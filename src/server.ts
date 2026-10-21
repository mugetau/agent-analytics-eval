/**
 * MCP server exposing the analytics query layer as agent-friendly tools.
 *
 * Tool-design principles used here (the evals measure whether they hold up; see src/variants.ts
 * for the switches that turn each one off so the evals can measure what it is worth):
 *  - Few, composable tools instead of one "run any SQL" escape hatch.
 *  - Descriptions say WHEN to use the tool and when NOT to, with a concrete example call.
 *  - Inputs are plain strings/numbers; validation errors explain how to fix the next call.
 *  - Outputs pre-compute what agents are bad at (totals, peaks, percentages) so they don't do mental arithmetic.
 *
 * Documentation comes in four levels (full > lean > short > none). The `full` texts are the
 * original design and are pinned by test/descriptions.test.ts, so older results stay comparable.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AnalyticsError, breakdown, funnel, schema, trend } from "./analytics.js";
import type { AnalyticsEvent } from "./events.js";
import { registerWideTools } from "./tools_wide.js";
import { FULL, stripPrecomputed, type DescriptionLevel, type Variant } from "./variants.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type ToolTexts = Record<DescriptionLevel, string>;
export type ParamTexts = Partial<Record<Exclude<DescriptionLevel, "none">, string>>;

/** Tool descriptions for every level. Exported so tests and the size script can inspect them. */
export const TOOL_TEXTS: Record<"get_schema" | "trend" | "funnel" | "breakdown", ToolTexts> = {
  get_schema: {
    full:
      "Start here. Returns the dataset's date range, every event name with counts, and each event's properties with example values. " +
      "Call it once before any other tool so you use real event and property names. Takes no arguments.",
    lean: "Start here. Lists the date range, every event with counts, and each event's properties with example values. Call it before other tools to get real names.",
    short: "Dataset date range, events and their properties. Call first.",
    none: "Get the dataset schema.",
  },
  trend: {
    full:
      "Count an event per day or per week. Use for 'how many X', 'when did X spike', 'which week had the most X'. " +
      "Returns per-bucket values plus a precomputed total and the peak bucket, so you do not need to add or compare numbers yourself. " +
      "Set unique_users=true to count distinct users instead of events. Set breakdown to split into one series per property value. " +
      "Weeks start on Monday (UTC); the first and last week of a date range may be partial. " +
      'Example: {"event":"error_occurred","interval":"day","filter":{"property":"error_type","equals":"PaymentTimeout"}}. ' +
      "Do not use for step-by-step conversion (use funnel) or for 'top values of a property' (use breakdown).",
    lean:
      "Count an event per day or week. Use for 'how many X' and 'when did X spike'. Returns per-bucket values plus a precomputed total and peak bucket. " +
      "unique_users=true counts distinct users; breakdown splits series by a property. Weeks start on Monday (UTC). " +
      "Not for conversion (use funnel) or top values (use breakdown).",
    short: "Count an event per day or week, with total and peak. Optional unique_users, breakdown, filter.",
    none: "Count events over time.",
  },
  funnel: {
    full:
      "Measure how many users move through an ordered list of 2-6 events. Use for 'what is the conversion from A to B', " +
      "'where do users drop off', and for comparing conversion between groups or periods. " +
      "The cohort is users whose FIRST step-1 event happened in [from, to]; later steps may happen after the range ends. " +
      "Each later step must occur at or after the previous step. Returns users per step plus conversion_from_previous_pct, " +
      "conversion_from_first_pct and overall_conversion_pct, already rounded to 2 decimals. " +
      "Set breakdown (a property of the FIRST step's event) to compare groups, e.g. by browser. " +
      "To compare two periods, call funnel twice with different from/to. " +
      'Example: {"steps":["onboarding_completed","project_created"],"from":"2026-09-15","to":"2026-09-28","breakdown":"browser"}.',
    lean:
      "Users moving through 2-6 ordered events. Use for conversion and drop-off, and to compare groups or periods. " +
      "The cohort is users whose first step-1 event is in [from, to]. Returns users per step and rounded conversion percentages. " +
      "breakdown (a property of the first step's event) compares groups; call twice with different dates to compare periods.",
    short: "Conversion through 2-6 ordered events, with percentages. Optional breakdown by a first-step property, date range, conversion_window_days.",
    none: "Compute a conversion funnel.",
  },
  breakdown: {
    full:
      "Rank the values of one event property by how often they occur. Use for 'which country has the most signups', " +
      "'which error type is most common', 'share of events by browser'. Returns rows sorted by count (highest first) with share_pct and a total. " +
      "To rank values on one specific day, set from and to to that same day. " +
      'Example: {"event":"error_occurred","property":"error_type","from":"2026-09-20","to":"2026-09-20"}. ' +
      "Do not use for change over time (use trend).",
    lean:
      "Rank an event property's values by count, with share_pct and a total. Use for 'which X is most common'. " +
      "Set from and to to the same day for a single day. Not for change over time (use trend).",
    short: "Rank values of an event property by count, with shares.",
    none: "Break down an event by a property.",
  },
};

