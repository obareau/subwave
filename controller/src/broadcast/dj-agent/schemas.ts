// The pick and request output schemas, and the system prompts that go with
// them. The schema comments are load-bearing - read them before changing a
// field's nullability.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import { z } from 'zod';
import * as settings from '../../settings.js';
import * as session from '../session.js';
import * as dj from '../../llm/dj.js';
import { modelTolerant } from '../../llm/sdk.js';
import * as likes from '../likes.js';
import { autoVoiceAllowed } from '../voice-policy.js';


// Plain .nullable() fields, deliberately — GLM's malformed spellings of
// "nothing" (the string "null", an omitted key, a double-JSON-encoded object)
// are repaired by the modelTolerant wrapper in pickSchema() below, at the
// OBJECT level. Do not wrap individual fields in a preprocess: a per-field
// pipe drops that field from the tool inputSchema's `required` array (the AI
// SDK renders Zod with io:'input'), which invites every provider to omit it —
// see modelTolerant's comment in core/pure.ts.
export const PICK_SCHEMA = z.object({
  id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (new artist, a shift in energy/era/texture), not a vibe label you would recycle pick after pick (e.g. "new artist, lifts the energy", never a repeated "mellow reflective step")'),
  say: z.string().nullable().describe('when the latest event message says to write a spoken link, set this to one or two natural sentences in the DJ voice that INTRODUCE the track you are about to play — set it up, name the artist or capture its feel, vary your opener. Do NOT back-announce, recap, or name the track that just played (a listener request may slip in ahead of your pick, so what aired right before it is not certain). Never state a clock time unless the event message tells you when the link airs — then use exactly that time. When the event says stay silent, set this to null'),
  // Transition effects (only honoured when the system prompt offers them — persona djMode, see settings.effectsActive).
  // One-line pointer only: the full coaching is dj.effectsGuidance() in the
  // system prompt. This description used to repeat all of it, so every agent
  // pick carried the effects text TWICE (~500 wasted tokens per call).
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('transition treatment per the TRANSITION EFFECTS guidance: "washout"/"loop" end THIS pick (loop needs measured tempo), "sweep"/"dissolve"/"chop" carry the previous track across a clash (chop only out of beat-driven material), "blend" only for an exceptionally locked pair; "normal" or null for a plain crossfade'),
});

// Same shape, transition coaching stripped. Zod field descriptions travel to
// the model as part of the structured-output contract even when every prompt
// mention is gated off, so with DJ mode off the description above kept talking
// the model into "blend"/"sweep" picks that runTrackEvent silently discarded —
// the LLM log showed effects that could never air. The enum stays identical
// (validation must not depend on persona state); only the description flips.
export const PICK_SCHEMA_NO_FX = PICK_SCHEMA.extend({
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('always set to null — transition effects are not available for this persona'),
});

// The live pick schema, resolved per run: the transition coaching follows the
// on-air persona's djMode (settings.effectsActive), and the `say` length
// follows its scriptLength — without this overlay an 'extended' storytelling
// persona stretched to 4-6 sentence links on the pool path (generateLink gets
// lengthPhrase in its prompt) but snapped back to the consts' hard-coded "one
// or two sentences" whenever the default-on agent picker was doing the talking.
// The plain (un-wrapped) object — for callers that still need to .extend()
// (repickFromSeen pins `id` to the run's own candidate set). Extend THIS,
// then re-wrap with modelTolerant; a ZodPreprocess pipe has no .extend.
export function pickSchemaBase() {
  const base = settings.effectsActive() ? PICK_SCHEMA : PICK_SCHEMA_NO_FX;
  return base.extend({
    say: z.string().nullable().describe(`when the latest event message says to write a spoken link, set this to ${dj.lengthPhrase('link')} of natural speech in the DJ voice that INTRODUCE the track you are about to play — set it up, name the artist or capture its feel, vary your opener. Do NOT back-announce, recap, or name the track that just played (a listener request may slip in ahead of your pick, so what aired right before it is not certain). Never state a clock time unless the event message tells you when the link airs — then use exactly that time. When the event says stay silent, set this to null`),
  });
}

