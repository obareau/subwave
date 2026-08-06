// Outbound webhooks — fan-out from station events (track.play, dj.say,
// dj.link, request.received) to operator-configured HTTP endpoints.
//
// Fire-and-forget. The webhook delivery path must never block playback or
// the DJ pipeline, so every send runs in the background with a hard 5-second
// timeout. Failures log to stderr; there is no retry queue and no durable
// outbox. If you want guaranteed delivery, point the webhook at a relay
// (Cloudflare Worker, Pipedream, n8n) that owns its own retry policy — this
// module's job is to get the event to that relay quickly, not to be one.
//
// The shape of the payload is documented in routes/webhooks.ts. Each event
// is a stable JSON object with `event`, `t`, and event-specific fields.
// `track.play` can be listener-gated at the call site in queue.ts when
// webhooksPolicy.trackPlayListenerGated is on; notify() does not gate events.

import * as settings from '../settings.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
// One definition, shared with the web form — see controller/src/schemas/webhook.ts.
import { WEBHOOK_EVENTS, type Webhook, type WebhookEvent } from '../schemas/webhook.js';
export { WEBHOOK_EVENTS, type WebhookEvent };

const TIMEOUT_MS = 5000;

async function postOne(hook: Webhook, body: string) {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'sub-wave/webhook',
    };
    if (hook.authHeader) headers['Authorization'] = hook.authHeader;
    const r = await fetchWithTimeout(hook.url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: TIMEOUT_MS,
    });
    if (!r.ok) {
      console.warn(`[webhook] ${hook.url} → ${r.status}`);
    }
  } catch (err: any) {
    console.warn(`[webhook] ${hook.url} failed: ${err.message}`);
  }
}

// Fire an event to every enabled, subscribed hook. Non-blocking.
export function notify(event: WebhookEvent, payload: Record<string, unknown>) {
  let hooks: Webhook[] = [];
  try {
    hooks = (settings.get()?.webhooks || []) as Webhook[];
  } catch {
    return;
  }
  if (!hooks.length) return;
  const targets = hooks.filter(h => h.enabled && h.events.includes(event));
  if (!targets.length) return;
  const body = JSON.stringify({
    event,
    t: new Date().toISOString(),
    ...payload,
  });
  for (const hook of targets) {
    postOne(hook, body);  // fire-and-forget
  }
}

// Test fire — used by the admin UI's "Test" button. Bypasses the event
// subscription list so the operator can sanity-check a fresh hook without
// also flipping the events toggle on first.
export async function fireTest(hook: Webhook) {
  await postOne(hook, JSON.stringify({
    event: 'test',
    t: new Date().toISOString(),
    note: 'sub-wave webhook test fire',
  }));
}
