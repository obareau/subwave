# Landing Press Run (skin & theme gallery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "The Press Run" — a full-bleed interlude on the landing broadsheet showing 8 real screenshots (every skin once, every theme once) as two slow counter-drifting marquee rows with a lightbox, plus the Playwright script that captures the screenshots.

**Architecture:** A static plate-data module (`web/lib/press-run-plates.ts`) is the single source of truth consumed by three things: the `PressRun` landing section (Motion-driven marquee + Radix dialog lightbox), the capture script (`web/scripts/capture-gallery.mjs`), and the image filenames under `web/public/screenshots/gallery/`. No controller changes, no new routes, no new npm dependencies.

**Tech Stack:** Next.js 15 App Router, Tailwind v4 (`bs-*` broadsheet classes), `motion` v12 via `m.` + LazyMotion, Radix dialog (`components/ui/dialog.tsx`), Playwright + sharp (ad hoc, not repo deps).

**Spec:** `docs/superpowers/specs/2026-07-27-landing-press-run-design.md`

## Global Constraints

- **No new entries in `web/package.json`.** Playwright, sharp, and tsx are used ad hoc (`npm i --no-save playwright sharp`, `npx tsx`) exactly like `web/scripts/observatory-stress.mjs` documents.
- **`style` prop on DOM elements is an eslint error** (`react/forbid-dom-props`, issue #50). All static styling is Tailwind classes; the only dynamic style is the Motion value `x`, which rides an `m.div` (member-expression JSX — the rule only fires on lowercase DOM tags). If eslint flags it anyway, the fix is Tailwind + CSS var, not disabling the rule.
- **Motion imports are `m.` from `'motion/react'`** — the app root wraps everything in `<LazyMotion strict>` (`web/components/MotionProvider.tsx`); `motion.div` throws in strict mode.
- **Never touch `web/app/globals.css`** — all new styling is Tailwind utilities in the component.
- **Copy strings verbatim** (spec-approved): eyebrow `INTERMISSION · THE FACES`; headline `Six faces. Eight coats of paint.`; dek `Skins are the furniture; themes are the ink. Every listener picks their own — the broadcast underneath is the same.`
- **Lint is the merge gate:** `cd web && npm run lint` (eslint + `tsc --noEmit`) must pass after every task. `web/` has no test runner — verification steps below are lint + concrete browser/script checks.
- **Commits at the end** (operator preference): stage work as tasks complete; the commits happen in Task 5, target branch PRs to `develop`, no AI attribution in messages.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `web/lib/press-run-plates.ts` | Create | Plate data: 8 curated skin×theme pairings, display names, captions, image paths, alt text. Plain data — no React, importable by the capture script. |
| `web/components/what/PressRun.tsx` | Create | The landing section: header, two marquee rows, plate frames/captions, reduced-motion fallback, missing-image fallback, lightbox dialog. All UI in one file (it is one section; the marquee row and plate are internal components). |
| `web/components/Landing.tsx` | Modify | Mount `<PressRun />` between `<OnTheAir />` and `<MeetTheVoices />`; add `overflow-x-clip` to the root div so the `w-screen` breakout can't grow a horizontal scrollbar. |
| `web/scripts/capture-gallery.mjs` | Create | Playwright capture harness: per plate, seed skin/theme overrides, dismiss the tune-in gate, wait for art, screenshot → WebP via sharp. |
| `web/public/screenshots/gallery/*.webp` | Generate | 8 captured images, committed. |
| `web/CLAUDE.md` | Modify | One paragraph: what the gallery is, how to re-capture. |

---

### Task 1: Plate data module

**Files:**
- Create: `web/lib/press-run-plates.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `PressRunPlate` (interface), `PRESS_RUN_PLATES: readonly PressRunPlate[]` (8 entries, ordered by plate number), `PRESS_RUN_ROWS: readonly [PressRunPlate[], PressRunPlate[]]` (4/4 split). Task 2 renders these; Task 4's script validates and captures from them.

- [ ] **Step 1: Write the module**

```ts
// Plate list for the landing page's "Press Run" interlude — the single source
// of truth for the gallery strip, its captions, the lightbox, and the capture
// script (scripts/capture-gallery.mjs). Every skin appears at least once and
// every built-in theme exactly once. Plain data, no React: the capture script
// imports this from node (via tsx).

export type PressRunSkinId =
  | 'classic' | 'unit' | 'drift' | 'subamp' | 'tty' | 'platter';

export type PressRunThemeId =
  | 'classic-light' | 'classic-dark' | 'blueprint' | 'cyberpunk'
  | 'flare' | 'recon' | 'signal' | 'vinyl';

export interface PressRunPlate {
  /** `${skinId}-${themeId}` — also the image basename under public/. */
  id: string;
  /** 1-based plate number, printed in the caption. */
  no: number;
  skinId: PressRunSkinId;
  skinName: string;
  /** One-liner shown in the lightbox. Copied verbatim from the skin registry
   *  (components/skins/index.ts) — kept as plain strings so this module never
   *  drags the registry's next/dynamic wrappers into the capture script. */
  skinDescription: string;
  themeId: PressRunThemeId;
  themeName: string;
  /** Path under public/, produced by scripts/capture-gallery.mjs. */
  src: string;
  alt: string;
}

function plate(
  no: number,
  skinId: PressRunSkinId,
  skinName: string,
  skinDescription: string,
  themeId: PressRunThemeId,
  themeName: string,
): PressRunPlate {
  return {
    id: `${skinId}-${themeId}`,
    no,
    skinId,
    skinName,
    skinDescription,
    themeId,
    themeName,
    src: `/screenshots/gallery/${skinId}-${themeId}.webp`,
    alt: `SUB/WAVE player — ${skinName} skin in the ${themeName} theme`,
  };
}

export const PRESS_RUN_PLATES: readonly PressRunPlate[] = [
  plate(1, 'classic', 'Classic',
    'The original SUB/WAVE face — masthead, centre stage, waveform, transport deck.',
    'classic-light', 'Classic Light'),
  plate(2, 'platter', 'Platter',
    'The flagship vinyl face — a reference turntable is the interface, needle and all.',
    'vinyl', 'Vinyl'),
  plate(3, 'tty', 'TTY',
    'The station as a live process — panes and a status line, everything tails.',
    'cyberpunk', 'Cyberpunk'),
  plate(4, 'unit', 'Unit SW-9',
    'A tabletop receiver — milled aluminium, weighted knobs, one glowing dot-matrix window.',
    'flare', 'Flare'),
  plate(5, 'drift', 'Drift',
    'Ninety percent weather, ten percent type — the cover art becomes the room.',
    'classic-dark', 'Classic Dark'),
  plate(6, 'subamp', 'Subamp',
    "A compact modular player — deck, booth and log stacked like it's 1998.",
    'blueprint', 'Blueprint'),
  plate(7, 'classic', 'Classic',
    'The original SUB/WAVE face — masthead, centre stage, waveform, transport deck.',
    'signal', 'Signal'),
  plate(8, 'platter', 'Platter',
    'The flagship vinyl face — a reference turntable is the interface, needle and all.',
    'recon', 'Recon'),
];

/** Row split for the two marquee bands: plates 1–4 drift left, 5–8 drift right. */
export const PRESS_RUN_ROWS: readonly [PressRunPlate[], PressRunPlate[]] = [
  PRESS_RUN_PLATES.slice(0, 4),
  PRESS_RUN_PLATES.slice(4, 8),
];
```

- [ ] **Step 2: Lint**

Run: `cd web && npm run lint`
Expected: PASS (new module type-checks; the literal unions catch any typo'd skin/theme id at compile time).

---

### Task 2: PressRun section + Landing integration

**Files:**
- Create: `web/components/what/PressRun.tsx`
- Modify: `web/components/Landing.tsx` (imports at top; JSX list around lines 31–41; root div line 22)

**Interfaces:**
- Consumes: `PRESS_RUN_ROWS`, `PressRunPlate` from `@/lib/press-run-plates` (Task 1); `EditorialReveal` from `../landing/EditorialReveal`; `cn` from `@/lib/cn`; `m`, `useAnimationFrame`, `useMotionValue`, `useReducedMotion`, `useSpring` from `'motion/react'`.
- Produces: default export `PressRun` (no props). Task 3 adds the lightbox inside this same file — it must keep the `onOpen: (p: PressRunPlate) => void` prop threading on `MarqueeRow`/`Plate` intact (this task wires `onOpen` to a no-op `setActive` placeholder state that Task 3 consumes).

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  m,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'motion/react';
import EditorialReveal from '../landing/EditorialReveal';
import { PRESS_RUN_ROWS, type PressRunPlate } from '@/lib/press-run-plates';
import { cn } from '@/lib/cn';

// "The Press Run" — an unnumbered full-bleed interlude between PART ONE and
// PART TWO: every skin and every built-in theme as real screenshots, drifting
// by in two counter-moving bands, slow as paper through a web press. Hover
// (or focusing a plate) winds a band down over ~600 ms instead of freezing
// it; prefers-reduced-motion swaps the drift for plain scrollable strips.

function PlateCaption({ plate }: { plate: PressRunPlate }) {
  return (
    <span className="block text-[10px] font-medium tracking-[0.18em] text-muted uppercase">
      <span className="font-bold text-vermilion">PLATE No. {plate.no}&nbsp;</span>
      · {plate.skinName} × {plate.themeName}
    </span>
  );
}

function Plate({
  plate,
  onOpen,
  ghost = false,
}: {
  plate: PressRunPlate;
  onOpen: (p: PressRunPlate) => void;
  /** Second copy of the sequence in the seamless loop — hidden from the
   *  accessibility tree and tab order so nothing is announced twice. */
  ghost?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onOpen(plate)}
      tabIndex={ghost ? -1 : 0}
      aria-hidden={ghost || undefined}
      className="group block w-[min(440px,78vw)] shrink-0 text-left"
    >
      <span
        className={cn(
          'block aspect-[16/10] overflow-hidden border border-ink bg-overlay',
          'shadow-[5px_5px_0_0_var(--ink)] transition-transform duration-200',
          'group-hover:-translate-y-0.5 group-focus-visible:-translate-y-0.5',
        )}
      >
        {failed ? (
          <span className="flex h-full w-full items-center justify-center text-[11px] font-bold tracking-[0.24em] text-muted uppercase">
            Plate missing
          </span>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- static
             public/ asset in a horizontally-moving track; next/image adds
             nothing here (no remote loader, fixed intrinsic size). */
          <img
            src={plate.src}
            alt={plate.alt}
            width={1600}
            height={1000}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="block h-full w-full object-cover"
          />
        )}
      </span>
      <span className="mt-2 block">
        <PlateCaption plate={plate} />
      </span>
    </button>
  );
}

function MarqueeRow({
  plates,
  direction,
  durationSec,
  offsetFraction = 0,
  onOpen,
}: {
  plates: PressRunPlate[];
  direction: 'left' | 'right';
  /** Seconds for one full pass of the sequence. */
  durationSec: number;
  /** Initial phase (0–1) so the two rows' seams never align. */
  offsetFraction?: number;
  onOpen: (p: PressRunPlate) => void;
}) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  // 1 = drifting, 0 = paused; the spring is the "press winding down" ease.
  const throttle = useMotionValue(1);
  const factor = useSpring(throttle, { stiffness: 40, damping: 15 });
  const trackRef = useRef<HTMLDivElement | null>(null);
  const halfRef = useRef(0);

  useEffect(() => {
    if (reduced) return;
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      const half = el.scrollWidth / 2;
      if (halfRef.current === 0 && half > 0) {
        // First measure: phase-shift the band so row seams stay unaligned.
        x.set(-half * offsetFraction);
      }
      halfRef.current = half;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [reduced, offsetFraction, x]);

  useAnimationFrame((_, delta) => {
    const half = halfRef.current;
    if (reduced || half === 0) return;
    const dir = direction === 'left' ? -1 : 1;
    const pxPerMs = half / (durationSec * 1000);
    const next = x.get() + dir * pxPerMs * delta * factor.get();
    // Wrap into (-half, 0] so the doubled track loops seamlessly either way.
    x.set(((next % half) + half) % half - half);
  });

  if (reduced) {
    return (
      <div className="overflow-x-auto">
        <div className="flex w-max gap-6 px-6 pb-2">
          {plates.map(p => (
            <Plate key={p.id} plate={p} onOpen={onOpen} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden"
      onPointerEnter={() => throttle.set(0)}
      onPointerLeave={() => throttle.set(1)}
      onFocus={() => throttle.set(0)}
      onBlur={() => throttle.set(1)}
    >
      <m.div ref={trackRef} className="flex w-max gap-6" style={{ x }}>
        {plates.map(p => (
          <Plate key={p.id} plate={p} onOpen={onOpen} />
        ))}
        {plates.map(p => (
          <Plate key={`${p.id}-ghost`} plate={p} onOpen={onOpen} ghost />
        ))}
      </m.div>
    </div>
  );
}

export default function PressRun() {
  const [, setActive] = useState<PressRunPlate | null>(null); // lightbox lands in the next task

  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">INTERMISSION · THE FACES</p>
      <h2>Six faces. Eight coats of paint.</h2>
      <p className="text-muted">
        Skins are the furniture; themes are the ink. Every listener picks their
        own — the broadcast underneath is the same.
      </p>

      <div className="relative left-1/2 w-screen -translate-x-1/2">
        <div className="bs-rule-double" />
        <div className="flex flex-col gap-8 py-10">
          <MarqueeRow
            plates={PRESS_RUN_ROWS[0]}
            direction="left"
            durationSec={80}
            onOpen={setActive}
          />
          <MarqueeRow
            plates={PRESS_RUN_ROWS[1]}
            direction="right"
            durationSec={92}
            offsetFraction={0.4}
            onOpen={setActive}
          />
        </div>
        <div className="bs-rule-double" />
      </div>
    </EditorialReveal>
  );
}
```

Implementation notes for this step:
- If `better-tailwindcss/no-unknown-classes` rejects `shadow-[5px_5px_0_0_var(--ink)]`, use `shadow-[5px_5px_0_0]` + `shadow-ink` (Tailwind v4 resolves `--color-*`-mapped tokens; `border-ink` already works in `Figure.tsx`, so `shadow-ink` should too).
- If `react/forbid-dom-props` fires on the `m.div` `style={{ x }}`: that means the rule config also covers member-expression components — check how `components/ui/editor-dialog.tsx` passes animation values to `m.div` and mirror it exactly.
- The `eslint-disable-next-line @next/next/no-img-element` is only needed if that Next plugin rule is active; drop the comment if lint passes without it (check first — `Figure.tsx` uses `m.img` without a disable).

- [ ] **Step 2: Mount it in `Landing.tsx`**

In `web/components/Landing.tsx`:

```tsx
import PressRun from './what/PressRun';
```

and in the JSX (the `w-screen` breakout needs an ancestor clip so the page never
gets a horizontal scrollbar — `100vw` includes the vertical-scrollbar gutter):

```tsx
    <div className="min-h-screen overflow-x-clip bg-bg text-ink">
```

```tsx
        <OnTheAir stations={stations} />
        <PressRun />
        <MeetTheVoices />
```

- [ ] **Step 3: Lint**

Run: `cd web && npm run lint`
Expected: PASS.

- [ ] **Step 4: Visual check (images don't exist yet — placeholder state)**

Run the web dev server (from the worktree: `cd web && npm run dev`, or against an already-running dev stack) and open `http://localhost:7700/landing`.
Expected: between PART ONE and PART TWO, a full-bleed band bounded by double rules; two rows of 8 framed "PLATE MISSING" boxes with plate captions, drifting slowly in opposite directions; hover eases a row to a stop; no horizontal scrollbar on the page; with OS reduced-motion enabled (or DevTools emulation), rows are static and scrollable.

---

### Task 3: Lightbox dialog

**Files:**
- Modify: `web/components/what/PressRun.tsx`

**Interfaces:**
- Consumes: `Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription` from `@/components/ui/dialog`; the `active` state + `setActive` wired by Task 2.
- Produces: nothing new outside the file.

- [ ] **Step 1: Wire the state and dialog**

In `PressRun()`, replace the placeholder state line with:

```tsx
  const [active, setActive] = useState<PressRunPlate | null>(null);
```

and append inside the `<EditorialReveal>` (after the breakout div):

```tsx
      <Dialog open={active !== null} onOpenChange={open => { if (!open) setActive(null); }}>
        <DialogContent className="max-w-[min(1100px,94vw)] gap-0 rounded-none border-ink bg-bg p-0 sm:rounded-none">
          {active && (
            <m.figure
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
              className="m-0"
            >
              <img
                src={active.src}
                alt={active.alt}
                width={1600}
                height={1000}
                className="block h-auto w-full border-b border-ink"
              />
              <figcaption className="flex flex-col gap-1 p-4">
                <DialogTitle className="text-[11px] font-medium tracking-[0.18em] text-muted uppercase">
                  <span className="font-bold text-vermilion">PLATE No. {active.no}&nbsp;</span>
                  · {active.skinName} × {active.themeName}
                </DialogTitle>
                <DialogDescription className="text-[14px] leading-[1.5] text-ink">
                  {active.skinDescription}
                </DialogDescription>
              </figcaption>
            </m.figure>
          )}
        </DialogContent>
      </Dialog>
```

with the import added:

```tsx
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
```

Implementation notes:
- Check `components/ui/dialog.tsx`'s `DialogContent` default classes before overriding — the goal is a sharp-cornered, ink-bordered, paper-backed panel; adjust the override list to whatever the primitive actually sets (e.g. it may not set `rounded-*` at all, making both `rounded-none` overrides unnecessary).
- Radix requires a `DialogTitle` for accessibility — it doubles as the caption here, so no visually-hidden extra node is needed.

- [ ] **Step 2: Lint**

Run: `cd web && npm run lint`
Expected: PASS.

- [ ] **Step 3: Behavior check**

On `/landing`: click a plate → dialog opens with the (missing) image area, caption, and skin description; Escape and the close button dismiss; focus returns to the plate; the marquee behind keeps drifting. Keyboard: Tab to a plate (row eases to a stop), Enter opens the dialog.

---

### Task 4: Capture script, gallery images, docs note

**Files:**
- Create: `web/scripts/capture-gallery.mjs`
- Generate: `web/public/screenshots/gallery/{classic-classic-light,platter-vinyl,tty-cyberpunk,unit-flare,drift-classic-dark,subamp-blueprint,classic-signal,platter-recon}.webp`
- Modify: `web/CLAUDE.md`

**Interfaces:**
- Consumes: `PRESS_RUN_PLATES` from `../lib/press-run-plates.ts` (run under `npx tsx` so the TS import resolves); a running station (web on `--base-url`, controller API on `--api-url`); localStorage override keys `subwave-skin-override` / `subwave-theme-override` (`web/lib/skin.ts:7`, `web/lib/theme.ts:15`) and the cache keys they shadow (`subwave-theme-tokens`, `subwave-mode-override`).
- Produces: the 8 `.webp` files whose paths Task 1 already encodes in `plate.src`.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/* ============================================================================
   SUB/WAVE — landing "Press Run" gallery capture.

   Re-run whenever a skin's look changes. Captures every plate in
   lib/press-run-plates.ts: seeds the listener skin/theme overrides, opens
   /listen, dismisses the tune-in gate, waits for cover art, screenshots at
   1600×1000, and writes WebP into public/screenshots/gallery/.

   Needs a RUNNING station with a track on air (dev stack: web on :7700,
   controller on :7701). playwright + sharp are NOT repo dependencies —
   install ad hoc, and run under tsx so the TS data module imports:

     cd web
     npm i --no-save playwright sharp
     npx tsx scripts/capture-gallery.mjs \
       [--base-url http://localhost:7700] [--api-url http://localhost:7701] \
       [--out public/screenshots/gallery] [--only tty-cyberpunk]
   ============================================================================ */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESS_RUN_PLATES } from '../lib/press-run-plates.ts';

const req = createRequire(import.meta.url);
function load(name) {
  try {
    return req(name);
  } catch {
    const dir = process.env.PLAYWRIGHT_DIR;
    if (dir) {
      try { return createRequire(join(dir, 'package.json'))(name); } catch { /* fall through */ }
    }
    console.error(`${name} is not installed here. Run \`npm i --no-save playwright sharp\``);
    console.error('or point PLAYWRIGHT_DIR at a directory whose node_modules has it.');
    process.exit(1);
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : null)).filter(Boolean),
);
const BASE = args['base-url'] || 'http://localhost:7700';
const API = args['api-url'] || 'http://localhost:7701';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = args.out || join(HERE, '..', 'public', 'screenshots', 'gallery');
const ONLY = args.only || null;

