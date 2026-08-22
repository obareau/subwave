// Pins the banter WINDOW (broadcast/banter-policy.ts + dj-gate's 'banter' rung).
//
// The bug this replaces (#1419): the gap was evaluated at exactly two instants
// an hour, so a station ident scheduled at :15 but boundary-deferred to :19:35
// left 25s of quiet at the :20 tick, the tick stood down, and the next chance
// was 30 minutes away — on `moderate`, which owns only the :20 slot, the whole
// hour was gone. Hours of eligible guest shows aired no banter at all, silently.
//
// Five properties are load-bearing, and each is a real way this regresses:
//
//  - The window has a TAIL. If a minute inside :20–:29 stops reading as the :20
//    slot, the retry is gone and we are back to a single instant.
//  - The retry minute keeps its slot's IDENTITY. dj-gate's rungs are keyed on
//    the slot, so if :24 resolved to anything but 20 a `moderate` station would
//    either lose its retry or gain a second exchange it never had.
//  - The gap itself is UNCHANGED at 5 minutes, and idents still count toward it.
//    "Classify short idents as not-real-talk" is the tempting fix and the wrong
//    one: it lets banter stack right behind an ident, which is what the gap is for.
//  - One fire per slot. A per-minute tick with no slot key is a stream of
//    exchanges, not a window — so the key must be stable across the window and
//    distinct across hours.
//  - The cron expression is DERIVED. A hand-written '20-29,50-59' drifts the
//    moment BANTER_WINDOW_MINUTES changes, and the drift is silent.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// settings.load()/update() touch nothing real — hence the dynamic imports. Same
// shape as scripts/clock-policy.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-banter-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS,
  banterSlot, banterSlotKey, banterWindowEnd, banterGap, banterCronExpression,
  banterStandDownLine, banterMissedLine,
  banterTickPlan,
} = await import('../src/broadcast/banter-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');

// The default roster's first persona, re-fadered to the frequency under test —
// the only settings the 'banter' rung reads. Patching the seeded persona (rather
// than writing one from scratch) keeps the strict TTS/soul validators happy;
// same trick as scripts/clock-policy.test.ts.
async function station(frequency: string) {
  await settings.update({
    tts: { enabled: true },
    personas: settings.get().personas.map((p: any, i: number) =>
      (i === 0 ? { ...p, frequency, djMode: false } : p)),
  } as any);
}

const at = (minute: number) => new Date(2026, 7, 19, 9, minute, 0);

test('every minute of a window resolves to the slot that opened it', () => {
  for (const slot of BANTER_SLOTS) {
    for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
      assert.equal(banterSlot(slot + i), slot, `:${slot + i} should belong to slot :${slot}`);
    }
    assert.equal(banterWindowEnd(slot), slot + BANTER_WINDOW_MINUTES - 1);
  }
  // The reporter's own case: an ident deferred to :19:35 pushes the exchange to
  // :24:35, which has to still be the :20 slot or there is no retry at all.
  assert.equal(banterSlot(24), 20);
});

test('minutes outside both windows are not a slot', () => {
  for (const m of [0, 15, 19, 30, 45, 49]) {
    assert.equal(banterSlot(m), null, `:${m} must not open a banter window`);
  }
  // The ident slots specifically — a window must never REACH one, or the
  // exchange and the ident are scheduled against each other (issue #310).
  assert.ok(banterSlot(30) === null && banterSlot(45) === null);
  assert.ok(banterWindowEnd(20) < 30);
});

test('the quiet gap is 5 minutes and is measured, not rounded', () => {
  assert.equal(BANTER_MIN_GAP_MS, 5 * 60_000);
  const now = 1_000_000_000_000;
  // The failure from the issue: an ident that aired 25s ago.
  const blocked = banterGap({ nowMs: now, lastTalkBreakAt: now - 25_000 });
  assert.equal(blocked.clear, false);
  assert.equal(blocked.sinceMs, 25_000);
  // Same ident, five minutes later inside the same window — the whole point.
  assert.equal(banterGap({ nowMs: now + 300_000, lastTalkBreakAt: now - 25_000 }).clear, true);
  // Exactly on the boundary counts as clear.
  assert.equal(banterGap({ nowMs: now, lastTalkBreakAt: now - BANTER_MIN_GAP_MS }).clear, true);
  // Nothing has aired yet (fresh boot) reads as an infinite gap, not a zero one.
  const fresh = banterGap({ nowMs: now, lastTalkBreakAt: 0 });
  assert.equal(fresh.clear, true);
  assert.equal(fresh.sinceMs, Infinity);
});

