// Phase 0 - enrichment. Last.fm tags and lyric excerpts, plus the MusicBrainz
// original-year resolution compilation tracks need.
//
// Part of the tag-library/ split - see ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as lastfm from '../lastfm.js';
import * as musicbrainz from '../musicbrainz.js';
import * as db from '../library-db.js';
import * as settings from '../../settings.js';
import { reportProgress } from '../tagger-progress.js';
import { mapPool, memoizeByKey } from '../../util/async-pool.js';
import { logEvent } from './log.js';

// ---------------------------------------------------------------------------
// Phase 0 — Enrichment (Last.fm tags + lyric excerpts)
// ---------------------------------------------------------------------------

export async function phaseEnrich(ids: string[], reEnrich: boolean): Promise<void> {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  // A configured Last.fm api_key (LASTFM_API_KEY / scrobble.lastfm.apiKey) lets
  // us hit the Last.fm API directly (music/lastfm.ts), which actually returns
  // tag[]. The tri-state gate (shared with the retag route via
  // lastfm.lastfmEnrichEnabled) keeps keyless vanilla-Navidrome installs from
  // wasting a round trip per artist on the tag-less getArtistInfo2 path.
  const hasKey = lastfm.hasLastfmKey();
  const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, hasKey);
  const lyricsEnabled = enrichCfg.lyrics !== false;
  // Original-year resolution for compilation-album tracks (issue #842) —
  // keyless MusicBrainz, so default-on; disable via
  // settings.embedding.enrichment.originalYear = false.
  const originalYearEnabled = enrichCfg.originalYear !== false;
  // The original-year backfill scopes itself in SQL (compilation tracks with
  // no resolved year), NOT by the tagger's untagged/enriched id set — the
  // column landed after most libraries were tagged, and gating on the enrich
  // scope (or enrichedAt) would never backfill an already-tagged library.
  const yearIds = originalYearEnabled ? db.idsNeedingOriginalYear(reEnrich) : [];
  if (ids.length === 0 && yearIds.length === 0) return;
  if (!lastfmEnabled && !lyricsEnabled && yearIds.length === 0) {
    console.log('[tag] phase-0 skipped: lastfmTags and lyrics disabled, no original-year lookups pending');
    return;
  }
  if (lastfmEnabled) {
    console.log(
      `[tag] phase-0 Last.fm tags via ${hasKey ? 'direct API (artist.getTopTags)' : 'Navidrome getArtistInfo2 (no api_key — likely empty)'}`,
    );
  }
  reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: 0, total: ids.length });
  // Per-artist Last.fm dedup: memoize on the in-flight PROMISE (not the resolved
  // value) so the concurrent pool below shares one API call across every track by
  // the same artist. Direct Last.fm API when a key is present (returns crowd tags
  // on vanilla Navidrome), else Navidrome's getArtistInfo2 — shared with the
  // single-track retag route so the two can't drift (see lastfm.ts).
  const artistTags = memoizeByKey<string[]>(artist =>
    lastfm.getArtistTags(artist, { count: 10 }).then(t => t ?? []).catch(() => []),
  );

  let enrichedTracks = 0;
  let enrichedLyrics = 0;
  let enrichedTags = 0;
  let enrichedYears = 0;

  // Enrichment is I/O-bound (Last.fm + Navidrome lyrics fetches), so a serial
  // await-per-track loop spends almost all its time blocked on the network — on a
  // large library that's the difference between minutes and an hour. Drain the id
  // list with a bounded pool instead. DB writes go through better-sqlite3
  // (synchronous), so they're naturally serialised on the single-threaded event
  // loop between awaits — no locking needed. Pool size is gentle by default (6)
  // and tunable via TAG_ENRICH_CONCURRENCY so a small Navidrome / Last.fm budget
  // can dial it down.
  const concurrency = Math.max(
    1,
    Math.min(32, parseInt(process.env.TAG_ENRICH_CONCURRENCY || '', 10) || 6),
  );

  // Skip the per-track Last.fm/lyrics loop entirely when both are disabled —
  // running it anyway would stamp enrichedAt with empty rows and mask a later
  // re-enable. The original-year loop below has its own scope + skip stamp.
  const metaIds = lastfmEnabled || lyricsEnabled ? ids : [];
  await mapPool(metaIds, concurrency, async (id) => {
    const t = db.getTrack(id);
    if (!t) return;
    if (!reEnrich && t.enrichedAt) return;

    let lastfmTags: string[] | null = null;
    if (lastfmEnabled && t.artist) {
      const tags = await artistTags(t.artist);
      lastfmTags = tags.length ? tags : null;
    }

    let lyricExcerpt: string | null = null;
    if (lyricsEnabled) {
      try {
        const raw = await subsonic.getLyrics(id);
        if (typeof raw === 'string' && raw.trim()) {
          lyricExcerpt = raw.trim();
        }
      } catch { /* ignore */ }
    }

    db.upsertTrackEnrichment(id, { lastfmTags, lyricExcerpt });
    enrichedTracks += 1;
    if (lastfmTags && lastfmTags.length) enrichedTags += 1;
    if (lyricExcerpt) enrichedLyrics += 1;
    if (enrichedTracks % 100 === 0) {
      console.log(
        `[tag] enriched ${enrichedTracks}/${metaIds.length} (lastfm: ${enrichedTags}, lyrics: ${enrichedLyrics})`,
      );
      reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: enrichedTracks, total: metaIds.length });
    }
  });

  // Original-year backfill (issue #842): compilation-album tracks whose plain
  // `year` is the compilation's own release date. Resolved via MusicBrainz
  // (music/musicbrainz.ts — earliest first-release-date across matching
  // recordings, exact-MBID first). Effectively serial regardless of pool width
  // (the client's 1 req/s throttle), so a big compilation-heavy library takes
  // a while on the first pass — hence the per-track checked_at stamp (hit OR
  // miss) that makes every later pass skip straight past it. The per-song
  // Navidrome fetch just recovers the recording MBID (not stored in
  // library.db); it's dwarfed by the MB throttle.
  if (yearIds.length) {
    console.log(`[tag] phase-0 original years: ${yearIds.length} compilation tracks to resolve via MusicBrainz (~1/s)`);
    reportProgress({ phase: 'enrich', label: 'Resolving original years', done: 0, total: yearIds.length });
    let checkedYears = 0;
    await mapPool(yearIds, Math.min(concurrency, 4), async (id) => {
      const t = db.getTrack(id);
      if (!t || !musicbrainz.needsOriginalYearLookup(t, reEnrich)) return;
      let mbid: string | null = null;
      try {
        mbid = (await subsonic.getSong(id))?.musicBrainzId || null;
      } catch { /* MBID is optional — the search path covers it */ }
      const year = await musicbrainz.lookupOriginalYear({ title: t.title, artist: t.artist, mbid, year: t.year });
      db.setOriginalYear(id, year);
      if (year != null) enrichedYears += 1;
      checkedYears += 1;
      if (checkedYears % 25 === 0) {
        console.log(`[tag] original years ${checkedYears}/${yearIds.length} (${enrichedYears} resolved)`);
        reportProgress({ phase: 'enrich', label: 'Resolving original years', done: checkedYears, total: yearIds.length });
      }
    });
  }

  logEvent(
    'info',
    `Metadata fetched for ${enrichedTracks.toLocaleString('en-GB')} tracks ` +
      `(${enrichedTags} Last.fm, ${enrichedLyrics} lyrics, ${enrichedYears} original years)`,
  );
}

