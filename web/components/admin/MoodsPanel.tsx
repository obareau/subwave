'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Trash2, Palette, Clock, CalendarDays, Volume2 } from 'lucide-react';
import {
  useController, useFieldArray, type Control,
} from 'react-hook-form';
import { z } from 'zod';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import { TextField, SelectField, type Option } from '@/lib/form-fields';
import { Card, Btn, Eyebrow } from './ui';
import { SectionTabs } from './SectionTabs';
import { ScrollArea } from '../ui/scroll-area';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import FestivalsSection from './FestivalsSection';
import {
  moodsSchema,
  moodScheduleSchema,
  weatherMoodsSchema,
  SETTINGS_MOODS_LIMIT,
  SETTINGS_MOOD_NAME_MAX,
  SETTINGS_MOOD_PROMPT_MAX,
} from '@/lib/schemas.generated';

interface MoodEntry {
  name: string;
  clapPrompt: string;
}
interface Correction {
  from: string;
  to: string;
}
interface MoodsFormValues {
  moods: MoodEntry[];
  schedule: Record<string, string>;
  weather: Record<string, string>;
  corrections: Correction[];
}

// The 8 fixed day-periods (controller context.ts getTimeContext) — only each
// period's MOOD is editable here; the hour ranges + vibe/show names stay in code.
const PERIODS: Array<{ id: string; label: string; hours: string }> = [
  { id: 'early-morning', label: 'Early morning', hours: '05–09' },
  { id: 'morning', label: 'Morning', hours: '09–12' },
  { id: 'midday', label: 'Midday', hours: '12–14' },
  { id: 'afternoon', label: 'Afternoon', hours: '14–17' },
  { id: 'drive-time', label: 'Drive-time', hours: '17–19' },
  { id: 'evening', label: 'Evening', hours: '19–22' },
  { id: 'late-evening', label: 'Late evening', hours: '22–01' },
  { id: 'after-hours', label: 'After hours', hours: '01–05' },
];

// The 6 fixed weather conditions (controller context.ts mapWeatherCode).
const CONDITIONS: Array<{ id: string; label: string }> = [
  { id: 'clear', label: 'Clear' },
  { id: 'cloudy', label: 'Cloudy' },
  { id: 'foggy', label: 'Foggy' },
  { id: 'rainy', label: 'Rainy' },
  { id: 'snowy', label: 'Snowy' },
  { id: 'stormy', label: 'Stormy' },
];

// Radix Select forbids an empty-string item value, so the weather "no steer"
// option rides a sentinel that maps back to '' on save.
const NONE = '__none__';

// From the mirror, not re-typed: a bare literal beside a "mirrors the
// server" comment is exactly what had already drifted in the persona editor.
const MOODS_LIMIT = SETTINGS_MOODS_LIMIT;

// tts.corrections has no controller-side zod schema — `tts` is one of the
// settings-patch-registry keys that deliberately did NOT convert (root
// CLAUDE.md, "What deliberately did NOT convert"; six cross-field rules read
// POST-MERGE state). This is a LOCAL, client-only shape guard mirroring the
// UI's own pre-existing caps, not a mirror of a server rule — there isn't one
// to mirror.
const CORRECTION_FROM_MAX = 80;
const CORRECTION_TO_MAX = 160;
const CORRECTIONS_LIMIT = 100;
const correctionsSchema = z
  .array(
    z.object({
      from: z.string().max(CORRECTION_FROM_MAX),
      to: z.string().max(CORRECTION_TO_MAX),
    }),
  )
  .max(CORRECTIONS_LIMIT);

type TabId = 'vocab' | 'moments' | 'festivals' | 'speech';
const TAB_IDS: TabId[] = ['vocab', 'moments', 'festivals', 'speech'];

