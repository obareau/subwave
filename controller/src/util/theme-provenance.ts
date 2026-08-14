// Which of the station's theme levels decided the theme on screen — and, just
// as importantly, saying so on the wire rather than only answering "which id".
//
// Three levels resolve a theme and each silently outranks the one below it:
//
//   this browser's own override   localStorage, set from the player's palette
//                                 menu. Never reaches the server, so it is
//                                 resolved client-side and is NOT modelled here.
//   the on-air show's themeId     settings.shows[].themeId, for as long as the
//                                 show is on air. Everyone sees it.
//   the station default           settings.theme.active — the admin picker.
//
// GET /themes used to return only the resolved `active` id, which made "the
// setting didn't stick" and "a show is pinning its own palette" the same
// response (#1300 bug 12): an operator saves a station theme, the admin UI
// applies it locally, and ThemeProvider's next poll repaints it away. Nothing
// failed — a level above simply won — but the endpoint could not say so and the
// admin UI could not have explained it even if it wanted to.
//
// Lives here rather than inline in routes/public.ts for the same reason
// util/public-persona.ts does: it is the SHAPE OF A PUBLIC READ, and a public
// read's contract is worth one pure function and one test rather than an object
// literal buried in a route handler. The contract the test pins:
//
//   • `active` keeps its old value in every case, so existing clients (the web
//     ThemeProvider, the Expo player) are byte-for-byte unaffected;
//   • a show wins ONLY if its themeId still resolves to a known theme — a stale
//     id (operator deleted the file) falls back to the station default, the
//     same lenient fallback the rest of the theme system uses;
//   • `activeShow` is null, not absent, when the station default wins, so a
//     client can destructure it without a presence check.

/** The subset of a resolved show this read touches. */
interface ActiveShowLike {
  id?: unknown;
  name?: unknown;
  themeId?: unknown;
}

/** The show that outranked the station default, as published. */
interface ProvenanceShow {
  id: string;
  name: string;
  themeId: string;
}

interface ThemeProvenance {
  /** The effective theme — what a client should actually paint. Unchanged. */
  active: string;
  /** Which level decided `active`. */
  activeSource: 'show' | 'station';
  /** settings.theme.active, i.e. what admin's station picker sets. */
  stationDefault: string;
  /** Null — never absent — when the station default won. */
  activeShow: ProvenanceShow | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Resolve the effective theme id and say which level decided it.
 *
 * `themeIds` is every theme the controller currently knows about (built-ins +
 * state/themes/*.json). A show's pin is honoured only if it is in that set.
 */
export function resolveThemeProvenance(args: {
  stationDefault: string;
  activeShow?: ActiveShowLike | null;
  themeIds: Iterable<string>;
}): ThemeProvenance {
  const { stationDefault } = args;
  const known = new Set(args.themeIds);
  const show = args.activeShow ?? null;
  const showThemeId = str(show?.themeId);
  // The show wins only when its pin still resolves. A stale override (theme
  // deleted under our feet) silently falls back to the station default — same
  // fallback strategy as getTheme(). Narrowing to the show OBJECT rather than a
  // boolean is what keeps the rest of this function free of `!` assertions.
  const winner = show && showThemeId && known.has(showThemeId) ? show : null;

  return {
    active: winner ? showThemeId : stationDefault,
    activeSource: winner ? 'show' : 'station',
    stationDefault,
    activeShow: winner
      ? { id: str(winner.id), name: str(winner.name), themeId: showThemeId }
      : null,
  };
}
