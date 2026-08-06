// The schema mirror generator. Everything here guards the same property: the
// output is ONE FLAT FILE, so mistakes that are harmless in separate modules
// (a duplicated module-private name, a differently-quoted zod import) become
// broken generated code. They must fail HERE, naming the source file — not
// downstream as a tsc error inside a file developers are told never to edit,
// and never silently, since the drift check compares the mirror to its sources
// and passes happily when the mirror faithfully reproduces the collision.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { buildMirror, collectDeclarations } = await import('./gen-schemas.js');

const HERE = dirname(fileURLToPath(import.meta.url));

const mod = (file: string, source: string) => ({ file, source });
const ZOD = "import { z } from 'zod';";

// --- collision guard ---

test('rejects the same top-level name declared by two modules', () => {
  // The real case: a generic name like `ID_RE` that two schema modules would
  // each declare for their own feature. webhook.ts avoids it by naming its one
  // WEBHOOK_ID_RE, which is the fix this guard exists to force.
  assert.throws(
    () =>
      buildMirror([
        mod('webhook.ts', `${ZOD}\nconst ID_RE = /^a$/;\nexport const a = z.string();`),
        mod('persona.ts', `${ZOD}\nconst ID_RE = /^b$/;\nexport const b = z.string();`),
      ]),
    (e: Error) => {
      // Both files and the identifier, or the message doesn't point at the cause.
      assert.match(e.message, /ID_RE/);
      assert.match(e.message, /schemas\/webhook\.ts/);
      assert.match(e.message, /schemas\/persona\.ts/);
      return true;
    },
  );
});

test('the collision guard covers every top-level declaration form', () => {
  const forms = [
    ['const', 'const X = 1;'],
    ['let', 'let X = 1;'],
    ['var', 'var X = 1;'],
    ['function', 'function X() {}'],
    ['class', 'class X {}'],
    ['type', 'type X = string;'],
    ['interface', 'interface X { a: string }'],
    ['enum', 'enum X { A }'],
  ] as const;
  for (const [label, decl] of forms) {
    for (const second of forms) {
      assert.throws(
        () => buildMirror([mod('a.ts', `${ZOD}\n${decl}`), mod('b.ts', `${ZOD}\n${second[1]}`)]),
        /duplicate top-level name "X"/,
        `${label} vs ${second[0]} should collide`,
      );
    }
  }
});

test('exported and module-private declarations collide alike', () => {
  assert.throws(
    () =>
      buildMirror([
        mod('a.ts', `${ZOD}\nexport const LIMIT = 16;`),
        mod('b.ts', `${ZOD}\nconst LIMIT = 4;`),
      ]),
    /duplicate top-level name "LIMIT"/,
  );
});

test('rejects a module declaring `z`, which the mirror preamble already imports', () => {
  assert.throws(
    () => buildMirror([mod('a.ts', `${ZOD}\nconst z2 = 1;\nconst z = 1;`)]),
    /duplicate top-level name "z"/,
  );
});

test('indented (nested) names never collide — only the top level shares a scope', () => {
  const out = buildMirror([
    mod('a.ts', `${ZOD}\nexport function f() {\n  const inner = 1;\n  return inner;\n}`),
    mod('b.ts', `${ZOD}\nexport function g() {\n  const inner = 2;\n  return inner;\n}`),
  ]);
  assert.match(out, /export function f/);
  assert.match(out, /export function g/);
});

test('collectDeclarations judges nesting by syntax, not by indentation', () => {
  const names = collectDeclarations(
    [
      'export const A = 1;',
      'type B = string;',
      'function c() {}',
      // Indented but still a top-level statement: it genuinely does share the
      // mirror's one scope. A line-wise collector skipped it on the leading
      // whitespace alone and so could not have caught it colliding.
      '  const D = 1;',
      // Genuinely nested, and so genuinely unable to collide.
      'function e() {\n  const inner = 1;\n  return inner;\n}',
    ].join('\n'),
  );
  assert.deepEqual(names, ['A', 'B', 'c', 'D', 'e']);
});

