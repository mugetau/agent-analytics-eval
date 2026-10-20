export type Expected =
  | { kind: "number"; value: number; tolerance: number }
  | { kind: "text"; value: string }
  | { kind: "unanswerable" };

export interface Grade {
  pass: boolean;
  got: string | null;
  reason: string;
}

/** Agents are told to finish with a line `FINAL ANSWER: <answer>`. We grade only that line. */
export function extractFinal(text: string): string | null {
  const matches = [...text.matchAll(/FINAL ANSWER:\s*(.+)/gi)];
  const last = matches[matches.length - 1];
  return last ? last[1]!.trim() : null;
}

const normalize = (s: string) => s.trim().replace(/^["'`*]+|["'`*.]+$/g, "").trim().toLowerCase();

export function grade(expected: Expected, answerText: string): Grade {
  const got = extractFinal(answerText);
  if (got === null) return { pass: false, got, reason: "no 'FINAL ANSWER:' line" };

  switch (expected.kind) {
    case "number": {
      const parsed = Number.parseFloat(got.replace(/[,%\s]/g, ""));
      if (Number.isNaN(parsed)) return { pass: false, got, reason: "answer is not a number" };
      const ok = Math.abs(parsed - expected.value) <= expected.tolerance;
      return { pass: ok, got, reason: ok ? "ok" : `expected ${expected.value} (±${expected.tolerance}), got ${parsed}` };
    }
    case "text": {
      const ok = normalize(got) === normalize(expected.value);
      return { pass: ok, got, reason: ok ? "ok" : `expected "${expected.value}"` };
    }
    case "unanswerable": {
      const ok = /^unanswerable\b/i.test(normalize(got));
      return { pass: ok, got, reason: ok ? "ok" : "should have said UNANSWERABLE (the data cannot answer this)" };
    }
  }
}
