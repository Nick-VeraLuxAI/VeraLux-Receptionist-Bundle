#!/usr/bin/env python3
"""
Analyze mono 16-bit STT debug WAVs: levels, largest sample steps, and framing checks.

Typical RX → STT path (PSTN, simplified):
  RTP → codec decode (AMR-WB pad/trim, ffmpeg, etc.)
  → media ingest (pending PCM merge + STT emit chunking)
  → call session onPcm16Frame
  → optional Speex AEC (20 ms frames; see STT_DEBUG_AEC_NEAR_OUT_WAV for L/R tap)
  → ChunkedSTT buffer / concat
  → preWhisperGate (before/after dumps often identical if only WAV wrap)
  → Whisper HTTP

Use this on prewhisper_*_after.wav, whisper_*_final*.wav, rx_*.wav, or aec_near_out_* stereo.

Debug taps (runtime env) from early to late:
  STT_DEBUG_DUMP_PCM16 — codec decode rolling dumps (per-call subdirs + post_decode)
  AUDIO_TAP=1 — media ingest checkpoints (e.g. EMITTED_BUFFERED) if enabled
  STT_DEBUG_AEC_NEAR_OUT_WAV — stereo L=near R=out on call end (20 ms aligned; needs AEC path)
  STT_DEBUG_DUMP_RX_WAV — short capture after playback; PCM is post-AEC (same as STT feed)
  preWhisper before/after — often identical if input is already WAV PCM16
  STT_DEBUG_DUMP_WHISPER_WAVS — exact HTTP payload to Whisper

Examples:
  python3 scripts/analyze_stt_wav.py path/to/dump.wav
  python3 scripts/analyze_stt_wav.py dump.wav --compare-bin raw_before.bin --sample-rate 16000
"""

from __future__ import annotations

import argparse
import math
import struct
import sys
import wave
from pathlib import Path


