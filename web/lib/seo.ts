import type { Metadata } from 'next';
import { SITE_URL, OFFICIAL_SITE_URL, IS_OFFICIAL_SITE } from '@/lib/site';

function urlOnBase(base: string, path = '/'): string {
  if (!path || path === '/') return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

// Always emit ABSOLUTE strings: Next pins relative metadata URLs to
// metadataBase, which it drops on force-dynamic routes, so a relative canonical
// resolves to a localhost origin. Absolute strings are emitted verbatim.
export function absoluteUrl(path = '/'): string {
  return urlOnBase(SITE_URL, path);
}

// Which install a page's content belongs to:
// - 'shared'  — the product site: landing, /setup, /manual, /news, and the
//   community catalogs. Byte-identical on every install (one shared image),
//   so on a non-official install its canonical points at getsubwave.com —
//   otherwise every public self-hosted station self-asserts canonical over
//   the same content and Google picks one winner per duplicate cluster,
//   which may not be the official site (see IS_OFFICIAL_SITE in lib/site.ts).
// - 'station' — the operator's own surface (/, /listen) plus /privacy and
//   /terms, which stay self-canonical everywhere: the player is genuinely
//   this station's page, and the legal pages bind this operator even though
//   the text is identical (search engines expect duplicated boilerplate).
//
// 'shared' is the default on purpose: nearly every pageMeta consumer is the
// product site, and a forgotten flag on a new docs page should donate to the
// official site rather than assert a fresh duplicate.
export type PageScope = 'shared' | 'station';

// The URL a page declares as its canonical (and og:url — crawlers treat a
// mismatched og:url as a competing canonical hint, so they must agree).
export function canonicalUrl(path: string, scope: PageScope = 'shared'): string {
  if (scope === 'shared' && !IS_OFFICIAL_SITE) {
    return urlOnBase(OFFICIAL_SITE_URL, path);
  }
  return absoluteUrl(path);
}

// Next does not deep-merge nested objects like `openGraph` across the
// layout→page chain, so siteName/title are restated here rather than inherited.
//
// `title` arrives pre-branded, so it opts out of the root layout's
// `%s · SUB/WAVE` template via `absolute`, or every page doubles the brand.
// `twitter` is restated because X prefers twitter:title/description over the
// og:* tags; without it every subpage inherits the root layout's sitewide card
// (twitter:image stays global, in the root layout <head>). `siteName` defaults
// to the product name; player routes pass the operator's own station name so a
// branded install's share card isn't labelled with the software (issue #1086).
export function pageMeta({
  title,
  description,
  path,
  type = 'website',
  siteName = 'SUB/WAVE',
  scope = 'shared',
}: {
  title: string;
  description?: string;
  path: string;
  type?: 'website' | 'article';
  siteName?: string;
  scope?: PageScope;
}): Metadata {
  const url = canonicalUrl(path, scope);
  return {
    title: { absolute: title },
    ...(description ? { description } : {}),
    alternates: { canonical: url },
    openGraph: {
      title,
      ...(description ? { description } : {}),
      url,
      siteName,
      type,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      ...(description ? { description } : {}),
    },
  };
}
