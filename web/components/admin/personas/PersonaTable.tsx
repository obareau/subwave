'use client';

// The "list" half of the cards/list toggle on /admin/personas. Same contract as
// the slate cards: the row opens the editor, and the spine carries the same status
// colour.

import { useMemo } from 'react';
import type { Persona } from './types';
import { API_BASE } from './constants';
import { initialsFor } from './helpers';
import { Pill, MetaChip } from '../ui';
import { RosterTable } from '../RosterTable';
import type { RosterColumn } from '../RosterTable';
import { RosterAvatar } from '../RosterAvatar';

interface PersonaTableProps {
  personas: Persona[];
  // The admin-selected default — gets the "default" pill.
  activePersonaId: string;
  // The persona actually broadcasting now (show override aware).
  onAirPersonaId: string;
  // Cache-buster bumped on avatar upload/delete.
  avatarTick: number;
  // Sourced from the RHF form's own formState.errors.personas.
  isPersonaInvalid: (idx: number) => boolean;
  onSelect: (idx: number) => void;
}

// The roster is index-keyed (onSelect(i)), so the row carries its position.
interface PersonaRow {
  persona: Persona;
  index: number;
}

export function PersonaTable({
  personas, activePersonaId, onAirPersonaId, avatarTick, isPersonaInvalid, onSelect,
}: PersonaTableProps) {
  const rows = useMemo<PersonaRow[]>(
    () => personas.map((persona, index) => ({ persona, index })),
    [personas],
  );

  const cols = useMemo<RosterColumn<PersonaRow>[]>(() => [
    {
      key: 'face',
      label: '',
      className: 'w-10',
      render: ({ persona: p }) => (
        <RosterAvatar
          src={p.avatar ? `${API_BASE}/persona-avatar/${encodeURIComponent(p.id)}?v=${avatarTick}` : null}
          initials={initialsFor(p.name)}
        />
      ),
    },
    {
      key: 'name',
      label: 'DJ',
      className: 'whitespace-nowrap',
      render: ({ persona: p, index }) => {
        const isOnAir = p.id === onAirPersonaId;
        const isDefault = p.id === activePersonaId;
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-extrabold text-ink">
              {p.name.trim() || `Persona ${index + 1}`}
            </span>
            {isOnAir && <Pill tone="accent" dot>on air</Pill>}
            {isDefault && !isOnAir && <Pill>default</Pill>}
          </span>
        );
      },
    },
    {
      key: 'tagline',
      label: 'Tagline',
      // `w-full max-w-0` — see the note in SkillsTable: the pair is what lets
      // the inner span truncate instead of widening the column.
      className: 'hidden lg:table-cell w-full max-w-0',
      render: ({ persona: p }) => (
        <span className="block truncate text-muted italic" title={p.tagline.trim()}>
          {p.tagline.trim() || 'no tagline'}
        </span>
      ),
    },
    {
      key: 'frequency',
      label: 'Frequency',
      className: 'hidden md:table-cell whitespace-nowrap',
      render: ({ persona: p }) => <span className="text-muted">{p.frequency}</span>,
    },
    {
      key: 'voice',
      label: 'Voice',
      className: 'hidden md:table-cell whitespace-nowrap',
      render: ({ persona: p }) => (
        <span className="flex items-center gap-1">
          <MetaChip>{p.tts.engine}</MetaChip>
          {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
            <MetaChip className="max-w-[120px] truncate">{p.tts.voice.trim()}</MetaChip>
          )}
        </span>
      ),
    },
    {
      key: 'skills',
      label: 'Skills',
      align: 'right',
      className: 'whitespace-nowrap',
      render: ({ persona: p }) => (
        <span className="mono-num font-extrabold text-ink">{p.skills.length}</span>
      ),
    },
    {
      key: 'status',
      label: '',
      align: 'right',
      className: 'w-24 whitespace-nowrap',
      render: ({ index }) => (
        isPersonaInvalid(index)
          ? <Pill className="border-[var(--danger)] text-[var(--danger)]">incomplete</Pill>
          : null
      ),
    },
  ], [activePersonaId, onAirPersonaId, avatarTick, isPersonaInvalid]);

  // Same status priority as the card spine.
  const spineFor = ({ persona: p, index }: PersonaRow): string => {
    if (p.id === onAirPersonaId) return 'var(--accent)';
    if (p.id === activePersonaId) return 'var(--ink)';
    if (isPersonaInvalid(index)) return 'var(--danger)';
    return 'var(--separator-strong)';
  };

  return (
    <RosterTable
      caption="DJ roster"
      cols={cols}
      rows={rows}
      rowKey={r => r.persona.id}
      rowLabel={r => `Edit ${r.persona.name.trim() || `Persona ${r.index + 1}`}`}
      rowSpine={spineFor}
      onRowClick={r => onSelect(r.index)}
    />
  );
}

export default PersonaTable;
