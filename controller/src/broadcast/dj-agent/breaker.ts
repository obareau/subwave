// Agent circuit breaker. A model that can't drive the done-tool harness fails
// EVERY agent run, so after a few consecutive failures the picker drops to the
// stateless pool for a cooldown instead of burning a call per track.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import * as settings from '../../settings.js';
import { logEvent } from '../../observability/events.js';

// --- Agent circuit breaker ---------------------------------------------------
// A model that can't drive the done-tool harness — ignores toolChoice and
// burns its whole output budget thinking instead of emitting the tool call
// (minimax-m2.7:cloud is the canonical case) — fails EVERY agent run, and
// each failure costs the full agent deadline before the stateless fallback
// takes over. Rather than paying that stall on every track, consecutive agent
// failures open the breaker: picks and request matching go straight to their
// stateless fallbacks for a cooldown, then the agent gets another try. Any
// agent success closes it. Module-level — one station, one model config at a
// time; the trip is logged to the DJ log + events so the operator can see
// WHY the session-aware picker went quiet and switch model.
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
let breakerFails = 0;
let breakerOpenUntil = 0;

// How long a rolled-but-unaired mic-pass stays worth airing. Mirrors
// queue.ts's PENDING_VOICE_MAX_AGE_MS for a deferred ident, for the same
// reason: the script bakes in a moment, so a late one misreads on air.
export const HANDOFF_MAX_AGE_MS = 20 * 60_000;

export function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

export function breakerSuccess() {
  breakerFails = 0;
}

export function breakerFailure(queue: any) {
  breakerFails++;
  if (breakerFails < BREAKER_FAILURES) return;
  breakerFails = 0;
  breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  queue.log('picker', `agent picks failed ${BREAKER_FAILURES}× in a row — using the stateless fallbacks for ${Math.round(BREAKER_COOLDOWN_MS / 60_000)} min (the configured model may not handle tool calls; see /admin/debug and consider switching model)`);
  logEvent('pick.breaker', { failures: BREAKER_FAILURES, cooldownMs: BREAKER_COOLDOWN_MS });
}

// Named agents — the picker and request-handler specs in one declarable block
// each. `buildSystem` and `buildTools` resolve persona / per-call filters at
// run time; everything else (schema, step cap, hard timeout, log kind) is
// fixed here so the spec lives in one place. picker-test.mjs reads
// `pickerAgent.maxSteps` / `pickerAgent.timeoutMs` so test runs match prod
// without drifting. The hard timeout is what fails fast into the stateless
// fallback below instead of dragging on a pathological model call — enforced
// by runDeadlined's shared deadline in agent.ts (native run, main run, and
// both recovery attempts all draw down the SAME overall budget, so worst
// case per agent call is this value, not a multiple of it). It comes from
// settings.llm.agentTimeoutMs (default 45s, admin-tunable) — slow
// reasoning-heavy cloud models routinely need 20-40s per pick, and a pick has
// a whole track length of slack; the deadline exists to contain the unbounded
// 60s+ stalls (#352), not to demand snappy answers.
export function agentDeadline(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}


