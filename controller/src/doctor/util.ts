// Helpers shared across the checks and the review: the error-swallowing
// wrapper every section runs behind, model-error classification, and the
// formatting / disk-measurement utilities.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { Finding } from './types.js';

export async function safe(fn: () => Promise<Finding[]>): Promise<Finding[]> {
  try {
    return await fn();
  } catch (err) {
    return [{ label: 'check failed', status: 'fail', detail: err?.message || String(err) }];
  }
}

export function isSchemaFailure(c: { ok?: unknown; error?: unknown } | null | undefined): boolean {
  return !!c && c.ok === false && isSchemaErrorMessage(c.error);
}

export function isSchemaErrorMessage(err: unknown): boolean {
  if (!err) return false;
  const s = typeof err === 'string' ? err : (err as { message?: string }).message || JSON.stringify(err);
  return /invalid_type|invalid_value|invalid_enum|unrecognized_keys|Invalid (option|input)|received undefined|No object generated|did not match (the )?schema|Type validation failed/i.test(s);
}

// Cheap name-based model classification — drives warnings only. `code` flags a
// code-specialised model (poor at DJ links / structured output); `sizeB` is the
// parameter count parsed from the tag (e.g. "gemma2:9b" → 9), null when absent.
export function classifyModel(label: string): { code: boolean; sizeB: number | null } {
  const m = (label || '').toLowerCase();
  const code = /coder|codestral|\bcode\b|[-_:]code/.test(m);
  const sizeMatch = m.match(/(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/);
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : null;
  return { code, sizeB };
}

// Compact snapshot of the live performance-affecting settings, so the AI review
// can reason about the actual knob values + trade-offs (not just the findings
// that fired). Pairs with the "Tuning" section and the knowledge base.

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

// Recursive directory size, capped so a huge archive can't make the check
// expensive. Returns bytes + file count visited; missing dir → zeroes.
export async function dirSize(path: string, cap = 5000): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function walk(dir: string): Promise<void> {
    if (files >= cap) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= cap) return;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        await walk(full);
      } else {
        try {
          const s = await stat(full);
          bytes += s.size;
          files += 1;
        } catch { /* file vanished mid-walk */ }
      }
    }
  }
  await walk(path);
  return { bytes, files };
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

