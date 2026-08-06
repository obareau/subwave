// Shared display helpers for live-session turns from GET /session.
//
// The live session is the single source of truth for the booth log wherever
// it's shown to people (player Booth feed, broadcast ticker, /admin/dash). The
// controller's in-memory `djLog` is operator diagnostics only and stays behind
// /admin/debug.
//
// role → display class: voice (spoken on-air verbatim), dj (the agent's pick /
// request reasoning), track (a track that aired), system (session events).

import type { SessionTurn } from './types';

export type TurnDisplayClass = 'voice' | 'dj' | 'track' | 'system';

export function turnClass(turn: SessionTurn | null | undefined): TurnDisplayClass {
  switch (turn?.role) {
    case 'segment': return 'voice';
    case 'dj':      return 'dj';
    case 'track':   return 'track';
    default:        return 'system';
  }
}

// "DJ" view = everything the DJ personally said or decided.
export const isDjTurn = (turn: SessionTurn | null | undefined): boolean => {
  const c = turnClass(turn);
  return c === 'voice' || c === 'dj';
};

// Session turns carry no id, so key off timestamp + index.
export function turnKey(turn: SessionTurn | null | undefined, i: number): string {
  return `${turn?.t || 'x'}-${i}`;
}

// `track` turns already carry a "▶ …" prefix; strip it so callers can supply
// their own marker.
export function turnText(turn: SessionTurn | null | undefined): string {
  const text = turn?.text || '';
  if (turnClass(turn) === 'track') return text.replace(/^▶\s*/, '');
  return text;
}

// The `pick` event turn is the literal prompt posted to the DJ agent — ~700
// chars of coaching the model needs verbatim but that drowns the booth log.
// Returns a one-liner for long event turns; null means render the turn as-is.
export function eventTurnSummary(turn: SessionTurn | null | undefined): string | null {
  if (turn?.role !== 'event') return null;
  const text = turn.text || '';
  if (text.length <= 160) return null;
  if (turn.kind === 'pick') {
    // Head is `Now playing "X" by Y [id: …] (after "A" by B)`: keep it, drop
    // the raw Subsonic id, reduce the instruction tail to flags.
    const head = (text.split('. Pick the track to play next.')[0] ?? text)
      .replace(/\s*\[id:[^\]]*\]/g, '');
    const parts = [
      `${head} → pick next`,
      text.includes('Stay silent') ? 'silent' : 'with link',
    ];
    if (text.includes('Set "transition"')) parts.push('effects nudge');
    return parts.join(' · ');
  }
  const firstSentence = text.match(/^[^.!?]*[.!?]/)?.[0] || text.slice(0, 140);
  return `${firstSentence.trim()} …`;
}

// The single voice/dj turn to surface as the DJ "thinking" line under
// now-playing. Walk newest→oldest and skip `dj`/pick turns whose `meta.trackId`
// isn't what's on air: a pick turn is written at the *previous* track's start,
// so its trackId is the NEXT track, and showing it reads as this song's
// reasoning when it isn't (#546). Voice/segment turns carry no trackId and are
// whatever was last spoken, so they always qualify. A null/unknown
// currentTrackId yields the latest voice turn, since no pick can be confirmed.
export function selectThinkingTurn(
  feed: SessionTurn[] | null | undefined,
  currentTrackId: string | null = null,
): SessionTurn | null {
  if (!feed?.length) return null;
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    const cls = turnClass(turn);
    if (!turn?.text || (cls !== 'voice' && cls !== 'dj')) continue;
    const trackId = turn.meta?.trackId as string | undefined;
    if (cls === 'dj' && trackId && trackId !== currentTrackId) continue;
    return turn;
  }
  return null;
}
