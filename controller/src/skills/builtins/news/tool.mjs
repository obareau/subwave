// News — fetch fresh headlines from the configured feed, burning each on read
// so a later tick doesn't re-offer it. `config.feed` / `config.feedMaxItems`
// come from the skill's frontmatter (the operator's state override, if any);
// undefined → services.fetchHeadlines falls back to the env-configured feed.
export const description = 'Fetch current news headlines from the configured feed. Returns only headlines not already read on air.';

// The operator knobs this skill exposes in /admin/skills. Declared HERE rather
// than gated on `kind === 'news'` in the route, so a copy of this skill under a
// different name (a second news source) still gets a feed field — issue #1300.
export const configFields = {
  feed: { type: 'url', label: 'News feed · RSS 2.0', placeholder: 'https://…/rss.xml' },
  feedMaxItems: { type: 'number', label: 'Max items', min: 1, max: 50, integer: true, placeholder: '10' },
};

export default async function getHeadlines(ctx, state, services, config) {
  if (!(state.seenHeadlines instanceof Set)) state.seenHeadlines = new Set();
  const maxItems = config?.feedMaxItems ? Number(config.feedMaxItems) : undefined;
  const items = await services.fetchHeadlines({ feedUrl: config?.feed || undefined, maxItems });
  const fresh = items.filter(it => !state.seenHeadlines.has(services.hashHeadline(it.title)));
  // Burn-on-read so a later tick doesn't re-offer the same headline.
  for (const it of fresh.slice(0, 6)) state.seenHeadlines.add(services.hashHeadline(it.title));
  if (state.seenHeadlines.size > 120) {
    state.seenHeadlines = new Set(Array.from(state.seenHeadlines).slice(-60));
  }
  if (!fresh.length) return { headlines: [] };
  return { headlines: fresh.slice(0, 6).map(it => ({ title: it.title, detail: it.description || null })) };
}
