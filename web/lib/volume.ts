// Persisted listener volume (issue #783). Mirrored into localStorage as a
// clamped 0..1 float string; volume 0 is persisted verbatim.
//
// Reads/writes are effect-only, never during render, so there's no hydration
// mismatch: the knob renders at the default on first paint and snaps to the
// stored value a tick later.

const STORAGE_KEY = 'subwave-volume';

/** Null when nothing valid is stored, so the caller keeps its own default.
 *  Null on the server. */
export function loadVolumePref(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
  } catch {
    return null;
  }
}

/** Clamped to 0..1. Storage failures are swallowed; playback is unaffected. */
export function saveVolumePref(volume: number): void {
  if (typeof window === 'undefined') return;
  try {
    const v = Math.min(1, Math.max(0, volume));
    window.localStorage.setItem(STORAGE_KEY, String(v));
  } catch { /* private mode / quota — non-fatal */ }
}
