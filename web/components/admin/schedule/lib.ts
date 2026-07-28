// Pure derivations for the schedule page ("The Rundown", /admin/shows/schedule).
//
// The persisted model stays the controller's 7×24 grid — `schedule[day][hour]`
// holds a show id or null (day keys are JS getDay: 0=Sun..6=Sat). Everything
// this screen renders — board cards, listing rows, the "orders" stack, counts,
// gap warnings, airtime bars — is derived from that one grid through the block
// helpers here, so the board and the listing can never disagree.

export interface Schedule {
  [day: number]: (string | null)[];
}

/** The slice of a show this screen needs (hydrated from GET /settings). */
export interface ScheduleShow {
  id: string;
  name: string;
  personaId: string;
  moods: string[];
  energies: string[];
}

/** One contiguous run of hours on one day. `showId` null = silent hours. */
export interface Block {
  day: number;
  start: number;
  /** Hours covered; `start + span` can be 24 (end of day), never wraps. */
  span: number;
  showId: string | null;
}

/** One contiguous run of unsaved cell edits (for the Review list). */
export interface DiffRange {
  day: number;
  start: number;
  end: number;
  fromId: string | null;
  toId: string | null;
}

// Storage keys are 0=Sun..6=Sat (JS getDay); display Mon-first.
export const DAYS: { key: number; label: string; name: string }[] = [
  { key: 1, label: 'MON', name: 'Monday' },
  { key: 2, label: 'TUE', name: 'Tuesday' },
  { key: 3, label: 'WED', name: 'Wednesday' },
  { key: 4, label: 'THU', name: 'Thursday' },
  { key: 5, label: 'FRI', name: 'Friday' },
  { key: 6, label: 'SAT', name: 'Saturday' },
  { key: 0, label: 'SUN', name: 'Sunday' },
];

export const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Same palette (and the same index-keyed assignment) as ShowsPanel, so a
// show's colour matches between the definitions page and this one.
export const SHOW_COLORS = [
  '#c5302a', '#2f6f4f', '#3a5fa8', '#9a5b1f', '#6b4a8a', '#1f7a7a',
  '#a83a6b', '#4a6b1f', '#8a6a1f', '#3a3a8a', '#7a2f5a', '#2f7a3a',
];

export function emptyWeek(): Schedule {
  const w: Schedule = {};
  for (let d = 0; d < 7; d++) w[d] = Array(24).fill(null);
  return w;
}

export function cloneWeek(s: Schedule): Schedule {
  const w: Schedule = {};
  for (let d = 0; d < 7; d++) w[d] = (s[d] ?? Array(24).fill(null)).slice();
  return w;
}

export function dayName(day: number): string {
  return DAYS.find(d => d.key === day)?.name ?? '';
}

export function dayLabel(day: number): string {
  return DAYS.find(d => d.key === day)?.label ?? '';
}

/** '06' — board-card style hour. 24 stays '24' so a day-end reads as a close. */
export function hh(h: number): string {
  return String(h).padStart(2, '0');
}

/** '06:00' — listing/editor style hour. */
export function hhmm(h: number): string {
  return `${hh(h)}:00`;
}

/** Group one day's 24 cells into contiguous blocks (shows and silent runs). */
export function dayBlocks(schedule: Schedule, day: number): Block[] {
  const cells = schedule[day] ?? Array(24).fill(null);
  const blocks: Block[] = [];
  let h = 0;
  while (h < 24) {
    const v = cells[h] ?? null;
    let end = h + 1;
    while (end < 24 && (cells[end] ?? null) === v) end++;
    blocks.push({ day, start: h, span: end - h, showId: v });
    h = end;
  }
  return blocks;
}

/** Every show block of the week in display order — the "standing orders". */
export function weekOrders(schedule: Schedule): Block[] {
  return DAYS.flatMap(d => dayBlocks(schedule, d.key).filter(b => b.showId));
}

export function bookedHoursOf(schedule: Schedule, day: number): number {
  return (schedule[day] ?? []).filter(Boolean).length;
}

export function bookedHours(schedule: Schedule): number {
  let n = 0;
  for (let d = 0; d < 7; d++) n += bookedHoursOf(schedule, d);
  return n;
}

export function showHours(schedule: Schedule, showId: string): number {
  let n = 0;
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) if (schedule[d]?.[h] === showId) n++;
  return n;
}

