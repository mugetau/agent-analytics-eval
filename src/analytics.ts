/**
 * Query layer. Pure functions over an in-memory event list.
 *
 * Design rule: every failure is an `AnalyticsError` with a message *and* a hint that tells
 * an agent exactly how to fix its next call (valid event names, date format, ...).
 * Agents recover from errors that teach; they loop on errors that just say "invalid".
 */
import type { AnalyticsEvent, PropValue } from "./events.js";

export const DAY_MS = 86_400_000;

export class AnalyticsError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "AnalyticsError";
  }
}

export type Interval = "day" | "week";
export interface Filter {
  property: string;
  equals: PropValue;
}

export const round2 = (x: number) => Math.round(x * 100) / 100;
export const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function closest(input: string, options: string[]): string | undefined {
  const lower = input.toLowerCase();
  return options
    .map((o) => ({ o, d: o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()) ? 0 : levenshtein(lower, o.toLowerCase()) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)[0]?.o;
}

function eventNames(events: AnalyticsEvent[]): string[] {
  return [...new Set(events.map((e) => e.event))].sort();
}

export function assertEvent(events: AnalyticsEvent[], name: unknown, label = "event"): asserts name is string {
  const names = eventNames(events);
  if (typeof name !== "string" || !names.includes(name)) {
    const suggestion = typeof name === "string" ? closest(name, names) : undefined;
    throw new AnalyticsError(
      `Unknown ${label} "${String(name)}".`,
      `${suggestion ? `Did you mean "${suggestion}"? ` : ""}Valid events: ${names.join(", ")}. Call get_schema to see each event's properties.`,
    );
  }
}

function propertyKeys(events: AnalyticsEvent[], eventName: string): string[] {
  const keys = new Set<string>();
  for (const e of events) if (e.event === eventName) for (const k of Object.keys(e.properties)) keys.add(k);
  return [...keys].sort();
}

export function assertProperty(events: AnalyticsEvent[], eventName: string, property: unknown, label = "property"): asserts property is string {
  const keys = propertyKeys(events, eventName);
  if (typeof property !== "string" || !keys.includes(property)) {
    throw new AnalyticsError(
      `Event "${eventName}" has no ${label} "${String(property)}".`,
      `Properties available on "${eventName}": ${keys.join(", ")}.`,
    );
  }
}

export function parseDay(value: string, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AnalyticsError(
      `"${label}" must be a date in YYYY-MM-DD format, got ${JSON.stringify(value)}.`,
      "Example: 2026-09-15. Dates are UTC and inclusive at both ends.",
    );
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || toDay(ms) !== value) {
    throw new AnalyticsError(`"${label}" is not a real calendar date: ${value}.`);
  }
  return ms;
}

export interface Range {
  from: string;
  to: string;
  startMs: number;
  endMs: number; // exclusive
}

export function resolveRange(events: AnalyticsEvent[], from?: string, to?: string): Range {
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const ms = Date.parse(e.timestamp);
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  const f = from ?? toDay(min);
  const t = to ?? toDay(max);
  const startMs = parseDay(f, "from");
  const endMs = parseDay(t, "to") + DAY_MS;
  if (endMs <= startMs) {
    throw new AnalyticsError(`"from" (${f}) is after "to" (${t}).`, "Swap them, or omit both to use the whole dataset.");
  }
  return { from: f, to: t, startMs, endMs };
}

export function applyFilter(events: AnalyticsEvent[], eventName: string, filter?: Filter): (e: AnalyticsEvent) => boolean {
  if (!filter) return () => true;
  assertProperty(events, eventName, filter.property, "filter property");
  return (e) => e.properties[filter.property] === filter.equals;
}

// ---------------------------------------------------------------------------------------------
// get_schema
// ---------------------------------------------------------------------------------------------

export function schema(events: AnalyticsEvent[]) {
  const range = resolveRange(events);
  const byEvent = new Map<string, { count: number; users: Set<string>; props: Map<string, Set<PropValue>> }>();
  for (const e of events) {
    let entry = byEvent.get(e.event);
    if (!entry) {
      entry = { count: 0, users: new Set(), props: new Map() };
      byEvent.set(e.event, entry);
    }
    entry.count++;
    entry.users.add(e.distinct_id);
    for (const [k, v] of Object.entries(e.properties)) {
      let values = entry.props.get(k);
      if (!values) entry.props.set(k, (values = new Set()));
      if (values.size < 10) values.add(v);
    }
  }
  return {
    date_range: { first_day: range.from, last_day: range.to },
    total_events: events.length,
    unique_users: new Set(events.map((e) => e.distinct_id)).size,
    note: "Dates are UTC. The dataset has no revenue, session-duration or device-model data.",
    events: [...byEvent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => ({
        name,
        count: v.count,
        unique_users: v.users.size,
        properties: Object.fromEntries([...v.props.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, vals]) => [k, [...vals].sort()])),
      })),
  };
}

