// The seed-vs-pick rule, and the classification of an agent pick that came back
// with an id no tool surfaced (#1247).
//
// Every pick event message hands the agent the ON-AIR track's id so it can pass
// it to the seed-based discovery tools ("pass the currently-playing song id"):
// broadcast/dj-agent.ts's `[id: …]`, and the same tag on the request path. That
// id is therefore the one real, well-formed track id sitting in the model's
// context that no tool ever returned — the discovery tools all exclude the seed
// from their own results (library-db/vectors.ts knnByBuffer drops `excludeId`).
// So when a model is cornered into committing with nothing to commit, echoing
// the seed is the single most available wrong answer, and nothing in the
// contract forbade it: "never invent or compose ids" is literally satisfied by
// an id that is real and was handed over in the prompt.
//
// Policy chokepoint, like util/request-guard.ts: the clause below is the ONE
// wording, shared by the pick/request schema field descriptions
// (broadcast/dj-agent/schemas.ts) and the empty-tool-result rule the model sees
// at the exact moment it fails (llm/internal/tools/picker/scope.ts). Never
// inline a second copy — they drift, and the wording is the whole fix.
//
// Pure + unit-pinned (scripts/pick-seed.test.ts).

// Deliberately phrased as "what it IS" before "what not to do": the observed
// failure isn't defiance, it's a model that was never told the seed had a role
// other than "a track id I have". Reads correctly appended to either an id-field
// description or a tool-result rule.
export const SEED_NOT_A_PICK_CLAUSE =
  'The track already playing is only the SEED you pass to the discovery tools — its id is never a valid answer, even when a tool comes back empty.';

export type PickFailureKind = 'no-candidates' | 'no-discovery' | 'seed-echo' | 'unknown-id';

export interface PickFailure {
  kind: PickFailureKind;
  // Operator-facing, for the booth log. Says WHY the slot went to the pool —
  // the complaint in #1247 was that a rejected agent pick and a healthy one look
  // identical to an operator, so a station silently reverts to the pool picker's
  // "most played albums" with nothing to explain the change of character.
  // No trailing "falling back to pool": the call site adds that, so every branch
  // reads the same way in the log whoever phrased the cause.
  message: string;
  // Whether this failure is evidence the configured model can't drive the
  // tool-loop harness — the only thing the circuit breaker exists to catch
  // (broadcast/dj-agent/breaker.ts). A run that surfaced ZERO candidates is a
  // library-coverage problem, not a model one: opening the breaker there
  // disables the session-aware picker for 10 minutes over an empty index and
  // points the operator at "switch model", which is the wrong repair. Mirrors
  // the existing already-queued carve-out in runTrackEvent.
  countsAgainstBreaker: boolean;
}

export function classifyPickFailure(
  { pickedId, seedId, candidates, toolCalls }:
  { pickedId: string | null; seedId: string | null; candidates: number; toolCalls: number },
): PickFailure {
  const echoed = !!pickedId && !!seedId && pickedId === seedId;

  // An empty `seen` has TWO causes, and only one is exempt. `toolCalls` counts
  // real discovery calls (flattenToolCalls excludes the synthetic `done`), so
  // zero means the model never explored at all — possible on the
  // toolChoice:'auto' downgrade (#570) or a provider that ignores 'required',
  // where a salvage leg then fabricates an id against an empty trail. That IS
  // the can't-drive-the-harness failure the breaker exists for; exempting it on
  // candidates===0 alone would let a tool-call-incapable model dodge the
  // breaker forever while every pick burns the full agent deadline.
  if (candidates === 0 && toolCalls === 0) {
    return {
      kind: 'no-discovery',
      message: 'agent made no discovery call at all, so its answer could not come from any tool — the configured model may not drive tool calls',
      countsAgainstBreaker: true,
    };
  }

  // Zero candidates with real discovery, and regardless of what the model
  // answered: with an empty `seen` map BOTH salvage stages are structurally
  // unable to help (nearestId has no keys to match against, repickFromSeen
  // returns null on its first line), so the run was lost the moment discovery
  // came back empty — the answer the model gave is a symptom, not the cause.
  // This is the #1247 path: the discovery budget (a single call on forced-tool
  // providers — runDiscoverySteps in provider/capabilities.ts) spent on tools
  // whose indexes don't cover the seed, then a forced commit with nothing.
  if (candidates === 0) {
    return {
      kind: 'no-candidates',
      message: echoed
        ? 'agent had no candidates — every discovery call came back empty, so it answered with the on-air track\'s own id. Not a model fault: the seed is likely missing from the index the tool it reached for is built on (check sounds-like / mood coverage on /admin/library)'
        : 'agent had no candidates — every discovery call came back empty, so its answer could not match a real track. Not a model fault: check library coverage on /admin/library',
      countsAgainstBreaker: false,
    };
  }

  // Candidates existed and the model still handed back the seed — and the
  // constrained re-pick over those candidates (repickFromSeen, a z.enum grammar
  // that can only answer with a real one) failed too. That IS a harness problem.
  if (echoed) {
    return {
      kind: 'seed-echo',
      message: `agent answered with the on-air track's own id despite ${candidates} candidate(s) from its own tools, and the corrective re-pick missed`,
      countsAgainstBreaker: true,
    };
  }

  return {
    kind: 'unknown-id',
    message: `agent returned unknown id ${pickedId ?? 'none'} (${candidates} candidate(s) surfaced, near-miss repair and corrective re-pick both missed)`,
    countsAgainstBreaker: true,
  };
}
