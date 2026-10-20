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
import type { Expected } from "./grade.js";

export interface EvalCase {
  id: string;
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

  // ---- cases ---------------------------------------------------------------------------------
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
  ];
}
