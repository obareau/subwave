// The LLM tagging worker pool, reused by phases 2 and 4.
//
// `pin` selects which leg each consumer targets (undefined = normal
// primary->fallback failover, used in single-LLM mode); `label` is stamped on
// every track a consumer tags, so per-track provenance stays honest when two
// different models are working the same run (discussion #320).
//
// Part of the tag-library/ split - see ../tag-library.ts for main().

import * as db from '../library-db.js';
import { primaryLeg, fallbackLeg, probeLegReachable } from '../../llm/provider.js';
import { isUnreachable, isQuotaOrAuthError, errReason } from '../../llm/sdk.js';
import { tagBatch, tagOne, type TagResult } from '../tagger-core.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';


// ---------------------------------------------------------------------------
// LLM tagging helper (reused by phase 2 + phase 4)
// ---------------------------------------------------------------------------

// A single LLM worker the batch loop pulls through. `pin` selects which leg
// each call targets (undefined → normal primary→fallback failover, used in
// single-LLM mode); `label` is stamped on every track this consumer tags so the
// per-track provenance is honest across two different models (discussion #320).
interface TagConsumer {
  pin?: 'primary' | 'fallback';
  label: string;
}

interface TagState {
  tagged: number;
  callCount: number;
  processed: number;
  // Tracks that came back null from the LLM (batch entry dropped / per-track
  // salvage failed) — surfaced in the progress channel.
  errors: number;
  byLeg: Record<string, number>;
}

// Which pipeline phase a runConsumer() call is tagging for — only used to
// stamp the progress channel ('seed' = phase 2, 'learn' = phase 4 rounds).
interface TagPhaseInfo {
  phase: 'seed' | 'learn';
  round?: number;
}

// Tag one batch with one consumer's leg. Returns the count actually tagged.
// Throws ONLY when a pinned leg's host is unreachable — the caller requeues the
// whole batch and drops the consumer. Upserts happen only after the batch fully
// resolves, so a rethrow mid-batch persists nothing: the requeue is lossless.
// Non-unreachable failures (small models dropping list entries) salvage per
// track exactly as before, so one bad line never sinks 25 tracks.
async function processBatch(
  batch: string[],
  consumer: TagConsumer,
  promptHash: string,
  source: db.TagSource,
  state: TagState,
): Promise<number> {
  const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
  if (songs.length === 0) return 0;
  const input = songs.map(t => ({
    title: t.title ?? undefined,
    artist: t.artist ?? undefined,
    album: t.album ?? undefined,
    year: t.year ?? undefined,
    genres: t.genres,
  }));
  const opts = consumer.pin ? { leg: consumer.pin } : {};

  let results: Array<TagResult | null>;
  try {
    results = await tagBatch(input, opts);
    state.callCount += 1;
  } catch (err: any) {
    // A pinned leg that can't recover this run — host down, OR a
    // quota/usage-limit/auth rejection (#438): rethrow BEFORE the per-track
    // salvage, otherwise we'd grind 25 serial connect-timeouts (or 25 identical
    // 429s) against a leg that won't answer. The surviving consumer redoes the
    // requeued batch.
    if (consumer.pin && (isUnreachable(err) || isQuotaOrAuthError(err))) throw err;
    // A "batch length mismatch" is NOT a failure. Some models (e.g. Mercury, and
    // small local models) don't return one structured-output entry per input
    // track, so we tag each track individually this batch — same seed set, same
    // cost envelope (only the seeds ever hit the LLM), just slower. Log it as an
    // expected degrade, not an error, so it doesn't read as something broken.
    // Genuine batch errors keep the error-level line with their message.
    const perTrackDegrade = /batch length mismatch/i.test(err.message || '');
    if (perTrackDegrade) {
      logEvent(
        'warning',
        `${consumer.label} didn't return one entry per track — tagging ` +
          `${songs.length} tracks individually this batch (expected for some models; just slower)`,
      );
    } else {
      logEvent(
        'error',
        `LLM batch failed (${songs.length} tracks) on ${consumer.label}: ${err.message} — falling back to per-track`,
      );
    }
    results = [];
    for (const song of input) {
      try {
        results.push(await tagOne(song, opts));
        state.callCount += 1;
      } catch (oneErr: any) {
        // Leg unusable mid-salvage (host died, or quota/auth) — bail the whole
        // batch (nothing upserted yet).
        if (consumer.pin && (isUnreachable(oneErr) || isQuotaOrAuthError(oneErr))) throw oneErr;
        console.error(`[tag] per-track tag failed on ${consumer.label}: ${oneErr.message}`);
        results.push(null);
      }
    }
  }

  let tagged = 0;
  for (let j = 0; j < songs.length; j++) {
    const result = results[j];
    if (!result) {
      state.errors += 1;
      continue;
    }
    const { moods, energy } = result;
    db.upsertTrackTags(songs[j].id, {
      moods,
      energy,
      source,
      confidence: null,
      promptHash,
      model: consumer.label,
    });
    tagged += 1;
  }
  return tagged;
}

