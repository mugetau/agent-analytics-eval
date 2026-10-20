/**
 * System prompts used by the agent eval.
 *
 * A real MCP server author does not control the client's system prompt, so the fairest test of
 * "do my tool descriptions work?" gives the model as little guidance as possible. Both prompts
 * keep the same answer-format rules, because the grader needs a parseable final line.
 *
 *  guided   The original prompt. Besides the format rules it tells the agent how to work: use only the
 *           tools, never guess, check the schema first, and say so instead of estimating.
 *  minimal  Format rules only. No "check the schema first", no "never guess", no "use only the tools".
 *           It still offers UNANSWERABLE as an output token, because the grader needs a way to read an
 *           abstention; it does not tell the agent to be careful or to look for missing data.
 */
const formatRules = (abstain: string) => `Finish with exactly one line in this form:
FINAL ANSWER: <answer>
Rules for the answer: a number is just the number (no units, no % sign); a date is YYYY-MM-DD; a category is just its name; ${abstain}, write FINAL ANSWER: UNANSWERABLE`;

export const PROMPTS = {
  // The guided prompt's text is identical to the one used for every result committed before the --prompt flag existed.
  guided: `You are a product analytics assistant. Answer the user's question using ONLY the provided tools; never guess or use outside knowledge.
Call get_schema first if you are unsure which events or properties exist. If the data cannot answer the question, say so instead of estimating.
${formatRules("if the data cannot answer the question")}`,
  minimal: `You are a product analytics assistant.
${formatRules("if the answer cannot be determined")}`,
} as const;

export type PromptName = keyof typeof PROMPTS;
export const PROMPT_NAMES = Object.keys(PROMPTS) as PromptName[];
