// Apply dynamic CSS variables / properties to a DOM node without inline
// `style={…}`, which the strict lint rule (issue #50) forbids. Mutating the live
// `HTMLElement.style` via the DOM API isn't intercepted by that rule, so genuinely
// dynamic per-element values work without widening it.

import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

export type StyleVars = Record<string, string | number | null | undefined>;

/** `removeProperty` takes the hyphenated CSS name, so clearing a camelCase key
 *  like `marginBottom` silently no-ops and the property sticks forever (setting
 *  works either way, which is why only clears were bitten). Custom properties
 *  are case-sensitive and already hyphenated — leave them exactly as given. */
function cssName(key: string): string {
  return key.startsWith('--') ? key : key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

export function useDynamicStyle<E extends HTMLElement | SVGElement>(
  ref: RefObject<E | null>,
  vars: StyleVars,
): void {
  // Cheap key so the effect only re-runs when a value actually changes.
  const key = Object.entries(vars)
    .map(([k, v]) => `${k}:${v == null ? '' : String(v)}`)
    .join('|');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const [k, v] of Object.entries(vars)) {
      if (v == null || v === '') {
        el.style.removeProperty(cssName(k));
        continue;
      }
      // CSS variables need setProperty; plain properties assign directly.
      if (k.startsWith('--')) el.style.setProperty(k, String(v));
      else (el.style as unknown as Record<string, string>)[k] = String(v);
    }
    // `vars` is tracked via the stringified `key`, not as a deep dep, so a
    // caller passing a fresh object literal doesn't reset it every render.
  }, [key, ref, vars]);
}
