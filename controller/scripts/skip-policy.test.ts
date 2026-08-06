// Pins the commit-then-skip policy (broadcast/skip-policy.ts) — the pure
// decisions behind an operator skip airing the COMMITTED pick rather than a
// random auto.m3u fill (#1300 bug 6). Under pair-aware drain the held pick
// isn't in dj_queue for most of each track's runtime, and even a sent pick
// may still be resolving — so the skip route commits first, waits for
// Liquidsoap to report a ready request, then skips.
// node:assert-via-tsx style, matching scripts/drain-policy.test.ts.

import assert from 'node:assert/strict';
import {
  parseDjQueueStatus, skipPrepAction, commitSatisfied,
  SKIP_COMMIT_WAIT_MS, SKIP_POLL_INTERVAL_MS, UNKNOWN_STATUS_GRACE_MS,
} from '../src/broadcast/skip-policy.js';

// ── parseDjQueueStatus ───────────────────────────────────────────────────────

// The three words dj_queue_status can answer, whitespace-tolerant (telnet
// responses carry \r\n).
assert.equal(parseDjQueueStatus('ready'), 'ready', 'ready parses');
assert.equal(parseDjQueueStatus('  ready\r\n'), 'ready', 'trims telnet whitespace');
assert.equal(parseDjQueueStatus('resolving'), 'resolving', 'resolving parses');
assert.equal(parseDjQueueStatus('empty'), 'empty', 'empty parses');

// An older radio.liq without the command answers with an error line — that's
// upgrade skew (controller updated before broadcast), not a queue state.
assert.equal(
  parseDjQueueStatus('ERROR: unknown command, type "help" to get the list of commands.'),
  'unknown',
  'unknown command → unknown',
);
assert.equal(parseDjQueueStatus(''), 'unknown', 'empty response → unknown');
assert.equal(parseDjQueueStatus(null), 'unknown', 'null → unknown');
assert.equal(parseDjQueueStatus(undefined), 'unknown', 'undefined → unknown');
// Never guess on a garbled response.
assert.equal(parseDjQueueStatus('READY set go'), 'unknown', 'garbage → unknown');

// ── skipPrepAction ───────────────────────────────────────────────────────────

// Nothing queued → the old bare skip, byte-for-byte: auto.m3u is the honest
// next and there is nothing to commit.
assert.equal(skipPrepAction(0), 'skip-now', 'empty queue → skip now');
// Anything queued → commit before skipping. Covers both the held-unsent pick
// (pair-drain) and the sent-but-still-resolving race.
assert.equal(skipPrepAction(1), 'commit', 'one queued → commit first');
assert.equal(skipPrepAction(3), 'commit', 'several queued → commit first');

// ── commitSatisfied ──────────────────────────────────────────────────────────

// The contract is about the HEAD of upcoming — the track a skip would air.
// Until it reaches dj_queue nothing is committed, whatever the probe says.
assert.equal(
  commitSatisfied({ headSent: false, queueStatus: 'ready', sinceHeadSentMs: 0 }),
  false,
  'head unsent → not satisfied even if the probe says ready',
);

// Sent + a resolved request waiting → the fallback will pick dj_queue. Done.
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'ready', sinceHeadSentMs: 0 }),
  true,
  'sent + ready → satisfied',
);

// Sent but still resolving (or the push hasn't landed on the 1s poll yet) →
// keep waiting; the outer timeout bounds a resolution that never finishes.
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'resolving', sinceHeadSentMs: 10_000 }),
  false,
  'resolving → keep waiting',
);
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'empty', sinceHeadSentMs: 10_000 }),
  false,
  'empty after send → keep waiting (poll race, boundary prefetch, or a failed resolve)',
);

// Upgrade skew: no probe available. Proceed on a fixed grace after the send —
// the 1s queue poll plus a typical fetch — rather than never skipping or
// recreating the bug by skipping at once.
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'unknown', sinceHeadSentMs: 0 }),
  false,
  'unknown status → wait out the grace first',
);
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'unknown', sinceHeadSentMs: UNKNOWN_STATUS_GRACE_MS }),
  true,
  'unknown status → satisfied after the grace',
);

// ── constants ────────────────────────────────────────────────────────────────

// The wait must comfortably cover a drain (writeHandoff waits up to 5s), the
// 1s queue poll, and a typical subhttp fetch — while staying a bounded UI
// action, not a hang.
assert.ok(SKIP_COMMIT_WAIT_MS >= 15_000, 'wait covers drain + poll + fetch');
assert.ok(SKIP_COMMIT_WAIT_MS <= 30_000, 'wait stays a bounded UI action');
assert.ok(SKIP_POLL_INTERVAL_MS <= 1_000, 'poll at least as often as the queue poll');
assert.ok(
  UNKNOWN_STATUS_GRACE_MS + 2 * SKIP_POLL_INTERVAL_MS < SKIP_COMMIT_WAIT_MS,
  'grace fits inside the wait with polls to spare',
);

console.log('skip-policy: all assertions passed');
