#!/usr/bin/env python3
"""Page-aware PDF extractor using PyMuPDF (fitz) for the personal assistant RAG pipeline.

Extracts per-page text, Markdown-formatted tables, effective character counts, and image counts,
detects scanned pages (needs_visual_ocr), and strips repeated headers/footers across pages.
Outputs UTF-8 JSON to stdout.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


def table_to_markdown(rows: list[list[str | None]]) -> str:
    cleaned_rows: list[list[str]] = []
    for row in rows:
        if not row:
            continue
        cells = [(cell or "").replace("\n", " ").replace("|", "\\|").strip() for cell in row]
        if any(cells):
            cleaned_rows.append(cells)
    if not cleaned_rows:
        return ""
    col_count = max(len(r) for r in cleaned_rows)
    padded = [r + [""] * (col_count - len(r)) for r in cleaned_rows]
    header = "| " + " | ".join(padded[0]) + " |"
    sep = "| " + " | ".join(["---"] * col_count) + " |"
    body = ["| " + " | ".join(r) + " |" for r in padded[1:]]
    return "\n".join([header, sep, *body])


def strip_repeated_headers_footers(page_texts: list[str]) -> list[str]:
    if len(page_texts) < 3:
        return page_texts

    top_counter: Counter[str] = Counter()
    bottom_counter: Counter[str] = Counter()
    split_pages: list[list[str]] = []

    for text in page_texts:
        lines = [line.strip() for line in text.splitlines()]
        non_empty = [line for line in lines if line]
        split_pages.append(lines)
        for candidate in non_empty[:2]:
            if len(candidate) <= 120:
                top_counter[candidate] += 1
        for candidate in non_empty[-2:]:
            if len(candidate) <= 120:
                bottom_counter[candidate] += 1

    min_freq = max(2, int(len(page_texts) * 0.4 + 0.9999))
    repeated_top = {line for line, cnt in top_counter.items() if cnt >= min_freq}
    repeated_bottom = {line for line, cnt in bottom_counter.items() if cnt >= min_freq}

    cleaned: list[str] = []
    for lines in split_pages:
        result = list(lines)
        removed_top = 0
        while result and removed_top < 2:
            if not result[0]:
                result.pop(0)
                continue
            if result[0] in repeated_top:
                result.pop(0)
                removed_top += 1
            else:
                break
        removed_bottom = 0
        while result and removed_bottom < 2:
            if not result[-1]:
                result.pop()
                continue
            if result[-1] in repeated_bottom:
                result.pop()
                removed_bottom += 1
            else:
                break
        cleaned.append("\n".join(result).strip())
    return cleaned


def parse_pdf(pdf_path: Path) -> dict:
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise RuntimeError("PyMuPDF (pymupdf / fitz) is required to parse PDF files.") from exc

    doc = fitz.open(str(pdf_path))
    try:
        metadata = doc.metadata or {}
        title = (metadata.get("title") or "").strip() or pdf_path.stem
        raw_texts: list[str] = []
        raw_pages: list[dict] = []

        for idx, page in enumerate(doc, start=1):
            text = page.get_text("text") or ""
            raw_texts.append(text)
            image_count = len(page.get_images(full=True))

            tables_markdown: list[str] = []
            if hasattr(page, "find_tables"):
                try:
                    found = page.find_tables()
                    for table in getattr(found, "tables", []):
                        md = table_to_markdown(table.extract())
                        if md:
                            tables_markdown.append(md)
                except Exception:
                    pass

            raw_pages.append(
                {
                    "page": idx,
                    "image_count": image_count,
                    "tables_markdown": tables_markdown,
                }
            )

        cleaned_texts = strip_repeated_headers_footers(raw_texts)
        pages_out: list[dict] = []
        for meta, cleaned_text in zip(raw_pages, cleaned_texts):
            effective_chars = len("".join(cleaned_text.split()))
            needs_visual_ocr = effective_chars < 50 and meta["image_count"] > 0
            pages_out.append(
                {
                    "page": meta["page"],
                    "text": cleaned_text,
                    "tables_markdown": meta["tables_markdown"],
                    "effective_chars": effective_chars,
                    "image_count": meta["image_count"],
                    "needs_visual_ocr": needs_visual_ocr,
                }
            )

        return {
            "title": title,
            "page_count": len(pages_out),
            "pages": pages_out,
        }
    finally:
        doc.close()


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse_pdf.py <pdf_path>"}, ensure_ascii=False))
        return 2
    pdf_path = Path(sys.argv[1])
    if not pdf_path.is_file():
        print(json.dumps({"error": f"PDF file not found: {pdf_path}"}, ensure_ascii=False))
        return 1
    try:
        result = parse_pdf(pdf_path)
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
