// Audience-source analytics routes.
//
// POST /beacon — public, one-shot per session from the player. Carries the
// external referrer + UTM (browser-only knowledge) in the body, and Cloudflare's
// real client IP + country in the headers. Feeds broadcast/audience.ts.
//
// GET /audience — admin-gated rollup for the Stats page.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { unverifiedCfIp, clientIp } from '../middleware/ratelimit.js';
import * as audience from '../broadcast/audience.js';

export const router = express.Router();

router.post('/beacon', (req, res) => {
  // Analytics must never break a listener — swallow everything, always 204.
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    // Analytics deliberately takes the CF header as an unverified HINT even
    // when TRUST_CF_CONNECTING_IP is off: a forged value here only skews a
    // rollup, and nothing gates on it. clientIp() must stay the gated one —
    // never reuse this ordering for anything that throttles or locks out.
    audience.record({
      ip: unverifiedCfIp(req) || clientIp(req),
      country: String(req.headers['cf-ipcountry'] || '').slice(0, 4) || undefined,
      referrer: typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : undefined,
      utmSource: typeof body.utmSource === 'string' ? body.utmSource.slice(0, 60) : undefined,
      path: typeof body.path === 'string' ? body.path.slice(0, 200) : undefined,
    });
  } catch {
    /* ignore */
  }
  res.status(204).end();
});

router.get('/audience', requireAdmin, (req, res) => {
  // Window clamps to 60 min … 90 days; day-bucket resolution past that is moot.
  const sinceMinutes = Math.max(
    60,
    Math.min(parseInt(String(req.query.sinceMinutes ?? ''), 10) || 1440, 90 * 1440),
  );
  res.json(audience.summary({ sinceMinutes }));
});
