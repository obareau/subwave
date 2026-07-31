# CLAUDE.md — `web/`

Loaded when working under `web/`. Station-wide architecture lives in the root `CLAUDE.md`.

### Web UI (`web/`)

Next.js 15 App Router + Tailwind. Routes:

- `/` — `PlayerApp` or `Landing`, chosen at request time by `SUBWAVE_HOMEPAGE` (`player` default).
- `/listen` (always player), `/landing` (always broadsheet), `/setup` (docs), `/onboarding` (first-run wizard, the in-browser counterpart to `npm run setup`).
- `/admin`, `/admin/settings`, `/admin/debug` — admin shell behind a **single sign-in gate** (`AdminShell` + `useAdminAuth` in `web/lib/adminAuth.js`). Credentials cached in `localStorage` as `base64(user:pass)`, dropped on sign-out.

**Player = shell + skin.** `PlayerApp` mounts `components/player/PlayerShell.tsx`: the headless core (`PlayerCore.tsx` — feed/audio/actions contexts split by update cadence, plus the OS media session) with the `<audio>` element, contained-embed portal plumbing, and toaster; the shell resolves the active **skin** from the registry (`components/skins/index.ts`, contract in `components/skins/types.ts`; lazy chunks, SSR on). Skins ship in-repo: `classic` (the original face), `unit` (UNIT SW-9 — a milled-aluminium receiver with a dot-matrix display and TIMELINE/BOOTH/REQ windows; replaced the retired `spool` walkman deck, which aliases to it), `drift` (ambient cover-wash poster), `subamp` (1998 modular player with a live spectrum analyzer), `tty` (full TUI; the registry aliases the retired `terminal` id to it), and `platter` (the flagship vinyl face). Shared pure derivations live in `components/skins/shared.ts`. Selection mirrors themes end to end: operator default `settings.ui.skin` rides `GET /state`, listener override in `localStorage` (`subwave-skin-override`, picker in the palette menu — hidden unless >1 skin), unknown ids always fall back to classic. Rules for skins: consume only the core contexts + shared hooks, render the tune-in gate via `useTuneInGate` (the tap is the browser's audio-unblock gesture), honor the theme tokens, and co-locate styles — never touch `globals.css`. The shell's `<audio>` element must carry `ref={attachAudio}` (from `usePlayerAudio`), never the plain `audioRef` — the private-station gate unmounts and remounts it mid-session, and `usePlayer`'s media listeners re-attach off that callback. With an object ref the remounted node got no listeners at all: the signal badge sat on "Acquiring" for the whole session while audio played, and stall/error recovery was dead (issue #1232). Skins still read `audioRef` for the Web Audio tap. All controller fetches go through `lib/stationClient.ts` (install-level calls — themes, onboarding — use `defaultStationClient`, always same-origin). Install-level page effects (first-run redirect, audience beacon) live in `components/player/PlayerPageEffects.tsx`, mounted by `/` and `/listen` only — never by showcase embeds.

PWA-installable (`app/manifest.js`, `app/icon.js`, dynamic icon/screenshot routes via `next/og` ImageResponse — mind Satori's constraints). `useMediaSession` wires OS lock-screen / headphone / car controls; **skip is intentionally omitted** on the listener side so a stray AirPods double-tap doesn't skip for everyone.

Stream URL + API base default to same-origin (`/api`, `/stream.mp3`) for the prod image; dev overrides via `web/.env.local` (`NEXT_PUBLIC_API_URL=http://localhost:7701`, `NEXT_PUBLIC_STREAM_URL=http://localhost:7702/stream.mp3`).

**Landing "Press Run" gallery.** The landing page's skin/theme interlude
(`components/what/PressRun.tsx`) renders the 8 curated skin×theme screenshots
in `public/screenshots/gallery/`, defined in `lib/press-run-plates.ts` (every
skin at least once, every built-in theme exactly once). When a skin's look
changes, re-capture against a running station:
`cd web && npm i --no-save playwright sharp && npx tsx scripts/capture-gallery.mjs`.