// Drain the shared `batches` queue with one consumer. `shift()` between awaits
// is atomic (single-threaded event loop), so two consumers never pull the same
// batch. In dual mode a pinned consumer whose host dies requeues its batch and
// returns; `onDrop` reports how many legs remain.
async function runConsumer(
  batches: string[][],
  consumer: TagConsumer,
  promptHash: string,
  source: db.TagSource,
  total: number,
  state: TagState,
  phaseInfo: TagPhaseInfo,
  onDrop: ((err: any) => number) | null,
): Promise<void> {
  for (;;) {
    const batch = batches.shift();
    if (!batch) return;
    try {
      const n = await processBatch(batch, consumer, promptHash, source, state);
      state.tagged += n;
      state.byLeg[consumer.label] = (state.byLeg[consumer.label] || 0) + n;
    } catch (err: any) {
      // processBatch rethrows only when a pinned leg can't recover this run:
      // the host is down (isUnreachable) OR the provider refused the leg with a
      // quota / credit / usage-limit / auth error (isQuotaOrAuthError, #438).
      // Name the real reason — logging every drop as "unreachable" misdirected an
      // operator whose OpenRouter credits had simply run out (Discord).
      batches.unshift(batch);
      const remaining = onDrop ? onDrop(err) : 0;
      const reason = isQuotaOrAuthError(err) ? 'quota/credit/auth rejected' : 'host unreachable';
      logEvent(
        'error',
        `LLM leg ${consumer.label} dropped — ${reason}: ${errReason(err)} (${remaining} leg(s) left)`,
      );
      return;
    }
    state.processed += 1;
    if (state.processed % 4 === 0) {
      console.log(`[tag] LLM-tagged ${state.tagged}/${total}`);
    }
    reportProgress({
      phase: phaseInfo.phase,
      label: 'Tagging with LLM',
      done: state.tagged,
      total,
      round: phaseInfo.round,
      errors: state.errors || undefined,
      llm: { legs: state.byLeg },
    });
  }
}

// Phase 2 + phase 4 LLM tagging. One consumer (single-LLM mode, failover-capable
// calls) or two (dual-LLM mode, one pinned per leg) drain a shared batch queue.
export async function llmTagInBatches(
  ids: string[],
  batchSize: number,
  promptHash: string,
  source: db.TagSource,
  consumers: TagConsumer[],
  phaseInfo: TagPhaseInfo,
): Promise<{ tagged: number; callCount: number; byLeg: Record<string, number> }> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const state: TagState = { tagged: 0, callCount: 0, processed: 0, errors: 0, byLeg: {} };
  reportProgress({
    phase: phaseInfo.phase,
    label: 'Tagging with LLM',
    done: 0,
    total: ids.length,
    round: phaseInfo.round,
  });

  if (consumers.length <= 1) {
    // Single consumer — no requeue/drop; the unpinned call already fails over
    // internally, so an error means the batch is genuinely unworkable this run.
    await runConsumer(batches, consumers[0], promptHash, source, ids.length, state, phaseInfo, null);
  } else {
    let alive = consumers.length;
    let quotaOrAuthDrop = false;
    await Promise.all(
      consumers.map(c =>
        runConsumer(batches, c, promptHash, source, ids.length, state, phaseInfo, (err: any) => {
          if (isQuotaOrAuthError(err)) quotaOrAuthDrop = true;
          return --alive;
        })),
    );
    if (batches.length > 0) {
      const abandoned = batches.reduce((n, b) => n + b.length, 0);
      const hint = quotaOrAuthDrop
        ? ' — a leg was refused for quota/credit/auth; check the provider credit balance, spend cap, or API key'
        : '';
      logEvent('warning', `All LLM legs dropped — ${abandoned} tracks left for next run${hint}`);
    }
  }
  return { tagged: state.tagged, callCount: state.callCount, byLeg: state.byLeg };
}

// Decide the LLM consumers for this run. Dual-LLM mode activates automatically
// when a fallback is configured, distinct from the primary, and its host answers
// a cheap probe — then both boxes tag in parallel off a shared queue. Otherwise a
// single failover-capable consumer (discussion #320).
export async function resolveTagConsumers(): Promise<TagConsumer[]> {
  const primary = primaryLeg();
  const fb = fallbackLeg();
  if (!fb) return [{ label: primary.label }];

  const sameHost =
    (primary.cfg.ollamaUrl || '') === (fb.cfg.ollamaUrl || '') &&
    (primary.cfg.baseUrl || '') === (fb.cfg.baseUrl || '');
  if (fb.label === primary.label && sameHost) {
    logEvent('info', 'Fallback LLM identical to primary — single-LLM mode');
    return [{ label: primary.label }];
  }

  if (!(await probeLegReachable(fb))) {
    logEvent('info', `Fallback LLM (${fb.label}) unreachable — single-LLM mode`);
    return [{ label: primary.label }];
  }

  logEvent('info', `Dual-LLM mode active: primary=${primary.label} + fallback=${fb.label}`);
  return [
    { pin: 'primary', label: primary.label },
    { pin: 'fallback', label: fb.label },
  ];
}

