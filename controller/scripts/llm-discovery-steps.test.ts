// settings.llm.discoverySteps — the operator override on how many discovery
// rounds the DJ agent gets before `done` is forced.
//
// COLD LOAD, NOT AN IN-PROCESS CHECK. settings.load()'s llm block composes
// explicitly and does NOT spread DEFAULTS, so a field missing from that
// composition still validates, still saves to settings.json, and still works for
// the rest of that process — then silently vanishes on the next restart with
// nothing in the logs. That has shipped twice (tts.cloud.compatParams #1317,
// llm.repeatPenalty #918 → #1327), and an in-process assertion passes on the
// broken code both times. So every case here writes a settings.json, drops the
// cache, and re-reads it the way a controller restart would.
//
// The second half checks the value actually reaches the consumers: the harness
// (discoveryStepsFor / gatedMaxStepsFor) and the prompt (promptDiscoverySteps).
// A setting that persists but never reaches the loop is the same bug wearing a
// different hat.
//
// No credentials, no external host.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-repeat-penalty.test.ts).
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-discovery-steps-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { discoveryStepsFor, gatedMaxStepsFor, DISCOVERY_STEPS_MAX } =
  await import('../src/llm/internal/provider/capabilities.js');
const { promptDiscoverySteps } = await import('../src/llm/internal/provider/legs.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// A forced-tool provider (capability default 1) — the interesting side, since
// raising it there is the main reason the override exists.
const LOCAL_LLM = {
  provider: 'openai-compatible',
  model: 'qwen3-8b',
  baseUrl: 'http://127.0.0.1:8080/v1',
};
// A native-strategy provider (capability default 3).
const CLOUD_LLM = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };

async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: { ...LOCAL_LLM, ...llm } }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('0 means auto: an untouched install still follows the capability table', async () => {
  // The whole point of the sentinel — upgrading to a build that has this
  // setting must not change a single station's behaviour.
  const llm = await coldLoad({});
  assert.equal(llm.discoverySteps, 0, 'default is the auto sentinel');
  assert.equal(discoveryStepsFor(llm), 1, 'forced-tool provider keeps its 1');
  assert.equal(discoveryStepsFor({ ...CLOUD_LLM, discoverySteps: 0 }), 3, 'native provider keeps its 3');
});

test('an override survives a controller restart and reaches the harness', async () => {
  const llm = await coldLoad({ discoverySteps: 3 });
  assert.equal(llm.discoverySteps, 3);
  // Persisting is only half of it — this is the consumer that decides the loop.
  assert.equal(discoveryStepsFor(llm), 3);
});

test('the override wins over the provider default in BOTH directions', async () => {
  // Up, on a forced-tool provider whose descriptor says 1.
  assert.equal(discoveryStepsFor(await coldLoad({ discoverySteps: 4 })), 4);
  // Down, on a native provider whose descriptor says 3.
  const narrowed = await coldLoad({ ...CLOUD_LLM, discoverySteps: 1 });
  assert.equal(discoveryStepsFor(narrowed), 1);
});

test('the derived cap still leaves exactly one forced-done step at any override', async () => {
  // The invariant the whole design rests on: widening discovery must never
  // widen the number of `done` attempts, or a GLM-class model gets more turns
  // to keep declining on an already-polluted trail.
  for (const n of [1, 2, 3, 4, 5]) {
    const llm = await coldLoad({ discoverySteps: n });
    assert.equal(gatedMaxStepsFor(llm) - discoveryStepsFor(llm), 1, `override ${n}`);
  }
});

test('a stored override is clamped, and junk falls back to the default', async () => {
  assert.equal((await coldLoad({ discoverySteps: 99 })).discoverySteps, DISCOVERY_STEPS_MAX);
  // Negative is nonsense; 0 is the documented "auto", so both land on auto.
  assert.equal((await coldLoad({ discoverySteps: -3 })).discoverySteps, 0);
  assert.equal((await coldLoad({ discoverySteps: 0 })).discoverySteps, 0);
  // A fractional value floors rather than being refused.
  assert.equal((await coldLoad({ discoverySteps: 2.7 })).discoverySteps, 2);
  // A string is not a number — the clamp refuses to guess, same as the others.
  assert.equal((await coldLoad({ discoverySteps: '3' })).discoverySteps, 0);
  // Absent (settings.json written before the field existed) → the default.
  assert.equal((await coldLoad({})).discoverySteps, 0);
});

