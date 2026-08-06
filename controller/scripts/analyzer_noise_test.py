#!/usr/bin/env python3
# Unit tests for the analyzer worker's two #1300 additions: the decode-noise
# filter (bug 16a) and the capability-loss report (bug 3b). Pure stdlib — no
# torch, no librosa, no audio, no network — so it runs anywhere.
# Run: `python3 scripts/analyzer_noise_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# Why these two are pinned:
#
#   * The noise filter's failure modes are asymmetric. A benign line it fails
#     to match is cosmetic — one more line in a log. A real decode error it DOES
#     match is swallowed, and the operator loses the only evidence of why a
#     track won't analyse. So the "keeps" half of this file matters more than
#     the "drops" half.
#   * capability_loss is what finally tells the caller that a model failed to
#     load. It is reported through emit(), i.e. on EVERY message, precisely
#     because the failure it describes otherwise looks like success: a graceful
#     degrade answers ok=true with the audio_embedding field simply absent.

import io
import os
import sys

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


# --- the noise filter -------------------------------------------------------

# Verbatim from the #1300 report. Every one of these is normal operation on a
# file that analyses perfectly well.
BENIGN = [
    "[src/libmpg123/id3.c:process_comment():587] error: No comment text / valid description?",
    "[src/libmpg123/parse.c:wetwork():1349] error: Giving up resync after 1024 bytes",
    "Note: Illegal Audio-MPEG-Header 0x00000000 at offset 1234.",
    "Warning: Xing stream size off by more than 1%",
    "UserWarning: PySoundFile failed. Trying audioread instead.",
    "librosa/core/audio.py:184: FutureWarning: librosa.core.audio.__audioread_load"
    "\n\tDeprecated as of librosa version 0.10.0",
]

# Things that must survive. A worker log line, a Python traceback, an ffmpeg
# failure, an OOM — the whole reason the filter replays rather than discards.
KEPT = [
    "[analyze-worker] CLAP load failed (Connection refused); audio embeddings disabled for this run",
    "Traceback (most recent call last):",
    "MemoryError",
    "ffmpeg pre-decode failed (Invalid data found when processing input)",
    "soundfile.LibsndfileError: Error opening 'x.mp3': File contains data in an unknown format.",
    # The decisive cases: the filter keys on the MESSAGE, never on who emitted
    # it. A libmpg123 line whose text nobody has catalogued is exactly the line
    # the replay exists for — matching the `[src/libmpg123/...]` header alone
    # would eat it, and every future libmpg123 error with it.
    "[src/libmpg123/parse.c] this line is new to us",
    "[src/libmpg123/readers.c:bad_read():99] error: Cannot read the whole file",
    # A real librosa warning, from the same module as the benign ones. An n_fft
    # wider than the signal is how a truncated file announces itself.
    "librosa/core/spectrum.py:257: UserWarning: n_fft=2048 is too large for input signal of length=512",
]


def test_benign_lines_are_noise():
    for line in BENIGN:
        for part in line.splitlines():
            assert aw.is_decoder_noise(part), f"not matched: {part!r}"


def test_real_errors_survive():
    for line in KEPT:
        assert not aw.is_decoder_noise(line), f"wrongly swallowed: {line!r}"


def test_blank_lines_are_dropped():
    assert aw.is_decoder_noise("")
    assert aw.is_decoder_noise("   ")


def test_capture_replays_only_what_matters():
    # The mechanism, end to end: fd 2 is captured across a "decode", and what
    # comes back out is everything that wasn't recognised chatter — in order.
    saved = sys.stderr
    sys.stderr = io.StringIO()
    try:
        with aw.quiet_decoder_noise():
            os.write(2, b"Note: Illegal Audio-MPEG-Header 0x00000000 at offset 9\n")
            os.write(2, b"MemoryError: out of memory\n")
            os.write(2, b"[src/libmpg123/parse.c:wetwork():1349] error: Giving up resync\n")
        out = sys.stderr.getvalue()
    finally:
        sys.stderr = saved
    assert "MemoryError" in out, f"real error was swallowed: {out!r}"
    assert "Illegal Audio-MPEG-Header" not in out, f"noise leaked: {out!r}"
    assert "libmpg123" not in out, f"noise leaked: {out!r}"


