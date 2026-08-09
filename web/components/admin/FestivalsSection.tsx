'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  useController, useFieldArray, useWatch, type Control,
} from 'react-hook-form';
import { z } from 'zod';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import { TextField, SelectField } from '@/lib/form-fields';
import { Card, Btn } from './ui';
import { SectionHeader } from './settings/shared';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import { Input } from '../ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import {
  festivalsSchema,
  SETTINGS_FESTIVAL_DESCRIPTION_MAX,
  SETTINGS_FESTIVAL_NAME_MAX,
  SETTINGS_FESTIVAL_WINDOW_DAYS_MAX,
} from '@/lib/schemas.generated';

// festivalsSchema is a FACTORY (`festivalsSchema(ctx: SettingsMoodContext)`) —
// see the doc comment on SettingsMoodContext in the mirror. It's also built as
// `z.unknown().superRefine(...).transform(...)`, a hand-validated array rather
// than a structurally-typed `z.object` array, so `z.input<>` collapses to
// `unknown` and `FieldPath` can't derive nested paths like `festivals.0.name`.
// `ReturnType`/`z.output` pull the schema's real OUTPUT shape purely at the
// type level (no runtime instance needed, so no throwaway ctx value) for
// typing the modal's bound fields — the live, per-render schema below (built
// with the real moodNames) is what actually validates at runtime.
type FestivalsArray = z.output<ReturnType<typeof festivalsSchema>>;
type FestivalsFormValues = { festivals: FestivalsArray };
type Festival = FestivalsArray[number];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAYS_IN_MONTH = (m: number) => {
  if (m === 2) return 29;
  if ([4, 6, 9, 11].includes(m)) return 30;
  return 31;
};

const EMPTY_FESTIVAL: Festival = {
  month: 1,
  day: 1,
  name: '',
  mood: 'festival',
  description: '',
  windowDays: 0,
};

const sortFestivals = (list: Festival[]) =>
  [...list].sort((a, b) => a.month - b.month || a.day - b.day);

// Display only — the controller owns the real window logic in
// getFestivalContext. `until` wraps the year boundary.
function festivalTiming(f: Festival, now: Date) {
  const dayMs = 86400000;
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffs = [-1, 0, 1].map(dy =>
    Math.round((new Date(now.getFullYear() + dy, f.month - 1, f.day).getTime() - t0) / dayMs),
  );
  return {
    active: diffs.some(d => Math.abs(d) <= (f.windowDays || 0)),
    until: Math.min(...diffs.filter(d => d >= 0)),
  };
}

