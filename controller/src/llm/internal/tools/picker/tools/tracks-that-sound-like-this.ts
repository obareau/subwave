import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { definePickerTool } from '../defs.js';

// Only registered when the CLAP audio embedding index has been built
// (withAudioEmbedding > 0). Without audio vectors every call returns [] — gate
// it off so the model is never offered an option it cannot use.
export default definePickerTool({
  name: 'tracksThatSoundLikeThis',
  available: ({ hasAudioEmbeddings }) => hasAudioEmbeddings,
  build: ({ emptyResult, seedSimilarity, stats }) => tool({
    description: 'Tracks whose ACTUAL SOUND (timbre, instrumentation, production, energy) is closest to a seed track — blind to tags and metadata, so it shines for instrumentals and non-English tracks. Pass the currently-playing song id (best) OR a track title.',
    // No k input: the agent reliably picked a small k (10–20), and audio
    // neighbours cluster tightly + many are recently-played, so that left ~1
    // survivor after recency filtering. Pull a wide fixed KNN (60) internally
    // — collect() still caps to 8 fresh ones. Mirrors the journey tool, which
    // also takes no args.
    inputSchema: z.object({
      songId: z.string().describe('a song id (preferred) or a track title'),
    }),
    execute: async ({ songId }) => {
      try {
        await library.load();
        const { tracks, matched, fellBack } = seedSimilarity(songId, 'audio');
        if (tracks.length) {
          return fellBack
            ? { tracks, note: `the seed has no audio fingerprint yet (audio analysis covers ${stats.withAudioEmbedding ?? 0} of ${stats.total} tracks so far), so these come from the mood/lyric index instead — they match the seed's tags and words, not its sound` }
            : tracks;
        }
        return emptyResult(matched,
          `the seed track likely has no audio vector yet (audio analysis covers ${stats.withAudioEmbedding ?? 0} of ${stats.total} tracks so far) — choose from your other tool results this round`);
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
