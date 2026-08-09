// Workaround for Bun's macOS stdin bug (oven-sh/bun#13374). Launched from a
// parent whose stdin is piped — `curl … | sh → exec subwave init </dev/tty` is
// exactly that — Bun's process.stdin delivers no bytes. Everything LOOKS right
// (isTTY=true, setRawMode succeeds; verified via SUBWAVE_TTY_DEBUG=1) and reads
// simply never produce data, so a Clack prompt renders and hangs forever: no
// typing, no Ctrl-C, no kill.
//
// Bun's stdin layer isn't fixable from user code, so sidestep it — open
// /dev/tty as a fresh ReadStream and hand that to Clack as the prompt's
// `input`. @clack/core takes an `input` per prompt but the high-level wrappers
// don't forward it, hence cli/scripts/patch-clack.mjs at build time.
//
// Returns undefined where there's no /dev/tty (CI, headless), leaving Clack on
// its process.stdin default.

import { openSync } from 'node:fs';
import { ReadStream } from 'node:tty';

let cached: NodeJS.ReadStream | null | undefined;

export function getInteractiveInput(): NodeJS.ReadStream | undefined {
  if (cached !== undefined) return cached ?? undefined;

  try {
    const fd = openSync('/dev/tty', 'r');
    cached = new ReadStream(fd);
    return cached;
  } catch {
    cached = null;
    return undefined;
  }
}

// True in the configuration that triggers #13374 — a piped parent, where even
// the fresh /dev/tty stream may never deliver bytes. A direct interactive run
// has isTTY === true and is never in danger. Only ui.ts's watchdog reads this.
export function inPipedStdinDangerZone(): boolean {
  return !process.stdin.isTTY;
}
