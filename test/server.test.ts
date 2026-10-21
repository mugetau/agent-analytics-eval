import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { generateEvents } from "../src/events.js";
import { buildCases } from "../src/eval/cases.js";
import { connectInMemory } from "../src/eval/connect.js";
import { grade } from "../src/eval/grade.js";
import { VARIANTS } from "../src/variants.js";

const events = generateEvents();
let client: Client;
let wideClient: Client;

before(async () => {
  client = await connectInMemory(events);
  wideClient = await connectInMemory(events, VARIANTS["wide-full"]);
});
after(async () => {
  await client.close();
  await wideClient.close();
});

describe("MCP surface", () => {
  it("exposes the four tools, each with an agent-oriented description", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["breakdown", "funnel", "get_schema", "trend"]);
    for (const t of tools) assert.ok((t.description ?? "").length > 60, `${t.name} needs a real description`);
  });

  it("returns structured JSON for valid calls", async () => {
    const res = await client.callTool({ name: "trend", arguments: { event: "signed_up", unique_users: true } });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    assert.equal(body.metric, "unique_users");
    assert.ok(body.total > 0);
  });

  it("returns isError with a recovery hint for bad calls", async () => {
    const res = await client.callTool({ name: "trend", arguments: { event: "signup" } });
    assert.equal(res.isError, true);
    const text = (res.content as { text: string }[])[0]!.text;
    assert.match(text, /Did you mean "signed_up"/);
  });
});

describe("oracle: the tool surface can answer every eval question", () => {
  for (const c of buildCases(events)) {
    it(c.id, async () => {
      const g = grade(c.expected, await c.oracle(c.tier === "wide" ? wideClient : client));
      assert.ok(g.pass, `${g.reason} (got ${g.got})`);
    });
  }
});

describe("grader", () => {
  it("handles numbers, text and refusals", () => {
    assert.ok(grade({ kind: "number", value: 8.4, tolerance: 0.05 }, "some reasoning\nFINAL ANSWER: 8.41").pass);
    assert.ok(!grade({ kind: "number", value: 8.4, tolerance: 0.05 }, "FINAL ANSWER: 9").pass);
    assert.ok(grade({ kind: "text", value: "Safari" }, "FINAL ANSWER: **safari**.").pass);
    assert.ok(grade({ kind: "unanswerable" }, "FINAL ANSWER: UNANSWERABLE").pass);
    assert.ok(!grade({ kind: "unanswerable" }, "FINAL ANSWER: 12000").pass);
    assert.ok(!grade({ kind: "text", value: "x" }, "no final line here").pass);
  });
});
