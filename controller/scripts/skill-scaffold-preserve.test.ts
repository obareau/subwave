// On-disk test for writeSkillFile's preserve pass (skills/scaffold.ts).
//
// writeSkillFile REWRITES SKILL.md from typed form fields, so every line it does
// not emit is a line it deletes. That is the half of #1300 the operator hit
// second: a `feed:` added by hand vanished on the first save from the admin
// form. Declaring knobs in tool.mjs fixes the form, but not this — a rewrite
// still needs to carry through what the form doesn't own:
//
//   - a hand-authored knob a tool reads straight off `config` (never declared),
//   - `toolDescription`, which the loader reads and the form never emitted,
//   - and, load-bearingly, a DECLARED knob at a moment when the declaration
//     isn't visible: a tool.mjs that fails to import loads prompt-only, so the
//     route sees no fields, and a save then would take the values with it.
//
// The opposite must hold too: a declared knob the operator CLEARED stays
// cleared, or the form could never delete a line.
//
// Run: `tsx scripts/skill-scaffold-preserve.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time — scaffold.ts
// derives SKILLS_DIR from it at module scope.
const stateDir = mkdtempSync(join(tmpdir(), 'skill-scaffold-test-'));
process.env.STATE_DIR = stateDir;

const { writeSkillFile } = await import('../src/skills/scaffold.js');

const dir = join(stateDir, 'skills', 'tech-news');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'SKILL.md');

// A duplicated News skill: declared knobs (feed/feedMaxItems), one hand-added
// knob its tool reads off `config`, and a hand-added toolDescription.
const SEEDED = `---
name: tech-news
label: Tech headlines
cooldown: 45m
feed: https://example.com/tech.xml
feedMaxItems: 6
apiBase: https://api.example.com
toolDescription: Fetch tech headlines.
tags: factual
---
Read one fresh headline.
`;

const form = {
  kind: 'tech-news',
  label: 'Tech headlines',
  cooldown: '45m',
  tags: ['factual'],
  brief: 'Read one fresh headline.',
};

// ── the tool.mjs is currently unloadable: nothing is declared ────────────────
{
  writeFileSync(file, SEEDED, 'utf8');
  await writeSkillFile({ ...form, config: {}, configKeys: [] });
  const md = readFileSync(file, 'utf8');

  assert.match(md, /^feed: https:\/\/example\.com\/tech\.xml$/m, 'feed survives a save made while tool.mjs is unloadable');
  assert.match(md, /^feedMaxItems: 6$/m, 'so does the second knob');
  assert.match(md, /^apiBase: https:\/\/api\.example\.com$/m, 'an undeclared, hand-authored knob survives');
  assert.match(md, /^toolDescription: Fetch tech headlines\.$/m, 'toolDescription survives');
  assert.equal((md.match(/^label:/gm) || []).length, 1, 'a form-owned key is written exactly once');
  assert.equal((md.match(/^tags:/gm) || []).length, 1, 'and never duplicated by the preserve pass');
}

// ── the declaration is visible: the form is authoritative for its own keys ───
{
  writeFileSync(file, SEEDED, 'utf8');
  await writeSkillFile({
    ...form,
    config: { feed: 'https://example.com/other.xml' },   // feedMaxItems cleared
    configKeys: ['feed', 'feedMaxItems'],
  });
  const md = readFileSync(file, 'utf8');

  assert.match(md, /^feed: https:\/\/example\.com\/other\.xml$/m, 'a declared knob takes the submitted value');
  assert.doesNotMatch(md, /feedMaxItems/, 'a declared knob the operator cleared stays cleared');
  assert.match(md, /^apiBase: https:\/\/api\.example\.com$/m, 'the undeclared knob is still carried');
  assert.match(md, /^Read one fresh headline\.$/m, 'the brief is still the body');
}

// ── a brand-new skill has nothing to preserve ────────────────────────────────
{
  await writeSkillFile({ kind: 'brand-new', brief: 'Say something.', config: {}, configKeys: [] });
  const md = readFileSync(join(stateDir, 'skills', 'brand-new', 'SKILL.md'), 'utf8');
  assert.equal(md, '---\nname: brand-new\n---\nSay something.\n', 'no existing file → no carry, no crash');
}

console.log('skill-scaffold-preserve.test.ts — all assertions passed');
