"""
HTTP TTS server for NVIDIA Magpie multilingual 357M
(https://huggingface.co/nvidia/magpie_tts_multilingual_357m).

Env:
  MAGPIE_TTS_MODEL     Hugging Face id or local .nemo path
                       (default: nvidia/magpie_tts_multilingual_357m)
  MAGPIE_TTS_DEVICE    cuda | cpu (default: cuda)
  MAGPIE_TTS_DTYPE     float32 | bfloat16 | float16 (default: float32 — bf16 is slower on this AR decode)
  MAGPIE_TTS_USE_CFG   default classifier-free guidance (default: false)
  MAGPIE_TTS_APPLY_TN  default NeMo text normalization (default: false)
  MAGPIE_TTS_WARMUP    true | false (default: true)
  MAGPIE_TTS_MAX_CONCURRENT  Per-process synthesis cap (default: 1)
  RATE_LIMIT_PER_MINUTE     HTTP rate limit (default: 10000)

POST /tts JSON:
  { "text": "...", "speaker": "Sofia", "language": "en",
    "temperature": 0.6, "cfg_scale": 2.5, "top_k": 80,
    "use_cfg": false, "apply_tn": false }

Returns audio/wav (PCM16). Speaking-rate is applied by the VeraLux client.
"""

from __future__ import annotations

import asyncio
import inspect
import io
import logging
import os
import time
from contextlib import asynccontextmanager, nullcontext
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
logger = logging.getLogger("magpie_tts_server")
# Quiet NeMo before the first import/load so decode-step INFO cannot sync CUDA.
logging.getLogger("nemo").setLevel(logging.WARNING)
logging.getLogger("nemo.collections.tts").setLevel(logging.WARNING)
logging.getLogger("nemo.collections.tts.models.magpietts").setLevel(logging.WARNING)

RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "10000")
limiter = Limiter(key_func=get_remote_address)

MODEL_ID = os.getenv("MAGPIE_TTS_MODEL", "nvidia/magpie_tts_multilingual_357m")
DEVICE = os.getenv("MAGPIE_TTS_DEVICE", "cuda").strip().lower()
DTYPE_STR = os.getenv("MAGPIE_TTS_DTYPE", "float32").strip().lower()
MAX_TEXT = int(os.getenv("MAGPIE_TTS_MAX_TEXT_CHARS", "2000"))
MAX_CONCURRENT = max(1, int(os.getenv("MAGPIE_TTS_MAX_CONCURRENT", "1")))
WARMUP = os.getenv("MAGPIE_TTS_WARMUP", "true").strip().lower() not in ("0", "false", "off")
DEFAULT_USE_CFG = os.getenv("MAGPIE_TTS_USE_CFG", "false").strip().lower() in ("1", "true", "on", "yes")
DEFAULT_APPLY_TN = os.getenv("MAGPIE_TTS_APPLY_TN", "false").strip().lower() in ("1", "true", "on", "yes")

DEFAULT_SPEAKER = os.getenv("MAGPIE_TTS_DEFAULT_SPEAKER", "Sofia")
DEFAULT_LANGUAGE = os.getenv("MAGPIE_TTS_DEFAULT_LANGUAGE", "en")

# Public Magpie multilingual checkpoint: five baked voices (NeMo TTS primer).
SPEAKERS = [
    {"id": "Aria", "index": 0, "label": "Aria — bright female", "gender": "female"},
    {"id": "Jason", "index": 1, "label": "Jason — clear male", "gender": "male"},
    {"id": "John", "index": 2, "label": "John — warm male", "gender": "male"},
    {"id": "Leo", "index": 3, "label": "Leo — deeper male", "gender": "male"},
    {"id": "Sofia", "index": 4, "label": "Sofia — warm receptionist female", "gender": "female"},
]
SPEAKER_INDEX = {s["id"].lower(): int(s["index"]) for s in SPEAKERS}
LANGUAGES = [
    {"id": "en", "label": "English"},
    {"id": "es", "label": "Spanish"},
    {"id": "fr", "label": "French"},
    {"id": "de", "label": "German"},
    {"id": "it", "label": "Italian"},
    {"id": "pt", "label": "Portuguese (Brazil)"},
    {"id": "zh", "label": "Chinese"},
    {"id": "ja", "label": "Japanese"},
    {"id": "ko", "label": "Korean"},
    {"id": "hi", "label": "Hindi"},
    {"id": "vi", "label": "Vietnamese"},
    {"id": "ar", "label": "Arabic"},
]
LANG_IDS = {item["id"] for item in LANGUAGES}

model: Any = None
ready = False
load_error: Optional[str] = None
sample_rate = 22050
sem = asyncio.Semaphore(MAX_CONCURRENT)
_DO_TTS_PARAMS: Optional[set[str]] = None
_AMP_DTYPE: Optional[torch.dtype] = None


