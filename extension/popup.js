import { GlobalWorkerOptions, getDocument } from "./vendor/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

const API_SETTINGS_KEY = "paper_pdf_flow_api_settings";
const API_VALIDATE_STATE_KEY = "paper_pdf_flow_api_validate_state";
const MSG_EXTRACT_CURRENT_ARTICLE = "PPF_EXTRACT_CURRENT_ARTICLE";
const SOURCE_PDF = "pdf";
const SOURCE_WEB = "web";
const PAGE_CLASS_FULLTEXT_READY = "FULLTEXT_READY";
const PAGE_CLASS_ABSTRACT_ONLY = "ABSTRACT_ONLY";
const PAGE_CLASS_NON_ARTICLE_PAGE = "NON_ARTICLE_PAGE";
const PAGE_CLASS_UNSURE = "UNSURE";

const refs = {
  captureView: document.getElementById("captureView"),
  settingsView: document.getElementById("settingsView"),
  sourcePdfBtn: document.getElementById("sourcePdfBtn"),
  sourceWebBtn: document.getElementById("sourceWebBtn"),
  pdfSection: document.getElementById("pdfSection"),
  webSection: document.getElementById("webSection"),
  pdfFile: document.getElementById("pdfFile"),
  webUrl: document.getElementById("webUrl"),
  outputName: document.getElementById("outputName"),
  startBtn: document.getElementById("startBtn"),
  apiSettingsBtn: document.getElementById("apiSettingsBtn"),
  statusLine: document.getElementById("statusLine"),
  progressBar: document.getElementById("progressBar"),
  metaLine: document.getElementById("metaLine"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  modelName: document.getElementById("modelName"),
  saveApiBtn: document.getElementById("saveApiBtn"),
  backBtn: document.getElementById("backBtn"),
  configState: document.getElementById("configState"),
  stateIcon: document.getElementById("stateIcon"),
  stateText: document.getElementById("stateText"),
};

let sourceType = SOURCE_PDF;

function shouldResetOnOpen() {
  try {
    const params = new URLSearchParams(String(window.location.search || ""));
    return params.get("reset") === "1";
  } catch (_error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || "").replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
}

function safeText(value) {
  return String(value || "").trim();
}

function showElement(el) {
  if (el) {
    el.classList.remove("hidden");
  }
}

function hideElement(el) {
  if (el) {
    el.classList.add("hidden");
  }
}

function showCaptureView() {
  showElement(refs.captureView);
  hideElement(refs.settingsView);
}

function showSettingsView() {
  showElement(refs.settingsView);
  hideElement(refs.captureView);
}

function setSourceType(nextSource) {
  sourceType = nextSource === SOURCE_WEB ? SOURCE_WEB : SOURCE_PDF;

  refs.sourcePdfBtn.classList.toggle("active", sourceType === SOURCE_PDF);
  refs.sourceWebBtn.classList.toggle("active", sourceType === SOURCE_WEB);

  if (sourceType === SOURCE_PDF) {
    showElement(refs.pdfSection);
    hideElement(refs.webSection);
    refs.startBtn.textContent = "开始生成";
    refs.outputName.placeholder = "例如 note.md";
    return;
  }

  hideElement(refs.pdfSection);
  showElement(refs.webSection);
  refs.startBtn.textContent = "从当前页面生成";
  refs.outputName.placeholder = "例如 current_page_interpretation.md";
}

function setConfigState(kind, text) {
  const klasses = ["success", "failure", "loading"];
  refs.configState.classList.remove(...klasses);
  if (kind) {
    refs.configState.classList.add(kind);
  }

  refs.stateText.textContent = safeText(text) || "请先保存并测试连接";
  if (kind === "success") {
    refs.stateIcon.textContent = "✓";
  } else if (kind === "failure") {
    refs.stateIcon.textContent = "!";
  } else if (kind === "loading") {
    refs.stateIcon.textContent = "";
  } else {
    refs.stateIcon.textContent = "·";
  }
}

function readApiSettingsInputs() {
  return {
    baseUrl: safeText(refs.apiBaseUrl.value),
    apiKey: safeText(refs.apiKey.value),
    model: safeText(refs.modelName.value),
  };
}

function fillApiSettingsInputs(data) {
  refs.apiBaseUrl.value = safeText(data && data.baseUrl ? data.baseUrl : "");
  refs.apiKey.value = safeText(data && data.apiKey ? data.apiKey : "");
  refs.modelName.value = safeText(data && data.model ? data.model : "");
}

function normalizeApiSettings(data) {
  return {
    baseUrl: safeText(data && data.baseUrl ? data.baseUrl : ""),
    apiKey: safeText(data && data.apiKey ? data.apiKey : ""),
    model: safeText(data && data.model ? data.model : ""),
  };
}

function validateApiSettingsPayload(payload) {
  if (!payload.baseUrl) {
    return "请填写地址";
  }
  if (!payload.apiKey) {
    return "请填写 API 密钥";
  }
  if (!payload.model) {
    return "请填写模型名字";
  }
  return "";
}

function stripMarkdownFence(raw) {
  const trimmed = safeText(raw);
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? safeText(fenced[1]) : trimmed;
}

function extractResponseText(respJson) {
  if (typeof respJson?.output_text === "string" && safeText(respJson.output_text)) {
    return safeText(respJson.output_text);
  }

  if (Array.isArray(respJson?.output)) {
    const chunks = [];
    respJson.output.forEach((item) => {
      if (!Array.isArray(item?.content)) {
        return;
      }
      item.content.forEach((contentItem) => {
        if (typeof contentItem?.text === "string") {
          chunks.push(contentItem.text);
        }
      });
    });
    return safeText(chunks.join("\n"));
  }

  return "";
}

function buildResponsesEndpoint(baseUrl) {
  const trimmed = safeText(baseUrl).replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.endsWith("/responses")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/responses`;
  }
  return `${trimmed}/v1/responses`;
}

async function requestValidateConfig(payload) {
  const endpoint = buildResponsesEndpoint(payload.baseUrl);
  let resp;

  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${payload.apiKey}`,
      },
      body: JSON.stringify({
        model: payload.model,
        store: false,
        max_output_tokens: 16,
        input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
      }),
    });
  } catch (_error) {
    throw new Error("验证请求失败");
  }

  if (!resp.ok) {
    throw new Error(`验证失败（HTTP ${resp.status}）`);
  }
}

