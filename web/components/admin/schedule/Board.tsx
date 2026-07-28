'use client';

// The board — a kanban-style 7-column × 24-hour view of the week, all seven
// days always open. Shows are cards whose height equals their duration; silent
// runs are hatched slots. Direct manipulation everywhere: click a silent slot
// (or drop a shelf chip on it) to book a show over those hours, click a card to
// load its order into the Write-an-order line, drag a card's top or bottom edge
// to move that boundary an hour at a time, click a card's × to take the run
// off the air. Every write is a local edit — Save the week persists.
//
// Two geometry rules earn their keep (#1204):
//
//  * The seven columns divide whatever width the board is given from `sm` up
//    (`sm:w-full` + `sm:min-w-0`) instead of holding a 188px floor. At that
//    floor the board's intrinsic width was 1428px against ~1072px of admin
//    content on a 1280 laptop, so a quarter of the week sat off-screen and the
//    hour gutter — which had been released from `sticky` at `sm` on the
//    assumption the board fits there — scrolled away with it, leaving an
//    unlabelled field of hatched rectangles. Columns that shrink mean no
//    horizontal scroll at all on a laptop, and the gutter now stays pinned at
//    every width for the narrow windows where scroll survives.
//  * The hour unit is a CSS variable (`--hour-px`) set from the density
//    preference, so the gutter's static `h-[var(--hour-px)]` and each card's
//    computed `calc()` height can never drift apart.

import type {
  ComponentPropsWithoutRef, DragEvent, KeyboardEvent, PointerEvent,
} from 'react';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { FoldHorizontal, Rows2, Rows4 } from 'lucide-react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import type { BoardDensity } from '../../../lib/adminView';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { ScrollArea, ScrollBar } from '../../ui/scroll-area';
import { Seg } from '../ui';
import { ColorChip, Mu } from './bits';
import type { Block, Schedule, ScheduleShow } from './lib';
import { DAYS, HOURS, dayBlocks, hh, resizedRun } from './lib';

const DND_TYPE = 'text/x-subwave-show';

function readDraggedShow(e: DragEvent): string {
  return e.dataTransfer.getData(DND_TYPE) || e.dataTransfer.getData('text/plain');
}

export interface BoardProps {
  schedule: Schedule;
  shows: ScheduleShow[];
  folded: Record<number, boolean>;
  onToggleFold: (day: number) => void;
  todayKey: number;
  colorOf: (id: string | null | undefined) => string;
  hoursOf: (id: string) => number;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  /** A card's edge dragged (or arrow-keyed) to new boundaries — the run moves
   *  to [start, end) and the hours it vacates fall silent. */
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
  /** The armed show — the shelf chip acting as a brush, or null. */
  armedShowId: string | null;
  /** Arm/disarm a shelf chip (the same id twice disarms). */
  onArmShow: (id: string) => void;
  /** Bulk writes behind a day header / an hour in the gutter. Only reachable
   *  with a show armed; both toggle off when the target already runs it. */
  onFillDay: (day: number) => void;
  onFillHour: (hour: number) => void;
  density: BoardDensity;
  hourPx: number;
  onDensity: (d: BoardDensity) => void;
}

