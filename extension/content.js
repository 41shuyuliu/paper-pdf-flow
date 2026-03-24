const MSG_OPEN_PANEL = "PPF_OPEN_PANEL";
const MSG_CLOSE_PANEL = "PPF_CLOSE_PANEL";
const MSG_QUERY_PANEL_STATE = "PPF_QUERY_PANEL_STATE";
const MSG_PANEL_CLOSED = "PPF_PANEL_CLOSED";
const MSG_DEBUG_EVENT = "PPF_DEBUG_EVENT";

const PANEL_ROOT_ID = "__ppf_panel_root__";
const PANEL_STYLE_ID = "__ppf_panel_style__";
const DEBUG_PREFIX = "[PPF][PAGE]";
const DEBUG_BUFFER_MAX = 200;
const PANEL_EDGE_GAP = 6;

function nowIso() {
  return new Date().toISOString();
}

function safeDebugDetail(detail) {
  if (!detail) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch (_error) {
    return { raw: String(detail) };
  }
}

function pushDebugEntry(entry) {
  try {
    const current = Array.isArray(window.__ppfDebugBuffer) ? window.__ppfDebugBuffer : [];
    current.push(entry);
    if (current.length > DEBUG_BUFFER_MAX) {
      current.splice(0, current.length - DEBUG_BUFFER_MAX);
    }
    window.__ppfDebugBuffer = current;
  } catch (_error) {
    // ignore
  }
}

function debugLog(event, detail = {}) {
  const payload = {
    ts: nowIso(),
    event,
    detail: safeDebugDetail(detail),
  };
  pushDebugEntry(payload);
  console.log(`${DEBUG_PREFIX} ${event}`, payload);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function placePanel(root, left, top) {
  const maxLeft = Math.max(PANEL_EDGE_GAP, window.innerWidth - root.offsetWidth - PANEL_EDGE_GAP);
  const maxTop = Math.max(PANEL_EDGE_GAP, window.innerHeight - root.offsetHeight - PANEL_EDGE_GAP);
  const nextLeft = clamp(left, PANEL_EDGE_GAP, maxLeft);
  const nextTop = clamp(top, PANEL_EDGE_GAP, maxTop);

  root.style.left = `${Math.round(nextLeft)}px`;
  root.style.top = `${Math.round(nextTop)}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";
}

function installPanelDrag(root, header, closeBtn) {
  if (root.__ppfDragReady) {
    return;
  }
  root.__ppfDragReady = true;

  let dragging = null;

  const endDrag = () => {
    if (!dragging) {
      return;
    }
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    debugLog("panel_drag_end");
    dragging = null;
  };

  const onMouseMove = (event) => {
    if (!dragging) {
      return;
    }
    const dx = event.clientX - dragging.startX;
    const dy = event.clientY - dragging.startY;
    placePanel(root, dragging.startLeft + dx, dragging.startTop + dy);
    event.preventDefault();
  };

  const onMouseUp = () => {
    endDrag();
  };

  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (closeBtn.contains(event.target)) {
      return;
    }

    const rect = root.getBoundingClientRect();
    dragging = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    debugLog("panel_drag_start", { x: event.clientX, y: event.clientY });
    event.preventDefault();
  });

  window.addEventListener("resize", () => {
    const rect = root.getBoundingClientRect();
    placePanel(root, rect.left, rect.top);
  });
}

function ensurePanelStyle() {
  if (document.getElementById(PANEL_STYLE_ID)) {
    debugLog("ensure_panel_style_reuse");
    return;
  }

  const style = document.createElement("style");
  style.id = PANEL_STYLE_ID;
  style.textContent = `
    #${PANEL_ROOT_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 390px;
      max-width: calc(100vw - 20px);
      height: 640px;
      max-height: calc(100vh - 20px);
      background: linear-gradient(180deg, #eef3f7 0%, #e7edf3 100%);
      border: 1px solid #cfd8e2;
      border-radius: 22px;
      box-shadow: 0 18px 34px rgba(24, 45, 64, 0.18);
      z-index: 2147483646;
      display: none;
      overflow: hidden;
      flex-direction: column;
    }

    #${PANEL_ROOT_ID} .ppf-header {
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      background: linear-gradient(180deg, #1b557f 0%, #174c7a 100%);
      border-bottom: 1px solid rgba(255, 255, 255, 0.14);
      color: #fff;
      font: 600 13px/1 "Segoe UI", Tahoma, sans-serif;
      user-select: none;
      cursor: move;
      touch-action: none;
    }

    #${PANEL_ROOT_ID} .ppf-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #${PANEL_ROOT_ID} .ppf-close {
      border: 0;
      background: transparent;
      color: #fff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      border-radius: 8px;
    }

    #${PANEL_ROOT_ID} .ppf-close:hover {
      background: rgba(255, 255, 255, 0.14);
    }

    #${PANEL_ROOT_ID} .ppf-body {
      flex: 1;
      min-height: 0;
      padding: 8px;
      background: linear-gradient(180deg, #eef3f7 0%, #e6edf3 100%);
    }

    #${PANEL_ROOT_ID} .ppf-frame {
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: 16px;
      background: transparent;
      display: block;
    }
  `;
  document.documentElement.appendChild(style);
  debugLog("ensure_panel_style_created");
}

function buildPopupSrc(reset) {
  const base = chrome.runtime.getURL("popup.html");
  if (!reset) {
    return base;
  }
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}reset=1&t=${Date.now()}`;
}