async function loadApiSettings() {
  const result = await chrome.storage.local.get([API_SETTINGS_KEY, API_VALIDATE_STATE_KEY]);
  const saved = normalizeApiSettings(result[API_SETTINGS_KEY] || {});
  fillApiSettingsInputs(saved);

  if (result[API_VALIDATE_STATE_KEY] === "success") {
    setConfigState("success", saved.model || "配置验证成功");
    return;
  }
  if (result[API_VALIDATE_STATE_KEY] === "failure") {
    setConfigState("failure", "最近一次测试连接失败");
    return;
  }
  setConfigState("", "请先保存并测试连接");
}

async function getValidatedApiSettings() {
  const result = await chrome.storage.local.get([API_SETTINGS_KEY, API_VALIDATE_STATE_KEY]);
  const saved = normalizeApiSettings(result[API_SETTINGS_KEY] || {});
  const message = validateApiSettingsPayload(saved);
  if (message) {
    throw new Error("请先完成 API 配置");
  }
  if (result[API_VALIDATE_STATE_KEY] !== "success") {
    throw new Error("请先在 API 配置中测试连接");
  }
  return saved;
}

async function saveApiSettings() {
  const payload = readApiSettingsInputs();
  const message = validateApiSettingsPayload(payload);
  if (message) {
    setConfigState("failure", message);
    return;
  }

  await chrome.storage.local.set({ [API_SETTINGS_KEY]: payload });
  setConfigState("loading", "正在测试接口连接...");

  try {
    await requestValidateConfig(payload);
    await chrome.storage.local.set({ [API_VALIDATE_STATE_KEY]: "success" });
    setConfigState("success", payload.model || "配置验证成功");
  } catch (error) {
    await chrome.storage.local.set({ [API_VALIDATE_STATE_KEY]: "failure" });
    setConfigState("failure", error instanceof Error ? error.message : String(error || "配置验证失败"));
  }
}

