# agent-analytics-eval

An MCP server that lets an AI agent query product-analytics data, **plus an eval harness that measures how well agents actually use it.**

Most MCP servers ship with the tools and no evidence they work. This repo treats the tool surface as a product: it has a ground-truth dataset, graded questions, and a loop for improving tool descriptions based on measured failures.

## Why this exists

Building for agents is different from building for people. An agent can't skim a dashboard; it reads tool descriptions, picks a tool, guesses arguments, and has to recover from errors. The failure modes are specific: wrong tool choice, malformed arguments, mental-arithmetic mistakes, and confidently answering questions the data can't support. This project makes those failure modes measurable.

## What's in the box

| Part | Where | What it does |
| --- | --- | --- |
| Synthetic dataset | `src/events.ts` | ~10k seeded events (signups, onboarding, errors, ...) with **planted ground truth**: a payment-error spike and a Safari-only conversion regression |
| Query layer | `src/analytics.ts`, `src/analytics_extra.ts` | Pure functions: the core four (`schema`, `trend`, `funnel`, `breakdown`) plus 13 more for the wide surface. Every error carries a hint that tells the agent how to fix its next call |
| MCP server | `src/server.ts`, `src/tools_wide.ts`, `src/index.ts` | Four tools over stdio (17 with the `wide-*` variants), with descriptions written for agents |
| Evals | `src/eval/` | 33 graded questions in three tiers (core, hard, wide), an **oracle** run (no LLM) and an **agent** run (Claude via the Anthropic API) |
| Tests | `test/` | 76 tests, including "the tool surface can answer every eval question" |

## Quick start

Requires Node 20+.

```bash
npm install
npm test                 # unit tests + oracle check, no API key needed
npm run eval:oracle      # scripted tool calls, proves the tools can answer the 19 core/hard questions (add `-- --variant wide-full` for all 33)
npm run serve            # start the MCP server on stdio
```

The server uses the `short` tool documentation by default (chosen from the description diet below). Set `ANALYTICS_VARIANT=full` for the original, longer descriptions. The evals default to `full`, so earlier results stay comparable.

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
npm run eval:agent -- --variant full,naive --trials 3      # ablation: same questions, different server designs
npm run eval:agent -- --tier hard --variant all --trials 3  # only the harder cases
npm run eval:agent -- --tier hard --variant full,naive --prompt minimal --trials 3   # no guidance in the system prompt
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

### Tiers

- **core** (10 cases): straightforward questions, from one-call counts to a two-period funnel comparison. These ceilinged quickly: see the first results below.
- **hard** (9 cases, added after the core tier scored 100% on every variant): each is built to stress one design choice, listed in the `targets` field of `src/eval/cases.ts`.

| Hard case | What it stresses |
| --- | --- |
| `avg-errors-per-day` | Total divided by number of days (precomputed totals) |
| `payment-error-share` | A percentage of a total (precomputed shares) |
| `quiet-error-days` | Scanning 28 daily values and counting; no tool does this for the agent |
| `final-week-upgraders` | Using the schema's date range, then date arithmetic |
| `safari-pricing-views` | Combining a filter on one property with a breakdown on another |
| `fast-upgraders` | A less obvious parameter (`conversion_window_days`) |
| `week-over-week-signups` | Weekly buckets and a percentage change, including a negative result |
| `busiest-weekday` | Aggregating 28 daily values by weekday (the top two weekdays differ by only 2 signups) |
| `unanswerable-session-duration` | Saying no when the dataset has no session data |

Run one tier with `--tier core|hard|all` (default `all`).

## Ablation: what is each design choice worth?

The design principles above are claims. To test them, `src/variants.ts` defines server variants that switch three choices independently:

| Variant | Descriptions | Error hints | Precomputed fields |
| --- | --- | --- | --- |
| `full` (default) | full | yes | yes |
| `lean` | lean | yes | yes |
| `short` | short | yes | yes |
| `naive` | none | no | no |
| `no-descriptions` | none | yes | yes |
| `no-hints` | full | no | yes |
| `no-precompute` | full | yes | no |

- **Descriptions** come in four levels. `full`: when to use and not to use each tool, examples, parameter docs (the original design). `lean`: the same facts without examples and with shorter parameter docs. `short`: one sentence per tool plus the date format. `none`: a few words per tool and no parameter docs. Tool names, parameters and types never change between levels; a test checks that only the documentation differs.
- **Error hints off:** errors still name the problem (`Unknown event "signup"`) but drop the `Hint:` line with the fix.
- **Precomputed off:** totals, peaks, shares and percentages are removed. Raw counts stay, so every answer is still derivable (tested in `test/variants.test.ts`). Rows stay sorted high to low, so rankings remain easy to read.

