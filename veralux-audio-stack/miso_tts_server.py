"""
HTTP TTS server for Miso TTS 8B (Miso One).

Env:
  MISO_TTS_MODEL          Hugging Face model id (default: MisoLabs/MisoTTS)
  MISO_TTS_DEVICE         cuda | cpu (default: cuda)
  MISO_TTS_DTYPE          bfloat16 | float16 | float32 (default: bfloat16)
  MISO_TTS_MAX_CONCURRENT Per-process synthesis cap (default: 1)
  MISO_TTS_MAX_TEXT_CHARS Request text limit (default: 2000)
  RATE_LIMIT_PER_MINUTE   HTTP rate limit (default: 10000)

POST /tts JSON:
  { "text": "...", "speaker": 0, "max_audio_length_ms": 10000,
    "temperature": 0.9, "top_k": 50,
    "speaker_wav_url": "https://...", "speaker_text": "Transcript for prompt audio" }

`speaker_wav_url` + `speaker_text` are optional and become one Miso context Segment for
voice continuation / cloning. Without both, Miso generates from text only.

Returns audio/wav (PCM16).
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import urllib.request
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger("miso_tts_server")

RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "10000")
MODEL_ID = os.getenv("MISO_TTS_MODEL", "MisoLabs/MisoTTS")
DEVICE = os.getenv("MISO_TTS_DEVICE", "cuda").strip().lower()
DTYPE_STR = os.getenv("MISO_TTS_DTYPE", "bfloat16").strip().lower()
MAX_TEXT = int(os.getenv("MISO_TTS_MAX_TEXT_CHARS", "2000"))
MAX_CONCURRENT = max(1, int(os.getenv("MISO_TTS_MAX_CONCURRENT", "1")))
DEFAULT_SPEAKER = int(os.getenv("MISO_TTS_DEFAULT_SPEAKER", "0"))
DEFAULT_MAX_AUDIO_MS = int(os.getenv("MISO_TTS_DEFAULT_MAX_AUDIO_MS", "10000"))
PROMPT_TIMEOUT_SECONDS = float(os.getenv("MISO_TTS_PROMPT_FETCH_TIMEOUT_SECONDS", "10"))
DEFAULT_PROMPT_TEXT = os.getenv("MISO_TTS_DEFAULT_PROMPT_TEXT", "This is a reference voice sample.")

limiter = Limiter(key_func=get_remote_address)
tts_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
GENERATOR: Any = None


def _dtype() -> torch.dtype:
    if DTYPE_STR in ("bf16", "bfloat16"):
        return torch.bfloat16
    if DTYPE_STR in ("fp16", "float16"):
        return torch.float16
    return torch.float32


def _load_generator() -> Any:
    global GENERATOR
    if GENERATOR is not None:
        return GENERATOR
    from generator import load_miso_8b

    logger.info(
        "Loading Miso TTS model=%s device=%s dtype=%s",
        MODEL_ID,
        DEVICE,
        DTYPE_STR,
    )
    GENERATOR = load_miso_8b(
        device=DEVICE,
        model_path_or_repo_id=MODEL_ID,
        dtype=_dtype(),
    )
    return GENERATOR


def _read_prompt_audio(url: str, target_sample_rate: int) -> torch.Tensor:
    with urllib.request.urlopen(url, timeout=PROMPT_TIMEOUT_SECONDS) as res:
        data = res.read()
    audio, sample_rate = torchaudio.load(io.BytesIO(data))
    if audio.ndim == 2:
        audio = audio.mean(dim=0)
    else:
        audio = audio.squeeze(0)
    if sample_rate != target_sample_rate:
        audio = torchaudio.functional.resample(
            audio,
            orig_freq=sample_rate,
            new_freq=target_sample_rate,
        )
    return audio


def _synthesize(
    text: str,
    speaker: int,
    max_audio_length_ms: int,
    temperature: float,
    top_k: int,
    speaker_wav_url: str | None,
    speaker_text: str | None,
) -> tuple[bytes, int]:
    gen = _load_generator()
    context = []
    if speaker_wav_url:
        from generator import Segment

        prompt_audio = _read_prompt_audio(speaker_wav_url, gen.sample_rate)
        context.append(Segment(speaker=speaker, text=speaker_text or DEFAULT_PROMPT_TEXT, audio=prompt_audio))

    audio = gen.generate(
        text=text,
        speaker=speaker,
        context=context,
        max_audio_length_ms=max_audio_length_ms,
        temperature=temperature,
        topk=top_k,
    )
    if hasattr(audio, "detach"):
        arr = audio.detach().cpu().float().numpy()
    else:
        arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:
        arr = np.squeeze(arr)

    buf = io.BytesIO()
    sf.write(buf, arr, int(gen.sample_rate), subtype="PCM_16", format="WAV")
    return buf.getvalue(), int(gen.sample_rate)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("miso-tts worker: loading model")
    await run_in_threadpool(_load_generator)
    logger.info("miso-tts worker: ready")
    yield


app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class TtsBody(BaseModel):
    text: str = Field(default="")
    speaker: int | None = Field(default=None, ge=0, le=16)
    max_audio_length_ms: int | None = Field(default=None, ge=500, le=90_000)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_k: int | None = Field(default=None, ge=1, le=1000)
    speaker_wav_url: str | None = None
    speaker_text: str | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    ok = GENERATOR is not None
    return {
        "status": "ok" if ok else "loading_or_failed",
        "model": MODEL_ID,
        "model_loaded": ok,
        "device": DEVICE,
        "sample_rate": getattr(GENERATOR, "sample_rate", None),
    }


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts(request: Request, body: TtsBody) -> Response:
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text too long"}, status_code=413)

    speaker = body.speaker if body.speaker is not None else DEFAULT_SPEAKER
    max_audio_length_ms = body.max_audio_length_ms or DEFAULT_MAX_AUDIO_MS
    temperature = 0.9 if body.temperature is None else body.temperature
    top_k = 50 if body.top_k is None else body.top_k

    prompt_url = body.speaker_wav_url.strip() if body.speaker_wav_url else None
    prompt_text = body.speaker_text.strip() if body.speaker_text else None

    try:
        async with tts_semaphore:
            wav_bytes, _sr = await run_in_threadpool(
                _synthesize,
                text,
                speaker,
                max_audio_length_ms,
                temperature,
                top_k,
                prompt_url,
                prompt_text,
            )
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        logger.exception("miso-tts synthesis failed")
        return JSONResponse(
            {"error": "synthesis_failed", "detail": str(e)[:400]},
            status_code=500,
        )
