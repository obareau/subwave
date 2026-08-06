import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { definePickerTool } from '../defs.js';

// Only registered when the controller's own text/mood embedding index has been
// built (withEmbedding > 0). This tool does KNN over the seed track's STORED
// vector (library.tracksLikeThis -> db.knnById) and never calls the embedding
// provider at query time, so it works whenever the index exists — mirroring how
// tracksThatSoundLikeThis gates on hasAudioEmbeddings. Without an index every
// call returns [], and the old description said "Prefer this to similarSongs",
// actively steering the model into a dead tool — so gate it off entirely rather
// than offer an unusable option.
export default definePickerTool({
  name: 'tracksLikeThis',
  available: ({ hasTextEmbeddings }) => hasTextEmbeddings,
  build: ({ emptyResult, seedSimilarity, stats, textIndexDegraded }) => tool({
    description: 'Tracks whose mood + lyrics + metadata embed closest to a seed track — the library\'s own semantic similarity. Pass the currently-playing song id (best) OR a track title.'
      // Degraded-index honesty (#1246): with mostly label-only vectors this
      // tool ranks by artist/album TEXT while calling itself semantic — the
      // model then reasons about an artist-name ranking as if it were a mood
      // ranking. Say what the ranking really is so it weighs results right.
      + (textIndexDegraded
          ? ' NOTE: most of this library\'s text vectors carry only artist/title/album labels (no tags, lyrics or measured sound), so "similar" here largely means same artist or same scene BY NAME — lean on the mood/genre/audio tools for real musical similarity.'
          : ''),
    // No k input: the agent reliably picked a small k (10–20), and the
    // nearest neighbours cluster tightly + many are recently-played, so that
    // left ~1 survivor after recency filtering. Pull a wide fixed KNN (60)
    // internally — collect() still caps to 8 fresh ones. Mirrors the journey
    // tool, which also takes no args.
    inputSchema: z.object({
      songId: z.string().describe('a song id (preferred) or a track title'),
    }),
    execute: async ({ songId }) => {
      try {
        await library.load();
        const { tracks, matched, fellBack } = seedSimilarity(songId, 'text');
        if (tracks.length) {
          // Say which index answered. Without this the model reads audio
          // neighbours as mood/lyric matches and reasons about them on the
          // wrong axis — the same mislabelling #1246 reports in the other
          // direction.
          return fellBack
            ? { tracks, note: 'that track has no mood/lyric embedding yet, so these come from the SOUND index instead — they match the seed\'s timbre and production, not its tags or words' }
            : tracks;
        }
        return emptyResult(matched,
          `that track has no embedding yet (${stats.withEmbedding ?? 0} of ${stats.total} tracks indexed so far) — choose from your other tool results this round`);
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
