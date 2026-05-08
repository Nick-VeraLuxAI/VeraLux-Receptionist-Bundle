#!/usr/bin/env python3
"""Merge env files: later files override earlier. Last KEY= wins. Preserves order of first-seen keys."""
from __future__ import annotations

import sys
from pathlib import Path


def load(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = raw.split("=", 1)
        out[k.strip()] = v.rstrip("\n")
    return out


def main() -> int:
    if len(sys.argv) < 3:
        print(f"usage: {sys.argv[0]} base.env override.env [override2.env ...]", file=sys.stderr)
        return 2
    merged: dict[str, str] = {}
    order: list[str] = []
    for p in sys.argv[1:]:
        chunk = load(Path(p))
        for k, v in chunk.items():
            if k not in merged:
                order.append(k)
            merged[k] = v
    for k in order:
        print(f"{k}={merged[k]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
