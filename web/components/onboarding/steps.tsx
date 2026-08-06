'use client';

import { useState } from 'react';
import type { WizardController } from './useWizard';
import { ProviderSelector } from '../admin/llm/ProviderSelector';
import { ModelCombobox } from '../admin/llm/ModelCombobox';
import { PROVIDER_IDS } from '../admin/llm/providerMeta';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { LocationPicker } from '../LocationPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { V3Alert } from '@/components/ui/alert';

// Presentation primitives kept local to the wizard, so a screen most operators
// see once doesn't drag in the full admin UI library. Labels, fills and borders
// ride the theme tokens.

// Shared by <Field> and the inline label rows that can't wrap their control in
// a <label>.
const WIZARD_LABEL_CLASS =
  'font-mono text-[11px] font-bold tracking-[0.18em] text-ink uppercase';

function StepHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mb-5">
      <h2 className="font-display text-xl font-bold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-muted">{blurb}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={WIZARD_LABEL_CLASS}>{label}</span>
      {children}
      {hint ? <span className="font-mono text-[12px] text-muted">{hint}</span> : null}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <Input {...props} />;
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={
        'border border-input bg-field px-3 py-[9px] text-[13px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
        (props.className || '')
      }
    />
  );
}

function TestPill({ result }: { result: { ok: boolean | null; msg?: string } }) {
  if (result.ok === null) return null;
  return (
    <div
      role="status"
      className={
        'mt-2 inline-block border px-2 py-0.5 font-mono text-xs ' +
        (result.ok
          ? 'border-ink bg-accent-soft text-ink'
          : 'border-destructive text-destructive')
      }
    >
      {result.ok ? '✓ ' : '✗ '}
      {result.msg || (result.ok ? 'connection ok' : 'connection failed')}
    </div>
  );
}

