import assert from 'node:assert/strict';
import { test } from 'node:test';

const displayModulePath = '../../web/components/admin/shows/' + 'candidate-diagnostic.js';
const display = await import(displayModulePath).catch(() => null);

test('strict diagnostics display the effective playlist pool instead of library-wide matches', () => {
  const report = {
    strict: true,
    library: { indexed: 4, matchingFilters: 2, afterExclusions: 1, effective: 0 },
    playlist: { total: 2, matchingFilters: 1, afterExclusions: 0, effective: 0 },
    warnings: [],
  };

  assert.equal(display?.displayedMatchingTracks?.(report), 0);
});

test('soft diagnostics keep the filter-fit count visible', () => {
  const report = {
    strict: false,
    library: { indexed: 4, matchingFilters: 2, afterExclusions: 2, effective: 4 },
    playlist: null,
    warnings: [],
  };

  assert.equal(display?.displayedMatchingTracks?.(report), 2);
});
