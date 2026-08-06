// Commit-then-skip policy — the pure decisions behind an operator skip airing
// the committed pick rather than a random auto.m3u fill (#1300 bug 6).
//
// Background: pair-aware drain (drain-policy.ts) deliberately HOLDS the tail
// pick out of Liquidsoap's dj_queue for most of each track's runtime, so an
// empty dj_queue mid-track is the NORMAL state for DJ-mode personas — and a
// bare telnet `skip` falls through to the randomized auto playlist. Even a
// sent pick can lose the race: a request is only eligible once resolved (a
// full subhttp fetch), and the fallback picks whichever source is ready at
// the seam. So POST /dj/skip commits first (force-drain), waits for the
// dj_queue_status probe to report a ready request, then skips. Pure and
// I/O-free so scripts/skip-policy.test.ts can pin the state machine.

// Upper bound on the whole commit wait. Must cover a drain (writeHandoff
// waits up to 5s per write), the 1s queue poll, and a typical subhttp fetch,
// while staying a bounded UI action — past it the skip proceeds anyway
// (operator intent to end THIS track outranks what fills the slot) with the
// outcome reported honestly.
export const SKIP_COMMIT_WAIT_MS = 20_000;

// How often the wait loop re-reads queue state + probes dj_queue_status.
export const SKIP_POLL_INTERVAL_MS = 500;

// Upgrade-skew path: an older radio.liq without dj_queue_status can't report
// readiness, so after the head is sent the wait proceeds on a fixed grace —
// the 1s queue poll plus a typical fetch — rather than never skipping or
// recreating the bug by skipping at once.
export const UNKNOWN_STATUS_GRACE_MS = 5_000;

// What the dj_queue_status telnet command answered: 'ready' (a resolved
// request is waiting — the fallback will pick dj_queue at the seam),
// 'resolving' (pushed but still downloading), 'empty', or 'unknown' (error
// text / garbled response / older radio.liq without the command).
export type DjQueueStatus = 'ready' | 'resolving' | 'empty' | 'unknown';

export function parseDjQueueStatus(raw: string | null | undefined): DjQueueStatus {
  const word = (raw ?? '').trim();
  if (word === 'ready' || word === 'resolving' || word === 'empty') return word;
  return 'unknown';
}

export type SkipPrep = 'skip-now' | 'commit';

// Nothing queued → the old bare skip, byte-for-byte: auto.m3u is the honest
// next and there is nothing to commit. Anything queued → commit first, which
// covers both the held-unsent pick and the sent-but-still-resolving race.
export function skipPrepAction(upcomingCount: number): SkipPrep {
  return upcomingCount > 0 ? 'commit' : 'skip-now';
}

// Whether the wait loop can hand over to the telnet skip. The contract is
// about the HEAD of upcoming — the track a skip would air — so a busy sender
// still rendering a LATER item's TTS never delays the skip. 'empty' after a
// send is kept-waiting, never satisfied: it can be the 1s poll race or a
// boundary prefetch (invisible to queue(), same blind spot dj_queue_remove
// documents), and treating it as proof of an idle queue would reintroduce
// the bug for exactly the window the probe exists to close.
export function commitSatisfied(p: {
  headSent: boolean;
  queueStatus: DjQueueStatus;
  sinceHeadSentMs: number;
}): boolean {
  if (!p.headSent) return false;
  if (p.queueStatus === 'ready') return true;
  if (p.queueStatus === 'unknown') return p.sinceHeadSentMs >= UNKNOWN_STATUS_GRACE_MS;
  return false;
}
