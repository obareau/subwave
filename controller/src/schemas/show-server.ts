// Server-only show rules — what schemas/show.ts cannot express because they
// are not pure functions of one submitted value:
//
//   1. id minting                    — a side effect
//   2. cross-row id de-duplication   — needs sibling awareness
//
// Same split, and the same two rules, as webhook-server.ts. Keeping them out of
// schemas/show.ts is load-bearing: it is what lets that file be copied
// byte-for-byte into the browser bundle.
import { mintId } from '../settings/vocab.js';

/**
 * Give every show an id, and make those ids unique.
 *
 * Shared by BOTH paths — the strict update() validator and the lenient
 * load-time normaliser — because two hand-rolled copies of "mint if absent,
 * re-mint on collision" is how load and save start disagreeing about which row
 * owns which id. For shows the id is what the weekly schedule grid points at,
 * so a row that changes identity across a save silently empties its slots.
 */
export function resolveShowIds<T extends { id?: string }>(items: T[]): (T & { id: string })[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id ?? mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    return { ...item, id };
  });
}
