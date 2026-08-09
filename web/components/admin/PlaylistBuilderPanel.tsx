'use client';

/* Playlist Builder: a RECIPE rail (prompt + seeds + tuning) beside a RESULT
   pane state machine (result / empty / generating / no-match / error). Saves
   land in Navidrome via the /playlists routes, so the set feeds the Shows
   picker immediately. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, X, Search, ArrowUp, ArrowDown, ChevronRight, ChevronUp, ChevronDown,
  GripVertical, RefreshCw, Trash2, FolderOpen, FilePlus2, Save,
} from 'lucide-react';
import { Controller, useWatch } from 'react-hook-form';
import type { z } from 'zod';
import { useAdminAuth } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { V3Alert } from '../ui/alert';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/cn';
import { useZodForm, applyServerFieldErrors } from '../../lib/form';
import { TextField, TextareaField, SwitchField, ToggleGroupField } from '../../lib/form-fields';
import { EnergyGraph } from './playlist-builder/EnergyGraph';
import {
  Chip,
  DualRange,
  Eyeb,
  IconBtn,
  Tog,
  energyBgClass,
  energyLabel,
} from './playlist-builder/bits';
import { runGenerationJob } from './playlist-builder/generate';
import type {
  ArcShape,
  DraftTrack,
  GenMode,
  PlaylistSummary,
  RawTrackRow,
  SeedChip,
  View,
} from './playlist-builder/types';
import {
  API,
  ARCS,
  BPM_MAX,
  BPM_MIN,
  BPM_STEP,
  ENERGIES,
  LEN_MAX,
  LEN_STEP,
  YEAR_MAX,
  YEAR_MIN,
  fmtDur,
  fmtRun,
  relTime,
  rowToDraft,
} from './playlist-builder/types';
import {
  PLAYLIST_NAME_MAX,
  playlistGenerateSchema,
  playlistHasIntent,
  playlistSaveSchema,
} from '@/lib/schemas.generated';

// ─── The generate-vs-save split (task-11-brief step 2) ─────────────────────
//
// This panel drives TWO request bodies: POST /playlists/generate (a preview,
// never persisted) and POST /playlists (the create/overwrite call). Only the
// second is "the create body" — but its `recipe` field is the SAME shape
// /generate takes (playlistRecipeSchema mirrors playlistGenerateSchema minus
// excludeTrackIds), and `recipe` rides on every save where "Keep in sync" is
// on. So every recipe-rail input (prompt, seeds, moods, genres, energies,
// year/bpm/length bounds, artists, arc, count, artistSpacing, the three
// source/knob switches) genuinely belongs to BOTH bodies, not just the
// generate one — RecipeFormValues below holds all of them.
//
// Two fields are deliberately left OUT of RecipeFormValues, per the brief:
// `seedArtist` and `genreInput`. `genreInput` is a real uncommitted text
// buffer (only becomes a value on Enter/comma/blur via addGenre). `seedArtist`
// is arguably not that — once picked from a search result it IS a committed
// value, same shape as a `seeds` chip — but it carries no schema rule either
// way (playlistText — free text, unchecked) and buildBody() below reads it
// directly regardless of where it lives, so keeping it as plain state loses
// no correctness, only RHF's reset/dirty-tracking for that one field. Kept as
// plain state per the brief's explicit instruction.
//
// The knobs/sources wire shape (playlistLooseRecord) is UNVALIDATED
// passthrough by design (see schemas/playlist.ts's header comment) — there is
// no per-field rule anywhere for moods/genres/energies/artists/arc/count/etc.
// The only whole-object rule in the whole module is `playlistHasIntent`,
// which playlistGenerateSchema enforces via `.refine`. Binding this form's
// resolver to playlistGenerateSchema does NOT make `formState.isValid` track
// that rule, though: the refine reads `input.knobs.moods` /
// `input.sources.recentlyAdded` / etc, and this form's fields are flat
// (`moods`, `recentlyAdded`, `yearFrom`/`yearTo` rather than `knobs.eras[]`)
// to match the rail's own UI concepts, which is what buildBody() below
// derives the wire shape FROM — so `isValid` here would only ever see
// `prompt` correctly and stays false-negative for every other case. Per step
// 6: the schema does not express the rule this form needs, so
// `playlistHasIntent(buildBody())` stays the real Generate gate, called
// directly, exactly as before conversion — `isValid` from this binding is
// otherwise inert and never read.
//
// The SAVE modal is a second, separate form (SaveFormValues) bound to
// playlistSaveSchema itself. `name` is the ONE real rule in that schema (1-120
// chars) and is the only field this form validates meaningfully — `isValid`
// on THIS binding correctly reduces to "is name valid", since songIds/
// playlistId/recipe are assembled at submit time from live component state
// (tracks/existingId/the recipe form's buildBody()) rather than tracked as
// interactive fields here. `saveMode` isn't a schema key at all (it only
// steers which value `playlistId` gets) but travels in this form anyway since
// it's a real save-time choice, not generation-only state.
interface RecipeFormValues {
  prompt: string;
  seeds: SeedChip[];
  moods: string[];
  genres: string[];
  energies: string[];
  yearFrom: number;
  yearTo: number;
  bpmOn: boolean;
  minBpm: number;
  maxBpm: number;
  artists: string[];
  arc: ArcShape;
  count: number;
  artistSpacing: number;
  capOn: boolean;
  minSec: number;
  maxSec: number;
  excludeRecent: boolean;
  instrumentalOnly: boolean;
  recentlyAdded: boolean;
}

const RECIPE_DEFAULTS: RecipeFormValues = {
  prompt: '',
  seeds: [],
  moods: [],
  genres: [],
  energies: [],
  yearFrom: YEAR_MIN,
  yearTo: YEAR_MAX,
  bpmOn: false,
  minBpm: BPM_MIN,
  maxBpm: BPM_MAX,
  artists: [],
  arc: 'flat',
  count: 25,
  artistSpacing: 2,
  capOn: false,
  minSec: 0,
  maxSec: LEN_MAX,
  excludeRecent: false,
  instrumentalOnly: false,
  recentlyAdded: false,
};

interface SaveFormValues {
  name: string;
  keepInSync: boolean;
  saveMode: 'overwrite' | 'create';
}

const SAVE_DEFAULTS: SaveFormValues = { name: '', keepInSync: false, saveMode: 'create' };

export default function PlaylistBuilderPanel() {
  const { adminFetch } = useAdminAuth();

  // Both playlistGenerateSchema and playlistSaveSchema are `z.preprocess(...)`
  // wrapped (see schemas/playlist.ts — the non-object-body fallback), which
  // makes their inferred `_input` `unknown` rather than a FieldValues-shaped
  // object, so useZodForm's own generic bound can't be satisfied by passing
  // them directly. The schema is cast to the form's own field shape here —
  // same one-cast-not-fought-at-every-callsite move as `Control<T>` elsewhere
  // in this file, just applied one level up. Nothing about runtime validation
  // changes: zodResolver(schema) inside useZodForm still runs the real
  // schema against the real posted values.
  const recipeForm = useZodForm(
    playlistGenerateSchema as unknown as z.ZodType<RecipeFormValues, RecipeFormValues>,
    RECIPE_DEFAULTS,
  );
  const recipeControl = recipeForm.control;
  const recipeValues = useWatch({ control: recipeControl }) as RecipeFormValues;

  const saveForm = useZodForm(
    playlistSaveSchema as unknown as z.ZodType<SaveFormValues, SaveFormValues>,
    SAVE_DEFAULTS,
  );
  const saveControl = saveForm.control;
  const saveNameValue = useWatch({ control: saveControl, name: 'name' });

  const [seedArtist, setSeedArtist] = useState('');
  const [genreInput, setGenreInput] = useState('');

  const [view, setView] = useState<View>('empty');
  const [name, setName] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [tracks, setTracks] = useState<DraftTrack[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [usedFallback, setUsedFallback] = useState(false);
  const [poolSize, setPoolSize] = useState<number | null>(null);
  // Frozen at the last generation so manual deck edits don't rewrite the
  // "chose N from M in pool" line. 'more' reports 'added', since its pool
  // excludes the current deck and the figure is never a mixed total.
  const [chosenCount, setChosenCount] = useState(0);
  const [poolVerb, setPoolVerb] = useState<'chose' | 'added'>('chose');
  const [errorMsg, setErrorMsg] = useState('');
  const [existingId, setExistingId] = useState<string | undefined>();
  const [keepInSync, setKeepInSync] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{ lastSyncedAt: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [modal, setModal] = useState<null | 'open' | 'save'>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [playlistQuery, setPlaylistQuery] = useState('');
  // Two-click armed delete in the Open modal — the only delete surface.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const [graphOpen, setGraphOpen] = useState(true);
  const [caveatsOpen, setCaveatsOpen] = useState(false);
  const [hotRow, setHotRow] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hotTimer = useRef<number | null>(null);
  const [toast, setToast] = useState('');

  // The live mood NAMES off /settings (tts.moods) — moods are operator-editable
  // (/admin/moods), so a hand-copied vocabulary here was wrong twice over: a
  // custom mood was unpickable and a deleted one was still offered.
  const [liveMoods, setLiveMoods] = useState<string[]>([]);

  const [seedQuery, setSeedQuery] = useState('');
  const [seedResults, setSeedResults] = useState<RawTrackRow[] | null>(null);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<RawTrackRow[] | null>(null);
  const [artistQuery, setArtistQuery] = useState('');
  const [artistResults, setArtistResults] = useState<string[] | null>(null);
  const [genreList, setGenreList] = useState<{ value: string; songCount: number }[] | null>(null);

  const dragIndex = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const lastMode = useRef<GenMode>('fresh');
  const generatingRef = useRef(false);

  // Header height, Navidrome banner and breadcrumb wrap all vary, so the frame
  // top is measured and stretched to the viewport bottom less the 24px page
  // gutter. The class-based calc() is only the first-paint estimate.
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      if (window.innerWidth < 1024) { setFrameH(null); return; }
      const top = el.getBoundingClientRect().top + window.scrollY;
      const fit = window.innerHeight - top - 24;
      setFrameH(Math.max(480, Math.round(fit)));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => { window.removeEventListener('resize', measure); ro.disconnect(); };
  }, []);
  useDynamicStyle(frameRef, { height: frameH ? `${frameH}px` : null });

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 4200);
  }, []);

  // Document-level rather than on the dialog markup, so Escape fires wherever
  // focus happens to be.
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/settings');
        if (!r.ok || cancelled) return;
        const j = await r.json() as { tts?: { moods?: string[] } };
        if (!cancelled && Array.isArray(j.tts?.moods)) setLiveMoods(j.tts.moods);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [adminFetch]);

  // Already-selected moods union in, so retiring a mood at /admin/moods can't
  // make a picked chip vanish from under the operator.
  const moodOptions = useMemo(() => {
    const out = [...liveMoods];
    for (const m of recipeValues.moods) if (!out.includes(m)) out.push(m);
    return out;
  }, [liveMoods, recipeValues.moods]);

  // Without this the modal is only reachable by tabbing through the page behind
  // it, and closing leaves focus on <body>.
  const modalPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modal) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    modalPanelRef.current?.focus();
    return () => restoreTo?.focus?.();
  }, [modal]);

  // Centres the row inside the LIST's own scroll context — scrollIntoView would
  // drag the page along.
  const jumpToRow = useCallback((i: number) => {
    // ScrollArea scrolls its internal radix viewport, not the Root that listRef
    // points at — resolve it so scrollTop/scrollTo act on the right element.
    const root = listRef.current;
    const list = root?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? root;
    const row = list?.querySelector<HTMLElement>(`[data-row="${i}"]`);
    if (!list || !row) return;
    if (list.scrollHeight > list.clientHeight) {
      const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTo({ top: list.scrollTop + delta - list.clientHeight / 2 + row.clientHeight / 2, behavior: 'smooth' });
    } else {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' }); // mobile: list flows with the page
    }
    setHotRow(i);
    if (hotTimer.current) window.clearTimeout(hotTimer.current);
    hotTimer.current = window.setTimeout(() => setHotRow(null), 1600);
  }, []);

  const totalSec = useMemo(() => tracks.reduce((s, t) => s + (t.durationSec || 0), 0), [tracks]);
  const dupeIds = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const t of tracks) { if (seen.has(t.id)) dup.add(t.id); seen.add(t.id); }
    return dup;
  }, [tracks]);

  const buildBody = useCallback((excludeTrackIds: string[] = []) => ({
    prompt: recipeValues.prompt.trim() || undefined,
    seedTrackIds: recipeValues.seeds.map(s => s.id),
    seedArtist: seedArtist || undefined,
    knobs: {
      targetCount: recipeValues.count,
      energyArc: recipeValues.arc,
      moods: recipeValues.moods,
      genres: recipeValues.genres,
      energies: recipeValues.energies,
      artists: recipeValues.artists,
      eras: recipeValues.yearFrom > YEAR_MIN || recipeValues.yearTo < YEAR_MAX
        ? [{ fromYear: recipeValues.yearFrom > YEAR_MIN ? recipeValues.yearFrom : null, toYear: recipeValues.yearTo < YEAR_MAX ? recipeValues.yearTo : null }]
        : [],
      artistSpacing: recipeValues.artistSpacing,
      excludeRecentlyPlayed: recipeValues.excludeRecent,
      instrumentalOnly: recipeValues.instrumentalOnly,
      minTrackSeconds: recipeValues.capOn && recipeValues.minSec > 0 ? recipeValues.minSec : undefined,
      maxTrackSeconds: recipeValues.capOn && recipeValues.maxSec < LEN_MAX ? recipeValues.maxSec : undefined,
      minBpm: recipeValues.bpmOn && recipeValues.minBpm > BPM_MIN ? recipeValues.minBpm : undefined,
      maxBpm: recipeValues.bpmOn && recipeValues.maxBpm < BPM_MAX ? recipeValues.maxBpm : undefined,
    },
    sources: { recentlyAdded: recipeValues.recentlyAdded },
    excludeTrackIds,
  }), [recipeValues, seedArtist]);

  // The SAME intent rule the /generate routes enforce (the schema's own
  // refinement runs playlistHasIntent too) — the Generate button needs the
  // answer before a request exists, which is why the predicate is exported
  // rather than living only inside the schema. See the split comment at the
  // top of this file for why this stays a direct call rather than
  // `recipeForm.formState.isValid`.
  const hasIntent = useMemo(() => playlistHasIntent(buildBody()), [buildBody]);

  const generating = view === 'generating';

  const generate = useCallback(async (mode: GenMode) => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    lastMode.current = mode;
    const exclude = mode === 'fresh' ? [] : tracks.map(t => t.id);
    setView('generating');
    try {
      const j = await runGenerationJob(adminFetch, buildBody(exclude));
      const got: DraftTrack[] = j.tracks || [];
      if (!got.length) {
        setView(mode === 'more' && tracks.length ? 'result' : 'nomatch');
        if (mode === 'more' && tracks.length) flash('nothing new matched — loosen the filters');
        return;
      }
      setReasons(j.reasons || []);
      setUsedFallback(!!j.usedFallback);
      setCaveatsOpen(!!j.usedFallback); // fallback matters — open the detail unprompted
      setPoolSize(typeof j.poolSize === 'number' ? j.poolSize : null);
      setChosenCount(got.length);
      setPoolVerb(mode === 'more' ? 'added' : 'chose');
      if (mode === 'more') {
        setTracks(prev => [...prev, ...got]);
        flash(`added ${got.length} more track${got.length === 1 ? '' : 's'}`);
      } else {
        setTracks(got);
        if (j.name && (!name.trim() || mode === 'fresh')) setName(j.name);
        setDescription(j.description || null);
        flash(`${got.length} tracks generated`);
      }
      setView('result');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'generation failed';
      setErrorMsg(msg);
      setView(mode === 'more' && tracks.length ? 'result' : 'error');
      if (mode === 'more' && tracks.length) flash(msg);
    } finally {
      generatingRef.current = false;
    }
  }, [tracks, adminFetch, buildBody, flash, name]);

  // Seed search; `stale` guards a slow response clobbering a newer query.
  useEffect(() => {
    const q = seedQuery.trim();
    if (q.length < 2) { setSeedResults(null); return; }
    let stale = false;
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=8`);
        const j = await r.json();
        if (!stale) setSeedResults(j.results || j.songs || j.tracks || []);
      } catch { if (!stale) setSeedResults([]); }
    }, 250);
    return () => { stale = true; window.clearTimeout(h); };
  }, [seedQuery, adminFetch]);

  // Manual add search (debounced, same staleness guard)
  useEffect(() => {
    const q = addQuery.trim();
    if (q.length < 2) { setAddResults(null); return; }
    let stale = false;
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=10`);
        const j = await r.json();
        if (!stale) setAddResults(j.results || j.songs || j.tracks || []);
      } catch { if (!stale) setAddResults([]); }
    }, 250);
    return () => { stale = true; window.clearTimeout(h); };
  }, [addQuery, adminFetch]);

  // Genre vocabulary — fetched once on first focus; suggestions filter locally.
  const loadGenres = useCallback(async () => {
    if (genreList) return;
    try {
      const r = await adminFetch('/library/genres');
      const j = await r.json();
      setGenreList(j.genres || []);
    } catch { setGenreList([]); }
  }, [adminFetch, genreList]);

  const genreSuggestions = useMemo(() => {
    if (!genreList) return null;
    const q = genreInput.trim().toLowerCase();
    if (!q) return null;
    const chosen = new Set(recipeValues.genres.map(g => g.toLowerCase()));
    const hits = genreList.filter(g => g.value.toLowerCase().includes(q) && !chosen.has(g.value.toLowerCase()));
    return hits.slice(0, 8);
  }, [genreList, genreInput, recipeValues.genres]);

  // Artist-filter search (debounced) — suggests distinct artist credits.
  useEffect(() => {
    const q = artistQuery.trim();
    if (q.length < 2) { setArtistResults(null); return; }
    let stale = false;
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=20`);
        const j = await r.json();
        const seen = new Set(recipeValues.artists.map(a => a.toLowerCase()));
        const names: string[] = [];
        for (const row of (j.results || []) as RawTrackRow[]) {
          const a = (row.artist || '').trim();
          if (a && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); names.push(a); }
          if (names.length >= 6) break;
        }
        if (!stale) setArtistResults(names);
      } catch { if (!stale) setArtistResults([]); }
    }, 250);
    return () => { stale = true; window.clearTimeout(h); };
  }, [artistQuery, adminFetch, recipeValues.artists]);

  // Distinct artists in the seed results — the "seed the artist" rows.
  const seedArtists = useMemo(() => {
    if (!seedResults) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of seedResults) {
      const a = (r.artist || '').trim();
      if (a && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); out.push(a); }
      if (out.length >= 2) break;
    }
    return out;
  }, [seedResults]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= tracks.length) return;
    setTracks(prev => {
      const next = [...prev];
      const [row] = next.splice(from, 1);
      if (!row) return prev;
      next.splice(to, 0, row);
      return next;
    });
  };
  const removeAt = (i: number) => setTracks(prev => prev.filter((_, idx) => idx !== i));
  const addTrack = (t: RawTrackRow) => {
    setTracks(prev => [...prev, rowToDraft(t)]);
    setAddQuery('');
    setAddResults(null);
  };

  const doNew = useCallback(() => {
    setTracks([]); setName(''); setDescription(null); setExistingId(undefined);
    setReasons([]); setUsedFallback(false); setPoolSize(null); setChosenCount(0);
    setErrorMsg(''); setKeepInSync(false); setSyncInfo(null); setView('empty');
  }, []);

  const openBrowse = useCallback(async () => {
    setModal('open');
    setPlaylistQuery('');
    setPlaylists(null);
    setArmedDelete(null);
    try {
      const r = await adminFetch('/playlists');
      const j = await r.json();
      setPlaylists(j.playlists || []);
    } catch { setPlaylists([]); }
  }, [adminFetch]);

  const deletePlaylist = useCallback(async (p: PlaylistSummary) => {
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { flash(j.error || 'delete failed'); return; }
      setPlaylists(prev => (prev ? prev.filter(x => x.id !== p.id) : prev));
      // The deck keeps the tracks as an unsaved draft; only the server tie is gone.
      if (existingId === p.id) { setExistingId(undefined); setKeepInSync(false); setSyncInfo(null); }
      flash(`Deleted “${p.name}” from the music server`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'delete failed');
    } finally {
      setArmedDelete(null);
    }
  }, [adminFetch, existingId, flash]);

  const loadPlaylist = useCallback(async (p: PlaylistSummary) => {
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(p.id)}`);
      const j = await r.json();
      setTracks((j.entries || []).map(rowToDraft));
      setName(p.name);
      setDescription(null);
      setExistingId(p.id);
      setKeepInSync(!!p.synced);
      setSyncInfo(p.synced ? { lastSyncedAt: p.lastSyncedAt ?? null } : null);
      setReasons([]); setUsedFallback(false); setPoolSize(null);
      setModal(null);
      setView('result');
      flash(`Loaded “${p.name}” from the music server`);
    } catch { flash('could not load playlist'); }
  }, [adminFetch, flash]);

  const openSave = useCallback(() => {
    if (!tracks.length) { flash('nothing to save'); return; }
    saveForm.reset({
      name: name.trim() || '',
      keepInSync,
      saveMode: existingId ? 'overwrite' : 'create',
    });
    // reset() doesn't itself validate, so an empty/over-length default (e.g.
    // an ungenerated deck with no name typed yet) would leave `isValid` stale
    // — true — until the operator touches the field. Force it once so the
    // Save button's initial disabled state is correct from the first paint.
    void saveForm.trigger();
    setModal('save');
  }, [tracks.length, name, existingId, keepInSync, flash, saveForm]);

  const onSaveSubmit = saveForm.handleSubmit(async (values) => {
    setSaving(true);
    try {
      // `saveMode` is NOT a key of playlistSaveSchema (only name/songIds/
      // playlistId/keepInSync/recipe are), so zodResolver's parsed OUTPUT —
      // what `values` above actually is — silently drops it: z.object()
      // strips unknown keys and this schema is never `.passthrough()`d.
      // Reading `values.saveMode` here always saw `undefined`, so `overwrite`
      // was always false and every "Overwrite existing" save created a new
      // playlist instead (Fix round 1 — see task-11-report.md). `saveMode`
      // isn't part of the wire body at all, only a local UI choice, so it's
      // read straight off the form's raw state instead — the same place
      // `existingId`/`tracks` already come from.
      const saveMode = saveForm.getValues('saveMode');
      const overwrite = saveMode === 'overwrite' && existingId;
      const r = await adminFetch('/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          songIds: tracks.map(t => t.id),
          playlistId: overwrite ? existingId : undefined,
          keepInSync: values.keepInSync,
          recipe: values.keepInSync ? buildBody() : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        if (!applyServerFieldErrors(saveForm, j.fieldErrors)) flash(j.error || 'save failed');
        return;
      }
      const id = j.playlist?.id || (overwrite ? existingId : undefined);
      setName(values.name);
      setExistingId(id);
      setKeepInSync(values.keepInSync);
      setSyncInfo(values.keepInSync ? (syncInfo ?? { lastSyncedAt: null }) : null);
      setModal(null);
      flash(`Saved “${values.name}” to Navidrome${values.keepInSync ? ' · sync on' : ''}`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  });

  const syncNow = useCallback(async () => {
    if (!existingId || syncing) return;
    setSyncing(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(existingId)}/sync`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { flash(j.error || 'sync failed'); return; }
      setSyncInfo({ lastSyncedAt: new Date().toISOString() });
      flash(j.added ? `Sync complete · added ${j.added} new track${j.added === 1 ? '' : 's'}` : 'Sync complete · nothing new');
      if (j.added) {
        const pr = await adminFetch(`/playlists/${encodeURIComponent(existingId)}`);
        const pj = await pr.json();
        if (pr.ok) setTracks((pj.entries || []).map(rowToDraft));
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'sync failed');
    } finally {
      setSyncing(false);
    }
  }, [existingId, syncing, adminFetch, flash]);

  const showResult = view === 'result' && tracks.length > 0;
  const showEmpty = view === 'empty' || (view === 'result' && tracks.length === 0);
  const saveDisabled = !showResult || saving;
  const filteredPlaylists = useMemo(() => {
    if (!playlists) return null;
    const q = playlistQuery.trim().toLowerCase();
    return q ? playlists.filter(p => p.name.toLowerCase().includes(q)) : playlists;
  }, [playlists, playlistQuery]);

  const searchInputClass =
    'w-full border border-separator-strong bg-field px-[11px] py-[9px] text-sm text-ink outline-none placeholder:text-muted/60 focus:border-ink';

  return (
    <div className="min-w-0">
      <div ref={frameRef} className="flex min-w-0 flex-col lg:h-[calc(100dvh-146px)] lg:min-h-[480px] lg:flex-row">

        {/* --card-bg matches the other admin panels, keeping the rail distinct
            from the deck. */}
        <aside className="flex min-h-0 flex-none flex-col border-b border-ink bg-[var(--card-bg)] lg:w-[380px] lg:border-r lg:border-b-0">
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-5 pt-4 pb-[26px]">

            <div className="mb-1.5 font-mono text-[10px] font-bold tracking-[0.2em] text-muted uppercase">Recipe</div>
            <h1 className="mb-[18px] font-display text-[22px] font-bold tracking-[-0.01em]">
              Describe the set
            </h1>

            <TextareaField
              control={recipeControl}
              name="prompt"
              label="Vibe"
              rows={3}
              placeholder={'“rainy sunday jazz that warms up halfway through”'}
              className="mb-[22px]"
            />

            {/* Raw Controller: the array-mutation half (chips, add/remove) needs
                RHF's field, but the search dropdown above it (seedQuery/
                seedResults) is transient UI, not a form value. */}
            <Controller
              control={recipeControl}
              name="seeds"
              render={({ field: seedsField }) => (
                <div className="mb-[22px]">
                  <div className="mb-[7px] flex items-center justify-between">
                    <Eyeb>Seeds</Eyeb>
                    <span className="font-mono text-[10px] text-muted">optional</span>
                  </div>
                  <div className="relative">
                    <input
                      value={seedQuery}
                      onChange={e => setSeedQuery(e.target.value)}
                      placeholder="Search a track or artist to anchor on…"
                      aria-label="Search seeds"
                      className={searchInputClass}
                    />
                    {seedResults && (seedResults.length > 0 || seedArtists.length > 0) && (
                      <div className="absolute z-20 max-h-64 w-full overflow-auto border border-t-0 border-ink bg-bg">
                        {seedResults.map(s => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                              if (!seedsField.value.some(x => x.id === s.id)) {
                                seedsField.onChange([...seedsField.value, { id: s.id, title: s.title || '', artist: s.artist || '' }]);
                              }
                              setSeedQuery(''); setSeedResults(null);
                            }}
                            className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left hover:bg-ink-soft"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[13px]">{s.title}</span>
                              <span className="block truncate font-mono text-[10px] text-muted">{s.artist}</span>
                            </span>
                            <Plus className="size-3.5 flex-none text-muted" />
                          </button>
                        ))}
                        {seedArtists.map(a => (
                          <button
                            key={a}
                            type="button"
                            onClick={() => { setSeedArtist(a); setSeedQuery(''); setSeedResults(null); }}
                            className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] text-vermilion">Artist · {a}</span>
                              <span className="block font-mono text-[10px] text-muted">seed everything similar to this artist</span>
                            </span>
                            <Plus className="size-3.5 flex-none text-vermilion" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {(seedsField.value.length > 0 || seedArtist) && (
                    <div className="mt-2.5 flex flex-wrap gap-[7px]">
                      {seedsField.value.map(s => (
                        <Chip key={s.id} onRemove={() => seedsField.onChange(seedsField.value.filter(x => x.id !== s.id))}>
                          {s.title} · {s.artist}
                        </Chip>
                      ))}
                      {seedArtist && (
                        <Chip accent onRemove={() => setSeedArtist('')}>Artist · {seedArtist}</Chip>
                      )}
                    </div>
                  )}
                </div>
              )}
            />

            <div className="mb-5 h-px bg-separator-strong" />

            <TextField
              control={recipeControl}
              name="count"
              label="Target length"
              numeric
              description="5–60 tracks"
              className="mb-5"
            />

            <TextField
              control={recipeControl}
              name="artistSpacing"
              label="Artist spacing"
              numeric
              description="0–5 · minimum tracks between repeats of the same artist, 0 = off"
              className="mb-5"
            />

            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb muted={!recipeValues.capOn}>Track length</Eyeb>
                <div className="flex items-center gap-2.5">
                  {recipeValues.capOn && (
                    <span className="font-mono text-[11px] font-bold text-vermilion">
                      {recipeValues.minSec > 0 && recipeValues.maxSec < LEN_MAX ? `${fmtDur(recipeValues.minSec)} – ${fmtDur(recipeValues.maxSec)}`
                        : recipeValues.minSec > 0 ? `≥ ${fmtDur(recipeValues.minSec)}`
                          : recipeValues.maxSec < LEN_MAX ? `≤ ${fmtDur(recipeValues.maxSec)}`
                            : 'any'}
                    </span>
                  )}
                  {/* Raw Controller, not SwitchField: the live length badge sits
                      between the label and the switch in this row, a slot
                      SwitchField's fixed label+switch layout has no place for. */}
                  <Controller
                    control={recipeControl}
                    name="capOn"
                    render={({ field }) => (
                      <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Limit track length" />
                    )}
                  />
                </div>
              </div>
              {/* Raw Controller pair, not TextField: DualRange clamps lo
                  against hi (and vice versa) INSIDE its own onChange before
                  either prop fires, so the invariant lo<=hi holds by
                  construction — there is no zod rule to bind and no error
                  state to wire. Two Controllers because the two thumbs are
                  two independent RHF field paths. */}
              <Controller control={recipeControl} name="minSec" render={({ field: lo }) => (
                <Controller control={recipeControl} name="maxSec" render={({ field: hi }) => (
                  <DualRange
                    min={0} max={LEN_MAX} step={LEN_STEP}
                    lo={lo.value} hi={hi.value} disabled={!recipeValues.capOn}
                    onLo={lo.onChange} onHi={hi.onChange}
                    loLabel="minimum track length in seconds"
                    hiLabel="maximum track length in seconds"
                  />
                )} />
              )} />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted">
                <span>{recipeValues.capOn && recipeValues.minSec > 0 ? `min ${fmtDur(recipeValues.minSec)}` : 'no min'}</span>
                <span>{recipeValues.capOn && recipeValues.maxSec < LEN_MAX ? `max ${fmtDur(recipeValues.maxSec)}` : 'no max'}</span>
              </div>
            </div>

            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb muted={!recipeValues.bpmOn}>Tempo</Eyeb>
                <div className="flex items-center gap-2.5">
                  {recipeValues.bpmOn && (
                    <span className="font-mono text-[11px] font-bold text-vermilion">
                      {recipeValues.minBpm > BPM_MIN && recipeValues.maxBpm < BPM_MAX ? `${recipeValues.minBpm} – ${recipeValues.maxBpm} bpm`
                        : recipeValues.minBpm > BPM_MIN ? `≥ ${recipeValues.minBpm} bpm`
                          : recipeValues.maxBpm < BPM_MAX ? `≤ ${recipeValues.maxBpm} bpm`
                            : 'any bpm'}
                    </span>
                  )}
                  {/* Same reason as Track length's switch above. */}
                  <Controller
                    control={recipeControl}
                    name="bpmOn"
                    render={({ field }) => (
                      <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Limit tempo" />
                    )}
                  />
                </div>
              </div>
              <Controller control={recipeControl} name="minBpm" render={({ field: lo }) => (
                <Controller control={recipeControl} name="maxBpm" render={({ field: hi }) => (
                  <DualRange
                    min={BPM_MIN} max={BPM_MAX} step={BPM_STEP}
                    lo={lo.value} hi={hi.value} disabled={!recipeValues.bpmOn}
                    onLo={lo.onChange} onHi={hi.onChange}
                    loLabel="minimum tempo in bpm"
                    hiLabel="maximum tempo in bpm"
                  />
                )} />
              )} />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted">
                <span>{BPM_MIN}</span>
                <span>{BPM_MAX} bpm</span>
              </div>
            </div>

            <div className="mb-5 h-px bg-separator-strong" />

            <ToggleGroupField
              control={recipeControl}
              name="arc"
              label="Energy arc"
              className="mb-5"
              options={ARCS.map(a => ({ value: a.id, label: a.label }))}
            />

            <Controller
              control={recipeControl}
              name="moods"
              render={({ field: moodsField }) => (
                <div className="mb-5">
                  <div className="mb-[9px]"><Eyeb>Moods</Eyeb></div>
                  <div className="flex flex-wrap gap-1.5">
                    {moodOptions.map(m => (
                      <Tog
                        key={m}
                        on={moodsField.value.includes(m)}
                        onClick={() => moodsField.onChange(
                          moodsField.value.includes(m) ? moodsField.value.filter(x => x !== m) : [...moodsField.value, m],
                        )}
                      >
                        {m}
                      </Tog>
                    ))}
                  </div>
                </div>
              )}
            />

            <Controller
              control={recipeControl}
              name="energies"
              render={({ field: energiesField }) => (
                <div className="mb-5">
                  <div className="mb-[9px]"><Eyeb>Energy levels</Eyeb></div>
                  <div className="flex flex-wrap gap-1.5">
                    {ENERGIES.map(e => (
                      <Tog
                        key={e}
                        on={energiesField.value.includes(e)}
                        onClick={() => energiesField.onChange(
                          energiesField.value.includes(e) ? energiesField.value.filter(x => x !== e) : [...energiesField.value, e],
                        )}
                      >
                        {e.charAt(0).toUpperCase() + e.slice(1)}
                      </Tog>
                    ))}
                  </div>
                </div>
              )}
            />

            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb>Release year</Eyeb>
                <span className={cn(
                  'font-mono text-[11px]',
                  recipeValues.yearFrom > YEAR_MIN || recipeValues.yearTo < YEAR_MAX ? 'font-bold text-vermilion' : 'text-muted',
                )}>
                  {recipeValues.yearFrom > YEAR_MIN && recipeValues.yearTo < YEAR_MAX ? `${recipeValues.yearFrom} – ${recipeValues.yearTo}`
                    : recipeValues.yearFrom > YEAR_MIN ? `since ${recipeValues.yearFrom}`
                      : recipeValues.yearTo < YEAR_MAX ? `until ${recipeValues.yearTo}`
                        : 'any year'}
                </span>
              </div>
              <Controller control={recipeControl} name="yearFrom" render={({ field: lo }) => (
                <Controller control={recipeControl} name="yearTo" render={({ field: hi }) => (
                  <DualRange
                    min={YEAR_MIN} max={YEAR_MAX} step={1}
                    lo={lo.value} hi={hi.value}
                    onLo={lo.onChange} onHi={hi.onChange}
                    loLabel="earliest release year"
                    hiLabel="latest release year"
                  />
                )} />
              )} />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted">
                <span>{YEAR_MIN}</span>
                <span>{YEAR_MAX}</span>
              </div>
            </div>

            <Controller
              control={recipeControl}
              name="genres"
              render={({ field: genresField }) => {
                const addGenre = () => {
                  const g = genreInput.trim().replace(/,+$/, '');
                  if (g && !genresField.value.some(x => x.toLowerCase() === g.toLowerCase())) genresField.onChange([...genresField.value, g]);
                  setGenreInput('');
                };
                return (
                  <div className="mb-5">
                    <div className="mb-[9px]"><Eyeb>Genres</Eyeb></div>
                    <div className="relative">
                      <input
                        value={genreInput}
                        onChange={e => setGenreInput(e.target.value)}
                        onFocus={loadGenres}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addGenre(); } }}
                        onBlur={() => { if (genreInput.trim()) addGenre(); }}
                        placeholder="Add a genre…"
                        aria-label="Add a genre"
                        className={searchInputClass}
                      />
                      {genreSuggestions && genreSuggestions.length > 0 && (
                        <div className="absolute z-20 max-h-56 w-full overflow-auto border border-t-0 border-ink bg-bg">
                          {genreSuggestions.map(g => (
                            <button
                              key={g.value}
                              type="button"
                              // preventDefault on mousedown so the input's onBlur (which
                              // commits raw text) doesn't fire before this click lands.
                              onMouseDown={e => e.preventDefault()}
                              onClick={() => {
                                genresField.onChange(
                                  genresField.value.some(x => x.toLowerCase() === g.value.toLowerCase()) ? genresField.value : [...genresField.value, g.value],
                                );
                                setGenreInput('');
                              }}
                              className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                            >
                              <span className="truncate text-[13px]">{g.value}</span>
                              <span className="flex flex-none items-center gap-2 font-mono text-[10px] text-muted">
                                {g.songCount} tracks <Plus className="size-3.5" />
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {genresField.value.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-[7px]">
                        {genresField.value.map(g => (
                          <Chip key={g} onRemove={() => genresField.onChange(genresField.value.filter(x => x !== g))}>{g}</Chip>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }}
            />

            <Controller
              control={recipeControl}
              name="artists"
              render={({ field: artistsField }) => (
                <div className="mb-5">
                  <div className="mb-[9px] flex items-center justify-between">
                    <Eyeb>Artists</Eyeb>
                    <span className="font-mono text-[10px] text-muted">only these artists</span>
                  </div>
                  <div className="relative">
                    <input
                      value={artistQuery}
                      onChange={e => setArtistQuery(e.target.value)}
                      placeholder="Add an artist…"
                      aria-label="Add an artist"
                      className={searchInputClass}
                    />
                    {artistResults && artistResults.length > 0 && (
                      <div className="absolute z-20 max-h-56 w-full overflow-auto border border-t-0 border-ink bg-bg">
                        {artistResults.map(a => (
                          <button
                            key={a}
                            type="button"
                            onClick={() => {
                              if (!artistsField.value.some(x => x.toLowerCase() === a.toLowerCase())) artistsField.onChange([...artistsField.value, a]);
                              setArtistQuery(''); setArtistResults(null);
                            }}
                            className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                          >
                            <span className="truncate text-[13px]">{a}</span>
                            <Plus className="size-3.5 flex-none text-muted" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {artistsField.value.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-[7px]">
                      {artistsField.value.map(a => (
                        <Chip key={a} onRemove={() => artistsField.onChange(artistsField.value.filter(x => x !== a))}>{a}</Chip>
                      ))}
                    </div>
                  )}
                </div>
              )}
            />

            <div className="mb-[18px] h-px bg-separator-strong" />

            <div className="grid gap-[13px]">
              <SwitchField control={recipeControl} name="instrumentalOnly" label="Instrumental only" description="skip vocal-forward tracks · best-effort" />
              <SwitchField control={recipeControl} name="recentlyAdded" label="Recently added" description="source from new library arrivals" />
              <SwitchField control={recipeControl} name="excludeRecent" label="Skip recent plays" description="avoid tracks that recently aired" />
            </div>
            </div>
          </ScrollArea>

          <div className="flex-none border-t border-ink px-5 py-3.5">
            <div className="mb-[9px] flex gap-2">
              <Button
                variant="accent"
                className="h-10 flex-1"
                disabled={generating || !hasIntent}
                onClick={() => generate('fresh')}
              >
                {generating ? 'Assembling…' : 'Generate'}
              </Button>
              <Button
                variant="secondary"
                className="h-10"
                disabled={generating || !tracks.length}
                onClick={() => generate('regenerate')}
                title="new set, same recipe — excludes current tracks"
              >
                Regenerate
              </Button>
              <Button
                variant="ghost"
                className="h-10"
                disabled={generating || !tracks.length}
                onClick={() => generate('more')}
                title="append new matches"
              >
                More
              </Button>
            </div>
            <div className="font-mono text-[10px] leading-[1.5] text-muted">
              Regenerate excludes current tracks · More appends new matches. Needs a vibe, seed, or any tuning.
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

            {showResult && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex-none border-b border-ink px-4 pt-1.5 pb-2.5 sm:px-6">
                  {/* The three deck actions eat ~185px, leaving ~8 characters of
                      title at 390px, so the name takes its own line. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <input
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Untitled set"
                      aria-label="Playlist name"
                      className="min-w-0 flex-1 basis-full border-b border-transparent bg-transparent py-0.5 font-display text-2xl font-bold tracking-[-0.01em] text-ink outline-none placeholder:text-muted/50 hover:border-separator-soft focus:border-[var(--accent)] sm:basis-0"
                    />
                    <div className="flex flex-none items-center gap-1.5">
                      <Button variant="ghost" size="sm" className="h-8" onClick={openBrowse} title="open a playlist from the music server">
                        <FolderOpen data-icon="inline-start" />Open
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8" onClick={doNew} title="start a blank draft">
                        <FilePlus2 data-icon="inline-start" />New
                      </Button>
                      <Button variant="accent" size="sm" className="h-8" disabled={saveDisabled} onClick={openSave} title="save to Navidrome">
                        <Save data-icon="inline-start" />{existingId ? 'Update' : 'Save'}
                      </Button>
                    </div>
                  </div>
                  {description && (
                    <p className="mt-0.5 line-clamp-1 text-[13px] text-muted italic" title={description}>{description}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink">
                    {poolSize !== null && (usedFallback ? (
                      <Chip>▲ Fallback</Chip>
                    ) : (
                      <Chip accent>✦ AI-curated</Chip>
                    ))}
                    <span><b>{tracks.length}</b> tracks</span>
                    <span className="text-separator-strong">/</span>
                    <span><b>{fmtRun(totalSec)}</b></span>
                    {poolSize !== null && (
                      <>
                        <span className="text-separator-strong">/</span>
                        <span className="text-muted">{poolVerb} {chosenCount} from {poolSize} in pool</span>
                      </>
                    )}
                    {(reasons.length > 0 || usedFallback) && (
                      <button
                        type="button"
                        onClick={() => setCaveatsOpen(v => !v)}
                        className={cn(
                          'flex items-center gap-1 border px-1.5 py-px text-[10px] font-bold uppercase transition',
                          caveatsOpen ? 'border-ink text-ink' : 'border-separator-strong text-muted hover:border-ink hover:text-ink',
                        )}
                      >
                        △ {usedFallback ? 'no-AI details' : `${reasons.length} caveat${reasons.length === 1 ? '' : 's'}`}
                        {caveatsOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      </button>
                    )}
                    {existingId && (keepInSync || syncInfo) && (
                      <span className="flex items-center gap-2 text-muted">
                        <span className="text-separator-strong">/</span>
                        <span>synced {syncInfo?.lastSyncedAt ? relTime(syncInfo.lastSyncedAt) : '· not yet'}</span>
                        <button
                          type="button"
                          onClick={syncNow}
                          disabled={syncing}
                          title="check the library for new matches now"
                          className="flex items-center gap-1 border border-separator-strong px-1.5 py-px text-[10px] font-bold uppercase transition hover:border-ink hover:text-ink disabled:opacity-40"
                        >
                          <RefreshCw className={cn('size-3', syncing && 'animate-spin')} />
                          {syncing ? 'syncing…' : 'sync now'}
                        </button>
                      </span>
                    )}
                  </div>
                </div>

                {caveatsOpen && (reasons.length > 0 || usedFallback) && (
                  <div className="flex-none border-b border-separator-soft bg-ink-soft px-4 py-2 font-mono text-[11px] leading-[1.6] text-muted sm:px-6">
                    {usedFallback && (
                      <div className="font-bold text-vermilion">
                        arranged without AI — the curation model was unreachable, so this set was ordered by rules (energy + relevance). Regenerate to retry the curator.
                      </div>
                    )}
                    {reasons.map((r, i) => <div key={i}>· {r}</div>)}
                  </div>
                )}

                <EnergyGraph
                  tracks={tracks}
                  arc={recipeValues.arc}
                  open={graphOpen}
                  onToggle={() => setGraphOpen(v => !v)}
                  onBarClick={jumpToRow}
                />

                <div className="relative flex flex-none items-center gap-2.5 border-b border-separator-soft px-4 py-2 sm:px-6">
                  <Search className="size-4 flex-none text-muted" />
                  <input
                    value={addQuery}
                    onChange={e => setAddQuery(e.target.value)}
                    placeholder="Add any track from your library…"
                    aria-label="Add a track"
                    className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted/60 focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                  />
                  {addResults && addResults.length > 0 && (
                    <div className="absolute top-full right-4 left-4 z-20 max-h-64 overflow-auto border border-ink bg-bg shadow-drawer sm:right-6 sm:left-6">
                      {addResults.map(s => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => addTrack(s)}
                          className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px]">{s.title}</span>
                            <span className="block truncate font-mono text-[10px] text-muted">{s.artist}{s.album ? ` · ${s.album}` : ''}</span>
                          </span>
                          <Plus className="size-3.5 flex-none text-muted" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <ScrollArea ref={listRef} className="flex-1">
                  <div className="pb-8">
                  {tracks.map((t, i) => (
                    <div
                      key={`${t.id}-${i}`}
                      data-row={i}
                      draggable
                      onDragStart={() => { dragIndex.current = i; }}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => { if (dragIndex.current != null) move(dragIndex.current, i); dragIndex.current = null; }}
                      className={cn(
                        'group grid grid-cols-[24px_44px_minmax(0,1fr)_auto] items-center gap-3 border-b border-separator-soft px-4 py-[9px] transition-colors hover:bg-ink-soft sm:grid-cols-[18px_24px_44px_minmax(0,1fr)_auto] sm:px-6',
                        hotRow === i && 'bg-vermilion/10',
                      )}
                    >
                      <div className="hidden cursor-grab place-items-center text-muted sm:grid">
                        <GripVertical className="size-4" />
                      </div>
                      <div className="text-right font-mono text-xs text-muted">{i + 1}</div>
                      <img
                        src={`${API}/cover/${encodeURIComponent(t.id)}`}
                        alt=""
                        loading="lazy"
                        className="size-11 border border-ink bg-ink-soft object-cover"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{t.title}</span>
                          {dupeIds.has(t.id) && (
                            <span className="flex-none border border-[var(--accent)] px-1 py-px font-mono text-[9px] font-bold tracking-[0.08em] text-vermilion">DUPLICATE</span>
                          )}
                        </div>
                        <div className="mt-[3px] truncate font-mono text-[11px] text-muted">
                          {t.artist}{t.album ? ` · ${t.album}` : ''}
                        </div>
                        {((t.moods && t.moods.length > 0) || t.instrumental === true) && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {(t.moods || []).slice(0, 2).map(m => (
                              <span key={m} className="border border-separator-soft px-[5px] py-px font-mono text-[9px] tracking-[0.04em] text-muted uppercase">{m}</span>
                            ))}
                            {t.instrumental === true && (
                              <span className="border border-separator-soft px-[5px] py-px font-mono text-[9px] tracking-[0.04em] text-muted uppercase">instrumental</span>
                            )}
                          </div>
                        )}
                      </div>
                      {/* Beside three 30px icon buttons this block is ~170px;
                          stacked it costs 90px and the title keeps the rest. */}
                      <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                        <div className="flex flex-col items-end gap-[3px]">
                          <span className="font-mono text-xs text-ink">{fmtDur(t.durationSec || 0)}</span>
                          <span className="flex items-center gap-[5px] font-mono text-[10px] text-muted">
                            <span className={cn('inline-block size-[7px]', energyBgClass(t.energy))} />
                            {energyLabel(t.energy)}{t.year ? ` · ${t.year}` : ''}
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
                          {/* The drag grip is `sm:` only, so on mobile these are
                              the only way to move a row: size them for a thumb. */}
                          <IconBtn className="size-9 sm:size-[30px]" onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up"><ArrowUp className="size-[15px]" /></IconBtn>
                          <IconBtn className="size-9 sm:size-[30px]" onClick={() => move(i, i + 1)} disabled={i === tracks.length - 1} title="Move down"><ArrowDown className="size-[15px]" /></IconBtn>
                          <IconBtn className="size-9 sm:size-[30px]" onClick={() => removeAt(i)} title="Remove"><X className="size-[15px]" /></IconBtn>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                </ScrollArea>
              </div>
            )}

            {showEmpty && (
              <div className="flex flex-1 items-center justify-center p-8 lg:p-10">
                <div className="w-full max-w-[520px]">
                  <div className="mb-2.5 font-mono text-[10px] font-bold tracking-[0.2em] text-muted uppercase">New draft</div>
                  <h2 className="mb-2.5 font-display text-[32px] font-bold tracking-[-0.01em]">
                    Nothing in the set yet.
                  </h2>
                  <p className="mb-[26px] text-sm leading-[1.55] text-muted">
                    Build a playlist two ways. The station reads its music library and returns an ordered set you can reshape by hand before saving to Navidrome.
                  </p>
                  <div className="grid gap-3">
                    <div className="flex gap-3.5 border border-ink p-4">
                      <div className="grid size-[26px] flex-none place-items-center border border-ink bg-[var(--accent)] font-mono text-xs font-bold text-white">1</div>
                      <div>
                        <div className="mb-0.5 text-sm font-bold">Describe a vibe, then Generate</div>
                        <div className="text-[13px] leading-[1.5] text-muted">Type a mood on the left, optionally add seed tracks and tuning, and let the curator assemble the set.</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3.5 border border-separator-strong p-4">
                      <div className="flex min-w-0 gap-3.5">
                        <div className="grid size-[26px] flex-none place-items-center border border-ink font-mono text-xs font-bold">2</div>
                        <div>
                          <div className="mb-0.5 text-sm font-bold">Open an existing playlist</div>
                          <div className="text-[13px] leading-[1.5] text-muted">Load one from the music server to edit or regenerate.</div>
                        </div>
                      </div>
                      <Button variant="secondary" size="sm" className="h-8" onClick={openBrowse}>Browse</Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {view === 'generating' && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-none items-center justify-center gap-4 px-6 pt-10 pb-[26px]">
                  <div className="size-[34px] flex-none animate-spin rounded-full border-2 border-separator-strong border-t-[var(--accent)]" />
                  <div>
                    <div className="font-display text-[22px] font-bold">Assembling your set…</div>
                    <div className="mt-1 font-mono text-[11px] text-muted">Scanning candidate tracks · sequencing by energy arc</div>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden px-4 sm:px-6">
                  <div className="grid gap-[9px]">
                    {[0, 1, 2, 3, 4].map(i => (
                      <div key={i} className="h-[60px] animate-pulse border border-separator-soft bg-ink-soft" />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {view === 'nomatch' && (
              <div className="flex flex-1 items-center justify-center p-8 lg:p-10">
                <div className="max-w-[460px] text-center">
                  <div className="mb-2.5 font-mono text-[10px] font-bold tracking-[0.2em] text-muted uppercase">0 results</div>
                  <h2 className="mb-2.5 font-display text-[28px] font-bold">
                    Nothing matched this recipe.
                  </h2>
                  <p className="mb-[22px] text-sm leading-[1.55] text-muted">
                    The filters were too tight for your library. Try widening the era, allowing more moods or energy levels, turning off <span className="text-ink">Instrumental only</span>, or dropping a genre.
                  </p>
                  <Button variant="accent" className="h-10" onClick={() => generate(lastMode.current)}>Loosen &amp; try again</Button>
                </div>
              </div>
            )}

            {view === 'error' && (
              <div className="flex flex-1 items-center justify-center p-8 lg:p-10">
                <div className="w-full max-w-[480px]">
                  <V3Alert tone="error" title="generation failed">
                    {errorMsg || 'The request to the curation service failed.'} Your recipe is untouched. Try again in a moment.
                  </V3Alert>
                  <div className="mt-4 flex gap-2.5">
                    <Button variant="accent" className="h-10" onClick={() => generate(lastMode.current)}>Retry</Button>
                    <Button variant="ghost" className="h-10" onClick={doNew}>Start over</Button>
                  </div>
                </div>
              </div>
            )}
          </div>

        </section>
      </div>

      {toast && (
        <div className="fixed top-[70px] right-4 left-4 z-[60] flex items-center gap-3 bg-ink px-3.5 py-3 text-bg shadow-drawer sm:right-6 sm:left-auto sm:max-w-[340px]">
          <span className="text-[13px] leading-[1.4]">{toast}</span>
          <button type="button" onClick={() => setToast('')} className="flex-none text-bg/70 hover:text-bg" title="dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {modal === 'open' && (
        <div
          // Backdrop keeps no role and no tabIndex: `role="button"` would put a
          // full-viewport control in the tab order and hide the dialog's real
          // controls from assistive tech. Escape is handled at the document level.
          className="fixed inset-0 z-[80] flex items-start justify-center bg-[rgba(20,18,14,0.42)] p-5 pt-16"
          // Only a click on the backdrop itself closes, so the panel needs no
          // stopPropagation of its own.
          onClick={e => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div
            ref={modalPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pb-open-title"
            tabIndex={-1}
            className="flex max-h-[78vh] w-full max-w-[560px] flex-col border border-ink bg-bg shadow-drawer outline-none"
          >
            <div className="flex items-center justify-between border-b border-ink px-5 py-4">
              <div>
                <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Music server</div>
                <h3 id="pb-open-title" className="mt-0.5 font-display text-xl font-bold">Open a playlist</h3>
              </div>
              <IconBtn onClick={() => setModal(null)} title="close"><X className="size-4" /></IconBtn>
            </div>
            <div className="px-5 pt-3.5 pb-2.5">
              <input
                value={playlistQuery}
                onChange={e => setPlaylistQuery(e.target.value)}
                placeholder="Search playlists…"
                aria-label="Search playlists"
                className={searchInputClass}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {filteredPlaylists === null ? (
                <div className="px-3 py-8 text-center text-sm text-muted">Loading…</div>
              ) : filteredPlaylists.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted">
                  {playlistQuery ? 'No playlists match.' : 'No playlists yet.'}
                </div>
              ) : filteredPlaylists.map(p => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => loadPlaylist(p)}
                  onKeyDown={e => { if (e.key === 'Enter') loadPlaylist(p); }}
                  className="mt-2 flex w-full cursor-pointer items-center justify-between gap-3 border border-separator-soft p-3 text-left transition-colors hover:bg-ink-soft"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{p.name}</span>
                      {p.synced && (
                        <span className="flex-none border border-[var(--accent)] px-[5px] py-px font-mono text-[9px] font-bold tracking-[0.06em] text-vermilion">SYNCED</span>
                      )}
                    </span>
                    <span className="mt-[3px] block font-mono text-[11px] text-muted">
                      {p.songCount} tracks{p.synced && p.lastSyncedAt ? ` · synced ${relTime(p.lastSyncedAt)}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-1">
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        if (armedDelete === p.id) { void deletePlaylist(p); }
                        else { setArmedDelete(p.id); window.setTimeout(() => setArmedDelete(a => (a === p.id ? null : a)), 2600); }
                      }}
                      title={armedDelete === p.id ? 'click again to delete from Navidrome' : 'delete playlist'}
                      className={cn(
                        'flex items-center gap-1 border px-1.5 py-1 font-mono text-[9px] font-bold tracking-[0.06em] uppercase transition',
                        armedDelete === p.id
                          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                          : 'border-transparent text-muted hover:border-separator-strong hover:text-ink',
                      )}
                    >
                      <Trash2 className="size-3.5" />
                      {armedDelete === p.id && 'sure?'}
                    </button>
                    <ChevronRight className="size-4 flex-none text-muted" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {modal === 'save' && (
        <div
          // See the OPEN modal above: backdrop stays a plain div; Escape is
          // owned by the document-level handler.
          className="fixed inset-0 z-[80] flex items-start justify-center bg-[rgba(20,18,14,0.42)] p-5 pt-16"
          onClick={e => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div
            ref={modalPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pb-save-title"
            tabIndex={-1}
            className="w-full max-w-[480px] border border-ink bg-bg shadow-drawer outline-none"
          >
            <div className="flex items-center justify-between border-b border-ink px-5 py-4">
              <div>
                <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                  {tracks.length} tracks · {fmtRun(totalSec)}
                </div>
                <h3 id="pb-save-title" className="mt-0.5 font-display text-xl font-bold">Save playlist</h3>
              </div>
              <IconBtn onClick={() => setModal(null)} title="close"><X className="size-4" /></IconBtn>
            </div>
            <div className="grid gap-4 px-5 py-[18px]">
              <TextField
                control={saveControl}
                name="name"
                label="Name"
                placeholder="Untitled set"
                description={`1–${PLAYLIST_NAME_MAX} characters`}
              />
              {existingId && (
                <Controller
                  control={saveControl}
                  name="saveMode"
                  render={({ field }) => (
                    <div className="grid gap-2">
                      {([
                        { id: 'overwrite' as const, label: 'Overwrite existing', hint: `updates “${name || saveNameValue || 'this playlist'}” on the server` },
                        { id: 'create' as const, label: 'Create a new playlist', hint: 'leaves the original untouched' },
                      ]).map(opt => {
                        const on = field.value === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => field.onChange(opt.id)}
                            className={cn('flex items-center gap-[11px] border p-3 text-left', on ? 'border-[var(--accent)]' : 'border-separator-strong')}
                          >
                            <span className={cn('grid size-3.5 flex-none place-items-center rounded-full border', on ? 'border-[var(--accent)]' : 'border-separator-strong')}>
                              {on && <span className="size-[7px] rounded-full bg-[var(--accent)]" />}
                            </span>
                            <span>
                              <span className="block text-[13px] font-semibold">{opt.label}</span>
                              <span className="block font-mono text-[10px] text-muted">{opt.hint}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                />
              )}
              <SwitchField
                control={saveControl}
                name="keepInSync"
                label="Keep in sync"
                description="Remembers this recipe and appends new matching songs after library tagging."
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink px-5 py-3.5">
              <span className="font-mono text-[10px] text-muted">
                Then pin it to a show in <a href="/admin/shows" className="text-vermilion hover:text-ink">Shows</a> →
              </span>
              <div className="flex flex-none gap-2.5">
                <Button variant="ghost" className="h-10" onClick={() => setModal(null)}>Cancel</Button>
                <Button
                  variant="accent"
                  className="h-10"
                  disabled={saving || !saveForm.formState.isValid}
                  onClick={() => { void onSaveSubmit(); }}
                >
                  {saving ? 'Saving…' : 'Save playlist'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
