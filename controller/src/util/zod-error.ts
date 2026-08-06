// Turning a ZodError into something an operator can read.
//
// A raw ZodError's `.message` is a pretty-printed JSON array of issue objects —
// ~15 lines for one bad URL. Every route that surfaces a failure does
// `res.status(400).json({ error: err.message })`, so that blob lands verbatim
// in a toast. These two helpers are the one place that translation lives.
//
// Neutral on purpose: BOTH middleware/validate.ts (route boundary) and
// settings/validate.ts (the persistence chokepoint update() reaches from backup
// restore and PUT /settings) import from here. Importing middleware/ into
// settings/ would invert the dependency direction, so neither owns it.
import type { ZodError } from 'zod';

// Dotted path — 'webhooks.1.url' — which is also react-hook-form's setError
// field syntax, so the admin form can map these straight onto inputs.
function pathOf(issue: ZodError['issues'][number]): string {
  return issue.path.join('.');
}

/**
 * One message per field, keyed by dotted path.
 *
 * The accumulator is a NULL-PROTOTYPE object, and that is load-bearing: field
 * names come from user data. On a plain `{}` literal, a field named `toString`
 * would be swallowed by the first-wins guard (`'toString' in {}` is true via
 * the prototype chain), and a field named `__proto__` would be dropped no
 * matter what the guard said, because `out['__proto__'] = msg` on a literal
 * attempts a prototype set instead of creating an own property. Object.create(null)
 * closes both at once — swapping `in` for Object.hasOwn would only close the first.
 */
export function flattenIssues(error: ZodError): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const issue of error.issues) {
    const key = pathOf(issue);
    // First error per field wins — a field with three problems should surface
    // one message, not a stack of them.
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * A flat, single-line message — what a 400's `error` string carries.
 *
 * The dotted path is prefixed whenever there is one. Zod's built-in messages
 * name a CONSTRAINT and never a location: 'invalid_type' says "expected array,
 * received string", 'invalid_format' says "Invalid string: must match pattern
 * /^[a-z0-9_]{3,32}$/", 'too_big' says "expected string to have <=500
 * characters". Custom messages usually name their field but never the array
 * INDEX, so two rows failing the same rule produced byte-identical text and the
 * operator could not tell which one to fix.
 *
 * Deciding this from the issue code — the earlier `code !== 'invalid_type'`
 * test — does not work. The set of codes carrying field-agnostic messages is
 * open and grows with every constraint a schema adds, so the heuristic silently
 * stopped applying to `.regex()` and `.max()` the moment those were used
 * without a custom message. Prefixing unconditionally is the only rule that
 * stays correct as the schemas evolve; the cost is mild redundancy when a
 * custom message already names its own field.
 *
 * `root` names the value under validation when the SCHEMA itself is unrooted.
 * validateWebhooksStrict parses the bare array, so its paths start at the index
 * ('0.url') and need 'webhooks' in front to read as a settings key; the route
 * middleware parses the wrapping object, whose paths are already rooted.
 */
export function firstMessage(error: ZodError, root?: string): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid request body';
  // pathOf is '' for a root-level issue, so a bare `root` survives on its own
  // and an unrooted root-level issue keeps just its message.
  const key = [root, pathOf(issue)].filter(Boolean).join('.');
  return key ? `${key}: ${issue.message}` : issue.message;
}
