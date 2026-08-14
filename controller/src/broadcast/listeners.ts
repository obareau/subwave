// Icecast listener-count monitor.
//
// Polls Icecast on an interval and caches the live listener count across both
// broadcast mounts (/stream.mp3 + /stream.opus), so the DJ gates can ask "is
// anyone listening?" without each one hitting Icecast.
//
// The count folds Safari's double connection into one (groupConnections /
// dedupeListeners): iOS/macOS Safari opens two identical sockets per client, so
// a raw sum double-counts every Apple listener.
//
// Keying on IP is not an option, and neither reason is fixed by the
// trusted-proxy work: behind a reverse proxy a row carries the listener's real
// address only when the operator named that proxy in icecast's
// <x-forwarded-for>, and even then a household behind one NAT is several
// listeners on one address. So every non-Safari socket counts as a listener and
// Safari's two near-simultaneous sockets are paired by user-agent + connect
// time. That needs the per-connection admin feed (/admin/listclients); the
// public status-json.xsl supplies online/bitrate and the fallback sum when the
// admin endpoint is unavailable.
//
// Fail-open: if Icecast is unreachable the count is null and djCallsAllowed()
// treats the station as occupied — a stats outage must never silence the DJ.

import { appendFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

let lastCount: number | null = null;        // null = unknown (not yet polled, or this poll failed)
let lastGoodCount: number | null = null;    // last count actually read from Icecast; null until the first success
let peakSeen = 0;                            // running max of the deduped count this process run
let consecutiveStatusFailures = 0;          // resets to 0 on every successful poll

// Full cached stream status, refreshed by the same poll that maintains
// lastCount. `online` is true when at least one broadcast mount has a source
// attached; `peak` sums listener_peak across both mounts. Read by the public
// /now-playing route, which every listener polls every 5s — serving the
// cached value means N listeners cost one Icecast status fetch per 15s
// instead of one per request (and a wedged Icecast can no longer stall the
// route for its 1.5s timeout on every poll).
export interface StreamStatus {
  online: boolean;
  listeners: { current: number; peak: number };
  /** Bitrate (kbps) of the primary (mp3) broadcast mount, null when offline. */
  bitrate: number | null;
  /** Sample rate (Hz) of the primary mount, null when offline/unknown. */
  sampleRate: number | null;
  /** Channel count of the primary mount, null when offline/unknown. */
  channels: number | null;
}
let lastStatus: StreamStatus = {
  online: false,
  listeners: { current: 0, peak: 0 },
  bitrate: null,
  sampleRate: null,
  channels: null,
};

// How many *consecutive* failed status polls before we stop trusting the last
// reading — both the cached `online` status and the gated count below. Under
// the limit we hold the last known values so a transient stats-endpoint timeout
// never tears down a healthy listener (issue #461) nor releases the idle pause
// (issue #1256); at or above it a genuinely unreachable Icecast still surfaces
// as offline / unknown instead of being pinned forever. 4 polls ≈ 1 min of
// sustained failure at the monitor's 15s cadence, ≈20s while the idle monitor
// is forcing its own 5s polls — both comfortably past a single blip, and the
// faster reading while idle is the right way round: an unobservable stream
// should resume sooner, not later.
const STALE_STATUS_LIMIT = 4;

// Deadline on the Icecast status fetch. Raised from 1500ms once the poll became
// single-flighted (below): the old figure was chosen when three cadences could
// each have a request in flight at once, where a longer deadline meant a deeper
// pile-up. Coalescing removes that objection, and 1500ms was measurably tight —
// #1256's reporter logged hundreds of AbortErrors per empty-room hour against an
// Icecast that direct curls never took near a second to answer, with the
// analysis pass (which only runs when the room IS empty) the likeliest source of
// the host pressure that reached it. Attacking the failure rate is strictly
// better than widening STALE_STATUS_LIMIT to absorb more failures: the limit is
// shared with the #461 offline-detection contract, which should NOT get slower.
// Still comfortably inside the idle monitor's 5s tick, so the ~20s fail-open
// budget while paused is unchanged.
const STATUS_TIMEOUT_MS = 3000;

// Next cached status after a status-fetch failure. Pure (no I/O) so the
// transient-vs-sustained branching is unit-tested in isolation
// (scripts/listeners-status.test.ts).
//   • transient (failures < limit): hold the last known status — the count is
//     stale-but-best-known, not a freshly-observed 0. Keeps a healthy player
//     alive through a momentary stats blip.
//   • sustained (failures ≥ limit): the broadcast really looks gone — report
//     offline, zero the current count, drop bitrate; keep the run's peak.
export function statusAfterFailure(
  prev: StreamStatus,
  consecutiveFailures: number,
  limit: number,
  peak: number,
): StreamStatus {
  if (consecutiveFailures >= limit) {
    return { online: false, listeners: { current: 0, peak }, bitrate: null, sampleRate: null, channels: null };
  }
  return { ...prev, listeners: { ...prev.listeners, peak } };
}

// Pure: the count the fail-open gates should act on. Same transient-vs-sustained
// split as statusAfterFailure above, applied to the number instead of the status
// (scripts/listeners-status.test.ts pins both).
//   • poll succeeded: that reading, always.
//   • transient failure (< limit): the last reading actually read from Icecast.
//     A failed fetch is not an observation — it says nothing about the room, so
//     the freshest real observation is strictly better information than "unknown".
//   • sustained failure (≥ limit): null. Icecast really is unreadable, and the
//     gates' documented fail-open kicks in.
//   • never polled: null (lastGood is null) — honest, and unchanged from before.
export function gatedCount(
  raw: number | null,
  lastGood: number | null,
  consecutiveFailures: number,
  limit: number,
): number | null {
  if (raw !== null) return raw;
  if (consecutiveFailures >= limit) return null;
  return lastGood;
}

// Time-series file. JSONL of {t, count} rows, one per persisted sample.
// We persist every minute (not every 15s poll) — keeps the file at ~1440
// rows/day, easily tail-readable, and that resolution is plenty for the
// "is anyone here?" sparkline this is for.
const HISTORY_FILE = join(config.stateDir, 'listeners.jsonl');
let lastPersistedMinute = -1;

// Pull samplerate / channels off an Icecast status source. Icecast exposes
// these either as top-level numeric fields or folded into the semicolon-
// delimited `audio_info` string ("samplerate=44100;channels=2;quality=…"),
// depending on build and encoder — try the direct field first, then the string.
function audioParam(src: any, key: 'samplerate' | 'channels'): number | null {
  const direct = Number(src?.[key]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const m = String(src?.audio_info || '').match(new RegExp(`${key}=([0-9]+)`, 'i'));
  return m ? Number(m[1]) : null;
}

// Coalesce overlapping polls into one in-flight run. Pure mechanism (no I/O),
// exported so the join/settle/re-arm behaviour is unit-pinned
// (scripts/listeners-status.test.ts).
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= run().finally(() => { inFlight = null; });
    return inFlight;
  };
}

