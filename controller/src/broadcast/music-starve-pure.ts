// The music-chain starve signal (#1300 bug 7) — pure decision logic.
//
// Split from the reader (music-starve.ts) so scripts/music-starve.test.ts can
// pin it without dragging in config.js / node:fs, the same split as
// stream-idle-pure.ts and programme-pure.ts.
//
// radio.liq's jingle rotate skips unavailable sources, so with the music chain
// starved (Navidrome unreachable, auto.m3u empty or exhausted) it serves
// stingers back to back forever — and the emergency fallback below it can't
// see that, because `radio` IS available: it is producing jingles. radio.liq
// now samples the pre-rotate chain itself and reports the verdict here, in
// music-starved.json.
//
// Every ambiguous input resolves toward NOT starved — a false "your station is
// broken" banner that never clears is worse than a missed one, and
// NavidromeBanner already covers the most common cause on its own.

/** How stale the heartbeat may get before the marker stops counting as live. */
export const STARVE_MARKER_STALE_MS = 60_000;

export interface StarveState {
  starved: boolean;
  /** Epoch ms the starve began, null when unknown or not starved. */
  since: number | null;
}

const NOT_STARVED: StarveState = { starved: false, since: null };

/** Marker timestamps are liquidsoap `time()` — unix SECONDS. This is the one
 *  place that conversion happens. Returns null for anything unusable. */
function toMs(raw: unknown): number | null {
  const ms = Number(raw) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Decide whether the mixer is currently reporting a starved music chain.
 * `now` is epoch ms; `marker` is the parsed music-starved.json (or null).
 */
export function starveState(marker: unknown, now: number): StarveState {
  if (!marker || typeof marker !== 'object') return NOT_STARVED;
  const m = marker as { starved?: unknown; since?: unknown; at?: unknown };

  // Only a literal true. A truthy value is a malformed marker, not a starve.
  if (m.starved !== true) return NOT_STARVED;

  // The heartbeat is the liveness proof. The marker is never deleted, so
  // without this a mixer that died mid-outage reports a starve forever.
  const atMs = toMs(m.at);
  if (atMs === null) return NOT_STARVED;
  if (now - atMs > STARVE_MARKER_STALE_MS) return NOT_STARVED;

  // `since` is best-effort: a starve we can't date is still a starve.
  return { starved: true, since: toMs(m.since) };
}