test('the collision guard covers the forms a line-wise collector missed', () => {
  // Each pair declares X two different ways. Every one of these silently
  // produced a mirror with two X declarations before the collector was parsed
  // rather than pattern-matched.
  const pairs: Array<[string, string, string]> = [
    ['export default function', 'export default function X() {}', 'function X() {}'],
    ['second declarator', 'export const A = 1, X = 2;', 'const X = 3;'],
    ['object destructure', 'const { X } = { X: 1 };', 'const X = 2;'],
    ['renamed destructure', 'const { a: X } = { a: 1 };', 'const X = 2;'],
    ['array destructure', 'const [X] = [1];', 'const X = 2;'],
    ['nested destructure', 'const { a: { X } } = { a: { X: 1 } };', 'const X = 2;'],
    ['renamed export', 'const q = 1;\nexport { q as X };', 'const X = 2;'],
    ['declare const', 'declare const X: number;', 'const X = 2;'],
  ];
  for (const [label, a, b] of pairs) {
    assert.throws(
      () => buildMirror([mod('a.ts', `${ZOD}\n${a}`), mod('b.ts', `${ZOD}\n${b}`)]),
      /duplicate top-level name "X"/,
      `${label} should collide`,
    );
  }
});

test('two default exports collide — one flat file carries one default', () => {
  assert.throws(
    () =>
      buildMirror([
        mod('a.ts', `${ZOD}\nexport default z.string();`),
        mod('b.ts', `${ZOD}\nexport default z.number();`),
      ]),
    /duplicate top-level name "default"/,
  );
});

test('a module re-exporting its own declaration does not collide with itself', () => {
  // `const a` then `export { a }` is ONE name introduced once. Counting the
  // binding and the export separately would make every such module fail.
  const out = buildMirror([mod('a.ts', `${ZOD}\nconst a = z.string();\nexport { a };`)]);
  assert.match(out, /export \{ a \}/);
});

// --- zod import strip ---
// eslint's zod-only restriction is not quote- or semicolon-sensitive, so every
// form that lints clean has to be recognised here or its import survives into
// the mirror and redeclares `z`.

test('strips the zod import whatever the quote style or semicolon', () => {
  for (const line of [
    "import { z } from 'zod';",
    'import { z } from "zod";',
    "import { z } from 'zod'",
    'import {z} from "zod"',
    "import  {  z  }  from  'zod' ;",
  ]) {
    const out = buildMirror([mod('a.ts', `${line}\nexport const a = z.string();`)]);
    const imports = out.split('\n').filter((l) => /^import\b/.test(l));
    assert.deepEqual(imports, ["import { z } from 'zod';"], `not stripped: ${line}`);
  }
});

test('rejects zod import forms the mirror cannot reproduce', () => {
  // Deliberate: a namespace import is not the same binding as a named one, and
  // extra named bindings would simply vanish. Reject loudly rather than rewrite.
  for (const line of [
    "import * as z from 'zod';",
    'import * as zod from "zod";',
    "import { z, type ZodType } from 'zod';",
    "import z from 'zod';",
    "import { ZodType } from 'zod';",
  ]) {
    assert.throws(
      () => buildMirror([mod('a.ts', `${line}\nexport const a = 1;`)]),
      (e: Error) => {
        assert.match(e.message, /schemas\/a\.ts/);
        assert.match(e.message, /import \{ z \} from 'zod'/);
        return true;
      },
      `should have been rejected: ${line}`,
    );
  }
});

test('rejects a multi-line zod import, whose tail a line-wise strip would miss', () => {
  // The opening `import {` names no specifier, so only the tail identifies it.
  for (const src of [
    "import {\n  z,\n} from 'zod';\nexport const a = 1;",
    "import {\n  z,\n}\nfrom 'zod';\nexport const a = 1;",
  ]) {
    assert.throws(() => buildMirror([mod('a.ts', src)]), /schemas\/a\.ts/, src);
  }
});

