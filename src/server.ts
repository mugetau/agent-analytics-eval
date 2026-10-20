/**
 * MCP server exposing the analytics query layer as agent-friendly tools.
 *
 * Tool-design principles used here (the evals measure whether they hold up; see src/variants.ts
 * for the switches that turn each one off so the evals can measure what it is worth):
 *  - Few, composable tools instead of one "run any SQL" escape hatch.
 *  - Descriptions say WHEN to use the tool and when NOT to, with a concrete example call.
 *  - Inputs are plain strings/numbers; validation errors explain how to fix the next call.
 *  - Outputs pre-compute what agents are bad at (totals, peaks, percentages) so they don't do mental arithmetic.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AnalyticsError, breakdown, funnel, schema, trend } from "./analytics.js";
import type { AnalyticsEvent } from "./events.js";
import { FULL, stripPrecomputed, type Variant } from "./variants.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function createServer(events: AnalyticsEvent[], variant: Variant = FULL): McpServer {
  const server = new McpServer({ name: "agent-analytics", version: "0.1.0" });

  /** Attaches a parameter description only when the variant has rich descriptions. */
  const d = <T extends z.ZodTypeAny>(shape: T, text: string): T => (variant.richDescriptions ? (shape.describe(text) as T) : shape);
  /** Picks the tool description for the variant. */
  const pick = (rich: string, terse: string) => (variant.richDescriptions ? rich : terse);

  const date = (what: string) => d(z.string().optional(), `${what} Format YYYY-MM-DD, UTC, inclusive. Omit to use the dataset boundary.`);

  const filterShape = d(
    z
      .object({
        property: d(z.string(), "Property name on the event, e.g. error_type"),
        equals: d(z.union([z.string(), z.number(), z.boolean()]), "Exact value to match, e.g. PaymentTimeout"),
      })
      .optional(),
    "Keep only events whose property equals a value.",
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
    {
      title: "Get schema",
      description: pick(
        "Start here. Returns the dataset's date range, every event name with counts, and each event's properties with example values. " +
          "Call it once before any other tool so you use real event and property names. Takes no arguments.",
        "Get the dataset schema.",
      ),
    },
    async () => run("get_schema", () => schema(events)),
  );

  server.registerTool(
    "trend",
    {
      title: "Event trend over time",
      description: pick(
        "Count an event per day or per week. Use for 'how many X', 'when did X spike', 'which week had the most X'. " +
          "Returns per-bucket values plus a precomputed total and the peak bucket, so you do not need to add or compare numbers yourself. " +
          "Set unique_users=true to count distinct users instead of events. Set breakdown to split into one series per property value. " +
          "Weeks start on Monday (UTC); the first and last week of a date range may be partial. " +
          'Example: {"event":"error_occurred","interval":"day","filter":{"property":"error_type","equals":"PaymentTimeout"}}. ' +
          "Do not use for step-by-step conversion (use funnel) or for 'top values of a property' (use breakdown).",
        "Count events over time.",
      ),
      inputSchema: {
        event: d(z.string(), "Event name exactly as listed by get_schema, e.g. signed_up"),
        from: date("First day."),
        to: date("Last day."),
        interval: d(z.enum(["day", "week"]).optional(), "Bucket size. Default day."),
        unique_users: d(z.boolean().optional(), "Count distinct users instead of events. Default false."),
        breakdown: d(z.string().optional(), "Property to split series by, e.g. browser. Max 10 series are returned."),
        filter: filterShape,
      },
    },
    async (args) => run("trend", () => trend(events, args)),
  );

  server.registerTool(
    "funnel",
    {
      title: "Conversion funnel",
      description: pick(
        "Measure how many users move through an ordered list of 2-6 events. Use for 'what is the conversion from A to B', " +
          "'where do users drop off', and for comparing conversion between groups or periods. " +
          "The cohort is users whose FIRST step-1 event happened in [from, to]; later steps may happen after the range ends. " +
          "Each later step must occur at or after the previous step. Returns users per step plus conversion_from_previous_pct, " +
          "conversion_from_first_pct and overall_conversion_pct, already rounded to 2 decimals. " +
          "Set breakdown (a property of the FIRST step's event) to compare groups, e.g. by browser. " +
          "To compare two periods, call funnel twice with different from/to. " +
          'Example: {"steps":["onboarding_completed","project_created"],"from":"2026-09-15","to":"2026-09-28","breakdown":"browser"}.',
        "Compute a conversion funnel.",
      ),
      inputSchema: {
        steps: d(z.array(z.string()).min(2).max(6), "Ordered event names, e.g. [signed_up, onboarding_completed, project_created]"),
        from: date("First day of the cohort window."),
        to: date("Last day of the cohort window."),
        breakdown: d(z.string().optional(), "Property of the first step's event to compare groups by, e.g. browser"),
        conversion_window_days: d(z.number().optional(), "Max days from step 1 to a later step. Default: no limit."),
      },
    },
    async (args) => run("funnel", () => funnel(events, args)),
  );

  server.registerTool(
    "breakdown",
    {
      title: "Top property values",
      description: pick(
        "Rank the values of one event property by how often they occur. Use for 'which country has the most signups', " +
          "'which error type is most common', 'share of events by browser'. Returns rows sorted by count (highest first) with share_pct and a total. " +
          "To rank values on one specific day, set from and to to that same day. " +
          'Example: {"event":"error_occurred","property":"error_type","from":"2026-09-20","to":"2026-09-20"}. ' +
          "Do not use for change over time (use trend).",
        "Break down an event by a property.",
      ),
      inputSchema: {
        event: d(z.string(), "Event name exactly as listed by get_schema"),
        property: d(z.string(), "Property to group by, e.g. country"),
        from: date("First day."),
        to: date("Last day."),
        unique_users: d(z.boolean().optional(), "Count distinct users instead of events. Default false."),
        top: d(z.number().int().min(1).max(50).optional(), "How many values to return. Default 10."),
        filter: filterShape,
      },
    },
    async (args) => run("breakdown", () => breakdown(events, args)),
  );

  return server;
}
