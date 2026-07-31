'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isIOSDevice } from '@/lib/platform';
import { useStationOrigin } from '@/lib/stationOrigin';
import { withStreamAuth } from '@/lib/stationAuth';
import { loadVolumePref, saveVolumePref } from '@/lib/volume';

// We pick MP3 vs Ogg-Opus on the client via canPlayType — Opus is roughly
// equal-or-better quality at half the bandwidth on browsers that decode it.
//
// The mount URLs come from StationOriginContext (env defaults when no
// provider; a remote station's host when the landing showcase tabs over).
// Consumers that retarget the player remount it (key) — the hook still
// mirrors the URLs into a ref so the long-lived watchdog listeners read
// fresh values either way.

// Reconnect backoff for the watchdog's error path. The first retry stays
// quick (a blip mid-broadcast should recover in half a second), but repeated
// failures double the delay up to a minute — an abandoned tab pointed at a
// downed station must not hammer reconnects twice a second all night.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

// Idle cutoff (issue #343). A forgotten tab/PWA stays connected to the live
// mount forever, counting as a listener and keeping the DJ's pause-when-empty
// gate open 24/7. After this long with zero listener activity (no pointer,
// no key, no tab focus) we tune out; the consumer surfaces a one-tap resume
// via `idleStopped`. 8h clears a full untouched workday of listening while
// still catching an abandoned tab on its first evening.
const IDLE_TUNE_OUT_MS = 8 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

// HTMLMediaElement.HAVE_FUTURE_DATA — enough decoded audio buffered to keep
// playing right now. Read off the constructor rather than the instance so the
// checks below work on a detached/erroring element too.
const HAVE_FUTURE_DATA = 3;

// Is the element audibly moving? Not paused, holding future data, and its
// media clock has advanced past `since`. This is the ground truth for "the
// listener is hearing sound" — network-level events (`stalled`) say nothing
// about it, and a wedged element fails it even though `paused` is false.
function advancingSince(el: HTMLAudioElement, since: number): boolean {
  return !el.paused && el.readyState >= HAVE_FUTURE_DATA && el.currentTime > since;
}

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Ref callback the consumer MUST put on its <audio> element (instead of
   *  audioRef) — it keeps audioRef pointing at the live node AND tells the
   *  hook when that node is replaced, so the media listeners re-attach. The
   *  private-station gate unmounts and remounts the element mid-session, and
   *  a plain object ref left the fresh node with no listeners at all: status
   *  stuck on 'connecting' forever and no stall recovery (issue #1232).
   *  Stable identity. */
  attachAudio: (el: HTMLAudioElement | null) => void;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
  // True when the idle cutoff (not the listener) tore playback down — the
  // consumer should explain why and offer a one-tap resume. Cleared on the
  // next tune().
  idleStopped: boolean;
}

export interface UsePlayerOptions {
  initialVolume?: number;
}

