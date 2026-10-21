/**
 * Server variants for ablation experiments.
 *
 * Each variant switches three independent design choices on or off, so the evals can show
 * which choice actually matters instead of arguing about it:
 *
 *   descriptions      How much documentation the tools carry, from most to least:
 *                       full   when to use / not to use, examples, parameter docs (the original design)
 *                       lean   the same facts without examples and with shorter parameter docs
 *                       short  one sentence per tool, plus the date format
 *                       none   a few words per tool and no parameter docs
 *   errorHints        Errors end with a `Hint:` line that tells the agent how to fix its next call.
 *                     Off: only the plain error message (which still names the problem).
 *   precomputed       Outputs include totals, peaks, shares and rounded percentages.
 *                     Off: raw counts only; the agent has to add and divide itself.
 *                     (Rows are still sorted high to low, so rankings stay easy to read.)
 *
 * The oracle (scripted) run only works with `full`, because its scripted calls read the
 * precomputed fields. Variants are for agent runs.
 */
export type DescriptionLevel = "full" | "lean" | "short" | "none";

export interface Variant {
  name: string;
  descriptions: DescriptionLevel;
  errorHints: boolean;
  precomputed: boolean;
  /** Which tools the server exposes: the original 4 ("core") or those plus 13 more ("wide"). */
  surface: Surface;
}

export type Surface = "core" | "wide";

export const FULL: Variant = { name: "full", descriptions: "full", errorHints: true, precomputed: true, surface: "core" };

export const VARIANTS: Record<string, Variant> = {
  full: FULL,
  // Description diet: same hints and precomputed fields, less documentation.
  lean: { name: "lean", descriptions: "lean", errorHints: true, precomputed: true, surface: "core" },
  short: { name: "short", descriptions: "short", errorHints: true, precomputed: true, surface: "core" },
  // Ablations.
  naive: { name: "naive", descriptions: "none", errorHints: false, precomputed: false, surface: "core" },
  "no-descriptions": { name: "no-descriptions", descriptions: "none", errorHints: true, precomputed: true, surface: "core" },
  "no-hints": { name: "no-hints", descriptions: "full", errorHints: false, precomputed: true, surface: "core" },
  "no-precompute": { name: "no-precompute", descriptions: "full", errorHints: true, precomputed: false, surface: "core" },
  // Wide surface: 17 tools. Same three switches as the core levels, so only the documentation changes.
  "wide-full": { name: "wide-full", descriptions: "full", errorHints: true, precomputed: true, surface: "wide" },
  "wide-lean": { name: "wide-lean", descriptions: "lean", errorHints: true, precomputed: true, surface: "wide" },
  "wide-short": { name: "wide-short", descriptions: "short", errorHints: true, precomputed: true, surface: "wide" },
  "wide-none": { name: "wide-none", descriptions: "none", errorHints: true, precomputed: true, surface: "wide" },
};

/**
 * The variant the shipped server (`npm run serve`) uses, chosen from the description diet results.
 * The evals still default to `full`, so every earlier result stays comparable.
 * Override with the ANALYTICS_VARIANT environment variable, e.g. ANALYTICS_VARIANT=full.
 */
export const DEFAULT_SERVER_VARIANT = "short";

export function resolveVariant(name: string | undefined): Variant {
  const key = name && name.trim() ? name.trim() : DEFAULT_SERVER_VARIANT;
  const variant = VARIANTS[key];
  if (!variant) throw new Error(`Unknown ANALYTICS_VARIANT "${key}". Choose from: ${Object.keys(VARIANTS).join(", ")}.`);
  return variant;
}

type Json = Record<string, any>;

/** Removes every derived field from a tool result, keeping the raw counts the answer can be built from. */
export function stripPrecomputed(tool: string, result: unknown): unknown {
  const out = structuredClone(result) as Json;
  switch (tool) {
    case "trend":
      delete out.total;
      for (const s of out.series ?? []) {
        delete s.total;
        delete s.peak;
      }
      break;
    case "funnel":
      for (const r of out.results ?? []) {
        delete r.overall_conversion_pct;
        for (const step of r.steps ?? []) {
          delete step.conversion_from_previous_pct;
          delete step.conversion_from_first_pct;
        }
      }
      break;
    case "breakdown":
      delete out.total;
      for (const v of out.values ?? []) delete v.share_pct;
      break;
  }
  return out;
}
