#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.paper_interpretation import build_extraction_report
from core.paper_interpretation import build_prompt_payload
from core.paper_interpretation import parse_pdf


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate an auxiliary extraction report from a paper PDF."
    )
    parser.add_argument("--pdf", required=True, help="Input PDF path")
    parser.add_argument("--out", required=True, help="Output report path")
    parser.add_argument(
        "--lang",
        default="zh",
        choices=["zh", "en"],
        help="Report language",
    )
    parser.add_argument(
        "--format",
        default="markdown",
        choices=["markdown", "json"],
        help="Output format. markdown=helper report, json=raw extraction payload.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf)
    out_path = Path(args.out)

    if not pdf_path.is_file():
        print(f"[ERROR] PDF not found: {pdf_path}")
        return 2

    parsed = parse_pdf(pdf_path)
    payload = build_prompt_payload(pdf_path.name, parsed)
    if args.format == "json":
        content = json.dumps(payload, ensure_ascii=False, indent=2)
    else:
        content = build_extraction_report(pdf_path, lang=args.lang, parsed=parsed)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(content, encoding="utf-8")

    print(f"[OK] wrote: {out_path}")
    print(
        f"[INFO] figures_detected={len(payload['figures'])} doi={payload['doi_guess']} format={args.format}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