export function createServer(events: AnalyticsEvent[], variant: Variant = FULL): McpServer {
  const server = new McpServer({ name: "agent-analytics", version: "0.1.0" });
  const level = variant.descriptions;

  /** Attaches a parameter description when the current level has text for it (level "none" never does). */
  const d = <T extends z.ZodTypeAny>(shape: T, texts: ParamTexts): T => {
    const text = level === "none" ? undefined : texts[level];
    return text ? (shape.describe(text) as T) : shape;
  };

  const date = (what: string) =>
    d(z.string().optional(), {
      full: `${what} Format YYYY-MM-DD, UTC, inclusive. Omit to use the dataset boundary.`,
      lean: `${what} YYYY-MM-DD, UTC, inclusive.`,
      short: "YYYY-MM-DD",
    });

  const eventName = (extra = "") =>
    d(z.string(), { full: `Event name exactly as listed by get_schema${extra}`, lean: "Event name from get_schema" });
  const uniqueUsers = () =>
    d(z.boolean().optional(), { full: "Count distinct users instead of events. Default false.", lean: "Count distinct users instead of events." });

  const filterShape = d(
    z
      .object({
        property: d(z.string(), { full: "Property name on the event, e.g. error_type", lean: "Property name" }),
        equals: d(z.union([z.string(), z.number(), z.boolean()]), { full: "Exact value to match, e.g. PaymentTimeout", lean: "Value to match" }),
      })
      .optional(),
    { full: "Keep only events whose property equals a value.", lean: "Keep only events where the property equals a value." },
  );

  function run(tool: string, fn: () => unknown): ToolResult {
    try {
      const result = fn();
      const shown = variant.precomputed ? result : stripPrecomputed(tool, result);
      return { content: [{ type: "text", text: JSON.stringify(shown, null, 2) }] };
    } catch (err) {
      if (err instanceof AnalyticsError) {
        const hint = variant.errorHints && err.hint ? `\nHint: ${err.hint}` : "";
        return { isError: true, content: [{ type: "text", text: `Error: ${err.message}${hint}` }] };
      }
      throw err;
    }
  }

  server.registerTool(
    "get_schema",
    { title: "Get schema", description: TOOL_TEXTS.get_schema[level] },
    async () => run("get_schema", () => schema(events)),
  );

  server.registerTool(
    "trend",
    {
      title: "Event trend over time",
      description: TOOL_TEXTS.trend[level],
      inputSchema: {
        event: eventName(", e.g. signed_up"),
        from: date("First day."),
        to: date("Last day."),
        interval: d(z.enum(["day", "week"]).optional(), { full: "Bucket size. Default day.", lean: "day or week. Default day." }),
        unique_users: uniqueUsers(),
        breakdown: d(z.string().optional(), {
          full: "Property to split series by, e.g. browser. Max 10 series are returned.",
          lean: "Property to split series by, e.g. browser.",
        }),
        filter: filterShape,
      },
    },
    async (args) => run("trend", () => trend(events, args)),
  );

  server.registerTool(
    "funnel",
    {
      title: "Conversion funnel",
      description: TOOL_TEXTS.funnel[level],
      inputSchema: {
        steps: d(z.array(z.string()).min(2).max(6), {
          full: "Ordered event names, e.g. [signed_up, onboarding_completed, project_created]",
          lean: "Ordered event names.",
        }),
        from: date("First day of the cohort window."),
        to: date("Last day of the cohort window."),
        breakdown: d(z.string().optional(), {
          full: "Property of the first step's event to compare groups by, e.g. browser",
          lean: "Property of the first step's event, e.g. browser.",
        }),
        conversion_window_days: d(z.number().optional(), {
          full: "Max days from step 1 to a later step. Default: no limit.",
          lean: "Max days from step 1 to a later step.",
        }),
      },
    },
    async (args) => run("funnel", () => funnel(events, args)),
  );

  server.registerTool(
    "breakdown",
    {
      title: "Top property values",
      description: TOOL_TEXTS.breakdown[level],
      inputSchema: {
        event: eventName(),
        property: d(z.string(), { full: "Property to group by, e.g. country", lean: "Property to group by." }),
        from: date("First day."),
        to: date("Last day."),
        unique_users: uniqueUsers(),
        top: d(z.number().int().min(1).max(50).optional(), { full: "How many values to return. Default 10.", lean: "How many values to return." }),
        filter: filterShape,
      },
    },
    async (args) => run("breakdown", () => breakdown(events, args)),
  );

  if (variant.surface === "wide") {
    registerWideTools(server, { events, level, d, date, eventName, uniqueUsers, filterShape, run });
  }

  return server;
}
