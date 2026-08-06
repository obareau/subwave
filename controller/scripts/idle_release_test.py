#!/usr/bin/env python3
# Unit test for the idle model release in analyze_worker (#1099 follow-up, CPU
# arming per #1204) — the mechanism that hands CLAP/Demucs memory back instead
# of leaving multiple GB resident for the life of the worker. Pure stdlib: no
# torch, no demucs, no audio, no network, so it runs anywhere.
# Run: `python3 scripts/idle_release_test.py` (exit 0 = pass).
#
# What this pins down, in the order it matters:
#   - the models are released, and the *_failed flags are NOT set, so the next
#     request reloads rather than silently no-opping forever;
#   - the release arms on cpu (the #1204 regression) as well as cuda;
#   - the countdown is driven by a HEAVY-use clock, not a general request clock.
#     That last one is the subtle half of #1204: while the clock was shared, a
#     station with steady lean bpm/key traffic would refresh it on every request
#     and the release would only ever fire on an idle box.

import os
import sys

# Import the worker with its shipped defaults. Heavy imports (torch/demucs/
# librosa) are lazy, so importing is stdlib-cheap.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


class FakeModel:
    """Stands in for a loaded ClapEmbedder / VocalActivityDetector. Never
    constructs a real model — the point is the release bookkeeping."""


def reset(embedder=None, detector=None, armed=False, heavy_age_s=0.0):
    """Put the worker's module-level release state in a known shape."""
    import time as _t

    aw._embedder = embedder
    aw._vocal_detector = detector
    aw._embed_failed = False
    aw._vocal_failed = False
    aw._idle_thread_started = armed
    aw._heavy_last_used = _t.time() - heavy_age_s


def with_device(device, fn):
    """Run fn with resolve_device() stubbed — the real one imports torch."""
    saved = aw.resolve_device
    try:
        aw.resolve_device = lambda: device
        return fn()
    finally:
        aw.resolve_device = saved


def with_env(value, fn):
    """Run fn with the ANALYZE_IDLE_UNLOAD_S override set to `value` (None =
    unset, i.e. fall through to the per-device default)."""
    saved = aw._IDLE_UNLOAD_ENV
    try:
        aw._IDLE_UNLOAD_ENV = "" if value is None else value
        return fn()
    finally:
        aw._IDLE_UNLOAD_ENV = saved


