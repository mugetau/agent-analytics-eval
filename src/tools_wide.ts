/**
 * The "wide" tool surface: 13 more tools registered after the original four.
 *
 * Why: with 4 tools every documentation level scored 100%, so descriptions could only be measured by
 * their token cost. With 17 tools, several of which overlap on purpose, choosing the right tool is a
 * real decision, and the descriptions are what an agent has to decide with.
 *
 * Overlaps (on purpose, like real servers):
 *   count_users / count_events  vs  trend (unique_users, total) and breakdown
 *   compare_periods             vs  two trend calls and arithmetic
 *   active_users                vs  trend with unique_users on a single event
 *   top_users / events_per_user vs  each other and breakdown
 *   anomalies                   vs  trend (peak)
 *
 * The `full` texts say when to use and when NOT to; lower levels drop that guidance first.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  activeUsers,
  anomalies,
  comparePeriods,
  countEvents,
  countUsers,
  eventFirstLast,
  eventsPerUser,
  getPropertyValues,
  retention,
  timeBetween,
  topUsers,
  userEvents,
  userProfile,
} from "./analytics_extra.js";
import type { AnalyticsEvent } from "./events.js";
import type { ParamTexts, ToolResult, ToolTexts } from "./server.js";
import type { DescriptionLevel } from "./variants.js";

export const WIDE_TOOL_NAMES = [
  "active_users",
  "retention",
  "user_profile",
  "user_events",
  "top_users",
  "time_between",
  "compare_periods",
  "anomalies",
  "events_per_user",
  "event_first_last",
  "count_users",
  "count_events",
  "get_property_values",
] as const;
export type WideToolName = (typeof WIDE_TOOL_NAMES)[number];

export const WIDE_TOOL_TEXTS: Record<WideToolName, ToolTexts> = {
  active_users: {
    full:
      "Count distinct users who did ANY event, per day or per week. Use for 'how many users were active', 'which day had the most active users', DAU/WAU. " +
      "Returns per-bucket values, unique_users_total for the range and the peak bucket. Weeks start on Monday (UTC). " +
      'Example: {"from":"2026-09-01","to":"2026-09-28","interval":"day"}. ' +
      "Do not use to count users of one specific event (use count_users, or trend with unique_users=true).",
    lean:
      "Distinct users with any event, per day or week (DAU/WAU), with a total and the peak bucket. " +
      "Not for users of one specific event (use count_users or trend with unique_users).",
    short: "Distinct active users per day or week, with peak.",
    none: "Count active users.",
  },
  retention: {
    full:
      "Day-N retention: of users whose FIRST cohort_event was in [from, to], the share who did return_event on exactly calendar day +N (UTC) after their cohort day. " +
      "Use for 'what is day-1 / day-7 retention'. Users whose day N falls after the end of the data are excluded, and the result says how many. " +
      "Returns cohort_size, returned_users and retention_pct rounded to 2 decimals. If day N cannot be measured for anyone, it returns an error instead of a number. " +
      'Example: {"cohort_event":"signed_up","return_event":"page_viewed","day_offset":1,"from":"2026-09-01","to":"2026-09-07"}. ' +
      "Do not use for conversion between steps (use funnel) or for elapsed time (use time_between).",
    lean:
      "Day-N retention: share of users whose first cohort_event was in [from, to] who did return_event on exactly day +N (UTC). " +
      "Excludes users whose day N is past the end of the data; errors if nobody is measurable. Not for step conversion (use funnel).",
    short: "Day-N retention for a cohort event and a return event.",
    none: "Compute retention.",
  },
  user_profile: {
    full:
      "Summary of ONE user: first and last event time, browser, country, total events and a count per event type. " +
      "Use for 'what is user_0042 like', 'how many events did this user generate'. Needs an exact distinct_id. " +
      "Do not use to find users (use top_users) or to see the event sequence (use user_events).",
    lean: "Summary of one user by distinct_id: first/last seen, browser, country, total events and counts per event type. Not for the event sequence (use user_events).",
    short: "Summary of one user by distinct_id.",
    none: "Get a user.",
  },
  user_events: {
    full:
      "The raw events of ONE user in time order, oldest first (limit 1 to 50, default 20). Use for 'what did user_0017 do first', 'show this user's journey'. " +
      "Returns timestamp, event and properties per row, plus whether the list was truncated. " +
      "Do not use for aggregate questions across users (use trend, breakdown or events_per_user).",
    lean: "Raw events of one user, oldest first (limit 1-50). For one user's sequence only; not for aggregates.",
    short: "Time-ordered events of one user.",
    none: "List a user's events.",
  },
  top_users: {
    full:
      "Rank users by how many times they did one event. Use for 'who viewed the most pages', 'which users hit the most errors'. " +
      "Returns the top N (1 to 20, default 5) with counts; ties are broken by distinct_id ascending. " +
      "Do not use to count how many users did something (use count_users) or to rank property values (use breakdown).",
    lean: "Top users by count of one event (top 1-20), ties by distinct_id ascending. Not for counting users (count_users) or ranking property values (breakdown).",
    short: "Rank users by how often they did an event.",
    none: "List top users.",
  },
  time_between: {
    full:
      "Elapsed hours between two events per user: for users whose FIRST from_event is in [from, to], the time until their first to_event at or after it. " +
      "Use for 'how long does it take users to go from signup to X', 'median time to upgrade'. " +
      "Returns mean, median and p90 in hours (2 decimals) plus how many users never did the second event. " +
      'Example: {"from_event":"signed_up","to_event":"upgraded"}. ' +
      "Do not use for conversion rates (use funnel, whose conversion_window_days limits the time allowed).",
    lean: "Hours from a user's first from_event to their next to_event: mean, median, p90, and users who never reached it. Not for conversion rates (use funnel).",
    short: "Mean, median and p90 hours between two events.",
    none: "Measure time between events.",
  },
  compare_periods: {
    full:
      "Compare the count of ONE event between two date ranges: returns both values, the absolute change and change_pct = (B - A) / A * 100 rounded to 2 decimals. " +
      "Use for 'did X grow week over week', 'percent change from last week'. Set unique_users=true to compare distinct users instead of events. " +
      "Period A is the baseline. If A is zero, change_pct is null. " +
      'Example: {"event":"project_created","a_from":"2026-09-08","a_to":"2026-09-14","b_from":"2026-09-15","b_to":"2026-09-21"}. ' +
      "Do not use to compare conversion between periods (call funnel twice).",
    lean: "Count of one event in period A vs period B with absolute and percent change ((B-A)/A, rounded). unique_users compares distinct users. Not for conversion (use funnel).",
    short: "Compare an event's count between two periods.",
    none: "Compare two periods.",
  },
  anomalies: {
    full:
      "Find unusually high days or weeks for one event: buckets whose count is above mean + threshold x standard deviation over the whole dataset (population standard deviation, default threshold 3). " +
      "Use for 'were there any spikes', 'which days were abnormal'. Returns mean, std_dev, the cutoff and the matching buckets. " +
      "Lower the threshold (for example 1.5) to catch smaller deviations. Do not use to find just the single highest day (trend returns the peak).",
    lean: "Days or weeks where an event's count exceeds mean + threshold x std dev (default 3). Returns mean, std_dev, cutoff and the anomalies. Not for just the single peak (trend has it).",
    short: "Find spike days or weeks for an event.",
    none: "Detect anomalies.",
  },
  events_per_user: {
    full:
      "How many times a typical user did one event: mean and median per user, the heaviest user and how many users did it at all. " +
      "Only users who did the event at least once are counted. Use for 'average page views per user', 'how often do users hit errors'. " +
      "Do not use to list the top users (use top_users) or the total count (use count_events).",
    lean: "Mean and median count of an event per user (among users who did it), plus the heaviest user. Not for rankings (top_users) or totals (count_events).",
    short: "Mean and median of an event per user.",
    none: "Events per user.",
  },
  event_first_last: {
    full:
      "The first and last time an event ever occurred in the dataset, with its total count. Use for 'when did the first upgrade happen', 'when was the last error'. " +
      "Returns exact timestamps and calendar days. Do not use for counts over time (use trend).",
    lean: "First and last timestamp of an event, plus its total. Not for counts over time (use trend).",
    short: "First and last occurrence of an event.",
    none: "Get first and last event time.",
  },
  count_users: {
    full:
      "Count DISTINCT users who did an event, optionally within a date range and with a property filter. Returns one number. " +
      "Use for 'how many different users did X', 'how many users viewed /docs'. " +
      'Example: {"event":"page_viewed","filter":{"property":"path","equals":"/docs"}}. ' +
      "Do not use to count events (use count_events) or for a series over time (use trend).",
    lean: "Number of distinct users who did an event, with optional dates and property filter. Not for event counts (count_events) or a series (trend).",
    short: "Number of distinct users who did an event.",
    none: "Count users.",
  },
  count_events: {
    full:
      "Count total occurrences of an event, optionally within a date range and with a property filter. Returns one number. " +
      "Use for 'how many errors happened on 2026-09-20' (set from and to to that day). " +
      "Do not use to count distinct users (use count_users) or to see a series over time (use trend).",
    lean: "Total occurrences of an event, with optional dates and property filter. Not for distinct users (count_users) or a series (trend).",
    short: "Number of times an event happened.",
    none: "Count events.",
  },
  get_property_values: {
    full:
      "List the distinct values of one event property over the whole dataset with their counts, most common first (limit 1 to 100, default 50), and the number of distinct values. " +
      "Use for 'how many different countries', 'what values does error_type take'. Takes no date range. " +
      "Do not use for rankings on a specific date range or for shares (use breakdown).",
    lean: "Distinct values of an event property over the whole dataset with counts, and the distinct count. No date range. For ranked shares over dates use breakdown.",
    short: "Distinct values of an event property.",
    none: "List property values.",
  },
};

type RunFn = (tool: string, fn: () => unknown) => ToolResult;
type Describe = <T extends z.ZodTypeAny>(shape: T, texts: ParamTexts) => T;

export interface WideContext {
  events: AnalyticsEvent[];
  level: DescriptionLevel;
  d: Describe;
  date: (what: string) => z.ZodOptional<z.ZodString>;
  eventName: (extra?: string) => z.ZodString;
  uniqueUsers: () => z.ZodOptional<z.ZodBoolean>;
  filterShape: z.ZodTypeAny;
  run: RunFn;
}

export function registerWideTools(server: McpServer, ctx: WideContext): void {
  const { events, level, d, date, eventName, uniqueUsers, filterShape, run } = ctx;
  const text = (name: WideToolName) => WIDE_TOOL_TEXTS[name][level];
  const interval = () => d(z.enum(["day", "week"]).optional(), { full: "Bucket size. Default day.", lean: "day or week. Default day." });
  const userId = () => d(z.string(), { full: "Exact user id, e.g. user_0042", lean: "User id, e.g. user_0042" });
  const filter = filterShape as z.ZodOptional<z.ZodObject<{ property: z.ZodString; equals: z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]> }>>;

  server.registerTool("active_users", { title: "Active users", description: text("active_users"), inputSchema: { from: date("First day."), to: date("Last day."), interval: interval() } }, async (a) =>
    run("active_users", () => activeUsers(events, a)),
  );

  server.registerTool(
    "retention",
    {
      title: "Retention",
      description: text("retention"),
      inputSchema: {
        cohort_event: d(z.string(), { full: "Event that puts a user in the cohort (their first one counts), e.g. signed_up", lean: "Cohort event, e.g. signed_up" }),
        return_event: d(z.string(), { full: "Event that counts as coming back, e.g. page_viewed", lean: "Return event, e.g. page_viewed" }),
        day_offset: d(z.number().int().min(0).max(60), { full: "Days after the cohort day (UTC calendar days). 1 = the next day. 0 to 60.", lean: "Days after the cohort day, 0-60." }),
        from: date("First day of the cohort window."),
        to: date("Last day of the cohort window."),
      },
    },
    async (a) => run("retention", () => retention(events, a)),
  );

  server.registerTool("user_profile", { title: "User profile", description: text("user_profile"), inputSchema: { distinct_id: userId() } }, async (a) =>
    run("user_profile", () => userProfile(events, a)),
  );

  server.registerTool(
    "user_events",
    {
      title: "User events",
      description: text("user_events"),
      inputSchema: { distinct_id: userId(), limit: d(z.number().int().min(1).max(50).optional(), { full: "How many events to return, oldest first. Default 20.", lean: "Max events, default 20." }) },
    },
    async (a) => run("user_events", () => userEvents(events, a)),
  );

  server.registerTool(
    "top_users",
    {
      title: "Top users",
      description: text("top_users"),
      inputSchema: {
        event: eventName(),
        top: d(z.number().int().min(1).max(20).optional(), { full: "How many users to return. Default 5.", lean: "How many users. Default 5." }),
        from: date("First day."),
        to: date("Last day."),
      },
    },
    async (a) => run("top_users", () => topUsers(events, a)),
  );

  server.registerTool(
    "time_between",
    {
      title: "Time between events",
      description: text("time_between"),
      inputSchema: {
        from_event: d(z.string(), { full: "Starting event (each user's first one counts), e.g. signed_up", lean: "Starting event, e.g. signed_up" }),
        to_event: d(z.string(), { full: "Ending event, e.g. upgraded", lean: "Ending event, e.g. upgraded" }),
        from: date("First day of the window for the starting event."),
        to: date("Last day of the window for the starting event."),
      },
    },
    async (a) => run("time_between", () => timeBetween(events, a)),
  );

  server.registerTool(
    "compare_periods",
    {
      title: "Compare periods",
      description: text("compare_periods"),
      inputSchema: {
        event: eventName(),
        a_from: d(z.string(), { full: "First day of period A, the baseline. YYYY-MM-DD, UTC.", lean: "Period A start, YYYY-MM-DD." }),
        a_to: d(z.string(), { full: "Last day of period A. YYYY-MM-DD, UTC, inclusive.", lean: "Period A end." }),
        b_from: d(z.string(), { full: "First day of period B, the one compared against A. YYYY-MM-DD, UTC.", lean: "Period B start." }),
        b_to: d(z.string(), { full: "Last day of period B. YYYY-MM-DD, UTC, inclusive.", lean: "Period B end." }),
        unique_users: uniqueUsers(),
      },
    },
    async (a) => run("compare_periods", () => comparePeriods(events, a)),
  );

  server.registerTool(
    "anomalies",
    {
      title: "Anomalies",
      description: text("anomalies"),
      inputSchema: {
        event: eventName(),
        interval: interval(),
        threshold: d(z.number().optional(), { full: "Standard deviations above the mean that count as unusual. Default 3.", lean: "Std devs above the mean. Default 3." }),
      },
    },
    async (a) => run("anomalies", () => anomalies(events, a)),
  );

  server.registerTool(
    "events_per_user",
    { title: "Events per user", description: text("events_per_user"), inputSchema: { event: eventName(), from: date("First day."), to: date("Last day.") } },
    async (a) => run("events_per_user", () => eventsPerUser(events, a)),
  );

  server.registerTool("event_first_last", { title: "First and last event", description: text("event_first_last"), inputSchema: { event: eventName() } }, async (a) =>
    run("event_first_last", () => eventFirstLast(events, a)),
  );

  server.registerTool(
    "count_users",
    { title: "Count users", description: text("count_users"), inputSchema: { event: eventName(), from: date("First day."), to: date("Last day."), filter } },
    async (a) => run("count_users", () => countUsers(events, a)),
  );

  server.registerTool(
    "count_events",
    { title: "Count events", description: text("count_events"), inputSchema: { event: eventName(), from: date("First day."), to: date("Last day."), filter } },
    async (a) => run("count_events", () => countEvents(events, a)),
  );

  server.registerTool(
    "get_property_values",
    {
      title: "Property values",
      description: text("get_property_values"),
      inputSchema: {
        event: eventName(),
        property: d(z.string(), { full: "Property to list values of, e.g. country", lean: "Property name." }),
        limit: d(z.number().int().min(1).max(100).optional(), { full: "Max values to return. Default 50.", lean: "Max values. Default 50." }),
      },
    },
    async (a) => run("get_property_values", () => getPropertyValues(events, a)),
  );
}
