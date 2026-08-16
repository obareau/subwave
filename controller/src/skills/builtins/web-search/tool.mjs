// Web search — something recent about the on-air artist (release, tour, press),
// or whatever the segment director asks for via the optional `query` input.
// `ready` gates the whole skill on a configured search provider, so it's never
// even offered when search is unavailable.
export const description = 'Search the web. Pass a query to dig into something specific (the track, an event, a topic worth a line), or pass null to default to recent news about the artist currently on air.';

export const inputs = {
  query: 'what to search for — a specific question or topic; null to default to recent news about the on-air artist',
};

export const ready = (services) => services.searchReady();

// True when `text` names `artist` as a whole word — not merely as a substring.
// A search for a short or common artist name comes back full of pages that
// happen to contain the word, and handing those to the DJ as "what this artist
// is up to" is how an empty result became an invented story (issue #1412).
// Word-boundary rather than `includes` so "Cue" doesn't match "cued"; the
// boundaries are letter/number classes so accented names still match.
function mentionsArtist(text, artist) {
  const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
  } catch {
    // An artist name that won't compile into a pattern falls back to a plain
    // containment test rather than dropping every source.
    return text.toLowerCase().includes(artist.toLowerCase());
  }
}

export default async function searchArtistNews(ctx, state, services, config, input) {
  const custom = String(input?.query || '').trim();
  const artist = services.nowPlaying()?.artist;
  if (!custom && (!artist || /^unknown/i.test(artist))) return { available: false };
  const query = custom || `${artist} musician latest news`;
  const alreadySearched = !custom && artist === state.lastSearchedArtist;
  const data = await services.searchWeb(query, { recency: 'week' });
  if (!custom) state.lastSearchedArtist = artist;
  const answer = (data.answer || '').trim();
  let results = data.results || [];
  // On the default artist query we know what the results were supposed to be
  // about, so anything that never names the artist is dropped before the DJ
  // ever sees it. A custom query is the agent's own wording — there is no
  // subject to check it against, so its results pass through as before.
  if (!custom) results = results.filter(r => mentionsArtist(`${r.title || ''} ${r.content || ''}`, artist));
  const sources = results
    .slice(0, 3)
    .map(r => `${r.title}: ${(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
  // Nothing to write from. The forced path stands down on this rather than
  // ordering a line anyway (skills/abstain-policy.ts); the autonomous director
  // has always read it as a reason to stay quiet.
  if (!answer && sources.length === 0) return { available: false };
  return { query, artist, alreadySearched, answer, sources };
}
