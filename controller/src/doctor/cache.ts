// Last-run cache. The admin panel hydrates from this on mount and the header
// badges station health from it, so a report survives navigation and a restart
// without forcing an immediate re-run. Deterministic data only (counts, plus DJ
// Doc's verdict once a review has run). Best-effort disk mirror under STATE_DIR;
// never throws into a check path.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { readFile, writeFile } from 'node:fs/promises';
import { STATE_DIR } from '../config.js';
import type { DoctorReport, DoctorReview } from './types.js';

// ---------------------------------------------------------------------------
// Last-run cache — the panel hydrates from this on mount and the admin header
// badges station health from it, so a report survives navigation and a restart
// without forcing an immediate re-run. Deterministic data only (counts + DJ
// Doc's verdict when a review has run). Best-effort disk mirror under STATE_DIR;
// never throws into a check path.
// ---------------------------------------------------------------------------

const CACHE_FILE = `${STATE_DIR}/doctor-last.json`;

interface DoctorCache {
  report: DoctorReport | null;
  review: DoctorReview | null;
}

let cache: DoctorCache = { report: null, review: null };
let cacheLoaded = false;

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      cache = { report: parsed.report ?? null, review: parsed.review ?? null };
    }
  } catch { /* no prior run persisted — fine */ }
}

function persistCache(): void {
  // Fire-and-forget: the in-memory cache is the source of truth for this
  // session; the disk mirror only bootstraps the next boot.
  writeFile(CACHE_FILE, JSON.stringify(cache)).catch(() => {});
}

export function rememberReport(report: DoctorReport): void {
  cacheLoaded = true; // a fresh run supersedes anything still on disk
  // A new report describes a new moment — the old review no longer matches it.
  cache = { report, review: null };
  persistCache();
}

export function rememberReview(review: DoctorReview): void {
  if (!cache.report) return; // a review with no report to attach to is meaningless
  cache = { ...cache, review };
  persistCache();
}

// Derive a headline verdict from the counts alone — used for the header badge
// when no LLM review has run (runDoctor is LLM-free). A real review's `overall`
// takes precedence when present.
function derivedOverall(counts: DoctorReport['counts']): 'healthy' | 'attention' | 'critical' {
  if (counts.fail > 0) return 'critical';
  if (counts.warn > 0) return 'attention';
  return 'healthy';
}

interface DoctorSummary {
  t: string | null;
  counts: DoctorReport['counts'] | null;
  overall: 'healthy' | 'attention' | 'critical' | null;
}

// Compact health headline for the admin header badge — no section detail.
export async function lastSummary(): Promise<DoctorSummary> {
  await ensureCacheLoaded();
  const r = cache.report;
  if (!r) return { t: null, counts: null, overall: null };
  const overall =
    cache.review?.available && cache.review.overall ? cache.review.overall : derivedOverall(r.counts);
  return { t: r.t, counts: r.counts, overall };
}

// Full last-run payload for the panel to hydrate from on mount.
export async function lastRun(): Promise<DoctorCache> {
  await ensureCacheLoaded();
  return cache;
}

// Wrap a check so a thrown error becomes a single fail finding rather than
// aborting runDoctor.

