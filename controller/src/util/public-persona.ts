// What an unauthenticated, ROSTER-WIDE read is allowed to say about a persona.
//
// Two endpoints share this: GET /schedule's persona index and GET /personas.
// They must never drift apart on what they disclose, and the rule is easier to
// reason about (and to pin) as a pure function than as two inline object
// literals in routes/public.ts — same split as util/listener-auth.ts.
//
// The disclosure line:
//
//   id / name / avatar   always — already public, and the schedule has shipped
//                        them since it existed.
//   tagline              always — the persona's public one-liner, the field an
//                        operator writes as a bio, and GET /dj has published it
//                        for the on-air persona all along.
//   soul                 OPT-IN (settings.privacy.publishPersonaSouls). A soul
//                        is the persona's SYSTEM PROMPT, not a written bio:
//                        operators author it assuming it stays backstage, and
//                        these reads hand over every persona at once. Default
//                        off, so upgrading a station changes no public bytes.
//
// Deliberately NOT here at any setting: tts (engine/voice/gain), skills, the
// behaviour dials (humour/localColour/warmth), djMode, language, frequency.
// Those are operator configuration, not station identity.
//
// GET /dj is intentionally out of scope. It publishes the ON-AIR persona's
// soul, one at a time, and has since it existed — public clients already read
// it, so gating it now would be a breaking change to a stable public read. The
// toggle governs bulk disclosure of the roster, which is the new capability.

/** The subset of a stored persona these reads touch. */
export interface PersonaLike {
  id?: unknown;
  name?: unknown;
  tagline?: unknown;
  soul?: unknown;
}

/** What a listener-safe persona looks like on the wire. `soul` is absent —
 *  not empty — when the station hasn't opted in, so a client can tell "not
 *  published" from "published but blank". */
export interface PublicPersona {
  id: string;
  name: string;
  tagline: string;
  avatar: string;
  soul?: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Whether roster-wide reads may publish persona souls.
 *
 * Strict `=== true`: absent (every settings.json written before the key
 * existed), null, and any non-boolean all read as OFF. Opting in has to be a
 * deliberate act, never something an upgrade or a malformed value does for you.
 */
export function soulsArePublic(s: { privacy?: { publishPersonaSouls?: unknown } } | null | undefined): boolean {
  return s?.privacy?.publishPersonaSouls === true;
}

/**
 * One persona, reduced to what an unauthenticated roster-wide read may show.
 *
 * `avatarUrl` is injected rather than built here so this module stays free of
 * the route layer's URL conventions (routes/public.ts owns `avatarUrlFor`).
 */
export function publicPersonaShape(
  p: PersonaLike,
  withSouls: boolean,
  avatarUrl: string,
): PublicPersona {
  const base: PublicPersona = {
    id: str(p?.id),
    name: str(p?.name),
    tagline: str(p?.tagline),
    avatar: avatarUrl,
  };
  return withSouls ? { ...base, soul: str(p?.soul) } : base;
}

/**
 * Guest co-host ids for a show, filtered to personas that still exist.
 *
 * A guest deleted after the show was saved simply vanishes — the same rule
 * settings/persona.ts resolveShowShape applies when it hydrates guests for the
 * on-air roster, kept in agreement here so /schedule and /now-playing never
 * disagree about who is in the booth. Ids only: the payload's persona index
 * already carries name/tagline/avatar, so clients join on id instead of us
 * repeating every blurb per show.
 */
export function publicGuestIds(
  guestPersonaIds: unknown,
  roster: readonly PersonaLike[],
): string[] {
  if (!Array.isArray(guestPersonaIds)) return [];
  return guestPersonaIds.filter(
    (gid): gid is string => typeof gid === 'string' && roster.some(p => p?.id === gid),
  );
}
