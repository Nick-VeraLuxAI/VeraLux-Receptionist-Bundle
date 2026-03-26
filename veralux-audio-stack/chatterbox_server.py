"""
HTTP TTS server for Resemble AI Chatterbox (https://github.com/resemble-ai/chatterbox).

Env:
  CHATTERBOX_VARIANT   turbo | standard | multilingual (default: turbo)
  CHATTERBOX_DEVICE    cuda | cpu (default: cuda)
  CHATTERBOX_DEFAULT_AUDIO_PROMPT  Optional path to a reference WAV on disk when no speaker_wav_url is sent (Turbo).
  CHATTERBOX_MAX_TEXT_CHARS        Default 1500
  RATE_LIMIT_PER_MINUTE            Default 30

POST /tts JSON:
  { "text": "...", "speaker_wav_url": "https://.../ref.wav" (optional), "language_id": "en" (multilingual only) }

Returns audio/wav (PCM).
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import urllib.request
from typing import Any, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger("chatterbox_server")

RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "30")
limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

VARIANT = os.getenv("CHATTERBOX_VARIANT", "turbo").strip().lower()
DEVICE = os.getenv("CHATTERBOX_DEVICE", "cuda").strip().lower()
DEFAULT_PROMPT_PATH = os.getenv("CHATTERBOX_DEFAULT_AUDIO_PROMPT", "").strip() or None
MAX_TEXT = int(os.getenv("CHATTERBOX_MAX_TEXT_CHARS", "1500"))
MAX_CONCURRENT = int(os.getenv("CHATTERBOX_MAX_CONCURRENT", "1"))

MODEL: Any = None


def _safe_exc_detail(exc: BaseException, max_len: int = 400) -> str:
    """Single-line hint for operators (admin preview); full trace stays in logs."""
    s = str(exc).strip().replace("\n", " ").replace("\r", " ")
    if len(s) > max_len:
        return s[: max_len - 1] + "…"
    return s


def _load_model() -> Any:
    global MODEL
    if MODEL is not None:
        return MODEL
    logger.info("Loading Chatterbox variant=%s device=%s", VARIANT, DEVICE)
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


def _download_wav(url: str, timeout: int = 30) -> str:
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

    # standard
    if speaker_path:
        wav = model.generate(text, audio_prompt_path=speaker_path)
    else:
        wav = model.generate(text)
    return _tensor_to_wav_bytes(wav, sr)


class TtsBody(BaseModel):
    text: str = Field(default="")
    speaker_wav_url: Optional[str] = None
    language_id: Optional[str] = None


@app.get("/health")
def health() -> dict[str, Any]:
    ok = MODEL is not None
    out: dict[str, Any] = {
        "status": "ok" if ok else "loading_or_failed",
        "variant": VARIANT,
        "device": DEVICE,
        "model_loaded": ok,
    }
    if VARIANT == "turbo" and DEFAULT_PROMPT_PATH:
        out["default_prompt_path"] = DEFAULT_PROMPT_PATH
        out["default_prompt_file_ok"] = os.path.isfile(DEFAULT_PROMPT_PATH)
    return out


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts(request: Request, body: TtsBody) -> Response:
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text too long"}, status_code=413)

    speaker_path: Optional[str] = None
    cleanup: Optional[str] = None
    if body.speaker_wav_url and body.speaker_wav_url.strip():
        try:
            cleanup = await run_in_threadpool(_download_wav, body.speaker_wav_url.strip())
            speaker_path = cleanup
        except Exception as e:
            logger.warning("speaker download failed: %s", e)
            return JSONResponse({"error": "speaker_wav_download_failed"}, status_code=400)

    try:
        wav_bytes = await run_in_threadpool(
            _synthesize, text, speaker_path, body.language_id
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        logger.exception("chatterbox synthesis failed")
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
