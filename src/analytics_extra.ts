/**
 * Query logic for the "wide" tool surface: 13 more tools on top of the four in analytics.ts.
 *
 * Same rules as the core layer: pure functions over the event list, and every failure is an
 * AnalyticsError with a hint that tells an agent how to fix its next call.
 *
 * Some of these tools add real capabilities (retention, time between events, per-user views).
 * Others deliberately overlap the core tools (count_users vs trend with unique_users, compare_periods vs
 * two trend calls plus arithmetic). That is what real servers look like, and it is what makes tool choice
 * a real problem for the agent.
 */
import type { AnalyticsEvent, PropValue } from "./events.js";
import {
  AnalyticsError,
  DAY_MS,
  applyFilter,
  assertEvent,
  assertProperty,
  resolveRange,
  round2,
  toDay,
  weekStart,
  type Filter,
  type Interval,
} from "./analytics.js";

const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const shiftDay = (day: string, delta: number) => toDay(dayStartMs(day) + delta * DAY_MS);

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function lastDataDay(events: AnalyticsEvent[]): string {
  let max = -Infinity;
  for (const e of events) max = Math.max(max, Date.parse(e.timestamp));
  return toDay(max);
}

function allUserIds(events: AnalyticsEvent[]): string[] {
  return [...new Set(events.map((e) => e.distinct_id))].sort();
}

function assertUser(events: AnalyticsEvent[], id: unknown): asserts id is string {
  const ids = allUserIds(events);
  if (typeof id !== "string" || !ids.includes(id)) {
    throw new AnalyticsError(
      `Unknown user "${String(id)}".`,
      `User ids look like ${ids[0]} to ${ids[ids.length - 1]}. Use top_users to find ids.`,
    );
  }
}

function checkInterval(interval: unknown): Interval {
  const v = interval ?? "day";
  if (v !== "day" && v !== "week") throw new AnalyticsError(`Invalid interval "${String(v)}".`, 'Use "day" or "week". Weeks start on Monday (UTC).');
  return v;
}

function bucketList(range: { startMs: number; endMs: number }, bucketOf: (ms: number) => string): string[] {
  const buckets: string[] = [];
  for (let ms = range.startMs; ms < range.endMs; ms += DAY_MS) {
    const b = bucketOf(ms);
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }
  return buckets;
}

const inRange = (e: AnalyticsEvent, r: { startMs: number; endMs: number }) => {
  const ms = Date.parse(e.timestamp);
  return ms >= r.startMs && ms < r.endMs;
};

// ---------------------------------------------------------------------------------------------
// active_users
// ---------------------------------------------------------------------------------------------

export function activeUsers(events: AnalyticsEvent[], args: { from?: string; to?: string; interval?: Interval }) {
  const interval = checkInterval(args.interval);
  const range = resolveRange(events, args.from, args.to);
  const bucketOf = (ms: number) => (interval === "day" ? toDay(ms) : weekStart(toDay(ms)));
  const perBucket = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const e of events) {
    if (!inRange(e, range)) continue;
    const b = bucketOf(Date.parse(e.timestamp));
    let set = perBucket.get(b);
    if (!set) perBucket.set(b, (set = new Set()));
    set.add(e.distinct_id);
    all.add(e.distinct_id);
  }
  const points = bucketList(range, bucketOf).map((bucket) => ({ bucket, value: perBucket.get(bucket)?.size ?? 0 }));
  let peak = points[0]!;
  for (const p of points) if (p.value > peak.value) peak = p;
  return {
    metric: "active_users (distinct users with any event)",
    interval,
    from: range.from,
    to: range.to,
    unique_users_total: all.size,
    peak,
    points,
  };
}

// ---------------------------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------------------------

export interface RetentionArgs {
  cohort_event: string;
  return_event: string;
  day_offset: number;
  from?: string;
  to?: string;
}

