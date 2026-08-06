// Rule entries for the never-play blocklist (#1300 FR 1, closes #752) — the
// attribute/tag half of blocklist.json, beside the id entries. A rule blocks
// every track matching its field + values, optionally only OUT of a seasonal
// allow-window ("Christmas tracks only air Dec 1–26") and optionally only
// while one of a set of shows is on air. Evaluation is synchronous so it can
// sit inside blocklist.matchOf()'s hot chokepoints; everything here is pure —
// blocklist.ts owns the state, the persistence, and the evaluation context
// (clock parts, active show, playlist member sets).
//
// Pinned by scripts/blocklist-rules.test.ts.

import {
  normGenre,
  genreMatches,
  trackAllTags,
  trackMoods,
  type FilterTrack,
} from './show-filter.js';

export type RuleField = 'genre' | 'tag' | 'mood' | 'artist' | 'album' | 'title' | 'playlist';

export const RULE_FIELDS: RuleField[] = ['genre', 'tag', 'mood', 'artist', 'album', 'title', 'playlist'];

// Seasonal ALLOW-window: inclusive month/day bounds. from > to wraps the year
// end (Dec 1 → Jan 6). While "in season" the rule does NOT block; a rule with
// no season always blocks. Fixed month/day like settings.festivals — lunar
// dates need per-year edits there too.
export interface SeasonWindow {
  from: { month: number; day: number };
  to: { month: number; day: number };
}

export interface BlockRule {
  id: string;            // unique, generated server-side — logs and DELETE key
  label: string;         // operator display name, e.g. "Christmas songs"
  field: RuleField;
  values: string[];      // any-of; playlist → Navidrome playlist ids
  season: SeasonWindow | null;
  // Scope: empty = station-wide. Non-empty = active only while one of these
  // shows is on air. Stale ids are inert (resolved against the live roster).
  showIds: string[];
  addedAt: string;
}

export const RULES_MAX = 50;
export const RULE_VALUES_MAX = 12;
export const RULE_TEXT_MAX = 64;

// Same normalisation as the blocklist's name fallback — trim, lowercase,
// collapse whitespace — so a `tag`/`artist` rule value compares the way an
// id entry's name snapshot does.
export const normText = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// ── Validation ───────────────────────────────────────────────────────────────

function parseMonthDay(raw: unknown, where: string): { month: number; day: number } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const month = Number(o.month);
  const day = Number(o.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`${where}.month must be 1-12`);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(`${where}.day must be 1-31`);
  return { month, day };
}

// Validate an add/update payload into the persisted shape (minus id/addedAt,
// which the store owns). Throws descriptive errors — the route surfaces the
// message verbatim, same convention as validateShowsStrict.
export function validateRulePatch(raw: unknown): Omit<BlockRule, 'id' | 'addedAt'> {
  if (!raw || typeof raw !== 'object') throw new Error('rule must be an object');
  const o = raw as Record<string, unknown>;

  const label = String(o.label ?? '').trim();
  if (!label) throw new Error('rule.label is required');
  if (label.length > RULE_TEXT_MAX) throw new Error(`rule.label must be at most ${RULE_TEXT_MAX} chars`);

  const field = o.field as RuleField;
  if (!RULE_FIELDS.includes(field)) throw new Error(`rule.field must be one of: ${RULE_FIELDS.join(', ')}`);

  if (!Array.isArray(o.values)) throw new Error('rule.values must be an array');
  const values: string[] = [];
  const seen = new Set<string>();
  for (const v of o.values) {
    if (typeof v !== 'string') throw new Error('rule.values entries must be strings');
    const t = v.trim();
    if (!t) continue;
    if (t.length > RULE_TEXT_MAX) throw new Error(`rule.values entries must be at most ${RULE_TEXT_MAX} chars`);
    const key = normText(t);
    if (seen.has(key)) continue; // silent dedupe — same value twice is one value
    seen.add(key);
    values.push(t);
  }
  if (!values.length) throw new Error('rule.values must have at least one entry');
  if (values.length > RULE_VALUES_MAX) throw new Error(`rule.values must have at most ${RULE_VALUES_MAX} entries`);

  let season: SeasonWindow | null = null;
  if (o.season != null) {
    const s = o.season as Record<string, unknown>;
    season = {
      from: parseMonthDay(s.from, 'rule.season.from'),
      to: parseMonthDay(s.to, 'rule.season.to'),
    };
  }

  let showIds: string[] = [];
  if (o.showIds != null) {
    if (!Array.isArray(o.showIds)) throw new Error('rule.showIds must be an array of strings');
    showIds = [...new Set(o.showIds.filter((v): v is string => typeof v === 'string' && !!v.trim()))];
  }

  return { label, field, values, season, showIds };
}

// ── Season / scope activity ──────────────────────────────────────────────────

