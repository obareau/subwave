// Shared station-profile schema — the single source of truth for the multi-
// station create/rename request shapes, executed on BOTH sides. The controller
// runs it in middleware/validate.ts at the route boundary AND inside
// stations/manager.ts (the persistence chokepoint, reachable without a route);
// the browser runs the mirrored copy (web/lib/schemas.generated.ts) as the
// form resolver.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// Enforced by controller/eslint.config.mjs and by gen-schemas.ts.
//
// Rules that are NOT pure functions of one value — resolving a slug against
// the ids already on disk, counting the rack against the cap — deliberately
// live in station-server.ts, which is NOT mirrored.
import { z } from 'zod';

// Station id = directory name under state/stations/. Also the containment
// guard's first line of defence (no dots, no slashes, no uppercase).
//
// Lives here rather than in stations/pure.ts (which re-exports it) because
// slugifyStationName below is part of the mirror and depends on it: the admin
// UI's slug preview used to be a hand-copied second implementation, and it had
// already drifted — it omitted the fallback, so a name of pure punctuation
// previewed an empty slug while the server minted `station`.
export const STATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Hard ceiling on stations per install. Each station is a full state dir
// (own library.db, jingles, archive), so the cap keeps a runaway "new
// station" habit from silently eating the disk. Enforced in
// manager.createStation and surfaced to the UI via GET /stations `limit`.
export const MAX_STATIONS = 8;

// Display-name ceiling. Not the id length (that's STATION_ID_RE's 41) — the
// name is free text on the identity card and the slug is derived from it.
export const STATION_NAME_MAX = 80;

export function slugifyStationName(name: string): string {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
  return STATION_ID_RE.test(slug) ? slug : 'station';
}

// Carries its own messages: zod's built-in text is written for a developer
// ("Too small: expected string to have >=1 characters") and these strings
// reach an operator, both in a toast and under the input.
//
// NOTE this REJECTS an over-long name where the hand-rolled validator silently
// truncated it at 80 (`.trim().slice(0, 80)`). Same call as the webhook
// conversion made on authHeader: a name quietly cut in half is a station the
// operator has to notice and rename, whereas a rejection says so at the input
// with the schema running client-side, before a request is even sent.
export const stationNameSchema = z
  .string({ error: 'Station name is required' })
  .trim()
  .min(1, 'Station name is required')
  .max(STATION_NAME_MAX, `Station name must be ${STATION_NAME_MAX} characters or fewer`);

// Fresh = empty station, runs onboarding on first air. Duplicate = inherits the
// live station's identity/config, starts fresh history.
export const STATION_CREATE_MODES = ['fresh', 'duplicate'] as const;

export type StationCreateMode = (typeof STATION_CREATE_MODES)[number];

export const stationCreateSchema = z.object({
  name: stationNameSchema,
  // Absent still means 'fresh', as it did before. An UNRECOGNISED mode is now a
  // 400 rather than being coerced to fresh by `mode === 'duplicate' ? … : …` —
  // silently creating an empty station when the operator asked to duplicate one
  // is the expensive direction to be wrong, and no client sends a third value.
  mode: z.enum(STATION_CREATE_MODES, { error: 'Pick fresh or duplicate' }).default('fresh'),
});

export type StationCreate = z.output<typeof stationCreateSchema>;

// Rename is display-name only — the slug and data folder stay put — so it
// shares the name rule and nothing else.
export const stationRenameSchema = z.object({ name: stationNameSchema });
