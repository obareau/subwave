// Acoustic-analysis pass — fills bpm / musical_key / intro_ms for tracks that
// lack them (or were analysed by an older ANALYSIS_VERSION). Resumable and
// batched like the mood tagger: interrupt it and re-run, it picks up where it
// left off. Shared by two entry points — a phase of `npm run tag`
// (music/tag-library.ts) and the standalone `npm run analyze`
// (music/analyze-library.ts) — so the logic lives in exactly one place.
//
// The heavy DSP runs in music/analyzer.ts's backend (tts-heavy sidecar or a
// local librosa venv). When no backend is available this is a clean no-op, so
// it's always safe to call as a tagger phase.

import { readFile, rm } from 'node:fs/promises';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import * as stemCacheStore from './stem-cache.js';
import * as subsonic from './subsonic.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { deriveVocalFromLyrics, clipRangesToTail, type LyricVocalResult } from './lyric-vocal.js';
import { runAudioMoodPass } from './audio-moods.js';
import { reportProgress, makeEventLogger } from './tagger-progress.js';
import { quietGateDecision, type QuietState } from './analyze-quiet-pure.js';
import { backfillDecision, failureCountsAgainstTrack, SYSTEMIC_FAILURE_RUN } from './analyze-capability.js';
import { probeListenerCount } from '../broadcast/listeners.js';

// Structured status events for the panel, mirrored to the terse `[analyze] …`
// console line. Shared by the tagger's analyze phase and the standalone CLI.
const logEvent = makeEventLogger('analyze');

export interface AnalyzeOptions {
  limit?: number;        // cap tracks this run (default: all that need it)
  reAnalyze?: boolean;   // drop existing analysis first, redo everything
  // Re-scan mode: a --re-analyze redoes ONLY the already-analysed population
  // (captured before the clear), never the un-analysed remainder. The raw
  // standalone `npm run analyze --re-analyze` leaves this off and redoes the
  // whole library as documented.
  rescan?: boolean;
  // Widen the scope to tracks that have bpm/key but no CLAP audio vector yet
  // (analysed before audio embeddings were enabled). Only meaningful when the
  // backend actually emits embeddings; defaults from ANALYZE_AUDIO_EMBEDDING.
  audioBackfill?: boolean;
  // Widen the scope to tracks with no vocal-activity ranges yet (vocal_ranges_json
  // NULL). The Demucs pass is expensive and opt-in; defaults from
  // ANALYZE_VOCAL_ACTIVITY / settings.audio.vocalActivity.
  vocalBackfill?: boolean;
}

// Audio embeddings are on when EITHER the env says so (env wins on, never
// off) or the operator flipped the admin toggle (settings.audio.embeddings —
// the discoverable path; see /admin/library). Both entry points (server-spawned
// runs and the standalone CLIs) call settings.load() before this runs.
function audioBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_AUDIO_EMBEDDING || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.embeddings === true;
  } catch {
    return false;
  }
}

// Vocal-activity backfill default — same precedence as audio: env wins on,
// else the admin toggle (settings.audio.vocalActivity).
function vocalBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_VOCAL_ACTIVITY || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.vocalActivity === true;
  } catch {
    return false;
  }
}

// Whether vocal-activity analysis is *wanted* — env ANALYZE_VOCAL_ACTIVITY wins
// on, else settings.audio.vocalActivity. Exposed so /library/coverage can decide
// whether to surface the vocal coverage row (hidden by default; #646).
export function vocalActivityWanted(): boolean {
  return vocalBackfillDefault();
}

// Whether CLAP "sounds-like" audio embeddings are *wanted* — env
// ANALYZE_AUDIO_EMBEDDING wins on, else settings.audio.embeddings. The audio
// twin of vocalActivityWanted(); /library/coverage feeds it into the per-dimension
// status enum so the panel doesn't have to re-derive the enable precedence.
export function audioEmbeddingWanted(): boolean {
  return audioBackfillDefault();
}

// Quiet-times gate (#1099) — same env-wins-on precedence as the toggles above:
// ANALYZE_QUIET_ONLY=1 forces it on, else the admin toggle
// (settings.audio.analyzeQuietOnly).
//
// Unlike the other audio toggles this one is re-read from DISK on every gate
// check, not once per pass: settings.load() caches for the child process's
// lifetime, and a pass over a big library runs for hours — an operator who
// flips the toggle mid-scan (the reporter's overnight run in #1102) expects
// the running pass to react, in both directions. Raw read, no normalization:
// two scalar fields, and any parse failure falls back to the boot-time
// snapshot (settings.get()) and then the defaults.
interface QuietConfig {
  enabled: boolean;
  minutes: number;
}