// The poll, single-flighted. pollCount() commits module state
// (lastCount/lastGoodCount/consecutiveStatusFailures/lastStatus) and is driven
// from three cadences at once — the 15s monitor interval, the idle monitor's
// forced 5s refresh (stream-idle.ts), and POST /request's on-demand refresh().
// The two commit points are a whole STATUS_TIMEOUT_MS apart (the failure path
// waits out the fetch timeout), so without the guard a slow doomed poll could
// land AFTER a younger
// successful one and overwrite its fresh state — a phantom blip on the raw
// readers and a "consecutive" failure count that isn't. Joining the poll
// already in flight keeps every caller's freshness contract (the answer is at
// most one timeout old — refresh() callers included) and stops the idle window
// double-polling Icecast when the 5s and 15s timers collide.
const fetchCount = singleFlight(() => pollCount(true));

async function pollCount(persistHistory: boolean) {
  let online = false;
  let bitrate: number | null = null;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let rawCount = 0; // un-deduped status sum — the fallback when admin is unreachable
  try {
    const r = await fetchWithTimeout(config.icecast.statusUrl, { timeoutMs: STATUS_TIMEOUT_MS });
    const ic = ((await r.json()) as any)?.icestats;
    const sources = Array.isArray(ic?.source) ? ic.source : ic?.source ? [ic.source] : [];
    // Only our two broadcast mounts count. Anything else (e.g. an /admin
    // source) is ignored so stray test mounts don't inflate the numbers.
    const broadcastSources = sources.filter((s: any) =>
      BROADCAST_MOUNTS.some(m => String(s?.listenurl || '').includes(m))
    );
    online = broadcastSources.length > 0;
    rawCount = broadcastSources.reduce(
      (sum: number, s: any) => sum + Number(s.listeners || 0), 0);
    // Describe the broadcast off the *primary* mount — /stream.mp3, the
    // always-served universal floor — rather than whichever source Icecast
    // happened to list first (Opus, when enabled, is a different 96k/48kHz
    // encode and would misreport the figures listeners actually receive). Falls
    // back to the first attached source if the mp3 mount isn't found. All comes
    // free off this same poll.
    const primarySource =
      broadcastSources.find((s: any) => String(s?.listenurl || '').includes('/stream.mp3')) ??
      broadcastSources[0];
    const firstBitrate = Number(primarySource?.bitrate);
    bitrate = Number.isFinite(firstBitrate) ? firstBitrate : null;
    sampleRate = audioParam(primarySource, 'samplerate');
    channels = audioParam(primarySource, 'channels');

    // Dedupe by IP+UA off the admin per-connection feed (Safari double-counts —
    // see dedupeListeners). Only worth a call when someone's actually attached;
    // on any admin failure fall back to the raw status sum rather than dropping
    // the count, so a missing admin password just degrades to the old numbers.
    let current = rawCount;
    if (online && rawCount > 0) {
      try {
        current = dedupeListeners(await getConnections());
      } catch {
        /* admin unreachable / no password — keep the raw status sum */
      }
    }

    lastCount = current;
    lastGoodCount = current;
    peakSeen = Math.max(peakSeen, current);
    lastStatus = { online, listeners: { current, peak: peakSeen }, bitrate, sampleRate, channels };
    consecutiveStatusFailures = 0;
  } catch {
    lastCount = null;
    // Treat a transient Icecast status fetch failure as "unknown", not as proof
    // the broadcast went offline: hold the last known status so the listener UI
    // doesn't tear down a healthy audio element over a momentary stats timeout
    // (issue #461). Only once failures persist (STALE_STATUS_LIMIT) do we report
    // offline — a genuinely unreachable Icecast must still surface eventually.
    consecutiveStatusFailures += 1;
    lastStatus = statusAfterFailure(lastStatus, consecutiveStatusFailures, STALE_STATUS_LIMIT, peakSeen);
  }
  // Persist at most one row per wall-clock minute. Skip null samples — a
  // stats outage shouldn't leave a misleading "0 listeners" stripe in the
  // graph; the gap itself communicates the outage.
  if (persistHistory && lastCount !== null) {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60000);
    if (minute !== lastPersistedMinute) {
      lastPersistedMinute = minute;
      const line = JSON.stringify({ t: now.toISOString(), count: lastCount }) + '\n';
      appendFile(HISTORY_FILE, line).catch(() => {});  // best-effort
    }
  }
  return lastCount;
}

