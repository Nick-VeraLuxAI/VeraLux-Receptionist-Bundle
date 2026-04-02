#!/usr/bin/env python3
"""
Comprehensive Whisper FINAL (and optional RX) WAV sweep:
  ffprobe, tail RMS spikes, lag-k 20ms chunk replay, clipping/silence, optional WRX overlap.

Example:
  python3 scripts/whisper_wav_sweep.py \\
    --wfinal stt-debug-export/call-gCzb-latest/whisper_*_final_6_*.wav \\
    --wrx stt-debug-export/call-gCzb-latest/rx_after_playback_*.wav
"""
from __future__ import annotations

import argparse
import hashlib
import math
import struct
import subprocess
import sys
import wave
from collections import Counter
from pathlib import Path


def load_mono(path: Path) -> tuple[list[int], int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    s = list(struct.unpack("<" + "h" * (len(raw) // 2), raw))
    if ch == 2:
        s = [(s[i] + s[i + 1]) // 2 for i in range(0, len(s), 2)]
    return s, sr


def ffprobe(path: Path) -> None:
    r = subprocess.run(
        [
            "ffprobe",
            "-hide_banner",
            "-loglevel",
            "error",
            "-show_entries",
            "format=duration",
            "-show_entries",
            "stream=codec_name,sample_rate,channels,channel_layout",
            "-of",
            "default=noprint_wrappers=1",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    print(r.stdout or r.stderr or "(no ffprobe output)")
    if r.returncode != 0:
        print("ffprobe failed; install ffmpeg or check path", file=sys.stderr)


def tail_rms(samples: list[int], sr: int, label: str) -> None:
    win = int(sr * 0.05)
    rms: list[float] = []
    for i in range(0, len(samples), win):
        blk = samples[i : i + win]
        if not blk:
            break
        rms.append(math.sqrt(sum(x * x for x in blk) / len(blk)))
    dur = len(samples) / sr
    mx = max(rms) if rms else 0.0
    tail_blocks = int(2 / 0.05)
    tail = rms[-tail_blocks:] if len(rms) > tail_blocks else rms
    print(f"\n--- tail RMS (50ms) {label} ---")
    print(f"sr={sr} dur_s={dur:.3f} blocks50ms={len(rms)} max_rms={mx:.1f}")
    print("tail_rms_norm:", " ".join(f"{(v / mx):.2f}" if mx else "0.00" for v in tail))
    spikes = [i for i, v in enumerate(tail) if mx and v > 0.35 * mx]
    if spikes:
        t0 = dur - 2
        print("tail_spike_times_s:", [round(t0 + i * 0.05, 2) for i in spikes])
    else:
        print("no_tail_spikes_over_35pct_max")


def lag_k_scan(samples: list[int], sr: int, label: str) -> None:
    chunk_samples = int(sr * 0.02)
    chunks: list[bytes] = []
    for i in range(0, len(samples), chunk_samples):
        blk = samples[i : i + chunk_samples]
        if len(blk) < chunk_samples:
            break
        chunks.append(hashlib.sha1(struct.pack("<" + "h" * len(blk), *blk)).digest())
    n = len(chunks)
    uniq = len(set(chunks))
    print(f"\n--- lag-k replay {label} ---")
    print("chunks_20ms:", n, "unique:", uniq, "dup_total:", n - uniq, "dup_pct:", round(100 * (n - uniq) / max(1, n), 2))
    lag_counts: Counter[int] = Counter()
    for k in range(1, 65):
        c = sum(1 for i in range(k, n) if chunks[i] == chunks[i - k])
        if c:
            lag_counts[k] = c
    print("top_lag_dups:", lag_counts.most_common(12))
    tail_secs = 3
    tail_n = int(tail_secs / 0.02)
    start = max(0, n - tail_n)
    tail = chunks[start:]
    tlen = len(tail)
    lag2: Counter[int] = Counter()
    for k in range(1, 65):
        c = sum(1 for i in range(k, tlen) if tail[i] == tail[i - k])
        if c:
            lag2[k] = c
    print(f"tail({tail_secs}s)_top_lag_dups:", lag2.most_common(12))
    adj = [i for i in range(1, n) if chunks[i] == chunks[i - 1]]
    print("adjacent_repeats:", len(adj))


def clip_silence(samples: list[int], sr: int, label: str) -> None:
    n = len(samples)
    absmax = max(abs(x) for x in samples) if samples else 0
    clip = sum(1 for x in samples if abs(x) >= 32760)
    print(f"\n--- clip/silence {label} ---")
    print("absmax:", absmax, "clip_samples:", clip, "clip_pct:", round(100 * clip / max(1, n), 4))
    tail = int(sr * 2)
    tail_s = samples[-tail:] if n > tail else samples
    thr = 300
    silent = sum(1 for x in tail_s if abs(x) <= thr)
    print(f"tail_2s_silence_pct_under_{thr}:", round(100 * silent / max(1, len(tail_s)), 2))


def compare_wrx(wfinal: Path, wrx: Path, sr1: int, sa: list[int]) -> None:
    sb, sr2 = load_mono(wrx)
    print("\n--- WFINAL vs WRX (250ms window hash overlap) ---")
    print("WFINAL:", wfinal.name, "n", len(sa))
    print("WRX:", wrx.name, "sr", sr2, "n", len(sb))
    if sr2 != sr1:
        print("WARNING: sample rate mismatch; overlap metric is approximate.")
    win = int(sr1 * 0.25)

    def hashes(x: list[int], w: int) -> list[str]:
        if len(x) < 160:
            return []
        if len(x) <= w:
            bb = struct.pack("<" + "h" * len(x), *x)
            return [hashlib.sha1(bb).hexdigest()]
        hs: list[str] = []
        for i in range(0, len(x) - w + 1, w):
            blk = x[i : i + w]
            bb = struct.pack("<" + "h" * len(blk), *blk)
            hs.append(hashlib.sha1(bb).hexdigest())
        return hs

    ha = set(hashes(sa, win))
    hb = hashes(sb, min(win, len(sb)))
    over = sum(1 for h in hb if h in ha)
    print("WRX windows overlapping WFINAL:", over, "/", len(hb))


def main() -> None:
    ap = argparse.ArgumentParser(description="Whisper FINAL WAV diagnostic sweep")
    ap.add_argument("--wfinal", type=Path, required=True, help="Path to whisper_*_final_*.wav")
    ap.add_argument("--wrx", type=Path, help="Optional rx_after_playback_*.wav")
    args = ap.parse_args()
    wf = args.wfinal
    if not wf.is_file():
        sys.exit(f"not found: {wf}")

    print("=== (1) ffprobe ===")
    ffprobe(wf)

    samples, sr = load_mono(wf)
    if sr != 16000:
        print(f"WARNING: sample_rate {sr} != 16000", file=sys.stderr)

    tail_rms(samples, sr, wf.name)
    lag_k_scan(samples, sr, wf.name)
    clip_silence(samples, sr, wf.name)

    if args.wrx and args.wrx.is_file():
        compare_wrx(wf, args.wrx, sr, samples)
    elif args.wrx:
        print("\nWRX path not found:", args.wrx, file=sys.stderr)

    print(
        "\nInterpret: lag=1 heavy → adjacent chunk replay; lag 2–32 → windowed replay; "
        "many finals on one call with clean per-file scans → multiple endpointing events, not in-file echo."
    )


if __name__ == "__main__":
    main()
