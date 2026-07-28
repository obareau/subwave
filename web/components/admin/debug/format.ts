// Formatting helpers shared by the debug cards.
//
// Part of the debug/ split - see ../DebugPanel.tsx.

import type { DebugIcecast } from './types';

export function oneLine(s: unknown, n = 110): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Structured-output responses and JSON user payloads (pickNextTrack,
// generateSegment, matchRequest…) are stored as compact JSON strings —
// pretty-print them for the expanded view. Free text and truncated JSON
// (older ring entries capped mid-string) fall through unchanged.
export function prettyMaybeJson(s: string): string {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
}

// Dense newsprint-tuned CodeBlock: shiki-highlighted JSON with a copy button.
// Only ever rendered inside an OPEN CallSection / ToolContent, so collapsed
// rows never pay the tokenization cost (see CallSection's open-state gate).

export function fmtListeners(icecast: DebugIcecast | undefined): string {
  if (!icecast || icecast.error) return '—';
  if (icecast.listeners != null) return `${icecast.listeners} listeners`;
  return 'up';
}

export function kindTone(k?: string): string {
  switch (k) {
    case 'error':
    case 'miss':
      return 'danger';
    case 'queued':
    case 'scheduler':
      return 'muted';
    default:
      return 'accent';
  }
}

