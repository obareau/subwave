'use client';

/* The WAVs Chatterbox and PocketTTS clone from. Import-only — there is no
   prompt-to-voice generator. Files dropped into state/voices/ by hand show up here. */

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { V3Alert } from '../../ui/alert';
import { SkeletonCards } from '@/components/ui/skeleton';
import { Btn } from '../ui';
import { PreviewButton } from '../settings/shared';
import type { VoiceData } from './types';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface VoicesSectionProps {
  voicesData: VoiceData | null;
  busy: boolean;
  uploadVoice: (file: File, name: string) => Promise<boolean>;
  onDelete: (file: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

// Mirrors ACCEPTED_AUDIO_EXTS in controller/src/audio/audio-import.ts.
const ACCEPT = '.wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,.opus,audio/*';

export function VoicesSection({ voicesData, busy, uploadVoice, onDelete, adminFetch }: VoicesSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setImportFile(f);
    if (f && !importName.trim()) setImportName(f.name.replace(/\.[^.]+$/, ''));
  };

  const doImport = async () => {
    if (!importFile || !importName.trim()) return;
    const ok = await uploadVoice(importFile, importName);
    if (ok) {
      setImportFile(null);
      setImportName('');
      if (importRef.current) importRef.current.value = '';
      setModal(false);
    }
  };

  if (!voicesData) {
    return <SkeletonCards cards={4} />;
  }
  const list = voicesData.voices || [];
  const dir = voicesData.dir || 'state/voices/';
  const noFfmpeg = voicesData.ffmpeg === false;
  const minSec = voicesData.advisory?.minSec ?? 4;
  const maxSec = voicesData.advisory?.maxSec ?? 20;

  return (
    <section className="grid gap-[22px]">
      <SectionMasthead
        title="Voices"
        sub="Reference clips your DJ personas can be cloned from. About five seconds of clean speech is enough — one voice, no music, no background noise."
        metrics={<TabMetric accent n={pad2(list.length)} l="voices" />}
        actions={
          <Btn sm tone="solid" className="min-h-9 sm:min-h-0" onClick={() => setModal(true)} disabled={busy}>
            Import
          </Btn>
        }
      />

      <PanelBox>
        <PanelHead label={`voice library · ${pad2(list.length)}`} />
        {list.length === 0 ? (
          <EmptyState caption="import a ~5 second recording to clone a voice" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {list.map(v => (
              /* Mobile drops the play/delete cluster below the text (as SfxSection). */
              <div
                key={v.file}
                className="grid grid-cols-1 items-center gap-3 px-[18px] py-[15px] sm:grid-cols-[1fr_auto] sm:gap-[18px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-[14px] font-bold">{v.file}</span>
                    {v.legacy && <Badge variant="ink">legacy folder</Badge>}
                  </div>
                  <MetaLine>
                    {v.size != null && <span>{fmtSize(v.size)}</span>}
                    {v.durationSec != null && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{v.durationSec}s</span>
                      </>
                    )}
                  </MetaLine>
                  {/* Advisory, never blocking: the file is stored exactly as uploaded. */}
                  {v.warning === 'short' && (
                    <p className="mt-1.5 text-[11px] leading-[1.55] text-muted">
                      Under {minSec}s — there may not be enough speech here to clone reliably.
                    </p>
                  )}
                  {v.warning === 'long' && (
                    <p className="mt-1.5 text-[11px] leading-[1.55] text-muted">
                      Over {maxSec}s — longer clips slow every line this persona speaks without
                      sounding better.
                    </p>
                  )}
                </div>
                <div className="flex flex-none items-center gap-2">
                  <PreviewButton
                    path={`/voices/${encodeURIComponent(v.file)}/audio`}
                    adminFetch={adminFetch}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Delete voice"
                    className="size-9 sm:size-8"
                    disabled={busy}
                    onClick={() => onDelete(v.file)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelBox>

      <Modal
        open={modal}
        onOpenChange={(o) => { if (!o) setModal(false); }}
        title="import voice"
        sub="a short recording of the voice you want to clone"
        footer={
          <>
            <Button variant="ghost" size="sm" className="min-h-9 sm:min-h-0" onClick={() => setModal(false)}>Cancel</Button>
            <Btn
              sm
              tone="accent"
              className="min-h-9 sm:min-h-0"
              onClick={doImport}
              disabled={busy || !importFile || !importName.trim()}
            >
              {busy ? 'Importing…' : 'Import'}
            </Btn>
          </>
        }
      >
        <div className="grid gap-3.5">
          {noFfmpeg && (
            <V3Alert title="wav only on this host">
              ffmpeg isn’t installed here, so other formats can’t be converted. Upload a{' '}
              <code className="font-mono text-[12px]">.wav</code>, or run the Docker image —
              it ships ffmpeg.
            </V3Alert>
          )}
          <div>
            <DropZone
              label={importFile ? importFile.name : 'choose an audio file'}
              hint={noFfmpeg ? 'wav' : 'wav · mp3 · m4a · ogg · flac · opus'}
              onClick={() => importRef.current?.click()}
              disabled={busy}
            />
            <input
              ref={importRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={onPick}
            />
          </div>
          <div>
            <Label htmlFor="voice-import-name">Name</Label>
            <Input
              id="voice-import-name"
              value={importName}
              onChange={e => setImportName(e.target.value)}
              placeholder="late-night-dj"
            />
            <p className="mt-1.5 text-[11px] leading-[1.55] text-muted">
              Becomes the filename personas pick from. Stored as a mono{' '}
              <code className="font-mono text-[12px]">.wav</code> in{' '}
              <code className="font-mono text-[12px]">{dir}</code>, so you can also drop files
              there by hand.
            </p>
          </div>
        </div>
      </Modal>
    </section>
  );
}
