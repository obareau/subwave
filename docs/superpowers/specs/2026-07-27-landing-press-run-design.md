# Landing page "Press Run" — skin & theme gallery

**Date:** 2026-07-27
**Status:** Approved direction (brainstorm), pending spec review

## What this is

A new full-bleed interlude on the landing broadsheet that shows every player skin (6) and every built-in theme (8) as real screenshots, styled as a slow newspaper press run. It gives the dense six-part editorial a visual pause ("breathing space") and finally puts the station's appearance system — currently absent from the landing page — on the front page.

## Decisions already made (with the operator)

- **Real image screenshots**, not CSS miniatures and not a live-player switcher.
- **Curated pairings**: 8 screenshots; every skin appears at least once, every theme exactly once.
- **Scripted capture**: a re-runnable Playwright script produces the images; outputs are checked in.
- **Layout: "The Press Run"** — two full-bleed marquee rows drifting in opposite directions, slow as a web press; hover pauses; click opens the plate large.
- **Placement: unnumbered interlude directly after `PART ONE · THE PLAYER`** (`OnTheAir`), before `PART TWO · THE DJ` (`MeetTheVoices`). Existing part numbering is untouched.
- The station has **8 built-in themes** (classic-light, classic-dark, blueprint, cyberpunk, flare, recon, signal, vinyl) — the "7" in the original ask undercounted; all 8 are included.

## The section: `web/components/what/PressRun.tsx`

New client component rendered by `web/components/Landing.tsx` between `OnTheAir` and `MeetTheVoices`. Follows the broadsheet system in `web/app/globals.css` (`bs-*` classes, sharp corners, double rules, mono captions) and the site's motion philosophy: *print, not a performance*.

### Composition

- Full-bleed block (breaks out of the article measure, like the Masthead), bounded top and bottom by `bs-rule-double`, with generous vertical padding — this is the breathing space.
- Header, centered, in the article measure:
  - eyebrow (mono, vermilion): `INTERMISSION · THE FACES`
  - headline (display font): **“Six faces. Eight coats of paint.”**
  - dek (muted): “Skins are the furniture; themes are the ink. Every listener picks their own — the broadcast underneath is the same.” (copy tunable at review)
- Two marquee rows, 4 plates each, drifting in opposite directions (row one leftward, row two rightward). Rows are offset horizontally so seams never align.

### Plates

Each plate is a screenshot in a broadsheet frame:

