import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROMPTS } from "../src/eval/prompts.js";

// The exact text used for every result committed before --prompt existed. If this test fails,
// old and new results are no longer comparable.
const ORIGINAL_GUIDED = `You are a product analytics assistant. Answer the user's question using ONLY the provided tools; never guess or use outside knowledge.
Call get_schema first if you are unsure which events or properties exist. If the data cannot answer the question, say so instead of estimating.
Finish with exactly one line in this form:
FINAL ANSWER: <answer>
Rules for the answer: a number is just the number (no units, no % sign); a date is YYYY-MM-DD; a category is just its name; if the data cannot answer the question, write FINAL ANSWER: UNANSWERABLE`;

describe("prompts", () => {
  it("guided is byte-for-byte the original prompt", () => {
    assert.equal(PROMPTS.guided, ORIGINAL_GUIDED);
  });

  it("minimal has no working guidance", () => {
    for (const phrase of ["get_schema", "schema", "ONLY", "never guess", "estimating", "outside knowledge", "the provided tools"]) {
      assert.ok(!PROMPTS.minimal.includes(phrase), `minimal should not mention "${phrase}"`);
    }
  });

  it("both keep the answer-format rules the grader depends on", () => {
    for (const p of Object.values(PROMPTS)) {
      assert.match(p, /FINAL ANSWER: <answer>/);
      assert.match(p, /YYYY-MM-DD/);
      assert.match(p, /UNANSWERABLE/);
    }
  });
});
