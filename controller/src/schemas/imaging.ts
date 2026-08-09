// Shared imaging schemas — the station's produced audio assets. Sound effects,
// beds, jingles and clone voices are four tabs and four routes, but ONE
// contract wearing four hats: a name, a description, a prompt (or jingle
// text), a duration. It was written out four times in the routes and four more
// in the panels; defining it once here is what makes them provably the same
// rule. Executed on BOTH sides: the controller runs these at the route
// boundary (middleware/validate.ts), the browser reads the caps and duration
// bands out of the mirror (web/lib/schemas.generated.ts) so an input can no
// longer invite a request the route rejects.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle. Enforced by controller/eslint.config.mjs and gen-schemas.ts.
//
// Only the duration BANDS genuinely differ between kinds, so those stay named
// per kind — broadcast/sfx.ts, broadcast/beds.ts and audio/bed-gen.ts
// re-export them rather than declaring their own. The old drift was exactly
// here: the sfx duration input carried min 0.5 / max 22 (the ElevenLabs
// generator's own range) while the route capped at 10.
import { z } from 'zod';

// The caps 60 and 200 existed only as maxLength attributes on the admin
// inputs; the controller had NO rule at all, so an API caller could store a
// name the library list then had to render. Lifting them into the schema is a
// real tightening.
export const IMAGING_NAME_MAX = 60;
export const IMAGING_DESCRIPTION_MAX = 200;
export const IMAGING_PROMPT_MAX = 500;
export const JINGLE_TEXT_MAX = 500;

// Sound effects sit under a spoken line, so they cap well below the
// generator's own 22s ceiling; the 0.5 floor is the ElevenLabs sound-gen
// minimum. broadcast/sfx.ts re-exports the max as MAX_DURATION_SEC.
export const SFX_MIN_SEC = 0.5;
export const SFX_MAX_SEC = 10;
// A bed must outlast the script read over it; generation via the ElevenLabs
// Music API caps at 2 minutes. broadcast/beds.ts re-exports the min as
// MIN_DURATION_SEC, audio/bed-gen.ts the max as BED_GEN_MAX_SEC.
export const BED_MIN_SEC = 30;
export const BED_GEN_MAX_SEC = 120;

// Explicit null reads as absent, as the `(req.body?.x || '')` readers these
// replace always did. (Named per-module: the mirror is one flat file.)
const imagingNullToUndefined = (v: unknown) => (v == null ? undefined : v);

const imagingName = z.preprocess(
  imagingNullToUndefined,
  z
    .string({ error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(IMAGING_NAME_MAX, `name must be 1-${IMAGING_NAME_MAX} chars`),
);

// NOTE: `.optional()` with a `.max()` and no `.catch()` — a catch cannot tell
// a wrong type from a too-long value, so it would silently blank a description
// the operator wrote 300 characters into. Refusing is the point.
const imagingDescription = z.preprocess(
  imagingNullToUndefined,
  z
    .string({ error: 'must be text' })
    .trim()
    .max(IMAGING_DESCRIPTION_MAX, `must be 0-${IMAGING_DESCRIPTION_MAX} chars`)
    .default(''),
);

// A duration knob: absent / '' means "let the generator decide"; a numeric
// string is what an <input type="number"> posts. The band is per kind.
function imagingDuration(band: { min: number; max: number }) {
  return z.preprocess(
    imagingNullToUndefined,
    z
      .union([z.literal(''), z.number(), z.string()])
      .optional()
      .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
      .refine((d) => d === undefined || (Number.isFinite(d) && d > 0), 'must be a positive number')
      .refine(
        (d) => d === undefined || d >= band.min,
        `must be at least ${band.min}s`,
      )
      .refine(
        (d) => d === undefined || d <= band.max,
        `is capped at ${band.max}s`,
      ),
  );
}

// POST /sfx — generate a stinger from a prompt.
export const sfxCreateSchema = z.object({
  name: imagingName,
  description: imagingDescription,
  prompt: z
    .string({ error: 'prompt is required' })
    .trim()
    .min(1, 'prompt is required')
    .max(IMAGING_PROMPT_MAX, `prompt too long (max ${IMAGING_PROMPT_MAX})`),
  durationSec: imagingDuration({ min: SFX_MIN_SEC, max: SFX_MAX_SEC }),
});

// POST /beds — generate an instrumental bed from a prompt.
export const bedCreateSchema = z.object({
  name: imagingName,
  description: imagingDescription,
  prompt: z
    .string({ error: 'prompt is required' })
    .trim()
    .min(1, 'prompt is required')
    .max(IMAGING_PROMPT_MAX, `prompt too long (max ${IMAGING_PROMPT_MAX})`),
  durationSec: imagingDuration({ min: BED_MIN_SEC, max: BED_GEN_MAX_SEC }),
});

// POST /jingles — render a TTS stinger from text.
export const jingleCreateSchema = z.object({
  text: z
    .string({ error: 'text is required' })
    .trim()
    .min(1, 'text is required')
    .max(JINGLE_TEXT_MAX, `text too long (max ${JINGLE_TEXT_MAX})`),
});

// The multipart import bodies. These sit AFTER audioUpload in the route chain:
// multer is what parses a multipart body into req.body in the first place, and
// validateBody replaces req.body ONLY — req.file, which no schema describes,
// rides through untouched. (The mirror image of the skills open-tail rule:
// there the extra data was IN the body and a schema would have eaten it; here
// it is beside the body and the schema cannot reach it.)
export const imagingImportSchema = z.object({
  name: imagingName,
  description: imagingDescription,
});

// A jingle import's label is optional — an absent label falls back to the
// filename server-side.
export const jingleImportSchema = z.object({
  label: z.preprocess(
    imagingNullToUndefined,
    z
      .string({ error: 'must be text' })
      .trim()
      .max(IMAGING_DESCRIPTION_MAX, `must be 0-${IMAGING_DESCRIPTION_MAX} chars`)
      .optional()
      .transform((v) => v || undefined),
  ),
});

// A clone-voice import has no description: the folder deliberately keeps no
// JSON sidecar (it stays operator-writable by hand), so there is nowhere for
// one to live.
export const voiceImportSchema = z.object({
  name: imagingName,
});