// ---------------------------------------------------------------------------------------------
// trend
// ---------------------------------------------------------------------------------------------

export interface TrendArgs {
  event: string;
  from?: string;
  to?: string;
  interval?: Interval;
  unique_users?: boolean;
  breakdown?: string;
  filter?: Filter;
}

export function trend(events: AnalyticsEvent[], args: TrendArgs) {
  assertEvent(events, args.event);
  const interval = args.interval ?? "day";
  if (interval !== "day" && interval !== "week") {
    throw new AnalyticsError(`Invalid interval "${String(interval)}".`, 'Use "day" or "week". Weeks start on Monday (UTC).');
  }
  const range = resolveRange(events, args.from, args.to);
  if (args.breakdown !== undefined) assertProperty(events, args.event, args.breakdown, "breakdown property");
  const passes = applyFilter(events, args.event, args.filter);

  const bucketOf = (ms: number) => (interval === "day" ? toDay(ms) : weekStart(toDay(ms)));
  const buckets: string[] = [];
  for (let ms = range.startMs; ms < range.endMs; ms += DAY_MS) {
    const b = bucketOf(ms);
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }

  const groups = new Map<string, { counts: Map<string, number>; users: Map<string, Set<string>>; allUsers: Set<string>; total: number }>();
  const overallUsers = new Set<string>();
  let overallCount = 0;
  for (const e of events) {
    if (e.event !== args.event) continue;
    const ms = Date.parse(e.timestamp);
    if (ms < range.startMs || ms >= range.endMs || !passes(e)) continue;
    const key = args.breakdown ? String(e.properties[args.breakdown] ?? "(none)") : "all";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { counts: new Map(), users: new Map(), allUsers: new Set(), total: 0 }));
    const b = bucketOf(ms);
    g.counts.set(b, (g.counts.get(b) ?? 0) + 1);
    let set = g.users.get(b);
    if (!set) g.users.set(b, (set = new Set()));
    set.add(e.distinct_id);
    g.allUsers.add(e.distinct_id);
    g.total++;
    overallUsers.add(e.distinct_id);
    overallCount++;
  }

  const unique = Boolean(args.unique_users);
  const series = [...groups.entries()]
    .map(([key, g]) => {
      const points = buckets.map((bucket) => ({
        bucket,
        value: unique ? (g.users.get(bucket)?.size ?? 0) : (g.counts.get(bucket) ?? 0),
      }));
      let peak = points[0]!;
      for (const p of points) if (p.value > peak.value) peak = p;
      return {
        ...(args.breakdown ? { breakdown_value: key } : {}),
        total: unique ? g.allUsers.size : g.total,
        peak,
        points,
      };
    })
    .sort((a, b) => b.total - a.total);

  const MAX_SERIES = 10;
  return {
    event: args.event,
    metric: unique ? "unique_users" : "event_count",
    interval,
    from: range.from,
    to: range.to,
    total: unique ? overallUsers.size : overallCount,
    ...(series.length > MAX_SERIES ? { truncated_series: series.length - MAX_SERIES } : {}),
    series: series.slice(0, MAX_SERIES),
  };
}

// ---------------------------------------------------------------------------------------------
// funnel
// ---------------------------------------------------------------------------------------------

export interface FunnelArgs {
  steps: string[];
  from?: string;
  to?: string;
  breakdown?: string;
  conversion_window_days?: number;
}

