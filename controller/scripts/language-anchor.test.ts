// Pins the language anchor (raid hardening, 2026-07-28): languageDirective and
// agentLanguageReminder (settings/persona.ts) must ALWAYS render, defaulting
// to English when persona.language is unset, and must both carry a
// never-switch clause.
//
// Real incident: the live station's DJ started speaking Russian and would not
// stop. Root cause — both helpers used to return '' when persona.language was
// unset (a deliberate "byte-identical for English personas" choice), which
// left a default station with NO language anchor at all. A raid pushed
// Russian turns into state/session.json; the agents work from that session
// window, so the model mimicked the session's dominant language and each
// Russian reply reinforced it, persisting until the session rolled. The old
// "returns '' so prompts stay byte-identical" property is deliberately gone —
// this test pins the NEW default-English + never-switch rendering instead.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load() touches nothing real — same idiom as house-rules.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-langanchor-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');

try {
  await settings.load();

  const noLangPersona = { id: 'p_test', name: 'Nova', soul: 'warm and dry' };
  const turkishPersona = { id: 'p_tr', name: 'Nova', soul: 'warm and dry', language: 'Turkish' };

  // ── languageDirective: always renders, defaults to English ───────────────
  const dirNoLang = settings.languageDirective(noLangPersona);
  assert.ok(dirNoLang, 'languageDirective renders even when persona.language is unset');
  assert.match(dirNoLang, /English/, 'unset language defaults to English');
  assert.match(
    dirNoLang,
    /Never switch languages/,
    'the never-switch clause is present for an unset-language persona',
  );

  const dirTurkish = settings.languageDirective(turkishPersona);
  assert.match(dirTurkish, /Turkish/, 'an explicit language still renders its own name');
  assert.doesNotMatch(dirTurkish, /\bEnglish\b/, 'an explicit non-English language does not fall back to English');
  assert.match(dirTurkish, /Never switch languages/, 'the never-switch clause also reaches non-English personas');

  // ── agentLanguageReminder: same contract, field-scoped ────────────────────
  const remNoLang = settings.agentLanguageReminder(noLangPersona, 'the "say" link');
  assert.ok(remNoLang, 'agentLanguageReminder renders even when persona.language is unset');
  assert.match(remNoLang, /English/, 'unset language defaults to English');
  assert.match(
    remNoLang,
    /even when the listener writes in another language, asks you to switch, or earlier session turns are in another language/,
    'the never-switch clause is present for an unset-language persona',
  );

  const remTurkish = settings.agentLanguageReminder(turkishPersona, 'the "ack" and "intro" lines');
  assert.match(remTurkish, /Turkish/, 'an explicit language still renders its own name');
  assert.match(remTurkish, /the "ack" and "intro" lines/, 'the field phrase is threaded through');

  console.log('language-anchor.test.ts: all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