// Data invariants — fail loudly before touching a browser.
{
  const themeIds = PRESS_RUN_PLATES.map(p => p.themeId);
  const skinIds = new Set(PRESS_RUN_PLATES.map(p => p.skinId));
  if (PRESS_RUN_PLATES.length !== 8) throw new Error('expected exactly 8 plates');
  if (new Set(themeIds).size !== PRESS_RUN_PLATES.length) throw new Error('every theme must appear exactly once');
  if (skinIds.size !== 6) throw new Error('every skin must appear at least once');
}

const { chromium } = load('playwright');
const sharp = load('sharp');

// The station must actually be broadcasting — a silent player screenshots as
// an empty face and lies about every skin.
const nowRes = await fetch(`${API}/api/now-playing`).catch(() => null);
const now = nowRes && nowRes.ok ? await nowRes.json() : null;
if (!now || !now.title) {
  console.error(`No track on air at ${API}/api/now-playing — start the dev stack and wait for a track.`);
  process.exit(1);
}
console.log(`On air: ${now.artist ?? '?'} — ${now.title}`);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

for (const plate of PRESS_RUN_PLATES) {
  if (ONLY && !plate.id.includes(ONLY)) continue;
  console.log(`plate ${plate.no}: ${plate.id}`);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(([skin, theme]) => {
    localStorage.setItem('subwave-skin-override', skin);
    localStorage.setItem('subwave-theme-override', theme);
    // Drop caches that could pre-paint a stale palette or pin a mode.
    localStorage.removeItem('subwave-theme-tokens');
    localStorage.removeItem('subwave-mode-override');
    localStorage.removeItem('subwave-skin-station');
  }, [plate.skinId, plate.themeId]);
  const page = await context.newPage();
  await page.goto(`${BASE}/listen`, { waitUntil: 'domcontentloaded' });

  // Theme override painted: every built-in theme is a registry palette, and
  // ThemeProvider applies palettes as inline tokens on <html>.
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--bg') !== '',
    null, { timeout: 20000 },
  );
  // Skin chunk mounted (pre-paint pending marker cleared — lib/skin.ts).
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute('data-skin-pending'),
    null, { timeout: 20000 },
  );

  // Dismiss the tune-in gate: click the skin's tune affordance if it exposes
  // one by name, otherwise Space (the shell-level tune shortcut).
  const tuneBtn = page.getByRole('button', { name: /tune in/i }).first();
  if (await tuneBtn.isVisible().catch(() => false)) {
    await tuneBtn.click().catch(() => {});
  } else {
    await page.keyboard.press('Space').catch(() => {});
  }

  // Cover art up — the strongest "this frame looks on-air" signal.
  await page.waitForFunction(
    () => Array.from(document.images).some(i => i.src.includes('/cover') && i.complete && i.naturalWidth > 0),
    null, { timeout: 30000 },
  ).catch(() => console.warn(`  [${plate.id}] cover art never settled — capturing anyway`));
  // Let idle motion settle: needle drop, spectrum warm-up, CRT flicker-in.
  await page.waitForTimeout(3000);

  const png = await page.screenshot({ type: 'png' });
  const file = join(OUT, `${plate.id}.webp`);
  await sharp(png).webp({ quality: 82 }).toFile(file);
  console.log(`  wrote ${file}`);
  await context.close();
}

