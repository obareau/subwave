'use client';

// Unsaved-work guard for an admin panel that batches edits locally and pushes
// them in one save (the Rundown's week, and anything else that grows the same
// shape). Two exits are covered:
//
//   - leaving the site / reloading the tab → the browser's own beforeunload
//     prompt, which is all a page can do there;
//   - clicking any in-app link (sidebar, breadcrumb, a card) → intercepted in
//     the CAPTURE phase before Next's router sees it, handed to the caller as
//     a href so it can ask what to do and navigate itself.
//
// Deliberately NOT covered: the browser back button. Trapping it means pushing
// a decoy history entry, which breaks back for everyone who has nothing
// pending — a worse trade than the case it saves.

import { useEffect, useRef } from 'react';

/**
 * @param active     guard only while there is something to lose.
 * @param onNavigate called with the intercepted in-app destination (path +
 *                   query + hash). The caller owns the prompt and the
 *                   subsequent `router.push`.
 */
export function useUnsavedGuard(active: boolean, onNavigate: (href: string) => void): void {
  // Held in a ref so a caller passing an inline arrow doesn't re-register the
  // listeners on every render.
  const cb = useRef(onNavigate);
  cb.current = onNavigate;

  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers still key off returnValue; the string itself is never
      // shown (browsers render their own copy).
      e.returnValue = '';
    };

    const onClick = (e: MouseEvent) => {
      // Anything but a plain left click is the operator asking for a new tab,
      // a context menu, or a download — none of which lose the pending work.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const a = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      // Off-origin navigations unload the document, so beforeunload already
      // prompts — intercepting here would double up.
      if (url.origin !== window.location.origin) return;
      // A link back to this very screen changes nothing.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);
}
