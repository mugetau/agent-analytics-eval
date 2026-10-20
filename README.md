# agent-analytics-eval

An MCP server that lets an AI agent query product-analytics data, **plus an eval harness that measures how well agents actually use it.**

Most MCP servers ship with the tools and no evidence they work. This repo treats the tool surface as a product: it has a ground-truth dataset, graded questions, and a loop for improving tool descriptions based on measured failures.

## Why this exists

Building for agents is different from building for people. An agent can't skim a dashboard; it reads tool descriptions, picks a tool, guesses arguments, and has to recover from errors. The failure modes are specific: wrong tool choice, malformed arguments, mental-arithmetic mistakes, and confidently answering questions the data can't support. This project makes those failure modes measurable.

## What's in the box

| Part | Where | What it does |
| --- | --- | --- |
| Synthetic dataset | `src/events.ts` | ~10k seeded events (signups, onboarding, errors, ...) with **planted ground truth**: a payment-error spike and a Safari-only conversion regression |
| Query layer | `src/analytics.ts` | Pure functions: `schema`, `trend`, `funnel`, `breakdown`. Every error carries a hint that tells the agent how to fix its next call |
| MCP server | `src/server.ts`, `src/index.ts` | Four tools over stdio, with descriptions written for agents |
| Evals | `src/eval/` | 10 graded questions, an **oracle** run (no LLM) and an **agent** run (Claude via the Anthropic API) |
| Tests | `test/` | 30 tests, including "the tool surface can answer every eval question" |

## Quick start

Requires Node 20+.

```bash
npm install
npm test                 # unit tests + oracle check, no API key needed
npm run eval:oracle      # scripted tool calls, proves the tools can answer all 10 questions
npm run serve            # start the MCP server on stdio
```

Use it from an MCP client (Claude Desktop, Claude Code, ...):

```json
{
  "mcpServers": {
    "agent-analytics": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/agent-analytics-eval/src/index.ts"]
    }
  }
}
```

Run the agent eval (needs your own key; set it in your shell and never commit it):

```bash
export ANTHROPIC_API_KEY=...        # PowerShell: $env:ANTHROPIC_API_KEY = "..."
npm run eval:agent -- --trials 3
npm run eval:agent -- --case conversion-regression --model <model-id> --max-turns 8
```

LLM answers vary between runs, so use `--trials` (1 to 20, default 1) to repeat each question and report a pass rate. A case that passes some trials but not all is marked `FLAKY`. Don't read much into a one-question difference from a single trial.

Results are saved to `results/agent-<timestamp>.json`: per-case pass rate, average tool calls and tokens, and the full tool-call trace of every trial.

## The tools

| Tool | Use it for |
| --- | --- |
| `get_schema` | Event names, counts, properties and example values. Agents should call it first |
| `trend` | "How many X?", "when did X spike?", per day or week, optional breakdown and filter |
| `funnel` | Conversion between ordered steps, comparing groups or periods |
| `breakdown` | "Which value of a property is most common?" |

### Design choices (and what the evals check)

- **Few composable tools, no raw-SQL escape hatch.** Narrow tools are easier for a model to pick correctly and easier to validate. The trade-off is less flexibility; the roadmap below covers that.
- **Descriptions say when to use *and when not to*,** with a concrete example call.
- **Errors teach.** `Unknown event "signup"` comes back with `Did you mean "signed_up"?` plus the list of valid events. Tested in `test/server.test.ts`.
- **Precompute what models get wrong.** Totals, peaks, and rounded percentages are returned directly, so the agent never has to add 28 numbers.
- **Say no.** One eval asks for revenue, which the data doesn't contain. The right answer is `UNANSWERABLE`. Hallucinated numbers fail it.

## How the evals work

Each case has a question, an expected answer, and an oracle.

- **Expected answers come from independent loops over the raw events** (`src/eval/cases.ts`), not from the query layer. A bug in `analytics.ts` makes the oracle fail instead of silently agreeing with itself.
- **Oracle run:** scripted MCP tool calls answer each question. Passing means the tools are *sufficient*. It's deterministic, free, and runs in CI.
- **Agent run:** a Claude model gets the question and the MCP tools, and must end with `FINAL ANSWER: ...`. Only that line is graded (numbers with tolerance, exact text, or `UNANSWERABLE`).

The questions range from simple counts to multi-step reasoning, e.g. finding the day with the most errors and then the cause, or comparing funnel conversion between two periods by browser to find the regression.

## Results

### Baseline (2026-10-20)

`claude-haiku-5-5`, 1 trial per case, default settings. Raw data: [`results/agent-2026-10-20T13-57-29-987Z.json`](results/agent-2026-10-20T13-57-29-987Z.json).

| Case | Pass | Tool calls | Input tokens | Output tokens |
| --- | --- | --- | --- | --- |
| total-signups | yes | 1 | 6,519 | 235 |
| projects-first-half | yes | 2 | 11,134 | 607 |
| signup-to-upgrade | yes | 2 | 10,901 | 189 |
| top-signup-country | yes | 2 | 10,856 | 181 |
| error-spike-day | yes | 1 | 6,304 | 163 |
| error-spike-cause | yes | 3 | 12,885 | 304 |
| payment-timeouts | yes | 2 | 10,763 | 184 |
| busiest-signup-week | yes | 2 | 10,922 | 530 |
| conversion-regression | yes | 3 | 12,924 | 556 |
| unanswerable-revenue | yes | 1 | 6,533 | 223 |
| **Total** | **10/10** | **avg 1.9** | **99,741** | **3,172** |

No tool errors occurred, and the model correctly answered `UNANSWERABLE` for the revenue question.

**What this does and doesn't show.** A perfect score on one trial means these ten questions are too easy to separate good tool design from bad: there is no failure to learn from yet. It shows the tools work end to end with a small model. It does not show that the design choices matter. That is the next experiment.

### Next

1. Add a deliberately minimal `naive` server variant (one-line descriptions, vague errors, no precomputed totals) and run the same questions against both, to measure what each design choice is worth.
2. Add harder cases: chained calls, misspelled event names, out-of-range dates, ambiguous wording.
3. Re-run with `--trials 3` or more, and record what moved in this section.

## Limitations

- The data is synthetic. Realistic enough to test tool use, but not a claim about real-world product data.
- Ten questions is a small eval set, and the baseline hit 100% on a single trial, so it currently has a ceiling effect. Treat pass rates as directional until the set grows and gets harder.
- The oracle run measures tool sufficiency, not model ability.

## Roadmap

- More cases: retention, multi-property filters, ambiguous questions that need clarification.
- Run the same questions against a real analytics API as an adapter alongside the synthetic one.
- Compare models and prompt variants; track cost (tokens) per correct answer.
- A `run_query` escape hatch behind a flag, and an eval comparing it to the narrow tools.

## License

MIT