def test_verbose_escape_hatch_passes_everything_through():
    # ANALYZE_VERBOSE_DECODER=1 must restore the raw firehose — a filter with no
    # way to turn it off is a filter you can't debug through.
    original = aw.VERBOSE_DECODER
    aw.VERBOSE_DECODER = True
    saved = sys.stderr
    sys.stderr = io.StringIO()
    try:
        with aw.quiet_decoder_noise():
            sys.stderr.write("Note: Illegal Audio-MPEG-Header 0x0 at offset 9\n")
        out = sys.stderr.getvalue()
    finally:
        sys.stderr = saved
        aw.VERBOSE_DECODER = original
    assert "Illegal Audio-MPEG-Header" in out, "verbose mode still filtered"


# --- the capability report --------------------------------------------------


def test_no_loss_reported_when_nothing_failed():
    # The common case, and it must stay byte-identical on the wire: no key.
    assert aw.capability_loss() == {}


def test_loss_names_the_capability_and_the_reason():
    original = (aw._embed_failed, aw._embed_error, aw._vocal_failed, aw._vocal_error)
    try:
        aw._embed_failed = True
        aw._embed_error = "model weights could not be downloaded: Connection refused"
        lost = aw.capability_loss()
        assert set(lost) == {"audio_embedding"}, lost
        assert "Connection refused" in lost["audio_embedding"]

        aw._vocal_failed = True
        aw._vocal_error = None  # a failure with no captured reason still reports
        lost = aw.capability_loss()
        assert set(lost) == {"audio_embedding", "vocal_activity"}, lost
        assert lost["vocal_activity"], "an unexplained failure must still be reported"
    finally:
        (aw._embed_failed, aw._embed_error, aw._vocal_failed, aw._vocal_error) = original


def test_loss_rides_on_every_emitted_message():
    # Not just the ready line: the failure this describes shows up mid-run, on a
    # response that otherwise looks entirely successful.
    original = (aw._embed_failed, aw._embed_error)
    out = io.StringIO()
    saved = sys.stdout
    sys.stdout = out
    try:
        aw._embed_failed = True
        aw._embed_error = "no weights"
        aw.emit({"id": "a1", "ok": True, "bpm": 120})
    finally:
        sys.stdout = saved
        (aw._embed_failed, aw._embed_error) = original
    import json

    msg = json.loads(out.getvalue())
    assert msg["ok"] is True, "the analysis itself still succeeded"
    assert msg["capability_loss"]["audio_embedding"] == "no weights"


def test_offline_failures_are_summarised_as_a_download_problem():
    # The reported error, verbatim. It must come back naming the cause rather
    # than echoing a urllib trace — this string ends up in the admin panel.
    summary = aw.summarize_load_error(
        Exception(
            "'[Errno 111] Connection refused' thrown while requesting HEAD "
            "https://huggingface.co/laion/clap-htsat-unfused/resolve/main/model.safetensors"
        )
    )
    assert "could not be downloaded" in summary, summary
    assert "huggingface.co" in summary


def test_other_failures_pass_through_bounded():
    # A wrong-but-specific reason beats a generic one, so anything unrecognised
    # is passed through — trimmed, because tracebacks land here.
    summary = aw.summarize_load_error(RuntimeError("CUDA out of memory"))
    assert summary == "CUDA out of memory"
    assert len(aw.summarize_load_error(RuntimeError("x" * 900))) == 240
    # An exception with an empty message still says something.
    assert aw.summarize_load_error(SystemExit()) == "SystemExit"


print("analyzer noise + capability report:")
test("benign decoder chatter is recognised", test_benign_lines_are_noise)
test("real errors are never swallowed", test_real_errors_survive)
test("blank lines are dropped", test_blank_lines_are_dropped)
test("fd-2 capture replays only what matters", test_capture_replays_only_what_matters)
test("ANALYZE_VERBOSE_DECODER restores everything", test_verbose_escape_hatch_passes_everything_through)
test("nothing is reported when nothing failed", test_no_loss_reported_when_nothing_failed)
test("a loss names the capability and the reason", test_loss_names_the_capability_and_the_reason)
test("the loss rides on every emitted message", test_loss_rides_on_every_emitted_message)
test("an offline load failure is summarised as a download problem", test_offline_failures_are_summarised_as_a_download_problem)
test("other load failures pass through, bounded", test_other_failures_pass_through_bounded)

if failures:
    print(f"✗ analyzer_noise_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_noise_test.py passed")
