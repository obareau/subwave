// Pins time.ts's timezone-change subscription — the hook the per-skill cron
// tasks use to re-register themselves.
//
// node-cron bakes the zone into cron.schedule(..., { timezone }) at
// registration, so a live timezone change leaves every registered task firing
// on the OLD zone. The first fix checked `'timezone' in req.body` inside POST
// /settings, which covers the admin panel and misses the other writers:
// routes/onboarding.ts patches `timezone` through settings.update() too, and a
// backup restore reaches update() directly. Putting the notification at the
// one place the zone actually changes is what stops this having to be
// remembered at each new writer.
//
// The no-change guard is the other half. settings.load() and every successful
// update() push the zone in whether or not it moved, so firing unconditionally
// would tear down and rebuild every station's crons on each unrelated settings
// save.
//
// Run: `tsx scripts/station-timezone-listener.test.ts`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { setStationTimezone, getStationTimezone, onStationTimezoneChange } from '../src/time.js';

const seen: string[] = [];
onStationTimezoneChange((tz) => seen.push(tz));

test('a real change notifies subscribers with the effective zone', () => {
  seen.length = 0;
  setStationTimezone('Europe/London');
  assert.deepEqual(seen, ['Europe/London']);
  assert.equal(getStationTimezone(), 'Europe/London');

  setStationTimezone('Asia/Kolkata');
  assert.deepEqual(seen, ['Europe/London', 'Asia/Kolkata']);
});

test('re-setting the same zone notifies nobody', () => {
  setStationTimezone('Asia/Kolkata');
  seen.length = 0;
  setStationTimezone('Asia/Kolkata');
  assert.deepEqual(seen, []);
});

test('an invalid zone resolves to Auto and notifies once, not per bad value', () => {
  setStationTimezone('Asia/Kolkata');
  seen.length = 0;
  setStationTimezone('Not/AZone');
  assert.equal(seen.length, 1, 'falling back to Auto is a real change');
  // Auto = whatever the process resolved to, never the literal bad string.
  assert.notEqual(seen[0], 'Not/AZone');
  assert.equal(seen[0], getStationTimezone());

  setStationTimezone('Also/Bogus');
  assert.equal(seen.length, 1, 'still Auto — not a change, so no second notify');
});

test('a throwing subscriber does not block the others or the write', () => {
  // One bad subscriber must not leave the zone half-applied.
  const after: string[] = [];
  onStationTimezoneChange(() => { throw new Error('boom'); });
  onStationTimezoneChange((tz) => after.push(tz));

  setStationTimezone('America/New_York');
  assert.equal(getStationTimezone(), 'America/New_York');
  assert.deepEqual(after, ['America/New_York']);
});
