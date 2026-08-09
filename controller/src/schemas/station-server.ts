// Server-only station rules — the two things schemas/station.ts cannot express
// because they are not pure functions of a single submitted value:
//
//   1. resolving a slug against the ids ALREADY on disk  — needs sibling awareness
//   2. the per-install cap                                — needs the current count
//
// Rule 2 is the shape webhooksSchema states inline as `.max(WEBHOOKS_LIMIT)`.
// It can't live in the station schema for the same reason it can there: the
// webhooks form posts the whole LIST, so the limit is a property of the
// submitted value, while POST /stations submits one station and the rack it
// joins is only known to the server.
//
// Keeping both out of schemas/station.ts is load-bearing: it is what lets that
// file be copied byte-for-byte into the browser bundle.
import { MAX_STATIONS, slugifyStationName } from './station.js';

/**
 * The directory name a new station gets, given everything already sitting in
 * state/stations/.
 *
 * Takes the existing entry NAMES rather than reaching for the filesystem, so
 * the collision rule is testable without a temp root and states its
 * dependency in its signature. `existing` should be every entry in the
 * stations dir, not just the station directories: `active.json` and
 * `mixer-restart-failed.json` live there too, and the fs-based check this
 * replaced (`existsSync`) counted them. No slug can collide with either name
 * (a slug has no dots) but the guard shouldn't rest on that.
 *
 * A collision appends -2, -3, … The base is cut to 38 chars first so the
 * suffix still fits inside STATION_ID_RE's 41.
 */
export function uniqueStationId(existing: Iterable<string>, name: string): string {
  const taken = new Set(existing);
  const base = slugifyStationName(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) {
    id = `${base.slice(0, 38)}-${n}`;
  }
  return id;
}

/**
 * The message for a full rack, or null when there's room.
 *
 * Returned rather than thrown because createStation has to decide WHICH error
 * class to raise — a cap hit after a legacy-root conversion must carry the
 * `converted` flag, or the route never fires the restart that conversion
 * requires. One place for the wording all the same.
 */
export function stationCapMessage(count: number, limit = MAX_STATIONS): string | null {
  return count >= limit ? `this install is capped at ${limit} stations` : null;
}