// NAVIDROME
export function NavidromeStep({ w }: { w: WizardController }) {
  const [busy, setBusy] = useState(false);
  const onTest = async () => {
    setBusy(true);
    // testNavidrome catches its own errors into the pill; the finally is the
    // backstop so the button can't wedge on "Testing…" (issue #682).
    try {
      await w.testNavidrome();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <StepHeader
        title="Connect Navidrome"
        blurb="SUB/WAVE plays from your Subsonic-compatible music library. Point it at your Navidrome and the AI DJ takes over."
      />
      <div className="grid gap-3">
        <Field label="Navidrome URL" hint="e.g. http://host.docker.internal:4533">
          <TextInput
            value={w.data.navidrome.url}
            placeholder="http://host.docker.internal:4533"
            onChange={e =>
              w.patch(d => ({ navidrome: { ...d.navidrome, url: e.target.value }, navidromeTest: { ok: null } }))
            }
          />
        </Field>
        <Field
          label="Username"
          hint="tip: a dedicated Navidrome user that can only access the libraries you want on air keeps audiobooks and seasonal collections off the stream"
        >
          <TextInput
            value={w.data.navidrome.user}
            autoComplete="username"
            onChange={e =>
              w.patch(d => ({ navidrome: { ...d.navidrome, user: e.target.value }, navidromeTest: { ok: null } }))
            }
          />
        </Field>
        <Field label="Password">
          <TextInput
            type="password"
            value={w.data.navidrome.pass}
            autoComplete="current-password"
            onChange={e =>
              w.patch(d => ({ navidrome: { ...d.navidrome, pass: e.target.value }, navidromeTest: { ok: null } }))
            }
          />
        </Field>
        <div>
          <Button
            variant="solid"
            onClick={onTest}
            disabled={busy || !w.data.navidrome.url || !w.data.navidrome.user || !w.data.navidrome.pass}
          >
            {busy ? 'Testing…' : 'Test connection'}
          </Button>
          <TestPill result={w.data.navidromeTest} />
        </div>
        <V3Alert title="Music licensing">
          Owning these files covers your own private listening, not{' '}
          <em>public</em> broadcast. If anyone but you can hear the stream,
          you&apos;re publicly performing copyrighted works and need the
          relevant licences (PRS&nbsp;+&nbsp;PPL in the UK,
          ASCAP/BMI&nbsp;+&nbsp;SoundExchange in the US) — or broadcast only
          content you&apos;re cleared to use (your own, Creative Commons,
          royalty-free, public domain). You are the broadcaster and are
          responsible for clearing these rights. Not legal advice.
        </V3Alert>
      </div>
    </div>
  );
}

// LLM. Provider list, labels and blurbs come from admin/llm/providerMeta so
// onboarding and the admin Settings tab never drift.

export function LlmStep({ w }: { w: WizardController }) {
  const [busy, setBusy] = useState(false);
  const isOllama = w.data.llm.provider === 'ollama';
  const isLocca = w.data.llm.provider === 'locca';
  const isCustom = w.data.llm.provider === 'openai-compatible';
  const onTest = async () => {
    setBusy(true);
    try {
      await w.testLlm();
    } finally {
      setBusy(false);
    }
  };
  // Enabled for the keyless-discoverable providers; cloud providers need their
  // key saved on the box first, so they fall back to free-typing the model id.
  const discoveryEnabled =
    isOllama || isLocca ||
    (isCustom && !!w.data.llm.baseUrl.trim()) ||
    w.data.llm.provider === 'openrouter';
  const discovery = useModelDiscovery({
    provider: w.data.llm.provider,
    baseUrl: w.data.llm.baseUrl,
    ollamaUrl: w.data.llm.ollamaUrl,
    enabled: discoveryEnabled,
    adminFetch: w.auth.adminFetch,
  });
  return (
    <div>
      <StepHeader
        title="Pick a language model"
        blurb="The DJ talks between tracks. Ollama running on the host is the homelab default — no API key needed."
      />
      <div className="grid gap-3">
        {/* Not <Field>: it renders a <label>, and a label around a radiogroup of
            buttons hijacks clicks. */}
        <div className="flex flex-col gap-1">
          <span className={WIZARD_LABEL_CLASS}>Provider</span>
          <ProviderSelector
            value={w.data.llm.provider}
            providerIds={PROVIDER_IDS}
            keyAware={false}
            onChange={id =>
              w.patch(d => ({ llm: { ...d.llm, provider: id }, llmTest: { ok: null } }))
            }
          />
        </div>
        {isOllama && (
          <Field label="Ollama URL" hint="Reachable from the controller container">
            <TextInput
              value={w.data.llm.ollamaUrl}
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, ollamaUrl: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {isCustom && (
          <Field label="Base URL" hint="e.g. http://localhost:8080/v1 (llama.cpp / vLLM / LM Studio)">
            <TextInput
              value={w.data.llm.baseUrl}
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, baseUrl: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {isLocca && (
          <Field
            label="Base URL"
            hint="Blank → http://host.docker.internal:8080/v1 (the locca server on the host)"
          >
            <TextInput
              value={w.data.llm.baseUrl}
              placeholder="http://host.docker.internal:8080/v1"
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, baseUrl: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {!isOllama && !isLocca && (
          <Field label="API key" hint="Stored in state/secrets.env (mode 0600), not in settings.json">
            <TextInput
              type="password"
              autoComplete="off"
              value={w.data.llm.apiKey}
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, apiKey: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {/* Not <Field>: the combobox trigger is a <button>, and a wrapping
            <label> would hijack the click. */}
        <div className="flex flex-col gap-1">
          <span className={WIZARD_LABEL_CLASS}>Model</span>
          <div className="flex items-stretch gap-2">
            {discovery.models.length > 0 ? (
              <ModelCombobox
                models={discovery.models}
                value={w.data.llm.model}
                onChange={v => w.patch(d => ({ llm: { ...d.llm, model: v }, llmTest: { ok: null } }))}
                placeholder="Select a model"
              />
            ) : (
              <TextInput
                aria-label="Model"
                value={w.data.llm.model}
                onChange={e => w.patch(d => ({ llm: { ...d.llm, model: e.target.value }, llmTest: { ok: null } }))}
                placeholder={isOllama ? 'glm-5.1:cloud' : (isCustom || isLocca) ? 'model filename or id' : 'e.g. claude-sonnet-4 · gpt-4o-mini'}
                className="max-w-[360px] flex-1"
              />
            )}
            {discovery.loading
              ? <span className="self-center text-xs whitespace-nowrap text-muted">discovering…</span>
              : discoveryEnabled && (
                <button
                  type="button"
                  onClick={discovery.refresh}
                  title="Refresh model list"
                  className="border border-ink px-2.5 text-sm text-ink hover:bg-ink hover:text-bg"
                >↻</button>
              )
            }
          </div>
          <span className="text-xs text-muted">
            {discovery.models.length > 0
              ? `${discovery.models.length} model${discovery.models.length !== 1 ? 's' : ''} discovered — pick one or filter.`
              : discoveryEnabled
                ? (discovery.error
                    ? `Discovery failed: ${discovery.error}. Type a model ID manually.`
                    : discovery.loading
                      ? 'Discovering models…'
                      : 'No models found yet — set the URL above, or type a model ID.')
                : 'Type the model ID. Discovery runs here once the API key is saved.'}
          </span>
        </div>
        <div>
          <Button variant="solid" onClick={onTest} disabled={busy || !w.data.llm.model}>
            {busy ? 'Asking…' : 'Send a test prompt'}
          </Button>
          <TestPill result={w.data.llmTest} />
        </div>
      </div>
    </div>
  );
}

// TTS
export function TtsStep({ w }: { w: WizardController }) {
  const engine = w.data.tts.defaultEngine;
  const heavyPicked = engine === 'chatterbox' || engine === 'pocket-tts';
  const heavyEnabled = w.data.tts.heavyEnabled;
  return (
    <div>
      <StepHeader
        title="Choose a voice engine"
        blurb="Piper is the default — fast, local, decent. Kokoro is slower but more natural. Cloud routes through OpenAI, ElevenLabs, or Fish Audio."
      />
      <div className="grid gap-3">
        <Field label="Default engine">
          <Select
            value={w.data.tts.defaultEngine}
            onChange={e =>
              w.patch(d => ({
                tts: { ...d.tts, defaultEngine: e.target.value as typeof d.tts.defaultEngine },
              }))
            }
          >
            <option value="piper">Piper (fast, local)</option>
            <option value="kokoro">Kokoro (natural, local)</option>
            <option value="cloud">Cloud (OpenAI / ElevenLabs / Fish Audio)</option>
            <option value="chatterbox">Chatterbox (voice cloning, sidecar)</option>
            <option value="pocket-tts">PocketTTS (multilingual, sidecar)</option>
            <option value="remote">Remote (your own server)</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={heavyEnabled}
            onChange={e =>
              w.patch(d => ({ tts: { ...d.tts, heavyEnabled: e.target.checked } }))
            }
          />
          Enable Chatterbox + PocketTTS (tts-heavy sidecar, ~5–6 GB)
        </label>
        {heavyEnabled && (
          <V3Alert title="Heavy TTS enabled">
            The sidecar isn&apos;t started by default. On the machine running
            this stack, either:
            <ul className="mt-2 ml-5 list-disc space-y-1">
              <li>
                Add <code>COMPOSE_PROFILES=tts-heavy</code> to your <code>.env</code>, then run{' '}
                <code>docker compose up -d</code> — this enables it permanently.
              </li>
              <li>
                Or run <code>docker compose --profile tts-heavy up -d</code> for a one-off start.
              </li>
            </ul>
          </V3Alert>
        )}
        {heavyPicked && !heavyEnabled && (
          <V3Alert tone="error" title="Heads up">
            {engine === 'chatterbox' ? 'Chatterbox' : 'PocketTTS'} runs in the
            optional <code>tts-heavy</code> sidecar but you haven&apos;t enabled
            it above — this persona will silently fall back to Piper until the
            sidecar is started.
          </V3Alert>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={w.data.tts.cloud.enabled}
            onChange={e =>
              w.patch(d => ({
                tts: { ...d.tts, cloud: { ...d.tts.cloud, enabled: e.target.checked } },
              }))
            }
          />
          Enable cloud TTS as a fallback
        </label>
        {w.data.tts.cloud.enabled && (
          <>
            <Field label="Cloud TTS provider">
              <Select
                value={w.data.tts.cloud.provider}
                onChange={e => {
                  const provider = e.target.value;
                  w.patch(d => ({
                    tts: {
                      ...d.tts,
                      cloud: {
                        ...d.tts.cloud,
                        provider,
                        // Credentials are provider-specific: never carry a
                        // typed key across a selector change.
                        apiKey: '',
                        ...(provider === 'fish-audio' ? { model: 's2.1-pro', voice: '' } : {}),
                      },
                    },
                  }));
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="elevenlabs">ElevenLabs</option>
                <option value="fish-audio">Fish Audio</option>
              </Select>
            </Field>
            <Field label="API key">
              <TextInput
                type="password"
                autoComplete="off"
                value={w.data.tts.cloud.apiKey}
                onChange={e =>
                  w.patch(d => ({
                    tts: { ...d.tts, cloud: { ...d.tts.cloud, apiKey: e.target.value } },
                  }))
                }
              />
            </Field>
            {w.data.tts.cloud.provider === 'fish-audio' && (
              <>
                <Field label="Fish model id">
                  <TextInput
                    value={w.data.tts.cloud.model}
                    maxLength={100}
                    placeholder="s2.1-pro"
                    onChange={e =>
                      w.patch(d => ({
                        tts: { ...d.tts, cloud: { ...d.tts.cloud, model: e.target.value } },
                      }))
                    }
                  />
                </Field>
                <Field label="Fish voice reference id">
                  <TextInput
                    value={w.data.tts.cloud.voice}
                    maxLength={100}
                    placeholder="Paste an account, public, or custom reference_id"
                    onChange={e =>
                      w.patch(d => ({
                        tts: { ...d.tts, cloud: { ...d.tts.cloud, voice: e.target.value } },
                      }))
                    }
                  />
                </Field>
                <p className="text-xs text-muted">
                  Account voice discovery is available after setup in Admin → Settings → TTS.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// DJ persona
export function DjStep({ w }: { w: WizardController }) {
  return (
    <div>
      <StepHeader
        title="DJ persona"
        blurb="The DJ's voice on air. Name your station and set your location for weather. Personality tuning lives in /admin/settings — keep this step short."
      />
      <div className="grid gap-3">
        <Field label="Station name">
          <TextInput
            value={w.data.dj.stationName}
            onChange={e => w.patch(d => ({ dj: { ...d.dj, stationName: e.target.value } }))}
          />
        </Field>
        {/* Not <Field>: the picker is a composite and can't live inside one
            <label>. */}
        <div className="flex flex-col gap-1">
          <span className={WIZARD_LABEL_CLASS}>Location</span>
          <LocationPicker
            variant="onboarding"
            value={{
              locationName: w.data.dj.locationName,
              lat: w.data.dj.lat,
              lng: w.data.dj.lng,
            }}
            onChange={next => w.patch(d => ({ dj: { ...d.dj, ...next } }))}
            onPick={r => {
              const tz = r.timezone;
              if (tz) w.patch(d => ({ dj: { ...d.dj, timezone: tz } }));
            }}
          />
          <span className="text-xs text-muted">
            Search a city — coordinates and timezone fill in automatically. Used for weather +
            “broadcasting from…” prompts.
          </span>
          {w.data.dj.timezone ? (
            <span className="text-xs text-muted">
              Timezone: {w.data.dj.timezone} (from your location)
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// REVIEW + SAVE
export function ReviewStep({
  w,
  onDone,
}: {
  w: WizardController;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onSave = async () => {
    setBusy(true);
    setErr(null);
    const r = await w.save();
    if (r.ok) {
      onDone();
    } else {
      setErr(r.error || 'save failed');
      setBusy(false);
    }
  };
  const rows: Array<[string, string]> = [
    ['Navidrome', w.data.navidrome.url ? `${w.data.navidrome.user} @ ${w.data.navidrome.url}` : '— skipped —'],
    ['LLM', `${w.data.llm.provider} · ${w.data.llm.model}`],
    ['TTS', w.data.tts.defaultEngine + (w.data.tts.cloud.enabled ? ` (+ ${w.data.tts.cloud.provider})` : '')],
    ['Station', `${w.data.dj.stationName} — ${w.data.dj.locationName}`],
  ];
  return (
    <div>
      <StepHeader
        title="All set?"
        blurb="Review and save. Settings land in state/settings.json + state/setup-config.json; API keys land in state/secrets.env (mode 0600)."
      />
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {err && <p role="alert" className="mt-3 text-sm text-destructive">{err}</p>}
      <Button variant="solid" size="lg" className="mt-5" onClick={onSave} disabled={busy}>
        {busy ? 'Saving…' : 'Save and finish'}
      </Button>
    </div>
  );
}
