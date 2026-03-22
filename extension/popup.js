import { GlobalWorkerOptions, getDocument } from "./vendor/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

const STORAGE_KEY = "paper_pdf_flow_extension_local_settings";

const refs = {
  pdfFile: document.getElementById("pdfFile"),
  outputName: document.getElementById("outputName"),
  langSelect: document.getElementById("langSelect"),
  modeSelect: document.getElementById("modeSelect"),
  startBtn: document.getElementById("startBtn"),
  statusLine: document.getElementById("statusLine"),
  progressBar: document.getElementById("progressBar"),
  metaLine: document.getElementById("metaLine"),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || "").replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
}

function safeText(value) {
  return String(value || "").trim();
}

function setStatus(text, kind = "") {
  refs.statusLine.textContent = safeText(text) || "空闲";
  refs.statusLine.classList.remove("error", "success");
  if (kind === "error") {
    refs.statusLine.classList.add("error");
  } else if (kind === "success") {
    refs.statusLine.classList.add("success");
  }
}

function setMeta(text) {
  refs.metaLine.textContent = safeText(text);
}

function setProgress(value) {
  const p = Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
  refs.progressBar.style.width = `${Math.round(p * 100)}%`;
}

function setRunning(running) {
  const disabled = Boolean(running);
  refs.startBtn.disabled = disabled;
  refs.pdfFile.disabled = disabled;
  refs.outputName.disabled = disabled;
  refs.langSelect.disabled = disabled;
  refs.modeSelect.disabled = disabled;
}

function ensurePdfFile(file) {
  if (!file) {
    throw new Error("请先选择一个 PDF 文件。");
  }
  const name = safeText(file.name).toLowerCase();
  const mime = safeText(file.type).toLowerCase();
  if (!(name.endsWith(".pdf") || mime === "application/pdf")) {
    throw new Error("所选文件不是 PDF。");
  }
}

function validateOutputName(value) {
  const name = safeText(value);
  if (!name) {
    return "";
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("输出文件名只能是纯文件名，不能包含路径。");
  }
  if (!name.toLowerCase().endsWith(".md")) {
    throw new Error("输出文件名必须以 .md 结尾。");
  }
  return name;
}

function defaultOutputName(pdfName) {
  const stem = safeText(pdfName).replace(/\.pdf$/i, "") || "流程笔记";
  return `${stem}.md`;
}

function triggerDownload(content, filename) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function detectCaptionTags(caption) {
  const c = safeText(caption).toLowerCase();
  const tags = [];

  const add = (tag) => {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  };

  if (c.includes("schematic") || c.includes("pipeline")) add("流程/装置示意");
  if (c.includes("bioprint")) add("生物打印构建");
  if (c.includes("matrigel")) add("Matrigel 几何与厚度优化");
  if (c.includes("viability")) add("细胞活性验证");
  if (c.includes("transcript") || c.includes("rna")) add("转录组/分子一致性对比");
  if (c.includes("tracking") || c.includes("interferometry") || c.includes("hslci")) add("单类器官追踪与动态成像");
  if (c.includes("drug") || c.includes("treated") || c.includes("response")) add("药物响应分析");
  if (c.includes("resistant") || c.includes("sensitive") || c.includes("heterogeneity")) add("耐药/敏感亚群与异质性");
  if (c.includes("atp")) add("终点 ATP 对照");
  return tags;
}

function zhFigSubtitle(tags) {
  if (tags.includes("耐药/敏感亚群与异质性")) return "识别样本内异质性";
  if (tags.includes("转录组/分子一致性对比")) return "确认方法不改变细胞本质";
  if (tags.includes("药物响应分析")) return "比较药物处理的动态反应";
  if (tags.includes("单类器官追踪与动态成像")) return "建立单类器官追踪能力";
  if (tags.includes("生物打印构建")) return "搭建可成像的构建流程";
  return "展示关键实验步骤";
}

function zhFigBullets(tags) {
  const bullets = [];
  if (tags.includes("流程/装置示意")) bullets.push("- 先交代整体实验流程与系统搭建。");
  if (tags.includes("生物打印构建")) bullets.push("- 通过标准化生物打印提升样本构建一致性。");
  if (tags.includes("Matrigel 几何与厚度优化")) bullets.push("- 通过几何/厚度优化提升成像可追踪性。");
  if (tags.includes("细胞活性验证")) bullets.push("- 验证构建步骤不会显著损伤细胞活性。");
  if (tags.includes("转录组/分子一致性对比")) bullets.push("- 从分子层面对比基线与改进流程的一致性。");
  if (tags.includes("单类器官追踪与动态成像")) bullets.push("- 对单个类器官进行连续追踪，得到时间序列变化。");
  if (tags.includes("药物响应分析")) bullets.push("- 对不同处理条件进行动态药物响应对比。");
  if (tags.includes("耐药/敏感亚群与异质性")) bullets.push("- 识别耐药/敏感亚群，评估样本内异质性。");
  if (tags.includes("终点 ATP 对照")) bullets.push("- 与终点法对照，验证动态方法的增益。");
  if (bullets.length === 0) bullets.push("- 该图用于补充关键流程或结果。");
  return bullets.slice(0, 4);
}