// The modal's fields, bound directly into the `festivals` field array at
// `idx`. A separate component (not inline JSX in FestivalsSection) so its
// useController/TextField/SelectField calls are unconditional from ITS OWN
// perspective — the parent only mounts it while a row is open, which is
// ordinary conditional rendering, not a conditional hook call.
//
// Name, description and mood bind through the shared `TextField`/
// `SelectField` (web/lib/form-fields.tsx) against `arrayControl` (the
// schema-output-typed cast built in FestivalsSection) — nothing about those
// wrappers needs the schema to be a structural `z.object`/`z.array`, only a
// concrete `Control<T>`/`FieldPath<T>` at the call site, which the cast
// already supplies. Their ids embed the literal RHF path
// (`festivals.${idx}.name`), including the dot — legal in a DOM id and
// resolved correctly by real id lookups (`getElementById`,
// `aria-describedby`, the accessibility tree); `verify-forms.py`'s
// `assert_aria` now resolves ids via an attribute selector so it agrees.
//
// Month, day and windowDays stay on a hand-rolled `useController` +
// `fieldAria` (not one of the five bound shapes): month's onValueChange also
// clamps day, and windowDays clamps its own value — neither is expressible
// through TextField/SelectField's plain field.onChange. Their ids are
// `${fieldId}-<field>` (a fixed per-mount suffix) purely because there's no
// reason to route them through the RHF path when fieldAria is being called
// by hand anyway; since only one row is ever open in this modal, a fixed
// per-mount id (no row key needed) is enough either way.
function FestivalModalFields({
  idx,
  control,
  moods,
  fieldId,
}: {
  idx: number;
  control: Control<FestivalsFormValues>;
  moods: string[];
  fieldId: string;
}) {
  const monthField = useController({ control, name: `festivals.${idx}.month` });
  const dayField = useController({ control, name: `festivals.${idx}.day` });
  const windowField = useController({ control, name: `festivals.${idx}.windowDays` });

  const monthAria = fieldAria(`${fieldId}-month`, monthField.fieldState.error);
  const dayAria = fieldAria(`${fieldId}-day`, dayField.fieldState.error);
  const windowAria = fieldAria(`${fieldId}-window`, windowField.fieldState.error);

  const month = monthField.field.value;
  const moodOptions = moods.map(m => ({ value: m, label: m }));

  return (
    <div className="grid gap-4">
      <TextField
        control={control}
        name={`festivals.${idx}.name`}
        label="Name"
        placeholder="e.g. New Year's Day"
        maxLength={SETTINGS_FESTIVAL_NAME_MAX}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field data-invalid={monthAria.invalid || undefined}>
          <FieldLabel {...monthAria.labelProps}>Month</FieldLabel>
          <Select
            value={String(month)}
            onValueChange={v => {
              // Clamp the day so Oct 31 → February can't leave an
              // impossible date in the form. The schema owns the actual
              // month/day validity rule — this is display convenience only.
              const nextMonth = Number(v);
              monthField.field.onChange(nextMonth);
              const maxDay = DAYS_IN_MONTH(nextMonth);
              if (dayField.field.value > maxDay) dayField.field.onChange(maxDay);
            }}
          >
            <SelectTrigger {...monthAria.controlProps} onBlur={monthField.field.onBlur} ref={monthField.field.ref}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((name, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError {...monthAria.errorProps} errors={monthField.fieldState.error ? [monthField.fieldState.error] : undefined} />
        </Field>

        <Field data-invalid={dayAria.invalid || undefined}>
          <FieldLabel {...dayAria.labelProps}>Day</FieldLabel>
          <Select
            value={String(dayField.field.value)}
            onValueChange={v => dayField.field.onChange(Number(v))}
          >
            <SelectTrigger {...dayAria.controlProps} onBlur={dayField.field.onBlur} ref={dayField.field.ref}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: DAYS_IN_MONTH(month) }, (_, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError {...dayAria.errorProps} errors={dayField.fieldState.error ? [dayField.fieldState.error] : undefined} />
        </Field>
      </div>

      <TextField
        control={control}
        name={`festivals.${idx}.description`}
        label="Description (optional)"
        placeholder="Short note about the festival"
        description="A short note your DJ can weave into its chat while the festival is on."
        maxLength={SETTINGS_FESTIVAL_DESCRIPTION_MAX}
      />

      <div className="grid grid-cols-2 gap-3">
        <SelectField
          control={control}
          name={`festivals.${idx}.mood`}
          label="Mood"
          options={moodOptions}
        />

        <Field data-invalid={windowAria.invalid || undefined}>
          <FieldLabel {...windowAria.labelProps}>
            Window <span className="text-muted">(days)</span>
          </FieldLabel>
          <Input
            {...windowAria.controlProps}
            type="number"
            min={0}
            max={SETTINGS_FESTIVAL_WINDOW_DAYS_MAX}
            value={String(windowField.field.value)}
            onChange={e => {
              const n = Math.max(
                0,
                Math.min(SETTINGS_FESTIVAL_WINDOW_DAYS_MAX, Number(e.target.value) || 0),
              );
              windowField.field.onChange(n);
            }}
            onBlur={windowField.field.onBlur}
            ref={windowField.field.ref}
          />
          <FieldError {...windowAria.errorProps} errors={windowField.fieldState.error ? [windowField.fieldState.error] : undefined} />
        </Field>
      </div>
      <div className="field-hint -mt-2">
        Music and spoken tone shift into the mood for the days around the date — a 3-day
        window covers a full week.
      </div>
    </div>
  );
}

export default function FestivalsSection() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [loaded, setLoaded] = useState(false);
  const [moods, setMoods] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which-row-is-open UI state, kept out of the form (per the migration
  // plan). `editIdx` is the festivals[] index open in the modal, for BOTH add
  // and edit — an "add" appends a blank row immediately so its fields can
  // bind through the same field array as everything else. `editing` says
  // which of the two is in play: true while the open row is a fresh,
  // uncommitted append (Cancel removes it), false while it's an edit of an
  // already-saved row (Cancel reverts it to the snapshot taken on open).
  const [editing, setEditing] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const editSnapshot = useRef<Festival | null>(null);
  const fieldId = useId();

  // moodNames is nullable on the shared context and null means "this caller
  // cannot check that rule" — the route posture. The browser HAS the live
  // mood list (fetched below), so pass it: that's what makes the editor
  // refuse a festival naming a dead mood at the same moment the controller
  // would. A factory schema must be memoised or the resolver is rebuilt on
  // every render.
  const schema = useMemo(
    () => z.object({ festivals: festivalsSchema({ moodNames: moods }) }),
    [moods],
  );
  const form = useZodForm(schema, { festivals: [] });
  // form.control's declared field-values type is z.input<schema>, which is
  // `{ festivals: unknown }` for the reason in the FESTIVALS_TYPE_SHAPE
  // comment above. This cast only widens what TypeScript is allowed to
  // believe the control's shape is, to the schema's OUTPUT type — the same
  // `control` object at runtime, and the type every row actually holds since
  // the form is seeded only from server data or EMPTY_FESTIVAL, never truly
  // unknown.
  const arrayControl = form.control as unknown as Control<FestivalsFormValues>;
  const { fields, append, update, remove: removeField } = useFieldArray({
    control: arrayControl,
    name: 'festivals',
    keyName: '_rhfKey',
  });
  const watchedFestivals = useWatch({ control: arrayControl, name: 'festivals' }) ?? [];

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as {
        values?: { festivals?: unknown };
        tts?: { moods?: unknown };
      } | null;
      // validateFestivalsStrict normalises on every save, so trust the shape here.
      const vals = j?.values?.festivals;
      const loadedList = Array.isArray(vals) ? (vals as Festival[]) : [];
      form.reset({ festivals: sortFestivals(loadedList) });
      setLoaded(true);
      // Vocabulary comes from the server so the dropdown can't drift from what
      // the controller will accept.
      const moodVals = j?.tts?.moods;
      setMoods(Array.isArray(moodVals) ? (moodVals as string[]) : []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [adminFetch, form]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  // `moods` (and so the schema's mood vocabulary) arrives asynchronously —
  // the resolver was built with whatever `moods` held at that render. Once
  // the real vocabulary lands, re-validate rather than reseeding: reseeding
  // via a `values` prop is banned by the migration plan, and remounting the
  // form would drop an edit already in progress.
  useEffect(() => {
    void form.trigger();
  }, [moods, form]);

  const persist = useCallback(async (list: Festival[]) => {
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ festivals: list }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: Record<string, string>;
      };
      if (!r.ok) {
        // A rule only the server can check still lands on the right input.
        applyServerFieldErrors(form, j.fieldErrors);
        throw new Error(j.error || `failed (${r.status})`);
      }
      form.reset({ festivals: sortFestivals(list) });
      setEditIdx(null);
      setEditing(false);
      notify.ok(`${list.length} festival${list.length === 1 ? '' : 's'} saved`);
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }, [adminFetch, form]);

  const commit = form.handleSubmit(values => persist(values.festivals));

  const startAdd = () => {
    append({ ...EMPTY_FESTIVAL });
    // `fields.length` here is this render's (pre-append) count, i.e. exactly
    // the index the new row lands at.
    setEditIdx(fields.length);
    setEditing(true);
    // formState.errors is populated per-field, lazily — a freshly appended
    // row carries no error until touched. `form.formState.isValid` (the
    // Save button's own gate) IS eager and already disables Save correctly,
    // but without this the modal opens with no message under the blank
    // Name field explaining why: the operator sees a disabled button and
    // nothing else. Force the refresh so the field-level error appears too.
    void form.trigger('festivals');
  };

  const startEdit = (idx: number) => {
    editSnapshot.current = watchedFestivals[idx] ?? null;
    setEditIdx(idx);
    setEditing(false);
  };

  const cancelEdit = () => {
    if (editIdx === null) return;
    if (editing) {
      removeField(editIdx);
    } else if (editSnapshot.current) {
      update(editIdx, editSnapshot.current);
    }
    setEditIdx(null);
    setEditing(false);
    editSnapshot.current = null;
  };

  const confirmRemove = () => {
    if (confirmDelete == null) return;
    const updated = watchedFestivals.filter((_, i) => i !== confirmDelete);
    setConfirmDelete(null);
    setEditIdx(null);
    setEditing(false);
    void persist(updated);
  };

  if (!hydrated || needsAuth) return null;

  // Grouped into month sections, carrying the original index so a row click
  // edits the right entry.
  const now = new Date();
  const timings = watchedFestivals.map(f => festivalTiming(f, now));
  const nextIdx = timings.length
    ? timings.reduce((best, t, i) => (t.until < (timings[best]?.until ?? Infinity) ? i : best), 0)
    : -1;
  const months: Array<{ month: number; rows: Array<{ f: Festival; idx: number }> }> = [];
  watchedFestivals.forEach((f, idx) => {
    const last = months[months.length - 1];
    if (last && last.month === f.month) last.rows.push({ f, idx });
    else months.push({ month: f.month, rows: [{ f, idx }] });
  });

  return (
    <section className="grid gap-6">
      <SectionHeader
        eyebrow="festivals"
        title="Festival calendar."
        sub="Dates that set a mood, marked across the year. Add your local holidays, regional celebrations, or personal landmarks — the station leans into the nearest one as it comes around."
        metrics={loaded ? [{ n: String(watchedFestivals.length), l: `date${watchedFestivals.length === 1 ? '' : 's'}`, accent: true }] : undefined}
        actions={
          <Btn tone="accent" className="min-h-9 sm:min-h-0" onClick={startAdd} disabled={!loaded}>
            Add festival
          </Btn>
        }
      />

      {err && <ErrorState error={err} onRetry={load} />}

      {!loaded && !err && <SkeletonRows rows={4} />}

      {loaded && (
        <Card
          title="Calendar"
          sub={`${watchedFestivals.length} date${watchedFestivals.length === 1 ? '' : 's'} · click one to edit`}
        >
          {watchedFestivals.length === 0 ? (
            <EmptyState
              title="Nothing on the calendar yet"
              description="Add your first date to get started."
            />
          ) : (
            <div className="grid">
              {months.map(({ month, rows }) => (
                <div key={month}>
                  <div className="mt-4 mb-1 flex items-center gap-3 first:mt-0">
                    <span className="caption">{MONTH_NAMES[month - 1]}</span>
                    <span className="flex-1 border-t border-dashed border-separator-strong" />
                  </div>
                  {rows.map(({ f, idx }) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={busy}
                      onClick={() => startEdit(idx)}
                      /* Mood/window drop to a second row on mobile: three
                         columns leave the name only ~170px at 390px. */
                      className="grid w-full cursor-pointer grid-cols-[30px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 px-1.5 py-2 text-left hover:bg-[var(--ink-soft)] sm:grid-cols-[30px_1fr_auto] sm:gap-y-0"
                    >
                      <span className="mono-num col-start-1 row-start-1 text-[12px] text-muted">
                        {String(f.day).padStart(2, '0')}
                      </span>
                      <span className="col-start-2 row-start-1 min-w-0">
                        <span className="flex items-baseline gap-2.5">
                          <span className="truncate text-[13px] font-bold">{f.name}</span>
                          {timings[idx]?.active ? (
                            <span className="flex-none text-[9px] font-bold tracking-[0.2em] text-vermilion uppercase">
                              ● now
                            </span>
                          ) : idx === nextIdx ? (
                            <span className="flex-none text-[9px] font-bold tracking-[0.2em] text-muted uppercase">
                              up next · {timings[idx]?.until}d
                            </span>
                          ) : null}
                        </span>
                        {f.description ? (
                          <span className="block truncate text-[11px] leading-[1.5] text-muted">
                            {f.description}
                          </span>
                        ) : null}
                      </span>
                      <span className="col-start-2 row-start-2 flex items-baseline gap-2.5 text-[10px] tracking-[0.08em] text-muted sm:col-start-3 sm:row-start-1">
                        <span>{f.mood}</span>
                        {f.windowDays ? <span className="mono-num">±{f.windowDays}d</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Modal
        open={editIdx !== null}
        onOpenChange={o => { if (!o) cancelEdit(); }}
        title={editing ? 'new festival' : 'edit festival'}
        sub={!editing && editIdx !== null ? watchedFestivals[editIdx]?.name : undefined}
        width={520}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {!editing && editIdx !== null ? (
              <Btn sm tone="danger" className="min-h-9 sm:min-h-0" onClick={() => setConfirmDelete(editIdx)} disabled={busy}>
                Remove
              </Btn>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Btn sm className="min-h-9 sm:min-h-0" onClick={cancelEdit} disabled={busy}>Cancel</Btn>
              <Btn
                sm
                tone="accent"
                className="min-h-9 sm:min-h-0"
                onClick={commit}
                disabled={busy || !form.formState.isValid}
              >
                {busy ? 'Saving…' : editing ? 'Add festival' : 'Save changes'}
              </Btn>
            </div>
          </div>
        }
      >
        {editIdx !== null && (
          <FestivalModalFields idx={editIdx} control={arrayControl} moods={moods} fieldId={fieldId} />
        )}
      </Modal>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Remove festival"
        description={
          confirmDelete != null
            ? `Remove "${watchedFestivals[confirmDelete]?.name}" from the festival calendar?`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={confirmRemove}
      />
    </section>
  );
}
