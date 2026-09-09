from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel
from kokoro_onnx import Kokoro
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from starlette.concurrency import run_in_threadpool
import asyncio
import logging
import soundfile as sf
import io
import os
import re
import numpy as np

# Rate limiting
RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "30")
limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

logger = logging.getLogger("kokoro_server")

KOKORO_MODEL_PATH = os.getenv("KOKORO_MODEL_PATH", "kokoro-v1.0.onnx")
KOKORO_VOICES_PATH = os.getenv("KOKORO_VOICES_PATH", "voices-v1.0.bin")
KOKORO_DEFAULT_VOICE = os.getenv("KOKORO_DEFAULT_VOICE", "bf_emma")
KOKORO_MAX_TEXT_CHARS = int(os.getenv("KOKORO_MAX_TEXT_CHARS", "1000"))
KOKORO_MAX_CONCURRENT = int(os.getenv("KOKORO_MAX_CONCURRENT", "2"))
KOKORO_MIN_SPEED = float(os.getenv("KOKORO_MIN_SPEED", "0.5"))
KOKORO_MAX_SPEED = float(os.getenv("KOKORO_MAX_SPEED", "1.5"))
KOKORO_DEVICE = os.getenv("KOKORO_DEVICE")
KOKORO_WARMUP = os.getenv("KOKORO_WARMUP", "true").strip().lower() in ("1", "true", "yes", "on")
KOKORO_WARMED = False

# Load Kokoro model + voices at startup (configurable for future GPU use).
if KOKORO_DEVICE:
    try:
        kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH, device=KOKORO_DEVICE)
    except TypeError:
        logger.warning(
            "KOKORO_DEVICE set but kokoro_onnx does not support device arg; using default device"
        )
        kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
else:
    kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)

tts_semaphore = asyncio.Semaphore(KOKORO_MAX_CONCURRENT)


class TTSRequest(BaseModel):
    text: str
    voice_id: str | None = KOKORO_DEFAULT_VOICE  # default voice if client doesn't send one
    voice: str | None = None  # Node runtime sends `voice`; prefer voice_id when both set

    # new tuning fields (match what your Node code sends)
    rate: float | None = 1.0       # maps to Kokoro "speed"
    energy: float | None = 1.0     # currently unused, placeholder
    variation: float | None = 1.0  # currently unused, placeholder


def _normalize_kokoro_text(text: str) -> str:
    t = (text or "").replace("\r", "\n")
    t = re.sub(r"[\n\t]+", " ", t)
    t = re.sub(r" {2,}", " ", t).strip()
    return t


def _create_samples(text: str, voice: str, speed: float):
    try:
        return kokoro.create(text, voice=voice, speed=speed)
    except RuntimeError as exc:
        if "number of lines" not in str(exc).lower():
            raise
        parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()]
        if len(parts) < 2:
            parts = [_normalize_kokoro_text(text.replace("!", ".").replace("?", "."))]
        wavs = []
        sample_rate = None
        for part in parts:
            samples, sample_rate = kokoro.create(part, voice=voice, speed=speed)
            wavs.append(samples)
        return np.concatenate(wavs), sample_rate


def _samples_to_wav(samples, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return buf.getvalue()


def _synthesize_wav(text: str, voice: str, speed: float) -> bytes:
    text = _normalize_kokoro_text(text)
    samples, sample_rate = _create_samples(text, voice, speed)
    return _samples_to_wav(samples, sample_rate)


async def _iter_vlx1_stream(text: str, voice: str, speed: float):
    """VLX1 + [u32be len][wav] chunks. Sentence splits first so first audio can start early."""
    yield b"VLX1"
    text = _normalize_kokoro_text(text)
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()]
    if len(parts) < 2:
        parts = [text]

    create_stream = getattr(kokoro, "create_stream", None)
    emitted = 0
    for index, part in enumerate(parts):
        part_emitted = False
        if create_stream is not None:
            try:
                stream = create_stream(part, voice=voice, speed=speed, lang="en-us")
                if asyncio.iscoroutine(stream):
                    stream = await stream
                async for samples, sample_rate in stream:
                    wav = _samples_to_wav(samples, sample_rate)
                    if not wav:
                        continue
                    emitted += 1
                    part_emitted = True
                    logger.info(
                        "kokoro stream chunk=%s part=%s/%s bytes=%s",
                        emitted,
                        index + 1,
                        len(parts),
                        len(wav),
                    )
                    yield len(wav).to_bytes(4, "big") + wav
            except Exception:
                logger.exception("kokoro create_stream failed on part %s", index + 1)
        if not part_emitted:
            samples, sample_rate = await run_in_threadpool(_create_samples, part, voice, speed)
            wav = _samples_to_wav(samples, sample_rate)
            emitted += 1
            logger.info(
                "kokoro stream chunk=%s part=%s/%s bytes=%s via_create",
                emitted,
                index + 1,
                len(parts),
                len(wav),
            )
            yield len(wav).to_bytes(4, "big") + wav

    if emitted == 0:
        wav = _synthesize_wav(text, voice, speed)
        yield len(wav).to_bytes(4, "big") + wav


