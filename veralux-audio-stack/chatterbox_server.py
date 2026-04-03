"""
HTTP TTS server for Resemble AI Chatterbox (https://github.com/resemble-ai/chatterbox).

## Architecture (multi-lane)

- **Lanes** = Gunicorn worker processes (`CHATTERBOX_GUNICORN_WORKERS`). Each worker loads one model
  copy (VRAM × workers). The master distributes incoming connections across workers.
- **Within one worker**: `asyncio.Semaphore(1)` — the model is not thread-safe; one synthesis at a time.
- **Queue wait** = time waiting on that semaphore (other requests in same worker). Cross-worker queuing
  is handled by the kernel / Gunicorn accept queue.

## Endpoints

- `POST /tts` — full utterance, single WAV (default; backward compatible).
- `POST /tts/stream` — sentence-chunked synthesis, binary stream (see `VLX1` below). Improves
  time-to-first-byte for long text; short lines behave like one chunk.

## Env (see also docs/chatterbox-architecture.md)

  CHATTERBOX_VARIANT, CHATTERBOX_DEVICE, CHATTERBOX_DEFAULT_AUDIO_PROMPT,
  CHATTERBOX_MAX_TEXT_CHARS, RATE_LIMIT_PER_MINUTE, CHATTERBOX_MAX_CONCURRENT,
  CHATTERBOX_SPEAKER_CACHE_DIR, CHATTERBOX_CUDA_WARMUP,
  CHATTERBOX_PRELOAD_SPEAKER_URLS (comma-separated),
  CHATTERBOX_STREAM_MAX_SEGMENTS (default 8),
  CHATTERBOX_GUNICORN_WORKERS (Docker CMD only)
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import re
import tempfile
import time
import urllib.request
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger("chatterbox_server")

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "30")
limiter = Limiter(key_func=get_remote_address)

VARIANT = os.getenv("CHATTERBOX_VARIANT", "turbo").strip().lower()
DEVICE = os.getenv("CHATTERBOX_DEVICE", "cuda").strip().lower()
DEFAULT_PROMPT_PATH = os.getenv("CHATTERBOX_DEFAULT_AUDIO_PROMPT", "").strip() or None
MAX_TEXT = int(os.getenv("CHATTERBOX_MAX_TEXT_CHARS", "1500"))
MAX_CONCURRENT = int(os.getenv("CHATTERBOX_MAX_CONCURRENT", "1"))
SPEAKER_CACHE_DIR = os.getenv("CHATTERBOX_SPEAKER_CACHE_DIR", "/tmp/chatterbox_speaker_cache").strip()
STREAM_MAX_SEGMENTS = max(1, int(os.getenv("CHATTERBOX_STREAM_MAX_SEGMENTS", "8")))
WORKER_PID = os.getpid()

# Within one worker process, only one synthesis at a time (shared MODEL is not thread-safe).
tts_semaphore = asyncio.Semaphore(max(1, MAX_CONCURRENT))

MODEL: Any = None

# Magic for chunked stream: "VLX1" + repeated u32be(len) + wav bytes
STREAM_MAGIC = b"VLX1"


def _safe_exc_detail(exc: BaseException, max_len: int = 400) -> str:
    s = str(exc).strip().replace("\n", " ").replace("\r", " ")
    if len(s) > max_len:
        return s[: max_len - 1] + "…"
    return s


def _load_model() -> Any:
    global MODEL
    if MODEL is not None:
        return MODEL
    logger.info("Loading Chatterbox variant=%s device=%s pid=%s", VARIANT, DEVICE, WORKER_PID)
    if VARIANT == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        MODEL = ChatterboxTurboTTS.from_pretrained(device=DEVICE)
    elif VARIANT == "multilingual":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        MODEL = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)
    else:
        from chatterbox.tts import ChatterboxTTS

        MODEL = ChatterboxTTS.from_pretrained(device=DEVICE)
    return MODEL


def _tensor_to_wav_bytes(wav: Any, sample_rate: int) -> bytes:
    try:
        import torch

        if isinstance(wav, torch.Tensor):
            x = wav.detach().cpu().float().numpy()
        else:
            x = np.asarray(wav, dtype=np.float32)
    except Exception:
        x = np.asarray(wav, dtype=np.float32)
    if x.ndim > 1:
        x = np.squeeze(x)
    if x.ndim != 1:
        x = x.flatten()
    buf = io.BytesIO()
    sf.write(buf, x, int(sample_rate), subtype="PCM_16", format="WAV")
    return buf.getvalue()


def _download_wav_to_path(url: str, dest_path: str, timeout: int = 30) -> None:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "VeraLux-Chatterbox-TTS/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    if len(data) < 100:
        raise ValueError("downloaded file too small")
    with open(dest_path, "wb") as f:
        f.write(data)


def _speaker_cache_path(url: str) -> str:
    key = hashlib.sha256(url.strip().encode("utf-8")).hexdigest()
    os.makedirs(SPEAKER_CACHE_DIR, exist_ok=True)
    return os.path.join(SPEAKER_CACHE_DIR, f"{key}.wav")


def _resolve_speaker_path(url: str) -> tuple[str, bool]:
    """
    Returns (path, should_unlink_after_request).
    Cached files are never unlinked by the caller.
    """
    cache_file = _speaker_cache_path(url)
    if os.path.isfile(cache_file) and os.path.getsize(cache_file) > 100:
        logger.info(
            "chatterbox_speaker_cache_hit url_hash=%s path=%s pid=%s",
            hashlib.sha256(url.strip().encode()).hexdigest()[:12],
            cache_file,
            WORKER_PID,
        )
        return cache_file, False

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav", dir=SPEAKER_CACHE_DIR)
    os.close(tmp_fd)
    try:
        _download_wav_to_path(url.strip(), tmp_path)
        os.replace(tmp_path, cache_file)
        logger.info("chatterbox_speaker_cached pid=%s path=%s", WORKER_PID, cache_file)
        return cache_file, False
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _download_wav_temp(url: str, timeout: int = 30) -> str:
    """Legacy one-off download (temp file, caller deletes)."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "VeraLux-Chatterbox-TTS/1.0"},
    )
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if len(data) < 100:
            raise ValueError("downloaded file too small")
        with open(path, "wb") as f:
            f.write(data)
        return path
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise


