---
name: paper-pdf-flow
description: Build a structured paper workflow note from an uploaded PDF. Use when the user asks to summarize a paper by figures, generate a minimal README note, extract an end-to-end experimental flow, or convert a paper PDF into a reusable markdown record for project folders.
---

# Paper PDF Flow Skill

Use this skill to convert one paper PDF into a compact, figure-driven markdown note.
Default behavior is to generate an auto-polished final note (`--mode final`) in the fixed structure:
- `# <pdf_stem> 极简梳理`
- `## 文献信息`
- `## 这篇论文要解决什么问题`
- `## 按图看整篇流程（Fig.1~Fig.N）`
- `## 关键结论（一句话）`

## Workflow

1. Validate input PDF exists.
2. Run `scripts/pdf_to_flow_note.py` to generate a final markdown (`--mode final` by default).
3. Optionally run a quick manual check:
- verify title, DOI, and figure order;
- patch missing timeline/group/statistics details if extraction is incomplete.
4. Save exactly one final note file to the provided output path.

## Single-File Contract (Strict)

- Treat `--out` as the only output target.
- Overwrite `--out` when regenerating.
- Do not create any side outputs or copies, including:
  - `README.md` mirror files,
  - `*_backup.md`,
  - `*_en.md`,
  - `*_copy.md`,
  - `同步副本` or any duplicate note.
- If translation or comparison is needed, reuse the same `--out` path and overwrite in place.

## Commands

```powershell
& 'D:\Python\Environments\pytorch\Scripts\python.exe' .\paper_pdf_flow_skill\scripts\pdf_to_flow_note.py `
  --pdf "path\to\paper.pdf" `
  --out "path\to\README.md" `
  --lang zh `
  --mode final
```

## Output Contract

The generated markdown must contain at least:
- Paper metadata (title/journal-like line/DOI if found)
- One-sentence objective
- Figure-driven flow (`Fig.1 -> Fig.N`)
- Key design signals (timepoints, doses, groups, metrics) if detectable
- Main conclusion + caution boundary
- Single-file output only (no duplicate files)

For long or noisy PDFs, run a short fact-check pass after generation.
Use `--mode draft` only when you explicitly want a lightweight draft.
