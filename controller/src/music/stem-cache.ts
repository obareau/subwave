// Stem cache (feature: stem-blend transitions) — per-track Demucs stem
// windows persisted by the analyzer worker (head 40s + tail 20s, 4 FLACs
// each) under `<stateDir>/stems/<trackId>/`, so a transition render is a
// fast mix of cached stems instead of a fresh separation inside the drain
// deadline. The controller owns the LIFECYCLE (this module: paths, presence
// checks, byte-budget LRU sweep); the analyzer owns the WRITES
// (analyze_worker.py write_stems — the same shared volume).

import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';

export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemWindow = 'head' | 'tail';

export function stemsRoot(): string {
  return path.join(config.stateDir, 'stems');
}

export function dirFor(trackId: string): string {
  // Track ids are Navidrome UUID-ish tokens; guard the join anyway so a
  // hostile id can never escape the cache root.
  return path.join(stemsRoot(), path.basename(String(trackId)));
}

export function stemPath(trackId: string, window: StemWindow, stem: string): string {
  return path.join(dirFor(trackId), `${window}-${stem}.flac`);
}

// Whether a track has a complete stem set for the given window. The render
// op is cache-hit-only, so "all four present" is the eligibility fact. The
// tail window also needs its alignment sidecar (tail-meta.json — the decoded
// duration + exact tail offset the stems were cut at): the render slices the
// bar grid against that offset, and stems cached before the sidecar existed
// would misalign by the tagged-vs-decoded duration gap, so they count as a
// miss until a re-analysis refreshes them.
export async function hasWindow(trackId: string, window: StemWindow): Promise<boolean> {
  try {
    const files = STEM_NAMES.map(s => stemPath(trackId, window, s));
    if (window === 'tail') files.push(path.join(dirFor(trackId), 'tail-meta.json'));
    const checks = await Promise.all(
      files.map(f => stat(f).then(st => st.size > 0, () => false)),
    );
    return checks.every(Boolean);
  } catch {
    return false;
  }
}

// The operator's byte budget (settings.audio.stemCacheGb), floored at 1 GB so
// a corrupt/zero setting can't collapse the cache to nothing.
export function budgetBytes(): number {
  return Math.max(1, Number(settings.get()?.audio?.stemCacheGb) || 15) * 1024 ** 3;
}

// Rough on-disk cost of one track's cached stem set (head 40s + tail 20s, four
// FLACs each) — the ~25 MB the admin UI quotes. Only used to SIZE a backfill,
// never to account for real usage (that walks the dirs), so an approximation
// is fine: being a few MB out changes how many tracks a night targets, nothing
// that can corrupt the cache.
export const APPROX_TRACK_BYTES = 25 * 1024 ** 2;

// One walk of the cache root -> per-dir bytes + newest mtime. Shared by the
// sweep and the usage report so the two can never disagree about what's on
// disk. ENOENT-tolerant throughout: the analyzer may be writing a dir while we
// scan.
async function scanDirs(): Promise<Array<{ dir: string; bytes: number; mtimeMs: number }>> {
  let entries: string[];
  try {
    entries = await readdir(stemsRoot());
  } catch {
    return []; // no cache dir yet
  }
  const dirs: Array<{ dir: string; bytes: number; mtimeMs: number }> = [];
  for (const name of entries) {
    const dir = path.join(stemsRoot(), name);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      let bytes = 0;
      let mtimeMs = 0;
      for (const f of await readdir(dir)) {
        try {
          const fst = await stat(path.join(dir, f));
          bytes += fst.size;
          if (fst.mtimeMs > mtimeMs) mtimeMs = fst.mtimeMs;
        } catch { /* file vanished mid-scan */ }
      }
      dirs.push({ dir, bytes, mtimeMs });
    } catch { /* dir vanished mid-scan */ }
  }
  return dirs;
}

export async function usageBytes(): Promise<number> {
  return (await scanDirs()).reduce((n, d) => n + d.bytes, 0);
}

// How many track dirs are on disk RIGHT NOW — the doctor's coverage number.
// Deliberately distinct from library-db's stemsCachedCount(): stems_at stamps
// ATTEMPTS (and must, for the backfill scope to converge), so once the sweep
// has evicted anything — or a separation failed — the stamp count overstates
// what a blend can actually hit. This counts hittable dirs instead.
export async function cachedTrackCount(): Promise<number> {
  return (await scanDirs()).length;
}

// How many more tracks the budget can hold, approximately. The stem backfill
// caps its scope at this: separating thousands of tracks the sweep will evict
// minutes later is hours of Demucs time for nothing, which is what made the
// feature look broken on a library bigger than the budget ("it will only ever
// cache the last 600 songs"). 0 = cache full, so the backfill stands down and
// says so rather than churning.
// `budget` defaults to the operator's setting; an explicit value mirrors
// sweep(budget) so the two can be reasoned about (and tested) together.
export async function headroomTracks(budget = budgetBytes()): Promise<number> {
  const free = budget - (await usageBytes());
  return free <= 0 ? 0 : Math.floor(free / APPROX_TRACK_BYTES);
}

// Byte-budget LRU sweep: newest track-dirs (by max file mtime — a re-analysis
// refreshes a dir's slot) are kept, oldest evicted until the cache fits the
// operator's budget (settings.audio.stemCacheGb). No existing LRU utility in
// the repo — byte accounting follows archives.pruneOlderThan, the sweep shape
// follows piper.cleanupOldVoices.
export async function sweep(budget = budgetBytes()): Promise<{ removed: number; freedBytes: number }> {
  const dirs = await scanDirs();
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) return { removed: 0, freedBytes: 0 };

  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let removed = 0;
  let freedBytes = 0;
  for (const d of dirs) {
    if (total <= budget) break;
    try {
      await rm(d.dir, { recursive: true, force: true });
      total -= d.bytes;
      freedBytes += d.bytes;
      removed += 1;
    } catch { /* best-effort — retry next sweep */ }
  }
  return { removed, freedBytes };
}
