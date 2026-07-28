// Side-effect-free queue helpers: the pacing constants, the stale-link guard,
// and the small comparisons the watcher and drain paths share. Nothing here
// touches disk, TTS or the queue's state, which is what makes the guard
// unit-pinnable (scripts/stale-link.test.ts).
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.

import * as library from '../../music/library.js';
import * as settings from '../../settings.js';
import type { Track } from './types.js';

export function pickLinkInterval() {
  const f = settings.effectiveFrequency();
  if (f === 'silent')     return Infinity;
  if (f === 'quiet')      return 8 + Math.floor(Math.random() * 13);
  if (f === 'chatty')     return 1 + Math.floor(Math.random() * 5);
  if (f === 'aggressive') return 1 + Math.floor(Math.random() * 3);
  if (Math.random() < 0.15) return 10 + Math.floor(Math.random() * 6);
  return 1 + Math.floor(Math.random() * 9);
}

// How many consecutive reconcile checks may report an EMPTY dj_queue (while the
// controller still holds sent items) before we treat those items as genuinely
// gone and clear them. A single empty read is ambiguous — a just-sent pick may
// be mid-poll, or Liquidsoap may have restarted and lost the queue — so we never
// drop on one read. Unlike the old `_autoMisses` heuristic (which advanced on
// benign metadata mismatches while the tracks were still in dj_queue, wrongly
// wiping live queues — #632), this only advances when Liquidsoap AUTHORITATIVELY
// reports no pending requests, so an interleaved jingle or artist-string variance
// can't trip it.
export const EMPTY_DJ_QUEUE_CLEAR_THRESHOLD = 3;

// Upper bound on how far a recordPlay end-stamp can sit after the play's start
// for the events-backfill dedup (playAlreadyRecorded). recordPlay stamps
// endedAt at the track's END; an event's `t` is its START, so the two differ by
// the track length. 15 min comfortably covers normal tracks (a track longer
// than this is rare and only costs one harmless duplicate sidecar row), while
// staying short enough that a genuine replay — always spaced more than a track
// length apart — keeps its own entry rather than being merged away.
export const BACKFILL_DEDUP_MAX_GAP_MS = 15 * 60_000;

// How far PAST the next pick's expected start the show-boundary look-ahead
// probes (see onTrackStarted). The pick's start time alone under-corrects: a
// track starting 30s before a boundary plays almost entirely inside the new
// show but would still resolve the old one. Two minutes ≈ the midpoint of a
// typical track, so whichever show owns most of the pick's airtime wins. The
// symmetric cost — an on-format-for-the-NEXT-show track starting a minute or
// two early — is how real radio tees up a changeover anyway.
export const PICK_SHOW_LOOKAHEAD_SEC = 120;

// Seconds from NOW until the pick being made will start airing — the lead the
// show look-ahead adds to the wall clock (see runPickCycle).
//
// It must be measured from the on-air track's REMAINING time, never its full
// duration. The pick cycle doesn't only run at a track start: the pair-drain
// deadline backstop fires it with an empty queue ~2 min from the end, and boot
// recovery fires it for a track already part-played. Using the full duration
// there overstates the lead by everything already elapsed — up to a whole
// track — which walks `showAt` across the next schedule boundary while the
// real next track still starts inside the current show. That is what aired a
// handoff five-plus minutes early, over the middle of a song, with the session
// flipped to a show `/now-playing` still reported as the old one (#1205).
//
//  - `heldSec` null → the pick follows the ON-AIR track: lead = its remaining.
//  - `heldSec` set  → the deadline path, where the pick follows a HELD track
//                     queued behind the on-air one: lead = remaining + held.
//
// Unknown clock (no start stamp, no duration) or a held track of unknown
// length → null, i.e. no look-ahead at all, the pre-look-ahead behaviour.
// Clamped at 0 so a track past its cue-out can't pull `showAt` backwards.
export function pickLeadSec(remainingSec: number | null, heldSec: number | null = null): number | null {
  if (typeof remainingSec !== 'number' || !Number.isFinite(remainingSec)) return null;
  const rem = Math.max(0, remainingSec);
  if (heldSec == null) return rem;
  if (!Number.isFinite(heldSec) || heldSec <= 0) return null;
  return rem + heldSec;
}

