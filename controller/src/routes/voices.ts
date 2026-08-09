// Admin-gated voice-clone library management — the reference WAVs Chatterbox
// and PocketTTS clone from (a persona's `tts.voice` is one of these filenames).
//
// Mirrors routes/sfx.ts's import flow, minus the generate half: there is no
// prompt-to-voice generator, only operator-supplied recordings. Dropping files
// into state/voices/ on the host still works and is still listed here — this
// just removes the need to.
import express from 'express';
import * as voices from '../audio/voice-library.js';
import { config } from '../config.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { validateBody } from '../middleware/validate.js';
import { voiceImportSchema } from '../schemas/imaging.js';
import { audioContentType, hasFfmpeg } from '../audio/audio-import.js';

export const router = express.Router();

// `dir` rides along so the UI can name the host folder in its hint, and
// `ffmpeg` so it can warn up-front that only .wav will be accepted (a bare-host
// dev box rather than any Docker image).
router.get('/voices', requireAdmin, async (req, res) => {
  try {
    res.json({
      voices: await voices.list(),
      dir: config.voices.dir,
      legacyDir: config.voices.legacyDir,
      ffmpeg: await hasFfmpeg(),
      advisory: { minSec: voices.ADVISORY_MIN_SEC, maxSec: voices.ADVISORY_MAX_SEC },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import an operator-supplied clip (multipart `file`, `name`). Transcoded to
// the canonical mono 24 kHz WAV. Every rejection is a 400 with the module's
// message — they're all operator-fixable (bad type, duplicate name, no ffmpeg).
// validateBody AFTER audioUpload — multer parses the multipart body, the
// middleware replaces req.body only, req.file rides through untouched.
router.post('/voices/upload', requireAdmin, audioUpload('file'), validateBody(voiceImportSchema), async (req, res) => {
  const file = req.file;
  const { name } = req.body as { name: string };
  if (!file) return res.status(400).json({ error: 'file is required' });
  try {
    const created = await voices.importVoice(file.buffer, {
      name,
      originalName: file.originalname,
    });
    queue.log('scheduler', `Voice imported: "${created.file}"`);
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// No in-use guard by design: a persona pointing at a deleted file keeps the
// value visible with a `missing` hint, and the workers fall back to their
// built-in voice with a logged reason.
router.delete('/voices/:file', requireAdmin, async (req, res) => {
  try {
    res.json(await voices.removeVoice(req.params.file));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Audition the stored clip — hear what was uploaded without a TTS round-trip.
// `:file` is resolved through the library's scan (never interpolated into a
// path), so anything not currently listed is a 404 rather than a filesystem
// read.
router.get('/voices/:file/audio', requireAdmin, async (req, res) => {
  try {
    const entry = await voices.resolve(req.params.file);
    if (!entry) return res.status(404).json({ error: 'unknown voice' });
    res.type(audioContentType(entry.path)).sendFile(entry.path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
