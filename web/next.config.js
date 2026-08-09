// Version shown in the admin console footer, in priority order:
//   1. SUBWAVE_BUILD_VERSION build-arg (scripts/update.sh, publish-images CI).
//      release-please only bumps package.json on `main`, so `develop` builds would
//      otherwise report a version behind.
//   2. `git describe` for local dev/build. A Docker build has no .git, so it falls to 3.
//   3. web/package.json — correct on a tagged checkout.
function resolveAppVersion() {
  const fromEnv = process.env.SUBWAVE_BUILD_VERSION;
  if (fromEnv) return fromEnv.replace(/^v/, '');
  try {
    // execFileSync (no shell) with a fixed, no-user-input command.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process');
    const described = execFileSync(
      'git',
      ['describe', '--tags', '--always', '--dirty'],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    if (described) return described.replace(/^v/, '');
  } catch {
    // No git available (e.g. inside a Docker build) — fall through.
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./package.json').version;
}

const version = resolveAppVersion();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // The /apps directory renders submitter-supplied icons + screenshots from the
  // community catalog. Those URLs are a trust boundary: an arbitrary host would
  // mean listener browsers fetching from anywhere, and an image that can be
  // swapped to anything after review. This allowlist is the REAL enforcement —
  // next/image refuses any host not listed here — so images are proxied and
  // optimised by the site rather than hot-linked, and a visitor's browser never
  // contacts the submitter's host. The community repo's catalog builder rejects
  // off-list URLs at submission time and web/lib/apps.ts re-checks them (the
  // catalog is a live remote fetch), but this is the backstop. Keep all three in
  // lockstep; widening it here without widening them is the dangerous direction.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'user-images.githubusercontent.com' },
      { protocol: 'https', hostname: 'github.com' },
    ],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  // The repo root carries its own package.json (the `sub-wave` CLI), so Next would
  // otherwise infer it as the workspace root — destabilising module resolution and
  // crashing the dev server when it loads tailwind.config.js through the ESM loader.
  outputFileTracingRoot: __dirname,
  // Verifying the onboarding wizard needs a SECOND `next dev` running
  // concurrently against a second controller (needsSetup is only ever true
  // there — see web/scripts/verify-forms.py's `onboarding` check), from this
  // same source tree. Next's dev server refuses a second instance sharing
  // one `.next/dev/lock` file ("Another next dev server is already
  // running"), and the lock is keyed off distDir — defaulting both
  // instances to plain `.next` collides. Unset, this is byte-identical to
  // every other invocation (dev, build, the Docker image).
  distDir: process.env.SUBWAVE_NEXT_DIST_DIR || '.next',
  // Dev only. Next blocks /_next/* dev resources whose Origin isn't localhost, so
  // opening `npm run dev` from a phone or another LAN/tailnet box serves the HTML but
  // never the client bundle — AdminShell then sits on "loading…" forever, because
  // useAdminAuth never hydrates. Comma-separated hosts, no scheme or port:
  //   SUBWAVE_DEV_ORIGINS=100.120.114.55,192.168.1.227 npm run dev
  allowedDevOrigins: (process.env.SUBWAVE_DEV_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  // Edge redirect for /admin → /admin/dash. A server-component `redirect()` in
  // app/admin/page.tsx crashed Next 15's Router post-sign-in: AdminShell renders its
  // sign-in form until auth is set, so the redirecting page mounts late as a child,
  // tripping React with "Rendered more hooks than during the previous render."
  async redirects() {
    return [{ source: '/admin', destination: '/admin/dash', permanent: true }];
  },
};

module.exports = nextConfig;
