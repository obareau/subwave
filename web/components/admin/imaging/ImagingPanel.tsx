'use client';

/* Owns the state and handlers the Jingles / SFX / Beds / Voices sections need.
   Tab pattern mirrors ConnectPanel (Seg control + ?tab= deep-link). */

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Music, AudioLines, Waves, Mic } from 'lucide-react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { SectionTabs } from '../SectionTabs';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import type { SettingsData, SaveSettings } from '../settings/shared';
import type { SfxData, SfxForm, BedsData, BedsForm, VoiceData, JingleImportFailure, JingleImportResult } from './types';
import { JinglesSection } from './JinglesSection';
import { SfxSection } from './SfxSection';
import { BedsSection } from './BedsSection';
import { VoicesSection } from './VoicesSection';
import { MonoLabel, TabMetric, pad2 } from './parts';

type TabId = 'jingles' | 'sfx' | 'beds' | 'voices';
const TAB_IDS: TabId[] = ['jingles', 'sfx', 'beds', 'voices'];

export default function ImagingPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsData | null>(null);
  const [sfxData, setSfxData] = useState<SfxData | null>(null);
  const [bedsData, setBedsData] = useState<BedsData | null>(null);
  const [voicesData, setVoicesData] = useState<VoiceData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Active tab lives in the URL (?tab=…), shared by the in-page SectionTabs and the
  // sidebar submenu, so switching tabs while already on the page works.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'jingles';

  // jingleRatio null = not yet hydrated from /settings; polling never re-hydrates it,
  // so operator edits to the ratio input survive the 3s refresh.
  const [jingleText, setJingleText] = useState('');
  const [jingleRatio, setJingleRatio] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [sfxForm, setSfxForm] = useState<SfxForm>({ name: '', description: '', prompt: '', durationSec: '' });
  const [confirmDeleteSfx, setConfirmDeleteSfx] = useState<string | null>(null);

  const [bedsForm, setBedsForm] = useState<BedsForm>({ name: '', description: '', prompt: '', durationSec: '' });
  const [confirmDeleteBed, setConfirmDeleteBed] = useState<string | null>(null);
  const [confirmDeleteVoice, setConfirmDeleteVoice] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json()) as SettingsData;
      setData(j); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const refreshSfx = async () => {
    try {
      const r = await adminFetch('/sfx');
      if (!r.ok) return;
      setSfxData((await r.json()) as SfxData);
    } catch { /* non-fatal */ }
  };

  const refreshBeds = async () => {
    try {
      const r = await adminFetch('/beds');
      if (!r.ok) return;
      setBedsData((await r.json()) as BedsData);
    } catch { /* non-fatal */ }
  };

  const refreshVoices = async () => {
    try {
      const r = await adminFetch('/voices');
      if (!r.ok) return;
      setVoicesData((await r.json()) as VoiceData);
    } catch { /* non-fatal */ }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    refresh(); refreshSfx(); refreshBeds(); refreshVoices();
    const id = setInterval(() => { refresh(); refreshSfx(); refreshBeds(); refreshVoices(); }, 3000);
    return () => clearInterval(id);
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (data?.values && jingleRatio == null) setJingleRatio(String(data.values.jingleRatio ?? ''));
  }, [data, jingleRatio]);

  // Routed through Next so a soft nav (in-page tab or sidebar submenu) re-derives `tab`.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const saveSettings: SaveSettings = async (patch) => {
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; requiresRestart?: boolean };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      // A jingle-ratio change needs a mixer restart (control in Settings → Danger zone).
      notify.ok(j.requiresRestart ? 'saved, restart the mixer to apply' : 'saved');
      await refresh();
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  const createJingle = async (): Promise<boolean> => {
    if (!jingleText.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/jingles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jingleText.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setJingleText('');
      await refresh();
      return true;
    } catch (e) { notify.err(`Jingle creation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // adminFetch leaves Content-Type unset so the browser sets the multipart boundary.
  // One request per file, not one batch: a 40-file import would otherwise sit in
  // server memory at once and one bad file would sink the rest. `label` applies only
  // to a single-file import. An abort counts the interrupted file as skipped, not failed.
  const uploadJingle = async (
    files: File[],
    label: string,
    opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<JingleImportResult | null> => {
    if (busy || !files.length) return null;
    const { onProgress, signal } = opts;
    setBusy(true);
    const total = files.length;
    let ok = 0;
    let aborted = false;
    const failures: JingleImportFailure[] = [];
    try {
      for (const [i, file] of files.entries()) {
        if (signal?.aborted) { aborted = true; break; }
        try {
          const fd = new FormData();
          fd.append('file', file);
          if (total === 1 && label.trim()) fd.append('label', label.trim());
          const r = await adminFetch('/jingles/upload', { method: 'POST', body: fd, signal });
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
          ok++;
        } catch (e) {
          if (signal?.aborted) { aborted = true; break; }
          failures.push({ name: file.name, reason: errorMessage(e) });
        }
        onProgress?.(i + 1, total);
      }
      if (ok) await refresh();
      if (aborted) {
        notify.info(`Import stopped — ${ok}/${total} imported`);
      } else if (total === 1) {
        if (ok) notify.ok('jingle imported');
        else notify.err(`Jingle import failed: ${failures[0]?.reason}`);
      } else if (failures.length === 0) {
        notify.ok(`${ok} jingles imported`);
      } else {
        notify.err(`${ok}/${total} jingles imported · ${failures.length} failed`);
      }
      return { ok, total, failures, aborted };
    } finally { setBusy(false); }
  };

  const createSfx = async (): Promise<boolean> => {
    if (!sfxForm.name.trim() || !sfxForm.prompt.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/sfx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sfxForm.name.trim(),
          description: sfxForm.description.trim(),
          prompt: sfxForm.prompt.trim(),
          durationSec: sfxForm.durationSec ? parseFloat(sfxForm.durationSec) : undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSfxForm({ name: '', description: '', prompt: '', durationSec: '' });
      await refreshSfx();
      return true;
    } catch (e) { notify.err(`Sound effect creation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteSfx = async (name: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/sfx/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Upload a ready-made effect — no ElevenLabs key required (unlike createSfx).
  const uploadSfx = async (file: File, name: string, description: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      if (description.trim()) fd.append('description', description.trim());
      const r = await adminFetch('/sfx/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
      notify.ok('sound effect imported');
      return true;
    } catch (e) { notify.err(`Sound effect import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  // Generate a bed via the ElevenLabs Music API — needs a key (unlike uploadBed).
  const createBed = async (): Promise<boolean> => {
    if (!bedsForm.name.trim() || !bedsForm.prompt.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/beds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: bedsForm.name.trim(),
          description: bedsForm.description.trim(),
          prompt: bedsForm.prompt.trim(),
          durationSec: bedsForm.durationSec ? parseFloat(bedsForm.durationSec) : undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setBedsForm({ name: '', description: '', prompt: '', durationSec: '' });
      await refreshBeds();
      notify.ok('bed generated');
      return true;
    } catch (e) { notify.err(`Bed generation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const uploadBed = async (file: File, name: string, description: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      if (description.trim()) fd.append('description', description.trim());
      const r = await adminFetch('/beds/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshBeds();
      notify.ok('bed imported');
      return true;
    } catch (e) { notify.err(`Bed import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteBed = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/beds/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshBeds();
      notify.ok('bed deleted');
    } catch (e) { notify.err(`Bed delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Any accepted audio type; the controller transcodes to the canonical mono WAV.
  const uploadVoice = async (file: File, name: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      const r = await adminFetch('/voices/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshVoices();
      notify.ok('voice imported');
      return true;
    } catch (e) { notify.err(`Voice import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteVoice = async (file: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/voices/${encodeURIComponent(file)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshVoices();
      notify.ok('voice deleted');
    } catch (e) { notify.err(`Voice delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Undefined until each source loads; the badge is omitted until then.
  const jingleCount = data?.jingles?.length;
  const sfxCount = sfxData?.sfx?.length;
  const bedCount = bedsData?.beds?.length;
  const totalAssets = (jingleCount ?? 0) + (sfxCount ?? 0) + (bedCount ?? 0);
  const ratioVal = data?.values?.jingleRatio;
  const ratioMetric = ratioVal == null ? '—' : ratioVal === 0 ? 'off' : `1 : ${ratioVal}`;
  const tabs = [
    { id: 'jingles' as TabId, label: 'Jingles', count: jingleCount, icon: Music },
    { id: 'sfx' as TabId, label: 'SFX', count: sfxCount, icon: AudioLines },
    { id: 'beds' as TabId, label: 'Beds', count: bedCount, icon: Waves },
    { id: 'voices' as TabId, label: 'Voices', count: voicesData?.voices?.length, icon: Mic },
  ];

  return (
    <div className="grid gap-4">
      <section className="card">
      <header className="p-4 lg:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <MonoLabel>imaging</MonoLabel>
          <span className="flex items-center gap-[7px] font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
            <span className="size-1.5 animate-pulse bg-[var(--accent)]" aria-hidden />
            live · refreshed every 3s
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <div className="text-[22px] leading-tight font-extrabold tracking-[-0.02em]">
              The sounds between the songs.
            </div>
            <p className="mt-1 max-w-[62ch] text-[11px] leading-[1.6] [text-wrap:pretty] text-muted">
              Everything your DJ slips between and over the music:{' '}
              <strong className="font-semibold text-ink">jingles</strong> are the station idents
              between tracks, <strong className="font-semibold text-ink">SFX</strong> are the little
              stingers under the voice,{' '}
              <strong className="font-semibold text-ink">beds</strong> are instrumentals to talk
              over when a link runs long, and{' '}
              <strong className="font-semibold text-ink">voices</strong> are the clips your
              personas are cloned from.
            </p>
          </div>
          <div className="flex flex-none gap-7">
            <TabMetric big n={pad2(totalAssets)} l="assets" />
            <TabMetric big accent n={ratioMetric} l="jingle ratio" />
          </div>
        </div>
      </header>

      <SectionTabs tabs={tabs} value={tab} onChange={selectTab} label="Imaging sections" />
      </section>

      {err && (
        <ErrorState error={err} onRetry={refresh} />
      )}

      <div>
        {tab === 'jingles' && (
          data ? (
            <JinglesSection
              data={data} busy={busy}
              jingleRatio={jingleRatio ?? ''} setJingleRatio={setJingleRatio}
              jingleText={jingleText} setJingleText={setJingleText}
              createJingle={createJingle} uploadJingle={uploadJingle}
              saveSettings={saveSettings}
              onDelete={setConfirmDelete} adminFetch={adminFetch}
            />
          ) : (
            !err && <SkeletonCards cards={6} />
          )
        )}

        {tab === 'sfx' && (
          <SfxSection
            sfxData={sfxData} sfxForm={sfxForm} setSfxForm={setSfxForm}
            busy={busy} createSfx={createSfx} uploadSfx={uploadSfx}
            onDelete={setConfirmDeleteSfx}
            data={data} saveSettings={saveSettings} adminFetch={adminFetch}
          />
        )}

        {tab === 'beds' && (
          <BedsSection
            bedsData={bedsData} bedsForm={bedsForm} setBedsForm={setBedsForm}
            busy={busy} createBed={createBed} uploadBed={uploadBed}
            onDelete={setConfirmDeleteBed}
            data={data} saveSettings={saveSettings} adminFetch={adminFetch}
          />
        )}

        {tab === 'voices' && (
          <VoicesSection
            voicesData={voicesData} busy={busy}
            uploadVoice={uploadVoice}
            onDelete={setConfirmDeleteVoice}
            adminFetch={adminFetch}
          />
        )}
      </div>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Delete jingle"
        description={confirmDelete ? `Delete the jingle "${confirmDelete}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDelete) deleteJingle(confirmDelete); setConfirmDelete(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteSfx != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteSfx(null); }}
        title="Delete sound effect"
        description={confirmDeleteSfx ? `Delete the sound effect "${confirmDeleteSfx}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteSfx) deleteSfx(confirmDeleteSfx); setConfirmDeleteSfx(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteBed != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteBed(null); }}
        title="Delete bed"
        description={confirmDeleteBed ? `Delete the bed "${confirmDeleteBed}"? This removes the audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteBed) deleteBed(confirmDeleteBed); setConfirmDeleteBed(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteVoice != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteVoice(null); }}
        title="Delete voice"
        description={confirmDeleteVoice ? `Delete the reference voice "${confirmDeleteVoice}"? Any persona still set to it falls back to the engine's built-in voice.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteVoice) deleteVoice(confirmDeleteVoice); setConfirmDeleteVoice(null); }}
      />
    </div>
  );
}
