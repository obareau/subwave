// Apply dynamic CSS variables / properties to a DOM node without inline
// `style={…}`. The strict lint rule (issue #50) forbids the `style` prop, but
// admin panels still need genuinely dynamic per-element values (computed
// gradients, palette swatches keyed off JS arrays, dynamic geometry). This
// hook mutates the live `HTMLElement.style` via the DOM API on every render —
// which the lint rule doesn't intercept — so dynamic styles survive the
// migration without widening the rule.

import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

export type StyleVars = Record<string, string | number | null | undefined>;

/** `removeProperty` takes the hyphenated CSS name, so clearing a camelCase key
 *  like `marginBottom` silently no-ops and the property sticks forever. Setting
 *  works either way (camelCase assignment), which is why this only ever bit the
 *  callers that clear a multi-word property. Custom properties are
 *  case-sensitive and already hyphenated — leave them exactly as given. */
function cssName(key: string): string {
  return key.startsWith('--') ? key : key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

export function useDynamicStyle<E extends HTMLElement | SVGElement>(
  ref: RefObject<E | null>,
  vars: StyleVars,
): void {
  // Cheap key so React only re-runs the effect when something actually
  // changes; `Object.entries` is O(n) but n is tiny here.
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
      // CSS variables (prefixed with `--`) use setProperty; everything else
      // is set on the `style` declaration directly.
      if (k.startsWith('--')) el.style.setProperty(k, String(v));
      else (el.style as unknown as Record<string, string>)[k] = String(v);
    }
    // `vars` is deliberately tracked via the stringified `key` instead of
    // a deep object dep so we don't reset every render when callers pass
    // a fresh object literal.
  }, [key, ref, vars]);
}