// Last known listener count — a number, or null when it couldn't be read. The
// RAW poll result: one failed fetch shows up here as null. Reporting surfaces
// (admin table, DJ context) want exactly that. Decision-making code does not —
// see gatedListenerCount().
export function getListenerCount() {
  return lastCount;
}

// The count the fail-open gates act on: the last reading actually read from
// Icecast, held through transient poll failures and only reported unknown once
// failures reach STALE_STATUS_LIMIT (see gatedCount above).
//
// This is what djCallsAllowed() and the idle monitor (stream-idle.ts) must read
// — never the raw lastCount. Both fail OPEN on null, so on the raw count a
// SINGLE fetch timeout released the idle pause and reopened the LLM gate; since
// the idle monitor forces a poll every 5s while paused (~120 per 10-minute
// pause), a sub-1% failure rate fired inside nearly every pause window and the
// power save was inactive ~95% of the time it should have been active (#1256).
//
// The fail-open doctrine is unchanged — a genuinely unreachable Icecast still
// reads null and still keeps the DJ on air. Only the definition of
// "unreachable" tightened, from one blip to sustained failure, matching the
// hysteresis the cached status has had since #461.
export function gatedListenerCount(): number | null {
  return gatedCount(lastCount, lastGoodCount, consecutiveStatusFailures, STALE_STATUS_LIMIT);
}

