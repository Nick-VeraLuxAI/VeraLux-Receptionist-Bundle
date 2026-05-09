#!/usr/bin/env python3
"""
Post-call forensic analyzer for VeraLux audio forensics bundles.
Writes <call-folder>/analysis/*. No network; no secrets emitted.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional


FILLER = frozenset(
    "a an the uh um hmm mm mhm ok okay yeah yep nope hi hello yes no i me my we you it is are was"
    .split()
)


def normalize_text(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"\s+", " ", s)
    return s


def token_set(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9']+", normalize_text(text)) if t not in FILLER and len(t) > 1}


def jaccard(a: str, b: str) -> float:
    sa, sb = token_set(a), token_set(b)
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def substring_hits(a: str, b: str) -> bool:
    na, nb = normalize_text(a), normalize_text(b)
    if len(na) < 8 or len(nb) < 8:
        return na in nb or nb in na
    return na in nb or nb in na


def fuzzy_ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_text(a), normalize_text(b)).ratio()


@dataclass
class EchoCompare:
    best_ref: str
    substring: bool
    jaccard: float
    fuzzy: float
    verdict: str  # likely_echo | possible_echo | likely_human


def compare_echo(user: str, refs: list[str]) -> Optional[EchoCompare]:
    user = user.strip()
    if not user or not refs:
        return None
    best: Optional[tuple[float, str, bool, float, float]] = None
    for ref in refs:
        r = ref.strip()
        if not r:
            continue
        sub = substring_hits(user, r)
        jac = jaccard(user, r)
        fz = fuzzy_ratio(user, r)
        score = max(jac, fz, 1.0 if sub else 0.0)
        if best is None or score > best[0]:
            best = (score, r, sub, jac, fz)
    if best is None:
        return None
    _, ref, sub, jac, fz = best
    if sub and fz >= 0.55:
        verdict = "likely_echo"
    elif fz >= 0.72 or jac >= 0.55:
        verdict = "likely_echo"
    elif fz >= 0.45 or jac >= 0.35:
        verdict = "possible_echo"
    else:
        verdict = "likely_human"
    return EchoCompare(best_ref=ref, substring=sub, jaccard=jac, fuzzy=fz, verdict=verdict)


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def load_json(p: Path) -> Any:
    try:
        return json.loads(read_text(p))
    except (json.JSONDecodeError, OSError):
        return None


def parse_timeline(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def ffprobe_wav(path: Path) -> dict[str, Any]:
    out: dict[str, Any] = {"path": str(path), "duration_sec": None, "sample_rate": None, "channels": None}
    if not path.is_file():
        return out
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate,channels,bits_per_sample:format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if r.returncode != 0:
            return out
        data = json.loads(r.stdout or "{}")
        fmt = data.get("format") or {}
        st = (data.get("streams") or [{}])[0]
        d = fmt.get("duration")
        if d is not None:
            try:
                out["duration_sec"] = float(d)
            except (TypeError, ValueError):
                pass
        sr = st.get("sample_rate")
        if sr is not None:
            try:
                out["sample_rate"] = int(sr)
            except (TypeError, ValueError):
                out["sample_rate"] = sr
        ch = st.get("channels")
        if ch is not None:
            try:
                out["channels"] = int(ch)
            except (TypeError, ValueError):
                out["channels"] = ch
        bps = st.get("bits_per_sample")
        if bps is not None:
            out["bits_per_sample"] = bps
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return out


def ffmpeg_astats_rms_peak(path: Path) -> tuple[Optional[float], Optional[float]]:
    if not path.is_file():
        return None, None
    try:
        r = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostats",
                "-i",
                str(path),
                "-af",
                "astats=metadata=1:reset=1",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        text = (r.stderr or "") + (r.stdout or "")
        rms = peak = None
        for line in text.splitlines():
            if "RMS level dB" in line and rms is None:
                m = re.search(r"-?[\d.]+", line)
                if m:
                    try:
                        rms = float(m.group(0))
                    except ValueError:
                        pass
            if "Peak level dB" in line and peak is None:
                m = re.search(r"-?[\d.]+", line)
                if m:
                    try:
                        peak = float(m.group(0))
                    except ValueError:
                        pass
        return rms, peak
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, None


def glob_count(root: Path, pat: str) -> list[Path]:
    return sorted(root.glob(pat))


def id_from_name(pat: re.Pattern, name: str) -> Optional[str]:
    m = pat.search(name)
    return m.group(1) if m else None


@dataclass
class TurnBundle:
    turn_id: str
    utterance_ids: list[str] = field(default_factory=list)
    norm_transcript: str = ""
    llm_input: str = ""
    llm_response: str = ""
    policy: Optional[dict] = None
    whisper_wav: Optional[Path] = None
    tts_wav: Optional[Path] = None
    playback_wav: Optional[Path] = None


def build_turn_bundles(call: Path, timeline: list[dict]) -> list[TurnBundle]:
    """Link files by turn_id / utterance_id using names and timeline hints."""
    u_to_t: dict[str, str] = {}
    # Any timeline row may carry both IDs (not only specific events).
    for row in timeline:
        uid = row.get("utteranceId") or row.get("utterance_id")
        tid = row.get("turnId") or row.get("turn_id")
        if uid and tid:
            u_to_t[str(uid)] = str(tid)

    turns: dict[str, TurnBundle] = {}

    pat_007 = re.compile(r"007_normalized_transcript_(.+)\.txt$")
    pat_009 = re.compile(r"009_transcript_to_llm_(.+)\.txt$")
    pat_010 = re.compile(r"010_llm_response_(.+)\.txt$")
    pat_005 = re.compile(r"005_whisper_request_(.+)\.wav$")
    pat_012 = re.compile(r"012_tts_raw_.*_(.+)\.wav$|012_tts_raw_(.+)\.wav$")
    pat_013 = re.compile(r"013_telnyx_playback_.*_(.+)\.wav$|013_telnyx_playback_(.+)\.wav$")

    for p in glob_count(call / "transcripts", "008_transcript_policy_*.json"):
        raw = load_json(p)
        if isinstance(raw, dict):
            uid = raw.get("utteranceId") or raw.get("utterance_id")
            tid = raw.get("turnId") or raw.get("turn_id")
            if isinstance(uid, str) and isinstance(tid, str):
                u_to_t[uid] = tid

    for p in glob_count(call / "llm", "009_transcript_to_llm_*.txt"):
        tid = id_from_name(pat_009, p.name)
        if tid:
            turns.setdefault(tid, TurnBundle(turn_id=tid)).llm_input = read_text(p).strip()

    for p in glob_count(call / "llm", "010_llm_response_*.txt"):
        tid = id_from_name(pat_010, p.name)
        if tid:
            turns.setdefault(tid, TurnBundle(turn_id=tid)).llm_response = read_text(p).strip()

    for p in glob_count(call / "transcripts", "007_normalized_transcript_*.txt"):
        uid = id_from_name(pat_007, p.name)
        if not uid:
            continue
        tid = u_to_t.get(uid)
        if not tid:
            continue
        b = turns.setdefault(tid, TurnBundle(turn_id=tid))
        if uid not in b.utterance_ids:
            b.utterance_ids.append(uid)
        b.norm_transcript = read_text(p).strip()

    for p in glob_count(call / "transcripts", "008_transcript_policy_*.json"):
        raw = load_json(p)
        if not isinstance(raw, dict):
            continue
        tid = raw.get("turnId") or raw.get("turn_id")
        matched = False
        if tid:
            turns.setdefault(str(tid), TurnBundle(turn_id=str(tid))).policy = raw
            matched = True
        if not matched:
            cue = raw.get("raw_caller_stt") or raw.get("normalized_caller_stt") or ""
            cue_n = normalize_text(str(cue))
            for b in turns.values():
                if cue_n and normalize_text(b.norm_transcript) == cue_n:
                    b.policy = raw
                    matched = True
                    break
            if not matched and cue_n:
                for b in turns.values():
                    if cue_n in normalize_text(b.norm_transcript) or normalize_text(b.norm_transcript) in cue_n:
                        b.policy = raw
                        break

    for p in glob_count(call / "audio", "005_whisper_request_*.wav"):
        uid = id_from_name(pat_005, p.name)
        if not uid:
            continue
        tid = u_to_t.get(uid)
        if not tid:
            continue
        b = turns.setdefault(tid, TurnBundle(turn_id=tid))
        b.whisper_wav = p
        if uid not in b.utterance_ids:
            b.utterance_ids.append(uid)

    for p in glob_count(call / "tts", "012_tts_raw_*.wav"):
        tid = id_from_name(pat_012, p.name)
        if tid:
            turns.setdefault(tid, TurnBundle(turn_id=tid)).tts_wav = p

    for p in glob_count(call / "playback", "013_telnyx_playback_*.wav"):
        tid = id_from_name(pat_013, p.name)
        if tid:
            turns.setdefault(tid, TurnBundle(turn_id=tid)).playback_wav = p

    # Sort utterance ids
    for b in turns.values():
        b.utterance_ids = sorted(set(b.utterance_ids))
    return sorted(turns.values(), key=lambda x: x.turn_id)


def summarize_timeline(rows: list[dict]) -> dict[str, Any]:
    by_event: dict[str, int] = defaultdict(int)
    first_ts: dict[str, int] = {}
    last_ts: dict[str, int] = {}
    wall_times: list[int] = []
    audio_times: list[int] = []

    for r in rows:
        ev = str(r.get("event") or "")
        by_event[ev] += 1
        w = r.get("wallClockMs")
        if isinstance(w, (int, float)):
            wi = int(w)
            wall_times.append(wi)
            if ev not in first_ts:
                first_ts[ev] = wi
            last_ts[ev] = wi
        a = r.get("audioClockMs")
        if isinstance(a, (int, float)):
            audio_times.append(int(a))

    duration_ms = (max(wall_times) - min(wall_times)) if len(wall_times) >= 2 else None

    def evs(*names: str) -> dict[str, int]:
        return {n: by_event.get(n, 0) for n in names}

    return {
        "event_counts": dict(sorted(by_event.items(), key=lambda x: (-x[1], x[0]))),
        "first_last_wall_ms_by_event": {k: {"first": first_ts.get(k), "last": last_ts.get(k)} for k in sorted(by_event)},
        "call_wall_clock_span_ms": duration_ms,
        "audio_clock_min": min(audio_times) if audio_times else None,
        "audio_clock_max": max(audio_times) if audio_times else None,
        "playback": evs("playback_start", "playback_ended", "playback_ended_webhook"),
        "listening": evs("listening_armed", "enter_listening", "audio_state_transition"),
        "transcripts": evs(
            "transcript_accepted",
            "transcript_rejected",
            "transcript_rejected_assistant_echo",
            "transcript_deferred",
        ),
        "frame_drops": evs(
            "frame_dropped_by_playback_gate",
            "post_playback_frame_dropped",
            "post_playback_frame_buffered",
            "post_playback_frame_released",
        ),
        "post_playback": evs(
            "post_playback_echo_window_started",
            "post_playback_frame_dropped",
            "post_playback_frame_buffered",
            "post_playback_frame_released",
        ),
        "assistant_echo": evs("transcript_rejected_assistant_echo", "assistant_echo_rejected"),
        "dead_air": evs("dead_air", "dead_air_detected"),
        "media_gap": evs("media_gap", "media_gap_compare", "media_payload"),
    }


def detect_issues(
    call: Path,
    timeline: list[dict],
    bundles: list[TurnBundle],
    inventory: dict[str, Any],
    summary: dict[str, Any],
) -> list[tuple[str, str, str]]:
    """Returns list of (severity PASS|WARNING|FAIL, category, detail)."""
    issues: list[tuple[str, str, str]] = []
    ec = summary["event_counts"]

    def add(sev: str, cat: str, msg: str) -> None:
        issues.append((sev, cat, msg))

    # 1 Telnyx media
    n_raw = inventory["counts"].get("001_raw_telnyx", 0)
    if n_raw > 0:
        add("PASS", "telnyx_media", f"Found {n_raw} raw Telnyx artifact(s).")
    else:
        add("WARNING", "telnyx_media", "No 001_raw_telnyx files; media may be disabled or call very short.")

    # 2 decode
    n2 = inventory["counts"].get("002_decoded_pcm", 0)
    if n2 > 0:
        add("PASS", "decode", f"{n2} decoded PCM WAV(s).")
    else:
        add("WARNING", "decode", "No 002_decoded_pcm WAVs.")

    # 3 STT -> whisper
    n5 = inventory["counts"].get("005_whisper_request", 0)
    if n5 > 0:
        add("PASS", "whisper_request", f"{n5} Whisper request WAV(s).")
    else:
        add("FAIL", "whisper_request", "No 005_whisper_request — STT may not be finalizing.")

    # 4 transcript vs audio
    n7 = inventory["counts"].get("007_normalized_transcript", 0)
    if n5 > 0 and n7 > 0:
        add("PASS", "transcript_artifacts", f"{n7} normalized transcript(s) with {n5} whisper WAV(s).")
    elif n5 > 0 and n7 == 0:
        add("WARNING", "transcript_artifacts", "Whisper WAVs exist but no 007 normalized transcripts.")

    # 5 policy
    n8 = inventory["counts"].get("008_transcript_policy", 0)
    if ec.get("transcript_rejected_assistant_echo", 0) > 0 or n8 > 0:
        add("PASS", "transcript_policy", f"Policy artifacts: {n8}, assistant_echo timeline: {ec.get('transcript_rejected_assistant_echo', 0)}.")
    else:
        add("PASS", "transcript_policy", "No echo rejections in timeline (may be clean call).")

    # 6 LLM text
    n9 = inventory["counts"].get("009_transcript_to_llm", 0)
    n10 = inventory["counts"].get("010_llm_response", 0)
    if n9 > 0 and n10 > 0:
        add("PASS", "llm", f"{n9} LLM input(s), {n10} response(s).")
    elif n9 == 0:
        add("FAIL", "llm", "No 009_transcript_to_llm — LLM path not captured or no turns.")
    else:
        add("WARNING", "llm", "Missing some LLM responses.")

    # 7 TTS
    n12 = inventory["counts"].get("012_tts_raw", 0)
    if n12 > 0:
        add("PASS", "tts", f"{n12} TTS raw file(s).")
    else:
        add("WARNING", "tts", "No 012_tts_raw files.")

    # 8 playback
    n13 = inventory["counts"].get("013_telnyx_playback", 0)
    n14 = inventory["counts"].get("014_playback_events", 0)
    if n13 > 0 or n14 > 0:
        add("PASS", "playback", f"013: {n13}, 014 events: {n14}.")
    else:
        add("WARNING", "playback", "No Telnyx playback WAV or playback events.")

    # 9 echo suppression
    if ec.get("transcript_rejected_assistant_echo", 0) > 0:
        add("PASS", "echo_suppression", "Assistant-echo rejections observed (filter active).")
    else:
        add("PASS", "echo_suppression", "No assistant_echo rejections in timeline (not proof of failure).")

    # 10 post-playback grace
    pp = ec.get("post_playback_echo_window_started", 0) + ec.get("post_playback_frame_buffered", 0)
    if pp > 0:
        add("PASS", "post_playback_grace", f"Post-playback events present ({pp}).")
    else:
        add("WARNING", "post_playback_grace", "No post_playback_* timeline rows; grace may be off or no playback overlap.")

    # STT during playback
    pb_starts = [r for r in timeline if r.get("event") == "playback_start"]
    pb_ends = [r for r in timeline if r.get("event") in ("playback_ended", "playback_ended_webhook")]
    acc = [r for r in timeline if r.get("event") == "transcript_accepted"]
    # crude: if accepted wall time between any start/end
    for a in acc[:50]:
        w = a.get("wallClockMs")
        if not isinstance(w, (int, float)):
            continue
        for s in pb_starts:
            ws = s.get("wallClockMs")
            if not isinstance(ws, (int, float)):
                continue
            for e in pb_ends:
                we = e.get("wallClockMs")
                if isinstance(we, (int, float)) and ws <= w <= we:
                    add("WARNING", "timing", f"transcript_accepted at wall {w} during playback window [{ws},{we}].")
                    break

    # Bundles: norm vs llm
    for b in bundles:
        if b.norm_transcript and b.llm_input and normalize_text(b.norm_transcript) != normalize_text(b.llm_input):
            add("WARNING", "transcript_drift", f"Turn {b.turn_id}: normalized transcript differs from LLM input.")
        pol = b.policy or {}
        if pol.get("reason") == "assistant_echo" or pol.get("decision") == "rejected":
            add("WARNING", "assistant_echo_policy", f"Turn {b.turn_id}: policy {pol.get('decision')} reason={pol.get('reason')}.")

    manifest = call / "manifest.jsonl"
    allow_pii = None
    if manifest.is_file():
        for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines()[:5]:
            try:
                o = json.loads(line)
                if o.get("event") == "forensics_session_started":
                    allow_pii = o.get("allowPii")
            except json.JSONDecodeError:
                pass
    if allow_pii is True:
        add("WARNING", "pii", "AUDIO_FORENSICS_ALLOW_PII was true — handle bundle as sensitive.")

    return issues


def build_inventory(call: Path) -> dict[str, Any]:
    audio = call / "audio"
    tr = call / "transcripts"
    llm = call / "llm"
    tts = call / "tts"
    pb = call / "playback"

    keys = {
        "001_raw_telnyx": list(audio.glob("001_raw_telnyx_*.bin")),
        "002_decoded_pcm": list(audio.glob("002_decoded_pcm_*.wav")),
        "003_emit_frame": list(audio.glob("003_emit_frame_*.wav")),
        "004_session_stt_input": list(audio.glob("004_session_stt_input_*.wav")),
        "005_whisper_request": list(audio.glob("005_whisper_request_*.wav")),
        "006_whisper_response": list(tr.glob("006_whisper_response_*.json")),
        "007_normalized_transcript": list(tr.glob("007_normalized_transcript_*.txt")),
        "008_transcript_policy": list(tr.glob("008_transcript_policy_*.json")),
        "009_transcript_to_llm": list(llm.glob("009_transcript_to_llm_*.txt")),
        "009_llm_request": list(llm.glob("009_llm_request_*.json")),
        "010_llm_response": list(llm.glob("010_llm_response_*.txt")),
        "012_tts_raw": list(tts.glob("012_tts_raw_*.wav")) + list(tts.glob("012_tts_raw_*.bin")),
        "013_telnyx_playback": list(pb.glob("013_telnyx_playback_*.wav")),
        "014_playback_events": list(pb.glob("014_playback_events_*.jsonl")),
    }
    counts = {k: len(v) for k, v in keys.items()}
    missing = [k for k, c in counts.items() if c == 0 and k in ("005_whisper_request", "007_normalized_transcript", "009_transcript_to_llm")]
    return {"counts": counts, "missing_notable": missing, "files": {k: [str(p.name) for p in v[:12]] for k, v in keys.items()}}


def recommended_steps(issues: list[tuple[str, str, str]], summary: dict[str, Any]) -> str:
    lines: list[str] = []
    text = " ".join(x[2] for x in issues)
    if "No 005_whisper_request" in text:
        lines.append("- No Whisper requests: check VAD/STT finalization, `STT_*` gates, and timeline `whisper_request_sent`.")
    if "normalized transcript differs" in text or "echo" in text.lower():
        lines.append("- Echo or transcript drift: tune `STT_ECHO_SUPPRESSION_MODE`, post-playback grace, and review `008_transcript_policy` + `transcript_rejected_assistant_echo`.")
    if "during playback window" in text:
        lines.append("- STT accepted during playback: review `playbackGateActive`, grace buffering, and Telnyx echo path.")
    if summary["event_counts"].get("post_playback_frame_dropped", 0) > 5:
        lines.append("- Many post_playback_frame_dropped: echo-tail energy gate may be aggressive; try permissive mode or lower RMS multipliers for trials.")
    if not lines:
        lines.append("- No critical flags from heuristics; spot-check `005` WAV quality and `009` vs `007` text for your scenario.")
    return "\n".join(lines)


def build_timing_alignment_md(timeline: list[dict]) -> str:
    lines = ["# Timing alignment\n\n", "Derived from `timeline.jsonl` (wall-clock ms).\n\n"]
    evs = [r for r in timeline if isinstance(r.get("wallClockMs"), (int, float))]
    evs.sort(key=lambda x: int(x["wallClockMs"]))  # type: ignore[index]

    def rows(kind: str, limit: int = 80) -> None:
        sub = [r for r in evs if (r.get("event") or "") == kind][:limit]
        if not sub:
            lines.append(f"## `{kind}`\n\n(none)\n\n")
            return
        lines.append(f"## `{kind}`\n\n")
        lines.append("| wall_ms | audio_ms | turn | utterance | notes |\n")
        lines.append("|---------|----------|------|-----------|-------|\n")
        for r in sub:
            w = r.get("wallClockMs")
            a = r.get("audioClockMs")
            tid = r.get("turnId") or r.get("turn_id") or ""
            uid = r.get("utteranceId") or r.get("utterance_id") or ""
            reason = r.get("reason") or r.get("state") or ""
            lines.append(f"| {w} | {a} | {tid} | {uid} | {reason} |\n")
        lines.append("\n")

    for k in (
        "playback_started",
        "playback_start_requested",
        "playback_ended",
        "playback_ended_webhook",
        "post_playback_echo_window_started",
        "post_playback_frame_buffered",
        "post_playback_frame_released",
        "post_playback_frame_dropped",
        "transcript_accepted",
        "transcript_rejected",
        "transcript_rejected_assistant_echo",
        "whisper_request_sent",
        "llm_request_sent",
        "llm_response_received",
    ):
        rows(k)

    # Heuristic flags
    lines.append("## Heuristic flags\n\n")
    pb_end = [int(r["wallClockMs"]) for r in evs if r.get("event") in ("playback_ended", "playback_ended_webhook")]
    acc = [r for r in evs if r.get("event") == "transcript_accepted"]
    for r in acc[:30]:
        w = int(r["wallClockMs"])  # type: ignore[arg-type]
        if pb_end and min(abs(w - x) for x in pb_end) < 400:
            lines.append(f"- transcript_accepted at {w} is within **400ms** of a playback end (possible echo window overlap).\n")
    lines.append("\n")
    return "".join(lines)


def build_echo_similarity_md(bundles: list[TurnBundle], call: Path) -> str:
    lines = ["# Echo similarity analysis\n\n"]
    prev_llm = ""
    prev_chunks: list[str] = []
    for idx, b in enumerate(bundles):
        lines.append(f"## Turn `{b.turn_id}`\n\n")
        cand = [prev_llm] if prev_llm.strip() else []
        cand.extend([c for c in prev_chunks if c.strip()])
        for label, text in (
            ("normalized", b.norm_transcript),
            ("llm_input", b.llm_input),
        ):
            if not text.strip():
                lines.append(f"- **{label}**: (empty)\n")
                continue
            ec = compare_echo(text, [x for x in cand if x.strip()])
            if ec:
                lines.append(
                    f"- **{label}** vs prior assistant: `{ec.verdict}` "
                    f"(fuzzy={ec.fuzzy:.2f}, jaccard={ec.jaccard:.2f}, substring={ec.substring})\n"
                )
            else:
                lines.append(f"- **{label}**: no prior assistant text to compare\n")
        # load playback jsonl for this turn
        pb_files = sorted((call / "playback").glob(f"014_playback_events_{b.turn_id}.jsonl"))
        if not pb_files:
            pb_files = sorted((call / "playback").glob("014_playback_events_*.jsonl"))
        if pb_files:
            lines.append("- playback events file(s): " + ", ".join(f"`{p.name}`" for p in pb_files[:3]) + "\n")
        lines.append("\n")
        prev_llm = b.llm_response or prev_llm
        prev_chunks = [b.llm_response] if b.llm_response else prev_chunks
    return "".join(lines)


def write_collage(call: Path, analysis: Path, bundles: list[TurnBundle]) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return
    sil = analysis / "_silence_500ms.wav"
    try:
        subprocess.run(
            [ffmpeg, "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.5", "-c:a", "pcm_s16le", str(sil)],
            capture_output=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return
    if not sil.is_file():
        return

    for b in bundles:
        parts: list[Path] = []
        if b.whisper_wav and b.whisper_wav.is_file():
            parts.append(b.whisper_wav)
        if not parts:
            continue
        parts.append(sil)
        if b.tts_wav and b.tts_wav.is_file():
            parts.append(b.tts_wav)
        parts.append(sil)
        if b.playback_wav and b.playback_wav.is_file():
            parts.append(b.playback_wav)
        uid = b.utterance_ids[0] if b.utterance_ids else b.turn_id
        out = analysis / f"compare_utt_{uid}.wav"
        lst = analysis / f"_concat_{uid}.txt"
        with lst.open("w", encoding="utf-8") as f:
            for p in parts:
                f.write(f"file '{p.resolve()}'\n")
        try:
            subprocess.run(
                [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)],
                capture_output=True,
                timeout=120,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        finally:
            lst.unlink(missing_ok=True)
    sil.unlink(missing_ok=True)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: veralux_forensics_analyze.py <call-folder>", file=sys.stderr)
        return 2
    call = Path(sys.argv[1]).resolve()
    if not call.is_dir():
        print(f"error: not a directory: {call}", file=sys.stderr)
        return 1
    if not (call / "timeline.jsonl").is_file():
        print(f"error: missing timeline.jsonl under {call}", file=sys.stderr)
        return 1

    analysis = call / "analysis"
    analysis.mkdir(parents=True, exist_ok=True)

    timeline = parse_timeline(call / "timeline.jsonl")
    inv = build_inventory(call)
    tsum = summarize_timeline(timeline)
    bundles = build_turn_bundles(call, timeline)
    issues = detect_issues(call, timeline, bundles, inv, tsum)
    rec = recommended_steps(issues, tsum)

    (analysis / "timeline_summary.json").write_text(json.dumps(tsum, indent=2), encoding="utf-8")

    # audio_inventory.md
    lines_ai = ["# Audio inventory\n", "\n"]
    for wav in sorted((call / "audio").glob("*.wav")) + sorted((call / "tts").glob("*.wav")) + sorted((call / "playback").glob("*.wav")):
        info = ffprobe_wav(wav)
        rms, peak = ffmpeg_astats_rms_peak(wav)
        lines_ai.append(f"## `{wav.name}`\n\n")
        lines_ai.append(f"- path: `{wav.relative_to(call)}`\n")
        lines_ai.append(f"- duration_sec: {info.get('duration_sec')}\n")
        lines_ai.append(f"- sample_rate: {info.get('sample_rate')}\n")
        lines_ai.append(f"- channels: {info.get('channels')}\n")
        if info.get("bits_per_sample"):
            lines_ai.append(f"- bits_per_sample: {info.get('bits_per_sample')}\n")
        if rms is not None:
            lines_ai.append(f"- astats RMS dB (approx): {rms}\n")
        if peak is not None:
            lines_ai.append(f"- astats peak dB (approx): {peak}\n")
        lines_ai.append("\n")
    (analysis / "audio_inventory.md").write_text("".join(lines_ai), encoding="utf-8")

    # transcript_comparison.md
    lines_tc: list[str] = ["# Transcript path comparison\n", "\n"]
    prev_llm_resp = ""
    prev_tts = ""
    for b in bundles:
        lines_tc.append(f"## Turn `{b.turn_id}`\n\n")
        lines_tc.append(f"- utterance ids: {', '.join(b.utterance_ids) or '(none)'}\n")
        lines_tc.append(f"- normalized (007): `{b.norm_transcript[:500]}{'…' if len(b.norm_transcript) > 500 else ''}`\n")
        lines_tc.append(f"- LLM input (009): `{b.llm_input[:500]}{'…' if len(b.llm_input) > 500 else ''}`\n")
        lines_tc.append(f"- LLM response (010): `{b.llm_response[:400]}{'…' if len(b.llm_response) > 400 else ''}`\n")
        if b.policy:
            lines_tc.append(f"- policy (008): `{json.dumps({k: b.policy.get(k) for k in ('decision', 'reason', 'utteranceId', 'turnId') if k in (b.policy or {})})}`\n")
        flags: list[str] = []
        if not b.norm_transcript.strip():
            flags.append("empty_normalized")
        if b.norm_transcript and b.llm_input and normalize_text(b.norm_transcript) != normalize_text(b.llm_input):
            flags.append("normalized_differs_from_llm_input")
        pol = b.policy or {}
        if pol.get("reason") == "assistant_echo":
            flags.append("assistant_echo_rejection")
        if pol.get("decision") == "rejected":
            flags.append("transcript_rejected")
        # echo vs previous assistant
        refs = [x for x in (prev_llm_resp, prev_tts) if x.strip()]
        ec = compare_echo(b.llm_input or b.norm_transcript, refs)
        if ec:
            lines_tc.append(
                f"- echo vs previous assistant: **{ec.verdict}** (fuzzy={ec.fuzzy:.2f}, jaccard={ec.jaccard:.2f}, substring={ec.substring})\n"
            )
            if ec.verdict == "likely_echo":
                flags.append("llm_input_resembles_previous_assistant")
        if len((b.norm_transcript or "").split()) <= 2 and b.norm_transcript.strip():
            flags.append("suspicious_short")
        lines_tc.append(f"- flags: {', '.join(flags) or 'none'}\n\n")
        prev_llm_resp = b.llm_response or prev_llm_resp
        # TTS text not always in wav name; use LLM response as proxy for "what TTS spoke"
        prev_tts = b.llm_response or prev_tts

    lines_tc.append("\n## All transcript policy files (008)\n\n")
    for p in glob_count(call / "transcripts", "008_transcript_policy_*.json"):
        raw = load_json(p)
        blob = json.dumps(raw, indent=2) if raw is not None else "{}"
        if len(blob) > 6000:
            blob = blob[:6000] + "\n… (truncated)"
        lines_tc.append(f"### `{p.name}`\n\n```json\n{blob}\n```\n\n")

    (analysis / "transcript_comparison.md").write_text("".join(lines_tc), encoding="utf-8")

    # issues_detected.md
    lines_iss = ["# Issues detected\n\n", "## Checklist\n\n"]
    checklist_titles = [
        ("telnyx_media", "Telnyx media reached runtime"),
        ("decode", "Audio decoded successfully"),
        ("whisper_request", "STT frames reached Whisper"),
        ("transcript_artifacts", "Whisper transcript matched audio artifact availability"),
        ("transcript_policy", "Transcript policy behaved correctly"),
        ("llm", "LLM received text"),
        ("tts", "TTS generated audio"),
        ("playback", "Playback events completed"),
        ("echo_suppression", "Echo suppression signals"),
        ("post_playback_grace", "Post-playback grace signals"),
    ]
    by_cat = {c: [] for _, c in checklist_titles}
    for sev, cat, msg in issues:
        by_cat.setdefault(cat, []).append((sev, msg))

    def grade(cat: str) -> str:
        xs = by_cat.get(cat, [])
        if any(s == "FAIL" for s, _ in xs):
            return "FAIL"
        if any(s == "WARNING" for s, _ in xs):
            return "WARNING"
        if any(s == "PASS" for s, _ in xs):
            return "PASS"
        return "WARNING"

    for key, title in checklist_titles:
        g = grade(key)
        lines_iss.append(f"### {g} — {title}\n\n")
        for sev, msg in by_cat.get(key, []):
            lines_iss.append(f"- **{sev}**: {msg}\n")
        if not by_cat.get(key):
            lines_iss.append("- (no specific rows)\n")
        lines_iss.append("\n")

    checklist_cats = {c for _, c in checklist_titles}
    lines_iss.append("## Raw signals\n\n")
    for sev, cat, msg in issues:
        if cat in checklist_cats:
            continue
        lines_iss.append(f"- **{sev}** [{cat}]: {msg}\n")

    (analysis / "issues_detected.md").write_text("".join(lines_iss), encoding="utf-8")

    (analysis / "recommended_next_steps.md").write_text(
        "# Recommended next steps\n\n" + rec + "\n",
        encoding="utf-8",
    )

    # summary.md
    summary_lines = [
        "# Forensic analysis summary\n\n",
        f"- call folder: `{call}`\n",
        f"- timeline events: {len(timeline)}\n",
        f"- wall span ms: {tsum.get('call_wall_clock_span_ms')}\n\n",
        "## Inventory counts\n\n",
    ]
    for k, v in sorted(inv["counts"].items()):
        summary_lines.append(f"- **{k}**: {v}\n")
    if inv["missing_notable"]:
        summary_lines.append("\n**Missing notable:** " + ", ".join(inv["missing_notable"]) + "\n")
    summary_lines.append("\n## Echo / LLM contamination heuristic\n\n")
    likely: list[str] = []
    for idx, b in enumerate(bundles):
        prev_r = bundles[idx - 1].llm_response if idx > 0 else ""
        if not prev_r.strip():
            continue
        ec = compare_echo(b.llm_input or b.norm_transcript, [prev_r])
        if ec and ec.verdict == "likely_echo":
            likely.append(b.turn_id)
    summary_lines.append(
        "- Turns where LLM input is **highly similar to previous assistant response** (possible echo contamination): "
        + (", ".join(likely) if likely else "none flagged")
        + "\n"
    )
    pol_echo = [b.turn_id for b in bundles if (b.policy or {}).get("reason") == "assistant_echo"]
    summary_lines.append(
        "- Turns with **008 assistant_echo** policy: " + (", ".join(pol_echo) if pol_echo else "none") + "\n"
    )
    summary_lines.append("\n## Top timeline events\n\n")
    for ev, c in list(tsum["event_counts"].items())[:25]:
        summary_lines.append(f"- `{ev}`: {c}\n")
    summary_lines.append("\n## Outputs\n\n")
    summary_lines.append(
        "See `timeline_summary.json`, `transcript_comparison.md`, `audio_inventory.md`, "
        "`timing_alignment.md`, `echo_similarity.md`, `issues_detected.md`, `recommended_next_steps.md`.\n"
    )
    allow = None
    mf = call / "manifest.jsonl"
    if mf.is_file():
        for line in mf.read_text(encoding="utf-8", errors="replace").splitlines()[:3]:
            try:
                o = json.loads(line)
                if o.get("event") == "forensics_session_started":
                    allow = o.get("allowPii")
            except json.JSONDecodeError:
                pass
    if allow is True:
        summary_lines.append("\n**Privacy:** Contains caller audio/transcripts. Handle as sensitive.\n")
    elif allow is False:
        summary_lines.append("\n**Privacy:** Session started with `AUDIO_FORENSICS_ALLOW_PII=false` (redaction enabled in artifacts).\n")

    (analysis / "summary.md").write_text("".join(summary_lines), encoding="utf-8")

    (analysis / "timing_alignment.md").write_text(build_timing_alignment_md(timeline), encoding="utf-8")
    (analysis / "echo_similarity.md").write_text(build_echo_similarity_md(bundles, call), encoding="utf-8")

    write_collage(call, analysis, bundles)
    return 0


if __name__ == "__main__":
    # Optional: unzip helper if first arg is zip — handled by shell wrapper
    raise SystemExit(main())
