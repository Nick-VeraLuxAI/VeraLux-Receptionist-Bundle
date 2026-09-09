"""
HTTP TTS server for MeloTTS (https://github.com/myshell-ai/MeloTTS).

Env:
  MELO_TTS_DEVICE          cuda | cpu (default: cuda)
  MELO_TTS_DEFAULT_LANG    EN (default)
  MELO_TTS_DEFAULT_SPEAKER  EN-US (default)
  MELO_TTS_WARMUP          true | false (default: true)
  MELO_TTS_MAX_CONCURRENT   Per-process synthesis cap (default: 1)
  RATE_LIMIT_PER_MINUTE    HTTP rate limit (default: 10000)

POST /tts JSON:
  { "text": "...", "speaker": "EN-US", "language": "EN",
    "speed": 1.0, "sdp_ratio": 0.2, "noise_scale": 0.6, "noise_scale_w": 0.8 }

Returns audio/wav (PCM16). Speed is native MeloTTS (do not also resample).
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.concurrency import run_in_threadpool

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("melo_tts_server")

RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "10000")
limiter = Limiter(key_func=get_remote_address)

DEVICE = os.getenv("MELO_TTS_DEVICE", "cuda").strip().lower()
MAX_TEXT = int(os.getenv("MELO_TTS_MAX_TEXT_CHARS", "2000"))
MAX_CONCURRENT = max(1, int(os.getenv("MELO_TTS_MAX_CONCURRENT", "1")))
WARMUP = os.getenv("MELO_TTS_WARMUP", "true").strip().lower() not in ("0", "false", "off")
DEFAULT_LANG = os.getenv("MELO_TTS_DEFAULT_LANG", "EN").strip().upper() or "EN"
DEFAULT_SPEAKER = os.getenv("MELO_TTS_DEFAULT_SPEAKER", "EN-US")

SPEAKERS = [
    {"id": "EN-US", "label": "EN-US — American English", "language": "EN", "gender": "female"},
    {"id": "EN-BR", "label": "EN-BR — British English", "language": "EN", "gender": "female"},
    {"id": "EN-INDIA", "label": "EN-INDIA — Indian English", "language": "EN", "gender": "female"},
    {"id": "EN-AU", "label": "EN-AU — Australian English", "language": "EN", "gender": "female"},
    {"id": "EN-Default", "label": "EN-Default — default English", "language": "EN", "gender": "female"},
    {"id": "ES", "label": "ES — Spanish", "language": "ES", "gender": "female"},
    {"id": "FR", "label": "FR — French", "language": "FR", "gender": "female"},
    {"id": "ZH", "label": "ZH — Chinese", "language": "ZH", "gender": "female"},
    {"id": "JP", "label": "JP — Japanese", "language": "JP", "gender": "female"},
    {"id": "KR", "label": "KR — Korean", "language": "KR", "gender": "female"},
]
SPEAKER_LANG = {s["id"]: s["language"] for s in SPEAKERS}
LANG_IDS = {"EN", "ES", "FR", "ZH", "JP", "KR"}
# Melo EN checkpoint uses EN_INDIA (underscore). UI and older saves use EN-INDIA.
SPEAKER_ALIASES = {
    "en-india": "EN_INDIA",
    "en_india": "EN_INDIA",
    "en-us": "EN-US",
    "en-br": "EN-BR",
    "en-au": "EN-AU",
    "en-default": "EN-Default",
    "en_default": "EN-Default",
}

models: dict[str, Any] = {}
ready = False
load_error: Optional[str] = None
sem = asyncio.Semaphore(MAX_CONCURRENT)


def _device() -> str:
    if DEVICE == "cuda" and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _language(code: Optional[str], speaker: str) -> str:
    t = (code or "").strip().upper().replace("_", "-")
    if t in LANG_IDS:
        return t
    if t.startswith("EN"):
        return "EN"
    iso = t.split("-")[0]
    iso_map = {"EN": "EN", "ES": "ES", "FR": "FR", "ZH": "ZH", "JA": "JP", "JP": "JP", "KO": "KR", "KR": "KR"}
    if iso in iso_map:
        return iso_map[iso]
    return SPEAKER_LANG.get(speaker, DEFAULT_LANG)


def _speaker(name: Optional[str], language: str) -> str:
    raw = (name or DEFAULT_SPEAKER).strip()
    alias = SPEAKER_ALIASES.get(raw.lower().replace(" ", ""))
    if alias:
        return alias
    if raw in SPEAKER_LANG:
        return raw
    for item in SPEAKERS:
        if item["language"] == language:
            return item["id"]
    return DEFAULT_SPEAKER


def _get_model(language: str):
    from melo.api import TTS

    lang = language if language in LANG_IDS else "EN"
    if lang not in models:
        logger.info("Loading MeloTTS language=%s device=%s", lang, _device())
        models[lang] = TTS(language=lang, device=_device())
    return models[lang]


def _spk2id_map(model: Any) -> dict[str, int]:
    data = getattr(getattr(model, "hps", None), "data", None)
    mapping = getattr(data, "spk2id", None) if data is not None else None
    if mapping is None:
        return {}
    if isinstance(mapping, dict):
        raw = mapping
    elif hasattr(mapping, "items"):
        raw = dict(mapping.items())
    else:
        raw = {k: v for k, v in vars(mapping).items() if not str(k).startswith("_")}
    out: dict[str, int] = {}
    for key, val in raw.items():
        try:
            out[str(key)] = int(val)
        except (TypeError, ValueError):
            continue
    return out


def _speaker_id(model: Any, speaker: str) -> int:
    mapping = _spk2id_map(model)
    if speaker in mapping:
        return mapping[speaker]
    lower = {k.lower(): v for k, v in mapping.items()}
    alias = SPEAKER_ALIASES.get(speaker.lower().replace(" ", ""), speaker)
    if alias in mapping:
        return mapping[alias]
    if alias.lower() in lower:
        return lower[alias.lower()]
    if speaker.lower() in lower:
        return lower[speaker.lower()]
    if mapping:
        logger.warning("unknown Melo speaker=%s ids=%s; using first", speaker, list(mapping))
        return next(iter(mapping.values()))
    return 0


def _synthesize_sync(
    text: str,
    speaker: str,
    language: str,
    speed: float,
    sdp_ratio: float,
    noise_scale: float,
    noise_scale_w: float,
) -> bytes:
    lang = _language(language, speaker)
    spk = _speaker(speaker, lang)
    model = _get_model(lang)
    spk_id = _speaker_id(model, spk)
    logger.info("resolve speaker_in=%s speaker=%s lang=%s spk_id=%s", speaker, spk, lang, spk_id)
    audio = model.tts_to_file(
        text,
        spk_id,
        output_path=None,
        speed=float(speed),
        sdp_ratio=float(sdp_ratio),
        noise_scale=float(noise_scale),
        noise_scale_w=float(noise_scale_w),
        quiet=True,
    )
    wave = np.asarray(audio, dtype=np.float32).squeeze()
    sr = int(getattr(getattr(getattr(model, "hps", None), "data", None), "sampling_rate", 44100))
    peak = float(np.max(np.abs(wave))) if wave.size else 0.0
    if peak > 1.0:
        wave = wave / peak
    buf = io.BytesIO()
    sf.write(buf, wave, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _load_default() -> None:
    global ready, load_error
    t0 = time.perf_counter()
    try:
        import nltk

        nltk.download("averaged_perceptron_tagger_eng", quiet=True)
    except Exception:
        logger.exception("nltk tagger download failed")
    if DEVICE == "cuda" and torch.cuda.is_available():
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    _get_model(DEFAULT_LANG)
    if WARMUP:
        _synthesize_sync("Hi.", DEFAULT_SPEAKER, DEFAULT_LANG, 1.0, 0.2, 0.6, 0.8)
        logger.info("MeloTTS warmup done in %.2fs", time.perf_counter() - t0)
    ready = True
    load_error = None
    logger.info("MeloTTS ready in %.2fs", time.perf_counter() - t0)


class TtsBody(BaseModel):
    text: str = Field(..., min_length=1)
    speaker: Optional[str] = None
    language: Optional[str] = None
    speed: Optional[float] = Field(default=None, ge=0.5, le=2.0)
    sdp_ratio: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    noise_scale: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    noise_scale_w: Optional[float] = Field(default=None, ge=0.0, le=2.0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global load_error
    try:
        await run_in_threadpool(_load_default)
    except Exception as exc:
        load_error = str(exc)
        logger.exception("MeloTTS load failed")
    yield


app = FastAPI(title="VeraLux MeloTTS", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.get("/health")
async def health():
    if ready:
        return {
            "ok": True,
            "engine": "melo_tts",
            "device": _device(),
            "loaded_languages": sorted(models.keys()),
            "speakers": [s["id"] for s in SPEAKERS],
        }
    return JSONResponse({"ok": False, "error": load_error or "loading"}, status_code=503)


@app.get("/voices")
async def voices():
    return {"speakers": SPEAKERS, "languages": [{"id": lang, "label": lang} for lang in sorted(LANG_IDS)]}


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts(request: Request, body: TtsBody):
    if not ready:
        return JSONResponse({"error": load_error or "not_ready"}, status_code=503)
    text = body.text.strip()
    if not text:
        return JSONResponse({"error": "empty_text"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text_too_long", "max": MAX_TEXT}, status_code=400)
    t0 = time.perf_counter()
    async with sem:
        wav = await run_in_threadpool(
            _synthesize_sync,
            text,
            body.speaker or DEFAULT_SPEAKER,
            body.language or DEFAULT_LANG,
            1.0 if body.speed is None else float(body.speed),
            0.2 if body.sdp_ratio is None else float(body.sdp_ratio),
            0.6 if body.noise_scale is None else float(body.noise_scale),
            0.8 if body.noise_scale_w is None else float(body.noise_scale_w),
        )
    logger.info(
        "tts speaker=%s lang=%s chars=%s speed=%s sdp=%s noise=%s noise_w=%s ms=%.0f",
        body.speaker or DEFAULT_SPEAKER,
        body.language or DEFAULT_LANG,
        len(text),
        1.0 if body.speed is None else float(body.speed),
        0.2 if body.sdp_ratio is None else float(body.sdp_ratio),
        0.6 if body.noise_scale is None else float(body.noise_scale),
        0.8 if body.noise_scale_w is None else float(body.noise_scale_w),
        (time.perf_counter() - t0) * 1000,
    )
    return Response(content=wav, media_type="audio/wav")
