// `subwave listen` / `subwave admin` — open the player or admin console in the
// operator's browser, pointed at the live stack.

import { detectCompose, webBaseFor, type ComposeEnv } from '../compose.ts';
import { openUrl } from '../util.ts';
import { exitIfCancelled, header, info, warn, muted, p, pauseForEnter } from '../ui.ts';

export type WebTarget = 'listen' | 'admin';

const PATHS: Record<WebTarget, string> = { listen: '/listen', admin: '/admin' };
const TITLES: Record<WebTarget, string> = { listen: 'Web player', admin: 'Admin console' };

type OpenableEnv = Exclude<ComposeEnv, 'down'>;

export interface OpenWebOpts {
  envArg?: OpenableEnv;
}

export async function runOpenWebCommand(
  target: WebTarget,
  opts: OpenWebOpts = {},
): Promise<void> {
  // Explicit arg → running stack → ask. The env only decides host and port.
  let env: OpenableEnv;
  if (opts.envArg) {
    env = opts.envArg;
  } else {
    const detected = detectCompose();
    if (detected.env !== 'down') {
      env = detected.env;
    } else {
      env = exitIfCancelled(await p.select<OpenableEnv>({
        message: 'Stack is down — which env should the browser target?',
        options: [
          { value: 'dev',      label: 'dev',              hint: 'web dev server :7700' },
          { value: 'prod',     label: 'prod',             hint: 'Caddy edge :7700' },
          { value: 'prod-byo', label: 'prod (BYO proxy)', hint: 'web :7700' },
        ],
      }));
    }
  }

  const url = webBaseFor(env) + PATHS[target];
  header(TITLES[target]);
  info(`opening ${url}`);

  if (!openUrl(url)) {
    warn('could not launch a browser — open the URL above yourself.');
  } else if (env === 'dev') {
    muted('dev: if the page does not load, start the web UI with `npm --prefix web run dev`.');
  }
  await pauseForEnter();
}