```bash
npm run eval:agent -- --variant all --trials 3
```

This writes one results file per variant and prints a comparison table (pass rate, tool calls, tokens per run, and a per-case matrix). Variants only apply to agent runs; the oracle needs the `full` server.

### Prompts

A server author doesn't control the client's system prompt, so how much guidance the prompt gives can hide weaknesses in the tool descriptions. `--prompt` selects one (`src/eval/prompts.ts`):

| Prompt | What the agent is told |
| --- | --- |
| `guided` (default) | Use only the tools, never guess, check the schema first if unsure, say so instead of estimating, plus the answer-format rules |
| `minimal` | Answer-format rules only |

Both keep the format rules, because the grader reads a `FINAL ANSWER:` line, and both let the agent write `UNANSWERABLE`, so an abstention can be read. `minimal` does not tell the agent to check the schema or to look for missing data. A test pins `guided` to the exact text used for all earlier results, so old and new runs stay comparable. Result files for `minimal` runs have `-minimal` in their name and record the prompt in the JSON.

### The descriptions diet

Tool definitions are re-sent to the model on every turn, so their size is a cost multiplied by the number of turns. `npm run tools:size` measures it offline and for free:

| Level | Characters | vs full |
| --- | --- | --- |
| full | 5,783 | |
| lean | 4,031 | -30% |
| short | 2,368 | -59% |
| none | 1,968 | -66% |

Characters are exact; token counts are only roughly a third of that. The agent runs report the real input tokens. The diet experiment runs `full`, `lean`, `short` and `no-descriptions` on the hard tier with `--prompt minimal --trials 3`, and looks for the smallest level that keeps the pass rate. Results go in the Results section below.

```bash
npm run tools:size
npm run eval:agent -- --tier hard --variant full,lean,short,no-descriptions --prompt minimal --trials 3 --model claude-haiku-5-5
```

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

### Ablation on the core tier (2026-10-20)

`claude-haiku-5-5`, 1 trial per case, 10 core cases, all five variants. Raw data: `results/agent-<variant>-2026-10-20T15-*.json`.

| Variant | Pass | Avg tool calls | Avg input tokens / run | Avg output tokens / run |
| --- | --- | --- | --- | --- |
| full | 10/10 | 2.1 | 10,655 | 326 |
| naive | 10/10 | 2.0 | 6,682 | 493 |
| no-descriptions | 10/10 | 2.0 | 6,782 | 409 |
| no-hints | 10/10 | 2.1 | 11,033 | 359 |
| no-precompute | 10/10 | 2.1 | 10,797 | 430 |

What this shows, and what it doesn't:

- **Accuracy did not move.** Every variant passed every question, so on this tier none of the three design choices changed correctness. Differences in tool calls (for example 4 vs 3 on one case) are single-trial noise.
- **Rich descriptions cost tokens.** The full descriptions add about 4,000 input tokens per run (roughly 60% more than `naive`), because tool definitions are re-sent on every turn. On these questions that was cost with no measurable benefit.
- **Error hints and precomputed fields were barely exercised.** There were no tool errors in four of the five variants (one in `no-precompute`, which had hints on), and the arithmetic was trivial. That is why the hard tier exists.
- **The shared system prompt helps every variant.** All agents called `get_schema` first, which gives even `naive` the real event names.

### Ablation on the hard tier (2026-10-20)

Same setup, 9 hard cases, all five variants, 1 trial each. Raw data: `results/agent-<variant>-2026-10-20T15-2*.json`.

| Variant | Pass | Avg tool calls | Avg input tokens / run | Avg output tokens / run |
| --- | --- | --- | --- | --- |
| full | 9/9 | 1.9 | 10,683 | 443 |
| naive | 9/9 | 1.9 | 6,696 | 509 |
| no-descriptions | 9/9 | 2.0 | 6,796 | 535 |
| no-hints | 9/9 | 1.9 | 10,669 | 428 |
| no-precompute | 9/9 | 1.9 | 10,955 | 481 |

What this shows:

