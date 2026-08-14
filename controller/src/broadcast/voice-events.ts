// Outbound signalling for one spoken segment (#1382).
//
// ONE place decides what the world is told about a piece of DJ speech, because
// there are four call sites that air one (announce, announceExchange,
// airPendingVoice, airIntro) and they used to each inline their own
// webhooks.notify — which is how they drifted into publishing three different
// subsets of the same event.
//
// Timebase is the thing to get right here, and there are two of them:
//
//   * `airedAt` is the LIVE EDGE — the moment the words leave the mixer, taken
//     from radio.liq's own clock via the voice marker. Operator surfaces want
//     this one.
//   * A listener is `streamBufferSeconds` behind that for their whole
//     connection (Icecast bursts already-broadcast audio on connect, #1114), so
//     anything syncing to what a LISTENER hears wants airedAt + that offset.
//     It rides the payload precisely so a consumer doesn't have to go and fetch
//     /now-playing to find it.
//
// When the air time can't be known — a mixer too old to write markers, or a
// clip that never made it out of the queue — `estimated: true` says so and the
// timestamps are omitted rather than guessed. An absent field is a consumer's
// cue to fall back to `t`; a fabricated one is a consumer silently believing a
// number nobody measured.

import * as settings from '../settings.js';
import * as webhooks from './webhooks.js';

export interface SpokenSegment {
  /** Correlation id shared by this segment's voice.start / voice.end / dj.* . */
  voiceId: string;
  /** The `announce` kind — 'link', 'station-id', 'hourly-check', 'banter', … */
  kind: string;
  /** Which mixer channel carried it: 'intro' = light duck (the song stays up
   *  under the voice), 'say' = heavy duck. Passed by the caller, never derived
   *  from `kind` — a deferred ident is a 'station-id' that deliberately airs on
   *  the INTRO channel because it lands at a track boundary
   *  (announceAtNextTrack), so kind alone would report the wrong one. */
  channel: 'say' | 'intro';
  text: string;
  /** The clip's own length in ms (no lead-in/tail padding). */
  durationMs: number;
  /** Live-edge epoch ms, or null when the station couldn't measure it. */
  airedAt: number | null;
  personaId?: string | null;
  personaName?: string | null;
  /** Whether to also fire the legacy dj.say/dj.link event. Off for a banter
   *  line: that exchange fires ONE aggregate dj.say for the whole conversation
   *  (five separate segments is not what a Discord relay wants), while
   *  voice.start/voice.end stay per line — a ducking consumer needs each real
   *  speech window, which is the entire point of the new pair. */
  legacy?: boolean;
}

// What is known BEFORE a segment airs: the identity it will carry, plus a
// forecast of how long the wait is. Fired the moment the station commits to
// speaking, so a consumer can prepare (close a reply gate, hand back from a
// caller, start a duck ramp) rather than react after the first words are out.
export interface QueuedSegment {
  /** The same id the eventual voice.start / voice.end carry. */
  voiceId: string;
  kind: string;
  channel: 'say' | 'intro';
  text: string;
  durationMs: number;
  /** Rough ms until the first word. A forecast, never a measurement — see below. */
  estimatedAirInMs: number;
  personaId?: string | null;
  personaName?: string | null;
}

// A clip can't outrun the voice serialiser's own hold, so neither can the
// voice.end timer. Guards against a mangled WAV header parking a timer hours out.
const MAX_SEGMENT_MS = 90_000;

function bufferSeconds(): number {
  try {
    const s = settings.get() as { stream?: { bufferSeconds?: number } } | null;
    const n = Number(s?.stream?.bufferSeconds);
    return Number.isFinite(n) ? n : 22;
  } catch {
    return 22;
  }
}

