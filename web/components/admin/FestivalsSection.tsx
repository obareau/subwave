'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn } from './ui';
import { SectionHeader } from './settings/shared';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';

interface Festival {
  month: number;
  day: number;
  name: string;
  mood: string;
  description?: string;
  windowDays?: number;
}

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

export default function FestivalsSection() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [festivals, setFestivals] = useState<Festival[] | null>(null);
  const [moods, setMoods] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Festival | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const fieldId = useId();

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
      const loaded = Array.isArray(vals) ? (vals as Festival[]) : [];
      setFestivals(sortFestivals(loaded));
      // Vocabulary comes from the server so the dropdown can't drift from what
      // the controller will accept.
      const moodVals = j?.tts?.moods;
      setMoods(Array.isArray(moodVals) ? (moodVals as string[]) : []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  const save = async (updated: Festival[]) => {
    setBusy(true);
    try {
      const payload = updated.map(f => ({
        month: f.month,
        day: f.day,
        name: f.name,
        mood: f.mood,
        description: f.description || '',
        windowDays: f.windowDays || 0,
      }));
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ festivals: payload }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setFestivals(sortFestivals(updated));
      setEditing(null);
      setEditIdx(null);
      notify.ok(`${updated.length} festival${updated.length === 1 ? '' : 's'} saved`);
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const startAdd = () => {
    setEditing({ ...EMPTY_FESTIVAL });
    setEditIdx(null);
  };

  const startEdit = (idx: number) => {
    if (!festivals || !festivals[idx]) return;
    setEditing({ ...festivals[idx] });
    setEditIdx(idx);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditIdx(null);
  };

  const commitEdit = () => {
    if (!festivals || !editing) return;
    const name = editing.name.trim();
    if (!name) {
      notify.err('Name is required');
      return;
    }
    let updated: Festival[];
    if (editIdx !== null) {
      updated = festivals.map((f, i) => (i === editIdx ? editing : f));
    } else {
      updated = [...festivals, editing];
    }
    void save(updated);
  };

  const remove = (idx: number) => {
    if (!festivals) return;
    const updated = festivals.filter((_, i) => i !== idx);
    void save(updated);
  };

  const updateField = <K extends keyof Festival>(field: K, value: Festival[K]) => {
    if (!editing) return;
    setEditing({ ...editing, [field]: value });
  };

  if (!hydrated || needsAuth) return null;

  // Grouped into month sections, carrying the original index so a row click
  // edits the right entry.
  const now = new Date();
  const timings = (festivals || []).map(f => festivalTiming(f, now));
  const nextIdx = timings.length
    ? timings.reduce((best, t, i) => (t.until < (timings[best]?.until ?? Infinity) ? i : best), 0)
    : -1;
  const months: Array<{ month: number; rows: Array<{ f: Festival; idx: number }> }> = [];
  (festivals || []).forEach((f, idx) => {
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
        metrics={festivals ? [{ n: String(festivals.length), l: `date${festivals.length === 1 ? '' : 's'}`, accent: true }] : undefined}
        actions={
          <Btn tone="accent" className="min-h-9 sm:min-h-0" onClick={startAdd} disabled={festivals === null}>
            Add festival
          </Btn>
        }
      />

      {err && <ErrorState error={err} onRetry={load} />}

      {festivals === null && !err && <SkeletonRows rows={4} />}

      {festivals !== null && (
        <Card
          title="Calendar"
          sub={`${festivals.length} date${festivals.length === 1 ? '' : 's'} · click one to edit`}
        >
          {festivals.length === 0 ? (
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
        open={editing !== null}
        onOpenChange={o => { if (!o) cancelEdit(); }}
        title={editIdx !== null ? 'edit festival' : 'new festival'}
        sub={editIdx !== null && editing ? editing.name : undefined}
        width={520}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {editIdx !== null ? (
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
                onClick={commitEdit}
                disabled={busy || !editing?.name.trim()}
              >
                {busy ? 'Saving…' : editIdx !== null ? 'Save changes' : 'Add festival'}
              </Btn>
            </div>
          </div>
        }
      >
        {editing && (
          <div className="grid gap-4">
            <div className="field">
              <Label htmlFor={`${fieldId}-name`}>Name</Label>
              <Input
                id={`${fieldId}-name`}
                value={editing.name}
                onChange={e => updateField('name', e.target.value)}
                placeholder="e.g. New Year's Day"
                maxLength={80}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <Label htmlFor={`${fieldId}-month`}>Month</Label>
                <Select
                  value={String(editing.month)}
                  onValueChange={v => {
                    // Clamp the day so Oct 31 → February can't leave an
                    // impossible date in the form.
                    const month = Number(v);
                    setEditing(cur => cur && ({
                      ...cur,
                      month,
                      day: Math.min(cur.day, DAYS_IN_MONTH(month)),
                    }));
                  }}
                >
                  <SelectTrigger id={`${fieldId}-month`} aria-label="Month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((name, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="field">
                <Label htmlFor={`${fieldId}-day`}>Day</Label>
                <Select
                  value={String(editing.day)}
                  onValueChange={v => updateField('day', Number(v))}
                >
                  <SelectTrigger id={`${fieldId}-day`} aria-label="Day">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: DAYS_IN_MONTH(editing.month) }, (_, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="field">
              <Label htmlFor={`${fieldId}-desc`}>Description <span className="text-muted">(optional)</span></Label>
              <Input
                id={`${fieldId}-desc`}
                value={editing.description || ''}
                onChange={e => updateField('description', e.target.value)}
                placeholder="Short note about the festival"
                maxLength={200}
              />
              <div className="field-hint mt-1">
                A short note your DJ can weave into its chat while the festival is on.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <Label htmlFor={`${fieldId}-mood`}>Mood</Label>
                <Select
                  value={editing.mood}
                  onValueChange={v => updateField('mood', v)}
                >
                  <SelectTrigger id={`${fieldId}-mood`} aria-label="Mood">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {moods.map(m => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="field">
                <Label htmlFor={`${fieldId}-window`}>Window <span className="text-muted">(days)</span></Label>
                <Input
                  id={`${fieldId}-window`}
                  type="number"
                  min={0}
                  max={14}
                  value={String(editing.windowDays ?? 0)}
                  onChange={e => updateField('windowDays', Math.max(0, Math.min(14, Number(e.target.value) || 0)))}
                />
              </div>
            </div>
            <div className="field-hint -mt-2">
              Music and spoken tone shift into the mood for the days around the date — a 3-day
              window covers a full week.
            </div>
          </div>
        )}
      </Modal>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Remove festival"
        description={
          confirmDelete != null && festivals
            ? `Remove "${festivals[confirmDelete]?.name}" from the festival calendar?`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (confirmDelete != null) { remove(confirmDelete); setConfirmDelete(null); }
        }}
      />
    </section>
  );
}
