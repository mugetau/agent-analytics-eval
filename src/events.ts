/**
 * Synthetic product-analytics dataset with *planted* ground truth.
 *
 * Everything is generated from a seeded PRNG, so the dataset is identical on every
 * machine. That is what makes the evals meaningful: we know the right answers
 * because we put them there.
 *
 * Planted facts (also asserted in test/analytics.test.ts):
 *  1. SAFARI REGRESSION: for users who sign up on/after 2026-09-15, Safari users convert
 *     from `onboarding_completed` to `project_created` at ~30% instead of ~80%.
 *  2. PAYMENT SPIKE: on 2026-09-20 there are 120 extra `error_occurred` events with
 *     error_type "PaymentTimeout" (normal days have 3-6 errors of other types).
 */

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

export interface AnalyticsEvent {
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  distinct_id: string;
  event: string;
  properties: Props;
}

export const DATASET_START = "2026-09-01";
export const DATASET_DAYS = 28; // 2026-09-01 .. 2026-09-28 inclusive
export const SAFARI_REGRESSION_START = "2026-09-15";
export const PAYMENT_SPIKE_DAY = "2026-09-20";
export const PAYMENT_SPIKE_COUNT = 120;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Small, fast, seedable PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let r = rand() * total;
  for (const [value, weight] of items) {
    r -= weight;
    if (r < 0) return value;
  }
  return items[items.length - 1]![0];
}

const BROWSERS = [
  ["Chrome", 55],
  ["Safari", 25],
  ["Firefox", 12],
  ["Edge", 8],
] as const;

const COUNTRIES = [
  ["US", 30],
  ["DE", 18],
  ["GB", 15],
  ["RS", 12],
  ["NL", 10],
  ["FR", 8],
  ["CH", 7],
] as const;

const PATHS = ["/", "/pricing", "/docs", "/dashboard", "/settings"] as const;

const ERROR_TYPES = [
  ["TypeError", 5],
  ["NetworkError", 3],
  ["ValidationError", 2],
] as const;

interface SyntheticUser {
  id: string;
  browser: string;
  country: string;
  signupMs: number;
  signupDayIndex: number;
}

export function generateEvents(seed = 42, userCount = 1500): AnalyticsEvent[] {
  const rand = mulberry32(seed);
  const startMs = Date.parse(`${DATASET_START}T00:00:00Z`);
  const endMs = startMs + DATASET_DAYS * DAY; // exclusive
  const regressionDayIndex = Math.round((Date.parse(`${SAFARI_REGRESSION_START}T00:00:00Z`) - startMs) / DAY);

  const events: AnalyticsEvent[] = [];
  const push = (ms: number, user: SyntheticUser, event: string, extra: Props = {}) => {
    if (ms >= endMs) return; // events that would fall after the dataset window are dropped
    events.push({
      timestamp: new Date(ms).toISOString(),
      distinct_id: user.id,
      event,
      properties: { browser: user.browser, country: user.country, ...extra },
    });
  };
  const hours = (min: number, max: number) => (min + rand() * (max - min)) * HOUR;

  const users: SyntheticUser[] = [];
  for (let i = 0; i < userCount; i++) {
    const signupMs = startMs + Math.floor(rand() * DATASET_DAYS * DAY);
    users.push({
      id: `user_${String(i + 1).padStart(4, "0")}`,
      browser: pick(rand, BROWSERS),
      country: pick(rand, COUNTRIES),
      signupMs,
      signupDayIndex: Math.floor((signupMs - startMs) / DAY),
    });
  }

  for (const user of users) {
    push(user.signupMs, user, "signed_up", { plan: "free" });

    const pageViews = 1 + Math.floor(rand() * 6);
    for (let p = 0; p < pageViews; p++) {
      push(user.signupMs + hours(0, 48), user, "page_viewed", { path: pick(rand, PATHS.map((x) => [x, 1] as const)) });
    }

    let t = user.signupMs;
    if (rand() < 0.75) {
      t += hours(0.1, 3);
      push(t, user, "onboarding_completed");

      const regressed = user.browser === "Safari" && user.signupDayIndex >= regressionDayIndex;
      if (rand() < (regressed ? 0.3 : 0.8)) {
        t += hours(0.2, 24);
        push(t, user, "project_created");

        if (rand() < 0.4) {
          t += hours(1, 72);
          push(t, user, "invited_teammate");

          if (rand() < 0.35) {
            t += hours(1, 96);
            push(t, user, "upgraded", { plan: "pro" });
          }
        }
      }
    }
  }

  // Baseline errors: a handful per day, from random users.
  for (let day = 0; day < DATASET_DAYS; day++) {
    const n = 3 + Math.floor(rand() * 4);
    for (let j = 0; j < n; j++) {
      const user = users[Math.floor(rand() * users.length)]!;
      push(startMs + day * DAY + Math.floor(rand() * DAY), user, "error_occurred", {
        error_type: pick(rand, ERROR_TYPES),
      });
    }
  }

  // Planted anomaly: payment timeout spike.
  const spikeStart = Date.parse(`${PAYMENT_SPIKE_DAY}T00:00:00Z`);
  for (let j = 0; j < PAYMENT_SPIKE_COUNT; j++) {
    const user = users[Math.floor(rand() * users.length)]!;
    push(spikeStart + Math.floor(rand() * DAY), user, "error_occurred", { error_type: "PaymentTimeout" });
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return events;
}
