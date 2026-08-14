// Public site origin: the single source of truth for absolute URLs in metadata,
// OG/Twitter cards, robots and the sitemap.
//
// Resolved at RUNTIME. Every route emitting an absolute URL is force-dynamic, so
// the running container's env is what matters. This is deliberate: the published
// GHCR image is one generic build shared by every operator, so the domain can't
// be known at image-build time, and baking it produced localhost URLs on every
// image-based install. NEXT_PUBLIC_SITE_URL is accepted as a fallback for older
// configs. Defaults to the dev origin so local builds still produce a valid
// `metadataBase` without Next's warning.
export const SITE_URL = (
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'http://localhost:7700'
).replace(/\/$/, '');

// The project's own public site. Non-official installs point the canonicals
// of SHARED pages (landing, docs, news, community catalogs) here — see
// lib/seo.ts canonicalUrl().
export const OFFICIAL_SITE_URL = 'https://getsubwave.com';

function isOfficialHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'getsubwave.com' || host === 'www.getsubwave.com';
  } catch {
    return false;
  }
}

// True when this install IS the official site, or the operator explicitly
// opted into indexing everything with SUBWAVE_INDEX_ALL=1.
//
// Every install serves the same marketing/docs/news pages as getsubwave.com
// (one shared image). If each self-asserted canonical over them, Google would
// fold the duplicates into one winner per cluster and a public self-hosted
// station could win a dispatch away from the official site. So non-official
// installs donate those canonicals back and drop the pages from their sitemap,
// while still serving them fully.
export const IS_OFFICIAL_SITE =
  process.env.SUBWAVE_INDEX_ALL === '1' || isOfficialHost(SITE_URL);