def _synthesize(text: str, speaker_path: Optional[str], language_id: Optional[str]) -> bytes:
    model = _load_model()
    sr = int(getattr(model, "sr", getattr(model, "sample_rate", 24000)))

    if VARIANT == "turbo":
        prompt = speaker_path or DEFAULT_PROMPT_PATH
        if not prompt:
            raise ValueError(
                "turbo_requires_reference: set speaker_wav_url or CHATTERBOX_DEFAULT_AUDIO_PROMPT"
            )
        wav = model.generate(text, audio_prompt_path=prompt)
        return _tensor_to_wav_bytes(wav, sr)

    if VARIANT == "multilingual":
        lang = (language_id or "en").strip()
        if speaker_path:
            try:
                wav = model.generate(text, language_id=lang, audio_prompt_path=speaker_path)
            except TypeError:
                wav = model.generate(text, language_id=lang)
        else:
            wav = model.generate(text, language_id=lang)
        return _tensor_to_wav_bytes(wav, sr)

    if speaker_path:
        wav = model.generate(text, audio_prompt_path=speaker_path)
    else:
        wav = model.generate(text)
    return _tensor_to_wav_bytes(wav, sr)


def _segments_for_stream(text: str, max_segments: int) -> list[str]:
    """Split for chunked streaming (Turbo). Coarse split on sentence end punctuation."""
    t = text.strip()
    if not t:
        return []
    parts = re.split(r"(?<=[.!?])\s+", t)
    segs = [p.strip() for p in parts if p.strip()]
    if not segs:
        return [t]
    if len(segs) == 1:
        return segs
    if len(segs) > max_segments:
        head = segs[: max_segments - 1]
        tail = " ".join(segs[max_segments - 1 :])
        segs = head + [tail]
    return segs


def _tts_log(
    event: str,
    request_id: str,
    *,
    queue_wait_ms: float | None = None,
    synth_ms: float | None = None,
    total_ms: float | None = None,
    ttfc_ms: float | None = None,
    segments: int | None = None,
    text_len: int | None = None,
    priority: int | None = None,
    extra: str | None = None,
) -> None:
    payload = {
        "event": event,
        "request_id": request_id,
        "worker_pid": WORKER_PID,
        "variant": VARIANT,
    }
    if queue_wait_ms is not None:
        payload["queue_wait_ms"] = round(queue_wait_ms, 2)
    if synth_ms is not None:
        payload["synthesize_ms"] = round(synth_ms, 2)
    if total_ms is not None:
        payload["total_ms"] = round(total_ms, 2)
    if ttfc_ms is not None:
        payload["time_to_first_chunk_ms"] = round(ttfc_ms, 2)
    if segments is not None:
        payload["segments"] = segments
    if text_len is not None:
        payload["text_len"] = text_len
    if priority is not None:
        payload["priority"] = priority
    if extra:
        payload["detail"] = extra
    logger.info("chatterbox_tts %s", payload)