// Owns the <audio> element + tune-in state. The audioRef must be attached to
// an <audio> tag rendered by the consumer (so the Waveform's Web Audio API
// can also reach it).
export function usePlayer({ initialVolume = 1 }: UsePlayerOptions = {}): Player {
  const { streams } = useStationOrigin();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The same node as audioRef.current, mirrored into state so the listener
  // effect below can depend on it. Refs don't notify on attach, so an element
  // that mounts later (or is swapped out and back) has to announce itself.
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    setAudioEl(el);
  }, []);
  // Resolved at mount via canPlayType. SSR + first render use the MP3 URL so
  // server and client markup agree; the useEffect below upgrades to Opus when
  // the browser confirms it can decode it.
  const [streamUrl, setStreamUrl] = useState<string>(streams.mp3);
  const [tunedIn, setTunedIn] = useState(false);
  // 'idle' | 'connecting' | 'playing'. 'connecting' covers the unavoidable
  // gap between the tune-in gesture and the first audible audio frames —
  // surfaced in the UI so the player doesn't claim to be playing while silent.
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolume] = useState(initialVolume);
  const [idleStopped, setIdleStopped] = useState(false);
  const preMuteVolume = useRef(initialVolume || 1);

  // play() resolves asynchronously; pausing before it settles rejects the
  // promise with an AbortError. We hold the latest play() promise and a
  // generation counter so rapid tune/stop toggles (now trivially reachable
  // via the Space/K shortcuts) settle on the last action without spurious
  // errors or a stale teardown clobbering a fresh play.
  const playPromise = useRef<Promise<void> | null>(null);
  const gen = useRef(0);

  // Refs mirror the latest values of state the stall watchdog needs to read,
  // so its event listeners can stay registered once and still see fresh data.
  const tunedInRef = useRef(tunedIn);
  const streamUrlRef = useRef(streamUrl);
  const streamsRef = useRef(streams);
  const volumeRef = useRef(volume);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Media clock (currentTime) at the moment the watchdog was armed — the
  // baseline the fire compares against to decide whether audio kept flowing.
  const watchdogArmedAt = useRef(0);
  // Consecutive failed reconnects since the last successful 'playing' —
  // drives the exponential backoff in onError.
  const retryCount = useRef(0);
  // Last listener activity (pointer/key/tab-focus/tune), read by the idle
  // sweep. Seeded by the sweep effect at mount (not here — render must stay
  // pure) so a fresh tab gets the full idle window.
  const lastActivityAt = useRef(0);
  // The idle sweep mounts once but must call the latest stop() (defined
  // below, recreated per render) — bridge with a ref.
  const stopRef = useRef<() => void>(() => {});
  // Set once if the optional Opus mount fails to load — pins us to MP3 so the
  // watchdog stops retrying a dead Opus URL (e.g. an operator who disabled the
  // server-side Opus encoder, so /stream.opus 404s).
  const opusFailedRef = useRef(false);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Restore the listener's last-used volume (issue #783). localStorage is
  // effect-only (never read during render) so SSR + first paint stay on the
  // default and there's no hydration mismatch — the knob snaps to the stored
  // level a tick later, same as the lite-mode toggle. Gate persistence on
  // `hydrated` so this restoring setVolume doesn't race the persist effect.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const stored = loadVolumePref();
    if (stored !== null) {
      setVolume(stored);
      preMuteVolume.current = stored > 0 ? stored : preMuteVolume.current;
    }
    hydratedRef.current = true;
  }, []);

  // Persist volume on change, debounced so a knob drag (dozens of setVolume
  // calls) collapses to one write. The cleanup clears the pending timer on each
  // re-run, so the transient default value the mount pass carries before the
  // restore effect's setVolume lands never actually reaches localStorage.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => saveVolumePref(volume), 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Pick Opus on browsers that *definitively* decode it (Chrome, Edge — they
  // return 'probably' for Ogg-Opus). Two browser families say they can decode
  // Opus but choke on the live chained Ogg stream Icecast emits at a crossfade
  // boundary, going silent at the first track change with no error/stalled
  // event for the watchdog to catch — so we keep both on the universal MP3
  // 192 kbps mount instead:
  //   • Safari iOS/iPadOS — returns the optimistic 'maybe', and its
  //     AVFoundation Opus decoder can't tolerate the Ogg page-chain boundary.
  //   • Firefox/Gecko — returns 'probably', decodes Opus fine in general, but
  //     its media stack can't follow the chained Ogg stream either (issue #212).
  // Three layers of defence: require 'probably' (drops Safari's 'maybe'), skip
  // iOS-family devices (iPad on iPadOS 13+ reports the desktop Macintosh UA so
  // we also check maxTouchPoints), and skip Firefox by UA.
  useEffect(() => {
    if (!streams.opus || opusFailedRef.current) return;
    const ua = navigator.userAgent;
    // Desktop/Android Firefox + Gecko forks (LibreWolf, Waterfox) carry
    // "Firefox" in the UA; Firefox-for-iOS reports "FxiOS" and is already
    // caught by isIOSDevice() below, so /firefox/i doesn't double-handle it.
    const isFirefox = /firefox/i.test(ua);
    if (isIOSDevice() || isFirefox) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably') {
      setStreamUrl(streams.opus);
    }
  }, [streams.opus]);

  // Drive `status` from the <audio> element's own events, and reconnect the
  // stream when the element gets stuck mid-broadcast (the symptom: a few
  // seconds of silence around a track transition that only a page refresh
  // recovers from, because nothing in here was forcing the dead element back
  // onto the live mount). 'playing' clears the watchdog; 'waiting'/'stalled'
  // arm a 5s timer that re-sets src if the media clock hasn't moved by then;
  // 'error' reconnects with exponential backoff (500 ms doubling to a 60 s
  // ceiling, reset on the next successful 'playing').
  //
  // Re-runs whenever the element itself is replaced — see attachAudio.
  useEffect(() => {
    const el = audioEl;
    if (!el) return;

    const clearWatchdog = () => {
      if (watchdogTimer.current !== null) {
        clearTimeout(watchdogTimer.current);
        watchdogTimer.current = null;
      }
    };

    const reconnect = () => {
      clearWatchdog();
      if (!tunedInRef.current || !audioRef.current) return;
      const audio = audioRef.current;
      // The media clock moved while the watchdog was pending, so the listener
      // is hearing audio: this was a network hiccup the buffer absorbed, not a
      // wedged element. Re-setting src here would cut audible sound for
      // nothing — reconcile the UI instead (issue #1232).
      if (advancingSince(audio, watchdogArmedAt.current)) {
        retryCount.current = 0;
        setStatus('playing');
        return;
      }
      const myGen = ++gen.current;
      audio.src = withStreamAuth(`${streamUrlRef.current}?t=${Date.now()}`);
      audio.volume = volumeRef.current;
      setStatus('connecting');
      const p = audio.play();
      playPromise.current = p;
      Promise.resolve(p).catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
        if (gen.current === myGen && name !== 'AbortError') {
          console.error('Reconnect failed:', err);
        }
      });
    };

    const armWatchdog = (delay: number) => {
      if (!tunedInRef.current) return;
      clearWatchdog();
      // Sample the media clock so the fire below can tell "stream died" from
      // "bytes were late but playback never missed a beat".
      watchdogArmedAt.current = audioRef.current?.currentTime ?? 0;
      watchdogTimer.current = setTimeout(reconnect, delay);
    };

    const onPlaying = () => {
      clearWatchdog();
      retryCount.current = 0;
      setStatus('playing');
    };
    // 'waiting' is a PLAYBACK event: the element ran out of decoded audio and
    // has actually gone silent, so the UI should say so.
    const onWaiting = () => {
      setStatus(s => (s === 'playing' ? 'connecting' : s));
      armWatchdog(5000);
    };
    // 'stalled' is a NETWORK event — no bytes for ~3s — and on a live mount it
    // fires routinely while the element still has seconds of buffered audio
    // and keeps playing without a hitch (a proxied stream delivering in bursts
    // does it every few seconds). Playback never stopped, so no second
    // 'playing' event is ever coming: pinning the status here left the signal
    // badge on "Acquiring" for the whole session while audio played fine
    // (issue #1232). Arm the watchdog — a real dead mount also stalls — but
    // leave `status` alone and let the clock check at fire time decide.
    const onStalled = () => {
      armWatchdog(5000);
    };
    // Cheapest honest witness that sound is coming out: timeupdate fires
    // ~4x/s, but only while the clock actually moves. Reconciles a status left
    // on 'connecting' by any event sequence the two handlers above don't
    // model (browsers differ on when they re-emit 'playing').
    const onTimeUpdate = () => {
      if (el.paused || el.readyState < HAVE_FUTURE_DATA) return;
      setStatus(s => (s === 'connecting' ? 'playing' : s));
    };
    const onError = () => {
      setStatus('idle');
      // If the optional Opus mount errors (commonly a 404 when the operator
      // has disabled Opus server-side), fall back permanently to the universal
      // MP3 mount rather than reconnecting to the dead Opus URL on every retry.
      const { mp3, opus } = streamsRef.current;
      if (opus && streamUrlRef.current === opus) {
        opusFailedRef.current = true;
        streamUrlRef.current = mp3;
        setStreamUrl(mp3);
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount.current, RECONNECT_MAX_MS);
      retryCount.current += 1;
      armWatchdog(delay);
    };
    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onStalled);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('error', onError);
    return () => {
      clearWatchdog();
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onStalled);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('error', onError);
    };
  }, [audioEl]);

  // Idle cutoff (issue #343): a tab left tuned in with no listener activity
  // for IDLE_TUNE_OUT_MS gets tuned out, so an abandoned browser doesn't sit
  // on the mount as a phantom listener (keeping pause-when-empty's DJ gate
  // open around the clock). Activity = pointer, key, or the tab becoming
  // visible; the listener-driven entry points (tune, the consumer's controls)
  // all arrive as pointer/key events anyway. The sweep runs once a minute —
  // hour-scale cutoff, minute-scale precision is plenty.
  useEffect(() => {
    const markActivity = () => { lastActivityAt.current = Date.now(); };
    markActivity(); // seed: mount counts as the start of the idle window
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markActivity();
    };
    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    document.addEventListener('visibilitychange', onVisibility);
    const sweep = setInterval(() => {
      if (!tunedInRef.current) return;
      if (Date.now() - lastActivityAt.current < IDLE_TUNE_OUT_MS) return;
      setIdleStopped(true);
      stopRef.current();
    }, IDLE_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(sweep);
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Tear down playback. Used by the Tune Out button and by PlayerApp when the
  // station goes off air, so the <audio> element isn't left retrying a dead
  // mount.
  const stop = () => {
    if (!audioRef.current) return;
    const el = audioRef.current;
    const myGen = ++gen.current;
    if (watchdogTimer.current !== null) {
      clearTimeout(watchdogTimer.current);
      watchdogTimer.current = null;
    }
    setTunedIn(false);
    setStatus('idle');
    // Let any in-flight play() settle before pausing, then bail if a later
    // tune() has already superseded this teardown.
    Promise.resolve(playPromise.current)
      .catch(() => {})
      .then(() => {
        if (gen.current !== myGen) return;
        el.pause();
        el.src = '';
      });
  };
  stopRef.current = stop;

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      stop();
      return;
    }
    const el = audioRef.current;
    const myGen = ++gen.current;
    // A fresh tune-in is listener activity: restart the idle window, clear
    // any pending idle prompt, and let the reconnect backoff start small.
    lastActivityAt.current = Date.now();
    setIdleStopped(false);
    retryCount.current = 0;
    el.src = withStreamAuth(`${streamUrl}?t=${Date.now()}`);
    el.volume = volume;
    setTunedIn(true);
    setStatus('connecting');
    const p = el.play();
    playPromise.current = p;
    Promise.resolve(p).catch((err: unknown) => {
      // AbortError just means a later stop() interrupted this play — benign.
      const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
      if (gen.current === myGen && name !== 'AbortError') {
        console.error('Play failed:', err);
      }
    });
  };

  // Mute is just volume 0; toggling restores the last non-zero level so the
  // keyboard 'M' shortcut and the command palette have a sensible round-trip.
  const toggleMute = () => {
    if (volume > 0) {
      preMuteVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(preMuteVolume.current || 1);
    }
  };

  return { audioRef, attachAudio, tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted: volume === 0, idleStopped };
}