def _quiet_nemo_logs() -> None:
    """NeMo logs every 30 decode steps at INFO; that forces host syncs and looks like a hang."""
    for name in (
        "nemo",
        "nemo.collections.tts",
        "nemo.collections.tts.models.magpietts",
        "nemo.utils",
    ):
        logging.getLogger(name).setLevel(logging.WARNING)
    try:
        from nemo.utils import logging as nemo_logging

        if hasattr(nemo_logging, "setLevel"):
            nemo_logging.setLevel("WARNING")
        elif hasattr(nemo_logging, "logger"):
            nemo_logging.logger.setLevel(logging.WARNING)
    except Exception:
        pass


def _amp_dtype() -> Optional[torch.dtype]:
    if DEVICE != "cuda" or not torch.cuda.is_available():
        return None
    if DTYPE_STR in ("float32", "fp32", "off", "none"):
        return None
    if DTYPE_STR in ("fp16", "float16"):
        return torch.float16
    return torch.bfloat16


def _enable_cuda_fast_paths() -> None:
    if DEVICE != "cuda" or not torch.cuda.is_available():
        return
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        # Variable-length AR decode: benchmark caches the warmup shape and slows real utterances.
        torch.backends.cudnn.benchmark = False
        if hasattr(torch, "set_float32_matmul_precision"):
            torch.set_float32_matmul_precision("high")
    except Exception:
        logger.warning("could not enable CUDA tf32/cudnn fast paths")


def _speaker_index(name: Optional[str]) -> int:
    raw = (name or DEFAULT_SPEAKER).strip()
    if raw.isdigit():
        idx = int(raw)
        if 0 <= idx <= 4:
            return idx
    return SPEAKER_INDEX.get(raw.lower(), SPEAKER_INDEX[DEFAULT_SPEAKER.lower()])


def _language(code: Optional[str]) -> str:
    t = (code or DEFAULT_LANGUAGE).strip().lower().replace("_", "-")
    if t in LANG_IDS:
        return t
    base = t.split("-")[0]
    return base if base in LANG_IDS else "en"


def _set_inference_params(
    temperature: Optional[float],
    cfg_scale: Optional[float],
    top_k: Optional[int],
) -> None:
    ip = getattr(model, "inference_parameters", None)
    if ip is None:
        return
    if temperature is not None:
        ip.temperature = float(temperature)
    if cfg_scale is not None:
        ip.cfg_scale = float(cfg_scale)
    if top_k is not None:
        ip.topk = int(top_k)


def _do_tts_params() -> set[str]:
    global _DO_TTS_PARAMS
    if _DO_TTS_PARAMS is None:
        _DO_TTS_PARAMS = set(inspect.signature(model.do_tts).parameters)
    return _DO_TTS_PARAMS


def _load_model() -> None:
    global model, ready, load_error, sample_rate, _AMP_DTYPE
    _quiet_nemo_logs()
    _enable_cuda_fast_paths()
    from nemo.collections.tts.models import MagpieTTSModel

    t0 = time.perf_counter()
    logger.info("Loading Magpie TTS %s on %s dtype=%s", MODEL_ID, DEVICE, DTYPE_STR)
    path = MODEL_ID.strip()
    if path.endswith(".nemo") and os.path.isfile(path):
        loaded = MagpieTTSModel.restore_from(path)
    else:
        loaded = MagpieTTSModel.from_pretrained(path)
    loaded.eval()
    if DEVICE == "cuda" and torch.cuda.is_available():
        loaded = loaded.cuda()
        amp = _amp_dtype()
        if amp is not None:
            try:
                loaded = loaded.to(dtype=amp)
                logger.info("Magpie weights cast to %s", str(amp).replace("torch.", ""))
            except Exception:
                logger.warning("weight cast to %s failed; using autocast only", amp, exc_info=True)
    else:
        loaded = loaded.cpu()
    model = loaded
    _AMP_DTYPE = _amp_dtype()
    sample_rate = int(
        getattr(loaded, "output_sample_rate", None)
        or getattr(loaded, "sample_rate", None)
        or 22050
    )
    if WARMUP:
        _synthesize_sync(
            "Hi, thanks for calling. How can I help you today?",
            DEFAULT_SPEAKER,
            "en",
            None,
            None,
            None,
            DEFAULT_USE_CFG,
            DEFAULT_APPLY_TN,
        )
        if DEVICE == "cuda" and torch.cuda.is_available():
            torch.cuda.synchronize()
        logger.info("Magpie warmup done in %.2fs", time.perf_counter() - t0)
    ready = True
    load_error = None
    logger.info(
        "Magpie ready sr=%s amp=%s cfg_default=%s tn_default=%s in %.2fs",
        sample_rate,
        str(_AMP_DTYPE).replace("torch.", "") if _AMP_DTYPE is not None else "off",
        DEFAULT_USE_CFG,
        DEFAULT_APPLY_TN,
        time.perf_counter() - t0,
    )


