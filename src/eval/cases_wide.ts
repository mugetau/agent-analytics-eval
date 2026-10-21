/**
 * Eval cases for the "wide" tool surface (17 tools). Tier "wide".
 *
 * Every question can be answered by a scripted call to a specific new tool (the oracle), and at least
 * one case uses each of the 13 new tools (test/wide.test.ts enforces that). Several questions can ALSO
 * be answered with the original four tools plus arithmetic, which is the point: with more overlapping
 * tools the agent has to choose, and the descriptions are what it chooses with.
 *
 * Expected answers come from simple independent loops over the raw events, not from src/analytics_extra.ts.
 */
import type { AnalyticsEvent } from "../events.js";
import { call, type EvalCase } from "./cases.js";

const final = (answer: string | number) => `FINAL ANSWER: ${answer}`;
const dayOf = (e: AnalyticsEvent) => e.timestamp.slice(0, 10);
const DAY_MS = 86_400_000;
const round2 = (x: number) => Math.round(x * 100) / 100;
const shiftDay = (day: string, delta: number) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);

export function buildWideCases(events: AnalyticsEvent[]): EvalCase[] {
  const allDays = [...new Set(events.map(dayOf))].sort();
  const lastDay = allDays[allDays.length - 1]!;
  const dataDays: string[] = [];
  for (let d = allDays[0]!; d <= lastDay; d = shiftDay(d, 1)) dataDays.push(d);

  // 1. day with the most distinct active users (first such day if tied)
  const usersPerDay = new Map<string, Set<string>>();
  for (const e of events) {
    const s = usersPerDay.get(dayOf(e)) ?? new Set<string>();
    s.add(e.distinct_id);
    usersPerDay.set(dayOf(e), s);
  }
  let peakDay = dataDays[0]!;
  for (const d of dataDays) if ((usersPerDay.get(d)?.size ?? 0) > (usersPerDay.get(peakDay)?.size ?? 0)) peakDay = d;

  // 2. day-1 page_viewed retention for users whose first signup was 09-01..09-27
  const firstSignup = new Map<string, number>();
  for (const e of events) if (e.event === "signed_up") firstSignup.set(e.distinct_id, Math.min(firstSignup.get(e.distinct_id) ?? Infinity, Date.parse(e.timestamp)));
  const viewDays = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.event !== "page_viewed") continue;
    const s = viewDays.get(e.distinct_id) ?? new Set<string>();
    s.add(dayOf(e));
    viewDays.set(e.distinct_id, s);
  }
  let cohort = 0;
  let back = 0;
  for (const [u, ms] of firstSignup) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (day < "2026-09-01" || day > "2026-09-27") continue;
    cohort++;
    if (viewDays.get(u)?.has(shiftDay(day, 1))) back++;
  }
  const day1Retention = round2((back / cohort) * 100);

  // 3. median hours from first signup to first project_created at/after it
  const hours: number[] = [];
  for (const [u, t0] of firstSignup) {
    const ts = events.filter((e) => e.event === "project_created" && e.distinct_id === u).map((e) => Date.parse(e.timestamp)).filter((t) => t >= t0);
    if (ts.length) hours.push((Math.min(...ts) - t0) / 3_600_000);
  }
  hours.sort((a, b) => a - b);
  const medianHours = round2(hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2);

  // 4. user with the most page_viewed events (lowest id on ties)
  const pageViewsByUser = new Map<string, number>();
  for (const e of events) if (e.event === "page_viewed") pageViewsByUser.set(e.distinct_id, (pageViewsByUser.get(e.distinct_id) ?? 0) + 1);
  const topViewer = [...pageViewsByUser.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];

  // 5. total events of user_0042
  const user42Events = events.filter((e) => e.distinct_id === "user_0042").length;

  // 6. mean page_viewed per user among users who viewed at least one page
  const meanViews = round2([...pageViewsByUser.values()].reduce((s, v) => s + v, 0) / pageViewsByUser.size);

  // 7. project_created % change, 09-15..09-21 vs 09-08..09-14
  const countIn = (event: string, from: string, to: string) => events.filter((e) => e.event === event && dayOf(e) >= from && dayOf(e) <= to).length;
  const pa = countIn("project_created", "2026-09-08", "2026-09-14");
  const pb = countIn("project_created", "2026-09-15", "2026-09-21");
  const projectChange = round2(((pb - pa) / pa) * 100);

  // 8. days with signups above mean + 1.5 population standard deviations
  const signupsPerDay = dataDays.map((d) => events.filter((e) => e.event === "signed_up" && dayOf(e) === d).length);
  const mean = signupsPerDay.reduce((s, v) => s + v, 0) / signupsPerDay.length;
  const sd = Math.sqrt(signupsPerDay.reduce((s, v) => s + (v - mean) ** 2, 0) / signupsPerDay.length);
  const busyDays = signupsPerDay.filter((v) => v > mean + 1.5 * sd).length;

  // 9. distinct users who viewed /docs
  const docsViewers = new Set(events.filter((e) => e.event === "page_viewed" && e.properties.path === "/docs").map((e) => e.distinct_id)).size;

  // 10. date of the first upgraded event
  const firstUpgrade = events.filter((e) => e.event === "upgraded").map(dayOf).sort()[0]!;

  // 11. distinct countries on signed_up
  const countries = new Set(events.filter((e) => e.event === "signed_up").map((e) => String(e.properties.country))).size;

  // 13. error_occurred events on 2026-09-20
  const errorsOn20 = countIn("error_occurred", "2026-09-20", "2026-09-20");

  // 14. the second event of user_0017 in time order (timestamps must be distinct for this to be well defined)
  const user17 = events.filter((e) => e.distinct_id === "user_0017").sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (user17.length < 3 || new Set(user17.slice(0, 3).map((e) => e.timestamp)).size < 3) throw new Error("user_0017 does not give an unambiguous second event; pick another user");
  const user17Second = user17[1]!.event;

  return [
    {
      id: "wide-peak-active-day",
      tier: "wide",
      targets: "active_users: distinct users across ALL events (not one event)",
      question: "On which date were the most distinct users active (doing any event)? Answer as YYYY-MM-DD.",
      expected: { kind: "text", value: peakDay },
      oracle: async (c) => final((await call(c, "active_users", { interval: "day" })).peak.bucket),
    },
    {
      id: "wide-day1-retention",
      tier: "wide",
      targets: "retention: a tool that exists for exactly this",
      question:
        "Of the users who first signed up between 2026-09-01 and 2026-09-27, what percentage viewed a page (page_viewed) on the calendar day right after their signup day (UTC)? Round to 2 decimals, without the % sign.",
      expected: { kind: "number", value: day1Retention, tolerance: 0.05 },
      oracle: async (c) =>
        final((await call(c, "retention", { cohort_event: "signed_up", return_event: "page_viewed", day_offset: 1, from: "2026-09-01", to: "2026-09-27" })).retention_pct),
    },
    {
      id: "wide-median-hours-to-project",
      tier: "wide",
      targets: "time_between: elapsed time, which the core tools cannot compute",
      question: "For users who created a project after signing up, what is the median number of hours from their first signup to their first project_created? Round to 2 decimals.",
      expected: { kind: "number", value: medianHours, tolerance: 0.02 },
      oracle: async (c) => final((await call(c, "time_between", { from_event: "signed_up", to_event: "project_created" })).median_hours),
    },
    {
      id: "wide-top-page-viewer",
      tier: "wide",
      targets: "top_users: ranking users, not property values",
      question: "Which user has the most page_viewed events? If several users tie, give the one whose id sorts first. Answer with the user id.",
      expected: { kind: "text", value: topViewer },
      oracle: async (c) => final((await call(c, "top_users", { event: "page_viewed", top: 1 })).users[0].distinct_id),
    },
    {
      id: "wide-user-total-events",
      tier: "wide",
      targets: "user_profile: one specific user",
      question: "How many events in total does user_0042 have?",
      expected: { kind: "number", value: user42Events, tolerance: 0 },
      oracle: async (c) => final((await call(c, "user_profile", { distinct_id: "user_0042" })).total_events),
    },
    {
      id: "wide-views-per-user",
      tier: "wide",
      targets: "events_per_user: an average per user, not per day",
      question: "Among users who viewed at least one page, how many page_viewed events does each user have on average? Round to 2 decimals.",
      expected: { kind: "number", value: meanViews, tolerance: 0.02 },
      oracle: async (c) => final((await call(c, "events_per_user", { event: "page_viewed" })).mean_per_user),
    },
    {
      id: "wide-project-wow-change",
      tier: "wide",
      targets: "compare_periods vs two trend calls and arithmetic",
      question:
        "By what percentage did the number of project_created events change in 2026-09-15 to 2026-09-21 compared with 2026-09-08 to 2026-09-14? Round to 2 decimals, without the % sign, and use a minus sign for a decrease.",
      expected: { kind: "number", value: projectChange, tolerance: 0.05 },
      oracle: async (c) =>
        final((await call(c, "compare_periods", { event: "project_created", a_from: "2026-09-08", a_to: "2026-09-14", b_from: "2026-09-15", b_to: "2026-09-21" })).change_pct),
    },
    {
      id: "wide-busy-signup-days",
      tier: "wide",
      targets: "anomalies with a non-default threshold",
      question:
        "Over the whole dataset, on how many days did signups exceed the daily mean by more than 1.5 standard deviations? Use the population standard deviation over all days from the first to the last day of the data.",
      expected: { kind: "number", value: busyDays, tolerance: 0 },
      oracle: async (c) => final((await call(c, "anomalies", { event: "signed_up", interval: "day", threshold: 1.5 })).anomaly_count),
    },
    {
      id: "wide-docs-viewers",
      tier: "wide",
      targets: "count_users vs trend with unique_users and a filter",
      question: "How many distinct users viewed the /docs page (page_viewed with path /docs)?",
      expected: { kind: "number", value: docsViewers, tolerance: 0 },
      oracle: async (c) => final((await call(c, "count_users", { event: "page_viewed", filter: { property: "path", equals: "/docs" } })).users),
    },
    {
      id: "wide-first-upgrade-date",
      tier: "wide",
      targets: "event_first_last: when something first happened",
      question: "On what date did the first upgraded event happen? Answer as YYYY-MM-DD.",
      expected: { kind: "text", value: firstUpgrade },
      oracle: async (c) => final((await call(c, "event_first_last", { event: "upgraded" })).first_day),
    },
    {
      id: "wide-signup-countries",
      tier: "wide",
      targets: "get_property_values: how many distinct values, vs a breakdown with top set high enough",
      question: "How many different countries appear on signed_up events?",
      expected: { kind: "number", value: countries, tolerance: 0 },
      oracle: async (c) => final((await call(c, "get_property_values", { event: "signed_up", property: "country" })).distinct_count),
    },
    {
      id: "wide-errors-on-day",
      tier: "wide",
      targets: "count_events vs trend for a single day",
      question: "How many error_occurred events happened on 2026-09-20?",
      expected: { kind: "number", value: errorsOn20, tolerance: 0 },
      oracle: async (c) => final((await call(c, "count_events", { event: "error_occurred", from: "2026-09-20", to: "2026-09-20" })).count),
    },
    {
      id: "wide-user-second-event",
      tier: "wide",
      targets: "user_events: one user's sequence",
      question: "Looking at user_0017's events in time order, what is the name of their second event?",
      expected: { kind: "text", value: user17Second },
      oracle: async (c) => final((await call(c, "user_events", { distinct_id: "user_0017", limit: 2 })).events[1].event),
    },
    {
      id: "wide-unanswerable-day30-retention",
      tier: "wide",
      targets: "saying no: the data ends before day 30 can be observed",
      question:
        "What percentage of users who first signed up between 2026-09-01 and 2026-09-07 viewed a page (page_viewed) exactly 30 calendar days after their signup day?",
      expected: { kind: "unanswerable" },
      oracle: async (c) => {
        // The tool refuses (nobody has an observable day 30); a good agent reports that instead of inventing a number.
        const res = await c.callTool({
          name: "retention",
          arguments: { cohort_event: "signed_up", return_event: "page_viewed", day_offset: 30, from: "2026-09-01", to: "2026-09-07" },
        });
        if (!res.isError) throw new Error("expected the retention tool to refuse an unmeasurable day 30");
        return final("UNANSWERABLE");
      },
    },
  ];
}
