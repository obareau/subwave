// Pins PLAYLISTS_PER_SHOW / EXCLUDED_PLAYLISTS_PER_SHOW — the per-show caps on
// pinned playlist anchors and playlist exclusions — and the web mirror that has
// to agree with them.
//
// Why this needs a test rather than "it's just a number": the cap is enforced in
// three independent layers that each hardcoded it at some point. The validator
// throws above it, the loader (normalizeShows, via schemas/show.ts
// repairShowForLoad) silently truncates at it, and the admin UI disables the
// checkboxes at its own copy. A UI copy ABOVE the controller's turns a
// legal-looking save into a 400; one BELOW hides anchors the operator is
// allowed to add. Nothing else catches that — the symptom is silent, not a
// crash. This is the playlist twin of show-filter-cap.test.ts.
//
// The web mirror is a single PLAYLISTS_MAX because the two controller constants
// are the same figure, so the test also fails if they ever diverge — at which
// point the UI needs two constants, not a re-pointed regex.
//
// NOTE on the regexes below: the field name now arrives as a dotted PREFIX
// ('shows.0.genres: must have at most 15 entries') rather than inline in the
// message, because the shared schema's errors go through firstMessage(). The
// patterns pin the FIELD and the RULE without pinning the separator between
// them — wording was never the contract here, accept-vs-reject is.
// Run: npm test -- playlists-cap

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PLAYLISTS_PER_SHOW,
  EXCLUDED_PLAYLISTS_PER_SHOW,
} from '../src/settings/vocab.js';
import { validateShowsStrict } from '../src/settings/validate.js';
import { normalizeShows } from '../src/settings/normalize.js';

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
    /playlistIds.*must have at most/,
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
    /excludedPlaylistIds.*must have at most/,
  );
});

test('the loader truncates at the same cap it validates against', () => {
  // The LOAD path (settings.json written by an older build, or by hand). It
  // truncates silently, so a cap here below the validator's would quietly drop a
  // legally-saved show's anchors on the next boot — and an over-cap list must
  // cost the extra anchors, never the show.
  const [s] = normalizeShows(
    showWith({
      playlistIds: ids(PLAYLISTS_PER_SHOW + 5),
      excludedPlaylistIds: ids(EXCLUDED_PLAYLISTS_PER_SHOW + 5),
    }),
    ['p1'],
  );
  assert.ok(s, 'over-cap playlist lists must not drop the show on load');
  assert.equal(s.playlistIds.length, PLAYLISTS_PER_SHOW);
  assert.equal(s.excludedPlaylistIds.length, EXCLUDED_PLAYLISTS_PER_SHOW);
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

test('the admin UI derives both caps from the schema mirror, not a copy', () => {
  // Previously this scraped one hardcoded PLAYLISTS_MAX and compared it to both
  // controller caps, with a note that the UI would need two constants if they
  // ever diverged. Both now come from the shared schema — and they are two
  // separate constants on the UI side as well, so a future divergence is a
  // no-op here instead of a silent mis-cap on the exclusions picker.
  const src = readFileSync(resolve(here, '../../web/components/admin/shows/types.ts'), 'utf8');
  for (const [local, schemaName] of [
    ['PLAYLISTS_MAX', 'PLAYLISTS_PER_SHOW'],
    ['EXCLUDED_PLAYLISTS_MAX', 'EXCLUDED_PLAYLISTS_PER_SHOW'],
  ]) {
    const m = src.match(new RegExp(`export const ${local} = (.+);`));
    assert.ok(m, `${local} not found in web/components/admin/shows/types.ts`);
    assert.equal(
      m![1], schemaName,
      `${local} is "${m![1]}" — it must be the schema mirror's ${schemaName}, not a copy`,
    );
  }
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nplaylists-cap: all tests passed');
