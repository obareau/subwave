// Expressive engines render square-bracket directions; fallback engines speak
// them literally. Keep the primary text untouched and sanitize only its rescue.
export function fallbackTextFor(requested: string, cloudCueFamily: string | null, text: string): string {
  const expressiveRequest = requested === 'chatterbox'
    || cloudCueFamily === 'fish-s21'
    || cloudCueFamily === 'elevenlabs-v3';
  if (!expressiveRequest || !text) return text;
  return text.replace(/\s*\[[^\]\r\n]{1,80}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// A voice slot the dispatcher can speak with: an engine, plus an optional
// persona-shaped override carrying the voice (and cloud provider) to use.
//
// `personaTts: null` on the hardcoded rungs is load-bearing. speakWith()'s
// per-engine branches only read an override when its `engine` matches, so for
// most rescues an override would be inert; the exception is a cloud persona
// that was pre-flight-rerouted because its provider is unconfigured, where
// forwarding it would re-apply the dead provider instead of the station
// default's credentials the availability probe just validated. Only the
// operator's OWN configured slot carries an override, because there the
// provider/voice is an explicit instruction rather than a leftover.
export interface RescueSlot {
  engine: string;
  personaTts: { engine: string; voice: string; cloudProvider: string } | null;
}

export interface TtsFallbackConfig {
  enabled?: boolean;
  engine?: string;
  voice?: string;
  cloudProvider?: string;
}

// The operator's configured fallback (settings.tts.fallback) as a slot, or null
// when the block is absent, disabled, or names an engine this build doesn't
// know. Kept beside the chain so "what does a configured fallback look like"
// has exactly one answer, shared by the pre-flight reroute and the mid-render
// rescue.
export function configuredSlot(
  fallback: TtsFallbackConfig | null | undefined,
  engines: readonly string[],
): RescueSlot | null {
  if (!fallback?.enabled) return null;
  const engine = fallback.engine || '';
  if (!engines.includes(engine)) return null;
  return {
    engine,
    personaTts: {
      engine,
      voice: fallback.voice || '',
      cloudProvider: fallback.cloudProvider || 'openai',
    },
  };
}

// Pure ordering logic for speak()'s runtime rescue chain — extracted from
// tts.ts so scripts/tts-fallback.test.ts can pin it without dragging in the
// engine modules (settings reads, venv existsSyncs, live /health probes).
//
// Order: the operator's CONFIGURED fallback first (their explicit second
// choice, engine AND voice), then the configured default engine, then Piper
// (the universal local floor), then Kokoro (for the case where Piper itself was
// the failed primary). The primary, duplicates, and anything the caller's
// `usable` gate rejects are dropped — so the chain never re-attempts the engine
// that just threw, and never attempts one the pre-flight gate already knows
// can't speak. A disabled fallback (`configured` null) reproduces the
// pre-fallback order exactly.
//
// Dedup is by ENGINE, first-wins: when the configured fallback and the default
// engine name the same engine, the configured slot survives and its voice is
// what speaks. Without that, the operator's chosen voice would be silently
// replaced by the engine's global default on exactly the station where both
// were pointed at the same engine.
//
// `usable` receives the slot's own cloud provider for the configured rung and
// null for the hardcoded ones — the probe must agree with the call, and a
// hardcoded cloud rung speaks with the station default's credentials.
export function orderedFallbacks(
  primary: string,
  configured: RescueSlot | null,
  defaultEngine: string | null | undefined,
  usable: (engine: string, cloudProvider?: string | null) => boolean,
): RescueSlot[] {
  const candidates: RescueSlot[] = [
    ...(configured ? [configured] : []),
    ...[defaultEngine, 'piper', 'kokoro'].map((engine) => ({
      engine: engine || '',
      personaTts: null,
    })),
  ];
  const out: RescueSlot[] = [];
  for (const slot of candidates) {
    const { engine } = slot;
    if (!engine || engine === primary || out.some((s) => s.engine === engine)) continue;
    if (!usable(engine, slot.personaTts?.cloudProvider ?? null)) continue;
    out.push(slot);
  }
  return out;
}
