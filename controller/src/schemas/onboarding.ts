// Shared onboarding schemas — the two PROBE bodies and the handful of rules
// the save handler had to hand-roll BECAUSE settings.update() does not own
// them. Executed on BOTH sides: the controller runs them at the route boundary
// and inside /onboarding/save; the browser (web/components/onboarding) runs the
// mirrored copy so a rule can hold a button shut instead of only answering a
// pressed one.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle. Enforced by controller/eslint.config.mjs and gen-schemas.ts.
//
// What is deliberately NOT here: the settings pass-through. Most of
// POST /onboarding/save forwards partial llm / tts / personas / weather
// patches to settings.update(), and a schema in front of that is the /settings
// mega-endpoint problem in miniature — worse than nothing, because z.object
// would strip whatever the wizard learns to send next. Converted is only what
// the ROUTE owns.
import { z } from 'zod';

/**
 * One normalisation for Navidrome credentials, everywhere they travel: trim,
 * and strip trailing slashes off the url — `${url}/rest/ping` against a stored
 * `…:4533/` double-slashes and some proxies 404 it. The PROBE requires all
 * three fields; save must NOT (skipping Navidrome is a supported way through
 * the wizard, and the shell posts the block with empty strings) — so the
 * strict schema below and this lenient helper share the normalisation rather
 * than each stating their own.
 */
export function normalizeNavidromeCredentials(raw: unknown): {
  url: string;
  user: string;
  pass: string;
} {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    url: String(r.url ?? '').trim().replace(/\/+$/, ''),
    user: String(r.user ?? '').trim(),
    pass: String(r.pass ?? ''),
  };
}

// POST /onboarding/test-navidrome — the probe needs something to probe.
export const navidromeProbeSchema = z
  .unknown()
  .transform(normalizeNavidromeCredentials)
  .refine(
    (c) => Boolean(c.url && c.user && c.pass),
    'url, user, and pass are required',
  );

// POST /onboarding/test-llm. The openai-compatible rule used to be a `throw`
// inside the probe's provider switch, so the only way to discover it was to
// press Test and wait — in the schema it also holds the wizard's button shut.
export const llmProbeSchema = z
  .unknown()
  .transform((raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      provider: String(r.provider ?? '').trim(),
      model: String(r.model ?? '').trim(),
      apiKey: String(r.apiKey ?? '').trim(),
      baseUrl: String(r.baseUrl ?? '').trim(),
      ollamaUrl: String(r.ollamaUrl ?? '').trim(),
    };
  })
  .refine((c) => Boolean(c.provider && c.model), 'provider and model are required')
  .refine(
    (c) => c.provider !== 'openai-compatible' || Boolean(c.baseUrl),
    'baseUrl is required for openai-compatible',
  );
export type LlmProbeInput = z.output<typeof llmProbeSchema>;

/**
 * Fish Audio's provider-specific save rule: a message, or null when fine.
 *
 * Deliberately NOT a schema over the tts patch — a schema that has to strip
 * nothing is the wrong tool when the object belongs to settings.update(); this
 * helper inspects one nested block without claiming ownership of the object
 * around it. It is the ONE copy: the route ran `1-100` while the wizard ran
 * `1–100` — same logic, drifted message, which is what the drift looks like
 * *before* it becomes a bug.
 */
export function fishAudioIssue(cloud: unknown): string | null {
  const c = (cloud && typeof cloud === 'object' ? cloud : {}) as Record<string, unknown>;
  if (c.enabled !== true || c.provider !== 'fish-audio') return null;
  const bad = (v: unknown) => {
    const s = String(v ?? '').trim();
    return !s || s.length > 100 || /[\r\n]/.test(s);
  };
  if (bad(c.model)) return 'Fish Audio model id must be 1-100 characters with no line breaks';
  if (bad(c.voice)) return 'Fish Audio voice reference id must be 1-100 characters with no line breaks';
  return null;
}
