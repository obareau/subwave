// Lenient load-path normalizers. These never throw: a hand-edited settings.json
// must not be able to wedge boot, so every one of them clamps or drops rather
// than rejecting. The strict counterparts used by update() live in validate.ts.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import {
  AVATAR_FILENAME_RE,
  CHATTERBOX_VOICE_RE,
  DJ_PROMPT_LIMIT,
  DJ_PROMPT_NAME_MAX,
  DJ_PROMPT_TEXT_MAX,
  DJ_PROMPT_TEXT_MIN,
  DjPromptEntry,
  FREQUENCIES,
  ID_RE,
  KOKORO_VOICE_RE,
  NormalizedShow,
  PERSONA_LIMIT,
  PIPER_VOICE_RE,
  POCKET_TTS_VOICE_RE,
  SCRIPT_LENGTHS,
  SHOWS_LIMIT,
  SHOW_TOPIC_MAX,
  SKILLS_PER_PERSONA_LIMIT,
  SKILL_SLUG_RE,
  SOUL_MAX,
  ScheduleOverride,
  TTS_CLOUD_PROVIDERS,
  TTS_ENGINES,
  WEBHOOKS_LIMIT,
  WEBHOOK_EVENTS,
  Webhook,
  clampTtsGain,
  clampTtsSpeed,
  coerceExcludedPlaylistIds,
  coerceGuestPersonaIds,
  coercePlaylistIds,
  coerceShowEnergies,
  coerceShowVocals,
  coerceShowEras,
  coerceShowGenres,
  coerceShowMoods,
  emptyWeek,
  mintId,
  normalizeDial,
} from './vocab.js';
import { DEFAULTS, coerceMaxTrackSeconds, rawMaxTrackSec } from './defaults.js';
// The webhook rules themselves, so this lenient path and update()'s strict one
// cannot restate them differently — see normalizeWebhooks below.
import { WEBHOOK_ID_RE, webhookSchema, type WebhookParsed } from '../schemas/webhook.js';
import { resolveWebhookIds } from '../schemas/webhook-server.js';

// ── normalizers (lenient — used by load(), clamp/default rather than throw) ──

// Archive retention with the keep-forever upgrade guard. A stored integer ≥ 0
// always wins (0 is a legitimate explicit "keep forever"). When nothing is
// stored, the fallback depends on whether the blob already archives: an
// install that enabled archiving under the old keep-forever default must stay
// at 0 — applying the bounded default there would delete existing tapes on
// upgrade — while everyone else (fresh installs, archive off) gets
// DEFAULTS.archive.retentionDays so newly enabled archiving is bounded from
// day one instead of silently filling the disk.
export function normalizeArchiveRetentionDays(archive: any): number {
  const v = archive?.retentionDays;
  if (Number.isInteger(v) && v >= 0) return v;
  if (archive?.enabled === true) return 0;
  return DEFAULTS.archive.retentionDays;
}

// Persona skill assignment. `null` (raw not an array) is the "all skills"
// sentinel — used by legacy personas and the code default so behaviour is
// unchanged until the operator explicitly picks a subset. An empty array
// means "this persona runs no skills".
//
// Legacy migrations: `random-facts` is rewritten to `curiosity` (the merged
// successor capability that absorbed the old prompt-only "did you know" line
// plus Wikipedia on-this-day). Persona ownership lists predate this rename,
// so without rewriting them, every upgraded operator would silently lose the
// capability the moment they reload settings.
export const SKILL_RENAMES: Record<string, string> = {
  'random-facts': 'curiosity',
};
function normalizeSkills(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = SKILL_RENAMES[item.trim()] || item.trim();
    if (!SKILL_SLUG_RE.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= SKILLS_PER_PERSONA_LIMIT) break;
  }
  return out;
}

