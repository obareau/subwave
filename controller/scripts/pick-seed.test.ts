// Unit tests for the seed-vs-pick policy (#1247) — the rule that the on-air
// track's id is a discovery SEED and never a valid answer, and the
// classification of an agent pick that came back with an id no tool surfaced.
// Run: `tsx scripts/pick-seed.test.ts` (folded into `npm test`).
//
// Pinned here because both halves are one-line-deletable regressions with no
// other alarm:
//   - the clause is what the reporter's prompt-level workaround proved fixes the
//     echo; if it stops reaching the schema field / tool rule, picks start
//     falling to the pool again with nothing in the log to say why.
//   - the breaker carve-out is the difference between "this library's index
//     doesn't cover that seed" and "this model can't drive tool calls". Get it
//     wrong and three empty-index tracks disable the session-aware picker for ten
//     minutes and advise the operator to switch model.
// node:assert-via-tsx style, matching scripts/lastfm-enrich.test.ts.

import assert from 'node:assert/strict';
import { SEED_NOT_A_PICK_CLAUSE, classifyPickFailure } from '../src/util/pick-seed.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const SEED = 'qGlvGNc5jXlYcqkOR0DCMs';   // the id from the issue's first rejection
const OTHER = 'zHPZijh0QjNFWqAz1QuSZF';

async function main() {
  console.log('SEED_NOT_A_PICK_CLAUSE (the shared wording):');

  await test('names the seed role AND forbids it as an answer', () => {
    // Both halves matter. "Never pick the on-air track" alone reads as an
    // arbitrary rule; saying WHY (it is the seed you pass the tools) is what the
    // reporter's working prompt line did.
    assert.match(SEED_NOT_A_PICK_CLAUSE, /seed/i);
    assert.match(SEED_NOT_A_PICK_CLAUSE, /never a valid answer/i);
  });

  await test('covers the empty-tool case explicitly', () => {
    // The failure only happens when a tool came back empty — a clause that
    // stops short of that leaves the exact moment of failure uncovered.
    assert.match(SEED_NOT_A_PICK_CLAUSE, /empty/i);
  });

  console.log('classifyPickFailure (why the run was discarded, and whose fault):');

  await test('zero candidates is NOT a breaker failure, even though the id was wrong', () => {
    // The #1247 path: one discovery call into an index that does not cover the
    // seed, then a forced commit with nothing to commit.
    const f = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 0, toolCalls: 1 });
    assert.equal(f.kind, 'no-candidates');
    assert.equal(f.countsAgainstBreaker, false);
    assert.match(f.message, /no candidates/i);
  });

  await test('zero candidates stays a coverage miss whatever the model answered', () => {
    // With an empty `seen` BOTH salvage stages are structurally unable to help,
    // so the answer is a symptom either way — a fabricated id is the same story
    // as an echoed seed.
    const f = classifyPickFailure({ pickedId: 'made-up-id', seedId: SEED, candidates: 0, toolCalls: 1 });
    assert.equal(f.kind, 'no-candidates');
    assert.equal(f.countsAgainstBreaker, false);
  });

  await test('zero candidates with ZERO discovery calls DOES count against the breaker', () => {
    // The other way `seen` ends up empty: the model never explored at all
    // (toolChoice:'auto' downgrade, or a provider ignoring 'required') and a
    // salvage leg fabricated an id against an empty trail. That is precisely
    // the can't-drive-tool-calls failure the breaker watches for — exempting it
    // would let such a model dodge the breaker forever while every pick burns
    // the full agent deadline.
    const f = classifyPickFailure({ pickedId: 'made-up-id', seedId: SEED, candidates: 0, toolCalls: 0 });
    assert.equal(f.kind, 'no-discovery');
    assert.equal(f.countsAgainstBreaker, true);
    assert.match(f.message, /no discovery call/i);
    const echoed = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 0, toolCalls: 0 });
    assert.equal(echoed.kind, 'no-discovery');
    assert.equal(echoed.countsAgainstBreaker, true);
  });

  await test('zero candidates names the seed echo when that is what happened', () => {
    // Same verdict, different diagnosis in the booth log — an operator reading
    // "answered with the on-air track's own id" knows to check index coverage.
    const echoed = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 0, toolCalls: 1 });
    const other = classifyPickFailure({ pickedId: 'made-up-id', seedId: SEED, candidates: 0, toolCalls: 1 });
    assert.match(echoed.message, /on-air track's own id/i);
    assert.notEqual(echoed.message, other.message);
  });

  await test('seed echo WITH candidates IS a breaker failure', () => {
    // The run had real candidates and the z.enum-constrained re-pick over them
    // also missed. That is the harness failing, which is what the breaker is for.
    const f = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 8, toolCalls: 1 });
    assert.equal(f.kind, 'seed-echo');
    assert.equal(f.countsAgainstBreaker, true);
    assert.match(f.message, /8 candidate/);
  });

  await test('an unrelated unknown id with candidates is a plain rejection', () => {
    const f = classifyPickFailure({ pickedId: OTHER, seedId: SEED, candidates: 5, toolCalls: 1 });
    assert.equal(f.kind, 'unknown-id');
    assert.equal(f.countsAgainstBreaker, true);
    assert.match(f.message, new RegExp(OTHER));
  });

  await test('a null pick id with candidates is a plain rejection, not an echo', () => {
    // The model returned no usable id at all — repickFromSeen's other entry
    // point. Must not read as a seed echo just because seedId is present.
    const f = classifyPickFailure({ pickedId: null, seedId: SEED, candidates: 5, toolCalls: 1 });
    assert.equal(f.kind, 'unknown-id');
    assert.equal(f.countsAgainstBreaker, true);
  });

  await test('an unknown seed (boot / untracked track) never reads as an echo', () => {
    // current?.id is null on recover and on an untracked auto-playlist track.
    // Comparing null to null must not classify every failure as a seed echo.
    const f = classifyPickFailure({ pickedId: null, seedId: null, candidates: 3, toolCalls: 1 });
    assert.equal(f.kind, 'unknown-id');
    const g = classifyPickFailure({ pickedId: OTHER, seedId: null, candidates: 3, toolCalls: 1 });
    assert.equal(g.kind, 'unknown-id');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall pick-seed tests passed');
}

main();
