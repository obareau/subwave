'use client';
// Full-screen editor for the focused persona. Binds the index-taking mutators down
// to the focused persona so the cards stay index-agnostic.
import type { RefObject } from 'react';
import type { Persona, PersonaTts, SettingsResponse, SkillCatalogEntry } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { Eyebrow, Pill } from '../ui';
import { cn } from '../../../lib/cn';
import { personaSubmitUrl } from '../../../lib/repo';
import { DIAL_NEUTRAL } from './constants';
import { EditorDialog, EditorFooter } from '../../ui/editor-dialog';
import { PersonaIdentityCard } from './PersonaIdentityCard';
import { PersonaBehaviorCard } from './PersonaBehaviorCard';
import { PersonaVoiceCard } from './PersonaVoiceCard';
import { PersonaSkillsCard } from './PersonaSkillsCard';

interface PersonaEditorProps {
  persona: Persona;
  index: number;
  personaCount: number;
  activePersonaId: string;
  onAirPersonaId: string;
  data: SettingsResponse | null;
  adminFetch: AdminAuth['adminFetch'];
  avatarTick: number;
  uploadingId: string | null;
  defaultEngine: string;
  cloudIssueText: string | null;
  skillCatalog: SkillCatalogEntry[];
  editorRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  isNew: boolean;
  onClose: () => void;
  setPersona: (i: number, patch: Partial<Persona>) => void;
  setPersonaTts: (i: number, patch: Partial<PersonaTts>) => void;
  setPersonaSkills: (i: number, skills: string[]) => void;
  onUploadAvatar: (id: string, file: File) => void;
  onGenerateAvatar: (id: string) => void;
  onClearAvatar: (id: string) => void;
  onSetActive: () => void;
  onRemove: () => void;
  canSave: boolean;
  focusedOk: boolean;
  allPersonasOk: boolean;
  promptOk: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

export function PersonaEditor({
  persona, index, personaCount, activePersonaId, onAirPersonaId, data, adminFetch, avatarTick, uploadingId,
  defaultEngine, cloudIssueText, skillCatalog, editorRef, open, isNew, onClose,
  setPersona, setPersonaTts, setPersonaSkills,
  onUploadAvatar, onGenerateAvatar, onClearAvatar, onSetActive, onRemove,
  canSave, focusedOk, allPersonasOk, promptOk, busy, onSave, onDiscard,
}: PersonaEditorProps) {
  const update = (patch: Partial<Persona>) => setPersona(index, patch);
  const updateTts = (patch: Partial<PersonaTts>) => setPersonaTts(index, patch);
  const setSkills = (skills: string[]) => setPersonaSkills(index, skills);

  // Opens the prefilled add-persona Issue Form on GitHub. Only the portable fields
  // travel — voice and avatar stay station-side.
  const shareToCommunity = () => {
    const slug = persona.name.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 49);
    const url = personaSubmitUrl({
      'persona-slug': slug,
      'display-name': persona.name.trim(),
      tagline: persona.tagline.trim(),
      soul: persona.soul.trim(),
      frequency: persona.frequency,
      'script-length': persona.scriptLength,
      'dj-mode': persona.djMode ? 'on' : '',
      humour: persona.humour !== DIAL_NEUTRAL ? String(persona.humour) : '',
      'local-colour': persona.localColour !== DIAL_NEUTRAL ? String(persona.localColour) : '',
      warmth: persona.warmth !== DIAL_NEUTRAL ? String(persona.warmth) : '',
      language: persona.language.trim(),
    });
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <EditorDialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<Eyebrow className="text-vermilion">{isNew ? 'New persona' : 'Edit persona'}</Eyebrow>}
      sub={(
        // The dialog header holds `sub` in a flex-none cell, so `truncate` needs a
        // width to bite: capped on phones (a 40-char name would push the close
        // button off the edge), unbounded on desktop.
        <span className="caption block max-w-[42vw] truncate sm:max-w-none">
          {persona.name.trim() || `Persona ${index + 1}`} · {index + 1} of {personaCount}
        </span>
      )}
      footer={
        <EditorFooter
          status={(
            <>
              <span
                className={cn(
                  'size-1.5 flex-none rounded-full',
                  canSave ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
                )}
              />
              <span className="min-w-0">
                {!canSave && !focusedOk
                  ? <span className="text-[var(--danger)]">this persona has a missing or invalid field</span>
                  : !canSave && !allPersonasOk
                    ? <span className="text-[var(--danger)]">another persona in the roster is incomplete</span>
                    : !canSave && !promptOk
                      ? <span className="text-[var(--danger)]">fix the system-prompt library</span>
                      : 'changes apply on the next spoken line · no mixer restart'}
              </span>
              {/* Standing state, not an action — rides the status row so the
                  transport stays a row of verbs. */}
              {persona.id === onAirPersonaId && <Pill tone="accent" className="text-[8px]">on air</Pill>}
              {persona.id === activePersonaId && <Pill className="text-[8px]">default</Pill>}
            </>
          )}
          actions={[
            {
              id: 'default',
              label: 'Set as default',
              onClick: onSetActive,
              hidden: persona.id === activePersonaId,
            },
            {
              id: 'remove',
              label: 'Remove',
              tone: 'danger',
              onClick: onRemove,
              disabled: personaCount <= 1,
              title: personaCount > 1 ? 'Remove this persona' : 'At least one persona is required',
            },
            {
              id: 'share',
              label: 'Share to community',
              onClick: shareToCommunity,
              disabled: !persona.name.trim() || !persona.soul.trim(),
              title: 'Open a prefilled GitHub form to share this persona with every station (voice and avatar stay yours)',
            },
          ]}
          primary={[
            { id: 'discard', label: 'Discard', onClick: onDiscard, disabled: busy },
            {
              id: 'save',
              label: busy ? 'Saving…' : 'Save persona',
              tone: 'accent',
              onClick: onSave,
              disabled: busy || !canSave,
            },
          ]}
        />
      }
    >
      <div ref={editorRef} className="grid">
        <PersonaIdentityCard
          persona={persona}
          isNew={isNew}
          adminFetch={adminFetch}
          avatarTick={avatarTick}
          uploading={uploadingId === persona.id}
          update={update}
          onPickAvatar={(file) => onUploadAvatar(persona.id, file)}
          onGenerateAvatar={() => onGenerateAvatar(persona.id)}
          onClearAvatar={() => onClearAvatar(persona.id)}
        />

        <PersonaBehaviorCard persona={persona} update={update} />

        <PersonaVoiceCard
          persona={persona}
          data={data}
          defaultEngine={defaultEngine}
          cloudIssueText={cloudIssueText}
          adminFetch={adminFetch}
          updateTts={updateTts}
        />

        <PersonaSkillsCard persona={persona} skillCatalog={skillCatalog} setSkills={setSkills} />
      </div>
    </EditorDialog>
  );
}
