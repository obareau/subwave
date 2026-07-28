// Opening, closing, backing up and resetting the database file. The only writer
// of the handle in handle.ts.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { DB_PATH, getDb, getEmbeddingDim, requireDb, setHandle } from './handle.js';
import { invalidateStats } from './stats.js';
import { migrate } from './schema.js';
import { maybeMigrateFromMoodsJson } from './legacy.js';

// ---------------------------------------------------------------------------
// Open + migrate
// ---------------------------------------------------------------------------

// `reseed` controls what happens when the DB's stored embedding dim no longer
// matches the requested one (the operator swapped embedding models). Without
// it, migrate() throws an instructive error — the safe default that protects a
// populated index. With it, migrate() drops the stale-dim vectors and rebuilds
// the table at the new dim so a re-embed run can refill it. The tagger passes
// `reseed` from its --reseed flag; the live controller passes it too so a model
// change self-heals instead of crashing (see music/library.ts). It is a no-op
// on the normal matching-dim path.
// `adoptStoredDim` (live controller) treats the dim already recorded in the DB
// as authoritative: the stored vectors win, and `embeddingDim` is only the
// fallback used when the DB has never been tagged. This stops the runtime from
// wiping a tagged index just because the model *name* maps to a different
// default than the dim the tagger actually probed (#319). The tagger leaves it
// off so a deliberate model swap still surfaces the --reseed gate.
export async function open(opts: {
  embeddingDim: number;
  reseed?: boolean;
  adoptStoredDim?: boolean;
}): Promise<void> {
  if (getDb()) {
    if (!opts.adoptStoredDim && opts.embeddingDim !== getEmbeddingDim()) {
      throw new Error(
        `library-db already open with embedding dim ${getEmbeddingDim()}; ` +
          `caller asked for ${opts.embeddingDim}. Use --reseed to switch models.`,
      );
    }
    return;
  }
  const db = new Database(DB_PATH);
  setHandle({
    db,
    embeddingDim: opts.embeddingDim,
    nonce: randomUUID().slice(0, 8),
  });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Cap the -wal sidecar: after any checkpoint SQLite truncates it back to this
  // size instead of leaving it at its high-water mark. Without it a bulk write
  // pass (acoustic analysis, tagging) balloons the WAL to hundreds of MB — 2.4×
  // the DB itself in #786 — and every later query walks that giant WAL on
  // better-sqlite3's synchronous thread, stalling the whole event loop.
  db.pragma('journal_size_limit = 67108864'); // 64 MiB
  sqliteVec.load(db);

  // migrate() may adopt the stored dim; trust its return as the live schema dim.
  setHandle({
    embeddingDim: await migrate(
      opts.embeddingDim,
      opts.reseed === true,
      opts.adoptStoredDim === true,
    ),
  });
  await maybeMigrateFromMoodsJson();
}

export function close(): void {
  const db = getDb();
  if (db) {
    // Fold the WAL back into the main DB file before closing. SQLite only
    // auto-checkpoints on the LAST connection to close, and the controller,
    // tagger and analyzer can hold the DB concurrently — so an explicit
    // best-effort TRUNCATE here is what keeps the sidecar from surviving
    // (and regrowing across) restarts. Synchronous, so it also runs safely
    // from a process 'exit' hook.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* busy/readonly — the hourly checkpoint or next close gets it */
    }
    db.close();
    setHandle({ db: null, embeddingDim: null });
    // reload()/restoreFromFile() both drop the handle through here, so a
    // reopened (possibly restored-from-backup) library never serves the
    // previous handle's cached tallies.
    invalidateStats();
  }
}

export function isOpen(): boolean {
  return getDb() !== null;
}

// Best-effort PRAGMA wal_checkpoint(TRUNCATE): fold the WAL into the main DB
// file and truncate the sidecar to zero. Returns what SQLite reports — busy=1
// means a concurrent reader/writer kept the checkpoint from completing (fine;
// the next run catches up) — or null when the DB isn't open. Called after bulk
// passes and hourly from the scheduler so the WAL can never balloon unbounded
// again (#786).
export function checkpointWal(): { busy: number; log: number; checkpointed: number } | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    return row?.[0] ?? null;
  } catch {
    return null;
  }
}

// Write a consistent, single-file copy of the live DB to `destPath`. Uses
// better-sqlite3's online backup API so the result is coherent even though the
// DB runs in WAL mode (a raw file copy could miss un-checkpointed pages in the
// -wal sidecar). Used by the backup/export route.
export async function backup(destPath: string): Promise<void> {
  await requireDb().backup(destPath);
}

// Replace the on-disk DB with the file at `srcPath` (a previously-exported
// backup). Closes the live handle first, swaps the file, and clears any stale
// WAL/SHM sidecars so the next open() reads the restored data cleanly. The
// caller is responsible for reopening (see music/library.ts:reload()).
export async function restoreFromFile(srcPath: string): Promise<void> {
  close();
  await copyFile(srcPath, DB_PATH);
  await rm(`${DB_PATH}-wal`, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
}

// Delete the entire on-disk DB — every track row, mood/energy tag, text +
// audio embedding, acoustic-analysis column, and enrichment cache — plus the
// WAL/SHM sidecars, so the next open() recreates an empty schema from scratch.
// Mirrors restoreFromFile()'s close→swap-file→drop-sidecars shape, and like it
// leaves the reopen to the caller (music/library.ts:reset()). This is the
// "start fresh" wipe behind the admin library Reset action — irreversible short
// of restoring a backup.
export async function reset(): Promise<void> {
  close();
  await rm(DB_PATH, { force: true });
  await rm(`${DB_PATH}-wal`, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
}


