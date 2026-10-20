import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalyticsError, breakdown, funnel, schema, trend } from "../src/analytics.js";
import { generateEvents, PAYMENT_SPIKE_COUNT, PAYMENT_SPIKE_DAY } from "../src/events.js";

const events = generateEvents();

describe("dataset", () => {
  it("is deterministic for a given seed", () => {
    assert.deepEqual(generateEvents(42), generateEvents(42));
    assert.notDeepEqual(generateEvents(42), generateEvents(7));
  });

  it("stays inside the 28-day window and is time-ordered", () => {
    const days = events.map((e) => e.timestamp.slice(0, 10));
    assert.ok(days[0]! >= "2026-09-01");
    assert.ok(days[days.length - 1]! <= "2026-09-28");
    for (let i = 1; i < events.length; i++) assert.ok(events[i - 1]!.timestamp <= events[i]!.timestamp);
  });

  it("contains the planted payment spike", () => {
    const t = trend(events, { event: "error_occurred", interval: "day" });
    assert.equal(t.series[0]!.peak.bucket, PAYMENT_SPIKE_DAY);
    assert.ok(t.series[0]!.peak.value >= PAYMENT_SPIKE_COUNT);
  });

  it("contains the planted Safari regression", () => {
    const conv = (from: string, to: string) =>
      Object.fromEntries(
        funnel(events, { steps: ["onboarding_completed", "project_created"], from, to, breakdown: "browser" }).results.map((r) => [
          r.breakdown_value!,
          r.overall_conversion_pct,
        ]),
      );
    const before = conv("2026-09-01", "2026-09-14");
    const after = conv("2026-09-15", "2026-09-28");
    assert.ok(before.Safari! > 70, `Safari before: ${before.Safari}`);
    assert.ok(after.Safari! < 45, `Safari after: ${after.Safari}`);
    assert.ok(after.Chrome! > 70, `Chrome after: ${after.Chrome}`);
  });
});

describe("trend", () => {
  it("fills empty buckets with zero and spans the whole range", () => {
    const t = trend(events, { event: "upgraded", from: "2026-09-01", to: "2026-09-03" });
    assert.deepEqual(
      t.series[0]!.points.map((p) => p.bucket),
      ["2026-09-01", "2026-09-02", "2026-09-03"],
    );
  });

  it("buckets weeks on Mondays", () => {
    const t = trend(events, { event: "signed_up", interval: "week" });
    for (const p of t.series[0]!.points) assert.equal(new Date(`${p.bucket}T00:00:00Z`).getUTCDay(), 1);
  });

  it("total equals the sum of its points", () => {
    const t = trend(events, { event: "page_viewed" });
    assert.equal(
      t.total,
      t.series[0]!.points.reduce((s, p) => s + p.value, 0),
    );
  });

  it("supports filters and breakdowns", () => {
    const t = trend(events, { event: "error_occurred", filter: { property: "error_type", equals: "PaymentTimeout" } });
    assert.equal(t.total, PAYMENT_SPIKE_COUNT);
    const b = trend(events, { event: "signed_up", breakdown: "browser", interval: "week" });
    assert.equal(b.series.length, 4);
  });
});

describe("funnel", () => {
  it("never increases from one step to the next", () => {
    const f = funnel(events, { steps: ["signed_up", "onboarding_completed", "project_created", "invited_teammate", "upgraded"] });
    const users = f.results[0]!.steps.map((s) => s.users);
    for (let i = 1; i < users.length; i++) assert.ok(users[i]! <= users[i - 1]!);
    assert.equal(f.results[0]!.cohort_size, users[0]);
  });

  it("respects the conversion window", () => {
    const open = funnel(events, { steps: ["signed_up", "upgraded"] }).results[0]!.steps[1]!.users;
    const tight = funnel(events, { steps: ["signed_up", "upgraded"], conversion_window_days: 1 }).results[0]!.steps[1]!.users;
    assert.ok(tight < open);
  });
});

describe("breakdown", () => {
  it("returns rows sorted high to low with shares that make sense", () => {
    const b = breakdown(events, { event: "signed_up", property: "country" });
    const counts = b.values.map((v) => v.count);
    assert.deepEqual(counts, [...counts].sort((x, y) => y - x));
    assert.equal(b.values.reduce((s, v) => s + v.count, 0), b.total);
  });
});

describe("errors teach the agent how to recover", () => {
  it("suggests the closest event name", () => {
    assert.throws(
      () => trend(events, { event: "signup" }),
      (e: unknown) => e instanceof AnalyticsError && /Did you mean "signed_up"/.test(e.hint ?? ""),
    );
  });

  it("lists valid properties when one is wrong", () => {
    assert.throws(
      () => breakdown(events, { event: "signed_up", property: "colour" }),
      (e: unknown) => e instanceof AnalyticsError && /browser/.test(e.hint ?? ""),
    );
  });

  it("explains the date format", () => {
    assert.throws(
      () => trend(events, { event: "signed_up", from: "Sept 1" }),
      (e: unknown) => e instanceof AnalyticsError && /YYYY-MM-DD/.test(e.message),
    );
  });

  it("rejects reversed ranges", () => {
    assert.throws(() => trend(events, { event: "signed_up", from: "2026-09-10", to: "2026-09-01" }), AnalyticsError);
  });
});

describe("schema", () => {
  it("lists every event with properties", () => {
    const s = schema(events);
    assert.deepEqual(
      s.events.map((e) => e.name),
      ["error_occurred", "invited_teammate", "onboarding_completed", "page_viewed", "project_created", "signed_up", "upgraded"],
    );
    assert.ok(s.events.find((e) => e.name === "error_occurred")!.properties.error_type);
  });
});
