const MSG_OPEN_PANEL = "PPF_OPEN_PANEL";
const MSG_CLOSE_PANEL = "PPF_CLOSE_PANEL";
const MSG_QUERY_PANEL_STATE = "PPF_QUERY_PANEL_STATE";
const MSG_PANEL_CLOSED = "PPF_PANEL_CLOSED";
const MSG_DEBUG_EVENT = "PPF_DEBUG_EVENT";
const PANEL_STATE_PREFIX = "PPF_PANEL_STATE_";
const DEBUG_PREFIX = "[PPF][DEBUG]";

const panelStateStorage = chrome.storage.session || chrome.storage.local;

function stateKey(tabId) {
  return `${PANEL_STATE_PREFIX}${tabId}`;
}

function nowIso() {
  return new Date().toISOString();
}

function toErrorText(error) {
  return error instanceof Error ? error.message : String(error || "");
}

function debugLog(event, detail = {}) {
  const payload = {
    ts: nowIso(),
    event,
    ...detail,
  };
  console.log(`${DEBUG_PREFIX} ${event}`, payload);
}

async function mirrorDebugToTab(tabId, event, detail = {}) {
  if (!tabId) {
    return;
  }
  try {
    await sendToContentWithRetry(tabId, {
      type: MSG_DEBUG_EVENT,
      event,
      detail: { ts: nowIso(), ...detail },
    });
  } catch (_error) {
    // Ignore mirror failures; the service worker console still has full logs.
  }
}

function isNoReceiverError(error) {
  const text = toErrorText(error).toLowerCase();
  return text.includes("receiving end does not exist") || text.includes("could not establish connection");
}

function isRestrictedUrl(url) {
  const text = String(url || "").toLowerCase();
  return text.startsWith("chrome://") || text.startsWith("edge://") || text.startsWith("about:") || text.startsWith("chrome-extension://");
}

async function getPanelState(tabId) {
  const key = stateKey(tabId);
  const data = await panelStateStorage.get(key);
  const saved = data && data[key] ? data[key] : null;
  return { open: Boolean(saved && saved.open) };
}

async function setPanelState(tabId, open) {
  const key = stateKey(tabId);
  await panelStateStorage.set({ [key]: { open: Boolean(open) } });
}

async function clearPanelState(tabId) {
  await panelStateStorage.remove(stateKey(tabId));
}

async function sendToContentWithRetry(tabId, message) {
  debugLog("send_message_start", { tabId, type: message && message.type ? message.type : "unknown" });
  try {
    const resp = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    debugLog("send_message_ok", { tabId, type: message && message.type ? message.type : "unknown" });
    return resp;
  } catch (error) {
    if (!isNoReceiverError(error)) {
      debugLog("send_message_failed", {
        tabId,
        type: message && message.type ? message.type : "unknown",
        error: toErrorText(error),
      });
      throw error;
    }
    debugLog("send_message_retry_inject", { tabId, type: message && message.type ? message.type : "unknown" });
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  const resp = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  debugLog("send_message_retry_ok", { tabId, type: message && message.type ? message.type : "unknown" });
  return resp;
}

async function queryPanelState(tabId) {
  const resp = await sendToContentWithRetry(tabId, { type: MSG_QUERY_PANEL_STATE, source: "action_probe" });
  if (!resp || resp.ok !== true) {
    return { open: false };
  }
  return { open: Boolean(resp.open) };
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || isRestrictedUrl(tab.url)) {
    debugLog("action_click_ignored", {
      reason: !tab || !tab.id ? "invalid_tab" : "restricted_url",
      url: String(tab && tab.url ? tab.url : ""),
    });
    console.warn("[PPF] action click ignored on restricted page:", String(tab && tab.url ? tab.url : ""));
    return;
  }
  const tabId = tab.id;
  debugLog("action_click", { tabId, url: String(tab.url || "") });
  void mirrorDebugToTab(tabId, "action_click", { tabId, url: String(tab.url || "") });

  try {
    // 优先以页面真实状态为准，避免 storage 与页面状态漂移。
    const real = await queryPanelState(tabId);
    debugLog("panel_state_real", { tabId, open: Boolean(real.open) });
    void mirrorDebugToTab(tabId, "panel_state_real", { tabId, open: Boolean(real.open) });

    if (real.open) {
      const closeResp = await sendToContentWithRetry(tabId, { type: MSG_CLOSE_PANEL, source: "action_toggle" });
      const storedOpen = !(closeResp && closeResp.ok === true ? Boolean(closeResp.open) : false);
      await setPanelState(tabId, storedOpen);
      debugLog("panel_close_done", { tabId, response: closeResp, storedOpen });
      void mirrorDebugToTab(tabId, "panel_close_done", { tabId, response: closeResp, storedOpen });
    } else {
      const openResp = await sendToContentWithRetry(tabId, { type: MSG_OPEN_PANEL, reset: true, source: "action_toggle" });
      const storedOpen = Boolean(openResp && openResp.ok === true ? openResp.open : true);
      await setPanelState(tabId, storedOpen);
      debugLog("panel_open_done", { tabId, response: openResp, storedOpen });
      void mirrorDebugToTab(tabId, "panel_open_done", { tabId, response: openResp, storedOpen });
    }
  } catch (error) {
    debugLog("action_click_failed", { tabId, error: toErrorText(error) });
    void mirrorDebugToTab(tabId, "action_click_failed", { tabId, error: toErrorText(error) });
    console.warn("[PPF] action click failed:", toErrorText(error));
    // 发生异常时兜底回写 false，避免后续长期误判为已打开。
    try {
      await setPanelState(tabId, false);
      debugLog("panel_state_fallback_false", { tabId });
      void mirrorDebugToTab(tabId, "panel_state_fallback_false", { tabId });
    } catch (_error) {
      // ignore
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || !tab.id || changeInfo.status !== "complete") {
    return;
  }
  // 需求 B：页面刷新后默认关闭，不自动恢复。
  await setPanelState(tabId, false);
  debugLog("tab_updated_reset_state", { tabId, status: String(changeInfo.status || "") });
  void mirrorDebugToTab(tabId, "tab_updated_reset_state", { tabId, status: String(changeInfo.status || "") });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearPanelState(tabId);
  debugLog("tab_removed_clear_state", { tabId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MSG_PANEL_CLOSED) {
    return;
  }
  (async () => {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!tabId) {
      sendResponse({ ok: false, error: "tab_id_missing" });
      return;
    }
    await setPanelState(tabId, false);
    debugLog("panel_closed_by_content", { tabId });
    void mirrorDebugToTab(tabId, "panel_closed_by_content", { tabId });
    sendResponse({ ok: true });
  })().catch((error) => {
    debugLog("panel_closed_handler_failed", { error: toErrorText(error) });
    sendResponse({ ok: false, error: toErrorText(error) });
  });
  return true;
});
