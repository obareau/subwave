// Pins the push-resolution probe policy (broadcast/resolve-probe.ts) — the
// pure decisions behind "the pick we just handed Liquidsoap never became a
// playable request" (#1405). A push that Liquidsoap accepts but cannot RESOLVE
// (the origin answered with a Subsonic error body, the file is missing) drops
// the request silently; before this probe the controller only noticed via
// reconcileWithDjQueue, three untracked track starts later.
// node:test style, matching the newer scripts/*.test.ts files.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseResolveProbeOutcome,
  probeVerdict,
  repickAfterFailure,
  MAX_CONSECUTIVE_RESOLVE_FAILURES,
} from '../src/broadcast/resolve-probe.js';

test('an explicit ready outcome resolves the pushed request', () => {
  assert.equal(probeVerdict({ outcome: 'ready', stillQueuedLocally: true }), 'resolved');
});

test('only an explicit failed outcome fails the pushed request', () => {
  assert.equal(probeVerdict({ outcome: 'failed', stillQueuedLocally: true }), 'failed');
});

test('protocol outcomes parse strictly and upgrade skew stays unknown', () => {
  assert.equal(parseResolveProbeOutcome(' ready\r\n'), 'ready');
  assert.equal(parseResolveProbeOutcome('failed'), 'failed');
  assert.equal(parseResolveProbeOutcome('pending'), 'pending');
  assert.equal(parseResolveProbeOutcome('ERROR: unknown command'), 'unknown');
});

test('a pending protocol outcome remains non-actionable', () => {
  // Queue membership is deliberately absent from this policy: it contains
  // unresolved requests and omits healthy boundary-prefetch downloads.
  assert.equal(probeVerdict({ outcome: 'pending', stillQueuedLocally: true }), 'pending');
});

test('an item that left `upcoming` is abandoned, never called failed', () => {
  // onTrackStarted splices the item when it airs — the single most likely
  // reason an id leaves dj_queue. Calling that a failure would drop a track
  // that is on air RIGHT NOW and re-pick over it.
  assert.equal(
    probeVerdict({ outcome: 'failed', stillQueuedLocally: false }),
    'abandon',
  );
  assert.equal(probeVerdict({ outcome: 'ready', stillQueuedLocally: false }), 'abandon');
});

test('an unavailable or unknown outcome channel fails open', () => {
  // Mid-restart / unreachable / garbled. A wrong 'failed' here would drop a
  // perfectly good pick every time the mixer restarts; the pre-#1405
  // reconcile sweep still cleans up genuinely stale items.
  assert.equal(
    probeVerdict({ outcome: 'unknown', stillQueuedLocally: true }),
    'abandon',
  );
});

test('re-picks are budgeted, so a dead origin cannot start a pick storm', () => {
  for (let streak = 1; streak <= MAX_CONSECUTIVE_RESOLVE_FAILURES; streak++) {
    assert.equal(repickAfterFailure(streak), true, `streak ${streak} re-picks`);
  }
  assert.equal(repickAfterFailure(MAX_CONSECUTIVE_RESOLVE_FAILURES + 1), false);
  assert.equal(repickAfterFailure(50), false);
});
