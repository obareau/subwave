// Push-resolution probe policy — the pure decisions behind "the pick we just
// handed Liquidsoap never became a playable request" (#1405).
//
// Background: drainToLiquidsoap writes one annotated URI to next.txt and marks
// the item `sent`. That is the ONLY confirmation the controller had: a push
// that Liquidsoap accepts but cannot RESOLVE (the origin answered with a
// Subsonic error body, the file is missing, the fetch timed out) drops the
// request silently. The station falls through to the unfiltered auto playlist,
// and because `upcoming.length !== 0` gates the auto-DJ, nothing re-picks until
// reconcileWithDjQueue clears the stale item — and that only runs when an
// UNTRACKED track starts, needing EMPTY_DJ_QUEUE_CLEAR_THRESHOLD of them. Three
// auto tracks is 10-25 minutes of unfiltered radio for one bad URL.
//
// Queue membership cannot answer that question: dj_queue contains idle and
// resolving requests, and a healthy request disappears from queue() while
// boundary prefetch is still downloading it. proto_subhttp therefore records
// an explicit per-handoff outcome and the controller consumes that over telnet.
// Pure and I/O-free so scripts/resolve-probe.test.ts can pin the state machine.

// Poll long enough to cover a slow whole-file fetch. If no explicit outcome
// arrives (old broadcast image, local-file URI, mixer restart), the loop simply
// expires fail-open and the existing reconcile sweep remains the backstop.
export const PUSH_PROBE_INTERVAL_MS = 1_000;
export const PUSH_PROBE_MAX_READS = 60;

// Consecutive resolution failures that may each trigger an immediate re-pick.
// Past it the station coasts on auto.m3u until the next natural pick: when a
// whole music origin is down, every re-pick fails the same way, and a re-pick
// storm burns LLM budget to queue tracks that cannot air. Music never stops
// either way — that is what the auto playlist is for.
export const MAX_CONSECUTIVE_RESOLVE_FAILURES = 3;

// 'resolved' — proto_subhttp returned a checked audio file.
// 'pending'  — the protocol has not completed yet; probe again.
// 'failed'   — proto_subhttp explicitly rejected or failed the fetch.
// 'abandon'  — nothing left to verify, or the outcome channel is unavailable.
export type ProbeVerdict = 'resolved' | 'pending' | 'failed' | 'abandon';
export type ResolveProbeOutcome = 'ready' | 'failed' | 'pending' | 'unknown';

export function parseResolveProbeOutcome(raw: string | null | undefined): ResolveProbeOutcome {
  const word = (raw ?? '').trim();
  if (word === 'ready' || word === 'failed' || word === 'pending') return word;
  return 'unknown';
}

export function probeVerdict(p: {
  // The item is still in `upcoming` and still flagged sent — i.e. it has not
  // aired (onTrackStarted splices it), was not cancelled, and was not already
  // cleared by a reconcile.
  stillQueuedLocally: boolean;
  // Explicit outcome reported by proto_subhttp for this handoff attempt.
  outcome: ResolveProbeOutcome;
}): ProbeVerdict {
  if (!p.stillQueuedLocally) return 'abandon';
  if (p.outcome === 'ready') return 'resolved';
  if (p.outcome === 'failed') return 'failed';
  if (p.outcome === 'unknown') return 'abandon';
  return 'pending';
}

// Whether a confirmed resolution failure may trigger an immediate re-pick.
// `streak` counts failures INCLUDING this one.
export function repickAfterFailure(streak: number): boolean {
  return streak <= MAX_CONSECUTIVE_RESOLVE_FAILURES;
}
