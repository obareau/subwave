// Pins the bounded archive-retention default and its keep-forever upgrade
// guard (settings/normalize.ts normalizeArchiveRetentionDays).
//
// History: archive.retentionDays defaulted to 0 (keep forever), so operators
// who enabled hourly archiving grew ~1.4 GB/day until the disk filled — the
// 99 GB state/archive Discord report. The default is now 30 days, but it must
// NOT reach installs that were already archiving under keep-forever: for them
// an upgrade would silently start deleting tapes they may be keeping on
// purpose. Two properties are load-bearing:
//
//  - A stored integer ≥ 0 always wins — explicit 0 stays keep-forever.
//  - No stored value + archive.enabled === true resolves to 0 (legacy
//    preserved); any other blob (fresh install, archive off) resolves to 30.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load()/update() touch nothing real — hence the dynamic imports.
// Scenarios rewrite settings.json and reset the store cache between loads.
// node:assert-via-tsx style, matching scripts/house-rules.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-archret-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');

const SETTINGS_PATH = join(root, 'settings.json');

async function loadBlob(blob: unknown) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(blob));
  store.setCache(null);
  await settings.load();
  return settings.get().archive;
}

try {
  // ── Fresh install: no settings.json at all → bounded default ─────────────
  store.setCache(null);
  await settings.load();
  assert.equal(settings.get().archive.enabled, false, 'fresh: archive off');
  assert.equal(settings.get().archive.retentionDays, 30, 'fresh: bounded default');

  // ── Upgrade guard: legacy enabled archive, no stored retention → 0 ───────
  let a = await loadBlob({ archive: { enabled: true, bitrate: 128 } });
  assert.equal(a.retentionDays, 0, 'legacy enabled archive keeps keep-forever');

  // ── Archive off, no stored retention → bounded default ───────────────────
  a = await loadBlob({ archive: { enabled: false } });
  assert.equal(a.retentionDays, 30, 'archive off gets the bounded default');

  // ── Stored values always win, 0 included ─────────────────────────────────
  a = await loadBlob({ archive: { enabled: true, retentionDays: 7 } });
  assert.equal(a.retentionDays, 7, 'stored window preserved');
  a = await loadBlob({ archive: { enabled: false, retentionDays: 0 } });
  assert.equal(a.retentionDays, 0, 'explicit 0 preserved even with archive off');

  // ── Junk falls through the same fork as absent ───────────────────────────
  a = await loadBlob({ archive: { enabled: true, retentionDays: -5 } });
  assert.equal(a.retentionDays, 0, 'junk value + enabled → keep-forever guard');
  a = await loadBlob({ archive: { enabled: false, retentionDays: 'x' } });
  assert.equal(a.retentionDays, 30, 'junk value + disabled → bounded default');

  // ── update(): enabling archiving later inherits the resolved default ─────
  await loadBlob({});
  await settings.update({ archive: { enabled: true } });
  assert.equal(settings.get().archive.retentionDays, 30, 'enable keeps resolved 30');
  // Explicit opt-out to keep-forever persists across a reload — update()
  // stores the 0, so the load-path guard never reinterprets it.
  await settings.update({ archive: { retentionDays: 0 } });
  assert.equal(settings.get().archive.retentionDays, 0, 'explicit keep-forever accepted');
  store.setCache(null);
  await settings.load();
  assert.equal(settings.get().archive.retentionDays, 0, 'explicit keep-forever survives reload');

  console.log('archive-retention: all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
