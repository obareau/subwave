'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { fmtClock } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Card, Btn, Pill, Eyebrow } from './ui';
import { ScrollArea } from '../ui/scroll-area';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Terminal, TerminalContent } from '../ai-elements/terminal';
import { BudgetMeter } from './debug/BudgetMeter';
import { DjContext } from './debug/DjContext';
import { FilesTable } from './debug/FilesTable';
import { LlmCalls } from './debug/LlmCalls';
import { MountsTable } from './debug/MountsTable';
import { SessionChat } from './debug/SessionChat';
import { SubsonicCalls } from './debug/SubsonicCalls';
import { TtsRouting } from './debug/TtsPanels';
import { HealthCell, KvTable } from './debug/bits';
import { fmtListeners, kindTone } from './debug/format';
import type { DebugData } from './debug/types';

export default function DebugPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<DebugData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      // Single-flight: /debug can take seconds, and overlapping requests pile up
      // on the single-threaded controller, starving /api/* into edge 524s.
      if (cancelled || running) return;
      running = true;
      try {
        // Skip the fetch when paused or hidden, but keep the loop alive.
        if (!paused && !(typeof document !== 'undefined' && document.hidden)) {
          const r = await adminFetch('/debug');
          if (r.status === 401) {
            if (!cancelled) setData(null);
          } else {
            const j = (await r.json()) as DebugData;
            if (!cancelled) {
              if (!j || typeof j !== 'object' || !j.queue) {
                setErr(j?.error || 'unexpected response shape from /debug');
                setData(null);
              } else {
                setData(j);
                setErr(null);
              }
            }
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
        // Gap measured from completion, not from start, so no overlap is possible.
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };
    tick();
    const onVisible = () => {
      if (!cancelled && !document.hidden) {
        if (timer) { clearTimeout(timer); timer = null; }
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [paused, needsAuth, hydrated, adminFetch]);

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="flex flex-wrap items-center gap-4 border-b border-ink p-3.5">
          <Eyebrow className={err ? 'text-[var(--danger)]' : 'text-vermilion'}>
            ● {err ? 'down' : 'live'}
          </Eyebrow>
          <span className="caption">refresh · 2s</span>
          {data?.llm?.budget?.enabled ? <BudgetMeter budget={data.llm.budget} /> : null}
          <span className="ml-auto flex gap-2">
            <Btn sm onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
          </span>
        </div>
        <div className="strip-mobile grid grid-cols-5">
          <HealthCell
            label="Icecast"
            status={data?.icecast && !data.icecast.error ? 'ok' : err ? 'down' : 'idle'}
            v={fmtListeners(data?.icecast)}
            sub={data?.icecast?.peakListeners != null ? `peak ${data.icecast.peakListeners}` : '—'}
          />
          <HealthCell
            label="Liquidsoap"
            status={data?.liquidsoapLog ? 'ok' : err ? 'down' : 'idle'}
            v={data?.liquidsoapLog ? 'up' : '—'}
            sub="log last 100"
          />
          <HealthCell
            label="LLM"
            status={data?.llm ? 'ok' : 'idle'}
            v={data?.llm?.activeModel || '—'}
            sub={data?.llm?.provider ? `provider ${data.llm.provider}` : '—'}
          />
          <HealthCell
            label="Picker"
            status={data?.queue?.current ? 'ok' : 'idle'}
            v={data?.queue?.current ? 'request' : 'auto-playlist'}
            sub={`upcoming ${data?.queue?.upcoming?.length ?? 0}`}
          />
          <HealthCell
            label="Tagger"
            status={data?.library?.total ? 'ok' : 'off'}
            v={data?.library?.total ? `${data.library.total} tracks` : '—'}
            sub={data?.library?.updatedAt ? new Date(data.library.updatedAt).toLocaleDateString('en-GB') : 'not tagged'}
          />
        </div>
      </section>

      {err && <ErrorState error={err} />}

      {!data && !err && (
        <Card title="Debug">
          <SkeletonRows rows={6} />
        </Card>
      )}

      {data && (
        <>
          <div className="stack-mobile grid grid-cols-3 gap-4">
            <Card
              title="Now playing"
              headClass="flex-nowrap"
              sub={
                <span className="text-[9px] tracking-[0.08em] normal-case">
                  now-playing.json
                </span>
              }
            >
              <ScrollArea className="max-h-80">
                <KvTable obj={data.nowPlaying} />
              </ScrollArea>
            </Card>

            <Card title="Icecast">
              <ScrollArea className="max-h-80">
                <KvTable obj={data.icecast as unknown as Record<string, unknown>} />
              </ScrollArea>
            </Card>

            <Card title="DJ context">
              <ScrollArea className="max-h-[200px]">
                <DjContext ctx={data.context} />
              </ScrollArea>
            </Card>
          </div>

          <Card title="Config" sub="redacted · listen mounts">
            <ScrollArea className="max-h-[480px]">
              <KvTable obj={data.config} />
              <MountsTable mounts={data.mounts} />
            </ScrollArea>
          </Card>

          {data.tts && !data.tts.error && (
            <Card
              title="TTS routing"
              sub={`who voices the next spoken segment · ${data.tts.recentCalls?.length ?? 0} recent calls`}
            >
              <TtsRouting tts={data.tts} />
            </Card>
          )}

          <LlmCalls llm={data.llm} />

          <SubsonicCalls subsonic={data.subsonic} />

          <Card
            title="Liquidsoap log"
            sub="last 100 lines"
            className="flex h-[440px] flex-col"
            bodyClass="flex flex-1 flex-col min-h-0"
            right={
              <Label className="flex min-h-9 cursor-pointer items-center gap-1.5 text-[10px] tracking-[0.18em] text-muted uppercase sm:min-h-0">
                <Checkbox
                  checked={autoScroll}
                  onCheckedChange={v => setAutoScroll(v === true)}
                />
                auto-scroll
              </Label>
            }
          >
            <Terminal
              output={data.liquidsoapLog || '— no log —'}
              autoScroll={autoScroll}
              className="min-h-0 flex-1 rounded-none border-separator-strong"
            >
              <TerminalContent className="max-h-none min-h-0 flex-1 p-2.5 text-[11px] leading-[1.6]" />
            </Terminal>
          </Card>

          <div className="stack-mobile grid grid-cols-2 gap-4">
            <Card title="State dir" sub="/var/sub-wave">
              <ScrollArea className="max-h-80">
                <FilesTable files={data.stateFiles} />
              </ScrollArea>
            </Card>

            <Card
              title="DJ voice WAVs"
              sub={`${Array.isArray(data.voiceFiles) ? data.voiceFiles.length : 0} files`}
            >
              <ScrollArea className="max-h-80">
                <FilesTable files={data.voiceFiles} />
              </ScrollArea>
            </Card>
          </div>

          <div className="stack-mobile grid grid-cols-[1fr_1.2fr] gap-4">
            <Card title="Queue" sub="current served request">
              {data.queue?.current ? (
                <KvTable obj={data.queue.current} />
              ) : (
                <span className="field-hint italic">none (auto-playlist)</span>
              )}
            </Card>

            <Card title="Upcoming queue" sub={`${data.queue?.upcoming?.length ?? 0} tracks`}>
              {(data.queue?.upcoming?.length ?? 0) === 0 ? (
                <span className="field-hint italic">queue empty</span>
              ) : (
                <ScrollArea className="max-h-80">
                  {data.queue?.upcoming?.map((t, i) => (
                    <div key={i} className="track-row grid grid-cols-[24px_1fr_auto]">
                      <span className="idx">{i + 1}</span>
                      <span className="title">
                        {t.title} <span className="artist">— {t.artist}</span>
                      </span>
                      {t.requestedBy ? (
                        <Pill tone="accent">↳ {t.requestedBy}</Pill>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))}
                </ScrollArea>
              )}
            </Card>
          </div>

          {data.session && !data.session.error && (
            <Card
              title="DJ session"
              sub={
                `${data.session.kind}` +
                (data.session.show ? ` · ${data.session.show.name}` : '') +
                (data.session.persona ? ` · ${data.session.persona.name}` : '') +
                ` · ${data.session.messages?.length ?? 0} turns`
              }
            >
              <SessionChat session={data.session} />
            </Card>
          )}

          <Card title="DJ log" sub={`${data.queue?.djLogCount} total · last 30${data.timezone ? ` · times in ${data.timezone}` : ''}`}>
            <ScrollArea className="max-h-72">
              <div className="grid gap-1">
                <AnimatePresence initial={false} mode="popLayout">
                  {(data.queue?.djLog || []).map(e => (
                    <m.div
                      key={e.id}
                      layout
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
                      className={`log ${kindTone(e.kind)}`}
                    >
                      <span className="t">
                        {fmtClock(e.t, data.timezone, data.locale) || '—'}
                      </span>
                      <span className="k">[{e.kind}]</span>
                      <span className="msg">{e.message}</span>
                    </m.div>
                  ))}
                </AnimatePresence>
              </div>
            </ScrollArea>
          </Card>
        </>
      )}
    </div>
  );
}
