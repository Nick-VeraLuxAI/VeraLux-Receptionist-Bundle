#!/usr/bin/env python3
"""
Select a VeraLux forensics session directory under a search root.

Prefer sessions whose folder name embeds an ISO-like timestamp; fall back to
timeline.jsonl st_mtime. Sort newest-first. Optionally reject sessions older
than --cutoff-epoch (unless --allow-old-session).

Prints exactly one absolute path to the selected session directory (stdout).
With --debug, prints candidates to stderr.

Does not use string sort on full paths for final selection.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


# Forensics folder names often: 2026-05-09T05-08-51-437Z
_RE_DIR_TS = re.compile(
    r"(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})T"
    r"(?P<h>\d{2})-(?P<mi>\d{2})-(?P<s>\d{2})-(?P<ms>\d{3})Z"
)


def parse_dir_timestamp(name: str) -> float | None:
    m = _RE_DIR_TS.search(name)
    if not m:
        return None
    g = m.groupdict()
    try:
        dt = datetime(
            int(g["y"]),
            int(g["mo"]),
            int(g["d"]),
            int(g["h"]),
            int(g["mi"]),
            int(g["s"]),
            int(g["ms"]) * 1000,
            tzinfo=timezone.utc,
        )
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


# Watcher output: 20260509T053134Z
_RE_WATCHER_DIR = re.compile(
    r"^(?P<y>\d{4})(?P<mo>\d{2})(?P<d>\d{2})T(?P<h>\d{2})(?P<mi>\d{2})(?P<s>\d{2})Z$"
)


def parse_watcher_dir_timestamp(name: str) -> float | None:
    m = _RE_WATCHER_DIR.match(name)
    if not m:
        return None
    g = m.groupdict()
    try:
        dt = datetime(
            int(g["y"]),
            int(g["mo"]),
            int(g["d"]),
            int(g["h"]),
            int(g["mi"]),
            int(g["s"]),
            0,
            tzinfo=timezone.utc,
        )
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


@dataclass
class SessionCandidate:
    session_dir: Path
    timeline: Path
    sort_key: float  # newer = larger for max sort
    source: str  # dir_name | mtime

    @property
    def timeline_mtime(self) -> float:
        try:
            return Path(self.timeline).stat().st_mtime
        except OSError:
            return 0.0


def collect_timelines(search_roots: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    out: list[Path] = []
    for root in search_roots:
        r = root.resolve()
        if not r.is_dir():
            continue
        for p in r.rglob("timeline.jsonl"):
            if p.is_file():
                rp = p.resolve()
                if rp not in seen:
                    seen.add(rp)
                    out.append(p)
    return out


def build_candidate(timeline_path: Path) -> SessionCandidate | None:
    session_dir = timeline_path.parent.resolve()
    name = session_dir.name
    ts = parse_dir_timestamp(name)
    src = "dir_name"
    if ts is None:
        try:
            ts = timeline_path.stat().st_mtime
            src = "mtime"
        except OSError:
            return None
    return SessionCandidate(session_dir=session_dir, timeline=timeline_path, sort_key=ts, source=src)


def select_session(
    search_roots: list[Path],
    cutoff_epoch: float | None,
    allow_old: bool,
    debug: bool,
) -> Path | None:
    timelines = collect_timelines(search_roots)
    candidates: list[SessionCandidate] = []
    for tl in timelines:
        c = build_candidate(tl)
        if c:
            candidates.append(c)

    if debug:
        sys.stderr.write("=== select_forensics_session candidates ===\n")
        for c in sorted(candidates, key=lambda x: (-x.sort_key, -x.timeline_mtime, str(x.session_dir))):
            age_note = ""
            if cutoff_epoch is not None and not allow_old:
                age_note = " REJECT_OLD" if c.sort_key < cutoff_epoch else " ok_cutoff"
            sys.stderr.write(
                f"  sort_key={c.sort_key:.3f} ({c.source}) "
                f"mtime_tl={c.timeline_mtime:.3f} "
                f"{c.session_dir}{age_note}\n"
            )

    if not candidates:
        return None

    def sort_tuple(c: SessionCandidate) -> tuple:
        return (-c.sort_key, -c.timeline_mtime, str(c.session_dir))

    candidates.sort(key=sort_tuple)

    pool = candidates
    if cutoff_epoch is not None and not allow_old:
        pool = [c for c in candidates if c.sort_key >= cutoff_epoch]
        if not pool:
            if debug:
                sys.stderr.write(
                    "=== no session with sort_key >= cutoff (use --allow-old-session to override) ===\n"
                )
            return None

    chosen = pool[0]
    if debug:
        sys.stderr.write(f"=== selected ===\n{chosen.session_dir}\n")
    return chosen.session_dir


def pick_watcher_bundle(call_dir: Path, debug: bool) -> Path | None:
    """Single child directory produced by live-call-test-watch.sh (timestamp name)."""
    call_dir = call_dir.resolve()
    if not call_dir.is_dir():
        return None
    children = [p for p in call_dir.iterdir() if p.is_dir()]
    if not children:
        return None
    scored: list[tuple[float, float, Path]] = []
    for p in children:
        name = p.name
        sk = parse_watcher_dir_timestamp(name)
        mt = 0.0
        try:
            mt = p.stat().st_mtime
        except OSError:
            pass
        if sk is None:
            sk = mt
        scored.append((sk, mt, p.resolve()))
    scored.sort(key=lambda t: (-t[0], -t[1], str(t[2])))
    if debug:
        sys.stderr.write("=== watcher bundle candidates (under call dir) ===\n")
        for sk, mt, p in scored:
            sys.stderr.write(f"  sort_key={sk:.3f} st_mtime={mt:.3f} {p}\n")
    return scored[0][2]


def main() -> int:
    ap = argparse.ArgumentParser(description="Select forensics session directory by timeline.jsonl / folder time.")
    ap.add_argument("--search-root", action="append", default=[], help="Directory tree to search (repeatable)")
    ap.add_argument("--cutoff-epoch", type=float, default=None, help="Reject sessions with sort_key < this (unix sec)")
    ap.add_argument("--allow-old-session", action="store_true", help="Allow sessions older than cutoff")
    ap.add_argument("--debug", action="store_true", help="Print candidates to stderr")
    ap.add_argument(
        "--pick-watcher-bundle",
        type=str,
        default="",
        metavar="CALL_DIR",
        help="Only resolve newest watcher subfolder under CALL_DIR (no timeline search)",
    )
    args = ap.parse_args()

    if args.pick_watcher_bundle:
        wb = pick_watcher_bundle(Path(args.pick_watcher_bundle), args.debug)
        if not wb:
            print("", end="")
            return 1
        print(str(wb), end="\n")
        return 0

    roots = [Path(x) for x in args.search_root]
    if not roots:
        print("error: need --search-root or --pick-watcher-bundle", file=sys.stderr)
        return 2

    allow_old = args.allow_old_session
    cutoff = args.cutoff_epoch
    sel = select_session(roots, cutoff, allow_old, args.debug)
    if sel is None:
        print("", end="")
        return 1
    print(str(sel), end="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