function zhExtractJournalLine(fullText) {
  const head = safeText(fullText).slice(0, 6000);
  const patterns = [
    /(Nature Communications\s*\|\s*\(\d{4}\)\s*\d+:\d+)/i,
    /(Nature Communications\s*\(\d{4}\))/i,
    /(IEEE Transactions on Medical Imaging)/i,
    /(Medical Image Analysis)/i,
    /(Scientific Reports)/i,
  ];
  for (const p of patterns) {
    const m = head.match(p);
    if (m && m[1]) {
      return safeText(m[1].replace("|", " "));
    }
  }
  return "未自动识别（建议手动补充）";
}

function zhProblemLines(figs) {
  const tags = [];
  for (const [, cap] of figs) {
    for (const t of detectCaptionTags(cap)) {
      if (!tags.includes(t)) tags.push(t);
    }
  }

  const lines = [];
  if (tags.includes("药物响应分析")) lines.push("- 传统流程常依赖单一终点读数，难以完整刻画药物响应的动态变化。");
  if (tags.includes("耐药/敏感亚群与异质性")) lines.push("- 群体平均指标容易掩盖样本内异质性，难识别耐药/敏感亚群。");
  if (tags.includes("生物打印构建")) lines.push("- 手工构建或非标准化流程重复性不足，影响高通量实验的一致性。");
  if (lines.length === 0) lines.push("- 论文关注如何把方法、验证与结论串成可复现的完整流程。");
  lines.push("- 目标：建立可规模化、可追踪、可定量的图驱动实验流程。");
  return lines.slice(0, 4);
}

function zhKeyConclusion(figs) {
  const tags = [];
  for (const [, cap] of figs) {
    for (const t of detectCaptionTags(cap)) {
      if (!tags.includes(t)) tags.push(t);
    }
  }
  if (tags.includes("生物打印构建") && tags.includes("单类器官追踪与动态成像") && tags.includes("药物响应分析")) {
    return "该研究将“标准化生物打印 + 单类器官动态追踪 + 药物响应定量”整合为一条高通量流程，并能进一步揭示样本内异质性。";
  }
  if (tags.includes("药物响应分析")) {
    return "该研究通过图驱动流程实现了药物响应的动态量化，相比单一终点读数信息更完整。";
  }
  return "该研究通过图驱动流程串联了方法、验证与结论，形成可复现的完整证据链。";
}

function zhFallbackFlowLines(fullText) {
  const text = safeText(fullText).toLowerCase();
  const lines = [
    "1. 方法总体（章节回退）",
    "- 未识别到稳定图注，改为按章节信号构建流程摘要。",
    "",
    "2. 实验设置（章节回退）",
    "",
    "3. 结果验证（章节回退）",
    "",
    "4. 结论总结（章节回退）",
    "",
  ];

  lines[2] = text.match(/method|approach|architecture|network|model/i)
    ? "- 论文首先给出模型/方法框架与关键模块设计。"
    : "- 论文首先定义任务目标与总体技术路线。";
  lines[4] = text.match(/dataset|data set|training|implementation|preprocess/i)
    ? "- 接着说明数据来源、训练配置与实现细节。"
    : "- 接着说明实验数据、对照设置与评估方案。";
  lines[6] = text.match(/result|comparison|ablation|experiment/i)
    ? "- 随后通过对比实验与（或）消融实验验证方法有效性。"
    : "- 随后给出定量与定性结果，验证方法表现。";
  lines[8] = text.match(/conclusion|discussion/i)
    ? "- 最后总结方法优势、适用边界与潜在改进方向。"
    : "- 最后总结主要贡献与局限。";
  return lines;
}

