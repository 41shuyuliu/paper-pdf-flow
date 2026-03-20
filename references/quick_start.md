# Quick Start

## Goal
Generate a minimal, figure-driven markdown note from a paper PDF.

## Command

```powershell
& 'D:\Python\Environments\pytorch\Scripts\python.exe' .\paper_pdf_flow_skill\scripts\pdf_to_flow_note.py `
  --pdf ".\path\to\paper.pdf" `
  --out ".\path\to\notes\README.md" `
  --lang zh `
  --mode final
```

## Single-File Rule
- Always keep one final file only: the `--out` target.
- Re-run by overwriting the same `--out` path.
- Do not create any mirror/copy files.

## Recommended Manual Check List
- Verify title and DOI.
- Verify figure order and key figure captions.
- Add missing design details: groups, sample counts, statistics.
- Replace generic "Main Conclusion" with paper-specific statements.
