/**
 * Eval runner.
 *
 *   npm run eval:oracle                 scripted tool calls, no LLM: checks the tools can answer every question
 *   npm run eval:agent                  a Claude model answers each question using only the MCP tools
 *   npm run eval:agent -- --trials 3                  repeat each question 3 times (LLM answers vary between runs)
 *   npm run eval:agent -- --case error-spike-day --model <model-id> --max-turns 8
 *
 * Agent mode needs ANTHROPIC_API_KEY. Results are written to results/<mode>-<timestamp>.json.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateEvents } from "../events.js";
import { buildCases, type EvalCase } from "./cases.js";
import { connectInMemory } from "./connect.js";
import { grade, type Grade } from "./grade.js";

const SYSTEM_PROMPT = `You are a product analytics assistant. Answer the user's question using ONLY the provided tools; never guess or use outside knowledge.
Call get_schema first if you are unsure which events or properties exist. If the data cannot answer the question, say so instead of estimating.
Finish with exactly one line in this form:
FINAL ANSWER: <answer>
Rules for the answer: a number is just the number (no units, no % sign); a date is YYYY-MM-DD; a category is just its name; if the data cannot answer the question, write FINAL ANSWER: UNANSWERABLE`;

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

async function runAgent(client: Client, question: string, model: string, maxTurns: number, trace: ToolTraceEntry[]) {
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
    const response = await anthropic.messages.create({ model, max_tokens: 1500, system: SYSTEM_PROMPT, tools: claudeTools, messages });
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

async function runOnce(client: Client, c: EvalCase, mode: "oracle" | "agent", model: string, maxTurns: number): Promise<CaseResult> {
  const trace: ToolTraceEntry[] = [];
  let usage: { input?: number; output?: number } = {};
  let g: Grade;
  try {
    let answer: string;
    if (mode === "oracle") {
      answer = await c.oracle(traced(client, trace));
    } else {
      const r = await runAgent(client, c.question, model, maxTurns, trace);
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

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "oracle" },
      model: { type: "string", default: process.env.EVAL_MODEL ?? "claude-sonnet-5-5" },
      case: { type: "string" },
      "max-turns": { type: "string", default: "10" },
      trials: { type: "string", default: "1" },
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

  const events = generateEvents();
  const client = await connectInMemory(events);
  const cases = buildCases(events).filter((c) => !values.case || c.id === values.case);
  if (cases.length === 0) throw new Error(`No case matches "${values.case}"`);

  const summaries: CaseSummary[] = [];
  for (const c of cases) {
    const runs: CaseResult[] = [];
    for (let i = 0; i < trials; i++) runs.push(await runOnce(client, c, mode, values.model!, Number(values["max-turns"])));

    const passes = runs.filter((r) => r.pass).length;
    const summary: CaseSummary = {
      id: c.id,
      question: c.question,
      expected: c.expected,
      trials,
      passes,
      pass_rate: passes / trials,
      avg_tool_calls: avg(runs.map((r) => r.tool_calls)),
      ...(mode === "agent"
        ? { avg_input_tokens: avg(runs.map((r) => r.input_tokens ?? 0)), avg_output_tokens: avg(runs.map((r) => r.output_tokens ?? 0)) }
        : {}),
      runs,
    };
    summaries.push(summary);

    const label = passes === trials ? "PASS " : passes === 0 ? "FAIL " : "FLAKY";
    const firstFailure = runs.find((r) => !r.pass)?.reason ?? "";
    console.log(
      `${label} ${c.id.padEnd(22)} ${String(passes).padStart(2)}/${trials}  avg calls=${summary.avg_tool_calls.toFixed(1)}  ${passes === trials ? "" : firstFailure}`,
    );
  }

  const passedRuns = summaries.reduce((s, c) => s + c.passes, 0);
  const totalRuns = summaries.length * trials;
  const solid = summaries.filter((c) => c.passes === c.trials).length;
  console.log(
    `\n${mode} run: ${passedRuns}/${totalRuns} runs passed (${((passedRuns / totalRuns) * 100).toFixed(1)}%), ` +
      `${solid}/${summaries.length} cases passed every trial, avg ${avg(summaries.map((c) => c.avg_tool_calls)).toFixed(1)} tool calls per run` +
      `${mode === "agent" ? `, model ${values.model}, ${trials} trial(s) per case` : ""}`,
  );

  await mkdir("results", { recursive: true });
  const file = `results/${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(
    file,
    JSON.stringify(
      {
        mode,
        model: mode === "agent" ? values.model : null,
        trials,
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
  process.exitCode = passedRuns === totalRuns ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