function zhFinalTemplate({ title, doi, pdfName, fullText, figs }) {
  const stem = safeText(pdfName).replace(/\.pdf$/i, "") || "论文";
  const journal = zhExtractJournalLine(fullText);
  const doiLine = doi === "N/A" ? "未自动识别（建议手动补充）" : `https://doi.org/${doi}`;
  const problemLines = zhProblemLines(figs);

  const figLines = [];
  let figHeader = "## 按图看整篇流程（Fig.1~Fig.N）";
  if (figs.length > 0) {
    const maxFig = Math.max(...figs.map(([n]) => Number(n)));
    figHeader = `## 按图看整篇流程（Fig.1~Fig.${maxFig}）`;
    figs.forEach(([no, cap], idx) => {
      const tags = detectCaptionTags(cap);
      figLines.push(`${idx + 1}. Fig.${no}（${zhFigSubtitle(tags)}）`);
      figLines.push(...zhFigBullets(tags));
      figLines.push("");
    });
  } else {
    figLines.push(...zhFallbackFlowLines(fullText));
  }

  return [
    `# ${stem} 极简梳理`,
    "",
    "## 文献信息",
    `- 题目：${title}`,
    `- 期刊：${journal}`,
    `- DOI：${doiLine}`,
    `- 文件：\`${pdfName}\``,
    "",
    "## 这篇论文要解决什么问题",
    ...problemLines,
    "",
    figHeader,
    ...figLines,
    "## 关键结论（一句话）",
    `- ${zhKeyConclusion(figs)}`,
    "",
  ].join("\n");
}

function zhDraftTemplate({ title, doi, pages, figs, signals }) {
  const figLines = figs.length
    ? figs.map(([n, cap]) => `- Fig.${n}：${detectCaptionTags(cap).join("、") || "关键实验步骤/结果"}`)
    : ["- 未自动提取到图注，请手动补充。"];
  const listOrNA = (arr) => (arr.length ? arr.join("、") : "未自动检出");
  return [
    "# 论文流程笔记（自动草稿）",
    "",
    "## 文献信息",
    `- 标题：${title}`,
    `- DOI：${doi}`,
    `- PDF页数：${pages}`,
    "",
    "## 一句话目标",
    "- 通过图驱动流程，快速理解论文在“问题 -> 方法 -> 验证 -> 结论”的完整链条。",
    "",
    "## 按图梳理流程（Fig.1 -> Fig.N）",
    ...figLines,
    "",
    "## 关键实验信号（自动检出）",
    `- 时间点：${listOrNA(signals.timepoints)}`,
    `- 剂量/浓度：${listOrNA(signals.doses)}`,
    `- 平台/孔板：${listOrNA(signals.plates)}`,
    `- 指标关键词：${listOrNA(signals.metrics)}`,
    "",
    "## 主结论（待人工确认）",
    "- 结合图注和正文，补齐该论文的核心贡献、与基线相比提升点、主要局限。",
    "",
  ].join("\n");
}

function enTemplate({ title, doi, pages, figs, signals, mode }) {
  const figLines = figs.length ? figs.map(([n, cap]) => `- Fig.${n}: ${cap}`) : ["- No figure captions were extracted automatically."];
  const listOrNA = (arr) => (arr.length ? arr.join(", ") : "not detected");
  return [
    mode === "final" ? "# Paper Flow Note (Auto Final)" : "# Paper Flow Note (Auto Draft)",
    "",
    "## Metadata",
    `- Title: ${title}`,
    `- DOI: ${doi}`,
    `- PDF pages: ${pages}`,
    "",
    "## Figure-driven Flow (Fig.1 -> Fig.N)",
    ...figLines,
    "",
    "## Key Experimental Signals (auto-detected)",
    `- Timepoints: ${listOrNA(signals.timepoints)}`,
    `- Doses/Concentrations: ${listOrNA(signals.doses)}`,
    `- Plate/platform terms: ${listOrNA(signals.plates)}`,
    `- Metric keywords: ${listOrNA(signals.metrics)}`,
    "",
  ].join("\n");
}

