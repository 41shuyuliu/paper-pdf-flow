#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Dict, List, Tuple

from pypdf import PdfReader


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Generate a minimal figure-driven markdown note from a paper PDF."
    )
    p.add_argument("--pdf", required=True, help="Input PDF path")
    p.add_argument("--out", required=True, help="Output markdown path")
    p.add_argument(
        "--lang",
        default="zh",
        choices=["zh", "en"],
        help="Output language",
    )
    p.add_argument(
        "--mode",
        default="final",
        choices=["final", "draft"],
        help="Output mode. final=auto polished output, draft=lightweight draft.",
    )
    return p.parse_args()


def normalize_text(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def read_pdf_text(pdf_path: Path) -> Tuple[str, int, str, str]:
    reader = PdfReader(str(pdf_path))
    pages = []
    for p in reader.pages:
        pages.append(p.extract_text() or "")
    first_page_raw = pages[0] if pages else ""
    full_text_raw = "\n".join(pages)
    return normalize_text(" ".join(pages)), len(reader.pages), first_page_raw, full_text_raw


def extract_title(full_text: str, first_page_raw: str) -> str:
    # First try: stitch top title lines before author/abstract blocks.
    lines_raw = [normalize_text(x) for x in first_page_raw.splitlines() if normalize_text(x)]
    stitched: List[str] = []
    skip_terms = ["http", "doi.org", "article", "arxiv:"]
    for ln in lines_raw[:20]:
        low = ln.lower()
        if re.match(r"^(abstract|introduction|keywords?)\b", low):
            break
        if any(t in low for t in skip_terms):
            continue
        if any(k in low for k in ["@","arxiv:", "conference on", "biomedical image analysis group", "university", "dept.", "department"]):
            break
        # Author-like line with many commas and names.
        if ln.count(",") >= 2 and re.search(r"\b[A-Z][a-z]+\b", ln):
            break
        if len(ln) < 3:
            continue
        stitched.append(ln)
        if len(" ".join(stitched)) > 180:
            break
    if stitched:
        cand = normalize_text(" ".join(stitched))
        if 20 <= len(cand) <= 180:
            return cand

    # Prefer first-page line candidates (more robust across journals).
    lines = lines_raw
    best = ""
    best_score = -10**9
    bad_terms = [
        "http",
        "doi",
        "arxiv",
        "received",
        "accepted",
        "copyright",
        "abstract",
        "keywords",
        "figure",
        "table",
        "email",
    ]

    for ln in lines[:40]:
        score = 0
        n = len(ln)
        if 20 <= n <= 170:
            score += 6
        if ":" in ln or "-" in ln:
            score += 1
        if ln.endswith("."):
            score -= 1
        if "," in ln and ln.count(",") >= 3:
            score -= 4
        low = ln.lower()
        if any(t in low for t in bad_terms):
            score -= 8
        # Author-line heuristic: many names with affiliation superscripts.
        if re.search(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\d\b", ln):
            score -= 6
        # Very digit-heavy lines are unlikely to be titles.
        digit_ratio = sum(ch.isdigit() for ch in ln) / max(1, len(ln))
        if digit_ratio > 0.12:
            score -= 4

        if score > best_score:
            best_score = score
            best = ln

    if best and best_score >= 3:
        return best

    # Fallback to body heuristic.
    head = full_text[:3000]
    head = re.split(r"\b(Abstract|Results|Introduction)\b", head, maxsplit=1)[0]
    m = re.search(r"([A-Z][A-Za-z0-9 ,:;()\-]{20,180})", head)
    if m:
        cand = m.group(1).strip()
        # Trim trailing author-like segment if present.
        cand = re.sub(r"\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\d.*$", "", cand).strip()
        return cand
    return "N/A"


def extract_doi(full_text: str, first_page_raw: str) -> str:
    matches = list(re.finditer(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b", full_text))
    if not matches:
        return "N/A"

    n = len(full_text)
    first_page_low = normalize_text(first_page_raw).lower()
    best = None
    best_score = -10**9
    for m in matches:
        doi = m.group(0)
        pos = m.start()
        left = max(0, pos - 140)
        right = min(n, m.end() + 140)
        ctx = full_text[left:right].lower()

        score = 0
        # Earlier mentions are usually better.
        if pos < n * 0.15:
            score += 6
        elif pos < n * 0.35:
            score += 2

        if doi.lower() in first_page_low:
            score += 6

        if "doi" in ctx or "https://doi.org" in ctx:
            score += 2

        # Penalize likely reference-section DOIs.
        if any(x in ctx for x in ["references", "ref.", "bibliography", "dataset", "data availability"]):
            score -= 6
        if "tcia" in doi.lower():
            score -= 4

        # Prefer cleaner DOI string length.
        if 12 <= len(doi) <= 55:
            score += 1

        if score > best_score:
            best_score = score
            best = doi

    if best is None:
        return "N/A"
    # If there is no first-page DOI evidence and score is weak, avoid noisy DOI from references/datasets.
    if best_score < 3:
        return "N/A"
    return best


def extract_fig_captions(full_text_raw: str, max_figs: int = 12) -> List[Tuple[str, str]]:
    # Line-based caption extraction to avoid inline "as shown in Figure 2" false positives.
    lines = [normalize_text(x) for x in full_text_raw.splitlines()]
    start_pat = re.compile(r"^(?:Fig\.?|Figure|FIGURE|图)\s*(\d+)\s*[|:.\-]\s*(.*)$", re.IGNORECASE)
    next_fig_pat = re.compile(r"^(?:Fig\.?|Figure|FIGURE|图)\s*\d+\s*[|:.\-]", re.IGNORECASE)
    stop_pat = re.compile(r"^(references|acknowledgements|appendix)\b", re.IGNORECASE)

    out: List[Tuple[str, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = start_pat.match(line)
        if not m:
            i += 1
            continue

        fig_no = m.group(1)
        cap_parts = [m.group(2).strip()]
        j = i + 1
        while j < len(lines):
            cur = lines[j]
            if not cur:
                break
            if next_fig_pat.match(cur) or stop_pat.match(cur):
                break
            # Section-style headings are likely not caption continuation.
            if re.match(r"^\d+(\.\d+)*\s+[A-Z]", cur):
                break
            cap_parts.append(cur)
            # Cap continuation length to keep precision.
            if len(" ".join(cap_parts)) > 420:
                break
            j += 1

        block = normalize_text(" ".join(cap_parts))
        if len(block) >= 20:
            out.append((fig_no, block[:360].rstrip()))
            if len(out) >= max_figs:
                break
        i = max(i + 1, j)
    # De-duplicate by fig number
    dedup: Dict[str, str] = {}
    for n, c in out:
        if n not in dedup:
            dedup[n] = c
    return [(k, dedup[k]) for k in sorted(dedup, key=lambda x: int(x))]


def extract_signals(full_text: str) -> Dict[str, List[str]]:
    signals: Dict[str, List[str]] = {}
    patterns = {
        "timepoints": (r"\b(\d+\s*(?:h|hour|hours|day|days|min|minutes))\b", re.IGNORECASE),
        # Keep concentration units strict to reduce confusion with geometric size labels.
        "doses": (r"\b(\d+(?:\.\d+)?\s*(?:µM|uM|nM|mM|mg/mL|mg/ml|%))\b", 0),
        # Restrict to common plate formats to avoid false positives from cell line names.
        "plates": (
            r"\b((?:6|12|24|48|96|384|1536)\s*-\s*well|(?:6|12|24|48|96|384|1536)\s*well)\b",
            re.IGNORECASE,
        ),
        "metrics": (
            r"\b(IC50|AUC|ATP|viability|growth rate|mass|Dice|ASD|clDice|Betti)\b",
            re.IGNORECASE,
        ),
    }
    for key, (pat, flags) in patterns.items():
        vals = re.findall(pat, full_text, flags=flags)
        uniq = []
        seen = set()
        for v in vals:
            vv = v.strip()
            low = vv.lower()
            if low not in seen:
                seen.add(low)
                uniq.append(vv)
            if len(uniq) >= 8:
                break
        signals[key] = uniq
    return signals


def detect_caption_tags(caption: str) -> List[str]:
    c = caption.lower()
    tags: List[str] = []

    def add(tag: str) -> None:
        if tag not in tags:
            tags.append(tag)

    if "schematic" in c or "pipeline" in c:
        add("流程/装置示意")
    if "bioprint" in c:
        add("生物打印构建")
    if "matrigel" in c:
        add("Matrigel 几何与厚度优化")
    if "viability" in c:
        add("细胞活性验证")
    if "transcript" in c or "rna" in c:
        add("转录组/分子一致性对比")
    if "tracking" in c or "interferometry" in c or "hslci" in c:
        add("单类器官追踪与动态成像")
    if "drug" in c or "treated" in c or "response" in c:
        add("药物响应分析")
    if "resistant" in c or "sensitive" in c or "heterogeneity" in c:
        add("耐药/敏感亚群与异质性")
    if "atp" in c:
        add("终点 ATP 对照")

    return tags


def zh_caption_summary(caption: str) -> str:
    tags = detect_caption_tags(caption)

    if not tags:
        return "这张图主要是在展示关键实验步骤或结果（建议再对照原图看一眼）。"
    return "这张图主要在讲：" + "、".join(tags) + "。"


def zh_flow_sentence(fig_no: str, caption: str) -> str:
    tags = detect_caption_tags(caption)
    if not tags:
        return f"Fig.{fig_no}：用于补充关键实验步骤或结果。"

    focus = "、".join(tags)
    if any(x in tags for x in ["流程/装置示意", "生物打印构建"]):
        return f"Fig.{fig_no}：先交代整体方案与实验搭建，重点是{focus}。"
    if any(x in tags for x in ["单类器官追踪与动态成像", "药物响应分析"]):
        return f"Fig.{fig_no}：进入核心验证阶段，展示{focus}。"
    if "耐药/敏感亚群与异质性" in tags:
        return f"Fig.{fig_no}：进一步分析样本内差异，突出{focus}。"
    return f"Fig.{fig_no}：该图主要用于证明{focus}。"


def zh_main_conclusion(figs: List[Tuple[str, str]], signals: Dict[str, List[str]]) -> List[str]:
    all_tags: List[str] = []
    for _, cap in figs:
        for t in detect_caption_tags(cap):
            if t not in all_tags:
                all_tags.append(t)

    parts = []
    if "生物打印构建" in all_tags and "单类器官追踪与动态成像" in all_tags:
        parts.append("论文建立了“生物打印 + 动态成像追踪”的一体化流程。")
    if "药物响应分析" in all_tags:
        parts.append("核心结果显示该流程可用于量化药物响应过程，而不仅是单一终点读数。")
    if "耐药/敏感亚群与异质性" in all_tags:
        parts.append("进一步结果强调了样本内耐药/敏感亚群识别能力。")
    if not parts:
        parts.append("论文通过多幅图构建了从方法到验证的完整证据链。")

    if signals.get("timepoints") or signals.get("doses"):
        parts.append("文中包含明确时间点与剂量设定，可支持后续复现实验设计。")

    return parts[:3]


def zh_extract_journal_line(full_text: str) -> str:
    # Minimal heuristic journal extraction; keep conservative.
    patterns = [
        r"(Nature Communications\s*\|\s*\(\d{4}\)\s*\d+:\d+)",
        r"(Nature Communications\s*\(\d{4}\))",
        r"(IEEE Transactions on Medical Imaging)",
        r"(Medical Image Analysis)",
        r"(Scientific Reports)",
    ]
    head = full_text[:6000]
    for p in patterns:
        m = re.search(p, head, re.IGNORECASE)
        if m:
            return m.group(1).replace("|", "").strip()
    return "未自动识别（建议手动补充）"


def zh_problem_lines(figs: List[Tuple[str, str]], signals: Dict[str, List[str]]) -> List[str]:
    tags: List[str] = []
    for _, cap in figs:
        for t in detect_caption_tags(cap):
            if t not in tags:
                tags.append(t)

    lines: List[str] = []
    if "药物响应分析" in tags:
        lines.append("- 传统流程常依赖单一终点读数，难以完整刻画药物响应的动态变化。")
    if "耐药/敏感亚群与异质性" in tags:
        lines.append("- 群体平均指标容易掩盖样本内异质性，难识别耐药/敏感亚群。")
    if "生物打印构建" in tags:
        lines.append("- 手工构建或非标准化流程重复性不足，影响高通量实验的一致性。")
    if not lines:
        lines.append("- 这篇论文关心的是：怎样把方法、验证和结论连成一条能复现的完整链条。")
    lines.append("- 作者想做的是一套能批量开展、能持续观察、还能算出结果的实验流程。")
    return lines[:4]


def zh_fallback_flow_lines(full_text: str) -> List[str]:
    text = full_text.lower()
    lines: List[str] = [
        "1. 先看方法总体（按章节回退）",
        "- 这次没有稳定识别到图注，所以改成按正文结构来梳理论文。",
    ]
    if any(k in text for k in ["method", "approach", "architecture", "network", "model"]):
        lines.append("- 开头先讲清楚方法框架，以及它由哪些关键部分组成。")
    else:
        lines.append("- 开头先说明要解决什么任务，以及整体打算怎么做。")

    lines.extend(
        [
            "",
            "2. 实验设置（章节回退）",
        ]
    )
    if any(k in text for k in ["dataset", "data set", "training", "implementation", "preprocess"]):
        lines.append("- 接着说明数据从哪里来、训练怎么设、实现细节是什么。")
    else:
        lines.append("- 接着说明实验用什么数据、怎么做对照、最后怎么评估。")

    lines.extend(
        [
            "",
            "3. 结果验证（章节回退）",
        ]
    )
    if any(k in text for k in ["result", "comparison", "ablation", "experiment"]):
        lines.append("- 后面通过对比实验和消融实验，检查这个方法到底有没有用。")
    else:
        lines.append("- 后面给出数字结果和直观看图结果，验证方法表现。")

    lines.extend(
        [
            "",
            "4. 结论总结（章节回退）",
        ]
    )
    if any(k in text for k in ["conclusion", "discussion"]):
        lines.append("- 最后总结这个方法哪里好、适合什么情况、还有哪些地方可以继续改。")
    else:
        lines.append("- 最后总结这篇论文最有价值的点，以及它目前的不足。")

    lines.append("")
    return lines


def zh_fig_subtitle(tags: List[str]) -> str:
    if "耐药/敏感亚群与异质性" in tags:
        return "识别样本内异质性"
    if "转录组/分子一致性对比" in tags:
        return "确认方法不改变细胞本质"
    if "药物响应分析" in tags:
        return "比较药物处理的动态反应"
    if "单类器官追踪与动态成像" in tags:
        return "建立单类器官追踪能力"
    if "生物打印构建" in tags:
        return "搭建可成像的构建流程"
    return "展示关键实验步骤"


def zh_fig_bullets(tags: List[str]) -> List[str]:
    bullets: List[str] = []
    if "流程/装置示意" in tags:
        bullets.append("- 先让你看懂整套实验是怎么搭起来的。")
    if "生物打印构建" in tags:
        bullets.append("- 通过更标准化的构建方式，让样本更稳定、更一致。")
    if "Matrigel 几何与厚度优化" in tags:
        bullets.append("- 通过调整形状和厚度，让后续成像更容易追踪。")
    if "细胞活性验证" in tags:
        bullets.append("- 看看前面的处理步骤有没有明显伤到细胞。")
    if "转录组/分子一致性对比" in tags:
        bullets.append("- 从分子层面检查改进前后是不是本质上还是同一类样本。")
    if "单类器官追踪与动态成像" in tags:
        bullets.append("- 连续追踪单个类器官，看看它随时间怎么变化。")
    if "药物响应分析" in tags:
        bullets.append("- 比较不同处理条件下，样本对药物的反应过程。")
    if "耐药/敏感亚群与异质性" in tags:
        bullets.append("- 看同一样本里是不是同时存在更耐药和更敏感的小群体。")
    if "终点 ATP 对照" in tags:
        bullets.append("- 拿传统终点法做对照，看看动态方法到底多带来了什么信息。")
    if not bullets:
        bullets.append("- 这张图是在补充关键流程或结果。")
    return bullets[:4]


def zh_key_conclusion_line(figs: List[Tuple[str, str]], signals: Dict[str, List[str]]) -> str:
    tags: List[str] = []
    for _, cap in figs:
        for t in detect_caption_tags(cap):
            if t not in tags:
                tags.append(t)

    if "生物打印构建" in tags and "单类器官追踪与动态成像" in tags and "药物响应分析" in tags:
        return "这篇论文把“更标准化的样本构建、单个类器官持续追踪、药物反应定量分析”连成了一整套流程，还能进一步看出样本内部的差异。"
    if "药物响应分析" in tags:
        return "这篇论文不只看最后一个时间点的结果，而是把药物反应的整个变化过程量化出来，所以信息更完整。"
    return "这篇论文用一组前后衔接的实验，把“方法有没有用、结论靠什么成立”这件事讲清楚了。"


def zh_final_strict_template(
    title: str,
    doi: str,
    pdf_name: str,
    full_text: str,
    figs: List[Tuple[str, str]],
    signals: Dict[str, List[str]],
) -> str:
    stem = Path(pdf_name).stem
    journal = zh_extract_journal_line(full_text)
    doi_line = f"https://doi.org/{doi}" if doi != "N/A" else "未自动识别（建议手动补充）"

    problem_lines = zh_problem_lines(figs, signals)

    fig_lines: List[str] = []
    if figs:
        max_fig = max(int(n) for n, _ in figs)
        fig_header = f"## 按图来看，这篇论文是怎么一步步做的（Fig.1~Fig.{max_fig}）"
        idx = 1
        for fig_no, cap in figs:
            tags = detect_caption_tags(cap)
            fig_lines.append(f"{idx}. Fig.{fig_no}（{zh_fig_subtitle(tags)}）")
            fig_lines.extend(zh_fig_bullets(tags))
            fig_lines.append("")
            idx += 1
    else:
        fig_header = "## 按图来看，这篇论文是怎么一步步做的（Fig.1~Fig.N）"
        fig_lines = zh_fallback_flow_lines(full_text)

    conclusion = zh_key_conclusion_line(figs, signals)

    return "\n".join(
        [
            f"# {stem} 大白话版论文导读",
            "",
            "## 文献信息",
            f"- 题目：{title}",
            f"- 期刊：{journal}",
            f"- DOI：{doi_line}",
            f"- 文件：`{pdf_name}`",
            "",
            "## 这篇论文要解决什么问题",
            *problem_lines,
            "",
            fig_header,
            *fig_lines,
            "## 最后一句人话总结",
            f"- {conclusion}",
            "",
        ]
    )


def zh_draft_template(
    title: str,
    doi: str,
    pages: int,
    figs: List[Tuple[str, str]],
    signals: Dict[str, List[str]],
) -> str:
    fig_lines = []
    if figs:
        for n, cap in figs:
            fig_lines.append(f"- Fig.{n}：{zh_caption_summary(cap)}")
    else:
        fig_lines.append("- 未自动提取到图注，请手动补充。")

    def list_or_na(key: str) -> str:
        vals = signals.get(key, [])
        return "、".join(vals) if vals else "未自动检出"

    return "\n".join(
        [
            "# 论文流程笔记（自动草稿）",
            "",
            "## 文献信息",
            f"- 标题：{title}",
            f"- DOI：{doi}",
            f"- PDF页数：{pages}",
            "",
            "## 一句话目标",
            "- 通过图驱动流程，快速理解论文在“问题 -> 方法 -> 验证 -> 结论”的完整链条。",
            "",
            "## 按图梳理流程（Fig.1 -> Fig.N）",
            *fig_lines,
            "",
            "## 关键实验信号（自动检出）",
            f"- 时间点：{list_or_na('timepoints')}",
            f"- 剂量/浓度：{list_or_na('doses')}",
            f"- 平台/孔板：{list_or_na('plates')}",
            f"- 指标关键词：{list_or_na('metrics')}",
            "",
            "## 主结论（待人工确认）",
            "- 结合图注和正文，补齐该论文的核心贡献、与基线相比提升点、主要局限。",
            "",
            "## 使用边界",
            "- 本文件为自动草稿，建议人工复核图注、分组、统计方法后再用于正式汇报或论文写作。",
            "",
        ]
    )


def zh_template(
    title: str,
    doi: str,
    pages: int,
    figs: List[Tuple[str, str]],
    signals: Dict[str, List[str]],
    mode: str,
    pdf_name: str,
    full_text: str,
) -> str:
    if mode == "final":
        return zh_final_strict_template(
            title=title,
            doi=doi,
            pdf_name=pdf_name,
            full_text=full_text,
            figs=figs,
            signals=signals,
        )
    return zh_draft_template(title, doi, pages, figs, signals)


def en_template(
    title: str,
    doi: str,
    pages: int,
    figs: List[Tuple[str, str]],
    signals: Dict[str, List[str]],
    mode: str,
) -> str:
    fig_lines = []
    if figs:
        for n, cap in figs:
            fig_lines.append(f"- Fig.{n}: {cap}")
    else:
        fig_lines.append("- No figure captions were extracted automatically.")

    def list_or_na(key: str) -> str:
        vals = signals.get(key, [])
        return ", ".join(vals) if vals else "not detected"

    title_line = "# Paper Flow Note (Auto Final)" if mode == "final" else "# Paper Flow Note (Auto Draft)"
    conclusion_title = (
        "## Main Conclusion"
        if mode == "final"
        else "## Main Conclusion (manual confirmation needed)"
    )
    conclusion_line = (
        "- The extracted figure chain indicates a method-to-validation pipeline with measurable experimental signals."
        if mode == "final"
        else "- Confirm key contributions, gains vs baseline, and limitations from full text."
    )
    boundary_line = (
        "- Auto final output; run a quick fact-check before publication use."
        if mode == "final"
        else "- This file is an auto draft; run a short manual correction pass before publication use."
    )

    return "\n".join(
        [
            title_line,
            "",
            "## Metadata",
            f"- Title: {title}",
            f"- DOI: {doi}",
            f"- PDF pages: {pages}",
            "",
            "## One-line Objective",
            "- Build a figure-driven understanding of the full paper pipeline.",
            "",
            "## Figure-driven Flow (Fig.1 -> Fig.N)",
            *fig_lines,
            "",
            "## Key Experimental Signals (auto-detected)",
            f"- Timepoints: {list_or_na('timepoints')}",
            f"- Doses/Concentrations: {list_or_na('doses')}",
            f"- Plate/platform terms: {list_or_na('plates')}",
            f"- Metric keywords: {list_or_na('metrics')}",
            "",
            conclusion_title,
            conclusion_line,
            "",
            "## Boundary",
            boundary_line,
            "",
        ]
    )


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf)
    out_path = Path(args.out)

    if not pdf_path.is_file():
        print(f"[ERROR] PDF not found: {pdf_path}")
        return 2

    full_text, pages, first_page_raw, full_text_raw = read_pdf_text(pdf_path)
    title = extract_title(full_text, first_page_raw)
    doi = extract_doi(full_text, first_page_raw)
    figs = extract_fig_captions(full_text_raw)
    signals = extract_signals(full_text)

    if args.lang == "zh":
        md = zh_template(
            title=title,
            doi=doi,
            pages=pages,
            figs=figs,
            signals=signals,
            mode=args.mode,
            pdf_name=pdf_path.name,
            full_text=full_text,
        )
    else:
        md = en_template(title, doi, pages, figs, signals, mode=args.mode)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(md, encoding="utf-8")

    print(f"[OK] wrote: {out_path}")
    print(f"[INFO] figures_detected={len(figs)} doi={doi}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
