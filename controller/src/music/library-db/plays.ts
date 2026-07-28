// Play history: what actually went to air, appended by the queue.

import { requireDb } from './handle.js';

// ---------------------------------------------------------------------------
// Play history
// ---------------------------------------------------------------------------

interface PlayRecord {
  id: number;
  trackId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  playedAt: string;
  source: string | null;       // 'ai' | 'request' | 'auto' at write time
  requestedBy: string | null;
  showId: string | null;
  showName: string | null;
}

export type PlayWrite = Omit<PlayRecord, 'id'>;

export function recordPlay(p: PlayWrite): void {
  requireDb().prepare(`
    INSERT INTO plays (track_id, title, artist, album, played_at, source, requested_by, show_id, show_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.trackId, p.title, p.artist, p.album, p.playedAt,
    p.source, p.requestedBy, p.showId, p.showName,
  );
}

export function listPlays(opts: { limit?: number; offset?: number } = {}): { total: number; rows: PlayRecord[] } {
  const d = requireDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const total = (d.prepare('SELECT COUNT(*) AS n FROM plays').get() as { n: number }).n;
  const rows = (d.prepare(`
    SELECT id, track_id, title, artist, album, played_at, source, requested_by, show_id, show_name
    FROM plays ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{
    id: number; track_id: string | null; title: string | null; artist: string | null;
    album: string | null; played_at: string; source: string | null;
    requested_by: string | null; show_id: string | null; show_name: string | null;
  }>).map((r) => ({
    id: r.id,
    trackId: r.track_id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    playedAt: r.played_at,
    source: r.source,
    requestedBy: r.requested_by,
    showId: r.show_id,
    showName: r.show_name,
  }));
  return { total, rows };
}