// Lenient normaliser for a `{engine, voice, cloudProvider}` voice slot. Shared
// by every persona's `tts` block AND the station-wide TTS fallback slot
// (`settings.tts.fallback`) — the two carry the same shape by design, because a
// fallback slot is handed to speakWith() as a synthetic persona (the same trick
// synthesizeSample() uses for previews). Keeping one normaliser is what stops
// the per-engine voice rules drifting between the two.
export function normalizeTts(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const engine = TTS_ENGINES.includes(r.engine as string) ? (r.engine as string) : 'piper';
  const cloudProvider = TTS_CLOUD_PROVIDERS.includes(r.cloudProvider as string)
    ? (r.cloudProvider as string)
    : 'openai';
  let voice =
    typeof r.voice === 'string' && r.voice.trim() ? r.voice.trim().slice(0, 100) : '';
  if (engine === 'kokoro' && !KOKORO_VOICE_RE.test(voice)) voice = 'bf_isabella';
  // Chatterbox voices are reference-WAV filenames in config.chatterbox.voiceDir.
  // Empty is legitimate ("use built-in default"), invalid filenames get reset
  // to empty rather than rewritten to a Kokoro id.
  if (engine === 'chatterbox' && voice && !CHATTERBOX_VOICE_RE.test(voice)) voice = '';
  // PocketTTS accepts a built-in voice id (alba, anna, …) OR a .wav filename
  // in the shared voice folder for zero-shot cloning (issue #213). Anything
  // that matches neither shape resets to the default; the worker also guards
  // against unknown ids, but normalising here keeps the persisted form clean.
  if (
    engine === 'pocket-tts'
    && (!voice
      || (!POCKET_TTS_VOICE_RE.test(voice) && !CHATTERBOX_VOICE_RE.test(voice)))
  ) {
    voice = 'alba';
  }
  // Piper voices are `.onnx` filenames in the shared voice folder (issue #230).
  // Empty is legitimate ("use the baked-in default voice"); invalid filenames
  // reset to empty. A Kokoro-shaped id is preserved, not wiped: the seed roster
  // carries one per persona under piper so switching to Kokoro yields distinct
  // voices without re-editing, and resolvePiperVoice() falls back gracefully for
  // it at render time. Wiping it here would silently break that on first reload
  // after a save (issue #454).
  if (engine === 'piper' && voice && !PIPER_VOICE_RE.test(voice) && !KOKORO_VOICE_RE.test(voice))
    voice = '';
  // openai-compatible voices are server-specific (often arbitrary cloning ref
  // names) — no canonical default; leave empty so generateSpeech omits the
  // field and the server picks its own. Remote engine voices likewise:
  // server-specific (id, reference-wav filename, or VoiceDesign prompt), no
  // Subwave-side default.
  if (!voice && engine === 'cloud' && cloudProvider !== 'openai-compatible') voice = 'alloy';
  if (!voice && engine !== 'cloud' && engine !== 'chatterbox' && engine !== 'piper' && engine !== 'remote') voice = 'bf_isabella';
  return { engine, cloudProvider, voice, gainDb: clampTtsGain(r.gainDb), speed: clampTtsSpeed(r.speed) };
}

// Load-time shape for `settings.tts.fallback` — the station's operator-chosen
// rescue voice. The voice slot itself goes through normalizeTts() (one set of
// per-engine rules for personas and the fallback alike); only `enabled` is
// extra. An absent block normalises to disabled + engine defaults, so a
// settings.json written before this key existed keeps the pre-fallback chain
// byte-for-byte. gainDb/speed are deliberately dropped: the resolved engine's
// own trims and the on-air persona's still apply, and a third trim on the
// rescue slot would be a level surprise nobody configured.
export function normalizeTtsFallback(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const { engine, voice, cloudProvider } = normalizeTts(r);
  return { enabled: typeof r.enabled === 'boolean' ? r.enabled : false, engine, voice, cloudProvider };
}

export function normalizePersona(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : '';
  const soul = typeof r.soul === 'string' ? r.soul.trim().slice(0, SOUL_MAX) : '';
  if (!name || !soul) return null;
  // Avatar — stored as a bare basename. Reset to '' if the persisted value
  // doesn't match the strict basename shape, so a hand-edited settings.json
  // can never point /persona-avatar/:id at an arbitrary path.
  const rawAvatar = typeof r.avatar === 'string' ? r.avatar.trim() : '';
  const avatar = rawAvatar && AVATAR_FILENAME_RE.test(rawAvatar) ? rawAvatar : '';
  return {
    id: typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : mintId('p_'),
    name,
    tagline: typeof r.tagline === 'string' ? r.tagline.trim().slice(0, 80) : '',
    frequency: FREQUENCIES.includes(r.frequency as string) ? (r.frequency as string) : 'moderate',
    scriptLength: SCRIPT_LENGTHS.includes(r.scriptLength as string) ? (r.scriptLength as string) : 'concise',
    djMode: r.djMode === true,
    humour: normalizeDial(r.humour),
    localColour: normalizeDial(r.localColour),
    warmth: normalizeDial(r.warmth),
    soul,
    language: typeof r.language === 'string' ? r.language.trim().slice(0, 60) : '',
    avatar,
    tts: normalizeTts(r.tts),
    skills: normalizeSkills(r.skills),
  };
}

