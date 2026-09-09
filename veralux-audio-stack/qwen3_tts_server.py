"""
HTTP TTS server for Qwen3-TTS 1.7B CustomVoice (see https://github.com/QwenLM/Qwen3-TTS).

Env:
  QWEN3_TTS_MODEL          Hugging Face model id (default: Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
  QWEN3_TTS_DEVICE         cuda | cpu (default: cuda)
  QWEN3_TTS_DTYPE          bfloat16 | float16 | float32 (default: bfloat16)
  QWEN3_TTS_ATTN           sdpa | flash_attention_2 | eager (default: sdpa; flash requires flash-attn)
  QWEN3_TTS_MAX_CONCURRENT Per-process synthesis cap (default: 1)
  RATE_LIMIT_PER_MINUTE    HTTP rate limit (default: 10000)

POST /tts JSON:
  { "text": "...", "speaker": "Ryan", "language": "English", "instruct": "",
    "do_sample": false, "temperature": 0.8, "top_p": 0.9, "top_k": 50,
    "repetition_penalty": 1.1, "max_new_tokens": 1024, "non_streaming_mode": true,
    "subtalker_dosample": null, "subtalker_top_k": null, "subtalker_top_p": null,
    "subtalker_temperature": null }

Optional generation kwargs match Qwen3TTSModel.generate_custom_voice (omit or null to use model defaults).
The VeraLux voice runtime sends do_sample=false when unset so chunked synthesis does not sound like a different speaker each sentence.

Returns audio/wav (PCM16).
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger("qwen3_tts_server")

RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "10000")
limiter = Limiter(key_func=get_remote_address)

MODEL_ID = os.getenv(
    "QWEN3_TTS_MODEL",
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
)
DEVICE = os.getenv("QWEN3_TTS_DEVICE", "cuda").strip().lower()
DTYPE_STR = os.getenv("QWEN3_TTS_DTYPE", "bfloat16").strip().lower()
ATTN = os.getenv("QWEN3_TTS_ATTN", "sdpa").strip().lower()
MAX_TEXT = int(os.getenv("QWEN3_TTS_MAX_TEXT_CHARS", "2000"))
MAX_CONCURRENT = max(1, int(os.getenv("QWEN3_TTS_MAX_CONCURRENT", "1")))
STREAM_MAX_SEGMENTS = max(1, int(os.getenv("QWEN3_TTS_STREAM_MAX_SEGMENTS", "8")))
WARMUP = os.getenv("QWEN3_TTS_WARMUP", "true").strip().lower() not in ("0", "false", "off")

DEFAULT_SPEAKER = os.getenv("QWEN3_TTS_DEFAULT_SPEAKER", "Serena")
DEFAULT_LANGUAGE = os.getenv("QWEN3_TTS_DEFAULT_LANGUAGE", "English")

# Chatterbox-compatible framed stream: "VLX1" + repeated u32be(len) + wav bytes
STREAM_MAGIC = b"VLX1"

# Official CustomVoice 1.7B preset speakers (Qwen model card).
CUSTOMVOICE_SPEAKERS = [
    {"id": "Serena", "label": "Serena — warm gentle female", "native": "Chinese", "gender": "female"},
    {"id": "Vivian", "label": "Vivian — bright slightly edgy young female", "native": "Chinese", "gender": "female"},
    {"id": "Sohee", "label": "Sohee — warm emotional female", "native": "Korean", "gender": "female"},
    {"id": "Ono_Anna", "label": "Ono Anna — playful light female", "native": "Japanese", "gender": "female"},
    {"id": "Ryan", "label": "Ryan — dynamic English male", "native": "English", "gender": "male"},
    {"id": "Aiden", "label": "Aiden — sunny American male", "native": "English", "gender": "male"},
    {"id": "Uncle_Fu", "label": "Uncle Fu — seasoned low male", "native": "Chinese", "gender": "male"},
    {"id": "Dylan", "label": "Dylan — clear Beijing male", "native": "Chinese", "gender": "male"},
    {"id": "Eric", "label": "Eric — lively Chengdu male", "native": "Chinese", "gender": "male"},
]

tts_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
MODEL: Any = None


def _dtype():
    if DTYPE_STR in ("bf16", "bfloat16"):
        return torch.bfloat16
    if DTYPE_STR in ("fp16", "float16"):
        return torch.float16
    return torch.float32


def _device_map():
    if DEVICE == "cpu":
        return "cpu"
    return "cuda:0"


def _enable_cuda_fast_paths() -> None:
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        if hasattr(torch, "set_float32_matmul_precision"):
            torch.set_float32_matmul_precision("high")
    except Exception:
        logger.warning("could not enable CUDA tf32/cudnn fast paths")


def _load_model() -> Any:
    global MODEL
    if MODEL is not None:
        return MODEL
    from qwen_tts import Qwen3TTSModel
    _enable_cuda_fast_paths()

    attn = ATTN
    if attn == "flash_attention_2":
        try:
            import flash_attn  # noqa: F401
        except ImportError:
            logger.warning("flash_attention_2 requested but flash-attn not installed; using sdpa")
            attn = "sdpa"

    logger.info(
        "Loading Qwen3-TTS model=%s device=%s dtype=%s attn=%s",
        MODEL_ID,
        DEVICE,
        DTYPE_STR,
        attn,
    )
    MODEL = Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        device_map=_device_map(),
        dtype=_dtype(),
        attn_implementation=attn,
    )
    return MODEL


def _synthesize(
    text: str,
    speaker: str,
    language: str,
    instruct: str,
    gen_kwargs: dict[str, Any],
) -> tuple[bytes, int]:
    model = _load_model()
    inst = instruct.strip()
    wavs, sr = model.generate_custom_voice(
        text=text,
        language=language if language else "English",
        speaker=speaker or DEFAULT_SPEAKER,
        instruct=inst,
        **gen_kwargs,
    )
    w = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
    if hasattr(w, "detach"):
        w = w.detach().cpu().float().numpy()
    else:
        w = np.asarray(w, dtype=np.float32)
    if w.ndim > 1:
        w = np.squeeze(w)
    buf = io.BytesIO()
    sf.write(buf, w, int(sr), subtype="PCM_16", format="WAV")
    return buf.getvalue(), int(sr)


def _segments_for_stream(text: str, max_segments: int) -> list[str]:
    """Split on sentence end so the first WAV can leave before the rest synths."""
    t = text.strip()
    if not t:
        return []
    parts = re.split(r"(?<=[.!?])\s+", t)
    segs = [p.strip() for p in parts if p.strip()]
    if not segs:
        return [t]
    if len(segs) > max_segments:
        head = segs[: max_segments - 1]
        tail = " ".join(segs[max_segments - 1 :])
        segs = head + [tail]
    return segs


def _warmup_model() -> None:
    if not WARMUP:
        return
    t0 = time.monotonic()
    try:
        _synthesize("Hi.", DEFAULT_SPEAKER, DEFAULT_LANGUAGE, "", {"do_sample": False})
        ms = (time.monotonic() - t0) * 1000
        logger.info("qwen3-tts warmup done in %.0f ms speaker=%s", ms, DEFAULT_SPEAKER)
    except Exception:
        logger.exception("qwen3-tts warmup failed (continuing)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("qwen3-tts worker: loading model")
    await run_in_threadpool(_load_model)
    if WARMUP:
        logger.info("qwen3-tts worker: warmup")
        await run_in_threadpool(_warmup_model)
    logger.info("qwen3-tts worker: ready")
    yield


app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class TtsBody(BaseModel):
    text: str = Field(default="")
    speaker: str | None = None
    language: str | None = None
    instruct: str | None = None
    # Optional — forwarded to generate_custom_voice (see Qwen3-TTS docs)
    do_sample: bool | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    top_k: int | None = Field(default=None, ge=0)
    repetition_penalty: float | None = Field(default=None, ge=0.5, le=2.0)
    max_new_tokens: int | None = Field(default=None, ge=1, le=32768)
    non_streaming_mode: bool | None = None
    subtalker_dosample: bool | None = None
    subtalker_top_k: int | None = Field(default=None, ge=0)
    subtalker_top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    subtalker_temperature: float | None = Field(default=None, ge=0.0, le=2.0)


_GEN_FIELDS = (
    "do_sample",
    "temperature",
    "top_p",
    "top_k",
    "repetition_penalty",
    "max_new_tokens",
    "non_streaming_mode",
    "subtalker_dosample",
    "subtalker_top_k",
    "subtalker_top_p",
    "subtalker_temperature",
)


def _extract_gen_kwargs(body: TtsBody) -> dict[str, Any]:
    d = body.model_dump()
    out: dict[str, Any] = {}
    for k in _GEN_FIELDS:
        v = d.get(k)
        if v is not None:
            out[k] = v
    return out


def _speaker_payload() -> dict[str, Any]:
    ids: list[str] = [s["id"] for s in CUSTOMVOICE_SPEAKERS]
    if MODEL is not None:
        try:
            live = list(MODEL.get_supported_speakers() or [])
            if live:
                ids = [str(x) for x in live]
        except Exception:
            logger.warning("get_supported_speakers failed; using catalog")
    return {"speakers": CUSTOMVOICE_SPEAKERS, "ids": ids, "default": DEFAULT_SPEAKER}


@app.get("/health")
def health() -> dict[str, Any]:
    ok = MODEL is not None
    return {
        "status": "ok" if ok else "loading_or_failed",
        "model": MODEL_ID,
        "model_loaded": ok,
        "device": DEVICE,
        "default_speaker": DEFAULT_SPEAKER,
        "speakers": [s["id"] for s in CUSTOMVOICE_SPEAKERS],
        "stream": True,
        "warmup": WARMUP,
    }


@app.get("/speakers")
def speakers() -> dict[str, Any]:
    return _speaker_payload()


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts(request: Request, body: TtsBody) -> Response:
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text too long"}, status_code=413)

    speaker = (body.speaker or DEFAULT_SPEAKER).strip()
    language = (body.language or DEFAULT_LANGUAGE).strip()
    instruct = (body.instruct or "").strip()
    gen_kwargs = _extract_gen_kwargs(body)

    try:
        async with tts_semaphore:
            wav_bytes, _sr = await run_in_threadpool(
                _synthesize, text, speaker, language, instruct, gen_kwargs
            )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.exception("qwen3-tts synthesis failed")
        return JSONResponse(
            {"error": "synthesis_failed", "detail": str(e)[:400]},
            status_code=500,
        )


@app.post("/tts/stream")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts_stream(request: Request, body: TtsBody) -> Response:
    """
    Stream framed WAV segments: magic `VLX1` then repeated [4-byte big-endian length][wav bytes].
    Each sentence is synthesized and yielded so the client can play the first clause
    without waiting for the rest. Not codec-frame Turbo — Qwen 0.1.1 has no PCM generator.
    """
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text too long"}, status_code=413)

    speaker = (body.speaker or DEFAULT_SPEAKER).strip()
    language = (body.language or DEFAULT_LANGUAGE).strip()
    instruct = (body.instruct or "").strip()
    gen_kwargs = _extract_gen_kwargs(body)
    segments = _segments_for_stream(text, STREAM_MAX_SEGMENTS)
    if not segments:
        return JSONResponse({"error": "text is required"}, status_code=400)

    async def byte_stream() -> AsyncIterator[bytes]:
        t_total0 = time.monotonic()
        first_chunk_logged = False
        ttfc_ms: float | None = None
        queue_wait_ms = 0.0
        total_synth = 0.0
        yield STREAM_MAGIC
        t_q0 = time.monotonic()
        async with tts_semaphore:
            queue_wait_ms = (time.monotonic() - t_q0) * 1000
            logger.info(
                "stream_lane_acquired queue_wait_ms=%.0f segments=%s text_len=%s",
                queue_wait_ms,
                len(segments),
                len(text),
            )
            for i, seg in enumerate(segments):
                if not seg.strip():
                    continue
                t_s0 = time.monotonic()
                wav, _sr = await run_in_threadpool(
                    _synthesize, seg.strip(), speaker, language, instruct, gen_kwargs
                )
                total_synth += (time.monotonic() - t_s0) * 1000
                if not first_chunk_logged:
                    ttfc_ms = (time.monotonic() - t_total0) * 1000
                    first_chunk_logged = True
                    logger.info(
                        "stream_first_chunk ttfc_ms=%.0f queue_wait_ms=%.0f segments=%s seg0_len=%s",
                        ttfc_ms,
                        queue_wait_ms,
                        len(segments),
                        len(seg),
                    )
                yield len(wav).to_bytes(4, "big") + wav
        logger.info(
            "stream_done ttfc_ms=%s synth_ms=%.0f total_ms=%.0f segments=%s",
            round(ttfc_ms, 2) if ttfc_ms is not None else None,
            total_synth,
            (time.monotonic() - t_total0) * 1000,
            len(segments),
        )

    return StreamingResponse(
        byte_stream(),
        media_type="application/octet-stream",
        headers={
            "X-TTS-Stream-Segments": str(len(segments)),
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )
