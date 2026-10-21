/**
 * Eval cases.
 *
 * Expected answers are computed by simple, independent loops over the raw events (see `truth`),
 * NOT by calling src/analytics.ts. If the tool layer has a bug, the oracle run fails.
 *
 * Each case also carries an `oracle`: a scripted sequence of MCP tool calls that answers the
 * question. Running the oracle proves the tool surface is *sufficient* to answer every question
 * (no LLM involved, so it is deterministic and free). The agent run then measures whether a
 * model can find that path by itself.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnalyticsEvent } from "../events.js";
import { buildWideCases } from "./cases_wide.js";
import type { Expected } from "./grade.js";

export interface EvalCase {
  id: string;
  /** "core" = the first, easy set. "hard" = cases built to stress one design choice each (see `targets`). "wide" = needs the 17-tool surface (wide-* variants). Default core. */
  tier?: "core" | "hard" | "wide";
  /** For hard cases: which design choice this case is meant to exercise. */
  targets?: string;
  question: string;
  expected: Expected;
  /** Scripted tool calls that answer the question. Returns text ending in `FINAL ANSWER: ...`. */
  oracle(client: Client): Promise<string>;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
  if (res.isError) throw new Error(`${name} returned an error: ${text}`);
  return JSON.parse(text);
}

const final = (answer: string | number) => `FINAL ANSWER: ${answer}`;
const dayOf = (e: AnalyticsEvent) => e.timestamp.slice(0, 10);

function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function topKey(counts: Map<string, number>): string {
  let best: string | undefined;
  for (const [k, v] of counts) if (best === undefined || v > counts.get(best)! || (v === counts.get(best)! && k < best)) best = k;
  return best!;
}

