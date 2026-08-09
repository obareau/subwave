// Onboarding's route-owned rules moved onto a shared zod schema
// (controller/src/schemas/onboarding.ts), mirrored into
// web/lib/schemas.generated.ts. Deliberately narrow: the settings pass-through
// stays with settings.update() — converted is only the two probe bodies and
// the rules the save handler had to hand-roll because update() does not own
// them. These tests pin the strict/lenient pair (the probe REQUIRES the
// credentials, save must not, both normalise identically) and the two rules
// that used to live twice.
//
// Run: npx tsx scripts/onboarding-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  fishAudioIssue,
  llmProbeSchema,
  navidromeProbeSchema,
  normalizeNavidromeCredentials,
} = await import('../src/schemas/onboarding.js');

// --- navidrome: one normalisation, two postures ------------------------------

test('the probe requires all three credentials; save-side normalisation does not', () => {
  assert.equal(navidromeProbeSchema.safeParse({}).success, false);
  assert.equal(navidromeProbeSchema.safeParse({ url: 'http://n:4533', user: 'a' }).success, false);
  assert.equal(
    navidromeProbeSchema.safeParse({ url: 'http://n:4533', user: 'a', pass: 'p' }).success,
    true,
  );
  // Skipping Navidrome is a supported way through the wizard — the shell posts
  // the block with empty strings, and the lenient normaliser accepts that.
  assert.deepEqual(normalizeNavidromeCredentials({ url: '', user: '', pass: '' }), {
    url: '', user: '', pass: '',
  });
});

test('probe and save agree on the normalisation, byte for byte', () => {
  // `${url}/rest/ping` against a stored `…:4533/` double-slashes, and some
  // proxies 404 it — so the slash-strip has ONE home and both paths run it.
  const raw = { url: '  http://navi:4533//  ', user: '  admin ', pass: ' p ' };
  const probe = navidromeProbeSchema.parse(raw);
  const save = normalizeNavidromeCredentials(raw);
  assert.deepEqual(probe, save);
  assert.equal(save.url, 'http://navi:4533');
  assert.equal(save.user, 'admin');
  // The password is NOT trimmed — a leading/trailing space can be real.
  assert.equal(save.pass, ' p ');
});

// --- llm probe ---------------------------------------------------------------

test('provider and model are required', () => {
  assert.equal(llmProbeSchema.safeParse({}).success, false);
  assert.equal(llmProbeSchema.safeParse({ provider: 'ollama' }).success, false);
  assert.equal(llmProbeSchema.safeParse({ provider: 'ollama', model: 'llama3' }).success, true);
});

test('openai-compatible needs a baseUrl — in the schema, not a handler throw', () => {
  // As a throw inside the probe's provider switch, the only way to discover
  // the rule was to press Test and wait; as a schema rule it also holds the
  // wizard's button shut.
  assert.equal(
    llmProbeSchema.safeParse({ provider: 'openai-compatible', model: 'm' }).success,
    false,
  );
  assert.equal(
    llmProbeSchema.safeParse({
      provider: 'openai-compatible', model: 'm', baseUrl: 'http://box:8080/v1',
    }).success,
    true,
  );
  // locca deliberately does NOT require one — the controller defaults to the
  // host locca server.
  assert.equal(llmProbeSchema.safeParse({ provider: 'locca', model: 'm' }).success, true);
});

// --- fish audio --------------------------------------------------------------

test('fishAudioIssue judges only an enabled fish-audio block', () => {
  assert.equal(fishAudioIssue(undefined), null);
  assert.equal(fishAudioIssue({ enabled: false, provider: 'fish-audio' }), null);
  assert.equal(fishAudioIssue({ enabled: true, provider: 'openai' }), null);
});

test('fishAudioIssue reports the field-specific message from its ONE home', () => {
  // The route ran '1-100' while the wizard ran '1–100' — same logic, drifted
  // message. This is now the single copy both sides call.
  const base = { enabled: true, provider: 'fish-audio', model: 'speech-1.6', voice: 'ref123' };
  assert.equal(fishAudioIssue(base), null);
  assert.match(fishAudioIssue({ ...base, model: '' })!, /model id must be 1-100/);
  assert.match(fishAudioIssue({ ...base, voice: 'x'.repeat(101) })!, /voice reference id must be 1-100/);
  assert.match(fishAudioIssue({ ...base, model: 'a\nb' })!, /no line breaks/);
});
