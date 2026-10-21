import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildCases } from "../src/eval/cases.js";
import { connectInMemory } from "../src/eval/connect.js";
import { generateEvents } from "../src/events.js";
import { WIDE_TOOL_NAMES, WIDE_TOOL_TEXTS } from "../src/tools_wide.js";
import { VARIANTS } from "../src/variants.js";

const events = generateEvents();
const levels = ["wide-full", "wide-lean", "wide-short", "wide-none"] as const;
const clients: Record<string, Client> = {};
let core: Client;

before(async () => {
  core = await connectInMemory(events, VARIANTS.full);
  for (const l of levels) clients[l] = await connectInMemory(events, VARIANTS[l]);
});
after(async () => {
  await core.close();
  for (const c of Object.values(clients)) await c.close();
});

const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;

describe("wide surface", () => {
  it("core variants still expose exactly four tools; wide variants expose 17", async () => {
    assert.equal((await core.listTools()).tools.length, 4);
    for (const l of levels) {
      const names = (await clients[l]!.listTools()).tools.map((t) => t.name);
      assert.equal(names.length, 17);
      for (const n of WIDE_TOOL_NAMES) assert.ok(names.includes(n), `${l} is missing ${n}`);
    }
  });

  it("levels differ only in documentation: same outputs for the same call", async () => {
    const args = { event: "page_viewed", top: 3 };
    const outs = await Promise.all(levels.map(async (l) => text(await clients[l]!.callTool({ name: "top_users", arguments: args }))));
    for (const o of outs) assert.equal(o, outs[0]);
  });

  it("every tool has texts at every level, and longer levels carry more documentation", () => {
    for (const n of WIDE_TOOL_NAMES) {
      const t = WIDE_TOOL_TEXTS[n];
      assert.ok(t.full.length > t.lean.length && t.lean.length > t.short.length && t.short.length >= t.none.length, `${n}: levels should shrink`);
    }
  });

  it("every wide tool is used by at least one wide oracle", async () => {
    const used = new Set<string>();
    const proxy = new Proxy(clients["wide-full"]!, {
      get(target, prop, receiver) {
        if (prop === "callTool") return (p: { name: string }) => (used.add(p.name), target.callTool(p as never));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    for (const c of buildCases(events).filter((c) => c.tier === "wide")) await c.oracle(proxy);
    for (const n of WIDE_TOOL_NAMES) assert.ok(used.has(n), `no wide case uses ${n}`);
  });

  it("errors carry hints that name the fix", async () => {
    const c = clients["wide-full"]!;
    const unknown = text(await c.callTool({ name: "user_profile", arguments: { distinct_id: "nobody" } }));
    assert.match(unknown, /Unknown user "nobody"[\s\S]*Hint:.*top_users/);
    const noDay = await c.callTool({ name: "retention", arguments: { cohort_event: "signed_up", return_event: "page_viewed", day_offset: 30, from: "2026-09-01", to: "2026-09-07" } });
    assert.equal(noDay.isError, true);
    assert.match(text(noDay), /cannot be measured|smaller day_offset/);
    const zero = JSON.parse(text(await c.callTool({ name: "compare_periods", arguments: { event: "upgraded", a_from: "2026-08-01", a_to: "2026-08-02", b_from: "2026-09-01", b_to: "2026-09-02" } })));
    assert.equal(zero.change_pct, null);
  });

  it("hints can be turned off on the wide surface too", async () => {
    const quiet = await connectInMemory(events, { ...VARIANTS["wide-full"]!, name: "wide-quiet", errorHints: false });
    const res = await quiet.callTool({ name: "user_profile", arguments: { distinct_id: "nobody" } });
    assert.doesNotMatch(text(res), /Hint:/);
    await quiet.close();
  });
});
