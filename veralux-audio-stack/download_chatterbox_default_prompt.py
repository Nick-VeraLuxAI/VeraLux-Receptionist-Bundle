#!/usr/bin/env python3
"""
Download English speech WAV for Chatterbox Turbo when no speaker_wav_url is sent.
Turbo requires the reference clip to be longer than 5 seconds; the Coqui XTTS-v2
en_sample is ~3s, so we tile it until duration meets that minimum.
"""
import io
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

URL = "https://huggingface.co/coqui/XTTS-v2/resolve/main/samples/en_sample.wav"
OUT = Path(os.getenv("CHATTERBOX_DEFAULT_PROMPT_OUT", "/app/chatterbox_default_prompt.wav"))
# Chatterbox Turbo asserts len(samples) / sr > 5.0
MIN_DURATION_SEC = float(os.getenv("CHATTERBOX_DEFAULT_PROMPT_MIN_SEC", "5.5"))


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.is_file() and OUT.stat().st_size > 1000:
        try:
            audio, sr = sf.read(str(OUT), dtype="float32")
            if audio.ndim > 1:
                audio = np.mean(audio, axis=1)
            if len(audio) / float(sr) >= MIN_DURATION_SEC:
                print("exists:", OUT)
                return 0
        except Exception as e:
            print("rebuild default prompt (invalid or short file):", e, file=sys.stderr)

    ctx = ssl.create_default_context()
    try:
        urllib.request.urlopen("https://huggingface.co/", timeout=10, context=ctx)
    except (ssl.SSLError, urllib.error.URLError):
        ctx = ssl._create_unverified_context()
        print("  (using SSL fallback)", file=sys.stderr)

    print("Downloading default Chatterbox Turbo prompt WAV ->", OUT)
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "VeraLux-Chatterbox-Build/1.0"})
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            data = resp.read()
        if len(data) < 1000:
            print("download too small", file=sys.stderr)
            return 1
        audio, sr = sf.read(io.BytesIO(data), dtype="float32")
        if audio.ndim > 1:
            audio = np.mean(audio, axis=1)
        dur = len(audio) / float(sr)
        if dur < MIN_DURATION_SEC:
            reps = int(np.ceil(MIN_DURATION_SEC / dur)) + 1
            audio = np.tile(audio, reps)
            trim = int(MIN_DURATION_SEC * sr)
            audio = audio[:trim]
            print(f"tiled {dur:.2f}s x{reps} -> {len(audio)/sr:.2f}s", file=sys.stderr)
        sf.write(str(OUT), audio, sr, subtype="PCM_16")
        print("ok:", OUT.stat().st_size, "bytes", f"~{len(audio)/sr:.2f}s @ {sr}Hz")
    except Exception as e:
        print("failed:", e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