def _preload_speakers() -> None:
    raw = os.getenv("CHATTERBOX_PRELOAD_SPEAKER_URLS", "").strip()
    if not raw or not SPEAKER_CACHE_DIR.strip():
        return
    for url in [u.strip() for u in raw.split(",") if u.strip()]:
        try:
            _resolve_speaker_path(url)
            logger.info("chatterbox_preload_speaker ok pid=%s", WORKER_PID)
        except Exception as e:
            logger.warning("chatterbox_preload_speaker failed url=%s err=%s", url[:80], e)


async def _cuda_warmup() -> None:
    if os.getenv("CHATTERBOX_CUDA_WARMUP", "true").lower() in ("0", "false", "no"):
        return
    if VARIANT != "turbo" or not DEFAULT_PROMPT_PATH:
        return
    try:
        t0 = time.monotonic()
        await run_in_threadpool(_synthesize, "Hi.", None, None)
        ms = (time.monotonic() - t0) * 1000
        logger.info("chatterbox_cuda_warmup_done pid=%s ms=%.1f", WORKER_PID, ms)
    except Exception as e:
        logger.warning("chatterbox_cuda_warmup_failed pid=%s err=%s", WORKER_PID, e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Each Gunicorn worker runs this once: load model, optional preload, warmup.
    Multiple workers => multiple model copies (true concurrent lanes).
    """
    logger.info("chatterbox_worker_startup_begin pid=%s variant=%s", WORKER_PID, VARIANT)
    await run_in_threadpool(_load_model)
    logger.info("chatterbox_worker_startup_model_loaded pid=%s", WORKER_PID)
    await run_in_threadpool(_preload_speakers)
    await _cuda_warmup()
    logger.info("chatterbox_worker_startup_ready pid=%s", WORKER_PID)
    yield


app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class TtsBody(BaseModel):
    text: str = Field(default="")
    speaker_wav_url: Optional[str] = None
    language_id: Optional[str] = None
    # Reserved for a future central router; logged only today (no cross-worker priority queue).
    priority: int = Field(default=0, ge=-100, le=100)


def _request_id(request: Request, body: TtsBody | None = None) -> str:
    h = request.headers.get("x-request-id") or request.headers.get("X-Request-Id")
    if h and h.strip():
        return h.strip()[:128]
    return f"cb-{WORKER_PID}-{int(time.time() * 1000)}"


@app.get("/health")
def health() -> dict[str, Any]:
    ok = MODEL is not None
    out: dict[str, Any] = {
        "status": "ok" if ok else "loading_or_failed",
        "variant": VARIANT,
        "device": DEVICE,
        "model_loaded": ok,
        "worker_pid": WORKER_PID,
        "gunicorn_workers_hint": os.getenv("CHATTERBOX_GUNICORN_WORKERS", "1"),
        "speaker_cache_dir": SPEAKER_CACHE_DIR,
    }
    if VARIANT == "turbo" and DEFAULT_PROMPT_PATH:
        out["default_prompt_path"] = DEFAULT_PROMPT_PATH
        out["default_prompt_file_ok"] = os.path.isfile(DEFAULT_PROMPT_PATH)
    return out


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts(request: Request, body: TtsBody) -> Response:
    rid = _request_id(request, body)
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text too long"}, status_code=413)

    speaker_path: Optional[str] = None
    cleanup: Optional[str] = None
    cached = False
    t_total0 = time.monotonic()

    if body.speaker_wav_url and body.speaker_wav_url.strip():
        try:
            if SPEAKER_CACHE_DIR.strip():
                speaker_path, _cached = await run_in_threadpool(
                    _resolve_speaker_path, body.speaker_wav_url.strip()
                )
            else:
                cleanup = await run_in_threadpool(_download_wav_temp, body.speaker_wav_url.strip())
                speaker_path = cleanup
        except Exception as e:
            logger.warning("speaker resolve failed rid=%s err=%s", rid, e)
            return JSONResponse({"error": "speaker_wav_download_failed"}, status_code=400)

    queue_wait_ms: float = 0.0
    synth_ms: float = 0.0
    try:
        t_q0 = time.monotonic()
        async with tts_semaphore:
            queue_wait_ms = (time.monotonic() - t_q0) * 1000
            _tts_log(
                "lane_acquired",
                rid,
                queue_wait_ms=queue_wait_ms,
                text_len=len(text),
                priority=body.priority,
            )
            t_s0 = time.monotonic()
            wav_bytes = await run_in_threadpool(_synthesize, text, speaker_path, body.language_id)
            synth_ms = (time.monotonic() - t_s0) * 1000
        total_ms = (time.monotonic() - t_total0) * 1000
        _tts_log(
            "synthesize_done",
            rid,
            queue_wait_ms=queue_wait_ms,
            synth_ms=synth_ms,
            total_ms=total_ms,
            text_len=len(text),
            priority=body.priority,
        )
        headers = {
            "X-TTS-Worker-Pid": str(WORKER_PID),
            "X-TTS-Queue-Wait-Ms": f"{queue_wait_ms:.2f}",
            "X-TTS-Synthesize-Ms": f"{synth_ms:.2f}",
            "X-TTS-Total-Ms": f"{total_ms:.2f}",
            "X-TTS-Request-Id": rid,
        }
        return Response(content=wav_bytes, media_type="audio/wav", headers=headers)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        logger.exception("chatterbox synthesis failed rid=%s", rid)
        return JSONResponse(
            {"error": "synthesis_failed", "detail": _safe_exc_detail(e)},
            status_code=500,
        )
    finally:
        if cleanup and os.path.isfile(cleanup):
            try:
                os.unlink(cleanup)
            except OSError:
                pass


@app.post("/tts/stream")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts_stream(request: Request, body: TtsBody) -> Response:
    """
    Stream framed WAV segments: magic `VLX1` then repeated [4-byte big-endian length][wav bytes].
    Client can merge WAVs or play sequentially. Measures time-to-first-chunk after lane acquired.
    """
    rid = _request_id(request, body)
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text too long"}, status_code=413)
    if VARIANT != "turbo":
        return JSONResponse(
            {"error": "stream_only_turbo", "detail": "Use POST /tts for non-turbo variants"},
            status_code=400,
        )

    speaker_path: Optional[str] = None
    cleanup: Optional[str] = None
    if body.speaker_wav_url and body.speaker_wav_url.strip():
        try:
            if SPEAKER_CACHE_DIR.strip():
                speaker_path, _ = await run_in_threadpool(
                    _resolve_speaker_path, body.speaker_wav_url.strip()
                )
            else:
                cleanup = await run_in_threadpool(_download_wav_temp, body.speaker_wav_url.strip())
                speaker_path = cleanup
        except Exception:
            return JSONResponse({"error": "speaker_wav_download_failed"}, status_code=400)

    segments = _segments_for_stream(text, STREAM_MAX_SEGMENTS)

    async def byte_stream() -> AsyncIterator[bytes]:
        nonlocal speaker_path, cleanup
        t_total0 = time.monotonic()
        first_chunk_logged = False
        ttfc_ms: float | None = None
        queue_wait_ms = 0.0
        total_synth = 0.0
        try:
            yield STREAM_MAGIC
            t_q0 = time.monotonic()
            async with tts_semaphore:
                queue_wait_ms = (time.monotonic() - t_q0) * 1000
                _tts_log(
                    "stream_lane_acquired",
                    rid,
                    queue_wait_ms=queue_wait_ms,
                    segments=len(segments),
                    text_len=len(text),
                    priority=body.priority,
                )
                for i, seg in enumerate(segments):
                    if not seg.strip():
                        continue
                    t_s0 = time.monotonic()
                    wav = await run_in_threadpool(_synthesize, seg.strip(), speaker_path, body.language_id)
                    total_synth += (time.monotonic() - t_s0) * 1000
                    if not first_chunk_logged:
                        ttfc_ms = (time.monotonic() - t_total0) * 1000
                        first_chunk_logged = True
                        _tts_log(
                            "stream_first_chunk",
                            rid,
                            ttfc_ms=ttfc_ms,
                            queue_wait_ms=queue_wait_ms,
                            segments=len(segments),
                            priority=body.priority,
                        )
                    ln = len(wav).to_bytes(4, "big")
                    yield ln + wav
            total_ms = (time.monotonic() - t_total0) * 1000
            _tts_log(
                "stream_done",
                rid,
                queue_wait_ms=queue_wait_ms,
                synth_ms=total_synth,
                total_ms=total_ms,
                ttfc_ms=ttfc_ms,
                segments=len(segments),
                priority=body.priority,
            )
        finally:
            if cleanup and os.path.isfile(cleanup):
                try:
                    os.unlink(cleanup)
                except OSError:
                    pass

    headers = {
        "X-TTS-Request-Id": rid,
        "X-TTS-Stream-Segments": str(len(segments)),
        "X-TTS-Worker-Pid": str(WORKER_PID),
    }
    return StreamingResponse(
        byte_stream(),
        media_type="application/octet-stream",
        headers=headers,
    )