/** Assign `value` to [start, end) on each of `days`, immutably. */
export function setRange(
  schedule: Schedule,
  days: number[],
  start: number,
  end: number,
  value: string | null,
): Schedule {
  const week = cloneWeek(schedule);
  for (const d of days)
    for (let h = start; h < end && h < 24; h++) week[d]![h] = value;
  return week;
}

/** Fill a whole day with `showId` — or clear it when the day already runs
 *  nothing but that show, so a second click undoes the first. The bulk gesture
 *  behind a click on a day header. */
export function fillDayToggle(schedule: Schedule, day: number, showId: string): Schedule {
  const cells = schedule[day] ?? [];
  const allSet = cells.length === 24 && cells.every(c => c === showId);
  return setRange(schedule, [day], 0, 24, allSet ? null : showId);
}

/** Fill one hour across all seven days — same toggle-off rule as `fillDayToggle`.
 *  The bulk gesture behind a click on an hour in the gutter. */
export function fillHourToggle(schedule: Schedule, hour: number, showId: string): Schedule {
  const days = DAYS.map(d => d.key);
  const allSet = days.every(d => schedule[d]?.[hour] === showId);
  return setRange(schedule, days, hour, hour + 1, allSet ? null : showId);
}

/** Where a dragged edge of `block` lands once `hour` is clamped to something
 *  legal: inside the day, and never shorter than one hour. Pure so the board
 *  can run it on every pointer move without touching the grid. */
export function resizedRun(
  block: Block,
  edge: 'top' | 'bottom',
  hour: number,
): { start: number; end: number } {
  const end = block.start + block.span;
  if (edge === 'top') return { start: Math.min(Math.max(hour, 0), end - 1), end };
  return { start: block.start, end: Math.max(Math.min(hour, 24), block.start + 1) };
}

/** Move one run's boundaries to [start, end) — the write behind a resize drag.
 *  The hours it gives up fall silent; the hours it takes over are written to
 *  its show over whatever was there, the same overwrite every other write on
 *  this screen performs. Clearing first is what makes a shrink work at all,
 *  and it must happen before the write or a grow would erase its own gain. */
export function resizeBlock(
  schedule: Schedule,
  block: Block,
  start: number,
  end: number,
): Schedule {
  if (!block.showId) return schedule;
  const cleared = setRange(schedule, [block.day], block.start, block.start + block.span, null);
  return setRange(cleared, [block.day], start, end, block.showId);
}

/** Number of cells where the two grids disagree (the unsaved-edit count). */
export function diffCells(a: Schedule, b: Schedule): number {
  let n = 0;
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++)
      if ((a[d]?.[h] ?? null) !== (b[d]?.[h] ?? null)) n++;
  return n;
}

/** Unsaved edits grouped into contiguous same-transition runs, display order. */
export function diffRanges(local: Schedule, server: Schedule): DiffRange[] {
  const out: DiffRange[] = [];
  for (const { key: d } of DAYS) {
    let h = 0;
    while (h < 24) {
      const from = server[d]?.[h] ?? null;
      const to = local[d]?.[h] ?? null;
      if (from === to) { h++; continue; }
      let end = h + 1;
      while (
        end < 24 &&
        (server[d]?.[end] ?? null) === from &&
        (local[d]?.[end] ?? null) === to &&
        from !== (local[d]?.[end] ?? null)
      ) end++;
      out.push({ day: d, start: h, end, fromId: from, toId: to });
      h = end;
    }
  }
  return out;
}

/** The block containing `hour` on `day` (always exists — silent runs count). */
export function blockAt(schedule: Schedule, day: number, hour: number): Block {
  const found = dayBlocks(schedule, day).find(
    b => b.start <= hour && hour < b.start + b.span,
  );
  return found ?? { day, start: hour, span: 1, showId: null };
}

/** Walk forward from a block boundary: the next `offset` blocks on air,
 *  crossing midnight into the following day(s). offset 1 = up next. */
export function blockAhead(schedule: Schedule, day: number, hour: number, offset: number): Block {
  let cur = blockAt(schedule, day, hour);
  for (let i = 0; i < offset; i++) {
    let nd = cur.day;
    let nh = cur.start + cur.span;
    if (nh >= 24) { nh = 0; nd = (cur.day + 1) % 7; }
    cur = blockAt(schedule, nd, nh);
  }
  return cur;
}