// Fail-closed presence check: the listener count when it is known and > 0,
// else null. The single definition of "someone is tuned in" for outbound
// side effects (scrobbles, gated track.play webhooks) — an unknown count
// must never fire to an empty room. Contrast djCallsAllowed() below, which
// deliberately fails OPEN so a stats outage can't take the DJ off the air.
//
// Deliberately reads the RAW count, not the gated one: failing closed means a
// blip costs at most one skipped scrobble, which is the safe direction and
// needs no hysteresis to protect it. The two gates below fail open, which is
// why they need it. Don't "unify" these onto one reading.
export function presentListeners(): number | null {
  return typeof lastCount === 'number' && Number.isFinite(lastCount) && lastCount > 0
    ? lastCount
    : null;
}

// Last known stream status, from the same 15s poll. Returns offline + 0/0
// until the first successful poll — same shape /now-playing always exposed.
export function getStreamStatus(): StreamStatus {
  return lastStatus;
}

// Force an immediate poll. Used by the request route so a listener who just
// connected isn't rejected on a stale cached value.
export async function refresh() {
  return fetchCount();
}

// One-shot count probe for out-of-process callers — the analysis quiet gate
// (#1099) runs inside the tagger/analyze CHILD process, which has no 15s
// monitor loop. Same status fetch + Safari dedupe as the monitor, but skips
// the history append: the server process already persists one row per minute,
// and a second writer would stripe duplicate rows into the sparkline JSONL.
// Calls pollCount directly, bypassing the single-flight guard: the child has
// no concurrent pollers to coalesce with, and joining would silently drop the
// skip-history flag.
//
// Returns the GATED count, not pollCount's raw result. The quiet gate
// (music/analyze-quiet-pure.ts) is the third fail-open-on-unknown reader and
// needs the same hysteresis for the same reason (#1256) — its fail-open runs the
// OPPOSITE way, so a single blip here starts a heavy DSP pass while somebody is
// listening rather than releasing a pause. The child's own module state carries
// the hysteresis: it polls once per track (or every 30s while waiting out the
// window), so consecutive failures accumulate across calls exactly as in the
// monitor loop.
export async function probeListenerCount(): Promise<number | null> {
  await pollCount(false);
  return gatedListenerCount();
}

// Set by broadcast/stream-idle.ts (via setStreamIdle) while the programme is
// idle-paused — a flag pushed in rather than imported out, so listeners.ts
// and stream-idle.ts don't form an import cycle.
let streamIdle = false;

export function setStreamIdle(v: boolean) {
  streamIdle = v;
}

// True when autonomous DJ LLM work is allowed right now. When the pause toggle
// is off, always true. When on, allowed only if at least one listener is
// counted — an unknown count (Icecast unreachable) is treated as occupied so a
// stats outage can never take the DJ off the air.
//
// Reads gatedListenerCount(), so "unknown" means sustained failure rather than
// one timed-out poll (#1256). This also gates POST /request, which forces a
// fresh poll first: under a real outage those failures reach the limit and
// requests are accepted as before, so only a single blip — where the held
// reading is seconds old and accurate — decides differently.
//
// An idle-paused stream blocks DJ calls regardless of the LLM toggle: the
// voice queues aren't being pulled while the idle gate is up, so any WAV
// written to say.txt/intro.txt would pile up and play back-to-back on resume.
export function djCallsAllowed() {
  if (streamIdle) return false;
  if (!settings.get()?.llm?.pauseWhenEmpty) return true;
  const count = gatedListenerCount();
  if (count === null) return true;
  return count > 0;
}

// How long boot waits on the first poll before giving up and starting anyway.
// Bounds the worst case (a wedged admin endpoint costs 2s per mount on top of
// the status fetch) — the reading is a nicety, never a boot dependency.
//
// Derived from STATUS_TIMEOUT_MS rather than written as a flat number: the wait
// only buys anything if it outlasts one failing status fetch, so a deadline
// raised past a hardcoded wait would silently give up before every slow poll
// and hand back the "never polled" fail-open this exists to close. A cold
// `compose up` is unaffected either way — Icecast isn't listening yet, so the
// connection is refused immediately rather than timing out.
const FIRST_POLL_WAIT_MS = STATUS_TIMEOUT_MS + 500;

