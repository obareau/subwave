// Version-pin helpers, shared by `subwave init` (writes the pin) and
// `subwave update` (moves it). The compose files embedded in the binary are
// frozen at its build tag while their image refs resolve
// `${SUBWAVE_VERSION:-latest}`, so an unpinned install floats on :latest and can
// drift ahead of the very compose files it's running. Pinning to the CLI's own
// release keeps the two in lockstep.

import { CLI_VERSION } from './assets.ts';

// publish-images.yml tags images with bare semver — git tag `v0.35.0` becomes
// image tag `0.35.0` — and CLI_VERSION is that same bare semver, so they map
// 1:1. A source build with no release-please bump carries `0.0.0` or worse:
// never pin to a tag that was never published, so anything that doesn't look
// like a real release returns null and the caller stays on :latest.
export function cliImageTag(): string | null {
  const v = CLI_VERSION.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(v)) return null;
  if (v === '0.0.0' || v.startsWith('0.0.0-')) return null;
  return v;
}

// Edits ONLY the pin line, leaving the rest of the file byte-for-byte intact.
// null means nothing to do — no pin line, the pin already equals `target`, or
// the pin follows a non-version tag (`latest`, `sha-…`), which is a deliberate
// follow mode and must never be silently converted into a fixed pin.
export function movePinInEnv(
  envText: string,
  target: string,
): { text: string; from: string } | null {
  const lines = envText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] as string).match(/^SUBWAVE_VERSION\s*=\s*(.*)$/);
    if (!m) continue;
    let current = (m[1] ?? '').trim();
    if (
      (current.startsWith('"') && current.endsWith('"')) ||
      (current.startsWith("'") && current.endsWith("'"))
    ) {
      current = current.slice(1, -1);
    }
    // Only migrate a concrete version pin (`0.35.0`, `0.35`, `v0.35.0`).
    if (!/^v?\d+\.\d+/.test(current)) return null;
    if (current === target) return null;
    lines[i] = `SUBWAVE_VERSION=${target}`;
    return { text: lines.join('\n'), from: current };
  }
  return null;
}
