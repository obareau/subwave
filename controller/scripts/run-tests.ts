// Test-suite runner for controller/. Auto-discovers every `scripts/*.test.ts`
// and hands the list to Node's built-in test runner (`node --test`), which runs
// each file as its own subprocess.
//
//   npm test              # run the whole suite
//   npm test -- picker    # run only files whose name matches "picker"
//
// Adding a test is still just dropping a `*.test.ts` file in here — no
// package.json edit — which is what let mix-fx.test.ts silently fall out of the
// old hand-maintained `&&` chain.
//
// Two shapes of test file coexist, deliberately:
//
//   • the ORIGINAL shape — a plain script that asserts and lets a throw or a
//     `process.exit(1)` signal failure. `node --test` reports one of these as a
//     single pass/fail keyed on the exit code, which is byte-for-byte the
//     contract this runner enforced by hand before.
//   • the node:test shape — `import { test } from 'node:test'`, one call per
//     assertion. These report per-assertion, with the failing one named and
//     everything else still shown as passing.
//
// So new tests get real reporting without a flag day, and nothing had to be
// rewritten. Prefer node:test for anything new.
//
// Concurrency is pinned to 1. Files here reach for shared ground — a temp state
// dir, the library DB, env vars — and the sequential run is the behaviour they
// were all written against; `node --test` would otherwise fan out across cores.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2]; // optional substring filter

const files = readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => f !== 'run-tests.test.ts') // guard against self-inclusion if ever added
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(filter ? `No test files match "${filter}".` : 'No *.test.ts files found.');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s)${filter ? ` matching "${filter}"` : ''}:\n`);

// `--import tsx` is what lets the runner load .ts directly; it is passed to the
// runner AND inherited by each test subprocess. The spec reporter is forced so
// output reads the same locally and in a non-TTY (where the default is TAP).
const { status } = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    ...files.map((f) => join(scriptsDir, f)),
  ],
  { stdio: 'inherit' },
);

process.exit(status ?? 1);
