// Station actions rather than settings reads/writes: bouncing the mixer,
// starting and stopping the stream, forcing a pick, the theme registry, and
// the SearXNG reachability probe.
//
// Part of the settings/ route split - see ../settings.ts.

import express from 'express';
import { queue } from '../../broadcast/queue.js';
import { restartLiquidsoap, startStream, stopStream } from '../../broadcast/liquidsoap-control.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  clearUserThemeCache,
  loadUserThemes,
  listThemesAnnotated,
  saveUserTheme,
  deleteUserTheme,
} from '../../themes.js';
import { fetchWithTimeout } from '../../util/fetch-timeout.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// ---------------------------------------------------------------------------
// POST /restart-mixer — telnet → Liquidsoap → shutdown → container restart
// Brief gap of dead air covered by Icecast burst buffer + emergency.mp3.
// ---------------------------------------------------------------------------
router.post('/restart-mixer', requireAdmin, async (req, res) => {
  try {
    await restartLiquidsoap();
    queue.log('scheduler', 'mixer restart requested');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /stream-stop — take the station off air by stopping the Icecast output.
// The mixer process keeps running; the /stream.mp3 mount disconnects.
// ---------------------------------------------------------------------------
router.post('/stream-stop', requireAdmin, async (req, res) => {
  try {
    await stopStream();
    queue.log('scheduler', 'stream stopped — off air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /stream-start — bring the station back on air (reconnect Icecast output)
// ---------------------------------------------------------------------------
router.post('/stream-start', requireAdmin, async (req, res) => {
  try {
    await startStream();
    queue.log('scheduler', 'stream started — on air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /auto-pick — toggle whether the LLM picks the next track
// Body: { "on": true | false }
// ---------------------------------------------------------------------------
router.post('/auto-pick', requireAdmin, express.json(), (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoPick = req.body.on;
  queue.log('scheduler', `auto-pick ${queue.autoPick ? 'enabled' : 'disabled'}`);
  res.json({ autoPick: queue.autoPick });
});

// ---------------------------------------------------------------------------
// POST /themes/refresh — re-scan ${STATE_DIR}/themes/. Use after dropping a
// new JSON in there to pick it up without bouncing the controller. Returns
// the freshly-listed registry so the admin UI can render it immediately.
// ---------------------------------------------------------------------------
router.post('/themes/refresh', requireAdmin, async (req, res) => {
  try {
    clearUserThemeCache();
    await loadUserThemes(true);
    const themes = await listThemesAnnotated();
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /themes — create/overwrite a user theme as ${STATE_DIR}/themes/<id>.json.
// Body: { id?, name, description?, mode, tokens }. The id is derived from the
// name when absent. Validated by the shared ThemeSchema (token security regex);
// reserved built-in ids are rejected. Returns the refreshed registry.
// ---------------------------------------------------------------------------
router.post('/themes', requireAdmin, async (req, res) => {
  try {
    const themes = await saveUserTheme(req.body || {});
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /themes/:id — remove a user theme file from ${STATE_DIR}/themes/.
// Built-in ids are reserved and rejected. The admin UI reassigns the active
// theme when it deletes the one in use, so this route only touches the file.
// Returns the refreshed registry.
// ---------------------------------------------------------------------------
router.delete('/themes/:id', requireAdmin, async (req, res) => {
  try {
    const themes = await deleteUserTheme(req.params.id);
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings/search/test-searxng — verifies the supplied SearXNG instance
// answers a JSON query. Used by the admin UI's "Test" button so the operator
// gets immediate feedback instead of waiting for a segment tick to fail.
// Body { baseUrl: string }. Does not persist anything.
// ---------------------------------------------------------------------------
// Intentionally permits RFC-1918 targets — SearXNG is typically on the homelab LAN.
router.post('/settings/search/test-searxng', requireAdmin, async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl || '').trim();
    if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl required' });
    if (!/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ ok: false, error: 'baseUrl must start with http:// or https://' });
    }

    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', 'subwave connectivity probe');
    url.searchParams.set('format', 'json');

    const r = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'SUB-WAVE radio controller (probe)' },
      timeoutMs: 8000,
    });

    if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status}` });
    const data = (await r.json()) as { results?: unknown };
    const count = Array.isArray(data?.results) ? (data.results as unknown[]).length : 0;
    return res.json({ ok: true, results: count });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string } | null | undefined;
    const msg = e?.name === 'AbortError' ? 'request timed out after 8s' : e?.message || 'fetch failed';
    return res.json({ ok: false, error: msg });
  }
});

