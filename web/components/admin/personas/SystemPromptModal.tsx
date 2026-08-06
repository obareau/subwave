'use client';
// The global system-prompt library: templates shared by every persona, one active
// at a time ('' = the built-in default). Two views — the library list and a single
// template's editor. Form data lives in the container; this holds only which view
// is showing.
import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Btn, Pill } from '../ui';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Modal } from '../../ui/modal';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { cn } from '../../../lib/cn';
import type { DjPromptPreset } from './types';
import { promptPresetValid, clientMintId } from './helpers';
import { HOUSE_RULES_MAX, PROMPT_MIN, PROMPT_MAX, PROMPT_NAME_MAX, PROMPT_PRESET_MAX } from './constants';

interface SystemPromptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: DjPromptPreset[];
  activeId: string;        // '' = built-in default
  // Station house rules — the one block appended to EVERY spoken-output
  // prompt, including the agent paths the template never reaches (#1182).
  houseRules: string;
  onHouseRulesChange: (v: string) => void;
  defaultPrompt: string;   // the built-in template text
  busy: boolean;
  // Save is shared with the persona editor (both POST the whole form), so `canSave`
  // carries the same roster-wide gate; `allPersonasOk` says when the block is
  // something other than the prompts.
  canSave: boolean;
  allPersonasOk: boolean;
  promptsOk: boolean;      // every preset in the library is valid
  onSetActive: (id: string) => void;
  onAddPreset: (preset: DjPromptPreset) => void;
  onPatchPreset: (id: string, patch: Partial<Pick<DjPromptPreset, 'name' | 'text'>>) => void;
  onRemovePreset: (id: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function SystemPromptModal({
  open, onOpenChange,
  presets, activeId, houseRules, onHouseRulesChange, defaultPrompt,
  busy, canSave, allPersonasOk, promptsOk,
  onSetActive, onAddPreset, onPatchPreset, onRemovePreset, onSave, onDiscard,
}: SystemPromptModalProps) {
  // null = the library list, 'default' = the read-only built-in, else a preset id.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Re-opening always lands on the library list, never a stale editor.
  useEffect(() => {
    if (!open) { setEditing(null); setConfirmDeleteId(null); }
  }, [open]);

  const addPreset = () => {
    if (presets.length >= PROMPT_PRESET_MAX) return;
    // Seed from the built-in template rather than a blank textarea.
    const preset: DjPromptPreset = {
      id: clientMintId('dp_'),
      name: `Prompt ${presets.length + 1}`,
      text: defaultPrompt,
    };
    onAddPreset(preset);
    setEditing(preset.id);
  };

  const editingPreset = editing && editing !== 'default'
    ? presets.find(p => p.id === editing) ?? null
    : null;
  const editingText = editingPreset ? editingPreset.text.trim() : '';
  const editingNameOk = !editingPreset
    || (editingPreset.name.trim().length >= 1 && editingPreset.name.trim().length <= PROMPT_NAME_MAX);
  const editingTextOk = !editingPreset
    || (editingText.length >= PROMPT_MIN && editingText.length <= PROMPT_MAX && editingText.includes('{name}'));
  const deleting = confirmDeleteId ? presets.find(p => p.id === confirmDeleteId) : null;

  const row = (opts: {
    key: string;
    name: string;
    meta: string;
    isActive: boolean;
    invalid?: boolean;
    onUse: () => void;
    actions: ReactNode;
  }) => (
    <div
      key={opts.key}
      className={cn(
        // Phones drop the actions onto a second row: radio + name + two buttons
        // can't share a ~320px line without clipping the name.
        'grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5 border p-2.5',
        'sm:grid-cols-[auto_1fr_auto] sm:gap-3',
        opts.invalid ? 'border-[var(--danger)]' : opts.isActive ? 'border-ink' : 'border-ink/40',
      )}
    >
      <button
        type="button"
        aria-label={opts.isActive ? `${opts.name} is in use` : `Use ${opts.name}`}
        onClick={opts.onUse}
        disabled={opts.isActive}
        className={cn(
          'v3-focus relative grid size-4 flex-none place-items-center rounded-full border border-ink bg-transparent p-0',
          // Invisible 36px hit box on phones: the 16px dot is too small for a thumb.
          "before:absolute before:-inset-2.5 before:content-[''] sm:before:content-none",
          opts.isActive ? 'cursor-default' : 'cursor-pointer hover:border-[var(--accent)]',
        )}
      >
        {opts.isActive && <span className="size-2 rounded-full bg-[var(--accent)]" />}
      </button>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-extrabold">{opts.name}</span>
          {opts.isActive && <Pill tone="accent" dot className="flex-none text-[8px]">in use</Pill>}
          {opts.invalid && <Pill className="flex-none text-[8px] text-[var(--danger)]">incomplete</Pill>}
        </div>
        <div className="caption mt-0.5">{opts.meta}</div>
      </div>
      <div className="col-span-2 flex flex-none flex-wrap items-center justify-end gap-2 sm:col-span-1 sm:justify-start">
        {opts.actions}
      </div>
    </div>
  );

  // Both footers own a full-width wrapping row rather than sitting as bare children
  // of the modal's non-wrapping footer flex: on a phone the status line plus two
  // buttons has to break onto two lines.
  const libraryFooter = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <span
        className={cn(
          'size-1.5 flex-none rounded-full',
          canSave ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
        )}
      />
      <span className="mr-auto min-w-0 text-[11px] text-muted">
        {!canSave && !promptsOk
          ? <span className="text-[var(--danger)]">fix the incomplete prompt template</span>
          : !canSave && !allPersonasOk
            ? <span className="text-[var(--danger)]">a persona in the roster is incomplete — fix it before saving</span>
            : 'changes apply on the next spoken line · no mixer restart'}
      </span>
      <Btn className="min-h-9 sm:min-h-0" onClick={onDiscard} disabled={busy}>Discard</Btn>
      <Btn className="min-h-9 sm:min-h-0" tone="accent" onClick={onSave} disabled={busy || !canSave}>
        {busy ? 'Saving…' : 'Save system prompt'}
      </Btn>
    </div>
  );
  const editorFooter = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {editingPreset && (
        <span className={cn('caption mr-auto min-w-0', editingTextOk && editingNameOk ? 'text-muted' : 'text-[var(--danger)]')}>
          {editingText.length}/{PROMPT_MAX} chars
          {!editingNameOk && ' · name required'}
          {!editingText.includes('{name}') && ' · missing {name}'}
          {editingText.length > 0 && editingText.length < PROMPT_MIN && ` · min ${PROMPT_MIN}`}
        </span>
      )}
      <Btn className="min-h-9 sm:min-h-0" onClick={() => setEditing(null)}>Back to library</Btn>
    </div>
  );

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={
          editing === null ? 'system prompt'
            : editing === 'default' ? 'built-in default'
              : 'edit prompt'
        }
        sub={
          editing === null ? 'template library — shared by every persona'
            : editing === 'default' ? 'read-only — New prompt starts from this text'
              : editingPreset?.name.trim() || undefined
        }
        width={720}
        footer={editing === null ? libraryFooter : editorFooter}
      >
        {editing === null ? (
          <>
            <p className="mb-3 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
              One template wraps the DJ&rsquo;s scripted talk (intros, links, idents, time
              checks, programme beats), shared by all personas. The tool-using agents (track
              picker, requests, skill segments) use each persona&rsquo;s name and soul directly
              instead — only the house rules below reach those too. Keep several saved and
              switch between them. Placeholders:{' '}
              <code>{'{name}'}</code> · <code>{'{soul}'}</code> · <code>{'{station}'}</code> ·{' '}
              <code>{'{location}'}</code> · <code>{'{language}'}</code>. <code>{'{location}'}</code> is the
              station&rsquo;s on-air location, not the weather coordinates; drop it if you never
              want the DJ to name a place. Most stations stay on the built-in default.
            </p>
            <div className="grid gap-2">
              {row({
                key: 'default',
                name: 'Built-in default',
                meta: 'ships with SUB/WAVE · read-only',
                isActive: activeId === '',
                onUse: () => onSetActive(''),
                actions: <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setEditing('default')}>View</Btn>,
              })}
              {presets.map(p =>
                row({
                  key: p.id,
                  name: p.name.trim() || '(unnamed)',
                  meta: `${p.text.trim().length} chars`,
                  isActive: activeId === p.id,
                  invalid: !promptPresetValid(p),
                  onUse: () => onSetActive(p.id),
                  actions: (
                    <>
                      <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setEditing(p.id)}>Edit</Btn>
                      <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setConfirmDeleteId(p.id)} disabled={busy}>Delete</Btn>
                    </>
                  ),
                }),
              )}
            </div>
            <div className="mt-3">
              <Btn
                className="min-h-9 sm:min-h-0"
                onClick={addPreset}
                disabled={busy || presets.length >= PROMPT_PRESET_MAX}
                title={presets.length >= PROMPT_PRESET_MAX ? `The library is full (${PROMPT_PRESET_MAX} templates)` : undefined}
              >
                New prompt
              </Btn>
            </div>

            {/* The one operator block that reaches EVERY spoken line: the scripted
                talk the template wraps AND the tool-using agents it never touches
                (issue #1182). */}
            <div className="mt-5 border-t border-ink/40 pt-4">
              <div className="caption mb-1.5">station house rules</div>
              <p className="mb-2 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
                Appended to <b>everything</b> the DJ speaks — scripted talk and the
                tool-using agents alike, whichever template is active. Use it for rules
                that must never be skipped: TTS control tags, &ldquo;spell out numbers and
                dates in words&rdquo;, language-specific spelling. Leave empty for none.
              </p>
              <Textarea
                rows={5}
                value={houseRules}
                maxLength={HOUSE_RULES_MAX}
                placeholder="e.g. Spell out numbers, dates and units in words — never digits."
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onHouseRulesChange(e.target.value)}
                className="font-mono text-[12px]"
              />
              <div className="caption mt-1 text-muted">
                {houseRules.trim().length}/{HOUSE_RULES_MAX} chars
              </div>
            </div>
          </>
        ) : editing === 'default' ? (
          <pre className="term max-h-[420px]">{defaultPrompt || '(default unavailable)'}</pre>
        ) : editingPreset ? (
          <div className="grid gap-3">
            <div>
              <div className="caption mb-1.5">name</div>
              <Input
                value={editingPreset.name}
                maxLength={PROMPT_NAME_MAX}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onPatchPreset(editingPreset.id, { name: e.target.value })}
                className={cn(!editingNameOk && 'border-[var(--danger)]')}
              />
            </div>
            <div>
              <div className="caption mb-1.5">template</div>
              <Textarea
                rows={16}
                value={editingPreset.text}
                maxLength={PROMPT_MAX}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onPatchPreset(editingPreset.id, { text: e.target.value })}
                className={cn('font-mono text-[12px]', editingTextOk ? 'border-ink' : 'border-[var(--danger)]')}
              />
            </div>
            <div>
              <Btn onClick={() => onPatchPreset(editingPreset.id, { text: defaultPrompt })} disabled={!defaultPrompt}>
                Restore default text
              </Btn>
            </div>
          </div>
        ) : null}
      </Modal>

      <V3AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteId(null); }}
        title="Delete prompt"
        description={
          <>
            Remove <b>{deleting?.name.trim() || 'this prompt'}</b> from the library?
            {confirmDeleteId === activeId && ' The station falls back to the built-in default.'}
            {' '}Nothing is permanent until you Save.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (confirmDeleteId) onRemovePreset(confirmDeleteId);
          setConfirmDeleteId(null);
        }}
      />
    </>
  );
}
