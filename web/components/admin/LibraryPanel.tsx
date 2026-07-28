'use client';

// Library — /admin/library (redesigned).
//
// One merged "Your DJ knows X%" tagging panel up top — coverage, the primary
// Start-tagging action, and progressive-disclosure Maintenance & log — then a
// clearer browse/search/untagged experience:
//   • Recently added — newest album tracks for quick discovery.
//   • Browse — filters the tagged moods index (mood/energy/genre/year/q).
//   • Search — Navidrome free-text (/dj/search, paged) plus, when the heavy
//     analyzer's CLAP text tower is up, a natural-language "sounds like" mode
//     (/library/search-sound).
//   • Untagged — paginates through library tracks that haven't been tagged yet.
//
// Tab choice, browse filters, and the search query are mirrored into the URL
// query string (history.replaceState) so reloads and shared links keep the view.
//
// Rows carry album art (via the public /cover/:id proxy, letter-tile fallback)
// and inline mood/energy tags so operators *see* what tagging produces. Each
// row supports Queue (push to the live queue) and, where applicable, Retag /
// Tag (single-track LLM classification via /library/retag).
//
// All colours come from theme tokens (the operator picks a theme in Settings),
// so the page renders correctly under every palette — no hardcoded hex.
//
// This file owns the panel's state and data fetching; the pieces it renders
// live in ./library/ (types, bits, Tabs, BrowseFilters, TrackTable, BlockedTab,
// HistoryTab, ManualTagEditor, AddToPlaylistBar).

import type { ChangeEvent, FormEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Sparkles, RefreshCw, ListMusic, X, Telescope, ArrowRight } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Card, Btn, Seg } from './ui';
import { llmProviderLabel } from './llm/providerMeta';
import TaggingPanel, { num } from './LibraryTaggingPanel';
import type {
  Coverage,
  TaggerState,
  LibraryStatsLite,
  Batch,
  BudgetMode,
  RescanOpts,
  TagSteps,
} from './LibraryTaggingPanel';
import type { PlaylistSummary } from './LibraryPlaylistsTab';
import type {
  BlockEntry,
  BlockType,
  BrowseResponse,
  Energy,
  PlayEntry,
  SearchMode,
  Sort,
  Tab,
  SettingsResponse,
  TableVariant,
  Track,
  TrackMode,
  UntaggedResponse,
  Vocal,
} from './library/types';
import { PAGE_SIZE, SEARCH_PAGE, SORTS, TABS } from './library/types';
import { Tabs } from './library/Tabs';
import { BrowseFilters } from './library/BrowseFilters';
import { TrackTable } from './library/TrackTable';
import { BlockedTab } from './library/BlockedTab';
import { HistoryTab } from './library/HistoryTab';
import { AddToPlaylistBar } from './library/AddToPlaylistBar';

