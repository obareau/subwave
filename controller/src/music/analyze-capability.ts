// Pure decisions the analysis pass makes about what it is going to skip, and
// what it tells the operator when it does.
//
// Two of them, both side-effect-free so they can be unit-pinned
// (scripts/analyze-capability.test.ts):
//
//   backfillDecision      — should the pass widen its scope to backfill an
//                           optional dimension, and if not, why not?
//   failureCountsAgainstTrack — does a thrown analysis count as evidence about
//                           THIS FILE, or is the whole pass failing?
//
// All three widenings — CLAP "sounds-like" vectors, Demucs vocal ranges and the
// stem cache — face the same three-way capability question, and the third answer
// is the one that was missing. `capable === false` used to mean exactly one
// thing (the image was built without the model) and the message said so: "switch
// to the heavy image". A heavy image whose weights fail to download lands on the
// same false and got the same message, which is advice to do the thing already
// done.
//
// The messages ARE the contract here: this is the only place an operator with a
// broken analyzer finds out what broke.

export type AnalysisDimension = 'audio' | 'vocal' | 'stem';

// Which backend is answering, so the retry advice names something that exists.
// 'sidecar' has an analyzer container to restart; 'local' (a librosa venv, and
// every AIO image) runs the worker as a child of the controller, so restarting
// "the analyzer" is either impossible or a no-op there — the latch lives in the
// controller process and goes when that does.
export type AnalysisBackend = 'sidecar' | 'local' | string | null;

export interface CapabilityInputs {
  dimension: AnalysisDimension;
  // The operator wants this dimension (env force or the admin toggle).
  wanted: boolean;
  // Backend can emit it. false = definitively not; null = unknown (a local
  // backend that hasn't been probed, or a sidecar too old to advertise).
  capable: boolean | null;
  // Why `capable` is false, when the cause is a failed model LOAD rather than a
  // lean build (analyzer.audioEmbeddingError / vocalActivityError). null
  // otherwise — including on a lean image, where nothing is wrong.
  error: string | null;
  // analyzer.backendLabel(). Only affects the retry sentence; omitting it gives
  // the generic wording rather than wrong wording.
  backend?: AnalysisBackend;
}

export interface CapabilityDecision {
  // Widen the pass to already-analysed tracks missing this dimension. False
  // when the backend definitively can't produce it — widening then re-analyses
  // the whole library every pass for a guaranteed no-op, which is the churn
  // behind the "+90 already-analysed tracks" report.
  widen: boolean;
  // One line for the pass log, or null when there is nothing to say.
  notice: string | null;
}

const LABEL: Record<AnalysisDimension, string> = {
  audio: 'audio',
  vocal: 'vocal',
  stem: 'stem',
};

// What the dimension needs, in the operator's terms. Vocal ranges and the stem
// cache are the same Demucs separation, so they fail together and say so alike.
const MODEL: Record<AnalysisDimension, string> = {
  audio: 'CLAP',
  vocal: 'Demucs',
  stem: 'Demucs',
};

// How to get an image that HAS the model. Deliberately names the image rather
// than a build arg: nearly everyone pulls, and `ANALYZER_HEAVY=1` is the switch
// the compose files read (it is inert on the AIO — see docs/unraid.md).
const HEAVY_HINT =
  'set ANALYZER_HEAVY=1 and recreate the analyzer, or run the -heavy AIO image';

// What the operator actually has to restart to clear the latch. The latch is
// sticky by design — that stickiness is what stops the pass re-attempting
// tracks it cannot fill — so the retry has to name the right process, and the
// right process is not the same one on every deployment. On a sidecar install
// the error is remembered in the analyzer container (server.py
// capability_errors, deliberately not cleared by the worker respawn). On a
// local/AIO install there IS no analyzer container: the worker is a child of
// the controller and the latch lives in the controller's own module state, so
// only the controller going down clears it. Telling an AIO operator to
// `docker compose restart analyzer` is the same class of dead-end advice this
// whole decision exists to stop.
function retryHint(backend: AnalysisBackend): string {
  if (backend === 'sidecar') return 'restart the analyzer (`docker compose restart analyzer`)';
  if (backend === 'local') {
    return 'restart the controller (this deployment runs the analyzer in-process, so there is no separate analyzer to restart)';
  }
  return 'restart the analyzer — or the controller, if it runs the analyzer in-process';
}

export function backfillDecision(x: CapabilityInputs): CapabilityDecision {
  if (!x.wanted) return { widen: false, notice: null };
  if (x.capable !== false) return { widen: true, notice: null };
  const label = LABEL[x.dimension];
  const model = MODEL[x.dimension];
  if (x.error) {
    // The image HAS the model; it failed to load. Say that, say why, and say
    // that the retry is a restart — the capability is latched precisely so the
    // pass stops re-attempting it, which also means it will not clear itself.
    return {
      widen: false,
      notice:
        `${label} backfill skipped — ${model} is installed but failed to load: ${x.error}. ` +
        `Fix the cause, then ${retryHint(x.backend ?? null)} to retry (the failure is remembered ` +
        'until then, so the pass stops re-analysing tracks it cannot fill).',
    };
  }
  return {
    widen: false,
    notice: `${label} backfill skipped — this analyzer is built without ${model} (${HEAVY_HINT})`,
  };
}

// How many tracks in a row may fail before the pass stops treating a throw as
// evidence about the FILE. Five: a run of five consecutive failures is not five
// bad files landing next to each other in id order, it is the thing they share
// — the analyzer that died mid-pass, the music backend that went away, the
// mount that unmounted.
export const SYSTEMIC_FAILURE_RUN = 5;

// Whether a thrown analysis should count against MAX_ANALYSIS_FAILURES.
//
// The per-track failure stamp exists so a file that can NEVER be analysed stops
// re-entering the scope. It is the wrong instrument for a fault that is not
// about the file at all: analyzer.isAvailable() gates the whole pass on the
// ANALYZER being up, but nothing gates it on Navidrome, so a music-backend
// outage (or a sidecar that dies at track 400 of 500) throws for every
// remaining track. Counted naively, three such passes sentence up to a whole
// batch — 500 tracks by the admin default — and the only way back is the
// operator finding and clicking "Retry all".
//
// `consecutive` is the number of failures since the last SUCCESS in this pass,
// including the one being decided. Scattered bad files never build a run (a
// good track between them resets it), so they still get stamped on the first
// attempt. A true answer means "this MAY be about the file" — the caller
// buffers the stamp and only writes it once a later success proves the pass
// healthy, discarding the buffer if the run trips the threshold instead. That
// deferral matters: written eagerly, the five failures in front of the guard
// would land on every pass of a persistent outage, sentencing the scope in id
// order five tracks per three passes — and an excluded track can't self-heal,
// because the success that would clear its count is the thing exclusion
// prevents. Worst case for a genuinely contiguous block of unanalysable files
// is that it takes a few more passes to work through, which is the cheap
// direction to be wrong.
export function failureCountsAgainstTrack(consecutive: number): boolean {
  return consecutive <= SYSTEMIC_FAILURE_RUN;
}
