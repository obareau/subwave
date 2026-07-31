# subwave

## What this codebase does

SUB/WAVE is a self-hosted personal internet radio station. One Icecast stream,
all listeners hear the same broadcast; an LLM "DJ" picks tracks from a Subsonic/
Navidrome library and reads scripts between them. Four processes share state via
a **file-based IPC directory** (`state/`, mounted `/var/sub-wave`): an Express
ESM controller (`controller/src`), a Liquidsoap mixer (`liquidsoap/radio.liq`),
a Next.js 15 player + admin UI (`web/`), and an Expo native app (`app/`).
Deployment is single-host Docker Compose behind Caddy, typically with Cloudflare
terminating TLS. Users are one operator (admin) plus anonymous public listeners.

## Auth shape

- **`requireAdmin`** (`controller/src/middleware/auth.ts`) is the *only* admin
  gate — HTTP Basic against `ADMIN_USER`/`ADMIN_PASS`, `timingSafeEqual`
  compare, 10-strike per-IP lockout. `assertAdminConfigured()` hard-exits at
  boot when `NODE_ENV=production` and creds are unset, so prod is never
  ungated. In dev the gate is deliberately opt-in and `requireAdmin` no-ops.
- **`clientIp`** (`middleware/ratelimit.ts`) resolves the address that lockout
  and rate-limit counters key on. It is header-derived behind a proxy — treat
  "attacker can choose their own key" as known and accepted, not a finding.
- **`util/listener-auth.ts`** holds two endpoints with *deliberately opposite*
  failure modes: `POST /listener-auth` (Icecast URL auth) **fails open** when
  `listenerAuth` is off; `POST /station-auth` (web player gate) **fails
  closed**. This is intentional and load-bearing — do not report them as
  inconsistent, and do not suggest merging them.
- **`util/request-guard.ts`** is the single chokepoint for listener-submitted
  request text (scripted-opener stripping, verbatim-echo guard, requester-name
  screening). A guard inlined into a route or agent instead of this module *is*
  a finding.
- Subsonic/Navidrome calls authenticate with the protocol-mandated salt+token
  **MD5** scheme (`music/subsonic.ts`). Required by the Subsonic API spec.

## Threat model

Ranked by impact: (1) **admin console takeover** — `/settings` and `/debug`
expose LLM/TTS API keys, the Navidrome password and station internals, so any
route reachable without `requireAdmin` that reads or mutates settings is
critical; (2) **prompt injection via listener requests** — untrusted text
reaches LLM prompts and then the on-air voice and the persisted session, which
caused a real raid (2026-07-28); (3) **LLM token theft** — unauthenticated
`POST /request` drives paid model calls, bounded only by `settings.requests`
caps and `llm.dailyTokenCap`; (4) **SSRF via operator-set URLs** —
`llm.baseUrl`, SearXNG base URL, and news `feed:` are admin-settable and then
fetched server-side.

## Project-specific patterns to flag

- **Writers of the IPC files.** `queue.drainToLiquidsoap()` must be the only
  writer of `next.txt`, and `queue.announce()` the only writer of
  `say.txt`/`intro.txt`. Any other module writing those, or interpolating
  unescaped user/track text into an `annotate:` URI, is a real issue — that
  string is parsed by Liquidsoap.
- **Telnet command construction** in `broadcast/liquidsoap-control.ts`: newline
  or CR injected into a value would forge extra Liquidsoap commands.
- **Icecast XML rendering.** `docker/broadcast-entrypoint.sh` and the AIO
  supervisor's `render_icecast()` interpolate settings-derived values (trusted
  proxy IPs, mount auth blocks) into `icecast.xml`. Unescaped input there
  breaks or rewrites the config.
- **Path handling under `state/`** — skill slugs, jingle filenames, station
  ids and persona ids become filesystem paths; traversal there escapes the
  state dir. `util/slug.ts` is the intended normaliser.
- **Public-shape leaks.** `util/public-persona.ts` is the only place allowed to
  decide what a persona publishes; a route widening that shape inline (e.g.
  leaking `soul`, TTS config or skills) is a finding.

## Known false-positives

- **`insecure-crypto` on MD5 in `music/subsonic.ts`** — mandated by the
  Subsonic auth protocol, not a chosen hash. Same for MD5 used as a cache or
  content key elsewhere.
- **`Math.random` (~38 files)** — used for DJ persona/soul/angle selection,
  shuffling and jitter. Non-security randomness throughout. `util/shuffle.ts`
  is deliberate.
- **`missing-auth` on `routes/public.ts`** — `/health`, `/now-playing`,
  `/state`, `/dj`, `/cover/:id`, `/schedule`, `/personas`, `/listen.pls` and
  `POST /request` are *intentionally public*; this is a public radio station.
  Only flag these if they expose secrets or admin-mutating behaviour.
- **`cors.ts` allowing `*`** — intentional. The player, native app and
  third-party clients are served from other origins; there are no cookies or
  browser-credentialed sessions, so there is no CSRF surface to protect.
- **`process-env-access` in `config.ts`** — by design the single env-derived
  config surface for the whole controller ("env always wins").
- **Auto-generated secrets** in `docker/broadcast-entrypoint.sh` and
  `setup/secrets.ts` (Icecast passwords, `state/secrets.env` at mode 0600) are
  generated and persisted on purpose, not hardcoded credentials.
