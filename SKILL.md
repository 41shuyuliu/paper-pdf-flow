---
name: paper-pdf-flow
description: 将上传的论文 PDF 生成结构化“按图梳理”笔记。适用于按图总结论文、生成最小化 README、提取端到端实验流程、或将论文 PDF 转为可复用 markdown 记录。
---

# 论文 PDF 流程技能

使用本技能可将单篇论文 PDF 转换为“按图梳理”的结构化 Markdown 笔记。
默认生成“自动最终版”（`--mode final`），固定结构如下：
- `# <pdf_stem> 极简梳理`
- `## 文献信息`
- `## 这篇论文要解决什么问题`
- `## 按图看整篇流程（Fig.1~Fig.N）`
- `## 关键结论（一句话）`

## 执行流程

1. 校验输入 PDF 是否存在。
2. 执行 `scripts/pdf_to_flow_note.py` 生成最终版 Markdown（默认 `--mode final`）。
3. 可选人工快检：
- 核对标题、DOI、图序；
- 若提取不完整，补充时间线、分组与统计细节。
4. 仅输出到 `--out` 指定路径。

## 单文件输出约束（严格）

- `--out` 是唯一输出目标。
- 再次生成时覆盖 `--out`。
- 禁止创建任何副本或镜像文件，包括：
  - `README.md` 镜像文件，
  - `*_backup.md`,
  - `*_en.md`,
  - `*_copy.md`,
  - `同步副本` 或其他重复笔记。
- 如需翻译或重写，也必须复用同一 `--out` 路径覆盖写入。

## 命令示例

```powershell
python .\scripts\pdf_to_flow_note.py `
  --pdf "path\to\paper.pdf" `
  --out "path\to\README.md" `
  --lang zh `
  --mode final
```

若系统使用 `python3`，将 `python` 替换为 `python3`。
若存在多 Python 环境，建议显式指定解释器路径后再执行。

## 输出要求

生成结果至少包含：
- 文献元信息（标题/期刊线索/DOI，若可识别）
- 问题定义
- 按图流程（`Fig.1 -> Fig.N`）
- 关键结论（一句话）
- 单文件输出（禁止副本）

对于排版复杂或噪声较高 PDF，建议在生成后做一次快速事实核对。
仅在你明确需要轻量草稿时使用 `--mode draft`。
