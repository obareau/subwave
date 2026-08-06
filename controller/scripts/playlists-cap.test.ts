// Pins PLAYLISTS_PER_SHOW / EXCLUDED_PLAYLISTS_PER_SHOW — the per-show caps on
// pinned playlist anchors and playlist exclusions — and the web mirror that has
// to agree with them.
//
// Why this needs a test rather than "it's just a number": the cap is enforced in
// three independent layers that each hardcoded it at some point. The validator
// throws above it, the loader (coercePlaylistIds / coerceExcludedPlaylistIds)
// silently truncates at it, and the admin UI disables the checkboxes at its own
// copy. A UI copy ABOVE the controller's turns a legal-looking save into a 400;
// one BELOW hides anchors the operator is allowed to add. Nothing else catches
// that — the symptom is silent, not a crash. This is the playlist twin of
// show-filter-cap.test.ts.
//
// The web mirror is a single PLAYLISTS_MAX because the two controller constants
// are the same figure, so the test also fails if they ever diverge — at which
// point the UI needs two constants, not a re-pointed regex.
//
// Run: npm test -- playlists-cap

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PLAYLISTS_PER_SHOW,
  EXCLUDED_PLAYLISTS_PER_SHOW,
  coercePlaylistIds,
  coerceExcludedPlaylistIds,
} from '../src/settings/vocab.js';
import { validateShowsStrict } from '../src/settings/validate.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const personas = [{ id: 'p1' }];
const themes = new Set<string>();
const ids = (n: number) => Array.from({ length: n }, (_, i) => `pl-${i + 1}`);
const showWith = (extra: Record<string, unknown>) => ([{
  id: 's1', name: 'Test Show', personaId: 'p1', topic: '', ...extra,
}]);

test('validator accepts exactly the cap and rejects one over — playlistIds', () => {
  const ok = validateShowsStrict(showWith({ playlistIds: ids(PLAYLISTS_PER_SHOW) }), personas, themes);
  assert.equal(ok[0].playlistIds.length, PLAYLISTS_PER_SHOW);
  assert.throws(
    () => validateShowsStrict(showWith({ playlistIds: ids(PLAYLISTS_PER_SHOW + 1) }), personas, themes),
    /playlistIds must have at most/,
  );
});

test('validator accepts exactly the cap and rejects one over — excludedPlaylistIds', () => {
  const ok = validateShowsStrict(
    showWith({ excludedPlaylistIds: ids(EXCLUDED_PLAYLISTS_PER_SHOW) }), personas, themes,
  );
  assert.equal(ok[0].excludedPlaylistIds.length, EXCLUDED_PLAYLISTS_PER_SHOW);
  assert.throws(
    () => validateShowsStrict(
      showWith({ excludedPlaylistIds: ids(EXCLUDED_PLAYLISTS_PER_SHOW + 1) }), personas, themes,
    ),
    /excludedPlaylistIds must have at most/,
  );
});

test('the loader truncates at the same cap it validates against', () => {
  // The LOAD path (settings.json written by an older build, or by hand). It
  // truncates silently, so a cap here below the validator's would quietly drop a
  // legally-saved show's anchors on the next boot.
  assert.equal(coercePlaylistIds(ids(PLAYLISTS_PER_SHOW + 5)).length, PLAYLISTS_PER_SHOW);
  assert.equal(
    coerceExcludedPlaylistIds(ids(EXCLUDED_PLAYLISTS_PER_SHOW + 5)).length,
    EXCLUDED_PLAYLISTS_PER_SHOW,
  );
});

test('a stale id still counts against the cap', () => {
  // The admin picker counts ids it cannot resolve against the live Navidrome
  // index toward its own cap. That only matches the controller because nothing
  // here filters unresolvable ids out before counting — resolveShowPlaylistPool
  // drops them at pick time, never at save time.
  const ok = validateShowsStrict(
    showWith({ playlistIds: ids(PLAYLISTS_PER_SHOW - 1).concat('deleted-in-navidrome') }),
    personas, themes,
  );
  assert.equal(ok[0].playlistIds.length, PLAYLISTS_PER_SHOW);
});

test('web admin mirror (PLAYLISTS_MAX) matches both controller caps', () => {
  const src = readFileSync(resolve(here, '../../web/components/admin/shows/types.ts'), 'utf8');
  const m = src.match(/export const PLAYLISTS_MAX = (\d+);/);
  assert.ok(m, 'PLAYLISTS_MAX not found in web/components/admin/shows/types.ts');
  assert.equal(
    PLAYLISTS_PER_SHOW, EXCLUDED_PLAYLISTS_PER_SHOW,
    'the two controller caps diverged — the web mirror can no longer be one constant',
  );
  assert.equal(
    Number(m![1]), PLAYLISTS_PER_SHOW,
    `web mirror is ${m![1]}, controller cap is ${PLAYLISTS_PER_SHOW}`,
  );
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nplaylists-cap: all tests passed');