await browser.close();
console.log('done.');
```

- [ ] **Step 2: Run it against a live station**

The station must be up with a track on air. From the worktree this is the dev-stack flow (`subwave-worktree-dev` skill preps the worktree; mind the dev-stack ownership rules — one stack globally):

Run: `cd web && npm i --no-save playwright sharp && npx playwright install chromium && npx tsx scripts/capture-gallery.mjs`
Expected: `On air: …` then eight `wrote …/public/screenshots/gallery/<id>.webp` lines, no gate-visible frames.

- [ ] **Step 3: Eyeball every capture**

Open each of the 8 files. Check per file: the right skin, the right palette (e.g. `classic-signal` is grey-on-grey, `unit-flare` floods hazard orange), cover art visible, no tune-in overlay, no half-loaded UI. If one plate shows its gate, that skin's tune affordance isn't matched by `/tune in/i` — find its overlay button (`grep -rn "tune" web/components/skins/<id>/`), extend the selector chain, re-run with `--only <id>`.
Also check total payload: `du -h web/public/screenshots/gallery/` — target ≤ ~1.5 MB total; if a file balloons past ~250 KB, lower the `quality` to 75 and re-run.

- [ ] **Step 4: Re-check `/landing`**

Reload `/landing`: real screenshots now fill the plates (no `PLATE MISSING`), lightbox shows the full-size capture.

- [ ] **Step 5: Document in `web/CLAUDE.md`**

Append to the end of `web/CLAUDE.md`:

```markdown
**Landing "Press Run" gallery.** The landing page's skin/theme interlude
(`components/what/PressRun.tsx`) renders the 8 curated skin×theme screenshots
in `public/screenshots/gallery/`, defined in `lib/press-run-plates.ts` (every
skin at least once, every built-in theme exactly once). When a skin's look
changes, re-capture against a running station:
`cd web && npm i --no-save playwright sharp && npx tsx scripts/capture-gallery.mjs`.
```

- [ ] **Step 6: Lint**

Run: `cd web && npm run lint`
Expected: PASS (the `.mjs` script is outside the TS project's strict rules but must not break `eslint .`).

---

### Task 5: Full verification, commits, draft PR

**Files:**
- No new files; commits + PR.

**Interfaces:**
- Consumes: everything above.
- Produces: commits on `worktree-landing-press-run` (which already carries the spec + this plan), a pushed branch, a draft PR **targeting `develop`** (never `main` — release-please owns it).

- [ ] **Step 1: Full lint + sanity sweep**

Run: `cd web && npm run lint`
Expected: PASS.
Then on `/landing` (desktop viewport): rows drift at press speed in opposite directions with unaligned seams; hover winds a row down smoothly (~600 ms), leave winds it back up; click → lightbox with caption + description; Escape closes.

- [ ] **Step 2: Reduced-motion and mobile checks**

- DevTools → Rendering → emulate `prefers-reduced-motion: reduce` → rows are static, horizontally scrollable, all 4 plates per row reachable.
- 390 px viewport: plates shrink to 78vw, no page-level horizontal scrollbar, captions don't wrap into the next plate.

- [ ] **Step 3: Grab a section screenshot for the PR**

With Playwright or a browser, capture the Press Run section on `/landing` to `$CLAUDE_JOB_DIR/tmp/press-run-section.png` — it goes in the PR body.

- [ ] **Step 4: Commit (code, then images)**

```bash
git add web/lib/press-run-plates.ts web/components/what/PressRun.tsx \
        web/components/Landing.tsx web/scripts/capture-gallery.mjs web/CLAUDE.md