export function retention(events: AnalyticsEvent[], args: RetentionArgs) {
  assertEvent(events, args.cohort_event, "cohort event");
  assertEvent(events, args.return_event, "return event");
  if (!Number.isInteger(args.day_offset) || args.day_offset < 0 || args.day_offset > 60) {
    throw new AnalyticsError(`"day_offset" must be an integer from 0 to 60, got ${String(args.day_offset)}.`, "Day 1 is the next calendar day (UTC) after the cohort day.");
  }
  const range = resolveRange(events, args.from, args.to);
  const lastDay = lastDataDay(events);

  const firstCohort = new Map<string, number>();
  const returnDays = new Map<string, Set<string>>();
  for (const e of events) {
    const ms = Date.parse(e.timestamp);
    if (e.event === args.cohort_event && (firstCohort.get(e.distinct_id) ?? Infinity) > ms) firstCohort.set(e.distinct_id, ms);
    if (e.event === args.return_event) {
      let set = returnDays.get(e.distinct_id);
      if (!set) returnDays.set(e.distinct_id, (set = new Set()));
      set.add(toDay(ms));
    }
  }

  let inCohort = 0;
  let measurable = 0;
  let returned = 0;
  for (const [user, ms] of firstCohort) {
    if (ms < range.startMs || ms >= range.endMs) continue;
    inCohort++;
    const cohortDay = toDay(ms);
    const targetDay = shiftDay(cohortDay, args.day_offset);
    if (targetDay > lastDay) continue; // day N is after the end of the data, so it cannot be measured
    measurable++;
    if (returnDays.get(user)?.has(targetDay)) returned++;
  }
  if (measurable === 0) {
    throw new AnalyticsError(
      `No users in the cohort have a day ${args.day_offset} that falls inside the dataset (last day ${lastDay}).`,
      "Use a smaller day_offset or a later cohort window, or conclude that this retention cannot be measured from the data.",
    );
  }
  return {
    cohort_event: args.cohort_event,
    return_event: args.return_event,
    day_offset: args.day_offset,
    from: range.from,
    to: range.to,
    definition: `Share of users whose first ${args.cohort_event} was in the window who did ${args.return_event} on exactly calendar day +${args.day_offset} (UTC) after their cohort day. Users whose day +${args.day_offset} is after ${lastDay} are excluded.`,
    cohort_size: measurable,
    returned_users: returned,
    retention_pct: round2((returned / measurable) * 100),
    excluded_users_day_outside_data: inCohort - measurable,
  };
}

// ---------------------------------------------------------------------------------------------
// user_profile / user_events / top_users
// ---------------------------------------------------------------------------------------------

