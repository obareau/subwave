// The two tool-loop agent definitions: the track picker and the listener-request
// matcher. Both run the same harness, so they accept native output on the same
// terms.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import * as settings from '../../settings.js';
import { defineAgent } from '../../llm/agent.js';
import { buildPickerTools } from '../../llm/tools.js';
import { pickSchema, pickSystem, requestSchema, requestSystem } from './schemas.js';
import { agentDeadline } from './breaker.js';

export const pickerAgent = defineAgent({
  kind: 'djAgentPick',
  // Resolved per run: the effects coaching in the transition field follows
  // the on-air persona's djMode, and the say length its scriptLength — same
  // reason effectsGuidance() is dynamic. See pickSchema above.
  schema: () => pickSchema(),
  // The done-tool path is meant to end the loop at step 1 (COMMIT_AFTER_STEPS
  // in agent.ts): step 0 discovers, step 1 commits. That held for every
  // provider UNTIL GLM (Zhipu/Z.ai) — it can decline the forced `done` call
  // repeatedly within the SAME conversation rather than complying on the first
  // attempt, so a taller maxSteps stopped being a rarely-hit backstop and
  // became a real (and wasted) retry budget: each extra step just grows an
  // increasingly "I already declined" trail, which made compliance WORSE, not
  // better, in testing. 2 keeps the main run to exactly discovery + one
  // committed attempt and hands off to agent.ts's own two-tier recovery (which
  // includes a clean-context retry) sooner — recovery is the mechanism that
  // actually rescues these, not more steps on a polluted trail.
  maxSteps: 2,
  timeoutMs: agentDeadline,
  buildSystem: ({ showAt, playlistTracks }: any = {}) => pickSystem(showAt ?? null, !!playlistTracks?.length),
  buildTools: ({ recentIds, recentKeys, hardRecentIds, hardRecentKeys, audioWaypoint, genreLock, eraLock, moodLock, energyLock, playlistLock, playlistTracks, excludedIds }) => {
    // For a strict show (filtersStrict) EVERY set music filter — genre, era,
    // mood, energy — becomes a hard lock the discovery tools enforce on
    // candidates, not just the prompt. The locks are ALL pre-resolved in
    // pickViaAgent and threaded through run() (async work — genre free text →
    // library tags, library-coverage gating — that this sync builder can't do),
    // alongside playlistLock / playlistTracks / excludedIds. Resolving them in
    // one place off one show snapshot also keeps the prompt's brief and the
    // tools' locks agreeing across a show boundary. Track length is an on-air
    // cut, NOT a pick filter (#447), so no length cap is passed here.
    const { tools, seen } = buildPickerTools({ recentIds, recentKeys, hardRecentIds, hardRecentKeys, audioWaypoint, genreLock, eraLock, moodLock, energyLock, playlistLock, playlistTracks, excludedIds });
    return { tools, extras: { seen } };
  },
  // Native-path acceptance: the picked id must be one a discovery tool actually
  // surfaced this run. A fabricated id falls the run through to the done-tool
  // harness instead of surfacing as an unknown-id rejection (observed:
  // gpt-5-mini invented 7/32 ids after an empty tool result).
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});

export const requestAgent = defineAgent({
  kind: 'djAgentRequest',
  // Function form — resolved per run so the intro length follows the on-air
  // persona's scriptLength (see requestSchema).
  schema: () => requestSchema(),
  // See pickerAgent.maxSteps above — same reasoning.
  maxSteps: 2,
  timeoutMs: agentDeadline,
  buildSystem: () => requestSystem(),
  // resolveReferences adds the web-backed reference resolver (request path only;
  // no-op without a search provider) when the operator opts in via
  // settings.llm.requestWebResolve. (Artists are no longer filtered on any pick
  // path — see the buildPickerTools note — so a request for a recently-played
  // artist resolves naturally.)
  buildTools: ({ recentIds }) => {
    const { tools, seen } = buildPickerTools({
      recentIds,
      resolveReferences: settings.get().llm?.requestWebResolve ?? false,
    });
    return { tools, extras: { seen } };
  },
  // Same native-path acceptance as pickerAgent — the request agent runs the
  // same model through the same harness, so it fabricates the same way.
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});


