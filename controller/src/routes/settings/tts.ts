// Voice preview and the voice catalogue for the on-air engines.
//
// Part of the settings/ route split - see ../settings.ts.

import express from 'express';
import { readFile, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import * as settings from '../../settings.js';
import * as tts from '../../audio/tts.js';
import * as speech from '../../llm/speech.js';
import { requireAdmin } from '../../middleware/auth.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// ---------------------------------------------------------------------------
// POST /settings/tts/preview — synthesize a short sample in an EXPLICIT engine +
// voice (not the on-air persona) so the admin "Play sample" button can audition
// a voice/speed before saving. Body: { engine, voice?, cloudProvider?, speed?,
// lang?, language?, text?, voiceSettings? } — `language` is the persona's
// free-text on-air language; when set (and no explicit text), the sample
// sentence is rendered in that language. voiceSettings carries UNSAVED ElevenLabs
// slider values (issue #696) so the operator can tune the expressive knobs by
// ear before saving; synthesizeSample clamps them like settings.update() does.
// On success streams the rendered WAV (audio/wav). On a synth
// failure — e.g. the tts-heavy sidecar is down or no cloud key — returns 422
// with { ok, message } instead of silently falling back to Piper, so the
// operator sees why. The temp WAV is unlinked once sent.
// ---------------------------------------------------------------------------
router.post('/settings/tts/preview', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const engine = typeof body.engine === 'string' ? body.engine : '';
  if (!engine || !tts.ENGINES.includes(engine)) {
    return res.status(400).json({ ok: false, message: `Unknown engine: ${engine || '(none)'}` });
  }
  let filePath: string | null = null;
  try {
    filePath = await tts.synthesizeSample({
      engine,
      voice: typeof body.voice === 'string' ? body.voice : '',
      cloudProvider: typeof body.cloudProvider === 'string' ? body.cloudProvider : 'openai',
      speed: typeof body.speed === 'number' ? body.speed : undefined,
      lang: typeof body.lang === 'string' ? body.lang : undefined,
      language: typeof body.language === 'string' ? body.language : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      voiceSettings: (body.voiceSettings && typeof body.voiceSettings === 'object')
        ? body.voiceSettings
        : undefined,
    });
    const buf = await readFile(filePath);
    // Local engines render WAV; cloud (ElevenLabs) renders MP3. Set the type
    // from the actual extension so the browser <audio> gets the right MIME.
    res.type(extname(filePath) || '.wav').send(buf);
  } catch (err: unknown) {
    res.status(422).json({ ok: false, message: (err as { message?: string })?.message || 'Preview synthesis failed' });
  } finally {
    if (filePath) unlink(filePath).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// GET /settings/tts/voices — discover the voices a cloud TTS provider offers,
// so persona + station-default voice fields can be a dropdown instead of a
// free-text box the operator fills from memory. The TTS twin of
// /settings/llm/models.
//
// Two discoverable providers: `openai-compatible` (probes a few conventional
// paths on the operator's own server — /v1/audio/voices isn't in the OpenAI
// spec, so there's no single right answer) and `elevenlabs` (a real API, and
// the one that matters most since cloned voices can never be hardcoded).
// `openai` publishes no list endpoint; its curated UI list is already complete.
//
// `baseUrl` rides in on the query so the operator can discover against a URL
// they've typed but not yet saved — same affordance the model dropdown gives.
// The API key deliberately does NOT: it's read from saved config, so it can't
// leak into access logs or browser history. ElevenLabs discovery therefore
// only works once the key is saved, which the UI gates on.
//
// Always 200s with { ok, voices, provider, error? } — an unreachable server is
// a normal answer, and the UI falls back to the free-text input.
// ---------------------------------------------------------------------------
router.get('/settings/tts/voices', requireAdmin, async (req, res) => {
  const provider = String(req.query.provider || '').trim();
  if (!provider) {
    return res.json({ ok: false, voices: [], provider: '', error: 'provider is required' });
  }
  const baseUrl = String(req.query.baseUrl || '').trim();
  await settings.load();
  const cloud = settings.get().tts?.cloud || {};

  // Same precedence as cloud-speech.isConfigured(): a key typed into Settings
  // counts only for the provider it was entered against, otherwise fall back
  // to that provider's env var from state/secrets.env.
  const envKey = provider === 'elevenlabs'
    ? process.env.ELEVENLABS_API_KEY
    : process.env.OPENAI_API_KEY;
  const settingsKey = provider === cloud.provider ? cloud.apiKey : '';
  const apiKey = (settingsKey || envKey || '').trim();

  // Backstop only — listVoices runs its own per-provider budget (10s managed,
  // 8s across the compat probe). Sits above both so the inner deadline is what
  // actually fires and the caller gets a real reason instead of a bare abort.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const result = await speech.listVoices({
      provider,
      // Fall back to the saved baseUrl so a persona card can discover without
      // re-sending the station-wide server URL.
      baseUrl: baseUrl || cloud.baseUrl || '',
      apiKey,
      signal: ctrl.signal,
    });
    res.json({ ...result, provider });
  } finally {
    clearTimeout(timer);
  }
});