test('a hand-edited settings.json can never corner the model at step 0', async () => {
  // A 0-round budget would force `done` immediately with an empty `seen` map,
  // where the model can only fabricate an id. The sentinel path and the clamp
  // both have to make that unreachable.
  for (const junk of [0, -1, -99, 0.2, null, 'nope', undefined]) {
    const llm = await coldLoad({ discoverySteps: junk as any });
    assert.ok(discoveryStepsFor(llm) >= 1, `discoverySteps=${String(junk)} resolved below 1`);
  }
});

test('the fallback leg carries its own override across a restart', async () => {
  // Per-leg like toolChoice/numCtx: the backup may be a different provider
  // running a different model, so it must resolve independently.
  const llm = await coldLoad({
    discoverySteps: 3,
    fallback: { enabled: true, provider: 'ollama', model: 'qwen3', discoverySteps: 2 },
  });
  assert.equal(llm.fallback.discoverySteps, 2);
  assert.equal(discoveryStepsFor(llm.fallback), 2);
  assert.equal(discoveryStepsFor(llm), 3, 'and the primary is unaffected');
});

test('saving an override then restarting keeps it — the operator story', async () => {
  await coldLoad({});
  await settings.update({ llm: { discoverySteps: 3 } } as any);
  assert.equal(settings.get().llm.discoverySteps, 3, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.discoverySteps, 3, 'and survives the restart');
});

test('the per-provider budget reaches only the agents that opted in', async () => {
  // The widening was designed for the pick/request pair; the segment
  // director's maxSteps: 2 is load-bearing (skills/_agent.ts — a wider loop
  // was measured burning the FULL agentTimeoutMs), so it must not opt in.
  // runDiscoverySteps is the strategy's resolver: without the opt-in it pins
  // the historical single step whatever the provider or operator override says.
  const { runDiscoverySteps } = await import('../src/llm/internal/provider/capabilities.js');
  const llm = await coldLoad({ ...CLOUD_LLM, discoverySteps: 5 });
  assert.equal(runDiscoverySteps(llm, true), 5, 'opted-in agents follow descriptor + override');
  assert.equal(runDiscoverySteps(llm, false), 1, 'everyone else keeps the single historical step');

  const { pickerAgent, requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
  const { directorAgent } = await import('../src/skills/_agent.js');
  assert.equal(pickerAgent.providerDiscoveryBudget, true, 'picker opts in');
  assert.equal(requestAgent.providerDiscoveryBudget, true, 'request matcher opts in');
  assert.equal(directorAgent.providerDiscoveryBudget, false, 'the director must NOT opt in');
});

test('the prompt promises the MINIMUM across the legs that could run', async () => {
  // The system prompt is built before withFailover picks a leg, so promising
  // the primary's budget can tell a model to plan a second look it will never
  // get on the backup — which corners it at the forced commit.
  await coldLoad({ ...CLOUD_LLM, discoverySteps: 3 });
  assert.equal(promptDiscoverySteps(), 3, 'no fallback → the primary\'s own budget');

  await coldLoad({
    ...CLOUD_LLM,
    discoverySteps: 3,
    fallback: { enabled: true, provider: 'ollama', model: 'qwen3' },
  });
  assert.equal(promptDiscoverySteps(), 1, 'a narrower fallback pulls the promise down');

  // A DISABLED fallback must not narrow anything — it can never run.
  await coldLoad({
    ...CLOUD_LLM,
    discoverySteps: 3,
    fallback: { enabled: false, provider: 'ollama', model: 'qwen3' },
  });
  assert.equal(promptDiscoverySteps(), 3);
});
