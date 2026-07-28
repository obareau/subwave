// Shapes and constants the library panel and its tabs share.
//
// Part of the library/ split - see ../LibraryPanel.tsx.

 
import type { TaggerState, LibraryStatsLite, BudgetMode } from '../LibraryTaggingPanel';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------
export interface Track {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  genre?: string | null;
  duration?: number | null;
  moods?: string[];
  energy?: string | null;
  source?: string | null;
  taggedAt?: string;
  // Acoustic-analysis surface — null/undefined until the analyze pass runs.
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  paceMean?: number | null;
  instrumental?: boolean | null;
  // Cosine match vs the query — only on sounds-like search results.
  similarity?: number | null;
}

export interface BrowseResponse {
  rows: Track[];
  total: number;
  moodVocab: string[];
  stats: {
    total: number;
    byMood: Record<string, number>;
    byEnergy: Record<string, number>;
    byGenre: Record<string, number>;
    updatedAt: string | null;
  };
}

export interface UntaggedResponse { rows: Track[]; nextCursor: string | null }

// Never-play blocklist entry (GET /library/blocklist) — name/artist/album are
// display snapshots taken at block time, so no Navidrome re-lookup to render.
export type BlockType = 'track' | 'album' | 'artist';
export interface BlockEntry {
  type: BlockType;
  id: string;
  name: string | null;
  artist: string | null;
  album: string | null;
  addedAt: string;
}

// One aired track from the durable play history (GET /library/history).
// Title/artist/album are air-time snapshots; showName is the show that was on.
export interface PlayEntry {
  id: number;
  trackId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  playedAt: string;
  source: string | null;       // 'ai' | 'request' | 'auto'
  requestedBy: string | null;
  showId: string | null;
  showName: string | null;
}

// Coverage / TaggerState / LibraryStatsLite / Batch / RescanOpts live in
// LibraryTaggingPanel.tsx alongside the panel that renders them.

export interface SettingsResponse {
  tagger?: TaggerState;
  libraryStats?: LibraryStatsLite;
  // Only the slice this panel needs from the full settings payload.
  values?: {
    audio?: {
      embeddings?: boolean;
      vocalActivity?: boolean;
      analyzeQuietOnly?: boolean;
      analyzeQuietMinutes?: number;
    };
    // Provider attribution for the Tagging modal's cost preview (#1162): the
    // mood/energy seed calls bill to the chat LLM, the embedding calls to the
    // embedding provider (blank = follows the LLM provider).
    llm?: { provider?: string; model?: string };
    embedding?: { provider?: string; model?: string };
  };
  // Daily-token-budget tier — drives the "budget nearly/already used" warning in
  // the Tagging modal. Absent on an old controller → treated as 'normal'.
  budget?: { mode: BudgetMode };
}

export type Tab = 'tracks' | 'browse' | 'search' | 'history' | 'blocked';
// The Tracks tab folds the old Recent + Untagged tabs into one view with an
// All / Needs-tags toggle; TableVariant keeps TrackTable's per-view behaviour
// (empty-state copy, accent Tag button) keyed on what's actually shown.
export type TrackMode = 'all' | 'needs';
export type TableVariant = 'recent' | 'browse' | 'search' | 'untagged';
export type Sort = 'artist' | 'title' | 'year' | 'taggedAt' | 'bpm' | 'loudness' | 'pace';
export type Energy = 'any' | 'low' | 'medium' | 'high';
export type Vocal = 'any' | 'instrumental' | 'vocal';
// 'library' = Navidrome metadata search (/dj/search); 'sound' = natural-language
// CLAP sounds-like search (/library/search-sound), shown only when coverage
// reports the capability.
export type SearchMode = 'library' | 'sound';

export const PAGE_SIZE = 50;
export const SEARCH_PAGE = 30;

export const TABS: Tab[] = ['tracks', 'browse', 'search', 'history', 'blocked'];
export const SORTS: Sort[] = ['artist', 'title', 'year', 'taggedAt', 'bpm', 'loudness', 'pace'];

// ---------------------------------------------------------------------------
// small shared parts
// ---------------------------------------------------------------------------
// Track length as m:ss, or null when unknown/zero (Navidrome omits duration on
// some rows — don't render "0:00" for those).