async function readQuietConfig(): Promise<QuietConfig> {
  const v = (process.env.ANALYZE_QUIET_ONLY || '').toLowerCase();
  const envOn = v === '1' || v === 'true' || v === 'yes';
  let enabled = envOn;
  let minutes = 10;
  let audio: any = null;
  try {
    audio = JSON.parse(await readFile(`${config.stateDir}/settings.json`, 'utf8'))?.audio;
  } catch {
    try {
      audio = settings.get()?.audio;
    } catch {
      audio = null;
    }
  }
  if (!enabled) enabled = audio?.analyzeQuietOnly === true;
  const m = audio?.analyzeQuietMinutes;
  if (Number.isFinite(m) && m >= 1 && m <= 120) minutes = Math.floor(m);
  return { enabled, minutes };
}

// How often the paused pass re-checks Icecast. One cheap status fetch per
// tick (probeListenerCount — no history write); 30s keeps the resume latency
// small without hammering a stream that's busy for hours.
const QUIET_POLL_MS = 30_000;

interface QuietGate {
  state: QuietState;
  paused: boolean; // for one-per-transition logging, not decision logic
}

// Block until the gate allows the next track (immediately when disabled).
// Sits BETWEEN tracks: an in-flight track finishes (seconds) and the pending
// prefetch download is left to resolve — only the next *compute* waits. The
// wait is unbounded by design; the escape hatches are the tagger Stop button
// and the admin toggle, which readQuietConfig() re-reads on every check so a
// mid-pass flip takes effect within one track / one 30s poll.
async function waitForQuiet(gate: QuietGate, progress: { done: number; total: number }): Promise<void> {
  for (;;) {
    const quiet = await readQuietConfig();
    // Skip the Icecast probe entirely while the gate is off (the default
    // path stays one cheap file read per track); the pure helper still runs
    // so a disabled gate resets the quiet clock.
    const count = quiet.enabled ? await probeListenerCount() : null;
    const d = quietGateDecision(gate.state, {
      enabled: quiet.enabled,
      count,
      now: Date.now(),
      quietAfterMs: quiet.minutes * 60_000,
    });
    gate.state = d.state;
    if (d.proceed) {
      if (gate.paused) {
        gate.paused = false;
        logEvent('info', 'Stream is quiet — resuming analysis');
        // Restore the normal label now — the per-track reporter only fires
        // every 25 tracks, which would leave "Waiting for quiet" on the panel
        // long after the pass resumed.
        reportProgress({ phase: 'analyze', label: 'Analysing audio', done: progress.done, total: progress.total });
      }
      return;
    }
    // count>0: someone is tuned in. count===0: the room just emptied and the
    // quiet window is still draining (an unknown count never reaches here —
    // the gate fails open).
    const why = count && count > 0 ? `${count} listening` : 'waiting out the quiet window';
    if (!gate.paused) {
      gate.paused = true;
      logEvent(
        'info',
        `Analysis paused — ${why}; resumes after ${quiet.minutes} min with no listeners`,
      );
    }
    reportProgress({
      phase: 'analyze',
      label: `Waiting for quiet (${why})`,
      done: progress.done,
      total: progress.total,
    });
    await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
  }
}

export interface AnalyzeStats {
  available: boolean;
  backend: string;
  analyzed: number;
  failed: number;
  scope: number;
  // How many of the analysed tracks also got a CLAP audio vector this run.
  // 0 when the backend has no CLAP model loaded (ANALYZE_AUDIO_EMBEDDING off).
  audioEmbedded: number;
  // How many tracks got vocal-activity ranges this run (incl. instrumentals,
  // stored as []). 0 when vocal activity is off / demucs absent.
  vocalAnalyzed: number;
}

// Model label recorded in audio_embedding_meta for provenance. The worker owns
// the actual model; this is just what the controller stamps alongside the
// vectors it stores. Env-overridable so a model swap is self-documenting.
const AUDIO_MODEL_LABEL = process.env.CLAP_MODEL || 'laion-clap';

// Best-effort wrapper — a mood-scoring failure must never fail (or re-run) the
// analysis pass itself; the next pass simply retries the un-scored remainder.
async function scoreAudioMoods(): Promise<void> {
  try {
    await runAudioMoodPass();
  } catch (err: any) {
    console.error(`[audio-moods] pass failed (non-fatal): ${err?.message || err}`);
  }
}