// The early half of the lifecycle: voice.queued → voice.start → voice.end, all
// three paired by `voiceId`.
//
// This one fires when the station COMMITS to a clip — the rendered WAV joins
// the voice serialiser — which is before the queue wait, the mixer's poll and
// the silent lead-in. That is the whole point: a consumer that only learns of
// speech from voice.start learns at the moment the words are already audible,
// which is too late to hand over gracefully or to start a duck ramp. Anything
// syncing to the audio still keys off voice.start/voice.end; this is for
// getting ready.
//
// `estimatedAirInMs` is a FORECAST and is never anything else. The wait it
// measures is mostly the serialiser's own hold, which is known, but the mixer
// poll and the handoff write are not, and a jingle can extend it. `expectedAirAt`
// is the same figure as a timestamp, for convenience. `estimated: true` says the
// same thing the other two events say when they can't measure: do not treat
// these as observations. There is deliberately no `airedAt` here — a field
// named for a measurement must never carry a guess.
export function notifyQueued(seg: QueuedSegment): void {
  const durationMs = Math.max(0, Math.min(MAX_SEGMENT_MS, Math.round(seg.durationMs) || 0));
  const estimatedAirInMs = Math.max(0, Math.round(seg.estimatedAirInMs) || 0);
  webhooks.notify('voice.queued', {
    voiceId: seg.voiceId,
    kind: seg.kind,
    channel: seg.channel,
    text: seg.text,
    durationMs,
    estimatedAirInMs,
    expectedAirAt: new Date(Date.now() + estimatedAirInMs).toISOString(),
    estimated: true,
    // Same reason it rides voice.start: a consumer syncing to what LISTENERS
    // hear (rather than to the live edge) needs the offset, and shouldn't have
    // to go and fetch /now-playing for it (#1114).
    streamBufferSeconds: bufferSeconds(),
    ...(seg.personaId ? { personaId: seg.personaId } : {}),
    ...(seg.personaName ? { personaName: seg.personaName } : {}),
  });
}

// Fire everything one segment owes the outside world:
//   voice.start        — now, stamped with the real air time when known
//   dj.say / dj.link   — the pre-existing events, unchanged in shape but now
//                        carrying duration + air time, and fired at AIR rather
//                        than at handoff
//   voice.end          — scheduled for the end of the speech
//
// Fire-and-forget like the fan-out underneath it; nothing here is awaited by a
// caller on the air path.
export function notifySpoken(seg: SpokenSegment): void {
  const channel = seg.channel;
  const durationMs = Math.max(0, Math.min(MAX_SEGMENT_MS, Math.round(seg.durationMs) || 0));
  const estimated = seg.airedAt == null;
  const endsAtMs = seg.airedAt != null ? seg.airedAt + durationMs : null;

  const identity = {
    voiceId: seg.voiceId,
    kind: seg.kind,
    channel,
    durationMs,
    // Omitted rather than nulled when unknown — see the header.
    ...(seg.airedAt != null ? { airedAt: new Date(seg.airedAt).toISOString() } : {}),
    estimated,
  };

  webhooks.notify('voice.start', {
    ...identity,
    text: seg.text,
    ...(endsAtMs != null ? { endsAt: new Date(endsAtMs).toISOString() } : {}),
    // The listener's own offset from the live edge, so a consumer syncing to
    // what people HEAR doesn't have to go and look it up (#1114).
    streamBufferSeconds: bufferSeconds(),
    ...(seg.personaId ? { personaId: seg.personaId } : {}),
    ...(seg.personaName ? { personaName: seg.personaName } : {}),
  });

  // The original pair, kept for every relay already subscribed to them. `text`
  // (and, on dj.say, `kind`) stay exactly where they were; everything else is
  // additive, including `kind` now also riding dj.link — a field appearing is
  // something a relay ignores, where a field moving is one that breaks.
  if (seg.legacy !== false) {
    webhooks.notify(seg.kind === 'link' ? 'dj.link' : 'dj.say', { text: seg.text, ...identity });
  }

  const delay = endsAtMs != null ? Math.max(0, endsAtMs - Date.now()) : durationMs;
  const timer = setTimeout(() => {
    webhooks.notify('voice.end', {
      ...identity,
      ...(endsAtMs != null ? { endedAt: new Date(endsAtMs).toISOString() } : {}),
    });
  }, Math.min(MAX_SEGMENT_MS, delay));
  // A pending end-of-speech ping must never hold the process open.
  timer.unref?.();
}
