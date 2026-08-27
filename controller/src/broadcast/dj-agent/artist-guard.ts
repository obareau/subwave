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
//
// #1406: that recency window only narrowed the re-pick POOL — the guard itself
// still fired on the on-air artist alone, so a pick three slots after the same
// artist was never examined and the window never consulted. The entry condition
// is the window too now (artistGuardCause below), which is what turns "no
// adjacent repeats" into actual spacing across a show.

import { artistRootKey, type CandidateLike } from '../../music/recency.js';

// Re-exported so the guard's own tests read its comparison key from the module
// that uses it, rather than reaching past it into music/recency.
export { artistRootKey };

// Default for `settings.llm.artistVarietyWindow` — how many recent plays the
// guard remembers. 5 covers the reported oscillation (an artist re-entering
// every other slot is inside any window ≥ 2; 5 also catches the slower
// every-third-slot shape) while staying far below the point where a
// show-filtered run's candidate set is likely to be wholly recent — and if it
// ever is, the fallbacks below hand the bare exclusion back rather than starving.
//
// NOTE the effective exclusion is wider than "5 plays": neighbourArtistRoots(n)
// gathers up to n queued-and-unaired tracks AND the on-air track AND the last n
// distinct plays — so this window can exclude up to 2n+1 artists, by design
// (the queued side is what covers pair-aware drains, where the pick is not
// adjacent to the track on air).
export const ARTIST_VARIETY_WINDOW = 5;

// Why the guard fired — 'onair' is the back-to-back repeat (#1124), 'recent' the
// spacing miss (#1406: legal 3-slots-apart repeats that still read as the same
// artist all morning). They are NOT the same event and the caller escalates them
// differently, which is the whole reason this returns a cause rather than a
// boolean: back-to-back is worth a pool rescue and a relaxation log; spacing is
// a preference that yields to whatever the run already surfaced.
export type ArtistGuardCause = 'onair' | 'recent' | null;

// Does this pick need the guard?
//
// `recentRoots` is queue.neighbourArtistRoots(window) and already CONTAINS the
// on-air artist, so the on-air test is checked first purely to name the cause —
// an empty window (operator set 0) still leaves back-to-back protection intact.
// An untagged pick is never guarded: no artist is not evidence of a repeat.
export function artistGuardCause(
  pickRoot: string,
  onAirRoot: string,
  recentRoots: Set<string> = new Set(),
): ArtistGuardCause {
  if (!pickRoot) return null;
  if (onAirRoot && pickRoot === onAirRoot) return 'onair';
  return recentRoots.has(pickRoot) ? 'recent' : null;
}

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
// `avoidRoot` is the lead key (artistRootKey) of the artist being steered away
// from — the rejected pick's own artist, which on the 'onair' cause IS the
// on-air artist. `recentRoots` is the lead keys of the surrounding slots
// (queue.neighbourArtistRoots — queued and unaired, on air, and the last few
// plays), so the on-air artist is excluded on either cause. Candidates with no
// artist at all are
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

// ── The guard itself ───────────────────────────────────────────────────────

// What the guard did, for the caller to act on. Split by OUTCOME rather than by
// cause: the call site's job is only "did the pick change, and does the slot
// still need filling", and every relaxation reason has already been logged here.
export type ArtistGuardOutcome<T> =
  // The guard didn't fire — the overwhelming majority of picks.
  | { kind: 'none' }
  // Fired, and the pick stands anyway. Relaxed, logged, slot still ours.
  | { kind: 'kept' }
  // Fired and the re-pick landed: use these in place of the original pick.
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T }
  // The pool rescue filled the slot itself (it enqueues, links and records its
  // own session turn), so the caller has nothing left to do for this pick.
  | { kind: 'rescued' };