- **Still no accuracy difference.** All 45 runs passed, including the two cases with the least room for error: `quiet-error-days` (an exact count of 13) and `busiest-weekday` (a 2-signup margin). In `no-precompute` the agent received only 28 raw daily values and did the arithmetic itself, correctly.
- **No tool errors in any variant,** so the error hints were never exercised on this tier either.
- **Every agent called `get_schema` first,** in every variant. The shared system prompt says to.
- **The cost finding repeats.** Rich descriptions again cost about 4,000 extra input tokens per run (10,683 vs 6,696 for `naive`), with no accuracy benefit. Output tokens are a little higher when information is removed (443 for `full` vs 481 to 535), consistent with the model doing more work itself, but the gap is small and from single trials.

**Conclusion so far.** On this tool surface (four tools, 28 days of data) and with this system prompt, a small modern model (`claude-haiku-5-5`) is insensitive to how the tools are documented. The documentation costs tokens without changing answers. This does **not** show that tool design never matters: the result is specific to a small tool surface, a small dataset, one model and a prompt that already tells the agent how to work. The next experiment removes that last confound.


### Hard tier with the minimal prompt (2026-10-20)

The previous run used a prompt that tells the agent to check the schema and not to guess. This run removes that guidance (`--prompt minimal`) and compares the two extremes, `full` and `naive`, with 3 trials per case. Raw data: `results/agent-full-minimal-*` and `results/agent-naive-minimal-*` (the 16-02 and 16-04 runs).

| Variant | Pass | Avg tool calls | Avg input tokens / run | Avg output tokens / run |
| --- | --- | --- | --- | --- |
| full | 27/27 | 1.9 | 10,383 | 439 |
| naive | 27/27 | 1.9 | 6,371 | 552 |

The null result survives the prompt change: no failures in 54 runs. `naive` used about 39% fewer input tokens. With 27 passes and no failures per variant, the data only supports saying each failure rate is probably under about 10%.

### Description diet (2026-10-20)

Hints and precomputed fields stay on; only the documentation shrinks. `--tier hard --prompt minimal --trials 3`, 108 runs. Raw data: `results/agent-<level>-minimal-2026-10-20T16-1*` and `T16-2*`.

| Level | Pass | Avg tool calls | Input tokens / run | vs full | Output tokens / run |
| --- | --- | --- | --- | --- | --- |
| full | 27/27 | 1.9 | 10,276 | | 425 |
| lean | 27/27 | 1.9 | 8,175 | -20% | 444 |
| short | 27/27 | 1.9 | 7,221 | -30% | 491 |
| none (`no-descriptions`) | 27/27 | 1.9 | 6,385 | -38% | 487 |

**Decision: the shipped server uses `short`.** Every level kept every answer correct, so accuracy cannot choose between them; `none` is the cheapest. I chose `short` as a judgment call, not a measured result: it saves 30%, still states the date format, and keeps a little protection for cases these tests don't cover. The extra cost over `none` is about 800 input tokens per run.

What this does not show:

- That documentation is useless. Tool and parameter names here are self-explanatory, and every agent called `get_schema` first on its own. A larger or more ambiguous tool surface, or a weaker model, could behave differently.
- Real dollar savings. These are raw input tokens; with prompt caching, repeated tool definitions are much cheaper, so the saving in cost is smaller than the token percentage. Smaller definitions still save context window and latency.

### Wide surface: 17 tools (2026-10-21)

Both runs used `claude-haiku-5-5` and `--prompt minimal`.

**A. Is the bigger surface harder?** Hard tier (9 cases), 3 trials, 4 tools (`full`) vs 17 tools (`wide-full`):

| Variant | Pass | Avg calls | Avg input tokens/run |
| --- | --- | --- | --- |
| full (4 tools) | 27/27 | 1.8 | 9,915 |
| wide-full (17 tools) | 27/27 | 1.9 | 22,871 |

No accuracy change. The 13 extra tools cost 2.3x the input tokens per run, because the definitions are re-sent every turn. Two cases took slightly more calls (`avg-errors-per-day` 1.3 to 1.7, `fast-upgraders` 2.0 to 2.7), so the extra tools caused some extra wandering, never a wrong answer.

**B. Do descriptions matter on the wide tier?** 14 wide cases, **1 trial per case**:

| Documentation | Pass | Avg calls | Avg input tokens/run | vs wide-full |
| --- | --- | --- | --- | --- |
| wide-full | 14/14 | 1.4 | 17,356 | |
| wide-lean | 14/14 | 1.5 | 14,515 | -16% |
| wide-short | 13/14 | 1.6 | 10,929 | -37% |
| wide-none | 14/14 | 1.6 | 9,089 | -48% |