def load_wav(path: Path, channel: str) -> tuple[list[int], int, int]:
    """Return (samples, sample_rate, num_channels)."""
    with wave.open(str(path), "rb") as w:
        ch, sw, sr, nframes, _, _ = w.getparams()
        if sw != 2:
            raise SystemExit(f"expected 16-bit PCM, got width {sw}")
        raw = w.readframes(nframes)
    all_s = list(struct.unpack("<" + "h" * (len(raw) // 2), raw))
    if ch == 1:
        return all_s, sr, 1
    if channel == "all":
        return all_s, sr, ch
    idx = {"l": 0, "r": 1, "0": 0, "1": 1}.get(channel.lower(), 0)
    if idx >= ch:
        raise SystemExit(f"channel index {idx} out of range for {ch}-channel wav")
    return [all_s[i] for i in range(idx, len(all_s), ch)], sr, ch


def load_raw_s16le(path: Path) -> list[int]:
    raw = path.read_bytes()
    if len(raw) % 2 != 0:
        raise SystemExit("raw bin length is not multiple of 2")
    return list(struct.unpack("<" + "h" * (len(raw) // 2), raw))


def report(samples: list[int], sr: int, label: str) -> None:
    n = len(samples)
    print(f"\n=== {label} ===")
    print(f"sample_rate_hz: {sr}")
    print(f"samples: {n}")
    print(f"duration_ms: {1000.0 * n / sr:.2f}")

    if n == 0:
        return

    mn, mx = min(samples), max(samples)
    mean = sum(samples) / n
    rms = math.sqrt(sum(s * s for s in samples) / n)
    peak = max(abs(s) for s in samples)
    print(f"min: {mn}  max: {mx}  mean: {mean:.4f}  rms: {rms:.2f}  peak_abs: {peak}")
    print(f"crest peak/rms: {peak / (rms + 1e-9):.2f}")

    d = [abs(samples[i + 1] - samples[i]) for i in range(n - 1)]
    max_d = max(d)
    max_i = d.index(max_d)
    print(f"\nmax |adjacent delta|: {max_d} at sample {max_i} ({1000 * max_i / sr:.3f} ms)")

    top_n = min(15, len(d))
    idx_sorted = sorted(range(len(d)), key=lambda i: d[i], reverse=True)[:top_n]
    print(f"top {top_n} adjacent |delta| (index, ms, delta):")
    for i in idx_sorted:
        print(f"  {i:6d}  {1000 * i / sr:8.3f} ms  {d[i]:6d}")

    for stride in (320, 160, 80):
        jumps = [abs(samples[k] - samples[k - 1]) for k in range(stride, n, stride)]
        mxj = max(jumps) if jumps else 0
        big = sum(1 for j in jumps if j > 2000)
        print(f"\nstride {stride} ({1000 * stride / sr:.1f}ms) boundary |delta| max: {mxj}, >2000: {big}/{len(jumps)}")

    intra_max = 0
    intra_idx = 0
    for b in range(0, n // 320):
        start = b * 320
        end = start + 320
        for i in range(start, end - 1):
            dd = abs(samples[i + 1] - samples[i])
            if dd > intra_max:
                intra_max = dd
                intra_idx = i
    print(f"\nmax |delta| inside full 320-sample blocks: {intra_max} at sample {intra_idx}")

    big3 = sum(1 for i in range(n - 1) if d[i] > 3000)
    print(f"adjacent |delta| > 3000: {big3}")

    near_z = sum(1 for s in samples if abs(s) <= 8)
    print(f"samples |s|<=8: {near_z} ({100 * near_z / n:.1f}%)")


def main() -> None:
    p = argparse.ArgumentParser(description="Analyze STT debug WAV (16-bit PCM).")
    p.add_argument("wav", type=Path, help="Path to .wav")
    p.add_argument(
        "--channel",
        choices=("l", "r", "0", "1", "all"),
        default="l",
        help="For stereo: l/0=near (AEC tap), r/1=out; all=interleaved diagnostic only",
    )
    p.add_argument("--compare-bin", type=Path, help="Raw s16le mono PCM to diff against WAV samples")
    p.add_argument("--sample-rate", type=int, default=16000, help="Label only for compare-bin length check")
    args = p.parse_args()

    if not args.wav.is_file():
        raise SystemExit(f"not a file: {args.wav}")

    loaded, sr, ch = load_wav(args.wav, args.channel)

    if ch == 2 and args.channel == "all":
        left = [loaded[i] for i in range(0, len(loaded), 2)]
        right = [loaded[i] for i in range(1, len(loaded), 2)]
        report(left, sr, f"{args.wav.name} (L / near)")
        report(right, sr, f"{args.wav.name} (R / AEC out)")
        diffs = [abs(left[i] - right[i]) for i in range(min(len(left), len(right)))]
        if diffs:
            print(f"\n=== L vs R per-sample |diff| ===\nmax: {max(diffs)}  mean: {sum(diffs)/len(diffs):.2f}")
    else:
        label = args.wav.name if ch == 1 else f"{args.wav.name} ch={args.channel}"
        report(loaded, sr, label)

    samples_for_cmp = (
        loaded
        if ch == 1 or args.channel != "all"
        else [loaded[i] for i in range(0, len(loaded), 2)]
    )

    if args.compare_bin:
        if not args.compare_bin.is_file():
            raise SystemExit(f"not a file: {args.compare_bin}")
        other = load_raw_s16le(args.compare_bin)
        if len(other) != len(samples_for_cmp):
            print(
                f"\ncompare-bin length {len(other)} != wav samples {len(samples_for_cmp)} (sr hint {args.sample_rate})",
                file=sys.stderr,
            )
        n = min(len(samples_for_cmp), len(other))
        diffs = [abs(samples_for_cmp[i] - other[i]) for i in range(n)]
        mx = max(diffs) if diffs else 0
        print(f"\n=== compare {args.compare_bin.name} ===")
        print(f"compared: {n} samples  max |diff|: {mx}  identical: {mx == 0}")


if __name__ == "__main__":
    main()
