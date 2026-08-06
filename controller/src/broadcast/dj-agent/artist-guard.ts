// Back-to-back artist guard policy — pure, unit-pinned (#1124 / #1187 / #1251).
//
// The guard itself lives in dj-agent.pickViaAgent: when the agent's pick repeats
// the artist already on air, it re-picks from the run's OWN candidates. This
// module owns the one question that re-pick has to answer — WHICH candidates it
// may choose from — so the answer is testable without a model call, and so the
// policy isn't spread across the call site.
//
// #1251: excluding only the on-air artist gave the re-pick no memory of the
// slots before it. On any catalogue with a deep bench for the show's filters,
// whichever artist ranks next-highest wins the re-pick, and wins it AGAIN the
// next time the guard fires — no adjacent repeats, but the same artist every
// other slot (observed live: Marvin Gaye in 3 of 5 slots, all three placed by
// the guard). So the re-pick also steps around the artists of the last few
// plays, and only falls back to the bare on-air exclusion when that leaves it
// nothing — the same never-starve philosophy as #1187's pool rescue.

import { artistRootKey, type CandidateLike } from '../../music/recency.js';

// How many recent plays the re-pick remembers. 5 covers the reported
// oscillation (an artist re-entering every other slot is inside any window ≥ 2;
// 5 also catches the slower every-third-slot shape) while staying far below the
// point where a show-filtered run's candidate set is likely to be wholly recent
// — and if it ever is, the fallback below hands the bare exclusion back rather
// than starving.
//
// NOTE the effective exclusion is wider than "5 plays": neighbourArtistRoots(n)
// gathers up to n queued-and-unaired tracks AND the on-air track AND the last n
// distinct plays — so this window can exclude up to 2n+1 artists, by design
// (the queued side is what covers pair-aware drains, where the pick is not
// adjacent to the track on air).
export const ARTIST_VARIETY_WINDOW = 5;

export interface AlternativePool<T> {
  // The candidates the re-pick may choose from, keyed by id as `seen` is.
  alt: Map<string, T>;
  // How many other-artist candidates the recency window removed. 0 means it
  // removed none — because no recent artist was in the pool, or because the
  // window emptied it and was overridden (see `starved`).
  dropped: number;
  // True when EVERY alternative was a recently-heard artist and the window was
  // overridden — the bare on-air exclusion was handed back. Distinguishes
  // "the window was a no-op" from "the window was overruled" in telemetry;
  // `dropped` is 0 in both cases.
  starved: boolean;
}

// The candidate set for a guard re-pick.
//
// `avoidRoot` is the predecessor's lead key (artistRootKey), `recentRoots` the
// lead keys of the surrounding slots (queue.neighbourArtistRoots — queued and
// unaired, on air, and the last few plays). Candidates with no artist at all are
// never dropped — an untagged track is not evidence of a repeat, and dropping it
// would narrow thin runs for nothing.
export function alternativeCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  avoidRoot: string,
  recentRoots: Set<string> = new Set(),
): AlternativePool<T> {
  const base = [...seen].filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || root !== avoidRoot;
  });
  if (!base.length || !recentRoots.size) return { alt: new Map(base), dropped: 0, starved: false };

  const fresh = base.filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || !recentRoots.has(root);
  });
  // Every alternative is a recently-heard artist. Hand back the unnarrowed set:
  // a same-artist repeat one slot later is a worse outcome than a same-artist
  // repeat five slots later, and the caller's pool rescue is the wrong escalation
  // here — the run DID surface another artist.
  if (!fresh.length) return { alt: new Map(base), dropped: 0, starved: true };

  return { alt: new Map(fresh), dropped: base.length - fresh.length, starved: false };
}