The single failure was `wide-busy-signup-days` on `wide-short`: the agent never called `anomalies`. It fetched 28 daily signup counts with `trend` and did the standard-deviation arithmetic itself, getting 2 instead of 1. That is the failure mode the project is about (wrong tool choice leading to mental arithmetic). But it is one run, `wide-none` passed the same question, and `wide-full` needed 3 calls for it, so this is a hint, not a result.

What this does and does not show:

- Fewer descriptions cost nothing measurable in accuracy again, even with 17 overlapping tools. Descriptions are still the main lever on cost: `wide-none` used about half the input tokens of `wide-full`.
- Haiku mostly picked the dedicated tool when one existed (for example `retention`, `top_users`, `count_users`), and in `wide-full` it needed fewer calls (1.4 vs 1.6). Better descriptions may buy efficiency rather than correctness.
- One trial per case cannot separate a real 7-point gap from noise. Next: repeat with `--trials 3`.

### Next

1. Repeat experiment B with `--trials 3` to see whether the `wide-short` failure on `anomalies` repeats.
2. If accuracy splits between documentation levels, find the smallest level that holds it.

## The wide tool surface (17 tools)

Every result above came from a four-tool server, where all documentation levels scored 100%. To test whether descriptions matter when choosing a tool is genuinely hard, the `wide-*` variants add 13 tools after the original four:

| Tool | Does | Overlaps with |
| --- | --- | --- |
| `active_users` | distinct users with any event, per day/week | `trend` + `unique_users` |
| `retention` | day-N retention for a cohort event and a return event | `funnel` (sort of) |
| `time_between` | mean/median/p90 hours between two events | nothing (new capability) |
| `compare_periods` | one event's count in two periods, with % change | two `trend` calls + arithmetic |
| `anomalies` | days/weeks above mean + k standard deviations | `trend` peak |
| `top_users`, `events_per_user` | rank users / average per user | `breakdown` |
| `user_profile`, `user_events` | one user's summary / raw event sequence | nothing |
| `count_users`, `count_events` | one number, with optional filter | `trend` totals |
| `event_first_last`, `get_property_values` | first/last time; distinct values | `trend`, `breakdown` |

Variants `wide-full`, `wide-lean`, `wide-short`, `wide-none` change only the documentation (hints and precomputed fields stay on). The 14 `wide` cases use every new tool at least once (a test enforces it) and include one unanswerable question (day-30 retention when the data ends first). Sizes of the tool definitions (`npm run tools:size`):

| Variant | Chars | ~Tokens | vs wide-full |
| --- | --- | --- | --- |
| wide-full | 19,467 | 6,489 | |
| wide-lean | 13,288 | 4,429 | -32% |
| wide-short | 8,275 | 2,758 | -57% |
| wide-none | 7,209 | 2,403 | -63% |

Run it (results are in the Results section above):

```bash
# is the bigger surface itself harder? (same hard-tier questions, 4 tools vs 17)
npm run eval:agent -- --tier hard --variant full,wide-full --prompt minimal --trials 3
# do descriptions matter now? start with 1 trial to check cost
npm run eval:agent -- --tier wide --variant wide-full,wide-lean,wide-short,wide-none --prompt minimal --trials 1
```

## Limitations

- The data is synthetic. Realistic enough to test tool use, but not a claim about real-world product data.
- The core tier has only ten questions and hit 100% on a single trial for every variant, so it has a ceiling effect. The hard tier adds nine cases, which is still a small set: treat pass rates as directional, and use `--trials` to separate real differences from noise.
- The oracle run measures tool sufficiency, not model ability.
- Everything was measured with one small model (`claude-haiku-5-5`) on a four-tool server and 28 days of synthetic data. The conclusions about documentation may not hold for other models or for much larger tool surfaces.
- Unless `--prompt minimal` is used, all variants share a system prompt that tells the agent to check the schema and not to guess. That helps the weaker variants and may understate the gap between them. Even `minimal` offers `UNANSWERABLE` as an output token, so abstention is not entirely unprompted.

## Roadmap

- More cases: retention, multi-property filters, ambiguous questions that need clarification.
- Run the same questions against a real analytics API as an adapter alongside the synthetic one.
- Compare models and prompt variants; track cost (tokens) per correct answer.
- A `run_query` escape hatch behind a flag, and an eval comparing it to the narrow tools.

## License

MIT
