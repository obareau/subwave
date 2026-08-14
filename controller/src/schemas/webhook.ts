// Shared webhook schema — the single source of truth for the outbound-webhook
// shape, executed on BOTH sides. The controller runs it in
// settings.validate.validateWebhooksStrict() and in the route middleware; the
// browser runs the mirrored copy (web/lib/schemas.generated.ts) as the form
// resolver.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// Enforced by controller/eslint.config.mjs.
//
// Rules that are NOT pure functions of one value — the authHeader redaction
// sentinel, id minting, cross-item id de-duplication — deliberately live in
// webhook-server.ts, which is NOT mirrored.
import { z } from 'zod';

// Event names the outbound webhook fan-out can subscribe to. This is now the
// ONE definition; settings/vocab.ts and broadcast/webhooks.ts re-export it.
export const WEBHOOK_EVENTS = [
  'track.play',          // a track started playing
  'dj.say',              // station ID / weather / hourly — heavy-ducked voice
  'dj.link',              // between-track auto-DJ link — light-ducked voice
  'request.received',    // a listener submitted a request
  // The same speech as dj.say/dj.link, but as a WINDOW rather than a ping:
  // start carries the measured duration, end fires when the words finish (#1382).
  // Subscribe to these instead of dj.* when you need the segment's real extent.
  // queued lands first, before the words — the one event in the set that is a
  // forecast rather than an observation, for consumers that must PREPARE for
  // speech (hand back from a call, close a gate) rather than react to it.
  'voice.queued',        // the station committed to speaking — not audible yet
  'voice.start',         // a spoken segment became audible on the stream
  'voice.end',           // …and finished
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOKS_LIMIT = 16;

// Exported because the LENIENT load-path normaliser (settings/normalize.ts)
// tests ids against it too. Two copies of this pattern would mean an id that is
// valid at boot and invalid on the next save — exactly the drift this shared
// module exists to remove. Named for its feature, not `ID_RE`: the mirror is one
// flat file, so every top-level name here shares a scope with every other
// schema module's.
export const WEBHOOK_ID_RE = /^[a-z0-9_]{3,32}$/;

export const webhookSchema = z.object({
  // Optional because a brand-new row has no id yet — the server mints one.
  // Carries its own message for the same reason url does: zod's built-in
  // regex/length text is written for a developer ("Invalid string: must match
  // pattern /^[a-z0-9_]{3,32}$/") and this string reaches an operator's toast.
  id: z
    .string()
    .regex(WEBHOOK_ID_RE, 'id must be 3-32 characters: lowercase letters, digits or underscores')
    .optional(),
  url: z
    .string()
    .trim()
    .max(500, 'URL must be 500 characters or fewer')
    .regex(/^https?:\/\//, 'URL must start with http:// or https://'),
  events: z
    .array(z.enum(WEBHOOK_EVENTS), { error: 'Pick at least one event' })
    .min(1, 'Pick at least one event')
    .transform((xs) => [...new Set(xs)]),
  enabled: z.boolean().default(true),
  // '' means no header. The literal 'set' is the redaction sentinel from
  // settings.getRedacted() meaning "keep whatever is stored" — resolving it
  // needs the CURRENT list, so see mergeWebhookSecrets() in webhook-server.ts.
  authHeader: z
    .string()
    .max(500, 'Authorization header must be 500 characters or fewer')
    .default(''),
});

export type WebhookParsed = z.output<typeof webhookSchema>;
export type Webhook = WebhookParsed & { id: string };

export const webhooksSchema = z
  // Explicit, so a non-array reads as something an operator can act on rather
  // than zod's 'Invalid input: expected array, received number'. Both callers
  // root this schema at 'webhooks'.
  .array(webhookSchema, { error: 'must be an array' })
  .max(WEBHOOKS_LIMIT, `At most ${WEBHOOKS_LIMIT} webhooks`);

// Both fields optional: the route lets the listener gate save on its own
// without re-submitting (and re-validating) the hook list, and vice versa.
export const webhooksPatchSchema = z.object({
  webhooks: webhooksSchema.optional(),
  trackPlayListenerGated: z.boolean().optional(),
});
