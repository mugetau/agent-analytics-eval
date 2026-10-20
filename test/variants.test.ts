import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call } from "../src/eval/cases.js";
import { connectInMemory } from "../src/eval/connect.js";
import { generateEvents } from "../src/events.js";
import { DEFAULT_SERVER_VARIANT, VARIANTS, resolveVariant, stripPrecomputed } from "../src/variants.js";

const events = generateEvents();
const clients: Record<string, Client> = {};

before(async () => {
  for (const [name, variant] of Object.entries(VARIANTS)) clients[name] = await connectInMemory(events, variant);
});
after(async () => {
  for (const c of Object.values(clients)) await c.close();
});

const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;

describe("variants change only what they claim to change", () => {
  it("naive has terse descriptions and the same four tools", async () => {
    const full = (await clients.full!.listTools()).tools;
    const naive = (await clients.naive!.listTools()).tools;
    assert.deepEqual(naive.map((t) => t.name).sort(), full.map((t) => t.name).sort());
    for (const t of naive) assert.ok((t.description ?? "").length < 60, `${t.name} description should be one short line`);
    const props = (naive.find((t) => t.name === "trend")!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    assert.equal(props.event!.description, undefined);
    const fullProps = (full.find((t) => t.name === "trend")!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    assert.ok(fullProps.event!.description);
  });

  it("no-descriptions keeps hints and precomputed fields", async () => {
    const res = await clients["no-descriptions"]!.callTool({ name: "trend", arguments: { event: "signup" } });
    assert.match(text(res), /Did you mean "signed_up"/);
    const ok = await call(clients["no-descriptions"]!, "trend", { event: "signed_up" });
    assert.ok("total" in ok);
  });

  it("error hints are removed only when the variant says so", async () => {
    for (const name of ["naive", "no-hints"]) {
      const res = await clients[name]!.callTool({ name: "trend", arguments: { event: "signup" } });
      assert.equal(res.isError, true);
      assert.match(text(res), /Unknown event "signup"/); // the problem is still named
      assert.doesNotMatch(text(res), /Hint:|Did you mean/);
    }
    for (const name of ["full", "no-descriptions", "no-precompute"]) {
      const res = await clients[name]!.callTool({ name: "trend", arguments: { event: "signup" } });
      assert.match(text(res), /Hint:/);
    }
  });

  it("precomputed fields are removed only when the variant says so", async () => {
    for (const name of ["naive", "no-precompute"]) {
      const t = await call(clients[name]!, "trend", { event: "error_occurred" });
      assert.equal(t.total, undefined);
      assert.equal(t.series[0].total, undefined);
      assert.equal(t.series[0].peak, undefined);
      const f = await call(clients[name]!, "funnel", { steps: ["signed_up", "upgraded"] });
      assert.equal(f.results[0].overall_conversion_pct, undefined);
      assert.equal(f.results[0].steps[1].conversion_from_first_pct, undefined);
      const b = await call(clients[name]!, "breakdown", { event: "signed_up", property: "country" });
      assert.equal(b.total, undefined);
      assert.equal(b.values[0].share_pct, undefined);
    }
    for (const name of ["full", "no-descriptions", "no-hints"]) {
      const t = await call(clients[name]!, "trend", { event: "error_occurred" });
      assert.ok(typeof t.total === "number" && t.series[0].peak);
    }
  });

  it("stripping keeps every raw count, so the answers are still derivable", async () => {
    const full = await call(clients.full!, "trend", { event: "error_occurred" });
    const naive = await call(clients.naive!, "trend", { event: "error_occurred" });
    const sum = (r: { series: { points: { value: number }[] }[] }) => r.series[0]!.points.reduce((s, p) => s + p.value, 0);
    assert.equal(sum(naive), full.total);
    assert.deepEqual(naive.series[0].points, full.series[0].points);

    const ff = await call(clients.full!, "funnel", { steps: ["signed_up", "upgraded"] });
    const nf = await call(clients.naive!, "funnel", { steps: ["signed_up", "upgraded"] });
    assert.deepEqual(
      nf.results[0].steps.map((s: { users: number }) => s.users),
      ff.results[0].steps.map((s: { users: number }) => s.users),
    );
    assert.equal(nf.results[0].cohort_size, ff.results[0].cohort_size);

    const fb = await call(clients.full!, "breakdown", { event: "signed_up", property: "country" });
    const nb = await call(clients.naive!, "breakdown", { event: "signed_up", property: "country" });
    assert.deepEqual(
      nb.values.map((v: { value: string; count: number }) => [v.value, v.count]),
      fb.values.map((v: { value: string; count: number }) => [v.value, v.count]),
    );
  });

  it("get_schema is unaffected by stripping", () => {
    const payload = { events: [{ name: "x", count: 1 }], total_events: 1 };
    assert.deepEqual(stripPrecomputed("get_schema", payload), payload);
  });
});

describe("shipped server variant", () => {
  it("defaults to short and can be overridden", () => {
    assert.equal(DEFAULT_SERVER_VARIANT, "short");
    assert.equal(resolveVariant(undefined).name, "short");
    assert.equal(resolveVariant("").name, "short");
    assert.equal(resolveVariant("full").name, "full");
  });

  it("rejects an unknown variant with the valid choices", () => {
    assert.throws(() => resolveVariant("bogus"), /Unknown ANALYTICS_VARIANT "bogus".*full.*short/);
  });
});