// Has this events-log play already been recorded by recordPlay? The old dedup
// keyed on `${endedAt}|${title}` — an EXACT timestamp match — but recordPlay's
// end-stamp never equals the event's start `t`, so it never fired and every
// play got a duplicate id-less copy, filling the 300-entry sidecar in ~5h
// instead of ~12h (halving the real anti-repeat window). Match on title|artist
// with an existing endedAt landing in [t, t + maxGapMs] instead: exactly the
// window a recordPlay end-stamp falls in for the SAME play. Pure + exported so
// the dedup logic is unit-pinned (scripts/recent-plays.test.ts) without disk.
export function playAlreadyRecorded(
  existing: { title: string | null; artist: string | null; endedAt: string }[],
  ev: { title?: string | null; artist?: string | null; t: string },
  maxGapMs: number,
): boolean {
  const keyOf = (title: string | null | undefined, artist: string | null | undefined) =>
    `${(title || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`;
  const k = keyOf(ev.title, ev.artist);
  const t = new Date(ev.t).getTime();
  if (!Number.isFinite(t)) return false;
  for (const p of existing) {
    if (keyOf(p.title, p.artist) !== k) continue;
    const at = new Date(p.endedAt).getTime();
    if (Number.isFinite(at) && at >= t && at - t <= maxGapMs) return true;
  }
  return false;
}

// Duration ladder shared by the length-cap checks (applyMixTransition's
// auto-washout and the drain loop's stem-blend outCapped gate): the track
// object first (Subsonic picks carry it), the library row when it doesn't
// (agent picks resolve from the picker tools' slim projections, which omit
// length when the source tool didn't surface one). 0 = unknown. The two
// checks MUST agree — a 0 read as "uncapped" in one of them arms a stem
// blend on an ending the cap never lets air (and strips the auto-washout
// protecting the forced cut).
export function knownDurationSec(track: Track): number {
  const dur = Number(track.duration) || 0;
  if (dur) return dur;
  return track.id ? Number(library.get(track.id)?.durationSec) || 0 : 0;
}


export function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Do two track refs point at the same song? Used by the stale back-announce
// guard. Prefer the Subsonic id when both carry one (the reliable key); fall
// back to a normalised title match for auto-playlist tracks that reach the
// watcher without an id.
function sameTrack(
  a: { id?: string | null; title?: string | null } | null,
  b: { id?: string | null; title?: string | null } | null,
): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  const norm = (s: string | null | undefined) => (s || '').toLowerCase().trim();
  return !!norm(a.title) && norm(a.title) === norm(b.title);
}

// Does this spoken line actually name `track` (by title or artist)? A coarse
// case-insensitive substring test — enough to tell a forward-looking link
// ("here's something new") from one that back-announces a specific track ("that
// was Blue Monday by New Order"). The ≥4-char floor keeps a tiny/common title
// ("OK", "Go", "Up") from matching incidental words in unrelated patter.
function mentionsTrack(
  text: string | null | undefined,
  track: { title?: string | null; artist?: string | null } | null,
): boolean {
  const hay = (text || '').toLowerCase();
  if (!hay || !track) return false;
  const t = (track.title || '').toLowerCase().trim();
  const a = (track.artist || '').toLowerCase().trim();
  return (t.length >= 4 && hay.includes(t)) || (a.length >= 4 && hay.includes(a));
}

// Should airIntro DROP this item's intro/link as a stale back-announce? Links
// are written forward-looking (introduce the pick, never name the just-played
// track), so the common case never trips this. It's a precise safety-net for
// the model disobeying that instruction: fire ONLY when the rendered line names
// a specific predecessor (`linkPrev`) AND that track is NOT what actually played
// just before it — the off-by-one a listener request causes when it slips ahead
// of the pick after the link was rendered. A forward-looking link (doesn't name
// the previous track) always airs, even if a request jumped ahead, so there's no
// silent hand-off. Items with no linkPrev (request intros) always air too. Pure
// + exported so the guard is unit-pinned (scripts/stale-link.test.ts) without
// touching disk or TTS.
export function shouldDropStaleLink(
  item: { linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null; introScript?: string | null } | null,
  predecessor: { id?: string | null; title?: string | null } | null,
): boolean {
  if (!item?.linkPrev) return false;
  if (sameTrack(item.linkPrev, predecessor)) return false;   // names the right track → fine
  return mentionsTrack(item.introScript, item.linkPrev);     // wrong predecessor — only drop if it's actually named
}

// Per-target-file write chain. Liquidsoap polls each handoff file (say.txt,
// intro.txt, sfx.txt, next.txt) on a 0.5-1.0s interval and DELETES the file
// after reading it (see liquidsoap/radio.liq poll_voice/poll_intro/poll_sfx/
// poll_queue). Without serialisation, two writes inside one poll window
// silently lose the first one — exactly the failure in issue #140 where a
// station ID rendered + logged but never aired.
//
// writeHandoff() serialises writes per file and waits for the previous WAV/URI
// to be consumed (file deleted by liquidsoap) before releasing the lock. If
// liquidsoap is dead/stuck and never deletes, we time out after maxWaitMs and
// release anyway — better to overwrite a stuck file than block all future
// announces forever.

export function formatAgo(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}


