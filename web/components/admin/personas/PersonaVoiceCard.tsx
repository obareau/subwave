'use client';
// The engine picker and every engine's voice selector live in the shared
// tts/EngineVoiceFields, which the station-wide TTS fallback slot uses too.
import type { ChangeEvent } from 'react';
import type { Persona, PersonaTts, SettingsResponse } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { Card } from '../ui';
import { EngineVoiceFields, ENGINE_UNAVAILABLE } from '../tts/EngineVoiceFields';
import { Label } from '../../ui/label';
import { VoiceMeter } from './VoiceMeter';
import { cn } from '../../../lib/cn';

interface PersonaVoiceCardProps {
  persona: Persona;
  data: SettingsResponse | null;
  defaultEngine: string;
  cloudIssueText: string | null;
  adminFetch: AdminAuth['adminFetch'];
  updateTts: (patch: Partial<PersonaTts>) => void;
}

export function PersonaVoiceCard({ persona, data, defaultEngine, cloudIssueText, adminFetch, updateTts }: PersonaVoiceCardProps) {
  const gain = persona.tts.gainDb ?? 0;
  const gainLabel = !gain
    ? '0 dB'
    : `${gain > 0 ? '+' : '−'}${Math.abs(gain).toFixed(1)} dB`;

  const speed = persona.tts.speed ?? 1;
  // Only Piper/Kokoro/cloud honour speed; the other workers ignore it, so the
  // control is shown but disabled with a hint.
  const speedSupported = persona.tts.engine !== 'chatterbox' && persona.tts.engine !== 'pocket-tts' && persona.tts.engine !== 'remote';

  return (
    <Card flat title="Voice" sub="text-to-speech engine">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        <div className="min-w-0">
          <EngineVoiceFields
            value={persona.tts}
            onChange={updateTts}
            data={data}
            adminFetch={adminFetch}
            previewSpeed={persona.tts.speed}
            previewLanguage={persona.language}
            cloudIssue={cloudIssueText && (
              <>
                <strong>This cloud voice won’t play.</strong> {cloudIssueText}{' '}
                Until that’s fixed, this persona falls back to <strong>{defaultEngine}</strong>.
              </>
            )}
            engineHint={<>
              Each persona can use its own engine and voice. The badge on each card
              shows whether it&apos;s ready in this build.
            </>}
            unavailableNote={engine => (
              <>{ENGINE_UNAVAILABLE[engine]} This persona falls back to{' '}
                <strong>{defaultEngine}</strong> until it&apos;s up.</>
            )}
            previewHint={<>
              Plays a short sample in this persona&apos;s voice, and language
              when one is set. Reflects the voice and speed; the dB trim is
              applied later, on air.
            </>}
          />
        </div>

        <div className="field mt-3.5 max-w-[360px] lg:mt-0 lg:max-w-[460px]">
          <div className="flex items-baseline justify-between gap-3">
            <Label>Voice level (dB)</Label>
            <span className="font-mono text-[15px] font-extrabold text-[var(--accent)] tabular-nums">{gainLabel}</span>
          </div>
          <VoiceMeter
            value={gain}
            onChange={v => updateTts({ gainDb: v })}
          />
          <div className="mt-1.5 flex justify-between text-[8px] font-bold tracking-[0.1em] text-muted tabular-nums">
            <span>−12 dB</span>
            <span className="-translate-x-1/2">0</span>
            <span>+12 dB</span>
          </div>
          <div className="field-hint">
            Trim this persona’s loudness on top of the engine level. <code>0 dB</code> = no change.
            Drag the meter or use the arrow keys.
          </div>

          <div className="field mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <Label>Speech speed</Label>
              <span className="font-mono text-[15px] font-extrabold text-[var(--accent)] tabular-nums">{speed.toFixed(2)}×</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={speed}
              disabled={!speedSupported}
              onChange={(e: ChangeEvent<HTMLInputElement>) => updateTts({ speed: Number(e.target.value) })}
              aria-label="Speech speed multiplier"
              className={cn(
                'mt-1.5 w-full accent-[var(--accent)]',
                !speedSupported && 'opacity-40',
              )}
            />
            <div className="mt-1.5 flex justify-between text-[8px] font-bold tracking-[0.1em] text-muted tabular-nums">
              <span>0.5× slower</span>
              <span className="-translate-x-1/2">1.0×</span>
              <span>2.0× faster</span>
            </div>
            <div className="field-hint">
              {speedSupported
                ? <>Slow down or speed up this persona on top of the engine pace. <code>1.00×</code> = no change.</>
                : <>Not supported by this engine; only Piper, Kokoro and cloud honour speed.</>}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
