import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call } from "../src/eval/cases.js";
import { connectInMemory } from "../src/eval/connect.js";
import { generateEvents } from "../src/events.js";
import { VARIANTS } from "../src/variants.js";

const events = generateEvents();
const levels = ["full", "lean", "short", "no-descriptions"] as const; // description levels full, lean, short, none
const clients: Record<string, Client> = {};
const tools: Record<string, any[]> = {};

before(async () => {
  for (const name of levels) {
    clients[name] = await connectInMemory(events, VARIANTS[name]!);
    tools[name] = (await clients[name]!.listTools()).tools;
  }
});
after(async () => {
  for (const c of Object.values(clients)) await c.close();
});

const size = (name: string) => JSON.stringify(tools[name]).length;

/** Removes every `description` key, leaving names, types and structure. */
function stripDescriptions(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripDescriptions);
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .filter(([k]) => k !== "description")
        .map(([k, v]) => [k, stripDescriptions(v)]),
    );
  }
  return x;
}

describe("description levels", () => {
  it("full is byte-for-byte the original design (so earlier results stay comparable)", () => {
    const hash = createHash("sha256").update(JSON.stringify(tools.full)).digest("hex");
    assert.equal(hash, "cabe73500f6702ef5d987bcb857cf63484bc41d369672a8237b90e2655158488");
  });

  it("each level is strictly smaller than the one before", () => {
    assert.ok(size("full") > size("lean"));
    assert.ok(size("lean") > size("short"));
    assert.ok(size("short") > size("no-descriptions"));
  });

  it("levels differ only in descriptions: same tools, parameters and types", () => {
    const reference = JSON.stringify(stripDescriptions(tools.full));
    for (const name of levels) assert.equal(JSON.stringify(stripDescriptions(tools[name])), reference, `${name} changed more than descriptions`);
  });

  it("lean keeps the facts an agent needs", () => {
    const byName = Object.fromEntries(tools.lean!.map((t) => [t.name, t.description as string]));
    assert.match(byName.trend!, /Monday/);
    assert.match(byName.trend!, /funnel/);
    assert.match(byName.funnel!, /first/i);
    assert.match(byName.funnel!, /compare/i);
    assert.match(byName.breakdown!, /same day/);
    for (const t of tools.lean!.filter((x) => x.name !== "get_schema")) {
      assert.match(JSON.stringify(t.inputSchema), /YYYY-MM-DD/, `${t.name} should say the date format`);
    }
  });

  it("short still states the date format on every date parameter", () => {
    for (const t of tools.short!) {
      const props = (t.inputSchema as { properties: Record<string, { description?: string }> }).properties;
      for (const key of ["from", "to"]) if (props[key]) assert.equal(props[key]!.description, "YYYY-MM-DD");
    }
  });

  it("answers are identical at every level: only the documentation changes", async () => {
    const args = [
      ["trend", { event: "error_occurred", interval: "week" }],
      ["funnel", { steps: ["onboarding_completed", "project_created"], breakdown: "browser" }],
      ["breakdown", { event: "signed_up", property: "country" }],
    ] as const;
    for (const [tool, a] of args) {
      const reference = JSON.stringify(await call(clients.full!, tool, { ...a }));
      for (const name of levels) assert.equal(JSON.stringify(await call(clients[name]!, tool, { ...a })), reference, `${tool} differs at ${name}`);
    }
  });
});
