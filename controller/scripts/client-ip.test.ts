// Pins clientIp() (controller/src/middleware/ratelimit.ts) — the identity
// EVERY per-IP gate keys on (the /request cooldown, per-IP hourly cap and
// one-pending hold, requireAdmin's brute-force lockout, the station-password
// throttle, per-IP like dedup). This is the single most load-bearing line on
// the raid-hardening branch, and it has already regressed twice in opposite
// directions: first trusting the left-most X-Forwarded-For entry (Cloudflare
// APPENDS the real client IP rather than replacing it, so a client-forged
// entry survived as xff[0] — 2b3fd008), then over-correcting to trust
// `CF-Connecting-IP` unconditionally (an ordinary header on a non-Cloudflare
// origin, so THAT became the forgeable one — 560b4657 gated it behind
// TRUST_CF_CONNECTING_IP, the current shape). Any change here should keep
// both failure modes in mind.
//
// TRUST_CF_CONNECTING_IP is read into a top-level `const` at module load, so
// the ON case can't be exercised by mutating process.env in-process after the
// first import — Node's ESM cache would just hand back the already-evaluated
// module. The default-OFF cases run in-process (this file's own tsx
// subprocess, per run-tests.ts); the ON case is exercised in a genuinely
// separate process — a throwaway script spawned with the env var set —
// so the module gets a fresh load with the flag already true.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ratelimitUrl = pathToFileURL(join(here, '..', 'src', 'middleware', 'ratelimit.ts')).href;

// Never let an inherited shell env var pollute the default-OFF assertions.
delete process.env.TRUST_CF_CONNECTING_IP;

const { clientIp } = await import('../src/middleware/ratelimit.js');

function req(headers: Record<string, string>, remoteAddress = '9.8.7.6') {
  return { headers, socket: { remoteAddress } };
}

// --- default OFF: both headers present -> XFF wins, NOT the CF header ------
{
  const r = req({
    'cf-connecting-ip': '203.0.113.9',
    'x-forwarded-for': '198.51.100.1, 10.0.0.2',
  });
  assert.equal(
    clientIp(r),
    '198.51.100.1',
    'flag unset: left-most XFF entry must win over cf-connecting-ip',
  );
}

// --- default OFF: only XFF present -> left-most entry -----------------------
{
  const r = req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.3, 10.0.0.4' });
  assert.equal(clientIp(r), '198.51.100.7', 'flag unset: left-most XFF entry wins with no CF header at all');
}

// --- default OFF: neither header -> socket peer -----------------------------
{
  const r = req({}, '192.0.2.55');
  assert.equal(clientIp(r), '192.0.2.55', 'flag unset, no headers: falls back to req.socket.remoteAddress');
}

console.log('client-ip.test.ts: default-OFF cases passed (in-process)');

// --- flag ON: cf-connecting-ip wins, exercised in a fresh child process -----
const scratch = mkdtempSync(join(tmpdir(), 'subwave-client-ip-'));
try {
  const childScript = join(scratch, 'flag-on.mts');
  writeFileSync(
    childScript,
    [
      `import { clientIp } from ${JSON.stringify(ratelimitUrl)};`,
      `const ip = clientIp({`,
      `  headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 10.0.0.2' },`,
      `  socket: { remoteAddress: '9.8.7.6' },`,
      `});`,
      `process.stdout.write(ip);`,
      '',
    ].join('\n'),
  );

  const out = execFileSync('tsx', [childScript], {
    encoding: 'utf8',
    env: { ...process.env, TRUST_CF_CONNECTING_IP: '1' },
  });

  assert.equal(
    out.trim(),
    '203.0.113.9',
    'TRUST_CF_CONNECTING_IP=1: cf-connecting-ip must win over XFF',
  );

  console.log('client-ip.test.ts: flag-ON case passed (child process)');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('client-ip.test.ts — all assertions passed');