function extractTitle(fullText, firstPageRaw) {
  const linesRaw = safeText(firstPageRaw)
    .split(/\n+/)
    .map((x) => normalizeText(x))
    .filter(Boolean);

  const stitched = [];
  const skipTerms = ["http", "doi.org", "article", "arxiv:"];
  for (const ln of linesRaw.slice(0, 20)) {
    const low = ln.toLowerCase();
    if (/^(abstract|introduction|keywords?)\b/.test(low)) break;
    if (skipTerms.some((t) => low.includes(t))) continue;
    if (["@", "arxiv:", "conference on", "university", "dept.", "department"].some((k) => low.includes(k))) break;
    if ((ln.match(/,/g) || []).length >= 2 && /\b[A-Z][a-z]+\b/.test(ln)) break;
    if (ln.length < 3) continue;
    stitched.push(ln);
    if (stitched.join(" ").length > 180) break;
  }
  if (stitched.length) {
    const cand = normalizeText(stitched.join(" "));
    if (cand.length >= 20 && cand.length <= 180) return cand;
  }

  let best = "";
  let bestScore = -1e9;
  const badTerms = ["http", "doi", "arxiv", "received", "accepted", "copyright", "abstract", "keywords", "figure", "table", "email"];
  for (const ln of linesRaw.slice(0, 40)) {
    let score = 0;
    if (ln.length >= 20 && ln.length <= 170) score += 6;
    if (ln.includes(":") || ln.includes("-")) score += 1;
    if (ln.endsWith(".")) score -= 1;
    if ((ln.match(/,/g) || []).length >= 3) score -= 4;
    const low = ln.toLowerCase();
    if (badTerms.some((t) => low.includes(t))) score -= 8;
    if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\d\b/.test(ln)) score -= 6;
    const digitRatio = (ln.match(/\d/g) || []).length / Math.max(1, ln.length);
    if (digitRatio > 0.12) score -= 4;
    if (score > bestScore) {
      bestScore = score;
      best = ln;
    }
  }
  if (best && bestScore >= 3) return best;

  const head = safeText(fullText).slice(0, 3000).split(/\b(Abstract|Results|Introduction)\b/i)[0];
  const m = head.match(/([A-Z][A-Za-z0-9 ,:;()\-]{20,180})/);
  if (m && m[1]) {
    return safeText(m[1].replace(/\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\d.*$/, ""));
  }
  return "N/A";
}

function extractDoi(fullText, firstPageRaw) {
  const text = safeText(fullText);
  const matches = [...text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/g)];
  if (!matches.length) return "N/A";

  const firstPage = normalizeText(firstPageRaw).toLowerCase();
  let best = null;
  let bestScore = -1e9;
  for (const m of matches) {
    const doi = m[0];
    const pos = m.index || 0;
    const left = Math.max(0, pos - 140);
    const right = Math.min(text.length, pos + doi.length + 140);
    const ctx = text.slice(left, right).toLowerCase();

    let score = 0;
    if (pos < text.length * 0.15) score += 6;
    else if (pos < text.length * 0.35) score += 2;
    if (firstPage.includes(doi.toLowerCase())) score += 6;
    if (ctx.includes("doi") || ctx.includes("https://doi.org")) score += 2;
    if (["references", "ref.", "bibliography", "dataset", "data availability"].some((x) => ctx.includes(x))) score -= 6;
    if (doi.toLowerCase().includes("tcia")) score -= 4;
    if (doi.length >= 12 && doi.length <= 55) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = doi;
    }
  }
  if (!best || bestScore < 3) return "N/A";
  return best;
}

function extractFigCaptions(fullTextRaw, maxFigs = 12) {
  const lines = safeText(fullTextRaw)
    .split(/\n+/)
    .map((x) => normalizeText(x));

  const startPat = /^(?:Fig(?:ure)?\.?|图)\s*(\d+)\s*(?:[|:：.\-)]\s*|\s+)(.*)$/i;
  const nextPat = /^(?:Fig(?:ure)?\.?|图)\s*\d+\s*(?:[|:：.\-)]\s*|\s+)/i;
  const stopPat = /^(references|acknowledgements|appendix)\b/i;

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (stopPat.test(line)) break;
    const m = line.match(startPat);
    if (!m) continue;

    const figNo = m[1];
    const capParts = [safeText(m[2])];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const cur = lines[j];
      if (!cur) break;
      if (nextPat.test(cur) || stopPat.test(cur)) break;
      if (/^\d+(\.\d+)*\s+[A-Z]/.test(cur)) break;
      capParts.push(cur);
      if (capParts.join(" ").length > 420) break;
    }
    const block = normalizeText(capParts.join(" "));
    if (block.length >= 20) {
      out.push([figNo, block.slice(0, 360)]);
      if (out.length >= maxFigs) break;
    }
    i = Math.max(i + 1, j - 1);
  }

  const dedup = new Map();
  for (const [n, c] of out) {
    if (!dedup.has(n)) dedup.set(n, c);
  }
  return [...dedup.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

function extractSignals(fullText) {
  const text = safeText(fullText);
  const uniq = (regex) => {
    const seen = new Set();
    const vals = [];
    for (const m of text.matchAll(regex)) {
      const v = safeText(m[1] || m[0]);
      const key = v.toLowerCase();
      if (!v || seen.has(key)) continue;
      seen.add(key);
      vals.push(v);
      if (vals.length >= 8) break;
    }
    return vals;
  };
  return {
    timepoints: uniq(/\b(\d+\s*(?:h|hour|hours|day|days|min|minutes))\b/gi),
    doses: uniq(/\b(\d+(?:\.\d+)?\s*(?:µM|uM|nM|mM|mg\/mL|mg\/ml|%))\b/g),
    plates: uniq(/\b((?:6|12|24|48|96|384|1536)\s*-\s*well|(?:6|12|24|48|96|384|1536)\s*well)\b/gi),
    metrics: uniq(/\b(IC50|AUC|ATP|viability|growth rate|mass|Dice|ASD|clDice|Betti)\b/gi),
  };
}

async function extractPageText(page) {
  const content = await page.getTextContent();
  const items = Array.isArray(content.items) ? content.items : [];
  const lines = [];
  let current = [];
  let prevY = null;

  for (const item of items) {
    const str = safeText(item && item.str ? item.str : "");
    if (!str) continue;
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : 0;
    if (prevY !== null && Math.abs(y - prevY) > 2.2) {
      if (current.length) lines.push(current.join(" "));
      current = [str];
    } else {
      current.push(str);
    }
    prevY = y;
  }
  if (current.length) lines.push(current.join(" "));
  return lines.join("\n");
}

async function readPdfText(file) {
  const buf = await file.arrayBuffer();
  const loadingTask = getDocument({ data: new Uint8Array(buf) });
  const pdf = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const raw = await extractPageText(page);
    pages.push(raw);
  }
  await pdf.destroy();

  const firstPageRaw = pages[0] || "";
  const fullTextRaw = pages.join("\n");
  const fullText = normalizeText(pages.join(" "));
  return { fullText, pages: pdf.numPages, firstPageRaw, fullTextRaw };
}

