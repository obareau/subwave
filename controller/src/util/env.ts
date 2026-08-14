// Typed environment-variable readers — the one place a raw `process.env` string
// becomes a number, a URL or a bounded value.
//
// The problem these replace: config.ts read every numeric var as
// `parseInt(process.env.X || '<default>', 10)`, which yields **NaN** for
// anything that isn't a number, and NaN then travels. `NEWS_MAX_ITEMS=ten`
// removed the headline cap entirely; `PORT=7701 ` (a stray character from a
// copy-pasted .env) bound a random port; a bad `PIPER_SPEED` reached ffmpeg as
// `atempo=NaN`. Every one of those failures is silent at the point of the
// mistake and confusing everywhere downstream.
//
// The posture is WARN AND FALL BACK, never throw. Same reasoning as the state
// bootstrap in docker/broadcast-entrypoint.sh: a station that refuses to boot
// over one malformed convenience var is strictly worse than one that boots on
// the default and says so. A var that is genuinely load-bearing has its own
// explicit check at its own call site (ADMIN_USER/ADMIN_PASS exit on boot in
// production, and that stays where it is).
//
// Issues are collected in `envIssues` as well as warned, so startup can repeat
// them into the booth log — the operator's actual log surface — rather than
// only into a container stdout they may never read.

import { z } from 'zod';

export interface EnvIssue {
  name: string;
  value: string;
  problem: string;
  usedInstead: string;
}

const issues: EnvIssue[] = [];

/** Every malformed env var seen while building config, in read order. */
export function envIssues(): readonly EnvIssue[] {
  return issues;
}

function note(name: string, value: string, problem: string, usedInstead: unknown): void {
  issues.push({ name, value, problem, usedInstead: String(usedInstead) });
  console.warn(`[env] ${name}="${value}" ${problem} — using ${String(usedInstead)} instead`);
}

// Read a var through a schema, falling back to `fallback` (and warning) when it
// is present but doesn't parse. ABSENT and EMPTY both mean "not set" — an env
// file that carries `ANALYZE_URL=` is expressing absence, not an empty value,
// and warning about it would fire on a perfectly ordinary compose file.
function read<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = schema.safeParse(raw.trim());
  if (parsed.success) return parsed.data;
  note(name, raw, parsed.error.issues[0]?.message || 'is not valid', fallback);
  return fallback;
}

export interface NumOptions {
  /** Smallest accepted value, inclusive. Defaults to 1 — the vars here are
   *  timeouts, ports, counts and rate multipliers, where 0 or negative is not a
   *  meaningful setting. Pass 0 explicitly where zero means "disabled". */
  min?: number;
  max?: number;
}

function bounded(base: z.ZodNumber, { min = 1, max }: NumOptions): z.ZodNumber {
  const s = base.min(min, `must be at least ${min}`);
  return max == null ? s : s.max(max, `must be at most ${max}`);
}

/** An integer var. Rejects floats outright rather than truncating them the way
 *  parseInt did — `AUTO_QUEUE_REFRESH_MINUTES=0.5` meant 0 minutes, i.e. a
 *  refresh cron that never rested. */
export function envInt(name: string, fallback: number, opts: NumOptions = {}): number {
  const schema = z
    .string()
    .regex(/^[-+]?\d+$/, 'is not a whole number')
    .transform(Number)
    .pipe(bounded(z.number().int(), opts));
  return read(name, schema, fallback);
}

/** A decimal var (speeds, seconds). */
export function envFloat(name: string, fallback: number, opts: NumOptions = {}): number {
  const schema = z
    .string()
    .regex(/^[-+]?(\d+\.?\d*|\.\d+)$/, 'is not a number')
    .transform(Number)
    .pipe(bounded(z.number().finite(), opts));
  return read(name, schema, fallback);
}

/** An http(s) URL var. A bare host or a `postgres://`-style scheme is rejected —
 *  every URL in the controller's config is fetched with fetch(). */
export function envUrl(name: string, fallback: string): string {
  // One check, not `z.url().refine(…)`: zod runs every check on a string even
  // after an earlier one fails, so the refine still saw the unparseable input
  // and `new URL()` threw straight out of this function — which is exactly the
  // "never throw" contract these readers exist to hold. Parsing inside the
  // predicate is also the honest test: URL is what fetch() will use.
  const schema = z.string().refine((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  }, 'is not an http(s) URL');
  return read(name, schema, fallback);
}

/** A plain string var. Present for symmetry — no validation to fail, so it
 *  never warns; use it so config.ts reads uniformly. */
export function envStr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** A string var constrained to a fixed set of values. */
export function envEnum<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const schema = z.enum(values as unknown as [T, ...T[]]);
  return read<T>(name, schema, fallback);
}
