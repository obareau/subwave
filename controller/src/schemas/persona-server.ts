// Server-only persona rules — what schemas/persona.ts cannot express because
// they are not pure functions of one submitted value:
//
//   1. id minting                    — a side effect (randomBytes)
//   2. cross-row id de-duplication   — needs sibling awareness
//
// Same split, and the same two rules, as show-server.ts and webhook-server.ts.
// Keeping them out of schemas/persona.ts is load-bearing: it is what lets that
// file be copied byte-for-byte into the browser bundle.
import { mintId } from '../settings/vocab.js';

/**
 * Give every persona an id, and make those ids unique.
 *
 * Shared by BOTH paths — the strict update() validator and the lenient
 * load-time normaliser — because two hand-rolled copies of "mint if absent,
 * re-mint on collision" is how load and save start disagreeing about which row
 * owns which id. For a persona the stakes are higher than for a show: the id is
 * what every show's `personaId`, every `guestPersonaIds` entry and
 * `activePersonaId` point at, so a row that changes identity across a save
 * silently orphans its shows — which update()'s post-patch integrity sweep then
 * "repairs" by reassigning them to whoever is first in the roster.
 */
export function resolvePersonaIds<T extends { id?: string }>(items: T[]): (T & { id: string })[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id ?? mintId('p_');
    if (seen.has(id)) id = mintId('p_');
    seen.add(id);
    return { ...item, id };
  });
}

/**
 * The same rule for the prompt-template library.
 *
 * Separate from resolvePersonaIds only because the prefix differs ('dp_' vs
 * 'p_'), and the prefix is what makes a stray id in a hand-edited settings.json
 * legible to an operator.
 */
export function resolveDjPromptIds<T extends { id?: string }>(items: T[]): (T & { id: string })[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id ?? mintId('dp_');
    if (seen.has(id)) id = mintId('dp_');
    seen.add(id);
    return { ...item, id };
  });
}