test('a slot key is stable across its window and distinct across hours/slots', () => {
  const opening = banterSlotKey(at(20));
  assert.ok(opening);
  // Stable: every retry minute claims the same slot, so one exchange airs.
  for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
    assert.equal(banterSlotKey(at(20 + i)), opening);
  }
  // Distinct: the :50 window and the next hour's :20 are their own chances.
  assert.notEqual(banterSlotKey(at(50)), opening);
  assert.notEqual(banterSlotKey(new Date(2026, 7, 19, 10, 20, 0)), opening);
  assert.notEqual(banterSlotKey(new Date(2026, 7, 20, 9, 20, 0)), opening);
  assert.equal(banterSlotKey(at(15)), null);
});

test('the cron expression is derived from the window constants', () => {
  const expected = BANTER_SLOTS
    .map(s => `${s}-${s + BANTER_WINDOW_MINUTES - 1}`)
    .join(',') + ' * * * *';
  assert.equal(banterCronExpression(), expected);
  // It must cover every minute banterSlot() accepts, and nothing else — the two
  // are read by different callers (node-cron vs the tick) and cannot disagree.
  const covered = new Set<number>();
  for (const range of banterCronExpression().split(' ')[0].split(',')) {
    const [lo, hi] = range.split('-').map(Number);
    for (let m = lo; m <= hi; m++) covered.add(m);
  }
  for (let m = 0; m < 60; m++) {
    assert.equal(covered.has(m), banterSlot(m) !== null, `minute ${m} coverage mismatch`);
  }
});

test('the frequency ladder is unchanged, and reads the slot rather than the minute', async () => {
  await station('quiet');
  // Quiet never auto-banters — anywhere in either window.
  for (const m of [20, 24, 29, 50, 59]) assert.equal(shouldFire('banter', at(m)), false);

  await station('moderate');
  // One an hour: the :20 slot only — but now with its full retry tail.
  for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
    assert.equal(shouldFire('banter', at(20 + i)), true, `moderate should retry at :${20 + i}`);
  }
  for (const m of [50, 55, 59]) assert.equal(shouldFire('banter', at(m)), false);

  for (const f of ['chatty', 'aggressive']) {
    await station(f);
    for (const m of [20, 25, 29, 50, 55, 59]) {
      assert.equal(shouldFire('banter', at(m)), true, `${f} should fire at :${m}`);
    }
    // Outside the windows nothing fires, whatever the rung — the ident and
    // hourly minutes stay theirs.
    for (const m of [0, 15, 19, 30, 45, 49]) {
      assert.equal(shouldFire('banter', at(m)), false, `${f} must not fire at :${m}`);
    }
  }
});

test('the station voice switch still sits above the whole window', async () => {
  await station('aggressive');
  await settings.update({ tts: { enabled: false } } as any);
  for (const m of [20, 25, 50, 59]) assert.equal(shouldFire('banter', at(m)), false);
  await settings.update({ tts: { enabled: true } } as any);
  assert.equal(shouldFire('banter', at(25)), true);
});

test('the stand-down lines carry the reason and the numbers', () => {
  const now = 1_000_000_000_000;
  const gap = banterGap({ nowMs: now, lastTalkBreakAt: now - 25_000 });
  const line = banterStandDownLine(20, gap);
  // The issue asked for exactly this: which gap, how long ago, how long is left.
  assert.match(line, /25s ago/);
  assert.match(line, /300s/);
  assert.match(line, /:29/);
  const missed = banterMissedLine(20, gap);
  assert.match(missed, /slot :20 missed/);
  // The last minute of a window is the one case where this is the ONLY line the
  // operator gets, so it carries the numbers too.
  assert.match(missed, /25s ago/);
  assert.match(missed, /300s/);
  // A fresh boot has no last break — the line must not print "Infinitys".
  assert.match(banterStandDownLine(20, banterGap({ nowMs: now, lastTalkBreakAt: 0 })), /never ago/);
});

