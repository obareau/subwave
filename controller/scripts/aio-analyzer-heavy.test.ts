// Regression tests for the AIO supervisor's ANALYZER_HEAVY warning
// (docker/aio/supervisor.sh: warn_if_analyzer_heavy_ignored).
//
// ANALYZER_HEAVY picks an image TAG, and it does it by docker-compose variable
// interpolation (`subwave-analyzer${ANALYZER_HEAVY:+-heavy}`). The all-in-one
// image has no analyzer service to select — CLAP and Demucs are baked into the
// venv at build time — so the variable is unreachable there, not merely
// unsupported. #1300 bug 9: operators set it, watch nothing change, and
// conclude stem transitions are broken. The caveat existed in docs/unraid.md
// and the doctor; nothing said it at the moment they were looking.
//
// The load-bearing properties:
//   1. Set + lean build  -> a warning that names the -aio-heavy IMAGE, since
//      that is the only thing that actually changes the outcome.
//   2. Set + heavy build -> a note, not a warning. The variable is still inert,
//      but the capability the operator wanted is present, so there is nothing
//      to fix and a red herring would send them chasing it.
//   3. Unset             -> silence on both builds. This runs on every AIO boot.
//
// Run: `tsx scripts/aio-analyzer-heavy.test.ts`.
//
// node:assert-via-tsx style, matching scripts/aio-log-link.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(here, '..', '..', 'docker', 'aio', 'supervisor.sh');

assert.ok(existsSync(SUPERVISOR), `supervisor.sh not found at ${SUPERVISOR}`);

// Drive warn_if_analyzer_heavy_ignored() against a scratch venv by sourcing the
// supervisor in library mode. Returns its stderr (the log lines the operator
// would see in `docker logs`), folded into stdout.
function runWarn(venvDir: string, analyzerHeavy: string | null): string {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SUBWAVE_ANALYZER_VENV: venvDir,
  };
  if (analyzerHeavy === null) delete env.ANALYZER_HEAVY;
  else env.ANALYZER_HEAVY = analyzerHeavy;
  return execFileSync(
    'bash',
    [
      '-c',
      `set -u; SUBWAVE_SUPERVISOR_LIB=1 source "$1"; warn_if_analyzer_heavy_ignored 2>&1`,
      'bash',
      SUPERVISOR,
    ],
    { env, encoding: 'utf8' },
  );
}

// A lean venv: librosa only, no torch. Mirrors WITH_CLAP=0.
function leanVenv(root: string): string {
  const venv = join(root, 'venv');
  mkdirSync(join(venv, 'lib', 'python3.13', 'site-packages', 'librosa'), { recursive: true });
  return venv;
}

// A heavy venv: torch present, the thing that actually makes CLAP/Demucs work.
function heavyVenv(root: string): string {
  const venv = leanVenv(root);
  const torch = join(venv, 'lib', 'python3.13', 'site-packages', 'torch');
  mkdirSync(torch, { recursive: true });
  writeFileSync(join(torch, '__init__.py'), '');
  return venv;
}

const tmp = mkdtempSync(join(tmpdir(), 'subwave-aio-heavy-'));
let failures = 0;

function scenario(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log('aio ANALYZER_HEAVY warning');

// 1. The reported case: set on a lean AIO. Must warn, and must name the image
//    swap — the variable itself is a dead end, so repeating it would be the
//    same non-advice the operator already followed.
scenario('set on a lean build warns and names the -aio-heavy image', () => {
  const out = runWarn(leanVenv(mkdtempSync(join(tmp, 'lean-'))), '1');
  assert.match(out, /WARNING: ANALYZER_HEAVY is set, and it does NOTHING/);
  assert.match(out, /subwave-aio-heavy/);
  // Pointing an AIO operator at the bare analyzer image replaces their whole
  // station with an analysis micro-service (#966), so the warning has to
  // disclaim it rather than stay silent.
  assert.match(out, /NOT subwave-analyzer-heavy/);
});

// 2. Set on a heavy build. Still inert, but the capability is there — so this
//    is a note, not a warning. Anything alarming here sends an operator whose
//    setup is FINE looking for a problem.
scenario('set on a heavy build notes without warning', () => {
  const out = runWarn(heavyVenv(mkdtempSync(join(tmp, 'heavy-'))), '1');
  assert.match(out, /no effect on/);
  assert.doesNotMatch(out, /WARNING/);
  assert.doesNotMatch(out, /###/);
});

// 3. Unset is the overwhelmingly common case and runs on every boot. Both
//    builds must say nothing at all.
scenario('unset stays silent on a lean build', () => {
  assert.equal(runWarn(leanVenv(mkdtempSync(join(tmp, 'lean-quiet-'))), null).trim(), '');
});
scenario('unset stays silent on a heavy build', () => {
  assert.equal(runWarn(heavyVenv(mkdtempSync(join(tmp, 'heavy-quiet-'))), null).trim(), '');
});

// 4. An empty value is what `ANALYZER_HEAVY=` in a .env file yields, and it is
//    also what compose treats as unset (`${ANALYZER_HEAVY:+-heavy}` expands to
//    nothing). Warning there would contradict the compose semantics the
//    variable is named after.
scenario('empty value is treated as unset', () => {
  assert.equal(runWarn(leanVenv(mkdtempSync(join(tmp, 'lean-empty-'))), '').trim(), '');
});

rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('\nall scenarios passed');