export async function runAnalysisPass(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  if (!(await analyzer.isAvailable())) {
    console.log('[analyze] no analysis backend (tts-heavy sidecar / local librosa venv) — skipping');
    return { available: false, backend: 'none', analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  const backend = analyzer.backendLabel();
  logEvent('info', `Audio engine: ${backend}`);

  // Resolve the vocal (Demucs) decision up front: a --re-analyze that is NOT
  // redoing vocal preserves existing vocal_ranges rather than wiping them (they
  // wouldn't be rebuilt this pass). Only run vocal when the backend can actually
  // produce it (a sidecar without Demucs reports vocalActivityAvailable===false).
  const vocalWanted = opts.vocalBackfill ?? vocalBackfillDefault();
  const vocalDecision = backfillDecision({
    dimension: 'vocal',
    wanted: vocalWanted,
    capable: analyzer.vocalActivityAvailable(),
    error: analyzer.vocalActivityError(),
    backend,
  });
  const vocalBackfill = vocalDecision.widen;
  // Stem cache (feature: stem-blend transitions): when the operator opted in
  // and the backend has Demucs, every analysed track also persists its head/
  // tail stems (the worker shares one separation with vocal detection, so
  // this is near-free compute — the spend is disk, LRU-swept below).
  // Same three-way capability question as audio and vocal, so it gets the same
  // answer from the same place. The stem cache rides Demucs, so a Demucs that
  // failed to LOAD lands on the same `capable: false` a lean image does — and
  // the old hard-coded message here told that operator to "use the heavy
  // analyzer image", which is the dead-end advice this whole decision exists to
  // stop, left standing in the one widening that hadn't been converted.
  const stemDecision = backfillDecision({
    dimension: 'stem',
    wanted: settings.get()?.audio?.stemCache === true,
    capable: analyzer.vocalActivityAvailable(),
    error: analyzer.vocalActivityError(),
    backend,
  });
  const stemCache = stemDecision.widen;

  // A re-scan re-analyse is scoped to the tracks that were ALREADY analysed —
  // snapshot them before the clear wipes the bpm marker. A raw --re-analyze
  // leaves reAnalyzeScope null and redoes the whole library (needsAnalysisIds
  // returns everything once the version markers are cleared).
  let reAnalyzeScope: string[] | null = null;
  if (opts.reAnalyze) {
    if (opts.rescan) reAnalyzeScope = db.analysedIds();
    db.clearAnalysis({ keepVocal: !vocalBackfill, clearStems: stemCache });
    console.log(
      `[analyze] --re-analyze: cleared existing analysis${vocalBackfill ? '' : ' (kept vocal ranges)'}` +
        (reAnalyzeScope ? ` — re-scan scope: ${reAnalyzeScope.length} already-analysed tracks` : ''),
    );
  }

  const cap = opts.limit && opts.limit > 0 ? opts.limit : undefined;
  const bpmIds = reAnalyzeScope
    ? (cap ? reAnalyzeScope.slice(0, cap) : reAnalyzeScope)
    : db.needsAnalysisIds(cap);
  let ids = bpmIds;

  // Audio backfill: also target already-analysed tracks that lack a CLAP audio
  // vector, so enabling embeddings on a previously-analysed library fills it in
  // without a full --re-analyze. Re-running analysis on these recomputes bpm/key
  // (same values, harmless) and stores the new audio vector from the same call.
  // `audioBackfill` stays the "CLAP wanted + producible" signal (drives the
  // per-track embed flag below); the widening is gated separately on
  // !reAnalyzeScope. A re-scan re-analyse already has a FIXED scope (the
  // previously-analysed set) and re-embeds CLAP for those via embed:true — so it
  // must NOT widen, or it'd pull the whole library back in (every track looks
  // vector-less right after the clear).
  // ...and ONLY when the backend can actually emit CLAP vectors. A backend that
  // can't never fills the vector column, so widening would re-analyse every
  // already-analysed track on every run for a guaranteed no-vector — the same
  // churn the vocal gate below prevents. The `false` there used to mean exactly
  // one thing (a lean image) and got exactly one message; a heavy image whose
  // weights fail to DOWNLOAD lands on the same false and needs the opposite
  // advice, so both the gate and its wording now come from the pure
  // backfillDecision (analyze-capability.ts). `null` (local backend / not yet
  // probed) still widens — unknown is not a no.
  const audioWanted = opts.audioBackfill ?? audioBackfillDefault();
  const audioDecision = backfillDecision({
    dimension: 'audio',
    wanted: audioWanted,
    capable: analyzer.audioEmbeddingAvailable(),
    error: analyzer.audioEmbeddingError(),
    backend,
  });
  const audioBackfill = audioDecision.widen;
  if (audioBackfill && !reAnalyzeScope) {
    const seen = new Set(bpmIds);
    const audioIds = db.unanalysedAudioIds(cap).filter(id => !seen.has(id));
    ids = cap ? [...bpmIds, ...audioIds].slice(0, cap) : [...bpmIds, ...audioIds];
    if (audioIds.length > 0) {
      console.log(`[analyze] audio backfill: +${ids.length - bpmIds.length} already-analysed tracks missing an audio vector`);
    }
  } else if (audioDecision.notice && !reAnalyzeScope) {
    // Warn-level when the model is present but broken: that's a fault the
    // operator can clear, unlike a lean image, which is just a build choice.
    logEvent(analyzer.audioEmbeddingError() ? 'warning' : 'info', audioDecision.notice);
  }

  // Vocal backfill: same idea for tracks missing vocal-activity ranges. The
  // Demucs separation is the expensive part, so this only widens the scope when
  // the operator opted in (env/admin toggle); the `vocal:true` flag below then
  // forces the backend to run it for this pass.
  // ...but ONLY when the backend can actually produce vocal ranges. A sidecar
  // built without Demucs (WITH_DEMUCS=0) reports vocalActivityAvailable()===false;
  // its vocal column then stays NULL forever, so backfilling would re-scan the
  // WHOLE library on every run for a guaranteed no-op (the churn behind the
  // "275/7093" report). `false` = definitively not built → skip; `null` (local
  // backend / not yet probed) keeps today's behaviour. isAvailable() above has
  // already probed the sidecar, so the capability is current here.
  // (vocalWanted / vocalBackfill resolved up front — see the clear above.)
  // Widening is suppressed under a fixed re-scan scope for the same reason as
  // audio above; the per-track vocal:true flag below still re-runs Demucs for the
  // in-scope tracks, so vocal ranges are rebuilt without dragging in the remainder.
  // Tail widening (feature: vocal-aware transitions): also re-target tracks
  // whose outro predates tail vocal detection — ONLY when the backend
  // advertises the capability (=== true). Old sidecars never report the flag,
  // so a stale image keeps the original head-only scope and can't churn.
  const includeTailMissing = analyzer.tailVocalAvailable() === true;
  if (vocalBackfill && !reAnalyzeScope) {
    const seen = new Set(ids);
    const vocalIds = db.needsVocalIds(cap, includeTailMissing).filter(id => !seen.has(id));
    const before = ids.length;
    ids = cap ? [...ids, ...vocalIds].slice(0, cap) : [...ids, ...vocalIds];
    if (ids.length > before) {
      console.log(`[analyze] vocal backfill: +${ids.length - before} tracks missing vocal-activity ranges`);
    }
  } else if (vocalDecision.notice && !reAnalyzeScope) {
    // Only say this when widening was actually attempted (not under a fixed
    // re-scan scope, where the per-track vocal flag handles the rebuild and
    // capability is surfaced in the admin UI instead).
    logEvent(analyzer.vocalActivityError() ? 'warning' : 'info', vocalDecision.notice);
  }

  // Stem backfill: the fourth widening (after CLAP vectors, vocal ranges and
  // the tail-vocal re-target), for tracks that have never had a stem
  // pass. Without it, turning the stem cache on did NOTHING to an
  // already-analysed library — the scope above only re-targets missing CLAP
  // vectors and missing vocal ranges, so a fully-scanned library reported
  // "all tracks current" and the operator's only route was a --re-analyze
  // that wipes every vector and can't resume across runs.
  //
  // `stemCache` already carries the capability gate (Demucs present), the same
  // guard the vocal widening needs to avoid re-scanning the library forever for
  // a guaranteed no-op. Suppressed under a fixed re-scan scope for the same
  // reason as the other two: those tracks re-separate anyway via stems_dir.
  //
  // Capped at what the budget can still hold. The stem set for a track is a
  // full Demucs separation; queuing thousands the LRU sweep will evict on the
  // way out is hours of GPU time thrown away, and it's why a big library
  // looked like it "only ever caches the last 600 songs". The cap is announced
  // — a silent truncation would read as "the backfill finished".
  //
  // The same headroom figure then gates EVERY stem write in the loop below
  // (#1257): stems ride along with any analysis when the cache is on, and the
  // ride-alongs used to bypass this cap entirely — a vocal backfill over a big
  // library grew a 500 GB budget to 674 GB with the backfill happily reporting
  // "skipped — cache is at budget" the whole time. One figure per pass:
  // stemSlotsLeft is decremented per NET-NEW dir requested (a rewrite of an
  // existing dir costs nothing — see stemCacheStore.stemWriteDecision), so the
  // pass can overshoot by at most the estimate's error before the sweep
  // settles the bill.
  let stemSlotsLeft = 0;
  let existingStemDirs: Set<string> = new Set();
  if (stemCache) {
    stemSlotsLeft = await stemCacheStore.headroomTracks();
    existingStemDirs = await stemCacheStore.cachedTrackIdSet();
  }
  if (stemCache && !reAnalyzeScope) {
    // The loop below spends stemSlotsLeft in ids order, and the tracks the
    // earlier widenings queued run FIRST — every one of them without a dir on
    // disk drains a slot before the backfill's own slice is reached. Sizing
    // (and announcing) off the raw pass-start figure re-creates the exact
    // "announced N, silently wrote fewer" truncation for the backfill's tail,
    // so reserve those slots up front.
    const reserved = ids.filter(id => !existingStemDirs.has(id)).length;
    const backfillSlots = Math.max(0, stemSlotsLeft - reserved);
    if (backfillSlots <= 0) {
      console.log(
        stemSlotsLeft <= 0
          ? `[analyze] stem backfill skipped — cache is at its ${settings.get()?.audio?.stemCacheGb ?? 15} GB budget ` +
              '(raise it in Settings → Transitions to cache more tracks)'
          : `[analyze] stem backfill skipped — the ${reserved} ride-along stem writes already queued this pass ` +
              `claim the budget's remaining ~${stemSlotsLeft} track slots`,
      );
    } else {
      const seen = new Set(ids);
      const needing = db.needsStemsIds().filter(id => !seen.has(id));
      // Under --limit, only the slots the bpm/CLAP/vocal scopes haven't already
      // spent are available — sizing off the raw cap would log stem tracks a
      // final slice then silently drops, the exact "reads as finished"
      // truncation the announcement exists to avoid.
      const room = cap ? Math.min(Math.max(0, cap - ids.length), backfillSlots) : backfillSlots;
      const stemIds = needing.slice(0, room);
      if (stemIds.length > 0) {
        ids = [...ids, ...stemIds];
        const left = needing.length - stemIds.length;
        console.log(
          `[analyze] stem backfill: +${stemIds.length} tracks with no cached stems` +
            (left > 0 ? ` (${left} left for later passes — budget holds ~${backfillSlots} more)` : ''),
        );
      }
    }
  } else if (stemDecision.notice && !reAnalyzeScope) {
    // Warn-level when Demucs is present but broken, info when the image simply
    // wasn't built with it — same split as audio and vocal above.
    logEvent(analyzer.vocalActivityError() ? 'warning' : 'info', stemDecision.notice);
  }

  // Say how many tracks the scope is deliberately leaving out. Silence here is
  // what made the old behaviour so confusing in reverse: "all tracks current"
  // is true of a library with 90 files that can never be analysed, and reads as
  // a clean bill of health.
  const excludedFailures = db.analysisFailedCount();
  if (excludedFailures > 0) {
    logEvent(
      'warning',
      `${excludedFailures} track${excludedFailures === 1 ? '' : 's'} excluded after ` +
        `${db.MAX_ANALYSIS_FAILURES} failed attempts — see Library → analysis failures for the reasons`,
    );
  }

  if (ids.length === 0) {
    console.log('[analyze] nothing to analyse — all tracks current');
    // Audio-mood scoring can still have work (vectors from past passes that
    // predate the scorer, or a changed vocabulary) — run it before returning.
    await scoreAudioMoods();
    return { available: true, backend, analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  logEvent('info', `Analysing audio for ${ids.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'analyze', label: 'Analysing audio', done: 0, total: ids.length });

  let analyzed = 0;
  let failed = 0;
  // Failures since the last success in THIS pass — the signal that separates a
  // bad file from a bad pass (see failureCountsAgainstTrack).
  let consecutiveFailures = 0;
  // Failure stamps held back until the pass proves it deserves to hand them
  // out. A throw inside the systemic window MIGHT be evidence about the file —
  // it depends on how the run ends, which is only known later: the next
  // success flushes the buffer (a scattered bad file still gets its stamp on
  // the pass it failed), the guard tripping discards it. Stamping eagerly and
  // revoking on the trip would also work, but the revoke would have to
  // subtract exactly what this pass added on top of counts earlier passes
  // earned; withholding the write is the version with nothing to un-do.
  let pendingFailureStamps: Array<{ id: string; reason: string }> = [];
  const flushFailureStamps = () => {
    for (const f of pendingFailureStamps) {
      try {
        db.recordAnalysisFailure(f.id, f.reason);
      } catch (stampErr: any) {
        // Never let bookkeeping end the pass — the old behaviour (retry
        // forever) is a better failure than stopping the run.
        console.error(`[analyze] ${f.id} failure stamp failed: ${stampErr?.message || stampErr}`);
      }
    }
    pendingFailureStamps = [];
  };
  let audioEmbedded = 0;
  let vocalAnalyzed = 0;
  // Quiet-times gate (#1099). The toggle itself is re-read from disk on every
  // check (see readQuietConfig); only the quiet-clock STATE lives here, so it
  // carries across tracks instead of resetting each loop iteration.
  const quietGate: QuietGate = { state: { quietSince: null }, paused: false };
  {
    const quiet = await readQuietConfig();
    if (quiet.enabled) {
      logEvent(
        'info',
        `Quiet-times gate on — analysis only runs once the stream has had no listeners for ${quiet.minutes} min`,
      );
    }
  }
  // Stamp the audio-embedding provenance row once, on the first vector written
  // this run. Cheap idempotent guard so we don't touch the meta table per track.
  let audioMetaStamped = false;
  const audioModelLabel = AUDIO_MODEL_LABEL;
  // One announcement when the stem budget gate first closes mid-pass — the
  // per-track skips themselves are routine, not news.
  let stemGateAnnounced = false;

  // One-ahead prefetch pipeline: the controller downloads track i+1's audio
  // (network) while the backend computes track i (CPU), so the two overlap.
  // The backend stays single-threaded — we only hide fetch latency. Each
  // download resolves to a temp path on the shared volume; on download failure
  // we fall back to the url path for that one id so it still gets analysed.
  // One-ahead prefetch, eagerly reduced to a SETTLED result so a rejection can
  // never float as an unhandled rejection in the window between kicking the
  // download off and awaiting it next iteration. downloadCapped now rejects on
  // every stale library entry (file missing on disk) — common — and Node's
  // default --unhandled-rejections=throw crashed the whole pass when a one-ahead
  // prefetch rejected during the previous track's compute window. The .then(_,_)
  // attaches handlers immediately, so the rejection is always owned.
  type Prefetch = Promise<{ path: string; complete: boolean } | { err: any }>;
  const prefetch = (songId: string): Prefetch =>
    analyzer.downloadCapped(songId).then((r) => r, (err) => ({ err }));
  let inflight: Prefetch | null = ids.length > 0 ? prefetch(ids[0]) : null;

  for (let i = 0; i < ids.length; i++) {
    // Gate BEFORE the next prefetch is kicked off: while paused, only the
    // already-inflight download (this track's) is outstanding — the pass
    // doesn't keep pulling audio for a queue it isn't going to compute yet.
    await waitForQuiet(quietGate, { done: i, total: ids.length });
    const id = ids[i];
    const downloadPromise = inflight;
    // Kick off the NEXT download before awaiting this one's analysis so the
    // fetch overlaps the compute.
    inflight = i + 1 < ids.length ? prefetch(ids[i + 1]) : null;

    let localPath: string | null = null;
    let localComplete: boolean | undefined;
    try {
      const settled = downloadPromise ? await downloadPromise : null;
      if (settled && 'err' in settled) {
        const err: any = settled.err;
        // A non-audio response (stale library entry — file missing on disk) is
        // not retryable via the url path, so don't mask it behind the sidecar's
        // url fetch; let the per-track handler record the real reason.
        if (err instanceof analyzer.NonAudioResponseError) throw err;
        // Otherwise a transient fetch failure — fall back to the url path.
        console.error(`[analyze] ${id} prefetch failed (${err?.message || err}); using url path`);
        localPath = null;
      } else {
        localPath = settled?.path ?? null;
        localComplete = settled && 'complete' in settled ? settled.complete : undefined;
      }
      // embed:true makes the backend lazy-load CLAP even when its own env
      // doesn't have ANALYZE_AUDIO_EMBEDDING (the admin-toggle path); omitted
      // when audio is off so the backend keeps its env-driven default.
      const embed = audioBackfill ? true : undefined;
      // Lyric-first vocal ranges (#1125): when vocal activity is wanted, try the
      // track's timed Navidrome lyrics before spending a Demucs separation. A
      // synced-lyric or explicit-instrumental track is decided here — accurately,
      // with no separation bleed — and skips Demucs. Anything inconclusive (no
      // lyrics, or unsynced text) still runs Demucs (now with the mix floor).
      // Best-effort: a lyric-fetch failure just falls through to Demucs.
      let lyricVocal: LyricVocalResult | null = null;
      if (vocalBackfill) {
        try {
          lyricVocal = deriveVocalFromLyrics(await subsonic.getStructuredLyrics(id));
        } catch {
          lyricVocal = null;
        }
      }
      // stems_dir asks the worker to persist the stems it separates anyway —
      // wire-named (spread verbatim into the worker request). Implies the
      // separation even when the vocal toggle is off.
      // Budget-gated (#1257): a net-new dir spends one of the pass's headroom
      // slots; a rewrite of a dir already on disk is free (no net-new bytes).
      // Once the slots run out, later tracks analyse without stems and stay
      // in needsStemsIds for a pass with room. Announced once, not per track.
      const stemDecision = stemCacheStore.stemWriteDecision({
        cacheOn: stemCache,
        slotsLeft: stemSlotsLeft,
        hasExistingDir: existingStemDirs.has(id),
      });
      if (stemDecision.consumesSlot) stemSlotsLeft -= 1;
      if (stemCache && !stemDecision.want && !stemGateAnnounced) {
        stemGateAnnounced = true;
        console.log(
          `[analyze] stem cache budget reached mid-pass — stems skipped for the remaining net-new tracks ` +
            '(raise audio.stemCacheGb in Settings → Transitions to cache more)',
        );
      }
      const stems_dir = stemDecision.want ? stemCacheStore.dirFor(id) : undefined;
      // vocal:true forces the Demucs pass for this track (admin/backfill path),
      // mirroring embed. A lyric-decided track sends an EXPLICIT false — the
      // worker only skips Demucs on undefined when its OWN env has vocal off,
      // and the analyzer service/AIO can carry ANALYZE_VOCAL_ACTIVITY, which
      // would pay the whole separation just to have its result overridden
      // below. Omitted when vocal activity is off.
      // …unless this track is caching stems: explicit false wins over stems_dir
      // in the worker, and the stem cache IS the separation, so skipping it to
      // save a Demucs pass we're paying for anyway would just lose the stems.
      // Lyrics still override the stored ranges below either way.
      const vocal = vocalBackfill ? (lyricVocal && !stems_dir ? false : true) : undefined;
      const a = localPath
        ? await analyzer.analyzePath(localPath, { embed, vocal, complete: localComplete, stems_dir })
        : await analyzer.analyze(id, { embed, vocal, stems_dir });
      // Lyrics win over the worker's vocal output when present: the ranges are
      // ground truth, and a synced onset is a truer intro than the energy
      // heuristic the worker returns once Demucs is skipped. An instrumental
      // marker (introMs null) keeps the energy-based intro.
      const vocalRanges = lyricVocal ? lyricVocal.vocalRanges : a.vocalRanges;
      // Tail ranges for lyric-decided tracks (feature: vocal-aware
      // transitions): vocal:false above skips the worker's tail Demucs pass,
      // so a.outro comes back with NO vocalRanges — and without a fill here
      // the sung tracks the feature exists for never get tail data
      // (mix.vocalTailFor stays null) while the tail-widened backfill
      // re-targets them on every pass, forever — the same churn class as the
      // "275/7093" report. Lyrics are tail ground truth exactly as they are
      // for the head: clip the whole-track ranges into the outro window
      // (20s mirrors the worker's ANALYZE_OUTRO_SECONDS default; the
      // wind-down start bounds it when the tagged duration is unknown).
      // Lyric-decided ⇒ override, matching vocalRanges above — a
      // stems-forced Demucs tail is still trumped by synced timing.
      let outro = a.outro;
      if (lyricVocal && outro) {
        const durMs = (Number(db.getTrack(id)?.durationSec) || 0) * 1000;
        const windowStartMs = durMs > 0 ? Math.min(outro.startMs, durMs - 20_000) : outro.startMs;
        outro = {
          ...outro,
          vocalRanges: clipRangesToTail(lyricVocal.vocalRanges, windowStartMs, durMs > 0 ? durMs : null),
        };
      }
      db.upsertTrackAnalysis(id, {
        bpm: a.bpm,
        musicalKey: a.musicalKey,
        introMs: lyricVocal?.introMs != null ? lyricVocal.introMs : a.introMs,
        confidence: a.confidence,
        loudnessLufs: a.loudnessLufs,
        peakDb: a.peakDb,
        sections: a.sections,
        pace: a.paceCurve,
        beats: a.beats,
        bars: a.bars,
        keyRanges: a.keyRanges,
        vocalRanges,
        outro,
        // Stamp the stem attempt whenever the worker actually reached the
        // stem-writing step — true (written) OR false (the write failed for
        // this track). Both are settled outcomes, and stamping the miss is
        // what stops a track that can never produce stems from being
        // re-targeted on every pass forever. null means the worker never got
        // that far (no stems_dir requested, or no Demucs), so the track stays
        // in scope for a later, better-equipped pass.
        stemsAttempted: a.stemsCached !== null,
      });
      if (vocalRanges != null) vocalAnalyzed += 1;
      // Stuck-case telemetry (vocal-aware transitions): a vocal pass that
      // produced head ranges but NO outro (incomplete download — the file
      // grew past ANALYZE_MAX_BYTES since its outro was stored) can't write
      // tail vocal data, and the upsert's COALESCE keeps the old tail-missing
      // outro — so the widened backfill will re-target this track every pass.
      // Say so instead of churning silently. Lyric-decided tracks hit the
      // same wall (no outro → nothing for the lyric fill above to clip into);
      // otherwise keyed off the WORKER's ranges, not the lyric-resolved ones:
      // it's the Demucs tail pass that's stuck.
      if (a.outro == null && (lyricVocal != null || (vocal && a.vocalRanges != null))) {
        const prior = db.getTrack(id);
        if (prior?.outro && prior.outro.vocalRanges == null) {
          console.log(`[analyze] ${id}: tail vocals not computable (incomplete download; stored outro predates tail detection) — stays in the vocal backfill scope`);
        }
      }
      // Opportunistically store the CLAP audio vector whenever the backend
      // carried one. Independent of the bpm/key write above: a track analysed
      // before CLAP was enabled simply gets its vector on the next pass once
      // unanalysedAudioIds re-targets it. The first vector written stamps the
      // audio-embedding provenance row.
      if (a.audioEmbedding && a.audioEmbedding.length === db.AUDIO_EMBEDDING_DIM) {
        try {
          db.upsertTrackAudioVector(id, a.audioEmbedding);
          if (!audioMetaStamped) {
            db.setAudioEmbeddingMeta(audioModelLabel, db.AUDIO_EMBEDDING_DIM);
            audioMetaStamped = true;
          }
          audioEmbedded += 1;
        } catch (err: any) {
          console.error(`[analyze] ${id} audio-vector write failed: ${err?.message || err}`);
        }
      }
      analyzed += 1;
      // A success is the evidence that the pass itself is healthy — so the
      // failures buffered since the last one were about their FILES after all,
      // and their stamps land now. The run the systemic guard counts starts
      // again from here.
      flushFailureStamps();
      consecutiveFailures = 0;
    } catch (err: any) {
      failed += 1;
      consecutiveFailures += 1;
      // The analysis columns stay NULL so the next run retries — but record
      // WHY, and count it. Without the stamp a permanently unanalysable track
      // (a corrupt file, a library row whose file is gone) is indistinguishable
      // from one that has never been attempted, so it re-enters the scope on
      // every pass forever and nothing anywhere can name it. After
      // MAX_ANALYSIS_FAILURES consecutive failures the exclusion in the scope
      // queries drops it, and the admin list is where it goes to be seen.
      //
      // ...but ONLY while the throw is evidence about the file. Past a run of
      // SYSTEMIC_FAILURE_RUN with no success in between, the shared cause is
      // the pass, not the track — Navidrome gone (isAvailable() gates the pass
      // on the ANALYZER being up, never on the music backend), the sidecar
      // dying mid-run, a mount that went away — and counting those would
      // sentence up to a whole batch to the exclusion list over three such
      // passes, recoverable only by hand. Which is why stamps are BUFFERED
      // (pendingFailureStamps) rather than written here: a persistent outage
      // used to still stamp the five tracks in front of the guard on every
      // pass, sentencing the scope in id order five tracks per three passes —
      // and an excluded track can't self-heal, because the success that would
      // clear its count is exactly what exclusion prevents.
      const reason = String(err?.message || err);
      console.error(`[analyze] ${id} failed: ${reason}`);
      if (failureCountsAgainstTrack(consecutiveFailures)) {
        pendingFailureStamps.push({ id, reason });
      } else if (consecutiveFailures === SYSTEMIC_FAILURE_RUN + 1) {
        logEvent(
          'warning',
          `${SYSTEMIC_FAILURE_RUN + 1} tracks in a row failed to analyse — treating this as a fault ` +
            'in the pass rather than the files (is the music backend reachable?), so these failures ' +
            'are not counted against any track until one analyses successfully again',
        );
        // The leading run's buffered stamps go with the verdict — the trip is
        // the moment they stopped being evidence about the files.
        pendingFailureStamps = [];
      }
    } finally {
      // Drop this track's temp file (best-effort) regardless of outcome.
      if (localPath) await rm(localPath, { force: true }).catch(() => {});
    }
    if ((i + 1) % 25 === 0 || i + 1 === ids.length) {
      console.log(`[analyze] ${i + 1}/${ids.length} (ok=${analyzed} fail=${failed})`);
      reportProgress({
        phase: 'analyze',
        label: 'Analysing audio',
        done: i + 1,
        total: ids.length,
        errors: failed || undefined,
      });
    }
  }

  // A trailing run of failures shorter than the systemic threshold never met
  // the success that would have flushed it — but nothing proved the pass
  // unhealthy either, so those stamps land (matching what an eager write would
  // have done). A run that DID trip the guard already emptied the buffer.
  flushFailureStamps();

  // Best-effort sweep of the staging dir in case a prefetch left an orphan
  // (e.g. a download that resolved after its analyze slot already errored).
  await rm(`${config.stateRoot}/analyze-tmp`, { recursive: true, force: true }).catch(() => {});

  // Keep the stem cache inside the operator's byte budget after a pass that
  // may have written hundreds of new stem dirs (LRU by dir mtime; the hourly
  // cleanup cron sweeps too, this just settles the bill promptly).
  if (stemCache) {
    const swept = await stemCacheStore.sweep().catch(() => null);
    if (swept && swept.removed > 0) {
      console.log(`[analyze] stem cache sweep: evicted ${swept.removed} track dirs (${Math.round(swept.freedBytes / 1024 ** 2)} MB)`);
    }
    // Surface a sweep that couldn't reach the budget (#1257) — the per-dir
    // deletes are best-effort by design, so this is the only place a
    // stuck-over-budget cache becomes visible to the operator event log.
    if (swept && swept.overBudgetBytes > 0) {
      logEvent(
        'warning',
        `Stem cache is ${(swept.overBudgetBytes / 1024 ** 3).toFixed(1)} GB over its ${settings.get()?.audio?.stemCacheGb ?? 15} GB budget and the sweep could not evict down to it` +
          (swept.failedDirs ? ` (${swept.failedDirs} dir delete(s) failed — check ownership/permissions on state/stems)` : ''),
      );
    }
  }

  // Zero-shot audio moods over the vectors this pass (and past passes) wrote —
  // one CLAP text-tower round-trip + in-process cosines (music/audio-moods.ts).
  // No-ops in seconds when there's nothing new and skips cleanly on backends
  // without the text tower.
  await scoreAudioMoods();

  // The worker degrades silently when Demucs fails to load at runtime (weights
  // download, OOM): every track analyses "ok" with vocal_ranges omitted, so a
  // vocal backfill that stored nothing would otherwise look like a clean run —
  // and re-target the same tracks forever (#996).
  if (vocalBackfill && analyzed > 0 && vocalAnalyzed === 0) {
    logEvent(
      'warning',
      'Vocal backfill stored no vocal-activity ranges — Demucs likely failed to load at runtime; check the analyzer container logs for "Demucs load failed"',
    );
  }

  logEvent(
    'success',
    `Audio analysed — ${analyzed.toLocaleString('en-GB')} tracks` +
      (audioEmbedded > 0 ? `, ${audioEmbedded.toLocaleString('en-GB')} sounds-like` : '') +
      (vocalAnalyzed > 0 ? `, ${vocalAnalyzed.toLocaleString('en-GB')} vocal` : '') +
      (failed > 0 ? ` · ${failed.toLocaleString('en-GB')} failed` : ''),
  );
  return { available: true, backend, analyzed, failed, scope: ids.length, audioEmbedded, vocalAnalyzed };
}