export default function Board({
  schedule, shows, folded, onToggleFold, todayKey,
  colorOf, hoursOf, onPick, onRemove, onResize, onDropShow,
  armedShowId, onArmShow, onFillDay, onFillHour,
  density, hourPx, onDensity,
}: BoardProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(gridRef, { '--hour-px': `${hourPx}px` });
  const armedName = shows.find(s => s.id === armedShowId)?.name ?? null;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-2 px-5 sm:px-[30px]">
        {/* Two lengths, not one truncated line. The long copy runs to three
            wrapped rows of mono on a phone, and half of what it describes is
            mouse-only: HTML5 drag-and-drop does not fire from a touch, and the
            7px card edges are a poor target for a fingertip. The short copy
            names the gestures a phone can actually perform. */}
        <Mu className="min-w-0 flex-1 tracking-[0.08em] sm:hidden">
          {armedName
            ? `${armedName} is armed — tap an hour to book it, or a day header for the whole day`
            : 'Tap a silent hour to book a show — tap a card to edit its order, its × to take it off the air'}
        </Mu>
        <Mu className="hidden min-w-0 flex-1 tracking-[0.08em] sm:block">
          {armedName
            ? `${armedName} is armed — click any hour to book it, a day header for the whole day, or an hour in the gutter for that hour all week`
            : 'Click a silent hour (or drag a show onto it) to book a show — click a card to edit its order, drag its top or bottom edge to change the hours, its × to take it off the air'}
        </Mu>
        <span className="ml-auto flex flex-none items-center gap-2">
          {/* The label stays: two row icons on their own in the corner of a
              toolbar could as easily be a view switch as a density one, and
              this control is the only thing here that isn't self-evident. */}
          <Mu className="hidden text-[8.5px] sm:inline">Rows</Mu>
          <Seg
            value={density}
            onChange={v => onDensity(v === 'compact' ? 'compact' : 'comfortable')}
            options={[
              // Icon-only, the RosterViewToggle recipe: the glyph carries the
              // meaning (fewer, taller rows vs more, shorter ones), an sr-only
              // span carries the name, and `title` carries the explanation.
              // min-h gives the tab a real tap target on a phone.
              {
                id: 'comfortable',
                title: 'Roomy rows — the full hour range on every card',
                label: (
                  <span className="flex min-h-[22px] items-center sm:min-h-0">
                    <Rows2 size={15} strokeWidth={1.75} aria-hidden />
                    <span className="sr-only">Roomy</span>
                  </span>
                ),
              },
              {
                id: 'compact',
                title: 'Compact rows — a shorter board that clears the fold',
                label: (
                  <span className="flex min-h-[22px] items-center sm:min-h-0">
                    <Rows4 size={15} strokeWidth={1.75} aria-hidden />
                    <span className="sr-only">Compact</span>
                  </span>
                ),
              },
            ]}
          />
        </span>
      </div>

      {/* The shelf — one draggable chip per show, wrapping to as many rows as
          the roster needs. It used to be a single scrolling tray, but a
          sideways slider hides most of the roster past the clipped edge —
          every chip has to be on screen to be dragged or armed. A chip is
          also a brush: click to arm it, then fill hours, days or a whole
          hour-of-the-week from the board without returning here. */}
      <div className="mx-5 mb-3.5 border border-ink bg-[var(--page-bg)] sm:mx-[30px]">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <span className="eyebrow mr-1 flex-none text-ink">The shelf</span>
          {shows.length === 0 && (
            <Mu className="text-[9px] normal-case">
              No shows yet —{' '}
              <Link href="/admin/shows" className="text-vermilion underline">
                define one on the Shows page
              </Link>{' '}
              to start scheduling.
            </Mu>
          )}
          {shows.map(s => {
            const armed = s.id === armedShowId;
            return (
              <button
                key={s.id}
                type="button"
                draggable
                aria-pressed={armed}
                onDragStart={e => {
                  e.dataTransfer.setData(DND_TYPE, s.id);
                  e.dataTransfer.setData('text/plain', s.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onArmShow(s.id)}
                title={armed
                  ? `“${s.name}” is armed — click hours on the board to book it, or click here to put the brush down`
                  : `Click to arm “${s.name}” as a brush, or drag it onto the board`}
                className={cn(
                  'flex min-h-9 flex-none cursor-grab items-center gap-1.5 border px-2.5 py-1.5 active:cursor-grabbing sm:min-h-0',
                  armed
                    ? 'border-ink bg-[var(--ink-soft)] outline-2 -outline-offset-2 outline-[var(--accent)]'
                    : 'border-separator-strong bg-[var(--card-bg)] hover:border-ink',
                )}
              >
                <ColorChip color={colorOf(s.id)} />
                <span className="text-[11.5px] font-semibold whitespace-nowrap text-ink">{s.name}</span>
                <Mu className="text-[8px]">{hoursOf(s.id)}h</Mu>
              </button>
            );
          })}
        </div>
      </div>

      {/* On a phone the week is a horizontal strip and Radix only reveals its
          scrollbar on hover, so name the gesture — and the span — outright.
          From sm up the columns divide the available width, so there is
          nothing to swipe. */}
      <Mu className="mb-1.5 flex items-center gap-1.5 px-5 tracking-[0.08em] sm:hidden">
        <span aria-hidden="true">◂</span>
        Swipe the board — Mon through Sun
        <span aria-hidden="true">▸</span>
      </Mu>

      <ScrollArea>
        <div ref={gridRef} className="flex w-max min-w-full items-start gap-2.5 pb-1.5 sm:w-full">
          {/* Hour gutter — pt clears the 38px column headers (+border+padding).
              Pinned at every width: on a phone the week is a scrolling strip,
              and in a narrow desktop window the columns bottom out and the
              board scrolls too. Either way the hour a card sits on has to stay
              readable, which is exactly what releasing this at `sm` broke. */}
          <div className="sticky left-0 z-10 w-[42px] flex-none bg-[var(--card-bg)] pt-[43px]">
            {HOURS.map(h => (
              // aria-disabled, not disabled: Firefox drops the tooltip (and
              // focus) on a disabled control, and the title is the only
              // in-place explanation of what arming a show unlocks here.
              <button
                key={h}
                type="button"
                aria-disabled={!armedShowId}
                onClick={armedShowId ? () => onFillHour(h) : undefined}
                title={armedName
                  ? `Put “${armedName}” on ${hh(h)}:00 every day (again to clear it)`
                  : `${hh(h)}:00 — arm a show on the shelf to fill this hour all week`}
                className={cn(
                  'flex h-[var(--hour-px)] w-full items-start justify-end border-0 bg-transparent pr-[7px] font-mono text-[9px] font-bold text-muted opacity-80',
                  armedShowId
                    ? 'cursor-pointer hover:text-vermilion hover:opacity-100'
                    : 'cursor-default',
                )}
              >
                {hh(h)}
              </button>
            ))}
          </div>

          {DAYS.map(d =>
            folded[d.key] ? (
              <FoldedRail
                key={d.key}
                label={d.label}
                name={d.name}
                count={dayBlocks(schedule, d.key).filter(b => b.showId).length}
                onClick={() => onToggleFold(d.key)}
              />
            ) : (
              <DayColumn
                key={d.key}
                label={d.label}
                name={d.name}
                today={d.key === todayKey}
                blocks={dayBlocks(schedule, d.key)}
                colorOf={colorOf}
                shows={shows}
                density={density}
                hourPx={hourPx}
                armedShowId={armedShowId}
                armedName={armedName}
                onToggleFold={() => onToggleFold(d.key)}
                onFillDay={() => onFillDay(d.key)}
                onPick={onPick}
                onRemove={onRemove}
                onResize={onResize}
                onDropShow={onDropShow}
              />
            ),
          )}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <Mu className="mt-1 block px-5 tracking-[0.08em] sm:px-[30px]">
        Hatched hours are silent — click one to book a show, or leave the station to run itself
      </Mu>
    </section>
  );
}

function DayColumn({
  label, name, today, blocks, colorOf, shows, density, hourPx, armedShowId, armedName,
  onToggleFold, onFillDay, onPick, onRemove, onResize, onDropShow,
}: {
  label: string;
  name: string;
  today: boolean;
  blocks: Block[];
  colorOf: (id: string | null | undefined) => string;
  shows: ScheduleShow[];
  density: BoardDensity;
  hourPx: number;
  armedShowId: string | null;
  armedName: string | null;
  onToggleFold: () => void;
  onFillDay: () => void;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const showById = (id: string | null) => shows.find(s => s.id === id) ?? null;
  const booked = blocks.reduce((a, b) => a + (b.showId ? b.span : 0), 0);
  return (
    // A phone still gets a fixed-width scrolling strip narrow enough that the
    // next day peeks past the right edge; from sm up `min-w-0` lets the seven
    // columns divide the board's width instead of forcing it past the screen.
    <div className="flex min-w-[164px] flex-1 flex-col border border-ink bg-[var(--page-bg)] sm:min-w-0">
      {/* The header carries two gestures. Its body folds the column — what it
          has always done, and the reason the day names read as handles — until
          a brush is armed, when it fills the whole day instead (the bulk write
          the paint-brush grid had). Same armed/unarmed split the silent slots
          make, and the hint line above the shelf names the armed one.
          The chevron is the constant: it folds in either mode, so an armed
          brush never leaves the column without a collapse control at the top.
          Fold also stays in the footer — this column is 24 hours tall, and
          scrolling ~800px back up to close it is its own annoyance. */}
      <div className="flex h-[38px] items-stretch border-b border-solid border-b-ink">
        <button
          type="button"
          onClick={armedShowId ? onFillDay : onToggleFold}
          title={armedName
            ? `Put “${armedName}” on all of ${name} (again to clear it)`
            : `Fold ${name} out of the way`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 hover:bg-[var(--ink-soft)]"
        >
          <span
            aria-hidden="true"
            className={cn('size-[7px] flex-none rounded-full', today ? 'bg-[var(--accent)]' : 'bg-ink')}
          />
          <span className="font-mono text-[11px] font-bold tracking-[0.16em] text-ink">{label}</span>
          <span className="ml-auto flex h-5 min-w-5 flex-none items-center justify-center border border-ink bg-[var(--card-bg)] px-1 font-mono text-[9px] font-bold text-ink">
            {blocks.filter(b => b.showId).length}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleFold}
          aria-label={`Fold ${name} out of the way`}
          title={`Fold ${name} out of the way`}
          className="flex w-7 flex-none cursor-pointer items-center justify-center border-0 border-l border-solid border-l-separator-strong bg-transparent p-0 text-muted hover:bg-[var(--ink-soft)] hover:text-ink"
        >
          <FoldHorizontal size={13} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-1 p-[5px]">
        {blocks.map(b =>
          b.showId ? (
            <BoardCard
              key={`${b.start}`}
              block={b}
              name={showById(b.showId)?.name ?? 'unknown show'}
              color={colorOf(b.showId)}
              density={density}
              hourPx={hourPx}
              onPick={onPick}
              onRemove={onRemove}
              onResize={onResize}
              onDropShow={onDropShow}
            />
          ) : (
            <DropSlot
              key={`${b.start}`}
              block={b}
              shows={shows}
              colorOf={colorOf}
              armedShowId={armedShowId}
              armedName={armedName}
              onDropShow={onDropShow}
            />
          ),
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-separator-strong px-2.5 py-2">
        <Mu className="text-[8px]">{booked} h booked</Mu>
        {/* min-h-9 on a phone: fold used to be the 38px header, and an 8px
            text label alone is no tap target. */}
        <button
          type="button"
          onClick={onToggleFold}
          title={`Fold ${name} out of the way`}
          className="ml-auto min-h-9 cursor-pointer border-0 bg-transparent p-0 font-mono text-[8px] tracking-[0.16em] text-muted uppercase hover:text-ink sm:min-h-0"
        >
          Fold
        </button>
      </div>
    </div>
  );
}

// A folded day — a slim vertical rail; click to reopen the column.
function FoldedRail({
  label, name, count, onClick,
}: {
  label: string;
  name: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open ${name}`}
      className="flex w-12 flex-none cursor-pointer flex-col items-center gap-3 self-stretch border border-ink bg-[var(--card-bg)] py-2.5 hover:bg-[var(--page-bg)]"
    >
      <span className="flex h-5 min-w-5 items-center justify-center border border-ink bg-[var(--card-bg)] px-1 font-mono text-[9px] font-bold text-ink">
        {count}
      </span>
      <span className="font-mono text-[11px] font-bold tracking-[0.18em] text-ink uppercase [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}

// One scheduled run as a card — height encodes duration (one `--hour-px` unit
// per hour). Clicking the card loads its order into the Write-an-order line;
// the × in the corner takes the run off the air (a local edit either way).
//
// A one-hour card has ~24px of content box at the roomy unit and less when
// compact, which is not two lines of type — it was slicing the show's name
// through the middle. Anything that short prints the name alone and leaves the
// hour range to the tooltip, which carried it all along.
//
// The two edges are resize handles: drag one to move that boundary an hour at
// a time. The drag is a PURE PREVIEW — the grid is written once, on release.
// Writing on every step would be the obvious thing and it does not work: the
// cards are re-derived from the grid by `dayBlocks` and keyed on `start`, so a
// top-edge drag would remount the very handle holding the pointer capture and
// the gesture would die on its first hour. Instead the card draws itself at
// the drafted size and pulls the difference back out of its own margins, so
// the run appears to grow over its neighbours without the column reflowing
// under the cursor.
function BoardCard({
  block, name, color, density, hourPx, onPick, onRemove, onResize, onDropShow,
}: {
  block: Block;
  name: string;
  color: string;
  density: BoardDensity;
  hourPx: number;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const drag = useRef<{ edge: ResizeEdge; y0: number } | null>(null);

  const blockEnd = block.start + block.span;
  const start = draft?.start ?? block.start;
  const end = draft?.end ?? blockEnd;
  const span = end - start;

  useDynamicStyle(ref, {
    height: `calc(var(--hour-px) * ${span} - 4px)`,
    // Negative when the draft has grown past the real run — the card overlaps
    // its neighbours instead of displacing them.
    marginTop: draft ? `calc(var(--hour-px) * ${start - block.start})` : undefined,
    marginBottom: draft ? `calc(var(--hour-px) * ${blockEnd - end})` : undefined,
    background: color,
  });

  const commit = (r: { start: number; end: number }) => {
    if (r.start !== block.start || r.end !== blockEnd) onResize(block, r.start, r.end);
  };

  const edgeHour = (edge: ResizeEdge) => (edge === 'top' ? block.start : blockEnd);

  const handleProps = (edge: ResizeEdge) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { edge, y0: e.clientY };
      setDraft({ start: block.start, end: blockEnd });
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d) return;
      const steps = Math.round((e.clientY - d.y0) / hourPx);
      setDraft(resizedRun(block, d.edge, edgeHour(d.edge) + steps));
    },
    onPointerUp: () => {
      if (drag.current && draft) commit(draft);
      drag.current = null;
      setDraft(null);
    },
    // A cancelled pointer (a system gesture, the page scrolling away) abandons
    // the draft rather than committing a size the operator never released on.
    onPointerCancel: () => { drag.current = null; setDraft(null); },
    onKeyDown: (e: KeyboardEvent) => {
      const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      commit(resizedRun(block, edge, edgeHour(edge) + step));
    },
  });

  // Two lines need both hour units; compact only has the room from three up.
  const showRange = density === 'comfortable' ? span > 1 : span > 2;
  const range = `${hh(start)} – ${hh(end)}`;
  return (
    <div
      ref={ref}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      className={cn(
        'group relative overflow-hidden text-[#f6f2ea]',
        'hover:outline-2 hover:-outline-offset-1 hover:outline-ink',
        over && 'outline-2 -outline-offset-1 outline-ink',
        // Lifted while drafting so the overlap reads as the card on top of its
        // neighbours rather than sunk behind them.
        draft && 'z-20 outline-2 -outline-offset-1 outline-[var(--accent)]',
      )}
    >
      <button
        type="button"
        onClick={() => onPick(block)}
        title={`${name} · ${hh(block.start)} – ${hh(blockEnd)} — click to edit this order, or drag an edge to change the hours`}
        className={cn(
          'flex size-full cursor-pointer flex-col overflow-hidden border-0 bg-transparent px-2 text-left text-inherit',
          showRange ? 'justify-between py-1.5' : 'justify-center py-0.5',
        )}
      >
        <span className="max-w-full overflow-hidden pr-4 font-mono text-[10.5px] leading-[1.2] font-bold tracking-[0.03em] text-ellipsis whitespace-nowrap uppercase">
          {name}
        </span>
        {showRange && (
          <span className="font-mono text-[9px] tracking-[0.06em] whitespace-nowrap opacity-70">
            {range}
          </span>
        )}
      </button>
      {/* While drafting, the range is the only feedback that matters — print it
          even on the short cards that normally leave it to the tooltip. */}
      {draft && !showRange && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-[rgba(0,0,0,0.45)] px-1 text-center font-mono text-[8.5px] tracking-[0.06em] whitespace-nowrap">
          {range}
        </span>
      )}
      <ResizeHandle
        edge="top"
        label={`Move the start of “${name}” — currently ${hh(block.start)}:00`}
        dragging={drag.current?.edge === 'top'}
        {...handleProps('top')}
      />
      <ResizeHandle
        edge="bottom"
        label={`Move the end of “${name}” — currently ${hh(blockEnd)}:00`}
        dragging={drag.current?.edge === 'bottom'}
        {...handleProps('bottom')}
      />
      <button
        type="button"
        onClick={() => onRemove(block)}
        aria-label={`Take “${name}” off the air`}
        title={`Take “${name}” off the air`}
        className="absolute top-[3px] right-[3px] z-10 flex size-[17px] cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-mono text-[13px] leading-none font-bold text-inherit opacity-0 group-hover:opacity-100 hover:bg-[rgba(0,0,0,0.35)] focus-visible:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

type ResizeEdge = 'top' | 'bottom';

// The grab strip on a card's top or bottom edge. Kept to 7px so it still fits
// either side of a one-hour card (22px of box at the compact unit) — the depth
// comes from `touch-action: none`, which hands the whole gesture to the
// pointer handlers instead of the page's scroll. Arrow keys drive the same
// edge for anyone not dragging.
function ResizeHandle({
  edge, label, dragging, ...rest
}: {
  edge: ResizeEdge;
  label: string;
  dragging: boolean;
} & ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label}. Drag, or use the up and down arrow keys.`}
      className={cn(
        'absolute inset-x-0 z-10 flex h-[7px] cursor-ns-resize touch-none items-center justify-center border-0 bg-transparent p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        edge === 'top' ? 'top-0' : 'bottom-0',
        // A capture can carry the pointer off the card, which drops
        // `group-hover` — the handle being dragged must not vanish under it.
        dragging && 'opacity-100',
      )}
      {...rest}
    >
      <span aria-hidden="true" className="h-[2px] w-6 max-w-[55%] bg-[rgba(246,242,234,0.8)]" />
    </button>
  );
}

// One silent run as a hatched slot — a drop target, and a click target. With a
// show armed on the shelf the click books it straight away; with nothing armed
// it opens a picker of shows to book over those hours (the same write either
// way, and the same write a drop performs).
function DropSlot({
  block, shows, colorOf, armedShowId, armedName, onDropShow,
}: {
  block: Block;
  shows: ScheduleShow[];
  colorOf: (id: string | null | undefined) => string;
  armedShowId: string | null;
  armedName: string | null;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useDynamicStyle(ref, { height: `calc(var(--hour-px) * ${block.span} - 4px)` });
  const span = `${hh(block.start)} – ${hh(block.start + block.span)}`;

  const slot = (
    <button
      ref={ref}
      type="button"
      onClick={armedShowId ? () => onDropShow(block, armedShowId) : undefined}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      title={armedName
        ? `Silent ${span} — click to put “${armedName}” here`
        : `Silent ${span} — click to book a show here, or drop one in`}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center overflow-hidden border border-dashed bg-[repeating-linear-gradient(45deg,transparent_0_5px,var(--ink-soft)_5px_10px)] px-1.5 font-mono text-[9px] tracking-[0.12em] text-ellipsis whitespace-nowrap uppercase',
        over
          ? 'border-ink text-ink'
          : 'border-[color-mix(in_oklab,var(--ink)_32%,transparent)] text-muted hover:border-ink hover:text-ink',
      )}
    >
      {armedName ? `+ ${armedName}` : '+ Add a show'}
    </button>
  );

  // Armed, the slot writes on click — there is no menu to open.
  if (armedShowId) return slot;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={shows.length === 0}>
        {slot}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-[10rem] overflow-y-auto">
        <DropdownMenuGroup>
          {shows.map(s => (
            <DropdownMenuItem key={s.id} onClick={() => onDropShow(block, s.id)}>
              <ColorChip color={colorOf(s.id)} />
              {s.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
