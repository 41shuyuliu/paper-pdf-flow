from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import Iterable
from typing import Pattern

from pypdf import PdfReader


class PaperInterpretationError(Exception):
    pass


class PdfExtractionError(PaperInterpretationError):
    pass


class ApiConfigError(PaperInterpretationError):
    pass


class ModelRequestError(PaperInterpretationError):
    pass


@dataclass(frozen=True)
class ParsedPaper:
    full_text: str
    pages: int
    first_page_raw: str
    full_text_raw: str


@dataclass(frozen=True)
class ApiConfig:
    base_url: str
    api_key: str
    model: str


@dataclass(frozen=True)
class PromptBundle:
    system_prompt: str
    user_prompt: str
    payload: dict[str, Any]


def safe_text(value: object) -> str:
    return str(value or "").strip()


def normalize_text(text: str) -> str:
    text = str(text or "").replace("\x00", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def parse_pdf(pdf_path: Path) -> ParsedPaper:
    try:
        reader = PdfReader(str(pdf_path))
    except Exception as exc:
        raise PdfExtractionError(f"无法读取 PDF：{exc}") from exc

    pages_raw: list[str] = []
    try:
        for page in reader.pages:
            pages_raw.append(page.extract_text() or "")
    except Exception as exc:
        raise PdfExtractionError(f"PDF 文本提取失败：{exc}") from exc

    first_page_raw = pages_raw[0] if pages_raw else ""
    full_text_raw = "\n".join(pages_raw)
    full_text = normalize_text(" ".join(pages_raw))
    if len(full_text) < 80:
        raise PdfExtractionError("PDF 文本提取过少，暂时无法生成论文解读")

    return ParsedPaper(
        full_text=full_text,
        pages=len(reader.pages),
        first_page_raw=first_page_raw,
        full_text_raw=full_text_raw,
    )


def take_excerpt_window(full_text: str, start: int, max_chars: int) -> str:
    text = safe_text(full_text)
    if not text:
        return ""
    safe_start = max(0, min(len(text), int(start or 0)))
    safe_length = max(0, int(max_chars or 0))
    return text[safe_start : safe_start + safe_length]


def extract_section_excerpt(
    full_text: str,
    patterns: Iterable[Pattern[str]],
    *,
    max_chars: int = 8000,
    lead_chars: int = 0,
) -> str:
    text = safe_text(full_text)
    if not text:
        return ""

    for pattern in patterns:
        match = pattern.search(text)
        if match:
            start = max(0, match.start() - max(0, int(lead_chars)))
            return text[start : start + max(0, int(max_chars))]
    return ""


def extract_middle_excerpt(full_text: str, max_chars: int = 6000) -> str:
    text = safe_text(full_text)
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    start = max(0, (len(text) - max_chars) // 2)
    return text[start : start + max_chars]


def extract_title(full_text: str, first_page_raw: str) -> str:
    lines_raw = [normalize_text(x) for x in first_page_raw.splitlines() if normalize_text(x)]

    stitched: list[str] = []
    skip_terms = ["http", "doi.org", "article", "arxiv:"]
    hard_stop_terms = [
        "@",
        "arxiv:",
        "conference on",
        "biomedical image analysis group",
        "university",
        "dept.",
        "department",
    ]

    for ln in lines_raw[:20]:
        low = ln.lower()
        if re.match(r"^(abstract|introduction|keywords?)\b", low):
            break
        if any(term in low for term in skip_terms):
            continue
        if any(term in low for term in hard_stop_terms):
            break
        if ln.count(",") >= 2 and re.search(r"\b[A-Z][a-z]+\b", ln):
            break
        if len(ln) < 3:
            continue
        stitched.append(ln)
        if len(" ".join(stitched)) > 180:
            break

    if stitched:
        candidate = normalize_text(" ".join(stitched))
        if 20 <= len(candidate) <= 180:
            return candidate

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
    for ln in lines_raw[:40]:
        score = 0
        if 20 <= len(ln) <= 170:
            score += 6
        if ":" in ln or "-" in ln:
            score += 1
        if ln.endswith("."):
            score -= 1
        if ln.count(",") >= 3:
            score -= 4
        low = ln.lower()
        if any(term in low for term in bad_terms):
            score -= 8
        if re.search(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\d\b", ln):
            score -= 6
        digit_ratio = sum(ch.isdigit() for ch in ln) / max(1, len(ln))
        if digit_ratio > 0.12:
            score -= 4
        if score > best_score:
            best_score = score
            best = ln

    if best and best_score >= 3:
        return best

    head = re.split(r"\b(Abstract|Results|Introduction)\b", full_text[:3000], maxsplit=1)[0]
    match = re.search(r"([A-Z][A-Za-z0-9 ,:;()\-]{20,180})", head)
    if match:
        candidate = match.group(1).strip()
        candidate = re.sub(r"\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\d.*$", "", candidate).strip()
        return candidate
    return "N/A"


def extract_doi(full_text: str, first_page_raw: str) -> str:
    matches = list(re.finditer(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b", full_text))
    if not matches:
        return "N/A"

    first_page_low = normalize_text(first_page_raw).lower()
    best = None
    best_score = -10**9
    text_length = len(full_text)
    for match in matches:
        doi = match.group(0)
        pos = match.start()
        left = max(0, pos - 140)
        right = min(text_length, match.end() + 140)
        ctx = full_text[left:right].lower()

        score = 0
        if pos < text_length * 0.15:
            score += 6
        elif pos < text_length * 0.35:
            score += 2
        if doi.lower() in first_page_low:
            score += 6
        if "doi" in ctx or "https://doi.org" in ctx:
            score += 2
        if any(token in ctx for token in ["references", "ref.", "bibliography", "dataset", "data availability"]):
            score -= 6
        if "tcia" in doi.lower():
            score -= 4
        if 12 <= len(doi) <= 55:
            score += 1

        if score > best_score:
            best_score = score
            best = doi

    if best is None or best_score < 3:
        return "N/A"
    return best


def extract_fig_captions(full_text_raw: str, max_figs: int = 12) -> list[tuple[str, str]]:
    lines = [normalize_text(x) for x in safe_text(full_text_raw).splitlines()]
    start_pat = re.compile(r"^(?:Fig(?:ure)?\.?|图)\s*(\d+)\s*(?:[|:：.\-)]\s*|\s+)(.*)$", re.IGNORECASE)
    next_pat = re.compile(r"^(?:Fig(?:ure)?\.?|图)\s*\d+\s*(?:[|:：.\-)]\s*|\s+)", re.IGNORECASE)
    stop_pat = re.compile(r"^(references|acknowledgements|appendix)\b", re.IGNORECASE)

    out: list[tuple[str, str]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if stop_pat.match(line):
            break
        match = start_pat.match(line)
        if not match:
            index += 1
            continue

        fig_no = match.group(1)
        cap_parts = [safe_text(match.group(2))]
        cursor = index + 1
        while cursor < len(lines):
            cur = lines[cursor]
            if not cur:
                break
            if next_pat.match(cur) or stop_pat.match(cur):
                break
            if re.match(r"^\d+(\.\d+)*\s+[A-Z]", cur):
                break
            cap_parts.append(cur)
            if len(" ".join(cap_parts)) > 420:
                break
            cursor += 1

        block = normalize_text(" ".join(cap_parts))
        if len(block) >= 20:
            out.append((fig_no, block[:360].rstrip()))
            if len(out) >= max_figs:
                break
        index = max(index + 1, cursor)

    dedup: dict[str, str] = {}
    for fig_no, caption in out:
        if fig_no not in dedup:
            dedup[fig_no] = caption
    return [(fig_no, dedup[fig_no]) for fig_no in sorted(dedup, key=lambda item: int(item))]


def extract_signals(full_text: str) -> dict[str, list[str]]:
    text = safe_text(full_text)

    def uniq(pattern: str, flags: int = 0) -> list[str]:
        seen: set[str] = set()
        values: list[str] = []
        for match in re.finditer(pattern, text, flags):
            value = safe_text(match.group(1) if match.groups() else match.group(0))
            key = value.lower()
            if not value or key in seen:
                continue
            seen.add(key)
            values.append(value)
            if len(values) >= 8:
                break
        return values

    return {
        "timepoints": uniq(r"\b(\d+\s*(?:h|hour|hours|day|days|min|minutes))\b", re.IGNORECASE),
        "doses": uniq(r"\b(\d+(?:\.\d+)?\s*(?:µM|uM|nM|mM|mg/mL|mg/ml|%))\b"),
        "plates": uniq(
            r"\b((?:6|12|24|48|96|384|1536)\s*-\s*well|(?:6|12|24|48|96|384|1536)\s*well)\b",
            re.IGNORECASE,
        ),
        "metrics": uniq(r"\b(IC50|AUC|ATP|viability|growth rate|mass|Dice|ASD|clDice|Betti)\b", re.IGNORECASE),
    }


def extract_journal_line(full_text: str) -> str:
    head = safe_text(full_text)[:6000]
    patterns = [
        r"(Nature Communications\s*\|\s*\(\d{4}\)\s*\d+:\d+)",
        r"(Nature Communications\s*\(\d{4}\))",
        r"(IEEE Transactions on Medical Imaging)",
        r"(Medical Image Analysis)",
        r"(Scientific Reports)",
    ]
    for pattern in patterns:
        match = re.search(pattern, head, re.IGNORECASE)
        if match:
            return safe_text(match.group(1).replace("|", " "))
    return "未自动识别（建议手动补充）"


def build_prompt_payload(pdf_name: str, parsed: ParsedPaper) -> dict[str, Any]:
    intro_excerpt = take_excerpt_window(parsed.full_text, 0, 9000)
    method_excerpt = extract_section_excerpt(
        parsed.full_text,
        [
            re.compile(r"\bmaterials?\s+and\s+methods?\b", re.IGNORECASE),
            re.compile(r"\bmethods?\b", re.IGNORECASE),
            re.compile(r"\bmethodology\b", re.IGNORECASE),
            re.compile(r"\bexperimental\s+setup\b", re.IGNORECASE),
            re.compile(r"\bimplementation\s+details?\b", re.IGNORECASE),
            re.compile(r"\bexperiments?\b", re.IGNORECASE),
        ],
        max_chars=11000,
        lead_chars=500,
    )
    results_excerpt = extract_section_excerpt(
        parsed.full_text,
        [
            re.compile(r"\bresults?\s+and\s+discussion\b", re.IGNORECASE),
            re.compile(r"\bresults?\b", re.IGNORECASE),
            re.compile(r"\bdiscussion\b", re.IGNORECASE),
            re.compile(r"\bconclusions?\b", re.IGNORECASE),
        ],
        max_chars=8000,
        lead_chars=500,
    )

    return {
        "file_name": pdf_name,
        "pages": parsed.pages,
        "title_guess": extract_title(parsed.full_text, parsed.first_page_raw),
        "journal_guess": extract_journal_line(parsed.full_text),
        "doi_guess": extract_doi(parsed.full_text, parsed.first_page_raw),
        "figures": [
            {"figure": f"Fig.{fig_no}", "caption": caption}
            for fig_no, caption in extract_fig_captions(parsed.full_text_raw)
        ],
        "signals": extract_signals(parsed.full_text),
        "body_excerpt_intro": intro_excerpt,
        "body_excerpt_method": method_excerpt,
        "body_excerpt_middle": extract_middle_excerpt(parsed.full_text, 5000),
        "body_excerpt_results": results_excerpt,
        "body_excerpt_tail": safe_text(parsed.full_text)[-2500:] if len(parsed.full_text) > 18000 else "",
    }


def build_model_prompts(pdf_name: str, parsed: ParsedPaper, lang: str = "zh") -> PromptBundle:
    payload = build_prompt_payload(pdf_name, parsed)
    payload_text = json.dumps(payload, ensure_ascii=False, indent=2)

    if lang == "en":
        system_prompt = "\n".join(
            [
                "You are a senior principal investigator explaining a paper to a non-specialist student at a whiteboard.",
                "Your task is not to write a generic summary but to turn the locally extracted paper text, excerpts, and figure captions into a high-quality Markdown interpretation.",
                "Output Markdown only. Do not output explanations, JSON, or code fences.",
                "You may add clarifying explanations, but do not invent facts, steps, numbers, or conclusions not supported by the source material.",
                "If a detail is unclear, explicitly say it is not clearly stated in the extracted material and suggest checking the original paper.",
                "Prioritize the body text excerpts, then use figure captions to strengthen the evidence chain.",
                "The Method section must be the most detailed section in the entire note.",
                "Use exactly this structure:",
                "# <pdf_stem> Paper Interpretation",
                "## Metadata",
                "## What Problem Does This Paper Solve",
                "## Walk Through the Paper by Original Structure",
                "## Method Breakdown",
                "## Experimental Design, Data, and Metrics",
                "## How Results Support the Conclusion",
                "## Limitations and Takeaways",
                "## One-Sentence Summary",
            ]
        )
        user_prompt = "\n".join(
            [
                "Generate the final English Markdown interpretation from the local PDF extraction below.",
                "Requirements:",
                "1. Output Markdown only.",
                "2. Explain the paper in a clear, mentor-like style for non-specialist readers.",
                "3. Follow the original paper logic instead of writing a long abstract.",
                "4. Make Method Breakdown the most detailed section.",
                "5. State clearly when a detail is not available from the extracted material.",
                "6. Explain which experiments, figures, or observations support the conclusion.",
                "",
                payload_text,
            ]
        )
        return PromptBundle(system_prompt=system_prompt, user_prompt=user_prompt, payload=payload)

    system_prompt = "\n".join(
        [
            "你是一个懂论文、也很会讲人话的老师，正在给第一次接触这篇论文的读者做导读。",
            "你的任务不是堆术语，也不是重写摘要，而是基于本地解析得到的论文文本、正文摘录和图注，把论文真正讲明白。",
            "只输出 Markdown，不要解释，不要 JSON，不要代码块。",
            "允许为了帮助理解补充解释，但不能编造原文未提供的事实、实验步骤、数据或结论。",
            "优先用通俗中文解释；专业名词或缩写第一次出现时，要顺手用一句短中文解释它是什么、有什么用。",
            "如果材料里没有明确给出某个细节，请明确写“原文摘录中未明确给出（建议回看原文）”。",
            "优先依据正文摘录解释论文逻辑，再结合图注补强结果证据链。",
            "Method 部分必须是全文最详细的部分，要先讲作者到底想怎么做，再逐步解释研究对象、输入输出、关键模块、执行顺序、训练或实验设置、评价方式，以及各步骤之间的关系。",
            "如果提到图或实验，先说明它想回答什么问题，再说明看到了什么结果，最后说明它支持了什么结论。",
            "必须严格使用以下固定结构和标题：",
            "# <pdf_stem> 论文解读",
            "## 文献信息",
            "## 这篇论文要解决什么问题",
            "## 按原文结构解读全文",
            "## Method 详细解读",
            "## 实验设计、数据与评价指标",
            "## 结果如何支撑结论",
            "## 局限性与启发",
            "## 一句话总结",
        ]
    )
    user_prompt = "\n".join(
        [
            "请根据下面的 PDF 本地解析结果，生成最终中文 Markdown 解读。",
            "输出要求：",
            "1. 只输出 Markdown 正文。",
            "2. 用中文作答，像一个懂行但很会讲人话的老师在带读论文：简洁、清楚、让非专业读者也能跟上。",
            "3. 少用术语，能用日常表达就不要堆学术黑话。",
            "4. 专业名词或缩写第一次出现时，要用括号或短句顺手解释，不要默认读者已经懂。",
            "5. 不是写详细摘要，而是按论文原始逻辑带用户读懂全文；每一部分先说“作者这部分想解决什么”。",
            "6. “Method 详细解读”必须是全篇最详细的部分，可使用编号或分点；先讲总体思路，再讲每一步怎么做、为什么这么做。",
            "7. “实验设计、数据与评价指标”要尽可能交代数据来源、分组、对照、时间点、剂量、评价指标和比较方式；像 ROI、HU、Dice 这类术语出现时要顺手解释。",
            "8. “结果如何支撑结论”要说明关键证据来自哪些实验、图或观察；提到图时，要说清这张图在比较什么、结果是什么、说明了什么。",
            "9. 如图注与正文摘录侧重点不同，优先忠实正文，再用图注补充。",
            "10. 如果信息不确定，请明确写“未自动识别（建议手动补充）”或“原文摘录中未明确给出（建议回看原文）”。",
            "11. 不要照抄 payload，要把信息组织成自然、可读、结构稳定、偏大白话的解读稿。",
            "",
            payload_text,
        ]
    )
    return PromptBundle(system_prompt=system_prompt, user_prompt=user_prompt, payload=payload)


def build_responses_endpoint(base_url: str) -> str:
    trimmed = safe_text(base_url).rstrip("/")
    if not trimmed:
        return ""
    if trimmed.endswith("/responses"):
        return trimmed
    if trimmed.endswith("/v1"):
        return f"{trimmed}/responses"
    return f"{trimmed}/v1/responses"


def strip_markdown_fence(raw: str) -> str:
    trimmed = safe_text(raw)
    fenced = re.match(r"^```(?:markdown|md)?\s*([\s\S]*?)\s*```$", trimmed, re.IGNORECASE)
    return safe_text(fenced.group(1)) if fenced else trimmed


def extract_response_text(resp_json: dict[str, Any]) -> str:
    output_text = resp_json.get("output_text")
    if isinstance(output_text, str) and safe_text(output_text):
        return safe_text(output_text)

    output = resp_json.get("output")
    if isinstance(output, list):
        chunks: list[str] = []
        for item in output:
            content = item.get("content") if isinstance(item, dict) else None
            if not isinstance(content, list):
                continue
            for content_item in content:
                if isinstance(content_item, dict) and isinstance(content_item.get("text"), str):
                    chunks.append(content_item["text"])
        return safe_text("\n".join(chunks))

    return ""


def validate_api_config(api_config: ApiConfig) -> None:
    if not safe_text(api_config.base_url):
        raise ApiConfigError("缺少 API 地址")
    if not safe_text(api_config.api_key):
        raise ApiConfigError("缺少 API 密钥")
    if not safe_text(api_config.model):
        raise ApiConfigError("缺少模型名字")


def request_markdown_from_model(
    api_config: ApiConfig,
    prompts: PromptBundle,
    *,
    max_output_tokens: int = 5200,
    timeout_sec: float = 120.0,
) -> str:
    validate_api_config(api_config)
    endpoint = build_responses_endpoint(api_config.base_url)
    if not endpoint:
        raise ApiConfigError("API 地址无效")

    request_body = json.dumps(
        {
            "model": api_config.model,
            "store": False,
            "max_output_tokens": max_output_tokens,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": prompts.system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": prompts.user_prompt}]},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")

    request = urllib.request.Request(
        endpoint,
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_config.api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise ModelRequestError(f"模型请求失败（HTTP {exc.code}）：{detail[:300]}") from exc
    except urllib.error.URLError as exc:
        raise ModelRequestError(f"模型请求失败：{exc.reason}") from exc
    except Exception as exc:
        raise ModelRequestError(f"模型请求失败：{exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ModelRequestError("模型返回不是合法 JSON") from exc

    text = strip_markdown_fence(extract_response_text(data))
    if not text:
        raise ModelRequestError("模型返回为空")
    return text


def generate_paper_interpretation(pdf_path: Path, api_config: ApiConfig, *, lang: str = "zh") -> str:
    parsed = parse_pdf(pdf_path)
    prompts = build_model_prompts(pdf_path.name, parsed, lang=lang)
    return request_markdown_from_model(api_config, prompts)


def build_extraction_report(pdf_path: Path, *, lang: str = "zh", parsed: ParsedPaper | None = None) -> str:
    parsed = parsed or parse_pdf(pdf_path)
    payload = build_prompt_payload(pdf_path.name, parsed)
    figures = payload["figures"]
    signals = payload["signals"]

    def list_or_na(values: list[str], missing: str) -> str:
        return "、".join(values) if values else missing

    if lang == "en":
        fig_lines = [f"- {item['figure']}: {item['caption']}" for item in figures] or ["- No stable figure captions were extracted."]
        return "\n".join(
            [
                f"# {pdf_path.stem} Extraction Report",
                "",
                "## Metadata",
                f"- Title: {payload['title_guess']}",
                f"- Journal hint: {payload['journal_guess']}",
                f"- DOI: {payload['doi_guess']}",
                f"- Pages: {payload['pages']}",
                f"- File: `{pdf_path.name}`",
                "",
                "## Figure Captions",
                *fig_lines,
                "",
                "## Experimental Signals",
                f"- Timepoints: {', '.join(signals['timepoints']) if signals['timepoints'] else 'not detected'}",
                f"- Doses: {', '.join(signals['doses']) if signals['doses'] else 'not detected'}",
                f"- Plate formats: {', '.join(signals['plates']) if signals['plates'] else 'not detected'}",
                f"- Metrics: {', '.join(signals['metrics']) if signals['metrics'] else 'not detected'}",
                "",
                "## Body Excerpts",
                "### Intro",
                payload["body_excerpt_intro"] or "Not extracted.",
                "",
                "### Method",
                payload["body_excerpt_method"] or "Not extracted.",
                "",
                "### Results",
                payload["body_excerpt_results"] or "Not extracted.",
                "",
                "## Note",
                "- This file is an auxiliary extraction report, not the final paper interpretation.",
                "",
            ]
        )

    fig_lines = [f"- {item['figure']}：{item['caption']}" for item in figures] or ["- 未自动提取到稳定图注。"]
    return "\n".join(
        [
            f"# {pdf_path.stem} 辅助提取报告",
            "",
            "## 文献信息",
            f"- 标题：{payload['title_guess']}",
            f"- 期刊线索：{payload['journal_guess']}",
            f"- DOI：{payload['doi_guess']}",
            f"- 页数：{payload['pages']}",
            f"- 文件：`{pdf_path.name}`",
            "",
            "## 图注索引",
            *fig_lines,
            "",
            "## 关键实验信号",
            f"- 时间点：{list_or_na(signals['timepoints'], '未自动检出')}",
            f"- 剂量/浓度：{list_or_na(signals['doses'], '未自动检出')}",
            f"- 孔板/平台：{list_or_na(signals['plates'], '未自动检出')}",
            f"- 指标关键词：{list_or_na(signals['metrics'], '未自动检出')}",
            "",
            "## 正文摘录",
            "### 开头",
            payload["body_excerpt_intro"] or "未提取到内容。",
            "",
            "### Method",
            payload["body_excerpt_method"] or "未提取到内容。",
            "",
            "### Results",
            payload["body_excerpt_results"] or "未提取到内容。",
            "",
            "## 使用说明",
            "- 本文件是辅助提取报告，用于给正式“论文解读”生成链路提供标题、图注、信号和正文摘录，不是最终产物。",
            "",
        ]
    )
