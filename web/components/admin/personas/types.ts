// Shared types for the personas editor (/admin/personas).

import type { EngineAvailability } from '../tts/engineMeta';
export type { EngineAvailability };

export interface PersonaTts {
  engine: 'piper' | 'kokoro' | 'chatterbox' | 'pocket-tts' | 'cloud' | 'remote' | string;
  cloudProvider: string;
  voice: string;
  // −12..+12, 0 = no change. Stacks on the per-engine gain (settings.ts:clampTtsGain).
  gainDb: number;
  // 0.5..2.0×, 1.0 = no change. Composes with the per-engine speed + daypart
  // energy; Piper/Kokoro/cloud only (settings.ts:clampTtsSpeed).
  speed: number;
}

export interface Persona {
  id: string;
  name: string;
  tagline: string;
  frequency: string;
  scriptLength: string;
  // Back-announces AND teases what's next, and runs callbacks across the session.
  // Off = the tasteful-narrator behaviour.
  djMode: boolean;
  // Tone dials, 0–10, default 5 (neutral). Map to prompt bands server-side.
  humour: number;
  localColour: number;
  warmth: number;
  soul: string;
  // Free-text on-air language ("Turkish", "Türkçe"). Empty = English (no
  // directive injected server-side).
  language: string;
  // Basename like `p_abc123.png`, empty when none. The image itself is served from
  // /api/persona-avatar/<id>; the basename is held only so a save round-trips it.
  avatar: string;
  tts: PersonaTts;
  skills: string[];
}

// Mirrors the controller's djPrompts entries (settings.ts:validateDjPromptsStrict).
export interface DjPromptPreset {
  id: string;
  name: string;
  text: string;
}

export interface FormState {
  personas: Persona[];
  activePersonaId: string;
  // '' selects the built-in default template.
  djPrompts: DjPromptPreset[];
  activeDjPromptId: string;
  // Station house rules — appended to EVERY spoken-output prompt, including
  // the agent paths the template never reaches (issue #1182). '' = off.
  djHouseRules: string;
}

// The react-hook-form shape: just the two field arrays (personas, djPrompts).
// `activePersonaId`/`activeDjPromptId`/`djHouseRules` stay plain useState in
// PersonasPanel — they aren't array rows and the controller's own patch
// registry validates them as their own top-level settings keys, not as part
// of the personas/djPrompts arrays.
//
// This is a TYPE-ONLY shape, not derived from `z.input<typeof personaSchema>`
// / `z.input<typeof djPromptSchema>`: every leaf of those schemas is a
// `z.unknown().transform()` (the schema doubles as the server's load-repair
// target), so its z.input types every field `unknown` and no nested path
// (`personas.0.tts.engine`) would type-check as a FieldPath. Persona/
// DjPromptPreset are the shape the schema's own `.transform()` actually
// produces and the shape this editor already edits — casting the real
// `form.control` to `Control<PersonasFormValues>` is a type-only statement,
// same technique Task 3 established for festivalsSchema/moodsSchema (the
// runtime object is identical; only what TypeScript is allowed to believe
// changes).
export interface PersonasFormValues {
  personas: Persona[];
  djPrompts: DjPromptPreset[];
}

export interface SkillCatalogEntry {
  name: string;
  label?: string;
  description?: string;
  // Station-wide toggle from the Skills page. Optional so the UI degrades
  // against older controllers that don't send it.
  enabled?: boolean;
  // Freeform organisation tags from the skill's SKILL.md frontmatter.
  tags?: string[];
}

export interface VoiceOption {
  id: string;
  label: string;
}

export interface SettingsResponse {
  // The persona actually on air: a live show's owner, else the admin-selected
  // default. `values.activePersonaId` is only the default. Optional so the UI
  // degrades against older controllers.
  onAir?: {
    personaId?: string;
    show?: { id: string; name: string } | null;
  };
  values?: {
    personas?: Array<Partial<Persona> & { avatar?: string }>;
    activePersonaId?: string;
    djPrompt?: string;
    djPrompts?: Array<Partial<DjPromptPreset>>;
    activeDjPromptId?: string;
    djHouseRules?: string;
    tts?: { defaultEngine?: string };
  };
  defaults?: { djPrompt?: string };
  skills?: { catalog?: SkillCatalogEntry[] };
  tts?: {
    kokoroVoices?: string[];
    kokoroVoiceLanguages?: Record<string, string>;
    kokoroLangs?: string[];
    piperVoices?: string[];
    chatterboxVoices?: string[];
    // `voiceDir` is the new shared name (issue #213). `chatterboxVoiceDir` is
    // kept as an alias so the UI keeps working against older controllers.
    voiceDir?: string;
    chatterboxVoiceDir?: string;
    pocketTtsVoices?: VoiceOption[];
    pocketTtsCustomVoices?: string[];
    available?: EngineAvailability;
    cloudProviders?: string[];
  };
  env?: Record<string, unknown>;
}

// GET /personas/community; mirrors the controller's CommunityPersona
// (personas/community.ts). "Already in the roster" is computed client-side by name
// match, since the panel holds the roster anyway.
export interface CommunityPersona {
  slug: string;
  displayName: string;
  tagline?: string;
  soul: string;
  frequency: 'silent' | 'quiet' | 'moderate' | 'chatty' | 'aggressive';
  scriptLength: 'one-liner' | 'concise' | 'extended' | 'storyteller';
  djMode: boolean;
  humour?: number;
  localColour?: number;
  warmth?: number;
  language?: string;
  submittedBy?: string;  // GitHub login of the contributor who submitted it
  dateAdded?: string;    // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}