@app.on_event("startup")
async def _warmup_kokoro():
    global KOKORO_WARMED
    if not KOKORO_WARMUP:
        return
    voices = []
    for voice in (KOKORO_DEFAULT_VOICE, "af_heart", "af_bella"):
        if voice and voice not in voices:
            voices.append(voice)
    try:
        for voice in voices:
            await run_in_threadpool(_synthesize_wav, "Hi thanks for calling.", voice, 1.0)
            logger.info("kokoro warmup complete voice=%s", voice)
        KOKORO_WARMED = True
    except Exception:
        logger.exception("kokoro warmup failed")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": KOKORO_MODEL_PATH,
        "voices": KOKORO_VOICES_PATH,
        "device": KOKORO_DEVICE or "default",
        "warmed": KOKORO_WARMED,
        "default_voice": KOKORO_DEFAULT_VOICE,
        "stream": hasattr(kokoro, "create_stream"),
    }


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def synthesize(request: Request, req: TTSRequest):
    try:
        text = (req.text or "").strip()
        if not text:
            return JSONResponse({"error": "text is required"}, status_code=400)
        if len(text) > KOKORO_MAX_TEXT_CHARS:
            return JSONResponse({"error": "text too long"}, status_code=413)

        # voice: Node sends `voice`; server also accepts voice_id
        voice = (req.voice or req.voice_id or KOKORO_DEFAULT_VOICE).strip()
        if voice.lower() == "default":
            voice = KOKORO_DEFAULT_VOICE

        # map rate -> speed for Kokoro
        speed = req.rate if req.rate is not None else 1.0
        if speed < KOKORO_MIN_SPEED:
            speed = KOKORO_MIN_SPEED
        if speed > KOKORO_MAX_SPEED:
            speed = KOKORO_MAX_SPEED

        # (energy / variation are accepted but not used for now)
        # You *could* later use them to choose different voices
        # or tweak text shaping on the Node side.

        async with tts_semaphore:
            wav_bytes = await run_in_threadpool(_synthesize_wav, text, voice, speed)

        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception:
        logger.exception("TTS synthesis failed")
        return JSONResponse({"error": "TTS synthesis failed"}, status_code=500)


@app.post("/tts/stream")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def synthesize_stream(request: Request, req: TTSRequest):
    try:
        text = (req.text or "").strip()
        if not text:
            return JSONResponse({"error": "text is required"}, status_code=400)
        if len(text) > KOKORO_MAX_TEXT_CHARS:
            return JSONResponse({"error": "text too long"}, status_code=413)

        voice = (req.voice or req.voice_id or KOKORO_DEFAULT_VOICE).strip()
        if voice.lower() == "default":
            voice = KOKORO_DEFAULT_VOICE

        speed = req.rate if req.rate is not None else 1.0
        if speed < KOKORO_MIN_SPEED:
            speed = KOKORO_MIN_SPEED
        if speed > KOKORO_MAX_SPEED:
            speed = KOKORO_MAX_SPEED

        async def gated():
            async with tts_semaphore:
                async for chunk in _iter_vlx1_stream(text, voice, speed):
                    yield chunk

        return StreamingResponse(
            gated(),
            media_type="application/octet-stream",
            headers={
                "X-Kokoro-Stream": "vlx1",
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception:
        logger.exception("TTS stream failed")
        return JSONResponse({"error": "TTS synthesis failed"}, status_code=500)