function takeExcerptWindow(fullText, start, maxChars) {
  const text = safeText(fullText);
  if (!text) {
    return "";
  }
  const safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
  const safeLength = Math.max(0, Number(maxChars) || 0);
  return text.slice(safeStart, safeStart + safeLength);
}

function extractSectionExcerpt(fullText, patterns, options = {}) {
  const text = safeText(fullText);
  if (!text) {
    return "";
  }

  const maxChars = Math.max(0, Number(options.maxChars) || 0) || 8000;
  const leadChars = Math.max(0, Number(options.leadChars) || 0);

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && Number.isFinite(match.index)) {
      const start = Math.max(0, match.index - leadChars);
      return text.slice(start, start + maxChars);
    }
  }

  return "";
}

function extractMiddleExcerpt(fullText, maxChars = 6000) {
  const text = safeText(fullText);
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const start = Math.max(0, Math.floor((text.length - maxChars) / 2));
  return text.slice(start, start + maxChars);
}

function buildModelPrompts({ pdfName, parsed }) {
  const title = safeText(parsed.titleGuess) || extractTitle(parsed.fullText, parsed.firstPageRaw);
  const doi = safeText(parsed.doiGuess) || extractDoi(parsed.fullText, parsed.firstPageRaw);
  const journal = safeText(parsed.journalGuess) || zhExtractJournalLine(parsed.fullText);
  const figs = Array.isArray(parsed.figures) && parsed.figures.length ? parsed.figures : extractFigCaptions(parsed.fullTextRaw);
  const signals = extractSignals(parsed.fullText);
  const introExcerpt = takeExcerptWindow(parsed.fullText, 0, 9000);
  const methodExcerpt = extractSectionExcerpt(
    parsed.fullText,
    [
      /\bmaterials?\s+and\s+methods?\b/i,
      /\bmethods?\b/i,
      /\bmethodology\b/i,
      /\bexperimental\s+setup\b/i,
      /\bimplementation\s+details?\b/i,
      /\bexperiments?\b/i,
    ],
    { maxChars: 11000, leadChars: 500 }
  );
  const resultsExcerpt = extractSectionExcerpt(
    parsed.fullText,
    [
      /\bresults?\s+and\s+discussion\b/i,
      /\bresults?\b/i,
      /\bdiscussion\b/i,
      /\bconclusions?\b/i,
    ],
    { maxChars: 8000, leadChars: 500 }
  );
  const middleExcerpt = extractMiddleExcerpt(parsed.fullText, 5000);
  const tailExcerpt = parsed.fullText.length > 18000 ? safeText(parsed.fullText).slice(-2500) : "";
  const payload = {
    file_name: pdfName,
    pages: parsed.pages,
    title_guess: title,
    journal_guess: journal,
    doi_guess: doi,
    figures: figs.map(([no, caption]) => ({ figure: `Fig.${no}`, caption })),
    signals,
    body_excerpt_intro: introExcerpt,
    body_excerpt_method: methodExcerpt,
    body_excerpt_middle: middleExcerpt,
    body_excerpt_results: resultsExcerpt,
    body_excerpt_tail: tailExcerpt,
  };

  const systemPrompt = [
    "你是资深首席研究员，正在白板前为没有专业背景的学生解读论文。",
    "你的任务不是写摘要，而是基于本地解析得到的论文文本、正文摘录和图注，输出一份高质量中文 Markdown 解读稿。",
    "只输出 Markdown，不要解释，不要 JSON，不要代码块。",
    "允许为了帮助理解补充解释，但不能编造原文未提供的事实、实验步骤、数据或结论。",
    "如果材料里没有明确给出某个细节，请明确写“原文摘录中未明确给出（建议回看原文）”。",
    "优先依据正文摘录解释论文逻辑，再结合图注补强结果证据链。",
    "Method 部分必须是全文最详细的部分，要逐步、逐点解释研究对象、输入输出、关键模块、执行顺序、训练或实验设置、评价方式，以及各步骤之间的关系。",
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
  ].join("\n");

  const userPrompt = [
    "请根据下面的 PDF 本地解析结果，生成最终中文 Markdown 解读。",
    "输出要求：",
    "1. 只输出 Markdown 正文。",
    "2. 用中文作答，风格像导师在白板前带学生读论文：简洁、清楚、便于非专业读者理解。",
    "3. 不是写详细摘要，而是按论文原始逻辑带用户读懂全文。",
    "4. “按原文结构解读全文”要按论文从问题定义到方法、结果、结论的顺序解释。",
    "5. “Method 详细解读”必须是全篇最详细的部分，可使用编号或分点，把实验或算法执行流程讲完整。",
    "6. “实验设计、数据与评价指标”要尽可能交代数据来源、分组、对照、时间点、剂量、评价指标和比较方式；若材料不足要明确说明。",
    "7. “结果如何支撑结论”要说明关键证据来自哪些实验、图或观察。",
    "8. 如图注与正文摘录侧重点不同，优先忠实正文，再用图注补充。",
    "9. 如果信息不确定，请明确写“未自动识别（建议手动补充）”或“原文摘录中未明确给出（建议回看原文）”。",
    "10. 不要照抄 payload，要把信息组织成自然、可读、结构稳定的解读稿。",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");

  return { systemPrompt, userPrompt };
}

async function requestMarkdownFromModel(config, prompts) {
  const endpoint = buildResponsesEndpoint(config.baseUrl);
  let resp;

  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        store: false,
        max_output_tokens: 5200,
        input: [
          { role: "system", content: [{ type: "input_text", text: prompts.systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: prompts.userPrompt }] },
        ],
      }),
    });
  } catch (_error) {
    throw new Error("模型请求失败");
  }

  if (!resp.ok) {
    throw new Error(`模型请求失败（HTTP ${resp.status}）`);
  }

  const data = await resp.json();
  const text = stripMarkdownFence(extractResponseText(data));
  if (!text) {
    throw new Error("模型返回为空");
  }
  return text;
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
  refs.sourcePdfBtn.disabled = disabled;
  refs.sourceWebBtn.disabled = disabled;
  refs.pdfFile.disabled = disabled;
  refs.webUrl.disabled = disabled;
  refs.outputName.disabled = disabled;
  refs.apiSettingsBtn.disabled = disabled;
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
  const stem = safeText(pdfName).replace(/\.pdf$/i, "") || "论文解读";
  return `${stem}.md`;
}