export function userProfile(events: AnalyticsEvent[], args: { distinct_id: string }) {
  assertUser(events, args.distinct_id);
  const mine = events.filter((e) => e.distinct_id === args.distinct_id);
  const byType: Record<string, number> = {};
  for (const e of mine) byType[e.event] = (byType[e.event] ?? 0) + 1;
  return {
    distinct_id: args.distinct_id,
    first_seen: mine[0]!.timestamp,
    last_seen: mine[mine.length - 1]!.timestamp,
    browser: mine[0]!.properties.browser,
    country: mine[0]!.properties.country,
    total_events: mine.length,
    events_by_type: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function userEvents(events: AnalyticsEvent[], args: { distinct_id: string; limit?: number }) {
  assertUser(events, args.distinct_id);
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AnalyticsError(`"limit" must be an integer from 1 to 50, got ${String(args.limit)}.`);
  }
  const mine = events.filter((e) => e.distinct_id === args.distinct_id); // already in time order
  return {
    distinct_id: args.distinct_id,
    total_events: mine.length,
    returned: Math.min(limit, mine.length),
    truncated: mine.length > limit,
    order: "oldest first",
    events: mine.slice(0, limit).map((e) => ({ timestamp: e.timestamp, event: e.event, properties: e.properties })),
  };
}

export function topUsers(events: AnalyticsEvent[], args: { event: string; top?: number; from?: string; to?: string }) {
  assertEvent(events, args.event);
  const top = args.top ?? 5;
  if (!Number.isInteger(top) || top < 1 || top > 20) throw new AnalyticsError(`"top" must be an integer from 1 to 20, got ${String(args.top)}.`);
  const range = resolveRange(events, args.from, args.to);
  const counts = new Map<string, number>();
  let total = 0;
  for (const e of events) {
    if (e.event !== args.event || !inRange(e, range)) continue;
    counts.set(e.distinct_id, (counts.get(e.distinct_id) ?? 0) + 1);
    total++;
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    event: args.event,
    from: range.from,
    to: range.to,
    users_with_event: ranked.length,
    total_events: total,
    tie_break: "distinct_id ascending",
    users: ranked.slice(0, top).map(([distinct_id, count]) => ({ distinct_id, count })),
  };
}

// ---------------------------------------------------------------------------------------------
// time_between
// ---------------------------------------------------------------------------------------------

export function timeBetween(events: AnalyticsEvent[], args: { from_event: string; to_event: string; from?: string; to?: string }) {
  assertEvent(events, args.from_event, "from_event");
  assertEvent(events, args.to_event, "to_event");
  const range = resolveRange(events, args.from, args.to);
  const firstFrom = new Map<string, number>();
  const toTimes = new Map<string, number[]>();
  for (const e of events) {
    const ms = Date.parse(e.timestamp);
    if (e.event === args.from_event && (firstFrom.get(e.distinct_id) ?? Infinity) > ms) firstFrom.set(e.distinct_id, ms);
    if (e.event === args.to_event) {
      let list = toTimes.get(e.distinct_id);
      if (!list) toTimes.set(e.distinct_id, (list = []));
      list.push(ms);
    }
  }
  const hours: number[] = [];
  let cohort = 0;
  for (const [user, t0] of firstFrom) {
    if (t0 < range.startMs || t0 >= range.endMs) continue;
    cohort++;
    const next = (toTimes.get(user) ?? []).filter((t) => t >= t0).sort((a, b) => a - b)[0];
    if (next !== undefined) hours.push((next - t0) / 3_600_000);
  }
  if (hours.length === 0) {
    throw new AnalyticsError(`No user in the cohort did ${args.to_event} after ${args.from_event}.`, "Check the event order, or widen from/to.");
  }
  hours.sort((a, b) => a - b);
  const mean = hours.reduce((s, h) => s + h, 0) / hours.length;
  return {
    from_event: args.from_event,
    to_event: args.to_event,
    from: range.from,
    to: range.to,
    definition: `For users whose first ${args.from_event} is in the window: hours until their first ${args.to_event} at or after it.`,
    users_in_cohort: cohort,
    users_measured: hours.length,
    users_without_to_event: cohort - hours.length,
    mean_hours: round2(mean),
    median_hours: round2(median(hours)),
    p90_hours: round2(hours[Math.ceil(0.9 * hours.length) - 1]!),
  };
}

// ---------------------------------------------------------------------------------------------
// compare_periods
// ---------------------------------------------------------------------------------------------

export interface ComparePeriodsArgs {
  event: string;
  a_from: string;
  a_to: string;
  b_from: string;
  b_to: string;
  unique_users?: boolean;
}

export function comparePeriods(events: AnalyticsEvent[], args: ComparePeriodsArgs) {
  assertEvent(events, args.event);
  for (const key of ["a_from", "a_to", "b_from", "b_to"] as const) {
    if (typeof args[key] !== "string") throw new AnalyticsError(`"${key}" is required.`, "Give all four dates as YYYY-MM-DD: a_from, a_to, b_from, b_to.");
  }
  const a = resolveRange(events, args.a_from, args.a_to);
  const b = resolveRange(events, args.b_from, args.b_to);
  const measure = (r: { startMs: number; endMs: number }) => {
    const users = new Set<string>();
    let count = 0;
    for (const e of events) {
      if (e.event !== args.event || !inRange(e, r)) continue;
      count++;
      users.add(e.distinct_id);
    }
    return args.unique_users ? users.size : count;
  };
  const va = measure(a);
  const vb = measure(b);
  return {
    event: args.event,
    metric: args.unique_users ? "unique_users" : "event_count",
    period_a: { from: a.from, to: a.to, value: va },
    period_b: { from: b.from, to: b.to, value: vb },
    change_abs: vb - va,
    change_pct: va === 0 ? null : round2(((vb - va) / va) * 100),
    ...(va === 0 ? { note: "Period A is zero, so a percentage change is undefined." } : {}),
    definition: "change_pct = (B - A) / A * 100",
  };
}

// ---------------------------------------------------------------------------------------------
// anomalies
// ---------------------------------------------------------------------------------------------

export function anomalies(events: AnalyticsEvent[], args: { event: string; interval?: Interval; threshold?: number }) {
  assertEvent(events, args.event);
  const interval = checkInterval(args.interval);
  const threshold = args.threshold ?? 3;
  if (!(typeof threshold === "number" && threshold > 0 && threshold <= 10)) {
    throw new AnalyticsError(`"threshold" must be a number greater than 0 and at most 10, got ${String(args.threshold)}.`, "It is the number of standard deviations above the mean. Default 3.");
  }
  const range = resolveRange(events);
  const bucketOf = (ms: number) => (interval === "day" ? toDay(ms) : weekStart(toDay(ms)));
  const buckets = bucketList(range, bucketOf);
  const counts = new Map<string, number>();
  for (const e of events) if (e.event === args.event) counts.set(bucketOf(Date.parse(e.timestamp)), (counts.get(bucketOf(Date.parse(e.timestamp))) ?? 0) + 1);
  const values = buckets.map((b) => counts.get(b) ?? 0);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const cutoff = mean + threshold * std;
  const found = buckets
    .map((bucket, i) => ({ bucket, value: values[i]!, sd_above_mean: std === 0 ? 0 : round2((values[i]! - mean) / std) }))
    .filter((p) => p.value > cutoff);
  return {
    event: args.event,
    interval,
    threshold_sd: threshold,
    buckets_analyzed: buckets.length,
    definition: "Buckets with count > mean + threshold * standard deviation (population standard deviation) over the whole dataset.",
    mean: round2(mean),
    std_dev: round2(std),
    cutoff: round2(cutoff),
    anomaly_count: found.length,
    anomalies: found,
  };
}

// ---------------------------------------------------------------------------------------------
// events_per_user
// ---------------------------------------------------------------------------------------------

export function eventsPerUser(events: AnalyticsEvent[], args: { event: string; from?: string; to?: string }) {
  assertEvent(events, args.event);
  const range = resolveRange(events, args.from, args.to);
  const counts = new Map<string, number>();
  for (const e of events) if (e.event === args.event && inRange(e, range)) counts.set(e.distinct_id, (counts.get(e.distinct_id) ?? 0) + 1);
  if (counts.size === 0) throw new AnalyticsError(`No "${args.event}" events between ${range.from} and ${range.to}.`, "Widen from/to, or omit them to use the whole dataset.");
  const values = [...counts.values()].sort((a, b) => a - b);
  const total = values.reduce((s, v) => s + v, 0);
  const heaviest = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  return {
    event: args.event,
    from: range.from,
    to: range.to,
    users_with_event: counts.size,
    total_events: total,
    mean_per_user: round2(total / counts.size),
    median_per_user: round2(median(values)),
    heaviest_user: { distinct_id: heaviest[0], count: heaviest[1] },
    note: "Only users who did the event at least once are counted.",
  };
}

// ---------------------------------------------------------------------------------------------
// event_first_last / count_users / count_events / get_property_values
// ---------------------------------------------------------------------------------------------

export function eventFirstLast(events: AnalyticsEvent[], args: { event: string }) {
  assertEvent(events, args.event);
  const mine = events.filter((e) => e.event === args.event);
  const first = mine[0]!.timestamp;
  const last = mine[mine.length - 1]!.timestamp;
  return { event: args.event, total_events: mine.length, first_timestamp: first, last_timestamp: last, first_day: first.slice(0, 10), last_day: last.slice(0, 10) };
}

export function countUsers(events: AnalyticsEvent[], args: { event: string; from?: string; to?: string; filter?: Filter }) {
  assertEvent(events, args.event);
  const range = resolveRange(events, args.from, args.to);
  const passes = applyFilter(events, args.event, args.filter);
  const users = new Set<string>();
  for (const e of events) if (e.event === args.event && inRange(e, range) && passes(e)) users.add(e.distinct_id);
  return { event: args.event, from: range.from, to: range.to, ...(args.filter ? { filter: args.filter } : {}), users: users.size };
}

export function countEvents(events: AnalyticsEvent[], args: { event: string; from?: string; to?: string; filter?: Filter }) {
  assertEvent(events, args.event);
  const range = resolveRange(events, args.from, args.to);
  const passes = applyFilter(events, args.event, args.filter);
  let count = 0;
  for (const e of events) if (e.event === args.event && inRange(e, range) && passes(e)) count++;
  return { event: args.event, from: range.from, to: range.to, ...(args.filter ? { filter: args.filter } : {}), count };
}

export function getPropertyValues(events: AnalyticsEvent[], args: { event: string; property: string; limit?: number }) {
  assertEvent(events, args.event);
  assertProperty(events, args.event, args.property);
  const limit = args.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AnalyticsError(`"limit" must be an integer from 1 to 100, got ${String(args.limit)}.`);
  const counts = new Map<PropValue, number>();
  for (const e of events) {
    if (e.event !== args.event) continue;
    const v = e.properties[args.property];
    if (v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return {
    event: args.event,
    property: args.property,
    distinct_count: rows.length,
    values: rows.slice(0, limit).map(([value, count]) => ({ value, count })),
    ...(rows.length > limit ? { values_hidden: rows.length - limit } : {}),
    scope: "whole dataset",
  };
}
