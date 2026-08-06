// The two tool-loop agent definitions: the track picker and the listener-request
// matcher. Both run the same harness, so they accept native output on the same
// terms.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import * as settings from '../../settings.js';
import { defineAgent } from '../../llm/agent.js';
import { buildPickerTools, type PickerScope } from '../../llm/tools.js';
import { pickSchema, pickSystem, requestSchema, requestSystem } from './schemas.js';
import { agentDeadline } from './breaker.js';

// What pickViaAgent hands the picker each run. `scope` is the whole constraint
// set as ONE value — recency, the strict show locks, the playlist anchor, the
// journey waypoint — resolved in pickViaAgent (async work: genre free text →
// library tags, coverage gating) and passed straight through to the discovery
// tools untouched.
//
// It travels whole for a reason. The previous shape listed every constraint as
// its own key here, again in the buildTools destructure, and again in the
// buildPickerTools call: a lock named in one list and forgotten in another was
// not a type error, it just fell through to a `null` default and stopped being
// enforced on the agent path while the pool picker still honoured it — the two
// pick paths silently disagreeing about the same show. Do not unpack the scope
// into keys here; see the note at the top of llm/internal/tools/picker/scope.ts.
export interface PickerRunArgs {
  scope: PickerScope;
  // Forecast air time for the pick's link, used by the prompt only — not a
  // discovery constraint, so it stays outside the scope.
  showAt?: Date | null;
}

export interface RequestRunArgs {
  scope: PickerScope;
}

// What buildTools hands back for the caller to resolve the chosen id against.
export interface PickerExtras {
  seen: Map<string, any>;
}

export const pickerAgent = defineAgent<PickerRunArgs, PickerExtras>({
  kind: 'djAgentPick',
  // Resolved per run: the effects coaching in the transition field follows
  // the on-air persona's djMode, and the say length its scriptLength — same
  // reason effectsGuidance() is dynamic. See pickSchema above.
  schema: () => pickSchema(),
  // Advisory floor only. On the done-tool path the cap is DERIVED per provider
  // (gatedMaxStepsFor = discovery budget + 1 in provider/capabilities.ts), so
  // this value reaches the model only as the `Math.max` floor on the native leg.
  //
  // The reason the derivation exists rather than a number here: GLM (Zhipu/Z.ai)
  // can decline the forced `done` call repeatedly within the SAME conversation
  // rather than complying on the first attempt, so a taller cap stopped being a
  // rarely-hit backstop and became a real (and wasted) retry budget — each extra
  // step just grows an increasingly "I already declined" trail, which made
  // compliance WORSE, not better, in testing. Deriving the cap keeps the main run
  // at exactly discovery + ONE committed attempt at every budget, and hands off
  // to agent.ts's recovery cascade sooner — recovery is the mechanism that
  // actually rescues these, not more steps on a polluted trail.
  maxSteps: 2,
  // The pick/request pair is what the per-provider discovery budget was
  // designed and tested for, so they opt in here. djAgent callers that DON'T
  // opt in (the segment director) keep the historical single discovery step —
  // a pinned step cap can be load-bearing (see directorAgent.maxSteps in
  // skills/_agent.ts), so the widening never applies implicitly.
  providerDiscoveryBudget: true,
  timeoutMs: agentDeadline,
  buildSystem: ({ showAt, scope }) => pickSystem(showAt ?? null, !!scope?.playlistTracks?.length),
  // For a strict show (filtersStrict) EVERY set music filter — genre, era, mood,
  // energy, vocals — becomes a hard lock the discovery tools enforce on
  // candidates, not just the prompt. Resolving them in one place off one show
  // snapshot keeps the prompt's brief and the tools' locks agreeing across a
  // show boundary. Track length is an on-air cut, NOT a pick filter (#447), so
  // no length cap is in the scope.
  buildTools: ({ scope }) => {
    const { tools, seen } = buildPickerTools(scope);
    return { tools, extras: { seen } };
  },
  // Native-path acceptance: the picked id must be one a discovery tool actually
  // surfaced this run. A fabricated id falls the run through to the done-tool
  // harness instead of surfacing as an unknown-id rejection (observed:
  // gpt-5-mini invented 7/32 ids after an empty tool result).
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});

export const requestAgent = defineAgent<RequestRunArgs, PickerExtras>({
  kind: 'djAgentRequest',
  // Function form — resolved per run so the intro length follows the on-air
  // persona's scriptLength (see requestSchema).
  schema: () => requestSchema(),
  // See pickerAgent.maxSteps above — same reasoning.
  maxSteps: 2,
  // See pickerAgent.providerDiscoveryBudget above.
  providerDiscoveryBudget: true,
  timeoutMs: agentDeadline,
  buildSystem: () => requestSystem(),
  // resolveReferences adds the web-backed reference resolver (request path only;
  // no-op without a search provider) when the operator opts in via
  // settings.llm.requestWebResolve. Applied here rather than at the call site
  // because it is a property of THIS agent, not of the request being served.
  // (Artists are no longer filtered on any pick path — see the buildPickerTools
  // note — so a request for a recently-played artist resolves naturally.)
  buildTools: ({ scope }) => {
    const { tools, seen } = buildPickerTools({
      ...scope,
      resolveReferences: settings.get().llm?.requestWebResolve ?? false,
    });
    return { tools, extras: { seen } };
  },
  // Same native-path acceptance as pickerAgent — the request agent runs the
  // same model through the same harness, so it fabricates the same way.
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});


