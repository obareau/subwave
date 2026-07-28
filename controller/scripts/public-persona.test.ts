// Pins the roster-wide public-read disclosure rule (util/public-persona.ts +
// settings.privacy.publishPersonaSouls).
//
// GET /schedule and GET /personas hand a listener the whole DJ roster in one
// request. Three properties are load-bearing and easy to regress:
//
//  - Souls are OPT-IN. A settings.json written before the key existed (and any
//    non-boolean written by hand) must read as OFF, or upgrading a station
//    silently publishes every operator's system prompts.
//  - `soul` is ABSENT, not empty, when off. A client has to be able to tell
//    "this station doesn't publish souls" from "the soul is blank", otherwise
//    it renders a wall of empty bio cards.
//  - Only identity fields ever ride along. TTS config, skills and the
//    behaviour dials are operator configuration and must never leak into a
//    public read, at any setting.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load()/update() touch nothing real — hence the dynamic imports.
// node:assert-via-tsx style, matching scripts/voice-policy.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-public-persona-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { publicPersonaShape, publicGuestIds, soulsArePublic } = await import(
  '../src/util/public-persona.js'
);

// A stored persona carrying every field the admin UI can set — the point is
// that only four of them survive the reduction.
const PERSONA = {
  id: 'p_nyx',
  name: 'Nyx',
  tagline: 'after-dark selector',
  soul: 'warm, unhurried, knows the deep cuts',
  frequency: 'moderate',
  djMode: true,
  humour: 7,
  localColour: 3,
  warmth: 8,
  language: 'en',
  avatar: 'p_nyx.png',
  tts: { engine: 'piper', cloudProvider: 'openai', voice: 'am_onyx', gainDb: 2, speed: 1.1 },
  skills: ['weather'],
};

// Anything beyond these must never appear on a public read, whatever the
// toggle says. Kept as an explicit deny-list so a field added to the persona
// schema and casually spread into the shape trips this test.
const ALLOWED = new Set(['id', 'name', 'tagline', 'avatar', 'soul']);

try {
  // ── The toggle defaults OFF, and only a real `true` turns it on ───────────
  await settings.load();
  assert.equal(
    soulsArePublic(settings.get()),
    false,
    'a fresh install must not publish persona souls',
  );

  // Every shape an older or hand-edited settings.json can present. All OFF —
  // opting in has to be deliberate, never something a missing key does for you.
  for (const privacy of [
    undefined,
    {},
    { publishPersonaSouls: undefined },
    { publishPersonaSouls: null },
    { publishPersonaSouls: 0 },
    { publishPersonaSouls: '' },
    // The string 'true' is the dangerous one: a hand-edited JSON or a form post
    // that skipped coercion would flip disclosure on under a loose check.
    { publishPersonaSouls: 'true' },
    { publishPersonaSouls: 1 },
  ]) {
    assert.equal(
      soulsArePublic({ privacy } as never),
      false,
      `privacy=${JSON.stringify(privacy)} must read as souls-private`,
    );
  }
  assert.equal(
    soulsArePublic({ privacy: { publishPersonaSouls: true } }),
    true,
    'an explicit boolean true is the only way in',
  );

  // ── Souls OFF: the field is absent, not blank ─────────────────────────────
  const closed = publicPersonaShape(PERSONA, false, '/persona-avatar/p_nyx');
  assert.deepEqual(
    closed,
    {
      id: 'p_nyx',
      name: 'Nyx',
      tagline: 'after-dark selector',
      avatar: '/persona-avatar/p_nyx',
    },
    'souls-off publishes exactly id/name/tagline/avatar',
  );
  assert.equal('soul' in closed, false, 'soul must be ABSENT when off, not empty-string');

  // ── Souls ON: the blurb rides, nothing else does ──────────────────────────
  const open = publicPersonaShape(PERSONA, true, '/persona-avatar/p_nyx');
  assert.equal(open.soul, PERSONA.soul, 'souls-on publishes the stored soul verbatim');
  assert.equal(open.tagline, PERSONA.tagline, 'tagline rides either way');

  // The real regression guard: operator configuration must never leak.
  for (const shape of [closed, open]) {
    for (const key of Object.keys(shape)) {
      assert.ok(ALLOWED.has(key), `public persona read leaked "${key}"`);
    }
  }

  // ── Missing/odd fields degrade to '' rather than undefined ────────────────
  // The wire shape has to stay stable for a half-filled persona, or clients
  // start rendering "undefined" in a bio slot.
  assert.deepEqual(
    publicPersonaShape({ id: 'p_x' }, true, ''),
    { id: 'p_x', name: '', tagline: '', avatar: '', soul: '' },
    'absent strings become empty strings, and soul is present-but-blank when ON',
  );

  // ── Guest ids resolve against the LIVE roster ─────────────────────────────
  const roster = [{ id: 'p_nyx' }, { id: 'p_frequency' }];
  assert.deepEqual(
    publicGuestIds(['p_frequency'], roster),
    ['p_frequency'],
    'a guest still on the roster survives',
  );
  assert.deepEqual(
    publicGuestIds(['p_deleted'], roster),
    [],
    'a guest deleted after the show was saved vanishes rather than dangling',
  );
  assert.deepEqual(
    publicGuestIds(['p_nyx', 'p_deleted', 'p_frequency'], roster),
    ['p_nyx', 'p_frequency'],
    'surviving guests keep their order with a dead one removed',
  );
  // Solo shows and pre-guest settings.json files both land here.
  for (const bad of [undefined, null, '', 'p_nyx', 42, {}]) {
    assert.deepEqual(
      publicGuestIds(bad, roster),
      [],
      `non-array guestPersonaIds (${JSON.stringify(bad)}) yields []`,
    );
  }
  assert.deepEqual(
    publicGuestIds([null, 7, { id: 'p_nyx' }], roster),
    [],
    'non-string entries are dropped, never coerced',
  );

  // ── The toggle round-trips through settings.update() and applies live ─────
  await settings.update({ privacy: { publishPersonaSouls: true } });
  assert.equal(soulsArePublic(settings.get()), true, 'update() turns disclosure on');

  // It is a DISCLOSURE flag, not a lock: unlike privatePlayer/listenerAuth it
  // must save with no station password set. If this ever throws, the toggle
  // has been pulled inside the "a lock needs a password" invariant.
  assert.equal(
    settings.get().privacy.password,
    '',
    'precondition: no station password is set in this test',
  );

  await settings.update({ privacy: { publishPersonaSouls: false } });
  assert.equal(soulsArePublic(settings.get()), false, 'update() turns disclosure back off');

  // And it must not have dragged the locks along with it.
  assert.equal(settings.get().privacy.privatePlayer, false, 'privatePlayer untouched');
  assert.equal(settings.get().privacy.listenerAuth, false, 'listenerAuth untouched');

  console.log('public-persona: OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