// Starts the 15s monitor loop. The returned promise settles once the FIRST poll
// has landed (or FIRST_POLL_WAIT_MS has passed), so boot can take one reading
// before the queue watcher is able to dispatch a pick: "never polled" and "poll
// failed" both read as unknown, and an unknown count fails open, which used to
// buy the DJ one free agent pick on every controller restart (#1256). Only
// helps when Icecast is already up — on a cold `compose up` the broadcast
// container isn't serving yet, the poll fails, and the gate fails open as
// designed.
export function startListenerMonitor(): Promise<void> {
  const first = fetchCount().then(() => {}, () => {});
  setInterval(fetchCount, 15000);
  return Promise.race([
    first,
    new Promise<void>(resolve => setTimeout(resolve, FIRST_POLL_WAIT_MS).unref()),
  ]);
}

// Read the recent listener history for the admin sparkline. Returns rows
// newer than `since` (defaults to 24 h ago), oldest-first.
//
// JSONL is read whole and filtered in-memory — fine because the file caps
// at ~1440 lines/day. If retention ever grows past a few MB, swap to a
// streaming tail; until then, the simple read is enough.
export interface ListenerSample {
  t: string;
  count: number;
}

export async function history({
  since,
}: { since?: Date } = {}): Promise<ListenerSample[]> {
  if (!existsSync(HISTORY_FILE)) return [];
  let raw = '';
  try {
    raw = await readFile(HISTORY_FILE, 'utf8');
  } catch {
    return [];
  }
  const cutoffMs = (since || new Date(Date.now() - 24 * 60 * 60 * 1000)).getTime();
  const out: ListenerSample[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const tMs = new Date(row.t).getTime();
      if (!Number.isFinite(tMs) || tMs < cutoffMs) continue;
      if (typeof row.count !== 'number') continue;
      out.push({ t: row.t, count: row.count });
    } catch {}
  }
  return out;
}

// Size of the persisted history file, for the admin debug view. Useful to
// notice if the operator left the station running for a year and the file
// grew unexpectedly.
export async function historyBytes(): Promise<number> {
  try {
    const st = await stat(HISTORY_FILE);
    return st.size;
  } catch {
    return 0;
  }
}

// ── Per-listener connections (admin only) ──────────────────────────────────
// The aggregate count above comes from Icecast's public status JSON. The
// per-connection breakdown (IP, user-agent, how long they've been connected)
// lives behind Icecast's admin interface (/admin/listclients), which is
// Basic-auth gated — so this path needs the admin password, unlike the count.

export interface ListenerConnection {
  ip: string;
  mount: string;
  userAgent: string;
  connectedSeconds: number;
  /** Raw sockets folded into this row by groupConnections (Safari opens 2). */
  connections?: number;
}

const BROADCAST_MOUNTS = ['/stream.mp3', '/stream.opus', '/stream.flac', '/stream.aac'];
let cachedAdminPassword: string | null = null;