// The moods[] rows and the moments/speech rows all bind through the SAME
// arrayControl (the schema-output-typed cast — see the comment beside it
// below), so a hand-rolled row component isn't needed for the plain text
// fields: TextField/SelectField take a template-literal FieldPath directly.
// Weather is the one exception — see WeatherMoodSelect below.
function WeatherMoodSelect({
  control,
  condition,
  label,
  moodOptions,
  fieldId,
}: {
  control: Control<MoodsFormValues>;
  condition: string;
  label: string;
  moodOptions: Option[];
  fieldId: string;
}) {
  // Hand-rolled rather than SelectField: weather's '' ("no mood steer") value
  // has to ride a Radix sentinel (Radix forbids an empty-string item value),
  // and remapping that sentinel on the way in/out of field.onChange is real
  // onChange logic SelectField doesn't expose — the same carve-out
  // FestivalsSection uses for month/day/windowDays.
  const { field, fieldState } = useController({ control, name: `weather.${condition}` });
  const aria = fieldAria(`${fieldId}-weather-${condition}`, fieldState.error);
  return (
    <Field data-invalid={aria.invalid || undefined}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Select
        value={field.value ? field.value : NONE}
        onValueChange={v => field.onChange(v === NONE ? '' : v)}
      >
        <SelectTrigger {...aria.controlProps} onBlur={field.onBlur} ref={field.ref}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— none —</SelectItem>
          {moodOptions.map(o => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

export default function MoodsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // which card is saving
  const fieldId = useId();

  // Active tab lives in the URL (?tab=…) so SectionTabs and the sidebar submenu
  // share one source of truth.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'vocab';

  // The vocabulary moodSchedule/weatherMoods validate against — and the
  // dropdown OPTIONS those two cards' Selects offer — is the PERSISTED
  // (last-saved) mood list, not the live, possibly-unsaved content of the
  // Vocabulary tab. This looks like it should be the opposite (moods is
  // itself one of the four collections this same form edits, so "use the
  // live form value" was the first thing tried — see Fix round 1 in the task
  // report for the full story), but the two cards are NOT symmetric on the
  // server: `saveMoods` posts `{ moods }` alone, so settings.ts's moodCtx
  // (settings.ts:1211, `next.moods`) is built from what THIS patch carries —
  // live is correct for that card, and it's why `moodsSchema` itself needs
  // no such context. `saveSchedule`/`saveWeather` post `{ moodSchedule }` /
  // `{ weatherMoods }` alone — `moods` never rides in their patch, so the
  // server ALWAYS judges them against whatever's actually persisted
  // (settings.ts:1205-1219, the `'moods' in patch` branch only runs for the
  // moods card's own save). Sourcing their dropdown options and their
  // validation context from the live watch meant an operator could rename a
  // mood on the Vocabulary tab without saving, assign the new (unsaved) name
  // to a time-of-day/weather slot on the Moments tab — client validation
  // passed, because it was checking the same live list — and have the save
  // rejected by the server with a confusing generic-error round trip, a
  // click path the pre-refactor UI (built from `savedMoodNames`) could not
  // produce. Fixed by making `savedMoodNames` real, separate state — set at
  // load and again only when the MOODS card's own save actually succeeds
  // (with the server-normalised names from the response, not the raw
  // payload) — rather than anything read live off the form. This also
  // removes the circular-dependency problem the live-watch version had
  // (schema needs form.control, form needs schema): `savedMoodNames` doesn't
  // depend on the form at all, so the schema can be built before the form
  // exists, no settle-one-render-behind dance required.
  const [savedMoodNames, setSavedMoodNames] = useState<string[]>([]);
  const moodOptions: Option[] = useMemo(
    () => savedMoodNames.map(m => ({ value: m, label: m })),
    [savedMoodNames],
  );

  const schema = useMemo(
    () =>
      z.object({
        moods: moodsSchema,
        schedule: moodScheduleSchema({ moodNames: savedMoodNames }),
        weather: weatherMoodsSchema({ moodNames: savedMoodNames }),
        corrections: correctionsSchema,
      }),
    [savedMoodNames],
  );
  const form = useZodForm(schema, { moods: [], schedule: {}, weather: {}, corrections: [] });
  // form.control's declared field-values type collapses to `unknown` for
  // moods/schedule/weather (moodsSchema/moodScheduleSchema/weatherMoodsSchema
  // are z.unknown().superRefine().transform(), not structural z.object/
  // z.array — see FestivalsSection's FESTIVALS_TYPE_SHAPE comment for the
  // full reasoning; same shape here). This cast only widens what TypeScript
  // is allowed to believe the control's shape is, to the real OUTPUT shape —
  // the same `control` object at runtime, and the type every field actually
  // holds since the form is seeded only from server data or empty rows.
  const arrayControl = form.control as unknown as Control<MoodsFormValues>;
  // Same cast rationale as arrayControl: form.getValues(key)'s declared type
  // is z.input<schema>[key], which is `unknown` for moods/schedule/weather —
  // this widens it back to the real shape at the type level only.
  const getFormValue = <K extends keyof MoodsFormValues>(key: K): MoodsFormValues[K] =>
    form.getValues(key as never) as unknown as MoodsFormValues[K];

  const { fields: moodFields, append: appendMood, remove: removeMood } = useFieldArray({
    control: arrayControl,
    name: 'moods',
    keyName: '_rhfKey',
  });
  const { fields: corrFields, append: appendCorr, remove: removeCorr } = useFieldArray({
    control: arrayControl,
    name: 'corrections',
    keyName: '_rhfKey',
  });

  // Re-validate once the schema has actually been rebuilt against a fresh
  // `savedMoodNames` (after load, and again after the moods card's own save
  // succeeds) — a stale-schema-in-closure guard: changing the `resolver`
  // react-hook-form is holding doesn't retroactively re-run it against
  // already-computed error state, only the next validation trigger does.
  useEffect(() => {
    void form.trigger();
  }, [schema, form]);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as {
        values?: {
          moods?: unknown;
          moodSchedule?: unknown;
          weatherMoods?: unknown;
          tts?: { corrections?: unknown };
        };
      } | null;
      const v = j?.values || {};
      const loadedMoods = Array.isArray(v.moods) ? (v.moods as MoodEntry[]) : [];
      const rawSchedule = (v.moodSchedule && typeof v.moodSchedule === 'object'
        ? v.moodSchedule : {}) as Record<string, string>;
      const rawWeather = (v.weatherMoods && typeof v.weatherMoods === 'object'
        ? v.weatherMoods : {}) as Record<string, string>;
      const loadedCorr = Array.isArray(v.tts?.corrections)
        ? (v.tts!.corrections as Correction[]) : [];
      // A period with no stored value yet falls back to the first vocab
      // entry (display convenience only, matching the pre-RHF behaviour) —
      // resolved once here at load, not re-derived on every render.
      const firstMood = loadedMoods[0]?.name ?? '';
      const loadedSchedule = Object.fromEntries(
        PERIODS.map(p => [p.id, rawSchedule[p.id] || firstMood]),
      );
      // Weather gets NO such fallback — '' is a real, intentional value
      // ("no mood steer"), not a gap to fill.
      const loadedWeather = Object.fromEntries(
        CONDITIONS.map(c => [c.id, rawWeather[c.id] || '']),
      );
      const next: MoodsFormValues = {
        moods: loadedMoods,
        schedule: loadedSchedule,
        weather: loadedWeather,
        corrections: loadedCorr,
      };
      form.reset(next);
      setSavedMoodNames(loadedMoods.map(m => m.name));
      setLoaded(true);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  // Routed through the Next router so a soft nav re-derives `tab`.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // POST one settings slice, then re-baseline the WHOLE form via
  // form.reset({...form.getValues(), [key]: nextValue}) — the same
  // no-options `form.reset(values)` FestivalsSection already proves out,
  // just fed the live current values for the three keys NOT being saved
  // (rather than a fixed `{festivals: […]}` shape) instead of dropping them.
  //
  // This was NOT the first thing tried: `form.reset(next, {keepDirtyValues:
  // true})` looked like the right tool (RHF's docs describe it as "keep
  // dirty fields' current value"), and a per-key `defaultsRef` was built to
  // support it. Reading react-hook-form's own reset() implementation (and
  // confirming empirically against the live verify stack) showed
  // `keepDirtyValues: true` does NOT recompute `dirtyFields`/`isValid`
  // against the new defaults unless `keepDefaultValues` is ALSO passed — and
  // `keepDefaultValues: true` means the OPPOSITE of what the name suggests
  // here: it skips adopting the new defaults at all. Without it, dirtyFields
  // is carried over from before the call, untouched — so the just-saved
  // card's dirty flag never cleared and its Save button stayed wrongly
  // enabled (caught by a manual Playwright pass against the running verify
  // stack, not by reading the source alone).
  //
  // The tradeoff of the simpler approach used here: because `nextDefaults`
  // adopts the LIVE value for every key (not just the one being saved), a
  // genuinely in-progress, unsaved edit on ANOTHER card will have its dirty
  // flag (and therefore its own Save button) incorrectly clear too — its
  // VALUE is preserved exactly (still visible, still editable, nothing is
  // lost), only the "you have unsaved changes" signal resets. Given RHF's
  // reset() has no option that recomputes dirtiness for one key while truly
  // leaving another's untouched, this is the safer failure direction: no
  // silent data loss, only a cosmetic re-touch-to-re-enable papercut on a
  // narrow (near-simultaneous multi-card edit) path.
  const persistPatch = useCallback(
    async (
      card: string,
      key: keyof MoodsFormValues,
      patch: Record<string, unknown>,
      nextValue: MoodsFormValues[keyof MoodsFormValues],
      okMsg: string,
      // Only the moods card uses this — see saveMoods — to re-baseline
      // savedMoodNames from the server's own (normalised) response rather
      // than the raw payload we sent.
      onSuccess?: (saved: Record<string, unknown> | undefined) => void,
    ) => {
      setBusy(card);
      try {
        const r = await adminFetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const j = (await r.json().catch(() => ({}))) as {
          error?: string;
          fieldErrors?: Record<string, string>;
          saved?: Record<string, unknown>;
        };
        if (!r.ok) {
          // Only meaningful for a SHAPE-level failure (e.g. a duplicate/
          // too-long mood name) — the route validates the patch with
          // moodNames: null before update() ever runs, so it can catch that
          // without knowing the vocabulary. A membership failure (the
          // orphan-guard case) is judged only inside update(), which throws a
          // plain Error with no field path — applyServerFieldErrors is a
          // no-op there, and the message is surfaced by notify.err instead.
          applyServerFieldErrors(form, j.fieldErrors);
          throw new Error(j.error || `failed (${r.status})`);
        }
        const current = form.getValues() as unknown as MoodsFormValues;
        form.reset({ ...current, [key]: nextValue });
        onSuccess?.(j.saved);
        notify.ok(okMsg);
      } catch (e) {
        notify.err(`Save failed: ${errorMessage(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [adminFetch, form],
  );

  const saveMoods = async () => {
    const ok = await form.trigger('moods');
    if (!ok) return;
    const raw = getFormValue('moods');
    const payload = raw.map(m => ({ name: m.name, clapPrompt: m.clapPrompt }));
    // This is the one save that can hit the controller's in-use removal
    // guard (assertNoOrphanMoods, settings/validate.ts): renaming or
    // removing a mood that a time-of-day slot, weather slot, festival or show
    // still points at throws a plain Error — "can't remove that mood — still
    // used by …" — from INSIDE settings.update(), after the vocabulary is
    // re-validated but before the maps are re-checked against it (only a
    // same-patch moodSchedule/weatherMoods save re-validates membership; this
    // card posts `moods` alone). That's a cross-field, whole-request rule,
    // not a single input's — there is no field to attach it to, so it
    // surfaces as a toast via persistPatch's catch, not via
    // applyServerFieldErrors/setError.
    await persistPatch(
      'moods',
      'moods',
      { moods: payload },
      raw,
      `${raw.length} mood${raw.length === 1 ? '' : 's'} saved`,
      // The only place savedMoodNames advances — see the comment above its
      // declaration. Prefer the server's own normalised names (settings.ts
      // runs every mood id through settingsNormalizeMoodName) over the raw
      // payload, so a not-yet-lowercased/dashed id typed by the operator
      // doesn't leak into the Moments dropdowns as a name the server would
      // never actually store that way.
      saved => {
        const savedMoods = Array.isArray(saved?.moods) ? (saved.moods as MoodEntry[]) : payload;
        setSavedMoodNames(savedMoods.map(m => m.name));
      },
    );
  };

  const saveSchedule = async () => {
    const ok = await form.trigger('schedule');
    if (!ok) return;
    const value = getFormValue('schedule');
    await persistPatch('schedule', 'schedule', { moodSchedule: value }, value, 'Time-of-day moods saved');
  };

  const saveWeather = async () => {
    const ok = await form.trigger('weather');
    if (!ok) return;
    const value = getFormValue('weather');
    await persistPatch('weather', 'weather', { weatherMoods: value }, value, 'Weather moods saved');
  };

  const saveCorrections = async () => {
    const ok = await form.trigger('corrections');
    if (!ok) return;
    const raw = getFormValue('corrections');
    const effective = raw.map(c => ({ from: c.from.trim(), to: c.to.trim() })).filter(c => c.from);
    // nextValue is the RAW value (blank scratch rows included) so the dirty
    // comparison stays structural (current === new default exactly); the
    // POSTED payload is the filtered one. A lingering blank row (added but
    // never filled in) therefore still reads as "dirty" after a save — a
    // minor, pre-existing quirk (the old state-diff version had the same
    // shape: dirtiness compared the FILTERED value, so a blank row was
    // invisible to it too) — harmless: re-saving just resends the same
    // effective payload.
    await persistPatch('corrections', 'corrections', { tts: { corrections: effective } }, raw, 'Speech corrections saved');
  };

  // Per-card Save gate. Not `form.formState.isValid` — that's the WHOLE
  // form's validity (zodResolver parses the combined schema as one object on
  // every change), so an invalid vocab-tab row would also disable the
  // moments/speech Save buttons despite those cards being independently fine.
  // Deferred /settings section work inherits this shape: one form per
  // section, one Save per card within it, each card gated on ITS OWN slice
  // of formState.errors/dirtyFields rather than the form-wide flags. Note
  // this direct-index lookup (`errors[key]`) only generalises as-is for
  // TOP-LEVEL keys, which is all four cards here are — a card keyed on a
  // NESTED settings path (e.g. a future `llm.baseUrl` card) will need a
  // `get(errors, path)`-style accessor instead of a bare index.
  const cardState = (key: keyof MoodsFormValues) => {
    const errors = form.formState.errors as Record<string, unknown>;
    const dirty = form.formState.dirtyFields as Record<string, unknown>;
    return { invalid: !!errors[key], dirty: !!dirty[key] };
  };

  if (!hydrated || needsAuth) return null;

  const tabs = [
    { id: 'vocab' as TabId, label: 'Vocabulary', count: loaded ? moodFields.length : undefined, icon: Palette },
    { id: 'moments' as TabId, label: 'Moments', count: undefined as number | undefined, icon: Clock },
    { id: 'festivals' as TabId, label: 'Festivals', count: undefined as number | undefined, icon: CalendarDays },
    { id: 'speech' as TabId, label: 'Speech', count: loaded ? corrFields.length : undefined, icon: Volume2 },
  ];

  const moodsCard = cardState('moods');
  const scheduleCard = cardState('schedule');
  const weatherCard = cardState('weather');
  const correctionsCard = cardState('corrections');

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">moods</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Moods &amp; moments.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            The words your library is tagged with, and which of them each part of the day, the
            weather, and the calendar leans into. Edit the list and every show, festival, and
            auto-DJ pick draws from it.
          </div>
        </div>
        <SectionTabs tabs={tabs} value={tab} onChange={selectTab} label="Moods sections" />
      </section>

      {err && <ErrorState error={err} onRetry={load} />}

      {!loaded && !err && tab !== 'festivals' && <SkeletonCards cards={6} />}

      {tab === 'vocab' && loaded && (
        <Card title="Mood vocabulary" sub="the moods every track is tagged with">
          <div className="field">
            <div className="field-hint">
              Give each mood a short id (letters, digits, dashes) and, if you like, a sound
              description we use for audio tagging (needs the heavy analyzer). Change a mood or its
              description and the older tags are marked stale; audio moods re-score on the next
              analysis pass, so re-run the tagger to refresh them. If a mood is still used by a
              show, festival, or one of the maps in Moments, you’ll need to reassign it before you
              can remove it.
            </div>
            <ScrollArea className="max-h-[420px]">
              <div className="flex flex-col gap-3 pr-2">
                {moodFields.map((field, idx) => (
                  <div
                    key={field._rhfKey}
                    className="flex flex-col gap-2 border-b border-ink/10 pb-3 last:border-0 sm:flex-row sm:items-end sm:gap-3"
                  >
                    <TextField
                      control={arrayControl}
                      name={`moods.${idx}.name`}
                      label="Mood id"
                      placeholder="id (e.g. mellow)"
                      className="sm:w-48 sm:shrink-0"
                      maxLength={SETTINGS_MOOD_NAME_MAX}
                    />
                    <TextField
                      control={arrayControl}
                      name={`moods.${idx}.clapPrompt`}
                      label="Sound description"
                      placeholder="sound description for audio tagging (optional)"
                      className="sm:flex-1"
                      maxLength={SETTINGS_MOOD_PROMPT_MAX}
                    />
                    <Btn
                      sm
                      title="Remove mood"
                      className="size-9 shrink-0 self-start sm:self-end"
                      onClick={() => removeMood(idx)}
                    >
                      <Trash2 size={12} />
                    </Btn>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Btn
                className="min-h-9 sm:min-h-0"
                disabled={moodFields.length >= MOODS_LIMIT}
                onClick={() => {
                  appendMood({ name: '', clapPrompt: '' });
                  // formState.errors is populated per-field, lazily — a
                  // freshly appended row carries no error until touched,
                  // even though the Save button's `moodsCard.invalid` gate
                  // reads that same errors map. Without this, "Save
                  // vocabulary" enables on a blank row and the click just
                  // silently no-ops against form.trigger('moods') inside
                  // saveMoods. Force the refresh here instead.
                  void form.trigger('moods');
                }}
              >
                Add mood
              </Btn>
              <Btn
                tone="accent"
                className="min-h-9 sm:min-h-0"
                disabled={busy !== null || !moodsCard.dirty || moodsCard.invalid}
                onClick={() => void saveMoods()}
              >
                {busy === 'moods' ? 'Saving…' : 'Save vocabulary'}
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {tab === 'moments' && loaded && (
        <>
          <Card title="Time of day → mood" sub="the mood your station leans into through the day">
            <div className="grid gap-3">
              {PERIODS.map(p => (
                <SelectField
                  key={p.id}
                  control={arrayControl}
                  name={`schedule.${p.id}`}
                  label={`${p.label} · ${p.hours}`}
                  options={moodOptions}
                />
              ))}
              <div className="mt-1">
                <Btn
                  tone="accent"
                  className="min-h-9 sm:min-h-0"
                  disabled={busy !== null || !scheduleCard.dirty || scheduleCard.invalid}
                  onClick={() => void saveSchedule()}
                >
                  {busy === 'schedule' ? 'Saving…' : 'Save time-of-day moods'}
                </Btn>
              </div>
            </div>
          </Card>

          <Card title="Weather → mood" sub="how live weather colours the mood — this wins over time of day">
            <div className="grid gap-3">
              {CONDITIONS.map(c => (
                <WeatherMoodSelect
                  key={c.id}
                  control={arrayControl}
                  condition={c.id}
                  label={c.label}
                  moodOptions={moodOptions}
                  fieldId={fieldId}
                />
              ))}
              <div className="mt-1">
                <Btn
                  tone="accent"
                  className="min-h-9 sm:min-h-0"
                  disabled={busy !== null || !weatherCard.dirty || weatherCard.invalid}
                  onClick={() => void saveWeather()}
                >
                  {busy === 'weather' ? 'Saving…' : 'Save weather moods'}
                </Btn>
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === 'festivals' && <FestivalsSection />}

      {tab === 'speech' && loaded && (
        <Card title="Speech corrections" sub="how names and tricky words should sound">
          <div className="field">
            <div className="field-hint">
              Find-and-replace rules we apply to every line before it’s spoken, for names and
              words the voice tends to get wrong (<em>GHz</em> →<em> gigahertz</em>, <em>Hozier</em>{' '}
              → <em>Ho-zeer</em>). Case doesn’t matter, and it matches whole words and phrases;
              leave the spoken form empty to drop a word entirely. New rules kick in from the next
              line — no restart needed.
            </div>
            <ScrollArea className="max-h-[360px]">
              <div className="flex flex-col gap-3 pr-2">
                {corrFields.map((field, idx) => (
                  <div
                    key={field._rhfKey}
                    className="flex flex-col gap-2 border-b border-ink/10 pb-3 last:border-0 sm:flex-row sm:items-end sm:gap-3"
                  >
                    <TextField
                      control={arrayControl}
                      name={`corrections.${idx}.from`}
                      label="Text on air"
                      placeholder="text on air (e.g. GHz)"
                      className="sm:flex-1"
                      maxLength={CORRECTION_FROM_MAX}
                    />
                    <TextField
                      control={arrayControl}
                      name={`corrections.${idx}.to`}
                      label="Spoken form"
                      placeholder="spoken form (e.g. gigahertz)"
                      description="leave empty to drop the word"
                      maxLength={CORRECTION_TO_MAX}
                      className="sm:flex-1"
                    />
                    <Btn
                      sm
                      title="Remove correction"
                      className="size-9 shrink-0 self-start sm:self-end"
                      onClick={() => removeCorr(idx)}
                    >
                      <Trash2 size={12} />
                    </Btn>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Btn
                className="min-h-9 sm:min-h-0"
                disabled={corrFields.length >= CORRECTIONS_LIMIT}
                onClick={() => appendCorr({ from: '', to: '' })}
              >
                Add correction
              </Btn>
              <Btn
                tone="accent"
                className="min-h-9 sm:min-h-0"
                disabled={busy !== null || !correctionsCard.dirty || correctionsCard.invalid}
                onClick={() => void saveCorrections()}
              >
                {busy === 'corrections' ? 'Saving…' : 'Save corrections'}
              </Btn>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