// Month/day key comparison handles the year-end wrap without real dates:
// from <= to is a plain closed interval, from > to wraps (in-window means on
// or after `from` OR on or before `to`).
const mdKey = (month: number, day: number) => month * 100 + day;

export function inSeason(season: SeasonWindow, parts: { month: number; day: number }): boolean {
  const k = mdKey(parts.month, parts.day);
  const f = mdKey(season.from.month, season.from.day);
  const t = mdKey(season.to.month, season.to.day);
  return f <= t ? k >= f && k <= t : k >= f || k <= t;
}

// Evaluation context — computed once per matchOf sweep by blocklist.ts, never
// per track: station-zone clock parts (zonedParts) and the on-air show id.
export interface RuleContext {
  month: number;
  day: number;
  activeShowId: string | null;
}

// Is this rule blocking anything right now? Out of season (or no season) AND
// in scope. A show-scoped rule with no show on air — or another show — is
// inert; a seasonal rule in season is inert.
export function ruleActive(rule: BlockRule, ctx: RuleContext): boolean {
  if (rule.season && inSeason(rule.season, ctx)) return false;
  if (rule.showIds.length) return ctx.activeShowId != null && rule.showIds.includes(ctx.activeShowId);
  return true;
}

// ── Compilation + matching ───────────────────────────────────────────────────

// Per-mutation compile: normalise values once so the per-track cost at the
// chokepoints is set lookups + (for genre) the word-boundary walk — the same
// order as the strict-lock filters already running in those paths.
export interface CompiledRule {
  rule: BlockRule;
  genreTargets: string[];  // field=genre — normGenre'd, for genreMatches
  valueSet: Set<string>;   // every other field — normText'd exact match
}

export function compileRules(rules: BlockRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    rule,
    genreTargets: rule.field === 'genre' ? rule.values.map(normGenre).filter(Boolean) : [],
    valueSet: new Set(rule.values.map(normText).filter(Boolean)),
  }));
}

// The track shape rules read — FilterTrack's tag surface plus the name fields
// the id blocklist already matches on.
export type RuleTrack = FilterTrack & { artist?: string | null; album?: string | null; title?: string | null; name?: string | null };

// Does this track match the rule's field + values? Activity (season/scope) is
// the caller's job via ruleActive — split so listing surfaces can show "what
// WOULD this rule block" independent of the clock.
//
// Semantics per field:
//   genre  — genreMatches: exact-normalised or the track's tag REFINES the
//            target on word boundaries (blocking "Punk" drops "Punk Rock";
//            blocking "Pop Punk" keeps plain "Pop"; blocking "Rap" keeps
//            "Trap") — the same direction the show filters use.
//   tag    — normalised EXACT match across every tag namespace we ingest
//            (trackAllTags: genres ∪ moods ∪ audioMoods ∪ Last.fm tags).
//            Exact, not substring — Last.fm tags are noisy free text.
//   mood   — normalised exact over trackMoods (editorial + audio union).
//   artist/album/title — normalised exact on the row's own fields (the id
//            blocklist's name-fallback semantics, minus the id).
//   playlist — track id ∈ the pre-resolved member set for any listed playlist
//            id; an unresolved playlist contributes nothing (stale ids inert).
export function ruleMatches(
  cr: CompiledRule,
  track: RuleTrack | null | undefined,
  playlistMembers: Map<string, Set<string>> | null,
): boolean {
  if (!track) return false;
  const { rule } = cr;
  switch (rule.field) {
    case 'genre':
      return cr.genreTargets.length > 0 && genreMatches(track, cr.genreTargets);
    case 'tag':
      return trackAllTags(track).some((t) => cr.valueSet.has(normText(t)));
    case 'mood':
      return trackMoods(track).some((m) => cr.valueSet.has(normText(m)));
    case 'artist':
      return !!track.artist && cr.valueSet.has(normText(track.artist));
    case 'album':
      return !!track.album && cr.valueSet.has(normText(track.album));
    case 'title': {
      const title = track.title ?? track.name;
      return !!title && cr.valueSet.has(normText(title));
    }
    case 'playlist': {
      if (!track.id || !playlistMembers) return false;
      for (const pid of rule.values) {
        if (playlistMembers.get(pid)?.has(track.id)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// ── Persistence coercion ─────────────────────────────────────────────────────

// Coerce a raw persisted rule (blocklist.json is operator-visible state, so
// treat it like any other state file: drop what doesn't parse rather than
// refusing to boot). Returns null for an unusable record.
export function coerceStoredRule(raw: unknown): BlockRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  try {
    const patch = validateRulePatch(o);
    return { id: o.id, addedAt: typeof o.addedAt === 'string' ? o.addedAt : new Date().toISOString(), ...patch };
  } catch {
    return null;
  }
}
