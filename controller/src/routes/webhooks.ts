// Admin-gated webhook management. CRUD lives here; the fan-out itself lives
// in broadcast/webhooks.ts and reads its config from settings on each fire.
//
// Event payloads emitted by the fan-out:
//   track.play       { event, t, title, artist, album?, sourceTrackId?, source,
//                      requestedBy?, listeners? }
//                    (when webhooksPolicy.trackPlayListenerGated is on, only POSTs
//                     when listener count > 0 — fail-closed; `listeners` included)
//                    `sourceTrackId` is the music backend's own id (Subsonic/
//                    Navidrome), null when unknown; `source` is how the track got
//                    queued (auto | ai | request) — two different things.
//   dj.say           { event, t, text, kind, voiceId, channel, durationMs,
//                      airedAt?, estimated }        // kind is the original `announce` kind
//   dj.link          { event, t, text, kind, voiceId, channel, durationMs,
//                      airedAt?, estimated }
//   request.received { event, t, requestedBy, text }   // text is the listener's raw ask
//   voice.queued     { event, t, voiceId, kind, channel, text, durationMs,
//                      estimatedAirInMs, expectedAirAt, estimated (always true),
//                      streamBufferSeconds, personaId?, personaName? }
//   voice.start      { event, t, voiceId, kind, channel, text, durationMs,
//                      airedAt?, endsAt?, estimated, streamBufferSeconds,
//                      personaId?, personaName? }
//   voice.end        { event, t, voiceId, kind, channel, durationMs,
//                      airedAt?, endedAt?, estimated }
//
// All payloads carry `event` (one of the above) and `t` (ISO timestamp).
//
// TIMEBASE (#1382). The voice events fire when the words are actually AUDIBLE
// on the stream, not when the clip was handed to the mixer — `airedAt` is the
// live-edge moment they began, measured by Liquidsoap itself. Every listener is
// `streamBufferSeconds` behind that live edge for their whole connection
// (Icecast bursts already-broadcast audio on connect, #1114), so a consumer
// syncing to what people HEAR wants `airedAt + streamBufferSeconds`, and one
// driving an operator display wants `airedAt` as-is. `durationMs` is the clip's
// own measured length, so [airedAt, airedAt + durationMs] is the speech window.
//
// `airedAt` is the first WORD. The mixer pushes a short silent lead-in ahead of
// every clip so the music has finished ducking before the DJ speaks, so the duck
// itself begins up to a second earlier — measured 0.795s on the bundled
// leadin.wav. Anything mirroring the duck (rather than the words) should allow
// for that head.
//
// `estimated: true` means the station could not measure the air time (a mixer
// that predates the voice marker, or a clip that never aired); `airedAt`/
// `endsAt`/`endedAt` are then ABSENT rather than guessed, and `t` is the best
// available approximation. Treat a missing field as unknown, never as zero.
//
// voice.queued is the one event in the set that is a FORECAST by nature, and it
// carries `estimated: true` for exactly that reason. It fires when the station
// commits to a clip — before the serialiser queue, the mixer poll and the
// lead-in — so a consumer can PREPARE for speech (hand back from a call, close
// a reply gate, start a ramp) instead of reacting once the words are already
// out. `estimatedAirInMs` is roughly how long it has; `expectedAirAt` is the
// same figure as a timestamp. Neither is measured, and neither is corrected
// afterwards: voice.start is the measurement, and a consumer that needs the
// truth waits for it. Note there is no `airedAt` on this event — a field named
// for a measurement never carries a guess.
//
// The lifecycle, all three paired by `voiceId`:
//   voice.queued  → it is going to speak
//   voice.start   → it is speaking (measured)
//   voice.end     → it stopped
//
// The early warning is as long as the wait happens to be: a clip landing behind
// another segment gets many seconds, one landing on an idle chain gets ~1s. It
// is a head start, never a guarantee.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as settings from '../settings.js';
import { WEBHOOK_EVENTS, fireTest } from '../broadcast/webhooks.js';
import { webhooksPatchSchema } from '../schemas/webhook.js';

export const router = express.Router();

router.get('/webhooks', requireAdmin, async (req, res) => {
  try {
    await settings.load();
    const s = settings.getRedacted();
    const policy = settings.get().webhooksPolicy || {};
    res.json({
      events: WEBHOOK_EVENTS,
      webhooks: s.webhooks || [],
      trackPlayListenerGated: !!policy.trackPlayListenerGated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/webhooks', requireAdmin, validateBody(webhooksPatchSchema), async (req, res) => {
  // The UI sends the whole list back. settings.update() validates the array
  // strictly and replaces it atomically — same pattern as personas/shows.
  // Both fields are optional so the gate toggle can save on its own without
  // re-submitting (and re-validating) the hook list, and vice versa.
  try {
    const patch: Record<string, unknown> = {};
    if (req.body?.webhooks !== undefined) {
      patch.webhooks = req.body.webhooks;
    }
    if (req.body?.trackPlayListenerGated !== undefined) {
      patch.webhooksPolicy = { trackPlayListenerGated: !!req.body.trackPlayListenerGated };
    }
    const r = await settings.update(patch);
    const policy = settings.get().webhooksPolicy || {};
    res.json({
      webhooks: settings.getRedacted().webhooks,
      trackPlayListenerGated: !!policy.trackPlayListenerGated,
      requiresRestart: r.requiresRestart,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Send a test payload to a single hook by id. Uses the live, non-redacted
// settings so the operator's saved authHeader actually goes out — they
// shouldn't have to retype it just to test the integration.
router.post('/webhooks/:id/test', requireAdmin, async (req, res) => {
  try {
    await settings.load();
    const hook = (settings.get().webhooks || []).find((h: any) => h.id === req.params.id);
    if (!hook) return res.status(404).json({ error: 'webhook not found' });
    await fireTest(hook);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
