#!/usr/bin/env python3
"""
Download a short English speech WAV for Chatterbox Turbo when no speaker_wav_url is sent.
Uses the same Coqui XTTS-v2 public sample as our XTTS image (clear speech, suitable as conditioning).
"""
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

URL = "https://huggingface.co/coqui/XTTS-v2/resolve/main/samples/en_sample.wav"
OUT = Path(os.getenv("CHATTERBOX_DEFAULT_PROMPT_OUT", "/app/chatterbox_default_prompt.wav"))


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.is_file() and OUT.stat().st_size > 1000:
        print("exists:", OUT)
        return 0

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
        OUT.write_bytes(data)
        print("ok:", OUT.stat().st_size, "bytes")
    except Exception as e:
        print("failed:", e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
