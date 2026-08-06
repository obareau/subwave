// Pins the music-starve marker contract (broadcast/music-starve-pure.ts) — how the
// controller reads radio.liq's music-starved.json (#1300 bug 7).
//
// Every ambiguous case resolves toward NOT starved. A false "your station is
// broken" banner that never clears is worse than a missed one, and the
// Navidrome banner already covers the most common cause on its own.
// node:assert-via-tsx style, matching scripts/skip-policy.test.ts.

import assert from 'node:assert/strict';
import { starveState, STARVE_MARKER_STALE_MS } from '../src/broadcast/music-starve-pure.js';

const NOW = 1_785_000_000_000;         // epoch ms
const SEC = (ms: number) => ms / 1000; // marker timestamps are unix SECONDS

// ── absent / malformed ───────────────────────────────────────────────────────

// No marker at all: an older broadcast image doesn't write this file. Upgrade
// skew must not read as a permanent outage.
assert.deepEqual(starveState(null, NOW), { starved: false, since: null }, 'null → not starved');
assert.deepEqual(starveState(undefined, NOW), { starved: false, since: null }, 'undefined → not starved');
assert.deepEqual(starveState('nonsense', NOW), { starved: false, since: null }, 'string → not starved');
assert.deepEqual(starveState(42, NOW), { starved: false, since: null }, 'number → not starved');
assert.deepEqual(starveState({}, NOW), { starved: false, since: null }, 'empty object → not starved');

// ── the healthy steady state ─────────────────────────────────────────────────

// radio.liq writes starved:false at startup, so this is what a working station
// looks like on disk.
assert.deepEqual(
  starveState({ starved: false, since: 0, at: SEC(NOW) }, NOW),
  { starved: false, since: null },
  'starved:false → not starved',
);

// Only a literal `true` counts — never a truthy value.
assert.deepEqual(
  starveState({ starved: 'true', at: SEC(NOW) }, NOW),
  { starved: false, since: null },
  'truthy string is not true',
);
assert.deepEqual(
  starveState({ starved: 1, at: SEC(NOW) }, NOW),
  { starved: false, since: null },
  'truthy number is not true',
);

// ── a live starve ────────────────────────────────────────────────────────────

const since = SEC(NOW - 90_000);
assert.deepEqual(
  starveState({ starved: true, since, at: SEC(NOW - 1000) }, NOW),
  { starved: true, since: NOW - 90_000 },
  'fresh heartbeat → starved, since converted to ms',
);

// ── staleness: the heartbeat is the liveness proof ───────────────────────────

// The marker is never deleted, so a mixer that died mid-outage would otherwise
// report a starve forever. `at` is refreshed every tick while starved.
assert.deepEqual(
  starveState({ starved: true, since, at: SEC(NOW - 5 * 60_000) }, NOW),
  { starved: false, since: null },
  'stale heartbeat → not starved',
);

// Exact boundary: at the threshold the marker is still LIVE; strictly past it
// is stale.
assert.equal(
  starveState({ starved: true, since, at: SEC(NOW - STARVE_MARKER_STALE_MS) }, NOW).starved,
  true,
  'exactly at the threshold is still live',
);
assert.equal(
  starveState({ starved: true, since, at: SEC(NOW - STARVE_MARKER_STALE_MS - 1) }, NOW).starved,
  false,
  'one ms past the threshold is stale',
);

// A missing or unusable `at` is not a heartbeat — it cannot prove liveness.
assert.equal(starveState({ starved: true, since }, NOW).starved, false, 'no at → not starved');
assert.equal(
  starveState({ starved: true, since, at: 'soon' }, NOW).starved, false, 'non-numeric at → not starved',
);
assert.equal(
  starveState({ starved: true, since, at: 0 }, NOW).starved, false, 'zero at → not starved',
);

// Container/host clock skew can put `at` slightly ahead. That's still a live
// heartbeat — don't discard it.
assert.equal(
  starveState({ starved: true, since, at: SEC(NOW + 2000) }, NOW).starved,
  true,
  'future at is still live',
);

// ── since is best-effort ─────────────────────────────────────────────────────

// A starve is a starve even if we can't say when it began — report it with a
// null start rather than suppressing the whole signal.
assert.deepEqual(
  starveState({ starved: true, at: SEC(NOW) }, NOW),
  { starved: true, since: null },
  'missing since → starved with null since',
);
assert.deepEqual(
  starveState({ starved: true, since: 'ages', at: SEC(NOW) }, NOW),
  { starved: true, since: null },
  'garbage since → starved with null since',
);

console.log('music-starve: all assertions passed');