// Resolve the Icecast admin password: explicit env wins, otherwise read the
// shared icecast-secrets.env that the broadcast container writes on boot (both
// containers mount /var/sub-wave, so no cross-container handshake is needed).
async function resolveAdminPassword(): Promise<string | null> {
  if (process.env.ICECAST_ADMIN_PASSWORD) return process.env.ICECAST_ADMIN_PASSWORD;
  if (cachedAdminPassword) return cachedAdminPassword;
  try {
    const raw = await readFile(join(config.stateRoot, 'icecast-secrets.env'), 'utf8');
    const m = raw.match(/^ICECAST_ADMIN_PASSWORD=(.*)$/m);
    if (m) {
      cachedAdminPassword = m[1].trim().replace(/^["']|["']$/g, '');
      return cachedAdminPassword;
    }
  } catch {
    /* file absent until broadcast boots — caller surfaces the null */
  }
  return null;
}

// Decode the XML entities Icecast escapes in text fields. User-agents routinely
// contain & and occasionally <>. &amp; is undone last so "&amp;lt;" survives.
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function tagText(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

// listclients XML is flat and machine-generated — one <listener> block per
// client — so a scan over those blocks is enough; no XML dependency pulled in.
// The opening tag carries an id attribute (`<listener id="33">`), so the match
// allows attributes rather than a bare tag.
function parseListClients(xml: string, mount: string): ListenerConnection[] {
  const out: ListenerConnection[] = [];
  const re = /<listener\b[^>]*>([\s\S]*?)<\/listener>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    out.push({
      ip: tagText(block, 'IP'),
      mount,
      userAgent: tagText(block, 'UserAgent'),
      connectedSeconds: Number(tagText(block, 'Connected')) || 0,
    });
  }
  return out;
}

// Max gap (seconds) between Safari's two sockets' Connected times for them to be
// treated as the same listener's double. They open within the same second and
// stay within ~1s of each other for the connection's life; 6s absorbs poll
// jitter without bridging two genuinely separate joins.
const DOUBLE_WINDOW_S = 6;

// True when the user-agent is real Safari / AppleCoreMedia — the only clients
// that open *two* identical sockets per listener (a fundamental AppleCoreMedia
// behaviour, no client-side fix — see react-native-track-player #2096).
// Chrome-on-Mac also carries the "Safari/537.36" token but is Blink and opens a
// single socket, so it must NOT match: gate on "Version/" + "Safari" and exclude
// the Chromium-family tokens.
function isSafariDouble(ua: string): boolean {
  if (/AppleCoreMedia/i.test(ua)) return true;
  if (!/Safari/i.test(ua) || !/Version\//i.test(ua)) return false;
  return !/(Chrome|CriOS|Chromium|Android|Edg|OPR)/i.test(ua);
}

// Number of distinct listeners — the headline count. Folds Safari's double
// back into one (see groupConnections) without keying on IP, which is either
// useless (an untrusted proxy makes every socket carry the proxy's address) or
// wrong (one NAT is many listeners). Single source of truth with the admin
// table: both derive from groupConnections so they can't drift apart.
export function dedupeListeners(conns: ListenerConnection[]): number {
  return groupConnections(conns).length;
}

// One row per distinct listener — for the admin connections table and the
// headline count. Every non-Safari socket is its own listener (Chrome, Firefox,
// Android, Sonos and hardware radios open exactly one socket each, so two
// distinct listeners sharing the proxy IP — and even the same UA — both
// count). Safari's two near-simultaneous sockets are paired into one row by
// user-agent + connect-time. `connections` records how many raw sockets folded
// in (Safari → 2); connectedSeconds is the longest-held of the group and mount
// lists every mount the listener holds.
export function groupConnections(conns: ListenerConnection[]): ListenerConnection[] {
  const singles: ListenerConnection[] = [];
  const safari: ListenerConnection[] = [];
  for (const c of conns) (isSafariDouble(c.userAgent) ? safari : singles).push(c);

  const out: ListenerConnection[] = singles.map(c => ({ ...c, connections: 1 }));

  // Pair Safari sockets per mount: sort by Connected, greedily merge an adjacent
  // socket within the window. Each real Apple listener is exactly two sockets, so
  // for any even count this yields N/2 listeners regardless of pairing order; an
  // odd leftover stands alone. Cap each group at 2 — Safari only ever doubles.
  const byMount = new Map<string, ListenerConnection[]>();
  for (const c of safari) {
    const arr = byMount.get(c.mount) ?? [];
    arr.push(c);
    byMount.set(c.mount, arr);
  }
  for (const arr of byMount.values()) {
    arr.sort((a, b) => b.connectedSeconds - a.connectedSeconds);
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      const next = arr[i + 1];
      if (next && cur.connectedSeconds - next.connectedSeconds <= DOUBLE_WINDOW_S) {
        out.push({ ...cur, connections: 2 });
        i++; // consume the paired socket
      } else {
        out.push({ ...cur, connections: 1 });
      }
    }
  }
  return out;
}

// Live per-listener connections across both broadcast mounts. Returns [] when
// nobody's connected; throws only on auth/transport failure so the admin route
// can show the operator why the table is empty.
export async function getConnections(): Promise<ListenerConnection[]> {
  const password = await resolveAdminPassword();
  if (!password) throw new Error('Icecast admin password unavailable');
  const auth =
    'Basic ' + Buffer.from(`${config.icecast.adminUser}:${password}`).toString('base64');

  const rows: ListenerConnection[] = [];
  for (const mount of BROADCAST_MOUNTS) {
    const r = await fetchWithTimeout(`${config.icecast.adminUrl}?mount=${encodeURIComponent(mount)}`, {
      headers: { Authorization: auth },
      timeoutMs: 2000,
    });
    // A wrong password fails the same way on every mount — surface it.
    if (r.status === 401) {
      cachedAdminPassword = null; // re-read the file next time in case it rotated
      throw new Error('Icecast admin auth rejected');
    }
    // A disabled mount (e.g. Opus off by default) returns 400 — just skip it.
    if (!r.ok) continue;
    rows.push(...parseListClients(await r.text(), mount));
  }
  return rows;
}