export function pickSchema() {
  // modelTolerant repairs GLM's malformed nullable spellings ("null"-the-
  // string, an omitted key) at the object level, on every parse path (done-
  // tool args, text salvage) — the wire schema stays identical to the plain
  // object's, all fields still required. See core/pure.ts.
  return modelTolerant(pickSchemaBase());
}

// Resolved per run, like pickSchema: the intro length follows the on-air
// persona's scriptLength. The stateless fallback's generateIntro gets
// lengthPhrase('intro') in its prompt, so without this overlay an 'extended'
// storytelling persona kept its long intros on the cascade path but snapped
// back to an unspecified length whenever the agent handled the request.
// Exported for scripts/llm-bench (same precedent as pickSystem/pickSchema for
// picker-test.mjs) — live callers stay on requestAgent.
export function requestSchema() {
  const base = z.object({
    id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
    ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
  });
  // Station voice off (settings.tts.enabled): no spoken intro can air, so the
  // field leaves the contract entirely rather than being written and dropped —
  // the request-path counterpart of runTrackEvent forcing wantLink=false, on
  // the same resolved-per-run pattern as pickSchemaBase's effectsActive()
  // branch. runRequestViaAgent still guards its own read, covering the switch
  // flipping mid-run (this schema resolved before the flip).
  if (!autoVoiceAllowed()) return base;
  return base.extend({
    intro: z.string().describe(`a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim. It airs over the track's opening seconds, so write it in the present tense — never "next" or "coming up". ${dj.lengthPhrase('intro')}`),
  });
}

// Ultra-minimal — persona + editorial criteria, nothing else. The AI SDK
// already conveys everything else through its own channels: tool descriptions
// (llm/tools.js), the done-tool description (llm/sdk.js), schema field
// descriptions (PICK_SCHEMA above), and the per-pick event message in the
// session window ("Stay silent — no link this time." vs "Also write a short
// link to speak over this track now."). Duplicating those in prompt text
// competes with the framework's structural signals and derails smaller
// models. PICKER_CRITERIA stays because it's editorial preference (flow,
// context, variety, interest) — that's not in any tool or schema.
// The transition-effects guidance (PICK_SCHEMA.transition) now lives in
// llm/internal/prompts/picker.ts (dj.effectsGuidance) so the pool picker
// shares it verbatim — it's appended to the picker system prompt ONLY when
// effects are active (the on-air persona's djMode — see
// settings.effectsActive; there is no separate toggle). Invisible otherwise,
// so the model leaves "transition" null.

