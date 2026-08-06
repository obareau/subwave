// Extra request-body parameters for the `openai-compatible` cloud TTS provider
// (issue #1317).
//
// A compatibility server is whatever the operator points us at — Chatterbox
// wants `temperature` / `seed` / `exaggeration` / `cfg_weight`, Qwen3-TTS and
// VibeVoice want entirely different fields, and the next one will want fields
// nobody has written down yet. Rather than growing a named setting per server
// generation, the operator stores free-form key/value pairs that ride along in
// the POST body to `/audio/speech`. Only the compatibility provider reads them:
// OpenAI, ElevenLabs and Fish request shapes stay byte-identical.
//
// This module is the ONE place the rule lives — both the settings validator
// (reject at save time, where the operator can see the error) and the send path
// in llm/internal/speech/cloud-speech.ts consume it, so a key that saves is
// always a key that sends. Pure and side-effect free; pinned by
// scripts/compat-tts-params.test.ts.

export type CompatParam = { key: string; value: string };

export const COMPAT_PARAM_MAX_ENTRIES = 20;
export const COMPAT_PARAM_KEY_MAX = 60;
export const COMPAT_PARAM_VALUE_MAX = 400;

// Body fields the station resolves itself. Each is rejected at save time rather
// than dropped at send time, so the operator learns immediately instead of
// wondering why their entry does nothing:
//   model / voice — first-class fields in the same settings panel, with their
//     own discovery UI. A second source of truth for them is a footgun, not an
//     escape hatch.
//   input — the script text. Overriding it would mute the segment silently:
//     the render still succeeds, so nothing falls back, and the booth airs the
//     wrong words.
//   speed — compatibility servers never receive a server-side `speed` (#942);
//     the rate is applied locally with ffmpeg atempo instead. An extra `speed`
//     here would COMPOUND with that local stretch rather than replace it.
export const COMPAT_PARAM_RESERVED_KEYS = ['model', 'input', 'voice', 'speed'];

// A stored value is text, because that is what an operator types into a form.
// Servers want real JSON types though — a Chatterbox that reads `temperature`
// as a float 422s on the string "0.8", and `seed` must be an integer. So the
// value is parsed as a JSON literal when it is one, and kept as a plain string
// when it isn't: `0.8` → 0.8, `42` → 42, `true` → true, `null` → null,
// `{"a":1}` → an object, `alba` → "alba". That also means a would-be-numeric
// string with a leading zero (`007`) stays a string, which is the right answer
// for the servers that use such values as ids.
export function coerceCompatParamValue(raw: string): unknown {
  const v = String(raw ?? '').trim();
  if (v === '') return '';
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// Validate + normalise a stored/incoming list. Throws with an operator-readable
// message on anything unusable — a bad param is a request the server will
// reject, i.e. a silent fallback to a different voice mid-show, so this is one
// of the few TTS settings worth failing the save over rather than clamping.
// Blank rows are dropped (the UI appends an empty row on "Add"), so an operator
// who adds a row and saves without filling it in doesn't hit an error.
export function validateCompatParams(input: unknown): CompatParam[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error('tts.cloud.compatParams must be an array of {key, value}');
  }
  const out: CompatParam[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('tts.cloud.compatParams entries must be objects with key and value');
    }
    const key = String((row as CompatParam).key ?? '').trim();
    const value = String((row as CompatParam).value ?? '').trim();
    if (!key && !value) continue; // untouched blank row
    if (!key) throw new Error('tts.cloud.compatParams entries need a parameter name');
    if (key.length > COMPAT_PARAM_KEY_MAX) {
      throw new Error(`tts.cloud.compatParams names must be 1-${COMPAT_PARAM_KEY_MAX} chars`);
    }
    // JSON object keys can hold anything, but a body field that isn't a plain
    // identifier is a typo far more often than it is a real server contract.
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`tts.cloud.compatParams name "${key}" must start with a letter and use only letters, digits, _ . -`);
    }
    if (COMPAT_PARAM_RESERVED_KEYS.includes(key)) {
      throw new Error(`tts.cloud.compatParams cannot override "${key}" — SUB/WAVE sets it for every request`);
    }
    if (value.length > COMPAT_PARAM_VALUE_MAX) {
      throw new Error(`tts.cloud.compatParams values must be 0-${COMPAT_PARAM_VALUE_MAX} chars`);
    }
    if (seen.has(key)) {
      throw new Error(`tts.cloud.compatParams has a duplicate name "${key}"`);
    }
    seen.add(key);
    out.push({ key, value });
  }
  if (out.length > COMPAT_PARAM_MAX_ENTRIES) {
    throw new Error(`tts.cloud.compatParams is limited to ${COMPAT_PARAM_MAX_ENTRIES} entries`);
  }
  return out;
}

// The object merged into the outgoing /audio/speech body. Defensive rather than
// trusting: settings.json is operator-editable by hand and may predate (or
// sidestep) the validator, so a malformed row is skipped here instead of
// throwing — a dropped param costs one un-tuned render, while a throw inside
// speak() costs the segment and drops the show to a local fallback voice.
export function compatParamsBody(params: unknown): Record<string, unknown> {
  if (!Array.isArray(params)) return {};
  const body: Record<string, unknown> = {};
  for (const row of params.slice(0, COMPAT_PARAM_MAX_ENTRIES)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const key = String((row as CompatParam).key ?? '').trim();
    if (!key || COMPAT_PARAM_RESERVED_KEYS.includes(key)) continue;
    body[key] = coerceCompatParamValue(String((row as CompatParam).value ?? ''));
  }
  return body;
}
