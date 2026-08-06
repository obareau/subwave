// GA Measurement ID, resolved at BUILD and RUNTIME, mirroring lib/site.ts.
//
// `NEXT_PUBLIC_*` vars are inlined at build time, so an ID set only in a running
// container's env never reached the client and operators had to rebuild the web
// image to turn analytics on. The plain (non-NEXT_PUBLIC) `GA_ID` comes from the
// container's runtime env instead; docker-compose plumbs the operator's existing
// `NEXT_PUBLIC_GA_ID` into it, so no .env change is needed. Empty = off.
//
// Same runtime caveat as SITE_URL: the value is read where the tree renders —
// per-request for the force-dynamic homepage, at build for static routes.
export const GA_ID = (
  process.env.GA_ID ||
  process.env.NEXT_PUBLIC_GA_ID ||
  ''
).trim();
