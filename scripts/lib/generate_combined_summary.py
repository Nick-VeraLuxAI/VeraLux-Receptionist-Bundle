#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def read_json(path: Path):
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def read_head(path: Path, n: int) -> str:
    try:
        if not path.is_file():
            return "(missing)"
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[:n])
    except OSError:
        return "(missing)"


def scan_timeline(path: Path) -> dict:
    out = {
        "transcript_rejected_assistant_echo": 0,
        "transcript_accepted_during_playback": 0,
        "post_playback_frame_dropped": 0,
        "post_playback_frame_released": 0,
        "whisper_latency_max_ms": None,
    }
    if path.is_dir():
        path = path / "timeline.jsonl"
    if not path.is_file():
        return out
    last_req = {}
    max_lat = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        ev = row.get("event")
        if ev == "transcript_rejected_assistant_echo":
            out["transcript_rejected_assistant_echo"] += 1
        elif ev == "transcript_accepted" and row.get("playbackActive") is True:
            out["transcript_accepted_during_playback"] += 1
        elif ev == "post_playback_frame_dropped":
            out["post_playback_frame_dropped"] += 1
        elif ev == "post_playback_frame_released":
            out["post_playback_frame_released"] += 1
        elif ev == "whisper_request_sent":
            uid = row.get("utteranceId") or row.get("utterance_id")
            if uid:
                last_req[str(uid)] = row.get("wallClockMs")
        elif ev == "whisper_response_received":
            uid = row.get("utteranceId") or row.get("utterance_id")
            t0 = last_req.get(str(uid))
            t1 = row.get("wallClockMs")
            if isinstance(t0, int) and isinstance(t1, int):
                max_lat = max(max_lat, t1 - t0)
    if max_lat > 0:
        out["whisper_latency_max_ms"] = max_lat
    return out


def parse_issue_counts(path: Path) -> dict[str, int]:
    counts = {"PASS": 0, "WARNING": 0, "FAIL": 0}
    try:
        if not path.is_file():
            return counts
        txt = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return counts
    for k in counts:
        counts[k] = len(re.findall(rf"\*\*{k}\*\*", txt))
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate COMBINED_TEST_SUMMARY.md from call_meta.jsonl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--generated-utc", required=True)
    ap.add_argument("--calls", type=int, required=True)
    ap.add_argument("--label", required=True)
    args = ap.parse_args()

    out = Path(args.out)
    run_dir = Path(args.run_dir)
    meta = Path(args.meta)

    def sanitize_path(raw: object) -> Path:
        s = str(raw or "").strip()
        if not s:
            return Path("")
        if "\n" not in s:
            return Path(s)
        # Recover last absolute-looking path line from noisy captured stdout blobs.
        abs_lines = [ln.strip() for ln in s.splitlines() if ln.strip().startswith("/")]
        if abs_lines:
            return Path(abs_lines[-1])
        return Path(s.splitlines()[-1].strip())

    rows = []
    if meta.is_file():
        for ln in meta.read_text(encoding="utf-8", errors="replace").splitlines():
            ln = ln.strip()
            if ln:
                try:
                    rows.append(json.loads(ln))
                except Exception:
                    continue

    lines: list[str] = []
    lines.append("# VeraLux combined voice test summary")
    lines.append("")
    lines.append(f"- generated_utc: {args.generated_utc}")
    lines.append(f"- label: {args.label}")
    lines.append(f"- calls_requested: {args.calls}")
    lines.append(f"- run_dir: `{run_dir}`")
    lines.append("")
    lines.append("## Per-call")
    lines.append("")

    for row in rows:
        ci = row.get("call")
        cdir = sanitize_path(row.get("call_dir"))
        tdir = sanitize_path(row.get("timeline_dir"))
        adir = sanitize_path(row.get("analysis"))
        status = str(row.get("status") or "unknown")
        issues = adir / "issues_detected.md"
        counts = parse_issue_counts(issues)
        lines.append(f"### Call {ci}")
        lines.append(f"- status: {status}")
        lines.append(f"- call path: `{cdir}`")
        lines.append(f"- selected session path: `{tdir}`")
        lines.append(f"- analysis path: `{adir}`")
        lines.append(f"- issues_detected.md exists: {issues.is_file()}")
        lines.append(
            f"- issues counts: PASS={counts['PASS']} WARNING={counts['WARNING']} FAIL={counts['FAIL']}"
        )
        tl_stats = scan_timeline(tdir)
        lines.append(
            f"- timeline flags: transcript_rejected_assistant_echo={tl_stats['transcript_rejected_assistant_echo']}, "
            f"accepted_during_playback={tl_stats['transcript_accepted_during_playback']}, "
            f"post_playback_frame_dropped={tl_stats['post_playback_frame_dropped']}, "
            f"post_playback_frame_released={tl_stats['post_playback_frame_released']}, "
            f"max_whisper_latency_ms={tl_stats['whisper_latency_max_ms']}"
        )
        lines.append("")

    lines.append("## Key excerpts")
    lines.append("")
    for row in rows:
        ci = row.get("call")
        adir = sanitize_path(row.get("analysis"))
        lines.append(f"### Call {ci} — issues_detected.md (head)")
        lines.append("```")
        lines.append(read_head(adir / "issues_detected.md", 60))
        lines.append("```")
        lines.append("")
        lines.append(f"### Call {ci} — transcript_comparison.md (head)")
        lines.append("```")
        lines.append(read_head(adir / "transcript_comparison.md", 60))
        lines.append("```")
        lines.append("")
        lines.append(f"### Call {ci} — echo_similarity.md (head)")
        lines.append("```")
        lines.append(read_head(adir / "echo_similarity.md", 40))
        lines.append("```")
        lines.append("")
        lines.append(f"### Call {ci} — recommended_next_steps.md")
        lines.append("```")
        lines.append(read_head(adir / "recommended_next_steps.md", 40))
        lines.append("```")
        lines.append("")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[ok] wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