test("a comment mentioning \"from 'zod'\" is not mistaken for an import", () => {
  // webhook.ts's own header says "this file may import ONLY from 'zod'".
  const out = buildMirror([
    mod('a.ts', `// this file may import ONLY from 'zod'.\n${ZOD}\nexport const a = z.string();`),
  ]);
  assert.match(out, /may import ONLY from 'zod'/);
});

test('strips a canonical zod import even when indented', () => {
  // The strip cuts the node the parse validated, not a line matched at column
  // zero — so an indented import cannot survive it and redeclare `z`.
  const out = buildMirror([mod('a.ts', `  ${ZOD}\nexport const a = z.string();`)]);
  assert.deepEqual(
    out.split('\n').filter((l) => /^\s*import\b/.test(l)),
    ["import { z } from 'zod';"],
  );
});

// --- everything that is not zod ---

test('rejects a module referencing anything but zod', () => {
  // Each of these used to be copied VERBATIM into the mirror with no error at
  // all: the strip only ever recognised zod imports, so a project path, a node
  // builtin or a controller-only package sailed through and broke the web
  // build instead — inside a generated file nobody is allowed to edit.
  for (const line of [
    "import { mintId } from '../settings/vocab.js';",
    "import type { Webhook } from './webhook.js';",
    "import { readFileSync } from 'node:fs';",
    "import express from 'express';",
    "import * as path from 'node:path';",
    "import './side-effect.js';",
  ]) {
    assert.throws(
      () => buildMirror([mod('a.ts', `${ZOD}\n${line}\nexport const a = z.string();`)]),
      (e: Error) => {
        assert.match(e.message, /schemas\/a\.ts/);
        assert.match(e.message, /\*-server\.ts/);
        return true;
      },
      `should have been rejected: ${line}`,
    );
  }
});

test('rejects a re-export with a module specifier, which no import check sees', () => {
  // `export … from` references another module exactly like an import does and
  // breaks the mirror exactly the same way, but does not start with `import`.
  for (const line of [
    "export { thing } from './other.js';",
    "export * from './other.js';",
    "export * as ns from './other.js';",
    "export type { Thing } from './other.js';",
  ]) {
    assert.throws(
      () => buildMirror([mod('a.ts', `${ZOD}\n${line}\nexport const a = z.string();`)]),
      /schemas\/a\.ts/,
      `should have been rejected: ${line}`,
    );
  }
});

test('the rejection names the offending specifier', () => {
  assert.throws(
    () => buildMirror([mod('a.ts', `${ZOD}\nimport { mintId } from '../settings/vocab.js';`)]),
    /\.\.\/settings\/vocab\.js/,
  );
});

test('a plain `export { a }` with no module specifier is left alone', () => {
  // Only a `from` clause references another module. Re-exporting a local
  // declaration is ordinary and must keep working.
  const out = buildMirror([mod('a.ts', `${ZOD}\nconst a = z.string();\nexport { a };`)]);
  assert.match(out, /export \{ a \}/);
});

test('a module needing no zod at all is mirrored as-is', () => {
  const out = buildMirror([mod('a.ts', 'export const LIMIT = 16;')]);
  assert.match(out, /export const LIMIT = 16;/);
});

// --- the two zod runtimes ---

test('controller and web declare the same zod version', () => {
  // The drift check only proves the mirror is the same TEXT. If the two
  // packages resolve different zod builds, the schema the form runs and the
  // schema the route runs can still disagree — which is the one property this
  // whole mechanism exists to guarantee. CI asserts this too (lint.yml,
  // controller leg); this is the copy that fails locally in `npm test`.
  const read = (p: string) => JSON.parse(readFileSync(join(HERE, '..', p), 'utf8'));
  const controller = read('package.json').dependencies.zod;
  const web = read(join('..', 'web', 'package.json')).dependencies.zod;
  assert.equal(
    controller,
    web,
    `zod version mismatch: controller ${controller} vs web ${web} — the schema mirror is copied text, so both packages must run the same zod.`,
  );
});