function buildMarkdown({ pdfName, lang, mode, fullText, pages, firstPageRaw, fullTextRaw }) {
  const title = extractTitle(fullText, firstPageRaw);
  const doi = extractDoi(fullText, firstPageRaw);
  const figs = extractFigCaptions(fullTextRaw);
  const signals = extractSignals(fullText);

  if (lang === "zh") {
    if (mode === "final") {
      return zhFinalTemplate({ title, doi, pdfName, fullText, figs });
    }
    return zhDraftTemplate({ title, doi, pages, figs, signals });
  }
  return enTemplate({ title, doi, pages, figs, signals, mode });
}

async function loadSettings() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const saved = data[STORAGE_KEY] || {};
  refs.langSelect.value = safeText(saved.lang) || "zh";
  refs.modeSelect.value = safeText(saved.mode) || "final";
}

async function saveSettings(lang, mode) {
  await chrome.storage.local.set({ [STORAGE_KEY]: { lang, mode } });
}

async function handleStart() {
  try {
    setRunning(true);
    setProgress(0);
    setMeta("");
    setStatus("正在校验输入...");

    const file = refs.pdfFile.files && refs.pdfFile.files[0] ? refs.pdfFile.files[0] : null;
    ensurePdfFile(file);
    const lang = safeText(refs.langSelect.value) || "zh";
    const mode = safeText(refs.modeSelect.value) || "final";
    const outputName = validateOutputName(refs.outputName.value) || defaultOutputName(file.name);

    await saveSettings(lang, mode);
    setProgress(0.1);
    setStatus("正在读取 PDF...");
    setMeta(`文件=${file.name}`);
    await sleep(30);

    const parsed = await readPdfText(file);
    setProgress(0.6);
    setStatus("正在生成 Markdown...");
    setMeta(`页数=${parsed.pages} | 语言=${lang} | 模式=${mode}`);
    await sleep(30);

    const md = buildMarkdown({
      pdfName: file.name,
      lang,
      mode,
      fullText: parsed.fullText,
      pages: parsed.pages,
      firstPageRaw: parsed.firstPageRaw,
      fullTextRaw: parsed.fullTextRaw,
    });

    setProgress(0.9);
    setStatus("正在准备下载...");
    await sleep(30);
    triggerDownload(md, outputName);
    setProgress(1.0);
    setStatus("完成，Markdown 已下载。", "success");
    setMeta(`输出=${outputName}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || "未知错误");
    setStatus(msg, "error");
  } finally {
    setRunning(false);
  }
}

async function bootstrap() {
  try {
    await loadSettings();
    setStatus("空闲");
    setMeta("就绪（本地模式）");
    setProgress(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || "初始化失败");
    setStatus(msg, "error");
  }
  refs.startBtn.addEventListener("click", handleStart);
}

bootstrap();
