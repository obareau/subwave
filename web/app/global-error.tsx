'use client';

import { useEffect } from 'react';

// Last-resort boundary: catches throws in the ROOT layout itself, which
// app/error.tsx cannot (error.js never wraps the layout in its own segment).
//
// It REPLACES the root layout when it renders, so: it must supply its own
// <html>/<body>; globals.css is unavailable (no Tailwind, no bs- classes, no
// custom properties — hence the self-contained <style> block with palette
// values copied from globals.css); and the theme-init script is gone too, so
// the palette follows prefers-color-scheme instead of the stored preference.
//
// Metadata exports aren't supported in a client component, so the tab title is
// set with React's <title>. Styles are a <style> element because eslint forbids
// inline styles.

const CSS = `
  :root {
    --ge-bg: #f3efe6;
    --ge-ink: #161412;
    --ge-muted: #7a736a;
    --ge-accent: #d94b2a;
    --ge-rule: rgba(0, 0, 0, 0.1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ge-bg: #100e0c;
      --ge-ink: #ece6dc;
      --ge-muted: #8a8278;
      --ge-rule: rgba(255, 255, 255, 0.12);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--ge-bg);
    color: var(--ge-ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.6;
  }
  .ge-wrap { max-width: 34rem; width: 100%; }
  .ge-brand {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ge-muted);
    margin: 0 0 20px;
  }
  .ge-brand b { color: var(--ge-accent); font-weight: 700; }
  .ge-title {
    font-size: clamp(32px, 7vw, 52px);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.05;
    margin: 0 0 16px;
  }
  .ge-body { margin: 0 0 28px; color: var(--ge-muted); }
  .ge-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .ge-btn {
    font: inherit;
    font-weight: 700;
    cursor: pointer;
    padding: 10px 18px;
    color: var(--ge-bg);
    background: var(--ge-accent);
    border: 1px solid var(--ge-accent);
    border-radius: 2px;
  }
  .ge-link {
    font-weight: 600;
    color: var(--ge-ink);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .ge-ref {
    margin: 28px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--ge-rule);
    font-size: 13px;
    color: var(--ge-muted);
  }
  .ge-ref code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[subwave] global error', error.digest ?? '', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <title>SUB/WAVE — transmission fault</title>
        <style>{CSS}</style>
        <div className="ge-wrap">
          <p className="ge-brand">
            SUB<b>/</b>WAVE
          </p>
          <h1 className="ge-title">Total signal loss.</h1>
          <p className="ge-body">
            The site shell itself failed to render, so there&rsquo;s nothing left to fall
            back to. The broadcast runs in a separate container from this web UI, so the
            stream is very likely still on air.
          </p>
          <div className="ge-actions">
            {/* No router here: the root layout is gone, so a full document
                reload is the only reliable recovery. reset() is offered first in
                case the failure was transient. */}
            <button type="button" className="ge-btn" onClick={() => reset()}>
              Try again
            </button>
            <a className="ge-link" href="/listen">
              Reload the player
            </a>
          </div>
          <p className="ge-ref">
            {error.digest ? (
              <>
                Reference <code>{error.digest}</code> — matches the corresponding line in{' '}
                <code>docker compose logs web</code>.
              </>
            ) : (
              <>
                Check <code>docker compose logs web</code> for the stack trace.
              </>
            )}
          </p>
        </div>
      </body>
    </html>
  );
}
