"""
subwave-tts-heavy — optional Chatterbox + PocketTTS sidecar for SUB/WAVE.

The controller (audio/chatterbox.ts, audio/pocketTts.ts) talks to this over
HTTP when TTS_HEAVY_URL is set. A thin FastAPI shim over two long-lived
subprocesses — the SAME stdio workers the controller runs in-process
(controller/scripts/{chatterbox,pocket_tts}_worker.py), one venv each because
the two packages have incompatible pip resolutions. One JSON object per line
over stdin/stdout; an asyncio.Lock per worker serialises requests. No audio
over the wire — the sidecar writes the WAV to the absolute `out` path on the
shared /var/sub-wave volume and the controller hands that path to Liquidsoap.

Endpoints:
  GET  /health   → {ok, engines, chatterbox_loaded, pocket_loaded}
  POST /speak    → {ok, path, duration_s}
    body: {engine, text, voice?, reference_wav?, out}
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

CHATTERBOX_PYTHON = os.environ.get("CHATTERBOX_PYTHON", "/opt/chatterbox/venv/bin/python")
CHATTERBOX_WORKER = os.environ.get("CHATTERBOX_WORKER", "/app/workers/chatterbox_worker.py")
POCKET_TTS_PYTHON = os.environ.get("POCKET_TTS_PYTHON", "/opt/pocket-tts/venv/bin/python")
POCKET_TTS_WORKER = os.environ.get("POCKET_TTS_WORKER", "/app/workers/pocket_tts_worker.py")

DEVICE = os.environ.get("TTS_HEAVY_DEVICE", "cpu").lower()
POCKET_TTS_DEFAULT_VOICE = os.environ.get("POCKET_TTS_VOICE", "alba")

# Per-worker HF cache homes so the engines don't fight over one directory;
# each is a named volume in compose, so first-boot weight downloads survive
# recreates. Passed into each worker's env via env_extra.
CHATTERBOX_HF_HOME = os.environ.get("CHATTERBOX_HF_HOME", "/opt/chatterbox/hf-cache")
POCKET_HF_HOME = os.environ.get("POCKET_HF_HOME", "/opt/pocket-tts/hf-cache")

# Max bytes of one worker stdout line. TTS responses are small, but keep in
# step with the analyzer sidecar so a future payload can't hit asyncio's
# 64 KiB default and LimitOverrunError (#996).
WORKER_STDOUT_LIMIT = 16 * 1024 * 1024

# Which engines to load. BOTH are baked into the image, but each costs RAM +
# a multi-GB first-boot download + 30-60s startup, so operators can narrow the
# comma-separated list. Unknown/empty entries are ignored; an empty result
# falls back to both so a typo never silently disables all TTS.
_ALL_ENGINES = ("chatterbox", "pocket-tts")
ENABLED_ENGINES = [
    e
    for e in (
        s.strip().lower()
        for s in os.environ.get("TTS_HEAVY_ENGINES", "chatterbox,pocket-tts").split(",")
    )
    if e in _ALL_ENGINES
]
if not ENABLED_ENGINES:
    ENABLED_ENGINES = list(_ALL_ENGINES)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("tts-heavy")


class TtsWorker:
    """Async wrapper around a long-lived stdio TTS worker subprocess.

    One JSON object per line over stdin/stdout (the same protocol as the
    controller's in-process TS clients); no multiplexing — one request in
    flight per worker, gated by a lock. run() supervises the lifecycle:
    start → wait-for-exit → respawn with a short backoff, so a crash (OOM,
    fatal model error) recovers without bouncing the container.
    """

    # START_BACKOFF applies when start() itself fails (model load error,
    # missing venv); RUN_BACKOFF when the worker exited after a clean start.
    START_BACKOFF_S = 5.0
    RUN_BACKOFF_S = 2.0

    def __init__(self, name: str, python: str, script: str, env_extra: dict[str, str] | None = None):
        self.name = name
        self.python = python
        self.script = script
        self.env_extra = env_extra or {}
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.ready = False
        # Ready message minus the `ready` flag — per-engine capability
        # metadata (e.g. pocket-tts' voice_cloning, #238). Cleared on restart.
        self.ready_meta: dict[str, Any] = {}

    async def run(self) -> None:
        """Keep the worker alive forever; on cancellation (lifespan teardown)
        terminate the running subprocess before bubbling up."""
        try:
            while True:
                try:
                    await self.start()
                except Exception as e:
                    log.error(f"[{self.name}] start failed: {e}")
                    self._reset()
                    await asyncio.sleep(self.START_BACKOFF_S)
                    continue
                assert self.proc is not None
                code = await self.proc.wait()
                log.warning(
                    f"[{self.name}] worker exited with code={code}; restarting in {self.RUN_BACKOFF_S}s",
                )
                self._reset()
                await asyncio.sleep(self.RUN_BACKOFF_S)
        except asyncio.CancelledError:
            self._terminate()
            raise

    def _reset(self) -> None:
        self.ready = False
        self.proc = None
        self.ready_meta = {}

    def _terminate(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    async def start(self) -> None:
        log.info(f"[{self.name}] starting worker: {self.python} {self.script}")
        env = {**os.environ, **self.env_extra}
        self.proc = await asyncio.create_subprocess_exec(
            self.python,
            self.script,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            limit=WORKER_STDOUT_LIMIT,
        )
        # Pump stderr to our log so model load progress / fatal errors land in
        # the container logs. Exits when the worker closes stderr on death.
        asyncio.create_task(self._pump_stderr())

        # Read until {"ready": true}, skipping non-JSON stdout noise (perth —
        # chatterbox's watermarker — bare-print()s a load message). Chatterbox
        # can take 30+ seconds even from a warm cache, so no timeout — run()'s
        # restart loop is the upstream safety net.
        try:
            msg = await self._await_message()
            if msg.get("fatal"):
                raise RuntimeError(f"[{self.name}] fatal: {msg.get('error')}")
            if not msg.get("ready"):
                raise RuntimeError(f"[{self.name}] expected ready, got: {msg}")
        except Exception:
            # Terminate the half-booted process so run() doesn't pile orphans
            # up across retry cycles.
            self._terminate()
            raise
        self.ready_meta = {k: v for k, v in msg.items() if k != "ready"}
        log.info(f"[{self.name}] ready {self.ready_meta or ''}".rstrip())
        self.ready = True

    async def _await_message(self) -> dict[str, Any]:
        """Read worker stdout until a parseable JSON object arrives."""
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"[{self.name}] worker exited before message")
            text = line.decode().strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                # Noise from a transitive dep — visible but not a protocol
                # failure.
                log.info(f"[{self.name}] non-JSON on stdout: {text!r}")
                continue
            return msg

    async def _pump_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        proc = self.proc
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            log.info(f"[{self.name}] {line.decode().rstrip()}")

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            # Fail fast when the worker is down — the controller's dispatcher
            # falls back to Piper, preferable to blocking the HTTP request on
            # an unhealthy worker.
            if not self.ready or not self.proc or self.proc.returncode is not None:
                raise RuntimeError(f"[{self.name}] worker not ready")
            assert self.proc.stdin
            req = json.dumps(payload, ensure_ascii=False)
            self.proc.stdin.write((req + "\n").encode())
            await self.proc.stdin.drain()
            # _await_message skips post-ready print() noise too — without
            # that, any stray stdout would crash the next /speak call.
            return await self._await_message()


chatterbox_worker = TtsWorker(
    name="chatterbox",
    python=CHATTERBOX_PYTHON,
    script=CHATTERBOX_WORKER,
    env_extra={
        "CHATTERBOX_DEVICE": DEVICE,
        "CHATTERBOX_REFERENCE_WAV": os.environ.get("CHATTERBOX_REFERENCE_WAV", ""),
        "HF_HOME": CHATTERBOX_HF_HOME,
    },
)

pocket_worker = TtsWorker(
    name="pocket-tts",
    python=POCKET_TTS_PYTHON,
    script=POCKET_TTS_WORKER,
    env_extra={
        "POCKET_TTS_VOICE": POCKET_TTS_DEFAULT_VOICE,
        "HF_HOME": POCKET_HF_HOME,
    },
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background tasks so uvicorn binds :8080 immediately — chatterbox's
    # 30-60s cold load would otherwise block the bind and the controller's
    # probe would see "connection refused" for the entire boot.
    log.info(f"enabled engines: {', '.join(ENABLED_ENGINES)}")
    tasks = []
    if "chatterbox" in ENABLED_ENGINES:
        tasks.append(asyncio.create_task(chatterbox_worker.run(), name="chatterbox-run"))
    if "pocket-tts" in ENABLED_ENGINES:
        tasks.append(asyncio.create_task(pocket_worker.run(), name="pocket-tts-run"))
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        # Let the supervisors terminate their subprocesses before uvicorn
        # exits; the container-stop SIGKILL is the fallback if this hangs.
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="subwave-tts-heavy", lifespan=lifespan)


class SpeakRequest(BaseModel):
    engine: str
    text: str
    voice: str = ""
    reference_wav: str = ""
    out: str


@app.get("/health")
async def health():
    # `engines` lists engines *currently ready*, not the static set — the
    # controller's probe (audio/ttsHeavyClient.ts) keys readiness on
    # `engines.includes(<name>)`, so advertising a still-booting or crashed
    # engine would cause failed /speak calls instead of clean fall-throughs
    # to Piper. The *_loaded booleans are operator diagnostics.
    ready_engines: list[str] = []
    if chatterbox_worker.ready:
        ready_engines.append("chatterbox")
    if pocket_worker.ready:
        ready_engines.append("pocket-tts")
    return {
        "ok": True,
        "engines": ready_engines,
        # What TTS_HEAVY_ENGINES asked for, regardless of load state.
        "enabled": ENABLED_ENGINES,
        "chatterbox_loaded": chatterbox_worker.ready,
        "pocket_loaded": pocket_worker.ready,
        # PocketTTS zero-shot cloning capability — false when the gated
        # weights weren't available at load (no HF_TOKEN), so cloned .wav
        # voices don't silently revert to a built-in (#238). None until ready.
        "pocket_voice_cloning": (
            pocket_worker.ready_meta.get("voice_cloning") if pocket_worker.ready else None
        ),
    }


@app.post("/speak")
async def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    if not req.out:
        raise HTTPException(400, "missing 'out' path")
    Path(req.out).parent.mkdir(parents=True, exist_ok=True)

    # A known engine this sidecar was told not to load: fail clearly so the
    # dispatcher falls back to Piper instead of blocking on a worker that
    # will never become ready.
    if req.engine in _ALL_ENGINES and req.engine not in ENABLED_ENGINES:
        raise HTTPException(
            503,
            f"engine '{req.engine}' is disabled on this sidecar "
            f"(TTS_HEAVY_ENGINES={','.join(ENABLED_ENGINES)})",
        )

    if req.engine == "chatterbox":
        msg = await chatterbox_worker.request({
            "id": "1",
            "text": text,
            "reference_wav": req.reference_wav or "",
            "out": req.out,
        })
    elif req.engine == "pocket-tts":
        msg = await pocket_worker.request({
            "id": "1",
            "text": text,
            "voice": req.voice or POCKET_TTS_DEFAULT_VOICE,
            # Reference WAV for zero-shot cloning (#213); the worker treats an
            # empty value as "use the built-in voice".
            "reference_wav": req.reference_wav or "",
            "out": req.out,
        })
    else:
        raise HTTPException(400, f"unknown engine: {req.engine}")

    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "worker failed")
    return {
        "ok": True,
        "path": msg["path"],
        "duration_s": msg.get("duration_s", 0),
        # PocketTTS' per-call voice substitution (#238) so the controller can
        # log when the requested voice/clone wasn't honoured. Absent for
        # engines that don't report it.
        "voice_used": msg.get("voice_used"),
        "fell_back": msg.get("fell_back", False),
        "fell_back_reason": msg.get("fell_back_reason"),
    }