// ---------------------------------------------------------------------------
// THE TICK'S STATE MACHINE (banterTickPlan)
// The half that had no coverage before: the slot claim, log-once, and which line
// the window's last minute writes. Driven the way the scheduler drives it — one
// call per minute, threading the two counters back in — so a mistake in the
// caller's contract shows up here rather than on air.
// ---------------------------------------------------------------------------

// Replays a run of minutes exactly as banterTick does, and reports what aired
// and what was logged. `talkAt` is the wall-clock minute (with seconds) some
// other segment aired at.
function replay(minutes: number[], opts: {
  talkAtMin?: number; talkAtSec?: number; eligible?: boolean;
} = {}) {
  const lastTalkBreakAt = opts.talkAtMin == null
    ? 0
    : new Date(2026, 7, 19, 9, opts.talkAtMin, opts.talkAtSec ?? 0).getTime();
  let firedSlot: string | null = null;
  let loggedSlot: string | null = null;
  const fired: number[] = [];
  const logs: string[] = [];
  for (const m of minutes) {
    const plan = banterTickPlan({
      now: at(m),
      eligible: opts.eligible ?? true,
      lastTalkBreakAt,
      firedSlot,
      loggedSlot,
    });
    if (plan.act === 'skip') continue;
    if (plan.act === 'wait') {
      if (plan.markLogged) loggedSlot = plan.markLogged;
      if (plan.log) logs.push(plan.log);
      continue;
    }
    firedSlot = plan.slotKey;
    fired.push(m);
  }
  return { fired, logs };
}

const WINDOW_20 = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

test("the reporter's hour: a :19:35 ident postpones the exchange, it no longer cancels it", () => {
  // 09:15 ident cron → boundary-deferred → actually airs 09:19:35. The old code
  // saw 25s at the :20 tick and gave up until :50 (or, on moderate, until 10:20).
  const { fired, logs } = replay(WINDOW_20, { talkAtMin: 19, talkAtSec: 35 });
  // The gap clears at :24:35, so :24 is still short (24:00 − 19:35 = 265s) and
  // :25 is the first minute that may air. This is the whole fix.
  assert.deepEqual(fired, [25]);
  // One stand-down line for the slot, not one per blocked minute.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stood down at :20 — last standalone talk 25s ago/);
});

test('a slot fires at most once, however many minutes are left in the window', () => {
  // Nothing has aired at all: the gap is open from the first minute.
  const { fired, logs } = replay(WINDOW_20);
  assert.deepEqual(fired, [20], 'the slot opens, airs once, and stays quiet');
  assert.deepEqual(logs, []);
  // And the :50 window is its own chance, unaffected by the :20 one.
  assert.deepEqual(replay([...WINDOW_20, 50, 51, 52]).fired, [20, 50]);
});

test('a window that never clears says so once, at the minute it is lost', () => {
  // A talk break at :24 keeps the gap short for every remaining minute (:29 is
  // only 300s later at :29:00 — exactly on the boundary, so it clears there).
  const late = replay(WINDOW_20, { talkAtMin: 24, talkAtSec: 30 });
  assert.deepEqual(late.fired, [], 'the gap never clears inside this window');
  assert.equal(late.logs.length, 2, 'one stand-down at :20, one "missed" at :29');
  assert.match(late.logs[0], /stood down at :20/);
  assert.match(late.logs[1], /slot :20 missed/);
  // The last minute being the FIRST blocked one still reports, with numbers —
  // the case where an operator would otherwise get no line at all.
  const only29 = replay([29], { talkAtMin: 28, talkAtSec: 30 });
  assert.deepEqual(only29.fired, []);
  assert.equal(only29.logs.length, 1);
  assert.match(only29.logs[0], /slot :20 missed — last standalone talk 30s ago/);
});

test('an ineligible show is silent — it never logs about a gap it never reached', () => {
  // Solo show / quiet persona / no listeners / budget spent all collapse to this.
  const out = replay(WINDOW_20, { talkAtMin: 19, talkAtSec: 35, eligible: false });
  assert.deepEqual(out.fired, []);
  assert.deepEqual(out.logs, [], 'a per-minute tick must not narrate ineligible minutes');
});

test('minutes outside a window are skipped without a decision', () => {
  for (const m of [0, 15, 19, 30, 45, 49]) {
    assert.equal(
      banterTickPlan({ now: at(m), eligible: true, lastTalkBreakAt: 0, firedSlot: null, loggedSlot: null }).act,
      'skip',
      `:${m} must not reach the gap check`,
    );
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
