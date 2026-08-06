import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Served by Next at /robots.txt. The admin console and API proxy are disallowed
// because the admin auth gate is client-side only, so the shell HTML is served
// and would otherwise be crawlable.

// Rendered per-request so SITE_URL comes from the runtime container env: a
// build-time render bakes the localhost fallback into every image-based install.
// Same reasoning in sitemap.ts and the public page segments.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/api'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
