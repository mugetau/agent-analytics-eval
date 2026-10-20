/**
 * Server variants for ablation experiments.
 *
 * Each variant switches three independent design choices on or off, so the evals can show
 * which choice actually matters instead of arguing about it:
 *
 *   richDescriptions  Tool and parameter descriptions that say when to use the tool, with examples.
 *                     Off: one-line tool descriptions and no parameter descriptions.
 *   errorHints        Errors end with a `Hint:` line that tells the agent how to fix its next call.
 *                     Off: only the plain error message (which still names the problem).
 *   precomputed       Outputs include totals, peaks, shares and rounded percentages.
 *                     Off: raw counts only; the agent has to add and divide itself.
 *                     (Rows are still sorted high to low, so rankings stay easy to read.)
 *
 * The oracle (scripted) run only works with `full`, because its scripted calls read the
 * precomputed fields. Variants are for agent runs.
 */
export interface Variant {
  name: string;
  richDescriptions: boolean;
  errorHints: boolean;
  precomputed: boolean;
}

export const FULL: Variant = { name: "full", richDescriptions: true, errorHints: true, precomputed: true };

export const VARIANTS: Record<string, Variant> = {
  full: FULL,
  naive: { name: "naive", richDescriptions: false, errorHints: false, precomputed: false },
  "no-descriptions": { name: "no-descriptions", richDescriptions: false, errorHints: true, precomputed: true },
  "no-hints": { name: "no-hints", richDescriptions: true, errorHints: false, precomputed: true },
  "no-precompute": { name: "no-precompute", richDescriptions: true, errorHints: true, precomputed: false },
};

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