export function normalizePersonaArray(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: NonNullable<ReturnType<typeof normalizePersona>>[] = [];
  for (const item of raw) {
    const p = normalizePersona(item);
    if (!p) continue;
    if (seen.has(p.id)) p.id = mintId('p_');
    seen.add(p.id);
    out.push(p);
    if (out.length >= PERSONA_LIMIT) break;
  }
  return out.length ? out : null;
}

// Lenient load-time path for the prompt-template library: drop entries that
// can't render (bad text) rather than failing the whole settings load. A
// missing/duplicate name degrades to "Prompt N" instead of dropping the entry —
// the text is the part the operator can't afford to lose.
export function normalizeDjPrompts(raw: unknown): DjPromptEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DjPromptEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text.length < DJ_PROMPT_TEXT_MIN || text.length > DJ_PROMPT_TEXT_MAX) continue;
    if (!text.includes('{name}')) continue;
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('dp_');
    if (seen.has(id)) id = mintId('dp_');
    seen.add(id);
    const name =
      (typeof item.name === 'string' ? item.name.trim().slice(0, DJ_PROMPT_NAME_MAX) : '') ||
      `Prompt ${out.length + 1}`;
    out.push({ id, name, text });
    if (out.length >= DJ_PROMPT_LIMIT) break;
  }
  return out;
}

export function normalizeShows(raw: unknown, personaIds: string[]): NormalizedShow[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NormalizedShow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '';
    if (!name) continue;
    if (!personaIds.includes(item.personaId)) continue; // drop dangling owner
    // Empty moods = "Any" (the autonomous mood applies on air). Unknown mood
    // strings are dropped rather than failing the whole show. Multi-value
    // (#929): plural arrays are canonical; legacy singular fields migrate to
    // one-element lists here (coerceShow* handle both shapes).
    const moods = coerceShowMoods(item);
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    // themeId is the optional per-show theme override. Lenient path: we only
    // sanity-check the shape. A stale id (theme file deleted under our feet)
    // is harmless — routes/public.ts (GET /themes) falls back to the station
    // default at serve time. Empty/missing means "no
    // override" and is stored as an empty string for round-trip cleanliness.
    const themeId =
      typeof item.themeId === 'string' && item.themeId.trim()
        ? item.themeId.trim().slice(0, 64)
        : '';
    // Optional music-steering filters (soft lean, applied at pick time). Each
    // is a LIST — OR within the attribute, AND across attributes (#929).
    // Genres are free text resolved fuzzily against the live library when a
    // pick is made (mirrors the listener-request path) — never validated
    // against Subsonic here. Eras are decade/year windows. Energies come from
    // the tagger's three bands. All default to "no constraint" (empty list).
    const genres = coerceShowGenres(item);
    const eras = coerceShowEras(item);
    const energies = coerceShowEnergies(item);
    // Vocal steering (#1300 FR 13): '' = no constraint, which is what every
    // show predating the field carries, so loading one is a no-op.
    const vocals = coerceShowVocals(item);
    // Opt-in: hard-filter the pick pool to EVERY set music filter (mood, genre,
    // era, energy) instead of the default soft leans. Only meaningful when at
    // least one filter is set; defaults OFF. The legacy genre-only `genreStrict`
    // is deliberately NOT carried over: the toggle now spans every filter, so
    // auto-migrating an old genre-strict show would silently harden mood/era/
    // energy too. Old shows come back soft; the operator re-opts into strict.
    const filtersStrict = item.filtersStrict === true;
    // Per-show track-length override (seconds). null = inherit the station-wide
    // maxTrackSeconds; 0 = unlimited (opt this show back out of the cap so a
    // long-form mix show can air hour-long sets); >0 = this show's own cap.
    const maxTrackSeconds = coerceMaxTrackSeconds(rawMaxTrackSec(item), true);
    // Optional Navidrome playlist anchor — the union of these playlists becomes
    // the show's candidate pool. playlistStrict (default off) makes the playlist
    // the show's ENTIRE universe; soft just lets it dominate. Both default empty
    // so existing shows are byte-for-byte unchanged.
    const playlistIds = coercePlaylistIds(item.playlistIds);
    const playlistStrict = item.playlistStrict === true;
    // Optional Navidrome playlist blocklist — tracks from these playlists are
    // excluded from the candidate pool. Empty = no exclusions.
    const excludedPlaylistIds = coerceExcludedPlaylistIds(item.excludedPlaylistIds);
    // Optional guest co-hosts. Lenient path: dangling persona ids (persona
    // deleted under our feet) and the host itself are silently dropped so the
    // show survives with whatever roster is still real.
    const guestPersonaIds = coerceGuestPersonaIds(item.guestPersonaIds, item.personaId, personaIds);
    // Scripted banter breaks (multi-voice exchanges). Only meaningful with
    // guests — stored as given, checked against the live roster at air time.
    const banter = item.banter === true;
    // Programme mode: the show airs as a produced episode (intro → feature →
    // outro arc — broadcast/programme.ts). segmentSkill optionally pins the
    // feature beat to one segment capability kind; free text, resolved against
    // the live skill catalog at air time (a stale kind degrades to the
    // producer's choice, same tolerance as playlistIds).
    const programme = item.programme === true;
    const segmentSkill = typeof item.segmentSkill === 'string' ? item.segmentSkill.trim().slice(0, 64) : '';
    out.push({
      id,
      name,
      topic: typeof item.topic === 'string' ? item.topic.trim().slice(0, SHOW_TOPIC_MAX) : '',
      personaId: item.personaId,
      guestPersonaIds,
      banter,
      programme,
      segmentSkill,
      moods,
      themeId,
      genres,
      eras,
      energies,
      vocals,
      filtersStrict,
      maxTrackSeconds,
      playlistIds,
      playlistStrict,
      excludedPlaylistIds,
    });
    if (out.length >= SHOWS_LIMIT) break;
  }
  return out;
}

