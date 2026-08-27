import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisModeForTrack } from '../src/music/analyze-capability.js';

test('an already-current track missing only its sounds-like vector uses embedding-only work', () => {
  assert.equal(analysisModeForTrack('audio-only', new Set(['stale', 'vocal', 'stems']), true), 'embedding-only');
});

test('baseline, vocal, and stem scopes retain full acoustic analysis', () => {
  const full = new Set(['stale', 'vocal', 'stems']);
  for (const id of full) assert.equal(analysisModeForTrack(id, full, true), 'full', id);
  assert.equal(analysisModeForTrack('ordinary', full, false), 'full');
});