def main():
    print("idle model release (analyze_worker):")

    # ── Release drops both singletons, keeps the failure flags clear ──────────
    # The *_failed flags are the "never retry this load" latch. A release must
    # not trip them, or one idle window would permanently disable embeddings
    # for the life of the process.
    def case_release_both():
        reset(embedder=FakeModel(), detector=FakeModel())
        aw._release_models()
        assert aw._embedder is None, "CLAP singleton must be dropped"
        assert aw._vocal_detector is None, "Demucs singleton must be dropped"
        assert aw._embed_failed is False, "release must NOT latch the CLAP failure flag"
        assert aw._vocal_failed is False, "release must NOT latch the Demucs failure flag"

    test("releases both models without latching the failure flags", case_release_both)

    # A release drops whichever singleton is loaded; the absent one stays None
    # (there is no third state — a release can't resurrect or latch anything).
    def case_release_one():
        reset(embedder=None, detector=FakeModel())
        aw._release_models()
        assert aw._vocal_detector is None, "the loaded detector is released"
        assert aw._embed_failed is False, "the absent embedder's flag stays clear"

        reset(embedder=FakeModel(), detector=None)
        aw._release_models()
        assert aw._embedder is None, "the loaded embedder is released"
        assert aw._vocal_failed is False, "the absent detector's flag stays clear"

    test("releases whichever models are loaded", case_release_one)

    # Nothing loaded → early return, no log, no trim.
    def case_release_noop():
        reset(embedder=None, detector=None)
        assert aw._release_models() is None, "no-op release returns cleanly"

    test("release with nothing loaded is a clean no-op", case_release_noop)

    # ── malloc_trim is reached and never propagates a failure ────────────────
    # It's a no-op off glibc (musl, macOS), so it must be swallowed. Force the
    # failure by pointing ctypes.CDLL at something that raises.
    def case_trim_safe():
        import ctypes as _c

        saved = _c.CDLL
        try:
            def boom(*_a, **_k):
                raise OSError("no libc handle here")

            _c.CDLL = boom
            reset(embedder=FakeModel(), detector=FakeModel())
            aw._release_models()  # must not raise
            assert aw._embedder is None, "release still completes when trim is unavailable"
        finally:
            _c.CDLL = saved

    test("malloc_trim failure is swallowed (non-glibc hosts)", case_trim_safe)

    # ── Arming: the #1204 regression ─────────────────────────────────────────
    # Pre-#1204 the guard was `resolve_device() != "cuda"`, so a CPU host never
    # armed and a backfill's models sat resident until the container stopped.
    def case_arms_on_cpu():
        reset(armed=False)
        with_device("cpu", lambda: with_env(None, aw._maybe_start_idle_release))
        assert aw._idle_thread_started is True, "#1204: the release must arm on cpu"

    test("arms on cpu (#1204)", case_arms_on_cpu)

    def case_arms_on_cuda():
        reset(armed=False)
        with_device("cuda", lambda: with_env(None, aw._maybe_start_idle_release))
        assert aw._idle_thread_started is True, "cuda must keep arming as before"

    test("still arms on cuda", case_arms_on_cuda)

    def case_disabled():
        reset(armed=False)
        with_device("cpu", lambda: with_env("0", aw._maybe_start_idle_release))
        assert aw._idle_thread_started is False, "0 must disable the release entirely"

    test("ANALYZE_IDLE_UNLOAD_S=0 does not arm", case_disabled)

    def case_arms_once():
        reset(armed=True)
        with_device("cpu", lambda: with_env(None, aw._maybe_start_idle_release))
        assert aw._idle_thread_started is True, "already-armed stays armed, no second thread"

    test("arming is idempotent", case_arms_once)

    # ── The idle window ─────────────────────────────────────────────────────
    def case_window_defaults():
        cuda = with_device("cuda", lambda: with_env(None, aw._idle_unload_seconds))
        cpu = with_device("cpu", lambda: with_env(None, aw._idle_unload_seconds))
        assert cuda == aw.IDLE_UNLOAD_CUDA_S, f"cuda default, got {cuda}"
        assert cpu == aw.IDLE_UNLOAD_CPU_S, f"cpu default, got {cpu}"
        assert cpu > cuda, (
            "cpu window must be the longer one: a cold CPU reload lands on "
            "interactive sound search (20s deadline), and swap pressure is not "
            "as urgent as a starved GPU"
        )

    test("idle window defaults per device, cpu longer", case_window_defaults)

    def case_window_env_wins():
        for device in ("cpu", "cuda"):
            got = with_device(device, lambda: with_env("42", aw._idle_unload_seconds))
            assert got == 42.0, f"explicit env must win on {device}, got {got}"

    test("ANALYZE_IDLE_UNLOAD_S overrides both devices", case_window_env_wins)

    def case_window_garbage():
        got = with_device("cpu", lambda: with_env("not-a-number", aw._idle_unload_seconds))
        assert got == aw.IDLE_UNLOAD_CPU_S, "garbage env falls back to the default, never crashes"

    test("unparseable idle window falls back to the default", case_window_garbage)

    # ── The heavy clock, i.e. the other half of #1204 ────────────────────────
    # A lean bpm/key request must not refresh the countdown. If it does, any
    # station with steady analysis traffic pins CLAP+Demucs forever and the
    # gate removal above buys nothing.
    def case_lean_request_does_not_refresh():
        # A lean bpm/key pass reaches the getters exactly like analyze() does —
        # get_embedder(force=False) / get_vocal_detector(force=False) with the
        # env flags off — and must bounce off the early return BEFORE the
        # _touch_heavy() stamp. This is the precise call shape of the #1204
        # traffic that pinned the models forever under the shared clock.
        reset(heavy_age_s=600.0)
        stale = aw._heavy_last_used
        saved = aw.EMBED_ENABLED, aw.VOCAL_ENABLED
        try:
            aw.EMBED_ENABLED = False
            aw.VOCAL_ENABLED = False
            assert aw.get_embedder(force=False) is None, "lean pass loads no embedder"
            assert aw.get_vocal_detector(force=False) is None, "lean pass loads no detector"
        finally:
            aw.EMBED_ENABLED, aw.VOCAL_ENABLED = saved
        aw._release_models()  # nothing loaded → no-op, must not stamp either
        assert aw._heavy_last_used == stale, (
            "#1204: a request that loads no model must not refresh the heavy clock"
        )

    test("lean request does not refresh the heavy clock (#1204)", case_lean_request_does_not_refresh)

    def case_heavy_use_refreshes():
        reset(heavy_age_s=600.0)
        stale = aw._heavy_last_used
        aw._touch_heavy()
        assert aw._heavy_last_used > stale, "heavy use must refresh the countdown"

    test("heavy use refreshes the clock", case_heavy_use_refreshes)

    # get_embedder stamps the clock on a CACHE HIT, not just a fresh load —
    # otherwise a long backfill could release mid-pass while still in use.
    def case_cache_hit_stamps():
        reset(embedder=FakeModel(), heavy_age_s=600.0)
        stale = aw._heavy_last_used
        got = aw.get_embedder(force=True)
        assert got is not None, "a cached embedder is returned as-is"
        assert aw._heavy_last_used > stale, (
            "a cache hit must refresh the clock, or a long pass could release mid-use"
        )

    test("get_embedder cache hit refreshes the clock", case_cache_hit_stamps)

    def case_detector_cache_hit_stamps():
        reset(detector=FakeModel(), heavy_age_s=600.0)
        stale = aw._heavy_last_used
        got = aw.get_vocal_detector(force=True)
        assert got is not None, "a cached detector is returned as-is"
        assert aw._heavy_last_used > stale, "a cache hit must refresh the clock"

    test("get_vocal_detector cache hit refreshes the clock", case_detector_cache_hit_stamps)

    # A disabled/failed getter must not stamp the clock — it did no heavy work.
    def case_declined_getter_does_not_stamp():
        reset(heavy_age_s=600.0)
        aw._embed_failed = True
        stale = aw._heavy_last_used
        assert aw.get_embedder(force=True) is None, "a latched failure returns None"
        assert aw._heavy_last_used == stale, "a declined getter must not refresh the clock"

    test("declined getter does not refresh the clock", case_declined_getter_does_not_stamp)

    print("✓ idle_release_test.py passed" if not failures else f"✗ {failures} case(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