// `showAt` — resolve the show brief/leans for that future moment instead of
// now: the pick airs when the current track ends, so near a show boundary the
// INCOMING show's rules are the ones to follow (see the look-ahead in
// queue.onTrackStarted). The persona now comes from the session, which the
// same look-ahead has already rolled — the mic-pass aired ahead of this pick,
// so the incoming DJ introduces their own opener rather than the outgoing DJ
// teeing up a show they've already signed off from.
export function pickSystem(showAt: Date | null = null, playlistResolved = true) {
  const persona = session.onAirPersona();
  // In DJ mode, lean on the live session history: a working DJ runs threads
  // and calls back to a track or a remark from earlier in the shift. This pairs
  // with the cross-hour memory in broadcast/session.ts, which now keeps that
  // history alive across daypart turnovers.
  const djModeLine = persona?.djMode
    ? `\n\nYou're in full DJ mode — keep the thread alive across tracks: call back to something you played or said earlier in this session when it fits, and build a little momentum rather than treating each pick as isolated.`
    : '';
  // The show topic must live in the system prompt, not only in the session-
  // opening message: the session window (~40 turns) scrolls past the opener
  // within the first hour, after which the picker would lose every show
  // constraint mid-show and revert to generic picks.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const showLine = activeShow?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${activeShow.topic}`
    : '';
  // The same mood/genre/decade/energy steer the pool picker applies — the agent
  // already owns songsByGenre + tracksByMood(energy) tools, so this line is
  // enough to make it reach for them. showMusicLean reflects the show's
  // filtersStrict here too: a strict show gets a hard "stay within" rule
  // instead of soft leans, so both pick paths honour strict the same way. Lives
  // in the system prompt for the same session-window reason as the show brief.
  const musicLean = dj.showMusicLean(activeShow);
  // Playlist anchor: a separate steer from genre/era. Strict → every pick MUST
  // come from the pinned playlist (the tools already enforce this in code, but
  // saying so keeps the agent reaching for showPlaylistTracks instead of
  // burning steps on tools that come back empty); soft → strong preference,
  // occasional steps outside allowed for flow. Gated on playlistResolved: when
  // the show pins playlists but none resolved (stale ids / Navidrome error),
  // the showPlaylistTracks tool is NOT registered — telling the model to call
  // a tool that doesn't exist burns steps and invites fabrication.
  const playlistLean = activeShow?.playlistIds?.length && playlistResolved
    ? (activeShow.playlistStrict
        ? `\n\nThis show is anchored to a curated playlist: every track you pick MUST come from it. Call showPlaylistTracks first and choose from what it returns.`
        : `\n\nThis show leans on a curated playlist: call showPlaylistTracks first and strongly prefer those tracks; only step outside occasionally when the flow calls for it.`)
    : '';
  // Listener favourites (#991): when the operator opts in, every pick sees the
  // heart-button leaderboard as a standing preference signal — mirrored in the
  // pool picker's listener-liked source so both paths lean the same way. A
  // lean, never a lock: the criteria's VARIETY rule still applies on top.
  const likeCfg = settings.get()?.likes;
  const favs = likeCfg?.enabled && likeCfg?.influenceDj
    ? likes.topLiked({ windowDays: likeCfg.windowDays, limit: likeCfg.maxTracks })
    : [];
  const favLine = favs.length
    ? `\n\nListener favourites — the most-liked tracks on this station recently: ${favs
        .map((f) => `"${f.track.title}" by ${f.track.artist || 'unknown'} (${f.count})`)
        .join('; ')}. Treat these as a strong preference signal: favour them and similar artists, genres and moods when they fit the moment — but keep variety, never loop the same favourites back-to-back.`
    : '';
  return `${settings.agentPersonaPreamble(persona)}

You run the station as one continuous shift. The messages above are the live session.${djModeLine}${showLine}${musicLean}${playlistLean}${favLine}

${dj.PICKER_CRITERIA}

Finding candidates: prefer tools backed by the local library — searchLibrary, songsByGenre, tracksByMood, tracksByEnergy, randomSongs, and the audio/embedding similarity tools. similarSongs and topSongsByArtist use external data and often return little, so try them second. If a tool returns nothing, switch tools rather than retrying. If a tool returns only a few tracks (fewer than ~4), make one more discovery call with a different tool before choosing, so you pick from a real range rather than whatever the first call happened to surface.${dj.effectsGuidance()}${settings.agentLanguageReminder(persona, 'the "say" link')}`;
}

// Exported for scripts/llm-bench, like requestSchema above.
export function requestSystem() {
  const persona = session.onAirPersona();
  // Follows requestSchema() above: with the station voice off there IS no
  // "intro" field, and a prompt that keeps talking about one invites the model
  // to stuff the intro into "ack" instead.
  const wantIntro = autoVoiceAllowed();
  return `${settings.agentPersonaPreamble(persona)}

The messages above are the live session. The final user line names the ONE listener request you are resolving now — any earlier request lines are already handled by someone else; ignore them. If the exact ask isn't in the library, pick the closest thing your tools actually returned and own the substitution in ${wantIntro ? 'the "ack" and "intro"' : 'the "ack"'} — never pretend it's what they asked for.${settings.agentLanguageReminder(persona, wantIntro ? 'the "ack" and "intro" lines' : 'the "ack" line')}

${wantIntro
    ? `The currently-playing track named in that line is there ONLY so you can interpret asks that lean on it ("something like this", "match this energy"). It is not the track your intro introduces and it may well have finished by the time the intro airs — never mention it, back-announce it, or describe the mood it set.${dj.AIR_TIME_CLAUSE}`
    : `The currently-playing track named in that line is there ONLY so you can interpret asks that lean on it ("something like this", "match this energy") — it is not the track you are choosing.`}`;
}