export function funnel(events: AnalyticsEvent[], args: FunnelArgs) {
  if (!Array.isArray(args.steps) || args.steps.length < 2 || args.steps.length > 6) {
    throw new AnalyticsError("A funnel needs between 2 and 6 steps.", 'Example: steps = ["signed_up", "onboarding_completed", "project_created"].');
  }
  args.steps.forEach((s) => assertEvent(events, s, "funnel step"));
  const range = resolveRange(events, args.from, args.to);
  const first = args.steps[0]!;
  if (args.breakdown !== undefined) assertProperty(events, first, args.breakdown, "breakdown property (read from the first step's event)");
  if (args.conversion_window_days !== undefined && !(args.conversion_window_days > 0)) {
    throw new AnalyticsError("conversion_window_days must be a positive number.", "Omit it for no time limit between steps.");
  }
  const windowMs = args.conversion_window_days !== undefined ? args.conversion_window_days * DAY_MS : undefined;

  // user -> event -> sorted timestamps (only for events that matter)
  const wanted = new Set(args.steps);
  const index = new Map<string, Map<string, number[]>>();
  const firstEvents = new Map<string, AnalyticsEvent>();
  for (const e of events) {
    if (!wanted.has(e.event)) continue;
    const ms = Date.parse(e.timestamp);
    let perUser = index.get(e.distinct_id);
    if (!perUser) index.set(e.distinct_id, (perUser = new Map()));
    let times = perUser.get(e.event);
    if (!times) perUser.set(e.event, (times = []));
    times.push(ms);
    if (e.event === first && ms >= range.startMs && ms < range.endMs) {
      const prev = firstEvents.get(e.distinct_id);
      if (!prev || ms < Date.parse(prev.timestamp)) firstEvents.set(e.distinct_id, e);
    }
  }

  const groups = new Map<string, number[]>(); // key -> users reaching each step
  for (const [user, firstEvent] of firstEvents) {
    const t0 = Date.parse(firstEvent.timestamp);
    const perUser = index.get(user)!;
    let depth = 1;
    let prev = t0;
    for (let i = 1; i < args.steps.length; i++) {
      const times = (perUser.get(args.steps[i]!) ?? []).slice().sort((a, b) => a - b);
      const next = times.find((t) => t >= prev && (windowMs === undefined || t - t0 <= windowMs));
      if (next === undefined) break;
      prev = next;
      depth++;
    }
    const key = args.breakdown ? String(firstEvent.properties[args.breakdown] ?? "(none)") : "all";
    let counts = groups.get(key);
    if (!counts) groups.set(key, (counts = Array<number>(args.steps.length).fill(0)));
    for (let i = 0; i < depth; i++) counts[i]!++;
  }

  const results = [...groups.entries()]
    .map(([key, counts]) => ({
      ...(args.breakdown ? { breakdown_value: key } : {}),
      cohort_size: counts[0]!,
      overall_conversion_pct: counts[0] ? round2((counts[counts.length - 1]! / counts[0]) * 100) : 0,
      steps: args.steps.map((event, i) => ({
        step: i + 1,
        event,
        users: counts[i]!,
        conversion_from_previous_pct: i === 0 ? 100 : counts[i - 1] ? round2((counts[i]! / counts[i - 1]!) * 100) : 0,
        conversion_from_first_pct: counts[0] ? round2((counts[i]! / counts[0]) * 100) : 0,
      })),
    }))
    .sort((a, b) => b.cohort_size - a.cohort_size);

  return {
    steps: args.steps,
    cohort_definition: `Users whose first "${first}" happened between ${range.from} and ${range.to} (UTC, inclusive). Each later step must happen at or after the previous step.`,
    from: range.from,
    to: range.to,
    conversion_window_days: args.conversion_window_days ?? null,
    results: results.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------------------------
// breakdown
// ---------------------------------------------------------------------------------------------

export interface BreakdownArgs {
  event: string;
  property: string;
  from?: string;
  to?: string;
  unique_users?: boolean;
  top?: number;
  filter?: Filter;
}

export function breakdown(events: AnalyticsEvent[], args: BreakdownArgs) {
  assertEvent(events, args.event);
  assertProperty(events, args.event, args.property);
  const range = resolveRange(events, args.from, args.to);
  const top = args.top ?? 10;
  if (!Number.isInteger(top) || top < 1 || top > 50) {
    throw new AnalyticsError(`"top" must be an integer between 1 and 50, got ${String(args.top)}.`);
  }
  const passes = applyFilter(events, args.event, args.filter);
  const unique = Boolean(args.unique_users);

  const counts = new Map<string, number>();
  const userSets = new Map<string, Set<string>>();
  const allUsers = new Set<string>();
  let total = 0;
  for (const e of events) {
    if (e.event !== args.event) continue;
    const ms = Date.parse(e.timestamp);
    if (ms < range.startMs || ms >= range.endMs || !passes(e)) continue;
    const key = String(e.properties[args.property] ?? "(none)");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    let set = userSets.get(key);
    if (!set) userSets.set(key, (set = new Set()));
    set.add(e.distinct_id);
    allUsers.add(e.distinct_id);
    total++;
  }
  const grand = unique ? allUsers.size : total;
  const rows = [...counts.keys()]
    .map((value) => {
      const count = unique ? userSets.get(value)!.size : counts.get(value)!;
      return { value, count, share_pct: grand ? round2((count / grand) * 100) : 0 };
    })
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return {
    event: args.event,
    property: args.property,
    metric: unique ? "unique_users" : "event_count",
    from: range.from,
    to: range.to,
    total: grand,
    values: rows.slice(0, top),
    ...(rows.length > top ? { other_values_hidden: rows.length - top } : {}),
  };
}
