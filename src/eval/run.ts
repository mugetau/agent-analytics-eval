/**
 * Eval runner.
 *
 *   npm run eval:oracle                 scripted tool calls, no LLM: checks the tools can answer every question
 *   npm run eval:agent                  a Claude model answers each question using only the MCP tools
 *   npm run eval:agent -- --trials 3                  repeat each question 3 times (LLM answers vary between runs)
 *   npm run eval:agent -- --variant full,naive        run the same questions against several server variants and compare
 *   npm run eval:agent -- --variant all --trials 3    every variant (see src/variants.ts)
 *   npm run eval:agent -- --tier hard                 only the harder cases (core | hard | all, default all)
 *   npm run eval:agent -- --prompt minimal            give the agent only answer-format rules, no guidance (default: guided)
 *   npm run eval:agent -- --case error-spike-day --model <model-id> --max-turns 8
 *
 * Agent mode needs ANTHROPIC_API_KEY. Results are written to results/<mode>-<variant>[-minimal]-<timestamp>.json.
 * Variants only apply to agent mode; the oracle needs the `full` server.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateEvents } from "../events.js";
import { buildCases, type EvalCase } from "./cases.js";
import { connectInMemory } from "./connect.js";
import { grade, type Grade } from "./grade.js";
import { VARIANTS, type Variant } from "../variants.js";
import { PROMPTS, PROMPT_NAMES, type PromptName } from "./prompts.js";

interface ToolTraceEntry {
  name: string;
  args: unknown;
  is_error: boolean;
}

interface CaseResult {
  id: string;
  question: string;
  expected: EvalCase["expected"];
  pass: boolean;
  got: string | null;
  reason: string;
  tool_calls: number;
  tool_errors: number;
  input_tokens?: number;
  output_tokens?: number;
  trace: ToolTraceEntry[];
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

/** Wraps the client so every tool call made by a case is recorded. */
function traced(client: Client, trace: ToolTraceEntry[]): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "callTool") {
        return async (params: { name: string; arguments?: Record<string, unknown> }) => {
          const res = await target.callTool(params);
          trace.push({ name: params.name, args: params.arguments ?? {}, is_error: Boolean(res.isError) });
          return res;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runAgent(client: Client, question: string, model: string, maxTurns: number, systemPrompt: string, trace: ToolTraceEntry[]) {
  const anthropic = new Anthropic();
  const { tools } = await client.listTools();
  const claudeTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await anthropic.messages.create({ model, max_tokens: 1500, system: systemPrompt, tools: claudeTools, messages });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (response.stop_reason !== "tool_use") {
      finalText = text;
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const res = await client.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
      trace.push({ name: block.name, args: block.input, is_error: Boolean(res.isError) });
      results.push({ type: "tool_result", tool_use_id: block.id, content: textOf(res), is_error: Boolean(res.isError) });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: finalText, inputTokens, outputTokens };
}

interface CaseSummary {
  id: string;
  question: string;
  expected: EvalCase["expected"];
  trials: number;
  passes: number;
  pass_rate: number;
  avg_tool_calls: number;
  avg_input_tokens?: number;
  avg_output_tokens?: number;
  runs: CaseResult[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function runOnce(client: Client, c: EvalCase, mode: "oracle" | "agent", model: string, maxTurns: number, systemPrompt: string): Promise<CaseResult> {
  const trace: ToolTraceEntry[] = [];
  let usage: { input?: number; output?: number } = {};
  let g: Grade;
  try {
    let answer: string;
    if (mode === "oracle") {
      answer = await c.oracle(traced(client, trace));
    } else {
      const r = await runAgent(client, c.question, model, maxTurns, systemPrompt, trace);
      answer = r.text;
      usage = { input: r.inputTokens, output: r.outputTokens };
    }
    g = grade(c.expected, answer);
  } catch (err) {
    g = { pass: false, got: null, reason: `runner error: ${(err as Error).message}` };
  }
  return {
    id: c.id,
    question: c.question,
    expected: c.expected,
    pass: g.pass,
    got: g.got,
    reason: g.reason,
    tool_calls: trace.length,
    tool_errors: trace.filter((t) => t.is_error).length,
    input_tokens: usage.input,
    output_tokens: usage.output,
    trace,
  };
}

interface VariantReport {
  variant: string;
  passedRuns: number;
  totalRuns: number;
  avgCalls: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  perCase: Map<string, { passes: number; trials: number; avgCalls: number }>;
  file: string;
}

async function runVariant(
  variant: Variant,
  mode: "oracle" | "agent",
  opts: { model: string; maxTurns: number; trials: number; only?: string; tier: string; prompt: PromptName },
): Promise<VariantReport> {
  const events = generateEvents();
  const client = await connectInMemory(events, variant);
  const cases = buildCases(events).filter((c) => (!opts.only || c.id === opts.only) && (opts.tier === "all" || (c.tier ?? "core") === opts.tier));
  if (cases.length === 0) throw new Error(`No case matches (case=${opts.only ?? "any"}, tier=${opts.tier})`);

  console.log(`\n=== variant: ${variant.name}${mode === "agent" ? ` (prompt: ${opts.prompt})` : ""} ===`);
  const summaries: CaseSummary[] = [];
  for (const c of cases) {
    const runs: CaseResult[] = [];
    for (let i = 0; i < opts.trials; i++) runs.push(await runOnce(client, c, mode, opts.model, opts.maxTurns, PROMPTS[opts.prompt]));

    const passes = runs.filter((r) => r.pass).length;
    const summary: CaseSummary = {
      id: c.id,
      question: c.question,
      expected: c.expected,
      trials: opts.trials,
      passes,
      pass_rate: passes / opts.trials,
      avg_tool_calls: avg(runs.map((r) => r.tool_calls)),
      ...(mode === "agent"
        ? { avg_input_tokens: avg(runs.map((r) => r.input_tokens ?? 0)), avg_output_tokens: avg(runs.map((r) => r.output_tokens ?? 0)) }
        : {}),
      runs,
    };
    summaries.push(summary);

    const label = passes === opts.trials ? "PASS " : passes === 0 ? "FAIL " : "FLAKY";
    const firstFailure = runs.find((r) => !r.pass)?.reason ?? "";
    console.log(
      `${label} ${c.id.padEnd(22)} ${String(passes).padStart(2)}/${opts.trials}  avg calls=${summary.avg_tool_calls.toFixed(1)}  ${passes === opts.trials ? "" : firstFailure}`,
    );
  }

  const passedRuns = summaries.reduce((sum, c) => sum + c.passes, 0);
  const totalRuns = summaries.length * opts.trials;
  const solid = summaries.filter((c) => c.passes === c.trials).length;
  console.log(
    `${mode} run (${variant.name}): ${passedRuns}/${totalRuns} runs passed (${((passedRuns / totalRuns) * 100).toFixed(1)}%), ` +
      `${solid}/${summaries.length} cases passed every trial, avg ${avg(summaries.map((c) => c.avg_tool_calls)).toFixed(1)} tool calls per run` +
      `${mode === "agent" ? `, model ${opts.model}, ${opts.trials} trial(s) per case` : ""}`,
  );

  await mkdir("results", { recursive: true });
  const file = `results/${mode}-${mode === "agent" ? `${variant.name}-${opts.prompt === "guided" ? "" : `${opts.prompt}-`}` : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(
    file,
    JSON.stringify(
      {
        mode,
        variant: variant.name,
        prompt: mode === "agent" ? opts.prompt : null,
        variant_settings: { descriptions: variant.descriptions, errorHints: variant.errorHints, precomputed: variant.precomputed },
        model: mode === "agent" ? opts.model : null,
        trials: opts.trials,
        run_at: new Date().toISOString(),
        passed_runs: passedRuns,
        total_runs: totalRuns,
        cases: summaries,
      },
      null,
      2,
    ),
  );
  console.log(`saved ${file}`);
  await client.close();

  return {
    variant: variant.name,
    passedRuns,
    totalRuns,
    avgCalls: avg(summaries.map((c) => c.avg_tool_calls)),
    avgInputTokens: avg(summaries.map((c) => c.avg_input_tokens ?? 0)),
    avgOutputTokens: avg(summaries.map((c) => c.avg_output_tokens ?? 0)),
    perCase: new Map(summaries.map((c) => [c.id, { passes: c.passes, trials: c.trials, avgCalls: c.avg_tool_calls }])),
    file,
  };
}

function printComparison(reports: VariantReport[]) {
  console.log("\n=== comparison ===");
  console.log("variant".padEnd(18) + "pass".padEnd(14) + "avg calls".padEnd(12) + "avg input tok/run".padEnd(20) + "avg output tok/run");
  for (const r of reports) {
    const pct = `${r.passedRuns}/${r.totalRuns} (${((r.passedRuns / r.totalRuns) * 100).toFixed(0)}%)`;
    console.log(r.variant.padEnd(18) + pct.padEnd(14) + r.avgCalls.toFixed(1).padEnd(12) + r.avgInputTokens.toFixed(0).padEnd(20) + r.avgOutputTokens.toFixed(0));
  }
  console.log("\nper case (passes/trials, avg calls):");
  const ids = [...reports[0]!.perCase.keys()];
  console.log("case".padEnd(24) + reports.map((r) => r.variant.padEnd(18)).join(""));
  for (const id of ids) {
    const cells = reports.map((r) => {
      const c = r.perCase.get(id)!;
      return `${c.passes}/${c.trials} (${c.avgCalls.toFixed(1)})`.padEnd(18);
    });
    console.log(id.padEnd(24) + cells.join(""));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "oracle" },
      model: { type: "string", default: process.env.EVAL_MODEL ?? "claude-sonnet-5-5" },
      case: { type: "string" },
      "max-turns": { type: "string", default: "10" },
      trials: { type: "string", default: "1" },
      variant: { type: "string", default: "full" },
      tier: { type: "string", default: "all" },
      prompt: { type: "string", default: "guided" },
    },
  });
  const mode = values.mode;
  if (mode !== "oracle" && mode !== "agent") throw new Error('--mode must be "oracle" or "agent"');
  if (mode === "agent" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("agent mode needs ANTHROPIC_API_KEY (set it in your shell; do not commit it). Use `npm run eval:oracle` for a no-key run.");
  }
  // The oracle is deterministic, so repeating it would add nothing.
  const trials = mode === "agent" ? Number(values.trials) : 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error("--trials must be an integer from 1 to 20");

  if (!(["core", "hard", "all"] as string[]).includes(values.tier!)) throw new Error('--tier must be "core", "hard" or "all"');

  const prompt = values.prompt as PromptName;
  if (!PROMPT_NAMES.includes(prompt)) throw new Error(`--prompt must be one of: ${PROMPT_NAMES.join(", ")}`);

  const requested = values.variant === "all" ? Object.keys(VARIANTS) : values.variant!.split(",").map((v) => v.trim());
  const variants = requested.map((name) => {
    const v = VARIANTS[name];
    if (!v) throw new Error(`Unknown variant "${name}". Choose from: ${Object.keys(VARIANTS).join(", ")}, or "all".`);
    return v;
  });
  if (mode === "oracle" && (variants.length !== 1 || variants[0]!.name !== "full")) {
    throw new Error("The oracle run only works with the full server (its scripted calls read precomputed fields). Use --mode agent to compare variants.");
  }

  const reports: VariantReport[] = [];
  for (const v of variants) {
    reports.push(await runVariant(v, mode, { model: values.model!, maxTurns: Number(values["max-turns"]), trials, only: values.case, tier: values.tier!, prompt }));
  }
  if (reports.length > 1) printComparison(reports);

  process.exitCode = reports.every((r) => r.passedRuns === r.totalRuns) ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
