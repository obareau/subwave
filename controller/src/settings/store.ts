// The loaded-settings cache and the accessors that read it. This is the seam
// that keeps the rest of the settings/ modules free of an import cycle back to
// settings.ts: load()/update() own writing the cache, everyone else reads it
// through get()/peek() here.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { MOOD_DEFAULTS, PERIOD_MOOD_DEFAULTS, WEATHER_MOOD_DEFAULTS } from './vocab.js';
import { DEFAULTS } from './defaults.js';

// The loaded settings. Null until load() has run. Only settings.ts writes it,
// and only through setCache() — everything else reads via get()/peek().
let cache: any = null;

// The raw cache, null included. Callers that must distinguish "not loaded yet"
// from "loaded" want this; everyone else wants get(), which substitutes the
// shipped defaults so a pre-load read still answers sensibly.
export function peek(): any {
  return cache;
}

// The single writer, called by load() and update() in settings.ts.
export function setCache(next: any): any {
  cache = next;
  return cache;
}

export function get() {
  return cache || DEFAULTS;
}

export function getDefaults() {
  return DEFAULTS;
}

// --- Live mood accessors — the single seam every consumer reads through, so an
// operator edit takes effect with no restart. Pre-load, get() returns DEFAULTS,
// so these still answer with the seed vocabulary (keeps the standalone
// audio-moods unit test working without a settings.load()). ---
export function moodEntries(): Array<{ name: string; clapPrompt: string }> {
  const m = get().moods;
  return Array.isArray(m) && m.length ? m : MOOD_DEFAULTS;
}
export function moodVocab(): string[] {
  return moodEntries().map((m) => m.name);
}
export function moodPromptFor(name: string): string {
  const e = moodEntries().find((m) => m.name === name);
  return e?.clapPrompt ? e.clapPrompt : `${name} music`;
}
export function moodScheduleFor(period: string): string {
  const s = get().moodSchedule || {};
  return s[period] ?? PERIOD_MOOD_DEFAULTS[period] ?? '';
}
export function weatherMoodFor(condition: string): string {
  const w = get().weatherMoods || {};
  return (w[condition] ?? WEATHER_MOOD_DEFAULTS[condition] ?? '') || '';
}

// Resolve the operator-entered inline API key for a provider from the
// per-provider map (issue #657). Returns '' when none is stored, in which case
// the registry/embedding layer falls through to the provider's env var
// (OPENROUTER_API_KEY etc.) exactly as before. This is the single resolution
// chokepoint — leg assembly (registry.llmCfg / legs.fallbackLeg) and the
// openai-compatible probe/discovery routes all go through it.
export function llmKeyFor(provider: string): string {
  const keys = get().llm?.keys || {};
  const v = keys[provider];
  return typeof v === 'string' ? v : '';
}

// Settings with secret fields masked — for the admin /settings response.
export function getRedacted() {
  const s = get();
  const clone = JSON.parse(JSON.stringify(s));
  if (clone.llm) {
    clone.llm.apiKey = s.llm?.apiKey ? 'set' : '';
    // Per-provider inline keys masked to 'set' | '' per entry, so the admin UI
    // can show which providers have a key on file without exposing the value.
    clone.llm.keys = {};
    for (const p of Object.keys(s.llm?.keys || {})) {
      clone.llm.keys[p] = s.llm.keys[p] ? 'set' : '';
    }
  }
  if (clone.llm?.fallback) clone.llm.fallback.apiKey = s.llm?.fallback?.apiKey ? 'set' : '';
  if (clone.tts?.cloud) {
    clone.tts.cloud.apiKey = s.tts?.cloud?.apiKey ? 'set' : '';
    clone.tts.cloud.compatApiKey = s.tts?.cloud?.compatApiKey ? 'set' : '';
  }
  if (clone.search) clone.search.apiKey = s.search?.apiKey ? 'set' : '';
  if (clone.embedding) clone.embedding.apiKey = s.embedding?.apiKey ? 'set' : '';
  if (Array.isArray(clone.webhooks)) {
    for (let i = 0; i < clone.webhooks.length; i++) {
      clone.webhooks[i].authHeader = s.webhooks?.[i]?.authHeader ? 'set' : '';
    }
  }
  if (clone.scrobble?.lastfm) {
    clone.scrobble.lastfm.apiKey = s.scrobble?.lastfm?.apiKey ? 'set' : '';
    clone.scrobble.lastfm.apiSecret = s.scrobble?.lastfm?.apiSecret ? 'set' : '';
    clone.scrobble.lastfm.sessionKey = s.scrobble?.lastfm?.sessionKey ? 'set' : '';
  }
  if (clone.scrobble?.listenbrainz) {
    clone.scrobble.listenbrainz.userToken = s.scrobble?.listenbrainz?.userToken ? 'set' : '';
  }
  if (clone.privacy) {
    clone.privacy.password = s.privacy?.password ? 'set' : '';
  }
  return clone;
}

// Resolve the effective per-call output-token cap. Returns the operator's
// configured value when set (> 0), else `fallback` — the strategy's own
// built-in default. The single read point for settings.llm.maxOutputTokens;
// strategy/text|object|agent all default their maxOutputTokens param through it.
export function resolveMaxOutputTokens(fallback: number): number {
  const v = get().llm?.maxOutputTokens;
  return typeof v === 'number' && v > 0 ? v : fallback;
}

// Smallest non-zero max-track-length (seconds) validation accepts and the
// admin/show UI offers. The on-air cut fires a crossfade that BEGINS
// crossfadeDuration before the cut point, so a cap below the crossfade is
// degenerate and below 2× leaves the track no solo airtime. 0 (= unlimited) is
// always allowed — this is only the floor for a POSITIVE cap. Surfaced to the UI
// via /settings.values.minTrackSeconds so client and server share one rule.
export function minTrackSeconds(s: { crossfadeDuration?: unknown } | null | undefined = get()): number {
  const xf = Number(s?.crossfadeDuration);
  const cross = Number.isFinite(xf) && xf > 0 ? xf : DEFAULTS.crossfadeDuration;
  return Math.max(30, Math.ceil(2 * cross));
}