// Everything the guard needs, injected — no queue, no settings, no model. This
// module stays the ONE place the guard's decisions live (the reason it exists;
// see the header), and injecting the two expensive calls is what makes the
// wiring between those decisions testable without a model call, which is the
// half that was previously only verifiable by reading (#1406).
export interface ArtistGuardDeps<T> {
  // The agent's pick and the track it would follow.
  song: T;
  object: { id?: string | null } & Record<string, unknown>;
  current: CandidateLike | null;
  // The run's own candidates, keyed by id, as pickViaAgent's `extras.seen`.
  seen: Iterable<[string, T]>;
  // queue.neighbourArtistRoots(window) — passed in rather than fetched, so the
  // caller owns every queue read. `window` is carried only for the log text.
  recentRoots: Set<string>;
  window: number;
  // A constrained re-pick over `alt`. Returns the model's object, or null when
  // the call failed or answered with an id outside the set it was offered.
  repick: (
    alt: Map<string, T>,
    reason: string,
  ) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  // The fallback pool asked for a pick that is NOT this artist. Only ever
  // called on the back-to-back cause — see the note at its call site.
  poolRescue: (avoidArtist: string) => Promise<'queued' | 'empty' | 'collision'>;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runArtistGuard<T extends CandidateLike>(
  deps: ArtistGuardDeps<T>,
): Promise<ArtistGuardOutcome<T>> {
  const { song, current, seen, recentRoots, window, repick, poolRescue, log, logEvent } = deps;

  const pickRoot = artistRootKey(song);
  const cause = artistGuardCause(pickRoot, artistRootKey(current || {}), recentRoots);
  if (!cause) return { kind: 'none' };

  const { alt, dropped, starved } = alternativeCandidates<T>(seen, pickRoot, recentRoots);
  const label = cause === 'onair' ? 'back-to-back artist' : 'recently-played artist';

  // Spacing yields to the run. `starved` means every alternative the agent
  // surfaced is ALSO inside the window; an empty `alt` means the run was
  // single-artist. Either way there is no fresher artist to re-pick, and
  // spending a re-pick call plus a pool rescue to arrive back here would buy
  // latency and nothing else. Back-to-back still escalates through both,
  // because an artist following itself is not a preference.
  if (cause === 'recent' && (starved || !alt.size)) {
    logEvent('pick.artistGuard', {
      relaxed: true, cause, reason: alt.size ? 'all-recent' : 'no-other-artist',
      artist: song.artist, candidates: alt.size, window,
    });
    log(`recently-played artist "${song.artist}" allowed — no fresher artist among the run's candidates (spacing window ${window} slots)`);
    return { kind: 'kept' };
  }

  if (alt.size) {
    const repicked = await repick(
      alt,
      cause === 'onair'
        ? `The track you chose is by ${song.artist}, the artist already on air — never play the same artist twice in a row. Choose a DIFFERENT artist from the candidates above.`
        : `The track you chose is by ${song.artist}, who has already played in the last few slots — space artists out across the show. Choose a DIFFERENT artist from the candidates above.`,
    );
    // Resolved from `alt`, not the full `seen`: the re-pick's id is constrained
    // to the alternatives by construction (z.enum), and reading it back out of
    // the narrower map is what keeps that true if the schema ever gains a
    // tolerance for ids it didn't offer.
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked) {
      logEvent('pick.artistGuard', { relaxed: false, cause, from: song.artist, to: altSong.artist, candidates: alt.size, recencySkipped: dropped, recencyStarved: starved, window });
      log(`${label} "${song.artist}" avoided — re-picked "${altSong.title}" by ${altSong.artist} from ${alt.size} other-artist candidate(s)${dropped ? `, ${dropped} more skipped as recently-played artists` : ''}${starved ? ' (every alternative was recently played — recency window waived)' : ''}`);
      return { kind: 'repicked', object: repicked, song: altSong };
    }
  }

  // A failed spacing re-pick keeps the pick. The pool rescue below answers
  // "does another artist exist AT ALL", which is only in doubt for back-to-back
  // — here the run demonstrably surfaced one and the model declined to take it,
  // so the honest outcome is the original pick, not a second model call chasing
  // a preference.
  if (cause === 'recent') {
    logEvent('pick.artistGuard', {
      relaxed: true, cause, reason: 'repick-failed',
      artist: song.artist, candidates: alt.size, window,
    });
    log(`recently-played artist "${song.artist}" allowed — re-pick from ${alt.size} other-artist candidate(s) didn't land (spacing window ${window} slots)`);
    return { kind: 'kept' };
  }

  // Pool rescue (#1187). It enqueues, links and records its own session turn on
  // success, so a 'queued' answer means the slot is filled and the caller is
  // done. `enqueuePick`'s dedup still applies: a pool pick colliding with
  // something already queued reports 'collision' and falls through to the
  // relaxation below rather than silently dropping the slot.
  const rescued = await poolRescue(song.artist || '');
  // Why the rescue ran, phrased for the booth log: the run either surfaced no
  // other artist at all, or surfaced some and the constrained re-pick call over
  // them failed — two different stations of the same rescue.
  const runWasThin = alt.size
    ? `re-pick from ${alt.size} other-artist candidate(s) didn't land`
    : 'every agent candidate was that artist';
  if (rescued === 'queued') {
    logEvent('pick.artistGuard', { relaxed: false, reason: 'pool-rescue', artist: song.artist, candidates: alt.size });
    log(`back-to-back artist "${song.artist}" avoided — ${runWasThin}, so the pick came from the fallback pool instead`);
    return { kind: 'rescued' };
  }
  // poolRescue distinguishes 'empty' (the pool truly holds no other artist)
  // from 'collision' (it produced a pick that deduped against something already
  // queued) — an operator reading #1187-style reports must be able to tell "the
  // library really had nothing" from "a request slipped in mid-pick".
  const reason = alt.size ? 'repick-failed' : 'no-other-artist';
  logEvent('pick.artistGuard', { relaxed: true, reason, artist: song.artist, candidates: alt.size, poolRescue: rescued });
  log(`back-to-back artist "${song.artist}" allowed — ${runWasThin} and the fallback pool ${rescued === 'collision' ? 'pick was already queued' : 'had none either'} (relaxed)`);
  return { kind: 'kept' };
}