- sharp corners, 1px ink border, hard offset shadow (`box-shadow: Npx Npx 0 var(--ink)` — match existing landing figures);
- mono caption beneath: `PLATE No. 3 · TTY × CYBERPUNK`;
- rendered ~440px wide on desktop (large enough to read the skin's layout), scaling down on mobile.

Plate data lives in one exported const in `web/lib/press-run-plates.ts` (id, skin id, skin display name, theme id, theme display name, image path, alt text, one-line skin description). It is the single source for the strip, captions, the lightbox, and the capture script.

### The curated pairings

| # | Skin | Theme | Why |
|---|------|-------|-----|
| 1 | Classic | Classic Light | The default face on the default paper |
| 2 | Platter | Vinyl | Turntable on sepia — the natural home |
| 3 | TTY | Cyberpunk | Terminal panes in cyan/pink |
| 4 | Unit SW-9 | Flare | Milled hardware on hazard orange |
| 5 | Drift | Classic Dark | Cover-art-as-room on deep charcoal |
| 6 | Subamp | Blueprint | 1998 modular player on cobalt linework |
| 7 | Classic | Signal | The colourless press proof |
| 8 | Platter | Recon | The turntable goes tactical khaki |

(Skins repeated for plates 7–8 are the two most visually distinct faces; final pairings may be tuned by eye once captures exist, without changing the mechanism.)

### Motion

- Driven by **`motion/react`** (`motion` v12 is already a `web/` dependency — no new install): each row is a doubled track (`plates + plates` for a seamless loop) whose `x` is a `useMotionValue` advanced in `useAnimationFrame` with modulo wrap — transform-only, compositor-friendly.
- Speeds equivalent to a ≈80s loop for row one and ≈92s for row two — press-slow, and slightly different so the rows never fall into lockstep.
- Hovering (or touching) a row eases its velocity to zero over ~600ms and back on leave — a press winding down, not an abrupt CSS pause. This smooth pause/resume is the main reason Motion beats a plain CSS keyframe here.
- `useReducedMotion()`: no drift; each row degrades to a plain `overflow-x: auto` scrollable strip showing the 4 plates (no doubling).
- No scroll-linked effects beyond the existing `EditorialReveal` entrance treatment used by neighbouring sections — *print, not a performance*.

### Lightbox

- Clicking a plate opens a dialog: the screenshot at full size, its caption, and the skin's one-line description (carried in the plate data, copied from the skin registry text).
- Reuse the existing dialog primitive in `web/components/ui/` (the repo vendors shadcn-style primitives). Plates are real `<button>`s → keyboard operable; dialog handles focus trap/Escape.
- The dialog content enters with a restrained Motion fade + 0.98→1 scale; no shared-element zoom (too showy for the broadsheet).
- Do not import the skin registry (`web/components/skins/index.ts`) into the landing bundle — it would pull `next/dynamic` skin chunks. Plate data is static.

### Accessibility & performance

- Alt text per plate: “SUB/WAVE player — {skin} skin in the {theme} theme”.
- Images are plain `<img loading="lazy" decoding="async">` (matches existing landing usage of static screenshots) served from `web/public/screenshots/gallery/`.
- One asset per pairing: `{skin}-{theme}.webp` at 1600×1000, quality-tuned to roughly 100–200 KB each (≈1–1.5 MB total, lazy-loaded, below the fold).
- The doubled marquee track renders each image twice; identical URLs mean one network fetch.

## Capture pipeline: `web/scripts/capture-gallery.mjs`

A standalone Playwright script (same ad-hoc harness pattern as `web/scripts/observatory-stress.mjs`; Playwright is not a web/ dependency — run via the locally installed playwright the harness pattern documents).

- **Inputs:** `--base-url` (default `http://localhost:7700`), `--out` (default `web/public/screenshots/gallery`), optional `--only skin-theme` filter.
- **Per pairing:**
  1. Open a fresh context at 1600×1000, seed `localStorage` before load: `subwave-skin-override={skin}`, `subwave-theme-override={theme}` (per `web/lib/skin.ts` / `web/lib/theme.ts` override keys).
  2. Navigate to `/listen`, dismiss the tune-in gate (`useTuneInGate`) by clicking through it so the playing state shows.
  3. Wait for now-playing metadata and cover art to render (station must be on air; the script asserts `/api/now-playing` has a track and fails with a clear message if the stream is silent or the stack is down).
  4. Screenshot the viewport, encode WebP, write `{skin}-{theme}.webp`.
- **Pairings list** is imported from `web/lib/press-run-plates.ts` — the same module the component uses — so the strip and the captures can't drift. The script runs under `npx tsx` so it can import the TS module directly.
- Outputs are committed. Re-run manually whenever a skin's look changes; a one-line note goes in `web/CLAUDE.md`.

## Integration

- `web/components/Landing.tsx`: insert `<PressRun />` between `<OnTheAir />` and `<MeetTheVoices />`.
- New keyframes/styles: co-located in the component (Tailwind + a small `<style>`/CSS module for the marquee keyframes) — **not** in `globals.css`, matching skin rules; if the broadsheet system demands globals, keep it to two keyframes named `bs-pressrun-*`.
- No controller changes, no settings, no new routes. The section is fully static.

## Error handling

- A missing image renders the plate frame with the caption and a muted “plate missing” fill (broken-image icon suppressed) — the marquee keeps working. This state should only exist mid-development.
- The capture script is fail-fast and idempotent; partial runs can be resumed with `--only`.

## Out of scope (deliberate)

- No interactive theme switching on the landing page (screenshots are fixed pairings).
- No changes to the manual's Skins & Themes page, the admin SkinGallery, or the stale news post that says “five skins” (candidate follow-up).
- No mobile-app screenshots; this is the web player only.

## Verification

- `cd web && npm run lint` (the merge gate).
- Dev stack up → run the capture script → visually check the 8 plates.
- Landing page in dev: strip drifts slowly both directions, hover pauses, click opens lightbox, reduced-motion shows static scrollable rows, mobile widths don't overflow horizontally (`overflow-x` stays inside the strip).
- Playwright screenshot of the section for the PR description.

## Follow-ups (not in this change)

- Refresh the stale skins news post (five skins → six, Spool → Unit).
- Consider reusing the plates on the `/manual/themes` page.