function ensurePanel() {
  ensurePanelStyle();

  let root = document.getElementById(PANEL_ROOT_ID);
  if (root) {
    debugLog("ensure_panel_reuse");
    return root;
  }

  root = document.createElement("div");
  root.id = PANEL_ROOT_ID;

  const header = document.createElement("div");
  header.className = "ppf-header";

  const title = document.createElement("div");
  title.className = "ppf-title";
  title.textContent = "论文解读助手";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ppf-close";
  closeBtn.title = "关闭面板";
  closeBtn.textContent = "×";

  const body = document.createElement("div");
  body.className = "ppf-body";

  const frame = document.createElement("iframe");
  frame.className = "ppf-frame";
  frame.src = buildPopupSrc(false);
  frame.setAttribute("title", "论文解读助手");
  body.appendChild(frame);

  closeBtn.addEventListener("click", () => {
    debugLog("panel_close_button_clicked");
    root.style.display = "none";
    chrome.runtime.sendMessage({ type: MSG_PANEL_CLOSED }, () => {});
  });
  installPanelDrag(root, header, closeBtn);

  header.appendChild(title);
  header.appendChild(closeBtn);
  root.appendChild(header);
  root.appendChild(body);

  document.documentElement.appendChild(root);
  debugLog("ensure_panel_created");
  return root;
}

function openPanel(reset) {
  if (window !== window.top) {
    debugLog("open_panel_ignored_non_top");
    return;
  }
  debugLog("open_panel_start", { reset: Boolean(reset) });
  const panel = ensurePanel();
  const frame = panel.querySelector(".ppf-frame");
  if (frame && reset) {
    frame.src = buildPopupSrc(true);
  } else if (frame && !String(frame.src || "").startsWith(chrome.runtime.getURL("popup.html"))) {
    frame.src = buildPopupSrc(false);
  }
  panel.style.display = "flex";
  debugLog("open_panel_done", { reset: Boolean(reset) });
}

function closePanel() {
  const panel = document.getElementById(PANEL_ROOT_ID);
  const hadPanel = Boolean(panel);
  if (hadPanel) {
    panel.style.display = "none";
  }
  debugLog("close_panel_done", { hadPanel });
  return { open: false, hadPanel };
}

function queryPanelState() {
  const panel = document.getElementById(PANEL_ROOT_ID);
  const state = {
    open: Boolean(panel && panel.style.display !== "none"),
    hasPanel: Boolean(panel),
  };
  debugLog("query_panel_state", state);
  return state;
}

function installRuntimeOnce() {
  if (window.__ppfRuntimeInstalled) {
    debugLog("runtime_install_skip_already_installed");
    return;
  }
  window.__ppfRuntimeInstalled = true;
  debugLog("runtime_install_done", {
    href: String(window.location.href || ""),
    topWindow: window === window.top,
    readyState: String(document.readyState || ""),
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }
    debugLog("runtime_message_received", { type: String(message.type || "unknown") });

    if (message.type === MSG_DEBUG_EVENT) {
      debugLog(`background_event:${String(message.event || "unknown")}`, message.detail || {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MSG_OPEN_PANEL) {
      try {
        openPanel(Boolean(message.reset));
        sendResponse({ ok: true, open: true });
        debugLog("runtime_message_open_done", { reset: Boolean(message.reset) });
      } catch (error) {
        debugLog("runtime_message_open_failed", {
          error: String(error && error.message ? error.message : error || "open_failed"),
        });
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error || "open_failed") });
      }
      return;
    }

    if (message.type === MSG_CLOSE_PANEL) {
      const result = closePanel();
      sendResponse({ ok: true, open: false, hadPanel: result.hadPanel });
      debugLog("runtime_message_close_done", result);
      return;
    }

    if (message.type === MSG_QUERY_PANEL_STATE) {
      const state = queryPanelState();
      sendResponse({ ok: true, open: state.open, hasPanel: state.hasPanel });
      debugLog("runtime_message_query_done", state);
      return;
    }

    debugLog("runtime_message_ignored_unknown", { type: String(message.type || "unknown") });
  });
}

installRuntimeOnce();