function tally(items: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

/** Conversion rate (%) from `a` to a later `b`, per browser, for users whose first `a` is in [from, to]. */
function stepConversionByBrowser(events: AnalyticsEvent[], a: string, b: string, from: string, to: string): Map<string, number> {
  const firstA = new Map<string, AnalyticsEvent>();
  const bTimes = new Map<string, number[]>();
  for (const e of events) {
    if (e.event === a && dayOf(e) >= from && dayOf(e) <= to && !firstA.has(e.distinct_id)) firstA.set(e.distinct_id, e);
    if (e.event === b) bTimes.set(e.distinct_id, [...(bTimes.get(e.distinct_id) ?? []), Date.parse(e.timestamp)]);
  }
  const cohort = new Map<string, { n: number; hit: number }>();
  for (const [user, ev] of firstA) {
    const browser = String(ev.properties.browser);
    const c = cohort.get(browser) ?? { n: 0, hit: 0 };
    c.n++;
    if ((bTimes.get(user) ?? []).some((t) => t >= Date.parse(ev.timestamp))) c.hit++;
    cohort.set(browser, c);
  }
  return new Map([...cohort].map(([k, v]) => [k, (v.hit / v.n) * 100]));
}

export function buildCases(events: AnalyticsEvent[]): EvalCase[] {
  // ---- independent ground truth ------------------------------------------------------------
  const signups = events.filter((e) => e.event === "signed_up");
  const signupUsers = new Set(signups.map((e) => e.distinct_id));
  const upgradedAfterSignup = new Set<string>();
  const firstSignupMs = new Map<string, number>();
  for (const e of signups) firstSignupMs.set(e.distinct_id, Math.min(firstSignupMs.get(e.distinct_id) ?? Infinity, Date.parse(e.timestamp)));
  for (const e of events) {
    if (e.event === "upgraded" && Date.parse(e.timestamp) >= (firstSignupMs.get(e.distinct_id) ?? Infinity)) upgradedAfterSignup.add(e.distinct_id);
  }
  const overallConversion = (upgradedAfterSignup.size / signupUsers.size) * 100;

  const projectUsersFirstHalf = new Set(
    events.filter((e) => e.event === "project_created" && dayOf(e) >= "2026-09-01" && dayOf(e) <= "2026-09-14").map((e) => e.distinct_id),
  );

  const topCountry = topKey(tally(signups.map((e) => String(e.properties.country))));

  const errors = events.filter((e) => e.event === "error_occurred");
  const errorsPerDay = tally(errors.map(dayOf));
  const spikeDay = [...errorsPerDay.keys()].sort().reduce((best, d) => (errorsPerDay.get(d)! > errorsPerDay.get(best)! ? d : best));
  const spikeType = topKey(tally(errors.filter((e) => dayOf(e) === spikeDay).map((e) => String(e.properties.error_type))));
  const paymentTimeouts = errors.filter((e) => e.properties.error_type === "PaymentTimeout").length;

  const signupsPerWeek = tally(signups.map((e) => mondayOf(dayOf(e))));
  const topWeek = [...signupsPerWeek.keys()].sort().reduce((best, w) => (signupsPerWeek.get(w)! > signupsPerWeek.get(best)! ? w : best));

  const before = stepConversionByBrowser(events, "onboarding_completed", "project_created", "2026-09-01", "2026-09-14");
  const after = stepConversionByBrowser(events, "onboarding_completed", "project_created", "2026-09-15", "2026-09-28");
  const worstBrowser = [...before.keys()].reduce((best, b) => (before.get(b)! - after.get(b)! > before.get(best)! - after.get(best)! ? b : best));

  // ---- truth for the harder cases ------------------------------------------------------------
  const DAY_MS = 86_400_000;
  const allDays = [...new Set(events.map(dayOf))].sort();
  const firstDay = allDays[0]!;
  const lastDay = allDays[allDays.length - 1]!;
  const shiftDay = (day: string, delta: number) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
  const daysInRange = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
    return out;
  };
  const dataDays = daysInRange(firstDay, lastDay);
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  const avgErrorsPerDay = round1(errors.length / dataDays.length);
  const paymentErrorShare = round2((paymentTimeouts / errors.length) * 100);
  const quietDays = dataDays.filter((d) => (errorsPerDay.get(d) ?? 0) < 5).length;

  const finalWeekFrom = shiftDay(lastDay, -6);
  const finalWeekUpgraders = new Set(events.filter((e) => e.event === "upgraded" && dayOf(e) >= finalWeekFrom && dayOf(e) <= lastDay).map((e) => e.distinct_id)).size;

  const safariPricingViews = events.filter((e) => e.event === "page_viewed" && e.properties.path === "/pricing" && e.properties.browser === "Safari").length;

  const upgradedWithin3Days = new Set<string>();
  for (const e of events) {
    if (e.event !== "upgraded") continue;
    const dt = Date.parse(e.timestamp) - (firstSignupMs.get(e.distinct_id) ?? Infinity);
    if (dt >= 0 && dt <= 3 * DAY_MS) upgradedWithin3Days.add(e.distinct_id);
  }
  const fastUpgradePct = round2((upgradedWithin3Days.size / signupUsers.size) * 100);

  const weekA = signupsPerWeek.get("2026-09-14")!;
  const weekB = signupsPerWeek.get("2026-09-21")!;
  const weekOverWeekPct = round1(((weekB - weekA) / weekA) * 100);

  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const topWeekday = topKey(tally(signups.map((e) => WEEKDAYS[new Date(e.timestamp).getUTCDay()]!)));

  // ---- cases ---------------------------------------------------------------------------------
  return [
    ...buildCoreAndHardCases(),
    ...buildWideCases(events),
  ];

  function buildCoreAndHardCases(): EvalCase[] {
  return [
    {
      id: "total-signups",
      question: "How many users signed up in total?",
      expected: { kind: "number", value: signupUsers.size, tolerance: 0 },
      oracle: async (c) => final((await call(c, "trend", { event: "signed_up", unique_users: true })).total),
    },
    {
      id: "projects-first-half",
      question: "How many distinct users created a project between 2026-09-01 and 2026-09-14 (inclusive)?",
      expected: { kind: "number", value: projectUsersFirstHalf.size, tolerance: 0 },
      oracle: async (c) =>
        final((await call(c, "trend", { event: "project_created", from: "2026-09-01", to: "2026-09-14", unique_users: true })).total),
    },
    {
      id: "signup-to-upgrade",
      question: "What percentage of users who signed up went on to upgrade? Give the percentage rounded to 2 decimals, without the % sign.",
      expected: { kind: "number", value: Math.round(overallConversion * 100) / 100, tolerance: 0.05 },
      oracle: async (c) => final((await call(c, "funnel", { steps: ["signed_up", "upgraded"] })).results[0].overall_conversion_pct),
    },
    {
      id: "top-signup-country",
      question: "Which country had the most signups? Answer with the two-letter country code.",
      expected: { kind: "text", value: topCountry },
      oracle: async (c) => final((await call(c, "breakdown", { event: "signed_up", property: "country" })).values[0].value),
    },
    {
      id: "error-spike-day",
      question: "On which date were there the most error_occurred events? Answer as YYYY-MM-DD.",
      expected: { kind: "text", value: spikeDay },
      oracle: async (c) => final((await call(c, "trend", { event: "error_occurred", interval: "day" })).series[0].peak.bucket),
    },
    {
      id: "error-spike-cause",
      question: "On the day with the most error_occurred events, which error_type was the most common?",
      expected: { kind: "text", value: spikeType },
      oracle: async (c) => {
        const day = (await call(c, "trend", { event: "error_occurred", interval: "day" })).series[0].peak.bucket;
        const rows = await call(c, "breakdown", { event: "error_occurred", property: "error_type", from: day, to: day });
        return final(rows.values[0].value);
      },
    },
    {
      id: "payment-timeouts",
      question: "How many error_occurred events had the error_type PaymentTimeout in total?",
      expected: { kind: "number", value: paymentTimeouts, tolerance: 0 },
      oracle: async (c) => {
        const rows = await call(c, "breakdown", { event: "error_occurred", property: "error_type" });
        return final(rows.values.find((v: { value: string }) => v.value === "PaymentTimeout").count);
      },
    },
    {
      id: "busiest-signup-week",
      question:
        "Group signups into weeks that start on Monday. Which week had the most signups? Answer with that week's Monday date as YYYY-MM-DD.",
      expected: { kind: "text", value: topWeek },
      oracle: async (c) => final((await call(c, "trend", { event: "signed_up", interval: "week" })).series[0].peak.bucket),
    },
    {
      id: "conversion-regression",
      question:
        "Compare the conversion from onboarding_completed to project_created between users who completed onboarding 2026-09-01 to 2026-09-14 and users who completed it 2026-09-15 to 2026-09-28. " +
        "Which browser's conversion dropped the most between the two periods? Answer with the browser name.",
      expected: { kind: "text", value: worstBrowser },
      oracle: async (c) => {
        const run = async (from: string, to: string) =>
          new Map<string, number>(
            (await call(c, "funnel", { steps: ["onboarding_completed", "project_created"], from, to, breakdown: "browser" })).results.map(
              (r: { breakdown_value: string; overall_conversion_pct: number }) => [r.breakdown_value, r.overall_conversion_pct],
            ),
          );
        const a = await run("2026-09-01", "2026-09-14");
        const b = await run("2026-09-15", "2026-09-28");
        const worst = [...a.keys()].reduce((best, k) => (a.get(k)! - b.get(k)! > a.get(best)! - b.get(best)! ? k : best));
        return final(worst);
      },
    },
    {
      id: "unanswerable-revenue",
      question: "What was our total revenue in September, in US dollars?",
      expected: { kind: "unanswerable" },
      oracle: async (c) => {
        await call(c, "get_schema", {}); // a good agent checks the schema, finds no revenue field, and says so
        return final("UNANSWERABLE");
      },
    },
    // ======================= hard tier =======================
    {
      id: "avg-errors-per-day",
      tier: "hard",
      targets: "precomputed totals: needs total / number of days",
      question: "On average, how many error_occurred events happened per day across the whole dataset? Round to 1 decimal.",
      expected: { kind: "number", value: avgErrorsPerDay, tolerance: 0.06 },
      oracle: async (c) => {
        const r = (await call(c, "trend", { event: "error_occurred" })).series[0];
        return final((r.total / r.points.length).toFixed(1));
      },
    },
    {
      id: "payment-error-share",
      tier: "hard",
      targets: "precomputed shares: percentage of a total",
      question: "What percentage of all error_occurred events had the error_type PaymentTimeout? Give the percentage rounded to 2 decimals, without the % sign.",
      expected: { kind: "number", value: paymentErrorShare, tolerance: 0.05 },
      oracle: async (c) => {
        const rows = await call(c, "breakdown", { event: "error_occurred", property: "error_type" });
        return final(rows.values.find((v: { value: string }) => v.value === "PaymentTimeout").share_pct);
      },
    },
    {
      id: "quiet-error-days",
      tier: "hard",
      targets: "scanning 28 daily values and counting (no tool does this for the agent)",
      question: "On how many days of the dataset were there fewer than 5 error_occurred events? Count every day from the first to the last day of the data.",
      expected: { kind: "number", value: quietDays, tolerance: 0 },
      oracle: async (c) => {
        const points = (await call(c, "trend", { event: "error_occurred", interval: "day" })).series[0].points;
        return final(points.filter((p: { value: number }) => p.value < 5).length);
      },
    },
    {
      id: "final-week-upgraders",
      tier: "hard",
      targets: "using get_schema's date range, then date arithmetic",
      question: "How many distinct users upgraded during the last 7 days of the dataset, counting the last day of the data as the 7th day?",
      expected: { kind: "number", value: finalWeekUpgraders, tolerance: 0 },
      oracle: async (c) => {
        const last = (await call(c, "get_schema", {})).date_range.last_day as string;
        const from = new Date(Date.parse(`${last}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
        return final((await call(c, "trend", { event: "upgraded", from, to: last, unique_users: true })).total);
      },
    },
    {
      id: "safari-pricing-views",
      tier: "hard",
      targets: "combining two features: a filter on one property with a breakdown on another",
      question: "How many page_viewed events were for the path /pricing and came from Safari users?",
      expected: { kind: "number", value: safariPricingViews, tolerance: 0 },
      oracle: async (c) => {
        const t = await call(c, "trend", { event: "page_viewed", breakdown: "browser", filter: { property: "path", equals: "/pricing" } });
        return final(t.series.find((s: { breakdown_value: string }) => s.breakdown_value === "Safari").total);
      },
    },
    {
      id: "fast-upgraders",
      tier: "hard",
      targets: "a less obvious parameter: conversion_window_days",
      question:
        "What percentage of users who signed up upgraded within 3 days of signing up? Give the percentage rounded to 2 decimals, without the % sign.",
      expected: { kind: "number", value: fastUpgradePct, tolerance: 0.05 },
      oracle: async (c) =>
        final((await call(c, "funnel", { steps: ["signed_up", "upgraded"], conversion_window_days: 3 })).results[0].overall_conversion_pct),
    },
    {
      id: "week-over-week-signups",
      tier: "hard",
      targets: "weekly buckets plus percentage-change arithmetic",
      question:
        "Weeks start on Monday. By what percentage did signups change in the week starting 2026-09-21 compared with the week starting 2026-09-14? Round to 1 decimal, without the % sign, and use a minus sign for a decrease.",
      expected: { kind: "number", value: weekOverWeekPct, tolerance: 0.1 },
      oracle: async (c) => {
        const points = (await call(c, "trend", { event: "signed_up", interval: "week" })).series[0].points as { bucket: string; value: number }[];
        const a = points.find((p) => p.bucket === "2026-09-14")!.value;
        const b = points.find((p) => p.bucket === "2026-09-21")!.value;
        return final((((b - a) / a) * 100).toFixed(1));
      },
    },
    {
      id: "busiest-weekday",
      tier: "hard",
      targets: "aggregating 28 daily values by weekday",
      question: "Across the whole dataset, which day of the week had the most signups in total? Answer with the weekday name, for example Monday.",
      expected: { kind: "text", value: topWeekday },
      oracle: async (c) => {
        const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const points = (await call(c, "trend", { event: "signed_up", interval: "day" })).series[0].points as { bucket: string; value: number }[];
        const totals = new Map<string, number>();
        for (const p of points) {
          const name = names[new Date(`${p.bucket}T00:00:00Z`).getUTCDay()]!;
          totals.set(name, (totals.get(name) ?? 0) + p.value);
        }
        return final([...totals.entries()].sort((x, y) => y[1] - x[1])[0]![0]);
      },
    },
    {
      id: "unanswerable-session-duration",
      tier: "hard",
      targets: "saying no: the dataset has no session data",
      question: "What was the average session duration, in minutes?",
      expected: { kind: "unanswerable" },
      oracle: async (c) => {
        await call(c, "get_schema", {});
        return final("UNANSWERABLE");
      },
    },
  ];
  }
}
