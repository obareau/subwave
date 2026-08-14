// The one place that answers "does this operator-supplied path point inside the
// state dir?" — for the read-only state-dir tree behind GET /debug/state-tree.
//
// Never inline this rule at a call site. Same reasoning as util/request-guard.ts
// and audio/voice-library.ts's resolve(): a second copy is a second opinion, and
// the thing on the other side of a wrong answer here is a filesystem read
// primitive over the whole host.
//
// The realpath containment check (rule 3) is what stops a symlink planted inside
// the state dir from exposing /etc or the host's music library. It is deliberately
// compatible with the documented way to relocate the stem cache, which is a BIND
// MOUNT at <state>/stems: a bind mount realpaths INSIDE root, a symlink does not.

import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Entries returned per directory listing. Read the cap as a promise to the UI:
 *  it is told the real `total`, so a truncated listing is never silent. */
export const MAX_ENTRIES = 500;

/**
 * Resolve a relative path against the state dir, or null if it escapes.
 *
 * `null` means the REQUEST was malformed (400), not that the path is missing —
 * a well-formed path that does not exist resolves fine and fails later at stat.
 */
export function resolveStatePath(root: string, rel: string): string | null {
  if (typeof rel !== 'string') return null;
  // Empty / '.' / '/' all mean the root itself.
  const raw = rel.replace(/^\/+/, '').trim();
  if (raw === '' || raw === '.') return resolve(root);
  // An absolute path is never a relative path into the tree, even after the
  // leading-slash strip above (Windows-style 'C:\' and UNC paths).
  if (isAbsolute(raw)) return null;
  if (raw.includes('\0')) return null;

  // Normalise FIRST, then refuse what is left. 'a/../b' normalises to 'b' and is
  // a legitimate path; refusing every '..' outright would reject it.
  const norm = normalize(raw);
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.includes(`${sep}..${sep}`)) return null;

  const abs = resolve(join(root, norm));
  return containedIn(resolve(root), abs) ? abs : null;
}

/** Lexical containment: `abs` is root itself or sits underneath it. */
export function containedIn(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The realpath half of the guard — resolves symlinks and re-checks containment.
 *
 * Split from `resolveStatePath` so the lexical rule stays pure and synchronous
 * (that is the part worth unit-testing exhaustively). A path that does not exist
 * yet cannot be realpath'd, so a missing target falls back to the lexical answer
 * and the caller's stat reports the real failure.
 */
export async function realStatePath(root: string, abs: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  try {
    const real = await realpath(abs);
    return containedIn(realRoot, real) ? real : null;
  } catch {
    // ENOENT (and friends): nothing to follow, so nothing can escape.
    return containedIn(realRoot, abs) ? abs : null;
  }
}
