// Delivery-boundary regression for issue #1707 and PR #1715 review.
//
// The helper tests proved stripSpeakerLabel() works; they could not prove the
// callers reach it. They did not: announce() stripped only when given an
// explicit persona, so POST /dj/say — which omits one — still handed
// "Iris : Bonsoir…" to TTS, the very example that reported the bug. These tests
// assert on the text that arrives at _speak, not on the helper.
//
// Run: npm test -- speech-label-boundary

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-speech-label-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');

const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;

const template = settings.get().personas[0];
const IRIS = { ...template, id: 'p_iris', name: 'Iris' };
const SHOW = 's_label';

function week() {
  const out: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) out[day] = Array(24).fill(SHOW);
  return out;
}

function ctx() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Label Show', topic: 'tests' },
  } as any;
}

/** Captures what actually reaches TTS. */
let spoken: string[] = [];

beforeEach(async () => {
  spoken = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  (queue as any)._speak = async (text: string) => { spoken.push(text); return null; };
  (queue as any)._airVoice = async () => true;
  await settings.update({
    personas: [IRIS], activePersonaId: IRIS.id,
    shows: [{ id: SHOW, name: 'Label Show', topic: 'tests', personaId: IRIS.id }],
    schedule: week(), scheduleOverride: null,
  } as never);
  session.start(ctx());
});

after(async () => {
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 600));
  rmSync(root, { recursive: true, force: true });
});

// ── announce() without a persona — the /dj/say path ──────────────────────────

test('announce strips the label when no persona is passed', async () => {
  await queue.announce('Iris : Bonsoir les auditeurs.', 'dj-speak');
  assert.equal(spoken.length, 1, 'the clip must reach TTS');
  assert.equal(spoken[0], 'Bonsoir les auditeurs.',
    'POST /dj/say supplies no persona, yet the on-air speaker is known');
});

test('announce strips the label when the persona is explicit', async () => {
  await queue.announce('Iris: Bonsoir.', 'dj-speak', { persona: IRIS as never });
  assert.equal(spoken[0], 'Bonsoir.');
});

test('announce leaves an unknown name alone', async () => {
  await queue.announce('Bob : hello there.', 'dj-speak');
  assert.equal(spoken[0], 'Bob : hello there.',
    'only a known cast name is a label — anything else is speech');
});

test('announce leaves ordinary colon-bearing speech alone', async () => {
  await queue.announce('Une seule règle : on ne coupe pas le silence.', 'dj-speak');
  assert.equal(spoken[0], 'Une seule règle : on ne coupe pas le silence.');
});

// ── announceAtNextTrack() — the scheduled path ───────────────────────────────

test('announceAtNextTrack strips the label too', async () => {
  await queue.announceAtNextTrack('Iris : et maintenant, la suite.', 'station-id');
  assert.equal(spoken.length, 1, 'the scheduled clip renders its WAV immediately');
  assert.equal(spoken[0], 'et maintenant, la suite.',
    'scheduled segments reach _speak through their own method, which also needs the guard');
});

test('announceAtNextTrack leaves ordinary speech alone', async () => {
  await queue.announceAtNextTrack('Radio Subwave : toute la nuit.', 'station-id');
  assert.equal(spoken[0], 'Radio Subwave : toute la nuit.',
    'a station name that is not a cast member must survive');
});