export function normalizeSchedule(raw: unknown, showIds: string[]) {
  const week = emptyWeek();
  if (!raw || typeof raw !== 'object') return week;
  const r = raw as Record<number, unknown>;
  for (let d = 0; d < 7; d++) {
    const day = r[d];
    if (!Array.isArray(day)) continue;
    for (let h = 0; h < 24; h++) {
      const v = day[h];
      if (typeof v === 'string' && showIds.includes(v)) week[d][h] = v;
    }
  }
  return week;
}

// Lenient load-path coercion for the timed takeover (#930). Anything malformed,
// dangling, or already expired loads as null — an override is transient state,
// never worth failing a boot over.
export function normalizeScheduleOverride(raw: unknown, showIds: string[]): ScheduleOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const showId = typeof o.showId === 'string' ? o.showId : '';
  const startedAt = typeof o.startedAt === 'number' ? o.startedAt : NaN;
  const expiresAt = typeof o.expiresAt === 'number' ? o.expiresAt : NaN;
  if (!showIds.includes(showId)) return null;
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) return null;
  if (startedAt >= expiresAt || expiresAt <= Date.now()) return null;
  return { showId, startedAt, expiresAt };
}


// Lenient load-path counterpart of validateWebhooksStrict. The RULES are the
// shared schema's — url shape, the 500-char caps, the event vocabulary, the id
// pattern — so the two paths can no longer drift apart. What lives here is only
// the LENIENCY, and each repair below is deliberate: at boot a bad row is
// patched or dropped so a hand-edited settings.json still starts the station,
// where update()'s strict path throws and tells the operator which field to fix.
export function normalizeWebhooks(raw: unknown): Webhook[] {
  if (!Array.isArray(raw)) return [];
  const rows: WebhookParsed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    // An unknown event name is FILTERED OUT rather than failing the row, so
    // retiring a name from WEBHOOK_EVENTS costs a hook that one subscription
    // instead of deleting the operator's webhook. The schema's own min(1) then
    // drops a row left with nothing to fire on, as it always did.
    const events = Array.isArray(item.events)
      ? item.events.filter((e: string) => (WEBHOOK_EVENTS as readonly string[]).includes(e))
      : [];
    const parsed = webhookSchema.safeParse({
      ...item,
      events,
      // undefined lets the schema's own .default() apply. Repaired rather than
      // rejected because none of the three is worth losing a working hook over:
      // an unrecognised id is re-minted below, a non-boolean `enabled` falls
      // back to on, and an over-long header is clamped to the same 500 the
      // strict path enforces.
      id: typeof item.id === 'string' && WEBHOOK_ID_RE.test(item.id) ? item.id : undefined,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
      authHeader:
        typeof item.authHeader === 'string' ? item.authHeader.slice(0, 500) : undefined,
    });
    if (!parsed.success) continue;
    rows.push(parsed.data);
    if (rows.length >= WEBHOOKS_LIMIT) break;
  }
  // Same minting and de-duplication the strict path runs, from the same module.
  // Deliberately NOT mergeWebhookSecrets: there is no prior list at load, and
  // resolving the redaction sentinel against nothing would blank a stored
  // header rather than leave it alone.
  return resolveWebhookIds(rows);
}