function defaultWebOutputName(title) {
  const stem = safeText(title)
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${stem || "current_page_interpretation"}.md`;
}

function countSectionHits(parsed, pageSignals) {
  const hits = new Set();

  if (pageSignals && pageSignals.hasIntroduction) hits.add("introduction");
  if (pageSignals && pageSignals.hasMethods) hits.add("methods");
  if (pageSignals && pageSignals.hasResults) hits.add("results");
  if (pageSignals && pageSignals.hasDiscussion) hits.add("discussion");

  return hits.size;
}

function classifyCurrentArticle(article) {
  const parsed = article && article.parsed ? article.parsed : {};
  const pageSignals = article && article.pageSignals ? article.pageSignals : {};
  const bodyChars = Number(pageSignals.articleTextLength || safeText(parsed.fullText).length || 0);
  const fullPageChars = Number(pageSignals.fullPageTextLength || 0);
  const rootRatio = Number(pageSignals.rootRatio || 0);
  const abstractChars = Number(pageSignals.abstractLength || 0);
  const figureCount = Number(pageSignals.figureCount || (Array.isArray(parsed.figures) ? parsed.figures.length : 0) || 0);
  const paragraphCount = Number(pageSignals.paragraphCount || 0);
  const headingCount = Number(pageSignals.headingCount || 0);
  const paywallCount = Array.isArray(pageSignals.paywallSignals) ? pageSignals.paywallSignals.length : 0;
  const sectionHits = countSectionHits(parsed, pageSignals);
  const hasCitationMeta = Boolean(
    safeText(article && article.doi ? article.doi : "") ||
      safeText(article && article.journal ? article.journal : "") ||
      pageSignals.hasCitationTitleMeta ||
      pageSignals.hasCitationDoiMeta ||
      pageSignals.hasCitationJournalMeta
  );
  const metaCount = [pageSignals.hasCitationTitleMeta, pageSignals.hasCitationDoiMeta, pageSignals.hasCitationJournalMeta].filter(Boolean).length;
  const usedBodyFallback = Boolean(pageSignals.usedBodyFallback);
  const hasAbstract = Boolean(pageSignals.hasAbstract);
  const hasMethods = Boolean(pageSignals.hasMethods);
  const hasResults = Boolean(pageSignals.hasResults);
  const hasDiscussion = Boolean(pageSignals.hasDiscussion);
  const title = safeText(article && article.title ? article.title : parsed.titleGuess || "");
  const titleLow = title.toLowerCase();
  const genericPageTitle =
    /(journal|journals|support|search results|browse|archive|table of contents|issues|home)/.test(titleLow) && !hasCitationMeta;
  const looksLikeAbstractOnly = hasAbstract && !hasMethods && !hasResults && !hasDiscussion;

  if ((!title && bodyChars < 1200 && !hasCitationMeta) || genericPageTitle) {
    return {
      type: PAGE_CLASS_NON_ARTICLE_PAGE,
      reason: "当前页面缺少稳定标题和论文元信息，更像普通网页而不是论文页。",
      metrics: { bodyChars, fullPageChars, rootRatio, abstractChars, sectionHits, figureCount, paragraphCount, headingCount, paywallCount, usedBodyFallback, metaCount },
    };
  }

  if (
    (!hasCitationMeta && sectionHits === 0 && figureCount === 0 && paragraphCount < 6 && bodyChars < 2500) ||
    (usedBodyFallback && !hasCitationMeta && rootRatio < 0.35 && sectionHits === 0)
  ) {
    return {
      type: PAGE_CLASS_NON_ARTICLE_PAGE,
      reason: "当前页面正文过少，未识别到论文正文结构，请切换到文章全文页。",
      metrics: { bodyChars, fullPageChars, rootRatio, abstractChars, sectionHits, figureCount, paragraphCount, headingCount, paywallCount, usedBodyFallback, metaCount },
    };
  }

  if (
    (paywallCount >= 1 && bodyChars < 5000 && sectionHits < 2) ||
    (hasCitationMeta && looksLikeAbstractOnly && bodyChars < 4000) ||
    (hasCitationMeta && abstractChars >= 120 && sectionHits === 0 && paragraphCount < 8) ||
    (hasCitationMeta && usedBodyFallback && looksLikeAbstractOnly && rootRatio < 0.45)
  ) {
    return {
      type: PAGE_CLASS_ABSTRACT_ONLY,
      reason: "当前页面更像摘要页或受限预览页，暂时无法生成完整论文解读。",
      metrics: { bodyChars, fullPageChars, rootRatio, abstractChars, sectionHits, figureCount, paragraphCount, headingCount, paywallCount, usedBodyFallback, metaCount },
    };
  }

  if (!usedBodyFallback && rootRatio >= 0.45 && bodyChars >= 4500 && sectionHits >= 2 && paragraphCount >= 8 && paywallCount === 0) {
    return {
      type: PAGE_CLASS_FULLTEXT_READY,
      reason: "当前页面已检测到较完整正文结构，可继续生成论文解读。",
      metrics: { bodyChars, fullPageChars, rootRatio, abstractChars, sectionHits, figureCount, paragraphCount, headingCount, paywallCount, usedBodyFallback, metaCount },
    };
  }

  if (!usedBodyFallback && rootRatio >= 0.6 && bodyChars >= 7000 && paragraphCount >= 10 && (sectionHits >= 1 || figureCount >= 2) && paywallCount === 0) {
    return {
      type: PAGE_CLASS_FULLTEXT_READY,
      reason: "当前页面正文较完整，可继续生成论文解读。",
      metrics: { bodyChars, fullPageChars, rootRatio, abstractChars, sectionHits, figureCount, paragraphCount, headingCount, paywallCount, usedBodyFallback, metaCount },
    };
  }

  return {
    type: PAGE_CLASS_UNSURE,
    reason: "当前页面提取到的正文结构不足，暂时无法确认是否为完整论文全文页。",
    metrics: { bodyChars, fullPageChars, rootRatio, abstractChars, sectionHits, figureCount, paragraphCount, headingCount, paywallCount, usedBodyFallback, metaCount },
  };
}

function pageClassToUserMessage(classification) {
  if (!classification) {
    return "当前页面分析失败。";
  }
  if (classification.type === PAGE_CLASS_ABSTRACT_ONLY) {
    return "当前页面仅检测到摘要或受限预览，无法生成完整论文解读。请打开全文页，或改用 PDF。";
  }
  if (classification.type === PAGE_CLASS_NON_ARTICLE_PAGE) {
    return "当前页面不像论文正文页，请切换到文章全文页面后再试。";
  }
  if (classification.type === PAGE_CLASS_UNSURE) {
    return "当前页面正文结构不足，暂时无法确认是完整全文页。建议切换到正文页或改用 PDF。";
  }
  return "当前页面可继续生成论文解读。";
}

function isRestrictedTabUrl(url) {
  const value = safeText(url).toLowerCase();
  return !value || value.startsWith("chrome://") || value.startsWith("chrome-extension://") || value.startsWith("edge://") || value.startsWith("about:");
}

async function requestCurrentPageArticle() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
  if (!activeTab || !activeTab.id) {
    throw new Error("未找到当前标签页，请先打开论文网页。");
  }
  if (isRestrictedTabUrl(activeTab.url)) {
    throw new Error("当前页面不支持读取，请切换到论文网页后再试。");
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(activeTab.id, { type: MSG_EXTRACT_CURRENT_ARTICLE });
  } catch (_error) {
    throw new Error("当前页面尚未准备好网页抽取，请刷新论文页面后重试。");
  }

  if (!response || response.ok !== true) {
    throw new Error(response && response.error ? response.error : "网页正文抽取失败");
  }
  return response;
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

async function handleWebStart() {
  try {
    setRunning(true);
    setProgress(0);
    setMeta("");
    const url = safeText(refs.webUrl.value);
    if (url) {
      throw new Error("当前版本先支持“从当前页面生成”，URL 输入将在下一步接入。");
    }

    setStatus("正在读取当前页面...");
    const apiConfig = await getValidatedApiSettings();
    const article = await requestCurrentPageArticle();
    const parsed = article.parsed || {};
    const classification = classifyCurrentArticle(article);
    if (classification.type !== PAGE_CLASS_FULLTEXT_READY) {
      setProgress(0);
      setMeta(
        `判定=${classification.type} | 正文=${classification.metrics.bodyChars} | 占比=${classification.metrics.rootRatio} | 章节=${classification.metrics.sectionHits} | 图注=${classification.metrics.figureCount} | rootFallback=${classification.metrics.usedBodyFallback}`
      );
      throw new Error(pageClassToUserMessage(classification));
    }
    const outputName = validateOutputName(refs.outputName.value) || defaultWebOutputName(article.title || parsed.titleGuess || "current_page_interpretation");

    setProgress(0.18);
    await sleep(30);
    setStatus("正在整理论文结构与方法...");
    setMeta(`页面=${article.title || "当前页面"} | 模型=${apiConfig.model} | 判定=FULLTEXT_READY | 占比=${classification.metrics.rootRatio}`);

    setProgress(0.45);
    await sleep(30);
    setStatus("正在调用模型生成论文解读...");
    const md = await requestMarkdownFromModel(
      apiConfig,
      buildModelPrompts({ pdfName: article.title || "current_page", parsed })
    );

    setProgress(0.88);
    await sleep(30);
    setStatus("正在准备下载...");
    triggerDownload(md, outputName);
    setProgress(1.0);
    setStatus("完成，当前页面论文解读 Markdown 已下载。", "success");
    setMeta(`输出=${outputName} | 来源=当前页面`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || "未知错误");
    setStatus(msg, "error");
  } finally {
    setRunning(false);
  }
}

async function handleStart() {
  if (sourceType === SOURCE_WEB) {
    await handleWebStart();
    return;
  }

  try {
    setRunning(true);
    setProgress(0);
    setMeta("");
    setStatus("正在校验输入...");

    const file = refs.pdfFile.files && refs.pdfFile.files[0] ? refs.pdfFile.files[0] : null;
    ensurePdfFile(file);
    const apiConfig = await getValidatedApiSettings();
    const outputName = validateOutputName(refs.outputName.value) || defaultOutputName(file.name);

    setProgress(0.12);
    setStatus("正在读取 PDF...");
    setMeta(`文件=${file.name}`);
    await sleep(30);

    const parsed = await readPdfText(file);
    if (safeText(parsed.fullText).length < 80) {
      throw new Error("PDF 文本提取过少，暂时无法调用模型生成");
    }

    setProgress(0.42);
    setStatus("正在整理论文结构与方法...");
    setMeta(`页数=${parsed.pages} | 模型=${apiConfig.model}`);
    await sleep(30);

    setProgress(0.68);
    setStatus("正在调用模型生成论文解读...");
    await sleep(30);

    const md = await requestMarkdownFromModel(
      apiConfig,
      buildModelPrompts({ pdfName: file.name, parsed })
    );

    setProgress(0.92);
    setStatus("正在准备下载...");
    await sleep(30);
    triggerDownload(md, outputName);
    setProgress(1.0);
    setStatus("完成，论文解读 Markdown 已下载。", "success");
    setMeta(`输出=${outputName} | 模式=论文解读`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || "未知错误");
    setStatus(msg, "error");
  } finally {
    setRunning(false);
  }
}

async function bootstrap() {
  try {
    if (shouldResetOnOpen()) {
      refs.pdfFile.value = "";
      refs.webUrl.value = "";
      refs.outputName.value = "";
    }
    showCaptureView();
    setSourceType(SOURCE_PDF);
    setStatus("空闲");
    setMeta(shouldResetOnOpen() ? "已重置，等待新任务" : "就绪（论文解读模式）");
    setProgress(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || "初始化失败");
    setStatus(msg, "error");
  }
  refs.startBtn.addEventListener("click", handleStart);
  refs.sourcePdfBtn.addEventListener("click", () => {
    setSourceType(SOURCE_PDF);
    setStatus("空闲");
    setMeta("就绪（PDF 模式）");
    setProgress(0);
  });
  refs.sourceWebBtn.addEventListener("click", () => {
    setSourceType(SOURCE_WEB);
    setStatus("空闲");
    setMeta("就绪（网页提取模式，第一版支持当前页面）");
    setProgress(0);
  });
  refs.apiSettingsBtn.addEventListener("click", async () => {
    await loadApiSettings();
    showSettingsView();
  });
  refs.saveApiBtn.addEventListener("click", saveApiSettings);
  refs.backBtn.addEventListener("click", () => {
    showCaptureView();
  });
}

bootstrap();
