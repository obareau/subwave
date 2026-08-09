// `subwave stop` — `docker compose down` for the live env, never with `-v`
// (that wipes state). The confirm defaults to no on prod, where listeners are
// on the line, and to yes on dev.

import { detectCompose, isProdEnv } from '../compose.ts';
import { composeDown } from '../docker.ts';
import { exitIfCancelled, ok, err, info, muted, p, pc, pauseForEnter, header } from '../ui.ts';
import { stopWebDev } from '../web-dev.ts';

export async function runStopCommand(): Promise<void> {
  const current = detectCompose();
  if (current.env === 'down' || !current.file) {
    header('Nothing to stop');
    info('stack is already down.');
    await pauseForEnter();
    return;
  }

  const yes = exitIfCancelled(await p.confirm({
    message: isProdEnv(current.env)
      ? `Stop the ${pc.red(pc.bold(current.env))} stack? Listeners will hear silence.`
      : `Stop the ${pc.bold('dev')} stack?`,
    initialValue: current.env === 'dev',
  }));
  if (!yes) {
    muted('cancelled.');
    return;
  }

  header(`Stopping ${current.env} stack`);
  muted(`docker compose -f ${current.file.file} down`);
  console.log();

  const code = await composeDown(current.file);
  if (code !== 0) {
    err(`docker compose exited ${code}`);
  } else {
    ok('stack stopped.');
  }

  // The dev web server lives outside docker, so composeDown missed it. In prod
  // web is a compose service and is already down.
  if (current.env === 'dev') {
    const r = stopWebDev();
    if (r.stopped) {
      ok('web dev server stopped.');
    } else if (r.reason && r.reason !== 'not running') {
      muted(`web dev: ${r.reason}`);
    }
  }

  await pauseForEnter();
}