git commit -m "feat(web): add Press Run skin/theme gallery to the landing page"
git add web/public/screenshots/gallery/
git commit -m "docs: capture the 8 Press Run gallery plates"
```

- [ ] **Step 5: Push and open a draft PR against develop**

```bash
git push -u origin worktree-landing-press-run
gh pr create --draft --base develop \
  --title "feat(web): landing Press Run — every skin and theme on the front page" \
  --body "<summary of the section, the 8 pairings, the capture script, the spec/plan paths, and the section screenshot>"
```

Expected: draft PR URL. No AI attribution anywhere in the body.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** interlude placement (T2), curated pairings incl. every-theme-once (T1, asserted in T4's script), Motion marquee with wind-down hover + differing speeds + seam offset (T2), reduced-motion fallback (T2), lightbox with description + restrained entrance (T3), missing-image fallback (T2), capture script sharing the data module + fail-fast preflight + `--only` resume (T4), committed WebPs at 1600×1000 (T4), CLAUDE.md note (T4), lint-gate verification and PR flow (T5). Copy strings match the spec verbatim.
- **Deviation from spec, deliberate:** spec's "≈1600×1000, ~100–200 KB each" is enforced as an eyeball + `du` check with a quality fallback, since WebP size depends on the skin's texture.
- **Type consistency:** `PressRunPlate`/`PRESS_RUN_PLATES`/`PRESS_RUN_ROWS` names match across T1/T2/T4; `onOpen` threading T2→T3; image basenames = `plate.id` in both T1 (`src`) and T4 (output filename).
- **Placeholders:** none — all code is written out.