export default function LibraryPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const ready = hydrated && !needsAuth;

  // shared state
  const [tab, setTab] = useState<Tab>('tracks');
  const [trackMode, setTrackMode] = useState<TrackMode>('all');
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [tagger, setTagger] = useState<TaggerState | null>(null);
  const [libStats, setLibStats] = useState<LibraryStatsLite | null>(null);
  const [batch, setBatch] = useState<Batch>('500');
  const [taggerBusy, setTaggerBusy] = useState(false);
  // settings.audio.embeddings — null until the first /settings poll lands.
  const [audioEnabled, setAudioEnabled] = useState<boolean | null>(null);
  // settings.audio.vocalActivity — null until the first /settings poll lands.
  const [vocalEnabled, setVocalEnabled] = useState<boolean | null>(null);
  // settings.audio.analyzeQuietOnly + analyzeQuietMinutes — the quiet-times
  // gate (#1099); null until the first /settings poll lands.
  const [quietEnabled, setQuietEnabled] = useState<boolean | null>(null);
  const [quietMins, setQuietMins] = useState<number | null>(null);
  // Daily-token-budget tier from /settings — null until the first slow poll lands.
  const [budgetMode, setBudgetMode] = useState<BudgetMode | null>(null);
  // Provider attribution for the Tagging modal (#1162) — "Google · gemini-2.0-
  // flash-lite" for the LLM seed calls, "OpenAI" for the embedding calls. Null
  // until the slow poll lands (the modal omits the attribution).
  const [llmLabel, setLlmLabel] = useState<string | null>(null);
  const [embedLabel, setEmbedLabel] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [queuing, setQueuing] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  // manual tagging — which row's inline editor is open, and which is saving.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  // Mood vocab, lifted out of the browse response so the editor has it on any
  // tab (browse is the only call that returns it; lazily fetched otherwise).
  const [vocab, setVocab] = useState<string[]>([]);

  // browse state
  const [moods, setMoods] = useState<string[]>([]);
  const [energy, setEnergy] = useState<Energy>('any');
  const [vocal, setVocal] = useState<Vocal>('any');
  const [genre, setGenre] = useState<string>('');
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [sort, setSort] = useState<Sort>('artist');
  const [page, setPage] = useState(0);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  // genre list (lazy)
  const [genreList, setGenreList] = useState<{ value: string; songCount: number }[]>([]);

  // search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('library');
  const [searchResults, setSearchResults] = useState<Track[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Library-mode paging: a full page from /dj/search means more may exist.
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchingMore, setSearchingMore] = useState(false);
  // The query/mode that produced searchResults — Load more must page THAT
  // search, not whatever is currently typed in the (maybe edited) input.
  const lastSearchRef = useRef<{ q: string; mode: SearchMode } | null>(null);

  // untagged state
  const [untagged, setUntagged] = useState<Track[]>([]);
  const [untaggedCursor, setUntaggedCursor] = useState<string | null>(null);
  const [untaggedLoading, setUntaggedLoading] = useState(false);

  // recent state
  const [recent, setRecent] = useState<Track[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);

  // playlist state — row selection (any track tab) + the Navidrome playlist
  // list shared by the add-to-playlist bar and the Playlists tab.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [plBusy, setPlBusy] = useState(false);

  // play-history state — the paged entry list for the History tab.
  const [historyRows, setHistoryRows] = useState<PlayEntry[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  // never-play blocklist state — the entry list for the Blocked tab, plus
  // which row's block action / which entry's unblock is in flight.
  const [blockedEntries, setBlockedEntries] = useState<BlockEntry[] | null>(null);
  const [blockedLoading, setBlockedLoading] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // URL state — tab, browse filters, and the search query live in the query
  // string so a reload / back-button / shared link lands on the same view.
  // Restored once on mount (post-hydration, so no SSR mismatch); written back
  // via history.replaceState (no Next.js navigation, no server round-trip).
  // -----------------------------------------------------------------------
  const [urlRestored, setUrlRestored] = useState(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('tab');
    // Legacy links: the old Recent and Untagged tabs are now Tracks (+ mode);
    // the old Playlists tab is the dedicated builder screen.
    if (t === 'untagged') { setTab('tracks'); setTrackMode('needs'); }
    else if (t === 'recent') setTab('tracks');
    else if (t === 'playlists') { window.location.replace('/admin/playlists'); return; }
    else if (t && (TABS as string[]).includes(t)) setTab(t as Tab);
    if (sp.get('view') === 'needs') { setTab('tracks'); setTrackMode('needs'); }
    const m = (sp.get('moods') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (m.length) setMoods(m);
    const en = sp.get('energy');
    if (en === 'low' || en === 'medium' || en === 'high') setEnergy(en);
    const vo = sp.get('vocal');
    if (vo === 'vocal' || vo === 'instrumental') setVocal(vo);
    const g = sp.get('genre');
    if (g) setGenre(g);
    const yf = sp.get('from');
    if (yf) setYearFrom(yf);
    const yt = sp.get('to');
    if (yt) setYearTo(yt);
    const bq = sp.get('q');
    if (bq) setQ(bq);
    const so = sp.get('sort');
    if (so && (SORTS as string[]).includes(so)) setSort(so as Sort);
    const sq = sp.get('sq');
    if (sq) setSearchQuery(sq);
    if (sp.get('smode') === 'sound') setSearchMode('sound');
    setUrlRestored(true);
  }, []);

  useEffect(() => {
    if (!urlRestored) return;
    const sp = new URLSearchParams();
    if (tab !== 'tracks') sp.set('tab', tab);
    if (tab === 'tracks' && trackMode === 'needs') sp.set('view', 'needs');
    if (moods.length) sp.set('moods', moods.join(','));
    if (energy !== 'any') sp.set('energy', energy);
    if (vocal !== 'any') sp.set('vocal', vocal);
    if (genre) sp.set('genre', genre);
    if (yearFrom) sp.set('from', yearFrom);
    if (yearTo) sp.set('to', yearTo);
    if (q.trim()) sp.set('q', q.trim());
    if (sort !== 'artist') sp.set('sort', sort);
    if (searchQuery.trim()) sp.set('sq', searchQuery.trim());
    if (searchMode === 'sound') sp.set('smode', 'sound');
    const qs = sp.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, [urlRestored, tab, trackMode, moods, energy, vocal, genre, yearFrom, yearTo, q, sort, searchQuery, searchMode]);

  // If coverage says the sound search can't serve (lean analyzer, no audio
  // index), drop back to the metadata mode the toggle would otherwise hide.
  useEffect(() => {
    if (coverage && coverage.soundSearchAvailable !== true && searchMode === 'sound') {
      setSearchMode('library');
    }
  }, [coverage, searchMode]);

  // -----------------------------------------------------------------------
  // polling — coverage (60 s) + tagger status (3 s while running, 10 s idle)
  // -----------------------------------------------------------------------
  const loadCoverage = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/library/coverage');
      if (!r.ok) return;
      setCoverage((await r.json()) as Coverage);
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  // Fast loop payload — just the live tagger snapshot (GET /library/tagger), so a
  // 3s running poll doesn't drag the whole heavy /settings body across each time.
  const loadTaggerState = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/library/tagger');
      if (!r.ok) return;
      const j = (await r.json()) as { tagger?: TaggerState };
      setTagger(j.tagger || null);
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  // Slow loop payload — the settings-derived bits the panel shows but that change
  // rarely: library stats, the audio/vocal opt-in toggles, and the daily-budget
  // tier. Deliberately does NOT touch tagger state (the fast loop owns that) so
  // the two pollers never race on it.
  const loadSettingsData = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json()) as SettingsResponse;
      if (j.libraryStats) setLibStats(j.libraryStats);
      if (j.values?.audio) {
        setAudioEnabled(!!j.values.audio.embeddings);
        setVocalEnabled(!!j.values.audio.vocalActivity);
        setQuietEnabled(!!j.values.audio.analyzeQuietOnly);
        setQuietMins(
          typeof j.values.audio.analyzeQuietMinutes === 'number'
            ? j.values.audio.analyzeQuietMinutes
            : 10,
        );
      }
      if (j.budget) setBudgetMode(j.budget.mode);
      // Which provider each tagging cost bills to (#1162). The tag-moods seed
      // calls always ride the chat LLM legs (tag-library resolveTagConsumers);
      // a blank embedding provider follows the LLM provider. Embedding model is
      // shown only when explicitly set — the provider-default resolution table
      // lives in Settings → Library and isn't duplicated here.
      if (j.values?.llm?.provider) {
        const llm = j.values.llm;
        setLlmLabel(llmProviderLabel(llm.provider) + (llm.model ? ` · ${llm.model}` : ''));
        const emb = j.values.embedding || {};
        const embProvider = emb.provider || llm.provider;
        setEmbedLabel(llmProviderLabel(embProvider) + (emb.model ? ` · ${emb.model}` : ''));
      }
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (!ready) return;
    loadCoverage();
    const id = setInterval(loadCoverage, 60_000);
    return () => clearInterval(id);
  }, [ready, loadCoverage]);

  // Fast: tagger state — 3s while a run is live so progress is snappy, 10s idle.
  useEffect(() => {
    if (!ready) return;
    loadTaggerState();
    const interval = tagger?.running ? 3_000 : 10_000;
    const id = setInterval(loadTaggerState, interval);
    return () => clearInterval(id);
  }, [ready, loadTaggerState, tagger?.running]);

  // Slow: settings-derived data (stats / audio toggles / budget) — 30s + on mount.
  useEffect(() => {
    if (!ready) return;
    loadSettingsData();
    const id = setInterval(loadSettingsData, 30_000);
    return () => clearInterval(id);
  }, [ready, loadSettingsData]);

  // While a run is live, poll coverage faster so the % visibly climbs.
  useEffect(() => {
    if (!ready || !tagger?.running) return;
    const id = setInterval(loadCoverage, 3_000);
    return () => clearInterval(id);
  }, [ready, tagger?.running, loadCoverage]);

  // -----------------------------------------------------------------------
  // browse fetch — debounced on filter change. Each run aborts the previous
  // in-flight request: without this, a slow earlier response can land after a
  // faster later one and overwrite the table with results for stale filters.
  // -----------------------------------------------------------------------
  const browseAbortRef = useRef<AbortController | null>(null);
  const runBrowse = useCallback(async () => {
    if (!ready) return;
    browseAbortRef.current?.abort();
    const ac = new AbortController();
    browseAbortRef.current = ac;
    setBrowseLoading(true);
    try {
      const params = new URLSearchParams();
      if (moods.length) params.set('moods', moods.join(','));
      if (energy !== 'any') params.set('energy', energy);
      if (vocal !== 'any') params.set('vocal', vocal);
      if (genre) params.set('genre', genre);
      if (yearFrom) params.set('yearFrom', yearFrom);
      if (yearTo) params.set('yearTo', yearTo);
      if (q.trim()) params.set('q', q.trim());
      params.set('sort', sort);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const r = await adminFetch(`/library/browse?${params}`, { signal: ac.signal });
      if (!r.ok) throw new Error(`browse failed (${r.status})`);
      setBrowse((await r.json()) as BrowseResponse);
    } catch (err) {
      // Superseded by a newer run — that run owns the table and the spinner.
      if (ac.signal.aborted) return;
      notify.err(errorMessage(err));
      setBrowse(null);
    } finally {
      if (!ac.signal.aborted) setBrowseLoading(false);
    }
  }, [adminFetch, ready, moods, energy, vocal, genre, yearFrom, yearTo, q, sort, page]);

  useEffect(() => {
    if (!ready || tab !== 'browse') return;
    const t = setTimeout(runBrowse, 250);
    return () => clearTimeout(t);
  }, [ready, tab, runBrowse]);

  // genre dropdown — fetch once
  useEffect(() => {
    if (!ready || genreList.length) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/library/genres');
        if (!r.ok) return;
        const j = await r.json() as { genres: { value: string; songCount: number }[] };
        if (!cancelled) setGenreList(j.genres || []);
      } catch { /* skip */ }
    })();
    return () => { cancelled = true; };
  }, [ready, adminFetch, genreList.length]);

  // reset to page 0 when any filter (other than page itself) changes
  useEffect(() => { setPage(0); }, [moods, energy, vocal, genre, yearFrom, yearTo, q, sort]);

  // -----------------------------------------------------------------------
  // search fetch — two modes: 'library' pages Navidrome metadata search
  // (/dj/search, offset appends), 'sound' is the one-shot natural-language
  // CLAP sounds-like search (/library/search-sound, no paging — fixed KNN).
  // -----------------------------------------------------------------------
  const executeSearch = useCallback(async (text: string, mode: SearchMode, offset: number) => {
    if (!text || !ready) return;
    const append = offset > 0;
    if (append) setSearchingMore(true);
    else setSearching(true);
    try {
      let rows: Track[] = [];
      let more = false;
      if (mode === 'sound') {
        const r = await adminFetch(`/library/search-sound?q=${encodeURIComponent(text)}&limit=${SEARCH_PAGE}`);
        const j = await r.json().catch(() => ({})) as { results?: Track[]; error?: string };
        if (!r.ok) throw new Error(j.error || `sound search failed (${r.status})`);
        rows = j.results || [];
      } else {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(text)}&limit=${SEARCH_PAGE}&offset=${offset}`);
        const j = await r.json().catch(() => ({})) as { results?: Track[]; hasMore?: boolean; error?: string };
        if (!r.ok) throw new Error(j.error || `search failed (${r.status})`);
        rows = j.results || [];
        // Absent on an old controller (fixed 12 rows) → no Load more, as before.
        more = !!j.hasMore;
      }
      setSearchResults(prev => (append ? [...(prev || []), ...rows] : rows));
      setSearchHasMore(more);
      lastSearchRef.current = { q: text, mode };
    } catch (err) {
      notify.err(errorMessage(err));
      if (!append) { setSearchResults([]); setSearchHasMore(false); }
    } finally {
      if (append) setSearchingMore(false);
      else setSearching(false);
    }
  }, [adminFetch, ready]);

  const runSearch = (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    executeSearch(searchQuery.trim(), searchMode, 0);
  };

  const loadMoreSearch = () => {
    const last = lastSearchRef.current;
    if (last) executeSearch(last.q, last.mode, searchResults?.length || 0);
  };

  // Deep link with a search query (?tab=search&sq=…) — run it once auth is up.
  const autoSearchedRef = useRef(false);
  useEffect(() => {
    if (!ready || !urlRestored || autoSearchedRef.current) return;
    autoSearchedRef.current = true;
    if (tab === 'search' && searchQuery.trim()) executeSearch(searchQuery.trim(), searchMode, 0);
  }, [ready, urlRestored, tab, searchQuery, searchMode, executeSearch]);

  // -----------------------------------------------------------------------
  // untagged paging
  // -----------------------------------------------------------------------
  const loadUntagged = useCallback(async (cursor: string | null, append: boolean) => {
    if (!ready) return;
    setUntaggedLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const r = await adminFetch(`/library/untagged?${params}`);
      if (!r.ok) throw new Error(`untagged failed (${r.status})`);
      const j = await r.json() as UntaggedResponse;
      setUntagged(prev => (append ? [...prev, ...j.rows] : j.rows));
      setUntaggedCursor(j.nextCursor);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setUntaggedLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab !== 'tracks' || trackMode !== 'needs' || !ready) return;
    if (untagged.length === 0) loadUntagged(null, false);
  }, [tab, trackMode, ready, untagged.length, loadUntagged]);

  // -----------------------------------------------------------------------
  // recent fetch
  // -----------------------------------------------------------------------
  const loadRecent = useCallback(async () => {
    if (!ready) return;
    setRecentLoading(true);
    try {
      const r = await adminFetch('/dj/recent?limit=50');
      if (!r.ok) throw new Error(`recent failed (${r.status})`);
      const j = await r.json() as { results: Track[] };
      setRecent(j.results || []);
    } catch (err) {
      notify.err(errorMessage(err));
      setRecent([]);
    } finally {
      setRecentLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab !== 'tracks' || trackMode !== 'all' || !ready) return;
    if (recent === null) loadRecent();
  }, [tab, trackMode, ready, recent, loadRecent]);

  // -----------------------------------------------------------------------
  // playlists — list fetch, row selection, add-to-playlist
  // -----------------------------------------------------------------------
  const loadPlaylists = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/playlists');
      const j = await r.json().catch(() => ({})) as { playlists?: PlaylistSummary[]; error?: string };
      if (!r.ok) throw new Error(j.error || `playlists failed (${r.status})`);
      setPlaylists(j.playlists || []);
    } catch (err) {
      notify.err(errorMessage(err));
      setPlaylists([]);
    }
  }, [adminFetch, ready]);

  // Selection is per-view: switching tabs drops it (ids from another tab would
  // be invisible, and "Add 12" with 9 off-screen rows is a foot-gun).
  useEffect(() => { setSelected(new Set()); }, [tab]);

  // The add-bar's dropdown needs the playlist list the first time a selection
  // appears on a track tab — fetch lazily, once.
  useEffect(() => {
    if (selected.size > 0 && playlists === null && ready) loadPlaylists();
  }, [selected.size, playlists, ready, loadPlaylists]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllRows = (rows: Track[]) => {
    setSelected(prev => {
      const all = rows.length > 0 && rows.every(r => prev.has(r.id));
      const next = new Set(prev);
      if (all) rows.forEach(r => next.delete(r.id));
      else rows.forEach(r => next.add(r.id));
      return next;
    });
  };

  const addSelectedToPlaylist = async (target: { playlistId?: string; name?: string }) => {
    const songIds = Array.from(selected);
    if (songIds.length === 0) return;
    setPlBusy(true);
    try {
      const r = target.playlistId
        ? await adminFetch(`/playlists/${encodeURIComponent(target.playlistId)}/tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songIds }),
          })
        : await adminFetch('/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: target.name, songIds }),
          });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `add to playlist failed (${r.status})`);
      const plName = target.name
        || playlists?.find(p => p.id === target.playlistId)?.name
        || 'playlist';
      notify.ok(`added ${songIds.length} track${songIds.length === 1 ? '' : 's'} to “${plName}”`);
      setSelected(new Set());
      loadPlaylists();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setPlBusy(false);
    }
  };

  // -----------------------------------------------------------------------
  // play history
  // -----------------------------------------------------------------------
  const loadHistory = useCallback(async (page: number) => {
    if (!ready) return;
    setHistoryLoading(true);
    try {
      const r = await adminFetch(`/library/history?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
      if (!r.ok) throw new Error(`history load failed (${r.status})`);
      const j = await r.json() as { total?: number; rows?: PlayEntry[] };
      setHistoryRows(j.rows || []);
      setHistoryTotal(j.total || 0);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab === 'history' && ready) loadHistory(historyPage);
  }, [tab, ready, historyPage, loadHistory]);

  // -----------------------------------------------------------------------
  // never-play blocklist
  // -----------------------------------------------------------------------
  const loadBlocked = useCallback(async () => {
    if (!ready) return;
    setBlockedLoading(true);
    try {
      const r = await adminFetch('/library/blocklist');
      if (!r.ok) throw new Error(`blocklist load failed (${r.status})`);
      const j = await r.json() as { entries?: BlockEntry[] };
      setBlockedEntries(j.entries || []);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBlockedLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab === 'blocked' && ready) loadBlocked();
  }, [tab, ready, loadBlocked]);

  const blockTrack = async (track: Track, type: BlockType) => {
    setBlocking(track.id);
    try {
      const r = await adminFetch('/library/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, trackId: track.id }),
      });
      const j = await r.json().catch(() => ({})) as { entry?: BlockEntry; purged?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `block failed (${r.status})`);
      const what = type === 'track' ? `“${track.title}”` : type === 'album' ? `album “${track.album}”` : track.artist;
      notify.ok(`${what} will never air${j.purged ? ` · ${j.purged} dropped from queue` : ''} — manage in the Blocked tab`);
      setBlockedEntries(prev => (prev && j.entry ? [...prev, j.entry] : prev));
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBlocking(null);
    }
  };

  const unblockEntry = async (e: BlockEntry) => {
    const key = `${e.type}:${e.id}`;
    setUnblocking(key);
    try {
      const r = await adminFetch(`/library/blocklist/${e.type}/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error || `unblock failed (${r.status})`);
      }
      notify.ok(`“${e.name || e.id}” can play again`);
      setBlockedEntries(prev => (prev ? prev.filter(x => !(x.type === e.type && x.id === e.id)) : prev));
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setUnblocking(null);
    }
  };

  // -----------------------------------------------------------------------
  // row actions
  // -----------------------------------------------------------------------
  const queueTrack = async (track: Track) => {
    setQueuing(track.id);
    try {
      const r = await adminFetch('/dj/queue-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      const j = await r.json().catch(() => ({})) as { queuePosition?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `queue failed (${r.status})`);
      notify.ok(`queued “${track.title}” · position ${j.queuePosition}`);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setQueuing(null);
    }
  };

  const retagTrack = async (track: Track) => {
    setRetagging(track.id);
    try {
      const r = await adminFetch('/library/retag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      const j = await r.json() as { moods?: string[]; energy?: string | null; error?: string };
      if (!r.ok) throw new Error(j.error || `retag failed (${r.status})`);
      const tagStr = j.moods?.length ? j.moods.join(', ') : '—';
      notify.ok(`retagged · ${tagStr} [${j.energy || '?'}]`);
      setFlashId(track.id);
      setTimeout(() => setFlashId(curr => (curr === track.id ? null : curr)), 1100);
      if (tab === 'browse') runBrowse();
      if (tab === 'tracks' && trackMode === 'needs') setUntagged(prev => prev.filter(t => t.id !== track.id));
      // Search/recent rows aren't refetched — patch the row so the new tags
      // show immediately (the server stamps retagged rows source='llm').
      if (tab === 'search') setSearchResults(prev => patchRows(prev, track, j.moods || [], j.energy ?? null, false, false, 'llm'));
      if (tab === 'tracks' && trackMode === 'all') setRecent(prev => patchRows(prev, track, j.moods || [], j.energy ?? null, false, false, 'llm'));
      loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setRetagging(null);
    }
  };

  // Mood vocab only rides along on the browse response. Keep `vocab` synced
  // from it, and lazily fetch a one-row browse when the editor opens on a tab
  // that hasn't loaded browse yet — avoids hardcoding SHOW_MOODS in the bundle.
  useEffect(() => {
    if (browse?.moodVocab?.length) setVocab(browse.moodVocab);
  }, [browse]);
  const ensureVocab = useCallback(async () => {
    if (vocab.length) return;
    try {
      const r = await adminFetch('/library/browse?limit=1');
      if (!r.ok) return;
      const j = (await r.json()) as BrowseResponse;
      if (j.moodVocab?.length) setVocab(j.moodVocab);
    } catch { /* editor shows a "loading moods…" hint until this lands */ }
  }, [vocab.length, adminFetch]);

  const onEditTrack = (t: Track) => {
    if (editingId === t.id) { setEditingId(null); return; }
    ensureVocab();
    setEditingId(t.id);
  };

  // Patch the visible rows after a tag write so search/recent reflect it
  // without a refetch. Album siblings in view update too when applyToAlbum.
  // `source` mirrors what the server stamped: 'manual' for the inline editor,
  // 'llm' for single-track retag.
  const patchRows = (
    rows: Track[] | null, track: Track,
    moods: string[], energy: string | null, cleared: boolean, applyToAlbum: boolean,
    source: string = 'manual',
  ): Track[] | null => {
    if (!rows) return rows;
    return rows.map(r => {
      const hit = r.id === track.id || (applyToAlbum && !!track.album && r.album === track.album);
      if (!hit) return r;
      return cleared
        ? { ...r, moods: [], energy: null, source: null }
        : { ...r, moods, energy, source };
    });
  };

  const saveManualTag = async (
    track: Track, moods: string[], energy: string | null, applyToAlbum: boolean,
  ) => {
    setManualBusy(track.id);
    try {
      const r = await adminFetch('/library/manual-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: track.id, moods, energy, applyToAlbum }),
      });
      const j = (await r.json().catch(() => ({}))) as
        { ok?: boolean; updated?: number; cleared?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      const cleared = !!j.cleared;
      const n = j.updated ?? 1;
      const scope = applyToAlbum ? `${n} album track${n === 1 ? '' : 's'}` : 'track';
      notify.ok(cleared ? `cleared tags · ${scope}` : `tagged ${scope} · ${moods.join(', ') || '—'}`);
      setEditingId(null);
      setFlashId(track.id);
      setTimeout(() => setFlashId(curr => (curr === track.id ? null : curr)), 1100);
      if (tab === 'browse') runBrowse();
      else if (tab === 'tracks' && trackMode === 'needs') {
        // Newly-tagged tracks leave the untagged list; cleared ones stay put.
        if (!cleared) {
          setUntagged(prev => prev.filter(t =>
            !(t.id === track.id || (applyToAlbum && track.album && t.album === track.album))));
        }
      } else if (tab === 'search') {
        setSearchResults(prev => patchRows(prev, track, moods, energy, cleared, applyToAlbum));
      } else if (tab === 'tracks') {
        setRecent(prev => patchRows(prev, track, moods, energy, cleared, applyToAlbum));
      }
      loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setManualBusy(null);
    }
  };

  // -----------------------------------------------------------------------
  // tagger controls
  // -----------------------------------------------------------------------
  const remaining = coverage?.total != null ? Math.max(0, coverage.total - coverage.tagged) : null;

  const startTagger = async (steps?: TagSteps) => {
    setTaggerBusy(true);
    try {
      const limit = batch === 'all' ? null : parseInt(batch, 10);
      const body: Record<string, unknown> = limit && limit > 0 ? { limit } : {};
      // Forward-run step toggles from the modal's Run tab; absent on the legacy
      // "Tag all" quick action, which then sends a plain full run.
      if (steps) Object.assign(body, steps);
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `tagger start failed (${r.status})`);
      notify.ok('tagger started');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  const stopTagger = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/tag-library/stop', { method: 'POST' });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `tagger stop failed (${r.status})`);
      notify.ok('stopping tagger…');
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Re-scan with explicit flags — each maps to a tag-library CLI flag:
  //   reseed     drop + rebuild every embedding from scratch (model-swap recovery)
  //   reEnrich   re-fetch Last.fm tags + lyrics that feed the embeddings
  //   reAnalyze  redo acoustic bpm/key analysis
  //   upgrade    re-LLM-tag only rows whose prompt/model is stale
  // Sends no limit — a partial reseed leaves the library in a mixed state KNN
  // can't use. Existing mood tags survive as seeds, so a reseed re-spends
  // embedding calls, not LLM. `thenTag` (reseed-only) rides along in opts: it
  // continues into the forward tag pass after the whole-library re-embed, still
  // with no limit so every untagged track is processed.
  const rescanTagger = async (opts: RescanOpts) => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `re-scan failed (${r.status})`);
      notify.ok('re-scan started…');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Flip settings.audio.embeddings — the "sounds-like" (CLAP) opt-in. The
  // toggle only persists the setting; vectors appear after an analysis run.
  const toggleAudio = async () => {
    if (audioEnabled == null) return;
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { embeddings: !audioEnabled } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      setAudioEnabled(!audioEnabled);
      // When the analyzer can't fingerprint yet (lean image), frame enabling as
      // pending rather than done — the incapable banner below explains the upgrade.
      const audioPending =
        coverage?.analysisAvailable !== false && coverage?.audioAnalysisAvailable === false;
      notify.ok(
        !audioEnabled
          ? audioPending
            ? 'sounds-like enabled — starts once the heavy analyzer is up'
            : 'sounds-like analysis enabled'
          : 'sounds-like analysis disabled',
      );
      // The toggle lives on the slow /settings loop — refresh it now so a manual
      // re-open / status recompute doesn't wait up to 30s to reflect the flip.
      void loadSettingsData();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Reconcile with Navidrome — walk the catalogue and prune library entries
  // for tracks that no longer exist (deleted files, or IDs re-minted by a full
  // rescan). No LLM/embedding cost; reuses the tagger's single-flight slot, so
  // the running view + stop button below cover it. Usable at 100% coverage,
  // where Start tagging is disabled.
  const reconcile = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `reconcile failed (${r.status})`);
      notify.ok('reconcile started, scanning Navidrome');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Run the analysis pass (bpm/key + audio fingerprints) as a background
  // child — same single-flight state as the tagger, so the running view and
  // stop button below cover it too.
  const analyzeAudio = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `analysis start failed (${r.status})`);
      notify.ok('audio analysis started');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Flip settings.audio.vocalActivity — the Demucs vocal-activity opt-in (#646).
  // Mirrors toggleAudio; env ANALYZE_VOCAL_ACTIVITY still wins "on".
  const toggleVocal = async () => {
    if (vocalEnabled == null) return;
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { vocalActivity: !vocalEnabled } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      setVocalEnabled(!vocalEnabled);
      // Mirrors toggleAudio: enabling on a lean analyzer is "armed", not active.
      const vocalPending =
        coverage?.analysisAvailable !== false && coverage?.vocalAnalysisAvailable === false;
      notify.ok(
        !vocalEnabled
          ? vocalPending
            ? 'vocal-activity enabled — starts once the heavy analyzer is up'
            : 'vocal-activity analysis enabled'
          : 'vocal-activity analysis disabled',
      );
      // Refresh the slow settings-derived state now rather than waiting for its
      // tick — and coverage too, so the coverage-driven bits (vocalStatus, the
      // vocal meter row) catch up without waiting out the 60s poll.
      void loadSettingsData();
      void loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Flip settings.audio.analyzeQuietOnly — the quiet-times gate (#1099): any
  // analysis run pauses while listeners are tuned in, resuming after the idle
  // window. The pass re-reads the toggle from disk on every check, so a flip
  // takes effect mid-run within one track; env ANALYZE_QUIET_ONLY still wins
  // "on".
  const toggleQuiet = async () => {
    if (quietEnabled == null) return;
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { analyzeQuietOnly: !quietEnabled } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      setQuietEnabled(!quietEnabled);
      notify.ok(
        !quietEnabled
          ? 'quiet times on — analysis pauses while anyone is listening'
          : 'quiet times off — analysis runs regardless of listeners',
      );
      void loadSettingsData();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Persist a new idle window for the quiet-times gate (minutes, 1–120) —
  // committed by the panel's number input on blur/Enter.
  const saveQuietMinutes = async (minutes: number) => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { analyzeQuietMinutes: minutes } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      setQuietMins(minutes);
      notify.ok(`quiet window set — analysis resumes after ${minutes} min with no listeners`);
      void loadSettingsData();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Backfill Demucs vocal ranges on tracks that lack them — POST with vocal:true
  // so the analyze pass forces the vocal scope (#646).
  const vocalBackfill = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vocal: true }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `vocal analysis start failed (${r.status})`);
      notify.ok('vocal analysis started');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Reset — wipe ALL tagging data (tags, embeddings, acoustics, enrichment) and
  // start fresh. Deletes library.db server-side; the Navidrome library itself is
  // untouched, so every track simply returns to the untagged pool. Gated behind
  // the modal's typed confirmation. Refused (409) while a tagger run is active.
  const resetLibrary = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `reset failed (${r.status})`);
      notify.ok('library reset — all tagging data wiped');
      // Everything the tables/meters showed is gone. Refresh coverage + settings
      // and drop the cached views so each tab reloads against the empty library.
      await loadCoverage();
      void loadSettingsData();
      setBrowse(null);
      setSearchResults(null);
      setRecent(null);
      setUntagged([]);
      setUntaggedCursor(null);
      if (tab === 'browse') runBrowse();
      else if (tab === 'tracks' && trackMode === 'all') loadRecent();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // -----------------------------------------------------------------------
  // derived
  // -----------------------------------------------------------------------
  const stats = browse?.stats;
  const moodVocab = browse?.moodVocab || [];
  const moodCounts = stats?.byMood || libStats?.byMood || {};
  const energyCounts = stats?.byEnergy || libStats?.byEnergy || {};
  const totalPages = browse ? Math.max(1, Math.ceil(browse.total / PAGE_SIZE)) : 1;
  const filtersActive =
    moods.length > 0 || energy !== 'any' || vocal !== 'any' || !!genre || !!yearFrom || !!yearTo || !!q.trim();

  const clearFilters = () => {
    setMoods([]); setEnergy('any'); setVocal('any'); setGenre(''); setYearFrom(''); setYearTo(''); setQ('');
    setSort('artist'); setPage(0);
  };

  // What the merged Tracks tab actually shows right now — drives the table's
  // rows, empty-state copy, and accent Tag button (TrackTable keys on this).
  const tableVariant: TableVariant =
    tab === 'tracks' ? (trackMode === 'needs' ? 'untagged' : 'recent') : (tab as TableVariant);
  const tableRows: Track[] =
    tableVariant === 'browse' ? (browse?.rows || []) :
    tableVariant === 'search' ? (searchResults || []) :
    tableVariant === 'untagged' ? untagged :
    (recent || []);
  const tableLoading =
    tableVariant === 'browse' ? browseLoading :
    tableVariant === 'search' ? searching :
    tableVariant === 'untagged' ? untaggedLoading :
    recentLoading;

  return (
    // grid-cols-1: the implicit `auto` track is sized by its items' min-content,
    // so a doorway card's un-shrinkable copy blew the whole column (and every
    // card stretched to it) past a phone viewport. minmax(0,1fr) caps the track.
    <div className="grid grid-cols-1 gap-5">
      {/* Doorways — Playlists and the Observatory live inside Library now
          (pulled out of the sidebar); these are their front doors. */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <a
          href="/admin/playlists"
          // min-w-0: a grid item's automatic minimum is its min-content, which
          // the nowrap/truncated blurb below would otherwise pin ~510px wide.
          className="group flex min-w-0 items-center gap-3.5 border border-ink bg-bg p-3.5 transition-colors hover:bg-ink-soft"
        >
          <span className="grid size-9 flex-none place-items-center border border-ink bg-[var(--accent)] text-white">
            <ListMusic size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-ink">Playlist Builder</span>
            <span className="block truncate font-mono text-[10px] text-muted">
              describe a vibe → an ordered set · edit by hand · save to Navidrome
            </span>
          </span>
          <ArrowRight className="size-4 flex-none text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
        </a>
        <a
          href="/observatory"
          className="group flex min-w-0 items-center gap-3.5 border border-ink bg-bg p-3.5 transition-colors hover:bg-ink-soft"
        >
          <span className="grid size-9 flex-none place-items-center border border-ink bg-ink text-bg">
            <Telescope size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-ink">Observatory</span>
            <span className="block truncate font-mono text-[10px] text-muted">
              fly the library as a starfield — moods, clusters, outliers
            </span>
          </span>
          <ArrowRight className="size-4 flex-none text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
        </a>
      </div>

      <TaggingPanel
        coverage={coverage}
        libStats={libStats}
        tagger={tagger}
        batch={batch}
        setBatch={setBatch}
        busy={taggerBusy}
        logOpen={logOpen}
        setLogOpen={setLogOpen}
        onStart={startTagger}
        onStop={stopTagger}
        onRescan={rescanTagger}
        onReconcile={reconcile}
        onReset={resetLibrary}
        audioEnabled={audioEnabled}
        onToggleAudio={toggleAudio}
        onAnalyzeAudio={analyzeAudio}
        vocalEnabled={vocalEnabled}
        onToggleVocal={toggleVocal}
        onVocalBackfill={vocalBackfill}
        quietEnabled={quietEnabled}
        quietMinutes={quietMins}
        onToggleQuiet={toggleQuiet}
        onQuietMinutes={saveQuietMinutes}
        budgetMode={budgetMode}
        llmLabel={llmLabel}
        embedLabel={embedLabel}
      />

      <Tabs tab={tab} setTab={setTab} />

      {/* contextual controls */}
      {tab === 'browse' && (
        <BrowseFilters
          moodVocab={moodVocab}
          moodCounts={moodCounts}
          energyCounts={energyCounts}
          genreList={genreList}
          moods={moods} setMoods={setMoods}
          energy={energy} setEnergy={setEnergy}
          vocal={vocal} setVocal={setVocal}
          genre={genre} setGenre={setGenre}
          yearFrom={yearFrom} setYearFrom={setYearFrom}
          yearTo={yearTo} setYearTo={setYearTo}
          q={q} setQ={setQ}
          sort={sort} setSort={setSort}
        />
      )}

      {tab === 'browse' && filtersActive && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span className="caption">active</span>
          {moods.map(m => (
            <span key={m} className="lib-active-chip">
              {m}<button type="button" onClick={() => setMoods(moods.filter(x => x !== m))} aria-label={`remove ${m}`}>×</button>
            </span>
          ))}
          {energy !== 'any' && (
            <span className="lib-active-chip">{energy} energy<button type="button" onClick={() => setEnergy('any')} aria-label="remove energy">×</button></span>
          )}
          {vocal !== 'any' && (
            <span className="lib-active-chip">{vocal}<button type="button" onClick={() => setVocal('any')} aria-label="remove vocal filter">×</button></span>
          )}
          {genre && (
            <span className="lib-active-chip">{genre}<button type="button" onClick={() => setGenre('')} aria-label="remove genre">×</button></span>
          )}
          {(yearFrom || yearTo) && (
            <span className="lib-active-chip">{yearFrom || '…'}–{yearTo || '…'}<button type="button" onClick={() => { setYearFrom(''); setYearTo(''); }} aria-label="remove year">×</button></span>
          )}
          {q.trim() && (
            <span className="lib-active-chip">“{q.trim()}”<button type="button" onClick={() => setQ('')} aria-label="remove search">×</button></span>
          )}
          <button type="button" className="inline-flex items-center gap-1 font-bold text-muted hover:text-ink" onClick={clearFilters}>
            <X size={12} /> clear all
          </button>
        </div>
      )}

      {tab === 'search' && (
        <Card bodyClass="!py-3">
          <div className="grid gap-2.5">
            {/* Mode toggle only when the CLAP text tower + audio index exist —
                on lean installs the tab stays plain metadata search. */}
            {coverage?.soundSearchAvailable === true && (
              <div className="flex flex-wrap items-center gap-3">
                <Seg
                  value={searchMode}
                  options={[
                    { id: 'library', label: 'Library' },
                    { id: 'sound', label: 'Sounds like' },
                  ]}
                  onChange={(v: string) => {
                    setSearchMode(v as SearchMode);
                    setSearchResults(null);
                    setSearchHasMore(false);
                  }}
                />
                {searchMode === 'sound' && (
                  <span className="text-[11px] text-muted">
                    describe a sound — matches the audio itself, not titles or tags
                  </span>
                )}
              </div>
            )}
            {/* Phone: the query takes a full row of its own and the two buttons
                share the row under it; from sm: the original single-row grid. */}
            <form onSubmit={runSearch} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_auto_auto]">
              <InputGroup className="col-span-2 sm:col-span-1">
                <InputGroupAddon><Search /></InputGroupAddon>
                <InputGroupInput
                  // `required` only; deliberately no minLength — one-character
                  // queries are legitimate here (an album called "1", an artist
                  // filed under "M") and a length floor would reject them with a
                  // native validation bubble.
                  required
                  placeholder={searchMode === 'sound'
                    ? 'dusty late-night jazz with brushed drums, warm acoustic fingerpicking…'
                    : 'floating points, kingdoms in colour, 2018…'}
                  value={searchQuery}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                />
              </InputGroup>
              <Btn tone="accent" type="submit" disabled={searching || !searchQuery.trim() || !ready}>
                {searching ? 'Searching…' : 'Search'}
              </Btn>
              <Btn type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); setSearchHasMore(false); }} disabled={searching}>
                Clear
              </Btn>
            </form>
          </div>
        </Card>
      )}

      {/* add-to-playlist bar — appears when rows are selected on a track tab */}
      {tab !== 'blocked' && tab !== 'history' && selected.size > 0 && (
        <AddToPlaylistBar
          count={selected.size}
          playlists={playlists}
          busy={plBusy}
          onAdd={addSelectedToPlaylist}
          onClear={() => setSelected(new Set())}
        />
      )}

      {tab === 'blocked' && (
        <BlockedTab
          entries={blockedEntries}
          loading={blockedLoading}
          unblocking={unblocking}
          onUnblock={unblockEntry}
          onRefresh={loadBlocked}
        />
      )}

      {tab === 'history' && (
        <HistoryTab
          rows={historyRows}
          total={historyTotal}
          page={historyPage}
          setPage={setHistoryPage}
          loading={historyLoading}
          queuing={queuing}
          onQueue={queueTrack}
          onRefresh={() => loadHistory(historyPage)}
        />
      )}

      {/* track list */}
      {tab !== 'blocked' && tab !== 'history' && (
      <Card
        title={
          tableVariant === 'browse' ? 'Tracks' :
          tableVariant === 'search' ? 'Search results' :
          tableVariant === 'untagged' ? 'Needs tags' :
          'Recently added'
        }
        sub={
          tableVariant === 'browse'
            ? (browse ? `${num(browse.total)} match${browse.total === 1 ? '' : 'es'}` : '')
            : tableVariant === 'search' ? (searchResults ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}` : 'enter a query')
            : tableVariant === 'untagged' ? `${untagged.length} loaded${remaining != null ? ` · ${num(remaining)} need tags` : ''}`
            : (recent ? `${recent.length} tracks` : '')
        }
        right={
          tab === 'tracks' ? (
            <span className="flex flex-wrap items-center gap-2.5">
              <Seg
                value={trackMode}
                options={[
                  { id: 'all', label: 'All' },
                  { id: 'needs', label: `Needs tags${remaining != null ? ` · ${num(remaining)}` : ''}` },
                ]}
                onChange={(v: string) => setTrackMode(v as TrackMode)}
              />
              {trackMode === 'needs' && untagged.length > 0 ? (
                <Btn sm tone="accent" onClick={() => startTagger()} disabled={tagger?.running || taggerBusy}>
                  <Sparkles size={11} /> Tag all
                </Btn>
              ) : trackMode === 'all' ? (
                <Btn sm onClick={loadRecent} disabled={recentLoading}>
                  <RefreshCw size={11} /> {recentLoading ? 'Loading…' : 'Refresh'}
                </Btn>
              ) : null}
            </span>
          ) : null
        }
        bodyClass="!p-0"
      >
        <TrackTable
          tab={tableVariant}
          rows={tableRows}
          loading={tableLoading}
          queuing={queuing}
          retagging={retagging}
          flashId={flashId}
          onQueue={queueTrack}
          onRetag={retagTrack}
          blocking={blocking}
          onBlock={blockTrack}
          vocab={vocab}
          editingId={editingId}
          manualBusy={manualBusy}
          onEdit={onEditTrack}
          onSaveManual={saveManualTag}
          onCancelEdit={() => setEditingId(null)}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAllRows}
        />
      </Card>
      )}

      {tab === 'browse' && browse && browse.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-y-2 text-[11px] text-muted">
          <span className="mono-num">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, browse.total)} of {num(browse.total)}
          </span>
          <span className="flex items-center gap-2">
            <Btn sm disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</Btn>
            <span className="mono-num">page {page + 1} of {totalPages}</span>
            <Btn sm disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>next ›</Btn>
          </span>
        </div>
      )}

      {tab === 'search' && searchHasMore && (searchResults?.length || 0) > 0 && (
        <div className="flex justify-center">
          <Btn onClick={loadMoreSearch} disabled={searchingMore}>
            {searchingMore ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}

      {tab === 'tracks' && trackMode === 'needs' && untaggedCursor && (
        <div className="flex justify-center">
          <Btn onClick={() => loadUntagged(untaggedCursor, true)} disabled={untaggedLoading}>
            {untaggedLoading ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
// Masthead tabs: icon left, name + subtitle stacked right. No count badges —
// the panel subtitle below reports the real numbers for whichever view is open.
