// Pins the daily LLM token tally (llm/internal/telemetry/budget.ts) against the
// call recorder that feeds it (telemetry/log.ts record()).
//
// Issue #1195: a call that THROWS is still billed by the provider, and djAgent's
// cascade can burn several legs before it gives up. The tally therefore counts
// failed calls that reported usage; the lifetime ticker beside it deliberately
// does not (it's the listener-facing counter on the player, mirroring
// summarizeLlm in stats.ts). Two properties are load-bearing:
//
//  - The two counters diverge on purpose. A regression that re-unifies them
//    either re-breaks the cap or makes the public ticker jump on failures.
//  - The live guard in log.ts and the seed filter in budget.ts are SECOND
//    copies of one policy, and disagreement is silent: screening `ok` in the
//    seed while counting failures live makes a mid-day restart re-seed from
//    successes only and walk the tally BACKWARDS, dropping an operator out of
//    `hard` on a container bounce. The round-trip below is the real pin —
//    record a mixed batch, then re-seed from the events file those very calls
//    wrote and assert the two numbers agree.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so the
// events log lands nowhere real — hence the dynamic imports. node:assert-via-tsx
// style, matching scripts/voice-policy.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-budget-'));
process.env.STATE_DIR = root;

const { record, lifetimeTokenCount } = await import('../src/llm/internal/telemetry/log.js');
const { dailyTokensUsed, seedDailyUsageFromLog } = await import('../src/llm/internal/telemetry/budget.js');

const utcDay = () => new Date().toISOString().slice(0, 10);
const eventsFile = () => join(root, 'logs', `events-${utcDay()}.jsonl`);

// logEvent's append is fire-and-forget (best-effort by design — a log write must
// never break a broadcast), so wait for the lines to actually land rather than
// racing them. Fails loudly on timeout instead of silently asserting on 0.
async function waitForLlmEvents(want: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = existsSync(eventsFile())
      ? readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean)
        .filter((l) => { try { return JSON.parse(l)?.type === 'llm'; } catch { return false; } }).length
      : 0;
    if (seen >= want) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${want} llm events on the timeline (saw ${seen})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A minimal record-shaped call. record() only reads ok/usage for the counters;
// everything else rides through to the ring buffer and the event line.
const call = (ok: boolean, total: number | undefined) => ({
  kind: 'pick',
  ok,
  ms: 12,
  model: 'test-model',
  via: 'ai-sdk',
  ...(total === undefined ? {} : { usage: { input: 1, output: total - 1, total } }),
  ...(ok ? {} : { error: 'agent did not call the done tool before stopping' }),
});

try {
  // ── Baseline ───────────────────────────────────────────────────────────────
  assert.equal(dailyTokensUsed(), 0, 'fresh process starts the day at zero');
  assert.equal(lifetimeTokenCount(), 0, 'fresh process starts the lifetime ticker at zero');

  // ── A successful call feeds both counters ──────────────────────────────────
  record(call(true, 100));
  assert.equal(dailyTokensUsed(), 100, 'a success counts toward the daily tally');
  assert.equal(lifetimeTokenCount(), 100, 'a success counts toward the lifetime ticker');

  // ── A FAILED call feeds the tally only (#1195) ─────────────────────────────
  // The spend is real — agent.ts sums every leg onto err.usage and
  // failureDiagnostics normalises it onto the record — so the cap must see it.
  record(call(false, 250));
  assert.equal(dailyTokensUsed(), 350, 'a failed call with usage counts toward the daily tally');
  assert.equal(lifetimeTokenCount(), 100, 'a failed call must NOT move the listener-facing ticker');

  // ── A failure with no usage adds nothing ───────────────────────────────────
  // Provider HTTP errors and deadline aborts throw bare. Nothing to count, and
  // nothing may be invented — this is why the cap is more honest, not exhaustive.
  record(call(false, undefined));
  assert.equal(dailyTokensUsed(), 350, 'a usage-less failure adds nothing to the tally');
  assert.equal(lifetimeTokenCount(), 100, 'a usage-less failure adds nothing to the ticker');

  // A zero-token report (local rigs often send one) is not a contribution either.
  record(call(false, 0));
  record(call(true, 0));
  assert.equal(dailyTokensUsed(), 350, 'zero-token reports add nothing, ok or not');

  // ── The restart round-trip: seed filter vs live guard ──────────────────────
  // Re-seed from the events file the calls above actually wrote. If the two
  // copies of the policy ever drift, this is where it shows up as a number
  // moving BACKWARDS across a restart.
  const live = dailyTokensUsed();
  await waitForLlmEvents(5);
  const seeded = await seedDailyUsageFromLog();
  assert.equal(seeded, live, 'a mid-day restart re-seeds to the same number it was live at');
  assert.equal(dailyTokensUsed(), live, 'and the tally reads unchanged after the re-seed');
  assert.ok(seeded >= 250, 'the re-seed carries the failed call, not just the successes');

  console.log('llm-budget: OK (failed calls count toward the daily cap; ticker unmoved; seed round-trips)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