def _synthesize_sync(
    text: str,
    speaker: str,
    language: str,
    temperature: Optional[float],
    cfg_scale: Optional[float],
    top_k: Optional[int],
    use_cfg: bool,
    apply_tn: bool,
) -> bytes:
    assert model is not None
    _set_inference_params(temperature, cfg_scale, top_k)
    kwargs: dict[str, Any] = {
        "transcript": text,
        "language": _language(language),
        "apply_TN": bool(apply_tn),
        "use_cfg": bool(use_cfg),
        "speaker_index": _speaker_index(speaker),
    }
    call_kwargs = {k: v for k, v in kwargs.items() if k in _do_tts_params()}
    amp_ctx: Any = nullcontext()
    if _AMP_DTYPE is not None and DEVICE == "cuda" and torch.cuda.is_available():
        amp_ctx = torch.autocast(device_type="cuda", dtype=_AMP_DTYPE)
    t_gen = time.perf_counter()
    with torch.inference_mode(), amp_ctx:
        audio, audio_len = model.do_tts(**call_kwargs)
        if DEVICE == "cuda" and torch.cuda.is_available():
            torch.cuda.synchronize()
    gen_ms = (time.perf_counter() - t_gen) * 1000
    if hasattr(audio_len, "shape") and getattr(audio_len, "shape", None):
        n = int(audio_len[0].item())
        wave = audio[0, :n].detach().float().cpu().numpy()
    else:
        wave = audio.detach().float().cpu().numpy().squeeze()
    wave = np.asarray(wave, dtype=np.float32)
    peak = float(np.max(np.abs(wave))) if wave.size else 0.0
    if peak > 1.0:
        wave = wave / peak
    buf = io.BytesIO()
    sf.write(buf, wave, sample_rate, format="WAV", subtype="PCM_16")
    logger.info(
        "synth speaker=%s lang=%s chars=%s cfg=%s tn=%s gen_ms=%.0f wav_ms=%.0f",
        speaker,
        language,
        len(text),
        use_cfg,
        apply_tn,
        gen_ms,
        (time.perf_counter() - t_gen) * 1000,
    )
    return buf.getvalue()


class TtsBody(BaseModel):
    text: str = Field(..., min_length=1)
    speaker: Optional[str] = None
    language: Optional[str] = None
    temperature: Optional[float] = Field(default=None, ge=0.05, le=1.5)
    cfg_scale: Optional[float] = Field(default=None, ge=0.5, le=5.0)
    top_k: Optional[int] = Field(default=None, ge=1, le=200)
    use_cfg: Optional[bool] = None
    apply_tn: Optional[bool] = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global load_error
    try:
        await run_in_threadpool(_load_model)
    except Exception as exc:
        load_error = str(exc)
        logger.exception("Magpie load failed")
    yield


app = FastAPI(title="VeraLux Magpie TTS", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.get("/health")
async def health():
    if ready and model is not None:
        return {
            "ok": True,
            "engine": "magpie_tts",
            "model": MODEL_ID,
            "device": DEVICE,
            "dtype": DTYPE_STR,
            "use_cfg_default": DEFAULT_USE_CFG,
            "apply_tn_default": DEFAULT_APPLY_TN,
            "sample_rate": sample_rate,
            "speakers": [s["id"] for s in SPEAKERS],
        }
    status = 503
    return JSONResponse(
        {"ok": False, "error": load_error or "loading"},
        status_code=status,
    )


@app.get("/voices")
async def voices():
    return {"speakers": SPEAKERS, "languages": LANGUAGES}


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def tts(request: Request, body: TtsBody):
    if not ready or model is None:
        return JSONResponse({"error": load_error or "not_ready"}, status_code=503)
    text = body.text.strip()
    if not text:
        return JSONResponse({"error": "empty_text"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": "text_too_long", "max": MAX_TEXT}, status_code=400)
    use_cfg = DEFAULT_USE_CFG if body.use_cfg is None else bool(body.use_cfg)
    apply_tn = DEFAULT_APPLY_TN if body.apply_tn is None else bool(body.apply_tn)
    t0 = time.perf_counter()
    async with sem:
        wav = await run_in_threadpool(
            _synthesize_sync,
            text,
            body.speaker or DEFAULT_SPEAKER,
            body.language or DEFAULT_LANGUAGE,
            body.temperature,
            body.cfg_scale,
            body.top_k,
            use_cfg,
            apply_tn,
        )
    logger.info(
        "tts speaker=%s lang=%s chars=%s cfg=%s tn=%s ms=%.0f",
        body.speaker or DEFAULT_SPEAKER,
        body.language or DEFAULT_LANGUAGE,
        len(text),
        use_cfg,
        apply_tn,
        (time.perf_counter() - t0) * 1000,
    )
    return Response(content=wav, media_type="audio/wav")
