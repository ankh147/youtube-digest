/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

function getEmbeddedSafariContext() {
  const location = window.location;
  if (location?.protocol !== "safari-web-extension:" || window.parent === window) return null;
  const params = new URL(location.href).searchParams;
  const tab = params.get("tab");
  const videoId = params.get("video");
  if (!tab || !/^\d+$/.test(tab) || !YTD_SETTINGS.videoFromId(videoId)) return null;
  const tabId = Number(tab);
  return Number.isSafeInteger(tabId) ? { tabId, videoId, readingLayout: params.get("layout") === "reading" } : null;
}

const embeddedSafariContext = getEmbeddedSafariContext();
const bilibiliSubtitleAccess = { origins: ["https://api.bilibili.com/*", "https://*.hdslb.com/*"] };

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptCoverage = null;
let transcriptAcquisition = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let overviewRequest = null;
let overviewError = "";
let seekRequest = 0;
let safariPlaybackPosition;
let videoTabId = null;
let digestRequest = null;
let notesRequest = 0;

// --- Translation state ---
// The universal language control supports original content, Chinese, and an
// aligned bilingual view across Transcript, Overview, and Notes.
let currentTranscriptMode = "original";
const DISPLAY_LANGUAGE_MODE_KEY = "ytd_display_language_modes_by_video";
const DISPLAY_LANGUAGE_MODES = new Set(["original", "zh", "bilingual"]);
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let interfaceTranslationCache = new Map();
let interfaceTranslationInFlight = new Set();
let interfaceTranslationFailures = new Set();
let currentNotes = [];
let currentNotesFilterVideoId = null;
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const TRANSLATION_BATCH_SIZE = 3;

// --- Transcript search state ---
// Matches point to visible marks in the active transcript language mode.
// Search navigation only scrolls the panel. It does not seek the video.
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Transcript reading position state ---
// Session storage survives a side panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let selectionActionsController = null;
let lastTranscriptScrollTop = 0;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

const BILIBILI_READING_LIMITS = Object.freeze({
  sentenceSeconds: 8,
  maxSeconds: 12,
  pauseSeconds: 1,
  maxChars: 110,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(
  entries,
  limits = TRANSCRIPT_SEGMENT_LIMITS,
  { preserveCueTimestamps = false } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          entryIndex,
          cueStart: start,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
      ...(preserveCueTimestamps && {
        cues: current.cues,
        displayText: current.cues.map(({ text }) => text).join(" "),
      }),
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "", cues: [] };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    if (preserveCueTimestamps) {
      if (current.lastEntryIndex === piece.entryIndex) {
        const previousCue = current.cues[current.cues.length - 1];
        previousCue.text = normalizeCaptionText(`${previousCue.text} ${piece.text}`);
      } else {
        current.cues.push({ start: Math.max(current.start, piece.cueStart), text: piece.text });
        current.lastEntryIndex = piece.entryIndex;
      }
    }
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  if (embeddedSafariContext) setupSafariPanel();
  setTranscriptModeButtons("original");
  setupEventListeners();
  await evictOldCacheEntries(20);

  await checkCurrentTab();
});

// Listen for messages from the page button and background worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    void checkCurrentTab({ expectedTabId: message.tabId });
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// Keep the panel on the active video in this window. Switching windows or
// finishing an older request must never change the video shown here.

let navigationRefreshTimer = null;
let panelWindowId = null;
if (!embeddedSafariContext) {
  chrome.windows.getCurrent().then((w) => {
    panelWindowId = w.id;
  });
}

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Follow the current tab and invalidate work for the previous video.
 */
function handleFrontTabUrl(url, tabId) {
  if (!YTD_SETTINGS.supportsPanel(url)) {
    digestRequest = null;
    translationGeneration += 1;
    // Start the position save, then close in this same event callback. Chrome
    // does not reliably honor window.close() after an asynchronous wait.
    void saveCurrentTranscriptViewState();
    window.close();
    return;
  }

  const newVideoId = YTD_SETTINGS.videoFromUrl(url)?.id ?? null;
  if (digestRequest && (digestRequest.videoId !== newVideoId || digestRequest.tabId !== tabId)) {
    digestRequest = null;
    translationGeneration += 1;
  }
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || tabId !== videoTabId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

/**
 * Gets the best URL from a tab update that can change the visible page.
 * The status events repeat the close request after Chrome commits the first
 * non-YouTube navigation, when an early URL event alone can be lost.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

if (!embeddedSafariContext) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active) return;
    if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
    const url = getNavigationUrl(changeInfo, tab);
    if (!url) return;
    handleFrontTabUrl(url, tabId);
  });

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (panelWindowId !== null && windowId !== panelWindowId) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      handleFrontTabUrl(tab.url || tab.pendingUrl || "", tabId);
    } catch {}
  });
}

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
  document.getElementById("overviewRetry").addEventListener("click", () => {
    document.querySelector('.tab[data-tab="overview"]')?.focus();
    void triggerAnalysis();
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    void checkCurrentTab();
  });

  document.querySelectorAll("[data-transcript-method]").forEach((button) => {
    button.addEventListener("click", () => void requestTranscriptReplacement(button.dataset.transcriptMethod));
  });
  document.getElementById("transcriptSettingsBtn").addEventListener("click", () => {
    void chrome.runtime.sendMessage({ action: "openOptions" });
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleDisplayLanguageModeChange(button.dataset.transcriptMode);
    });
  });
  setupTranscriptSearch();

  // pagehide also covers closing the side panel without a tab change.
  window.addEventListener("pagehide", () => {
    void saveCurrentTranscriptViewState();
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setupSafariPanel() {
  document.documentElement.classList.add("safari-embedded");
  const closeButton = document.getElementById("closeSafariPanelBtn");
  closeButton.hidden = false;
  if (embeddedSafariContext.readingLayout) {
    document.documentElement.classList.add("safari-reading");
    closeButton.textContent = "返回视频";
    window.addEventListener("message", (event) => {
      if (!event.isTrusted || event.source !== window.parent) return;
      const data = event.data;
      if (data?.action === "safariDigestSeekFailed" && data.request === seekRequest) {
        document.getElementById("seekStatus").textContent = data.error;
      }
      if (data?.action === "safariDigestPlaybackPosition" && data.videoId === currentVideoId) {
        safariPlaybackPosition = Number.isFinite(data.seconds) ? data.seconds : undefined;
      }
    });
  }
  closeButton.addEventListener("click", () => void closeSafariPanel());
  const noteButton = document.getElementById("savePlaybackNoteBtn");
  noteButton.hidden = false;
  noteButton.addEventListener("click", async () => {
    const videoId = currentVideoId;
    const status = document.getElementById("seekStatus");
    if (!videoId || !currentTranscript) {
      status.textContent = "请先获取字幕。";
      return;
    }
    noteButton.disabled = true;
    status.textContent = "正在保存笔记…";
    try {
      const seconds = embeddedSafariContext.readingLayout
        ? safariPlaybackPosition
        : (await relayToVideo({ action: "getCurrentTime" }))?.response?.currentTime;
      if (!Number.isFinite(seconds)) throw new Error("无法读取当前播放时间。");
      const saved = await chrome.runtime.sendMessage({
        action: "saveNote",
        videoId,
        timestamp: Math.max(0, Math.floor(seconds) - 3),
        videoTitle: currentVideoTitle,
        channelName: currentChannelName,
      });
      if (!saved?.success) throw new Error(saved?.error || "无法保存笔记。");
      status.textContent = "笔记已保存。";
      if (videoId === currentVideoId) void loadNotes(currentNotesFilterVideoId);
    } catch (error) {
      status.textContent = localizeError(error.message);
    } finally {
      noteButton.disabled = false;
    }
  });
}

async function closeSafariPanel() {
  await saveCurrentTranscriptViewState();
  window.parent.postMessage({ action: "closeSafariDigest" }, "*");
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

function relayToVideo(payload, tabId = videoTabId, videoId = currentVideoId) {
  return chrome.runtime.sendMessage({ action: "relayToContent", tabId, videoId, payload });
}

async function checkCurrentTab({ expectedTabId } = {}) {
  let request;
  try {
    let selectedTab;
    if (embeddedSafariContext) {
      selectedTab = await chrome.runtime.sendMessage({
        action: "getSafariPanelVideo",
        ...embeddedSafariContext,
      });
      if (!selectedTab) {
        showError("无法加载视频", "视频页面已切换，请重新打开摘要。");
        return;
      }
    } else {
      const query = panelWindowId === null
        ? { active: true, currentWindow: true }
        : { active: true, windowId: panelWindowId };
      const [tab] = await chrome.tabs.query(query);
      selectedTab = tab;
    }
    const tab = selectedTab;
    if (!tab?.url || (expectedTabId && tab.id !== expectedTabId)) return;
    if (!YTD_SETTINGS.supportsPanel(tab.url)) {
      handleFrontTabUrl(tab.url, tab.id);
      return;
    }
    const source = YTD_SETTINGS.videoFromUrl(tab.url);
    if (!source) {
      digestRequest = null;
      currentVideoId = null;
      videoTabId = null;
      showState("welcome");
      return;
    }
    if (digestRequest?.videoId === source.id && digestRequest.tabId === tab.id) return;
    if (currentVideoId === source.id && videoTabId === tab.id && panelIsShowingResults()) return;

    request = { videoId: source.id, tabId: tab.id };
    digestRequest = request;
    await startDigest(source, tab, request);
  } catch (error) {
    console.error("Video check error:", error);
    if ((request && digestRequest === request) || (embeddedSafariContext && !request)) {
      showError("无法加载视频", localizeError(error.message));
    }
  } finally {
    if (digestRequest === request) digestRequest = null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(source, tab, request) {
  const videoId = source.id;
  const videoChanged = videoId !== currentVideoId;
  const isCurrent = () => digestRequest === request;
  if (videoChanged) {
    await saveCurrentTranscriptViewState();
    if (!isCurrent()) return;
    translationGeneration += 1;
    transcriptScrollObserver?.disconnect();
    transcriptScrollObserver = null;
    resetTranscriptSearch();
    lastTranscriptScrollTop = 0;
    currentNotes = [];
    pendingTranscriptViewState = null;
    currentTranscriptMode = "original";
    setTranscriptModeButtons("original");
    document.querySelectorAll(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === "transcript");
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === "transcript");
    });
    document.getElementById("chapterList").replaceChildren();
    document.getElementById("quotesList").replaceChildren();
    document.getElementById("notesList").replaceChildren();
  }

  currentVideoId = videoId;
  currentVideoUrl = source.url;
  videoTabId = tab.id;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptCoverage = null;
  transcriptAcquisition = null;
  document.getElementById("supadataChoices").open = false;
  overviewRequest = null;
  renderOverviewStatus();
  currentVideoTitle = "";
  currentChannelName = "";
  currentVideoDescription = "";
  currentVideoDuration = 0;
  document.getElementById("videoInfo").style.display = "none";
  showState("loading");
  updateLoading("正在查找字幕", "");

  const [viewState, displayMode, cached, videoResult] = await Promise.all([
    loadTranscriptViewState(videoId),
    loadDisplayLanguageMode(videoId),
    loadFromCache(videoId),
    relayToVideo({ action: "getVideoInfo" }, tab.id, videoId).catch(() => null),
  ]);
  if (!isCurrent()) return;
  pendingTranscriptViewState = viewState;
  currentTranscriptMode = displayMode;
  setTranscriptModeButtons(displayMode);
  document.getElementById("contentArea")?.classList.toggle(
    "restoring-transcript-view", Boolean(viewState),
  );
  const videoInfo = videoResult?.success ? videoResult.response : null;
  applyVideoInfo({
    ...cached?.videoInfo,
    ...videoInfo,
    duration: videoInfo?.duration || cached?.videoInfo?.duration,
  }, tab.title);

  let digest = cached;
  if (!digest) {
    updateLoading("正在读取网页字幕", "");
    const result = await fetchTranscriptForVideo(request, "web");
    if (!isCurrent()) return;
    if (!result?.success) {
      transcriptAcquisition = transcriptFailure(result);
      showState("transcriptFallback");
      return;
    }
    digest = result;
  }

  displayDigest(digest);
  if (!cached) await saveToCache(videoId);
}

function fetchTranscriptForVideo(request, method) {
  return chrome.runtime.sendMessage({
    action: "fetchTranscript", videoId: request.videoId, tabId: request.tabId,
    method, duration: currentVideoDuration,
  });
}

function transcriptFailure(result) {
  const needsBilibiliAccess = Boolean(embeddedSafariContext && currentVideoId?.startsWith("bili:") &&
    result?.error === "Load failed");
  return {
    missing: !currentTranscript,
    needsBilibiliAccess,
    settings: ["NO_SUPADATA_KEY", "INVALID_SUPADATA_KEY"].includes(result?.error),
    message: needsBilibiliAccess
      ? "Safari 未能连接哔哩哔哩的字幕服务。请允许访问字幕接口和下载服务器后重试。"
      : localizeError(result?.message || result?.error || "没有读到字幕。"),
  };
}

function coverageForDigest(digest) {
  const duration = digest.videoInfo?.duration || currentVideoDuration || digest.videoDuration ||
    digest.transcriptCoverage?.duration;
  return YTD_SETTINGS.transcriptCoverage(digest.transcript, duration);
}

function displayDigest(digest) {
  if (digest.videoInfo) applyVideoInfo(digest.videoInfo, currentVideoTitle);
  if (!currentVideoDuration && digest.videoDuration > 0) currentVideoDuration = digest.videoDuration;
  currentTranscriptCoverage = coverageForDigest(digest);
  transcriptAcquisition = null;
  const overviewCoverage = document.getElementById("overviewCoverage");
  const warning = describeTranscriptCoverage(currentTranscriptCoverage);
  overviewCoverage.hidden = !warning;
  overviewCoverage.textContent = warning ? "概览仅基于已取得的字幕。" + warning : "";
  currentTranscript = digest.transcript;
  currentTranscriptText = digest.transcriptText;
  currentTranscriptTimestamped = getTimestampedTranscript(digest);
  currentTranscriptLanguage = digest.language || digest.transcriptLanguage || null;
  for (const [key, value] of Object.entries(digest.paragraphCache || {})) {
    transcriptParagraphCache.set(key, value);
  }
  for (const [key, value] of Object.entries(digest.interfaceCache || {})) {
    interfaceTranslationCache.set(key, value);
  }
  renderTranscript();
  if (hasOverviewContent(digest.analysis)) {
    currentAnalysis = digest.analysis;
    renderAnalysisResults(currentAnalysis);
  } else if (digest.analysis) {
    renderOverviewStatus({ error: localizeError("EMPTY_OVERVIEW"), canRetry: true });
  }
  showState("results");
  restorePendingTranscriptViewState(currentVideoId);
  void loadNotes(currentVideoId);
  setupExplainFeature();
  if (currentTranscriptMode !== "original") void translateTranscript();
}

async function requestTranscriptReplacement(method) {
  if (!currentVideoId || digestRequest) return;
  const request = { videoId: currentVideoId, tabId: videoTabId };
  const needsBilibiliAccess = method === "web" && transcriptAcquisition?.needsBilibiliAccess;
  digestRequest = request;
  transcriptAcquisition = {
    missing: !currentTranscript,
    busy: true,
    message: method === "web" ? "正在重新读取网页字幕…" : "正在等待 Supadata 返回字幕…",
  };
  renderTranscriptAcquisition();

  try {
    if (needsBilibiliAccess) {
      const granted = await chrome.permissions.request(bilibiliSubtitleAccess);
      if (digestRequest !== request) return;
      if (!granted) {
        transcriptAcquisition = {
          missing: !currentTranscript,
          needsBilibiliAccess: true,
          message: "读取 B 站字幕需要访问哔哩哔哩的字幕接口和下载服务器。",
        };
        return;
      }
    }
    const result = await fetchTranscriptForVideo(request, method);
    if (digestRequest !== request) return;
    if (!result?.success) {
      transcriptAcquisition = transcriptFailure(result);
      return;
    }

    const coverage = coverageForDigest(result);
    if (currentTranscriptCoverage && coverage.status !== "covered" &&
        YTD_SETTINGS.transcriptCoverageLength(coverage) <=
          YTD_SETTINGS.transcriptCoverageLength(currentTranscriptCoverage)) {
      transcriptAcquisition = { message: "这次取到的字幕范围没有扩大，已保留原有字幕。" };
      return;
    }

    overviewRequest = null;
    currentAnalysis = null;
    translationGeneration += 1;
    transcriptScrollObserver?.disconnect();
    transcriptScrollObserver = null;
    for (const cache of [transcriptParagraphCache, interfaceTranslationCache]) {
      for (const key of cache.keys()) {
        if (key.startsWith(request.videoId + ":")) cache.delete(key);
      }
    }
    interfaceTranslationFailures.clear();
    interfaceTranslationInFlight.clear();
    renderOverviewStatus();
    displayDigest(result);
    document.getElementById("supadataChoices").open = false;
    document.querySelector('.tab[data-tab="transcript"]')?.focus();
    await saveToCache(request.videoId);
  } catch (error) {
    if (digestRequest !== request) return;
    transcriptAcquisition = { missing: !currentTranscript, needsBilibiliAccess, message: "字幕请求失败。请重试。" };
  } finally {
    if (digestRequest === request) {
      digestRequest = null;
      renderTranscriptAcquisition();
    }
  }
}

function getTimestampedTranscript(digest) {
  return digest.transcriptTimestamped ||
    YTD_SETTINGS.formatTimestampedTranscript(digest.transcript);
}

function applyVideoInfo(info, fallbackTitle) {
  currentVideoTitle = info?.title || fallbackTitle || "";
  currentChannelName = info?.channelName || "";
  currentVideoDescription = info?.description || "";
  currentVideoDuration = Number.isFinite(info?.duration) ? info.duration : 0;
  document.getElementById("videoTitle").textContent = currentVideoTitle;
  document.getElementById("videoChannel").textContent = currentChannelName;
  document.getElementById("videoInfo").style.display = currentVideoTitle || currentChannelName ? "block" : "none";
}

// ============================================================
// RENDERING
// ============================================================

function interfaceTranslationCacheKey(surface, id, text) {
  return `${currentVideoId || "none"}:zh:${surface}:${id}:${text}`;
}

function getInterfaceTranslation(surface, id, text) {
  return interfaceTranslationCache.get(
    interfaceTranslationCacheKey(surface, id, text),
  );
}

function renderLocalizedContent(text, surface, id) {
  const original = String(text || "");
  if (!original) return "";
  const cacheKey = interfaceTranslationCacheKey(surface, id, original);
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "original") return escapeHtml(original);

  const translation = translated
    ? escapeHtml(translated)
    : interfaceTranslationFailures.has(cacheKey)
      ? '<span class="translation-error">暂无法提供翻译。</span>'
      : '<span class="translation-pending">正在翻译…</span>';
  if (currentTranscriptMode === "bilingual") {
    return `<span class="localized-copy"><span class="localized-original">${escapeHtml(original)}</span><span class="localized-translation">${translation}</span></span>`;
  }
  return `<span class="localized-copy"><span class="localized-translation">${translation}</span></span>`;
}

function getLocalizedPlainText(text, surface, id) {
  const original = String(text || "");
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "zh") return translated || original;
  if (currentTranscriptMode === "bilingual" && translated) {
    return `${original}\n\n${translated}`;
  }
  return original;
}

async function translateInterfaceSegments(surface, segments, rerender) {
  if (currentTranscriptMode === "original" || !segments.length) return;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const missing = segments
    .filter((segment) => segment.text)
    .map((segment) => ({
      ...segment,
      cacheKey: interfaceTranslationCacheKey(
        surface,
        segment.id,
        segment.text,
      ),
    }))
    .filter(
      (segment) =>
        !interfaceTranslationCache.has(segment.cacheKey) &&
        !interfaceTranslationFailures.has(segment.cacheKey) &&
        !interfaceTranslationInFlight.has(segment.cacheKey),
    );
  if (!missing.length) return;

  missing.forEach((segment) => interfaceTranslationInFlight.add(segment.cacheKey));
  setTranslatingSpinner(true);
  try {
    for (
      let start = 0;
      start < missing.length;
      start += TRANSLATION_BATCH_SIZE
    ) {
      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result;
      try {
        result = await sendTranslationMessage({
          action: "translateContent",
          content: {
            segments: batch.map(({ id, text }) => ({ id, text })),
          },
          contentType: "interfaceBatch",
          targetLanguage: "zh",
          videoTitle: currentVideoTitle,
        });
      } catch (error) {
        console.error("[YouTube Digest] Interface batch error:", error);
        result = { success: false, error: error.message };
      }
      if (
        generation !== translationGeneration ||
        videoId !== currentVideoId ||
        currentTranscriptMode === "original"
      ) {
        return;
      }
      const aligned = alignTranslatedSegmentBatch(
        batch,
        result?.success ? result.translatedContent?.segments : [],
      );
      aligned.forEach((item, index) => {
        if (item.text) {
          interfaceTranslationCache.set(batch[index].cacheKey, item.text);
        } else {
          interfaceTranslationFailures.add(batch[index].cacheKey);
        }
      });
      // Match the Transcript UX: reveal and persist every small batch as soon
      // as it returns instead of waiting for the full Overview or Notes list.
      rerender();
      await updateCache();
    }
  } catch (error) {
    console.error("[YouTube Digest] Interface translation error:", error);
    missing.forEach((segment) =>
      interfaceTranslationFailures.add(segment.cacheKey),
    );
  } finally {
    missing.forEach((segment) => interfaceTranslationInFlight.delete(segment.cacheKey));
    setTranslatingSpinner(false);
  }
}

function getOverviewTranslationSegments() {
  if (!currentAnalysis) return [];
  const segments = [];
  (currentAnalysis.chapters || []).forEach((chapter, index) => {
    if (chapter.title) {
      segments.push({ id: `chapter-${index}-title`, text: chapter.title });
    }
    if (chapter.summary) {
      segments.push({ id: `chapter-${index}-summary`, text: chapter.summary });
    }
  });
  [...(currentAnalysis.keyQuotes || [])]
    .sort((a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0))
    .forEach((quote, index) => {
      if (quote.quote) segments.push({ id: `quote-${index}`, text: quote.quote });
    });
  return segments;
}

function translateOverviewContent() {
  return translateInterfaceSegments(
    "overview",
    getOverviewTranslationSegments(),
    () => {
      const contentArea = document.getElementById("contentArea");
      const scrollTop = contentArea?.scrollTop || 0;
      renderAnalysisResults(currentAnalysis);
      if (contentArea) contentArea.scrollTop = scrollTop;
    },
  );
}

function getNoteTranslationId(note, index) {
  const stablePart = String(note.id || note.createdAt || index)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `note-${stablePart || index}`;
}

function translateNotesContent() {
  const segments = currentNotes.map((note, index) => ({
    id: getNoteTranslationId(note, index),
    text: note.text || "",
  }));
  return translateInterfaceSegments("notes", segments, () => {
    const contentArea = document.getElementById("contentArea");
    const scrollTop = contentArea?.scrollTop || 0;
    renderNotes(currentNotes, currentNotesFilterVideoId);
    if (contentArea) contentArea.scrollTop = scrollTop;
  });
}

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function hasOverviewContent(analysis) {
  return Boolean(analysis?.chapters?.length || analysis?.keyQuotes?.length);
}

function renderOverviewStatus({ loading = false, error = "", canRetry = false } = {}) {
  overviewError = error;
  document.getElementById("overviewLoading").hidden = !loading;
  document.getElementById("overviewError").textContent = error;
  document.getElementById("overviewRetry").hidden = !canRetry;
  document.getElementById("overviewResults").hidden = !currentAnalysis;
}

function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  document.getElementById("chaptersEmpty").hidden = Boolean(analysis.chapters?.length);
  (analysis.chapters || []).forEach((chapter, index) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${renderLocalizedContent(chapter.title, "overview", `chapter-${index}-title`)}</span>
        <span class="chapter-summary">${renderLocalizedContent(chapter.summary || "", "overview", `chapter-${index}-summary`)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  document.getElementById("quotesEmpty").hidden = sortedQuotes.length > 0;
  sortedQuotes.forEach((quote, index) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${renderLocalizedContent(quote.quote, "overview", `quote-${index}`)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="将这条引用保存为笔记">笔记</button>
          <button class="quote-copy-btn" title="复制这条引用">复制</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const text = getLocalizedPlainText(quote.quote, "overview", `quote-${index}`);
      if (!await copyToClipboard(text)) return;
      quoteCopyBtn.textContent = "已复制";
      setTimeout(() => {
        quoteCopyBtn.textContent = "复制";
      }, 1500);
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });

  renderOverviewStatus();

  if (
    currentTranscriptMode !== "original" &&
    resultTabIsActive("overview")
  ) {
    void translateOverviewContent();
  }
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "正在保存…";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "已保存";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "错误";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "错误";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (!event.target.closest(".transcript-time") && hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  void seekTo(getTranscriptCueTime(event.target, seconds));
}

function getTranscriptCueTime(element, fallback) {
  const seconds = Number(element?.closest("[data-cue-start]")?.dataset.cueStart);
  return Number.isFinite(seconds) ? seconds : fallback;
}

function renderTranscriptTimestamp(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  const timestamp = `${minutes}:${String(remainder).padStart(2, "0")}`;
  return `<button class="transcript-time" type="button" aria-label="从 ${timestamp} 开始播放">${timestamp}</button>`;
}

function renderTranscriptSource(segment) {
  if (!segment.cues) return renderSubtitleInlineMarkup(segment.text);
  return segment.cues.map(({ start, text }) =>
    `<span class="transcript-cue" data-cue-start="${start}">${renderSubtitleInlineMarkup(text)}</span>`,
  ).join(" ");
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const rows = getOriginalTranscriptRows(currentTranscript, currentVideoId);

  rows.forEach((row) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = row.start;

    div.innerHTML = `
      ${renderTranscriptTimestamp(row.start)}
      <span class="transcript-text">${renderTranscriptSource(row)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, row.start),
    );
    transcriptList.appendChild(div);
  });

  // Reapply an active query after a language mode rerenders the transcript.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function getOriginalTranscriptRows(entries, videoId) {
  if (!videoId?.startsWith("bili:")) return groupTranscriptEntries(entries);

  const rows = [];
  const limits = BILIBILI_READING_LIMITS;
  let row;
  let previous;

  for (const entry of entries) {
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    const start = Number(entry?.start);
    if (!text || !Number.isFinite(start) || start < 0) continue;

    const duration = Number(entry.duration);
    const end = start + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    if (row) {
      const followsPause = previous.end > previous.start && start - previous.end >= limits.pauseSeconds;
      const followsSentence = start - row.start >= limits.sentenceSeconds &&
        /[.!?。！？]["')\]”’）】」』]*$/.test(previous.text);
      if (followsPause || followsSentence || end - row.start > limits.maxSeconds ||
          row.text.length + 1 + text.length > limits.maxChars) {
        row = null;
      }
    }

    if (!row) {
      row = { start, text: "", cues: [] };
      rows.push(row);
    }
    row.text = row.text ? `${row.text} ${text}` : text;
    row.cues.push({ start, text });
    previous = { start, end, text };
  }
  return rows;
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Finds separate, case-insensitive literal matches. A literal search is
 * important here because punctuation such as "." must be treated as transcript
 * text, not as a regular expression command.
 */
function findLiteralTranscriptMatches(text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return [];

  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedNeedle, "giu");
  const matches = [];
  for (const match of source.matchAll(matcher)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/**
 * Removes old marks before a new search. Restoring plain text first prevents
 * nested marks when the user types one more letter into the search field.
 */
function clearTranscriptSearchHighlights() {
  document
    .querySelectorAll("#transcriptList mark.transcript-search-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });

  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));
}

/**
 * Replaces matching parts of one text node with mark elements. We collect all
 * text nodes before changing the DOM, so each replacement is safe and stable.
 */
function markTranscriptTextNode(textNode, query) {
  const ranges = findLiteralTranscriptMatches(textNode.nodeValue, query);
  if (!ranges.length) return [];

  const fragment = document.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  ranges.forEach(({ start, end }) => {
    if (start > cursor) {
      fragment.appendChild(
        document.createTextNode(textNode.nodeValue.slice(cursor, start)),
      );
    }

    const mark = document.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = textNode.nodeValue.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (cursor < textNode.nodeValue.length) {
    fragment.appendChild(
      document.createTextNode(textNode.nodeValue.slice(cursor)),
    );
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  return marks;
}

/**
 * Updates the result count and navigation buttons from the current search
 * state. The live output gives the same information to screen reader users.
 */
function updateTranscriptSearchControls(query) {
  const count = document.getElementById("transcriptSearchCount");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  const hasMatches = transcriptSearchMatches.length > 0;

  if (count) {
    count.textContent = !query
      ? ""
      : hasMatches
        ? `第 ${transcriptSearchIndex + 1} 条，共 ${transcriptSearchMatches.length} 条`
        : "未找到匹配结果";
  }
  if (previous) previous.disabled = !hasMatches;
  if (next) next.disabled = !hasMatches;
}

/**
 * Shows which match is current. Search navigation pauses automatic transcript
 * following, so playback cannot pull the user away from the result they found.
 */
function revealCurrentTranscriptSearchMatch({ scroll = true } = {}) {
  transcriptSearchMatches.forEach((mark) => mark.classList.remove("current"));
  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));

  const mark = transcriptSearchMatches[transcriptSearchIndex];
  if (!mark) return;

  mark.classList.add("current");
  mark.closest(".transcript-entry")?.classList.add("search-current");

  if (!scroll) return;
  if (autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Searches the transcript that is visible now. This means Original searches
 * source subtitles, Chinese searches translated text, and Bilingual searches
 * both columns. Translated rows call this again as their text arrives.
 */
function refreshTranscriptSearch({ preserveIndex = false, scroll = true } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const query = String(input?.value || "").trim();
  const previousIndex = transcriptSearchIndex;

  clearTranscriptSearchHighlights();
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
  if (clearButton) clearButton.hidden = !input?.value;

  if (!query) {
    updateTranscriptSearchControls(query);
    return;
  }

  document
    .querySelectorAll("#transcriptList .transcript-entry")
    .forEach((row) => {
      const content = row.querySelector(".transcript-text, .transcript-copy");
      if (!content) return;

      const textNodes = [];
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue || parent?.closest("button")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        transcriptSearchMatches.push(...markTranscriptTextNode(node, query));
      });
    });

  if (transcriptSearchMatches.length) {
    transcriptSearchIndex = preserveIndex
      ? Math.min(Math.max(previousIndex, 0), transcriptSearchMatches.length - 1)
      : 0;
    revealCurrentTranscriptSearchMatch({ scroll });
  }
  updateTranscriptSearchControls(query);
}

/**
 * Moves through results in a loop, like the browser's built-in Find control.
 */
function moveTranscriptSearch(direction) {
  if (!transcriptSearchMatches.length) return;
  transcriptSearchIndex =
    (transcriptSearchIndex + direction + transcriptSearchMatches.length) %
    transcriptSearchMatches.length;
  revealCurrentTranscriptSearchMatch();
  updateTranscriptSearchControls(
    document.getElementById("transcriptSearchInput")?.value.trim(),
  );
}

/**
 * Clears search when the user opens a different video. A query for the old
 * video is unlikely to help and can make the next transcript look empty.
 */
function resetTranscriptSearch({ focus = false } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  refreshTranscriptSearch({ scroll: false });
  if (focus) input?.focus();
}

/**
 * Wires mouse and keyboard controls once when the side panel starts.
 */
function setupTranscriptSearch() {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  if (!input) return;

  input.addEventListener("input", () => refreshTranscriptSearch());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      resetTranscriptSearch({ focus: true });
    }
  });

  clearButton?.addEventListener("click", () => {
    resetTranscriptSearch({ focus: true });
  });
  previous?.addEventListener("click", () => moveTranscriptSearch(-1));
  next?.addEventListener("click", () => moveTranscriptSearch(1));
}

function getDisplayedTranscriptText() {
  if (currentTranscriptMode === "original") {
    if (currentVideoId?.startsWith("bili:")) {
      return getOriginalTranscriptRows(currentTranscript || [], currentVideoId)
        .map(({ text }) => text)
        .join("\n");
    }
    return currentTranscriptText || "";
  }
  return getActiveTranscriptSegments()
    .map((segment) => {
      const translated = transcriptParagraphCache.get(
        transcriptTranslationCacheKey(segment),
      );
      const original = segment.displayText ?? segment.text;
      if (currentTranscriptMode === "zh") return translated || original;
      return translated ? `${original}\n${translated}` : original;
    })
    .join("\n\n");
}

function copyTranscript() {
  copyToClipboardWithFeedback(getDisplayedTranscriptText(), "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = getDisplayedTranscriptText();
  const videoUrl = currentVideoUrl;

  let exportText = "";
  exportText += `字幕\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `标题：${currentVideoTitle || "未知"}\n`;
  exportText += `频道：${currentChannelName || "未知"}\n`;
  exportText += `网址：${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `简介：\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `字幕：\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `由 YouTube Digest 导出\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-字幕.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
  document.getElementById("transcriptModeControl").style.display =
    state === "results" ? "inline-flex" : "none";

  renderTranscriptAcquisition(state === "results" || state === "transcriptFallback");
  if (state !== "results") {
    seekRequest += 1;
    document.getElementById("seekStatus").textContent = "";
    stopPlaybackTracking();
  }
}

function formatCoverageTime(seconds) {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  if (minutes < 60) return minutes + ":" + remainder;
  return Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0") + ":" + remainder;
}

function describeTranscriptCoverage(coverage) {
  if (!coverage || !["partial", "unknown"].includes(coverage.status)) return "";
  const range = formatCoverageTime(coverage.start) + "–" + formatCoverageTime(coverage.end);
  const end = coverage.duration ? "，视频全长 " + formatCoverageTime(coverage.duration) : "";
  const gap = coverage.gaps[0];
  const gapText = gap
    ? " " + formatCoverageTime(gap.start) + "–" + formatCoverageTime(gap.end) + " 未检测到字幕，可能没有对白。"
    : "";
  return "已取得字幕 " + range + end + "。全片字幕覆盖待确认。" + gapText;
}

function renderTranscriptAcquisition(active = panelIsShowingResults() || transcriptAcquisition?.missing) {
  const warning = describeTranscriptCoverage(currentTranscriptCoverage);
  const acquisition = transcriptAcquisition;
  const section = document.getElementById("transcriptAcquisition");
  section.hidden = !active || (currentTranscript && !resultTabIsActive("transcript")) ||
    !(warning || acquisition?.message);
  document.getElementById("transcriptCoverageStatus").textContent = section.hidden ? "" : warning;
  document.getElementById("transcriptRequestStatus").textContent = section.hidden ? "" : acquisition?.message || "";
  document.getElementById("supadataChoices").hidden = currentVideoId?.startsWith("bili:");
  document.getElementById("transcriptSettingsBtn").hidden = !acquisition?.settings;
  document.querySelectorAll("[data-transcript-method]").forEach((button) => {
    button.disabled = Boolean(acquisition?.busy);
    if (button.dataset.transcriptMethod === "web") {
      button.textContent = acquisition?.needsBilibiliAccess ? "授权并重试" : "重试读取网页字幕";
    }
  });
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

const ERROR_COPY = new Map([
  ["Unknown error", "未知错误"],
  ["NO_AI_KEY", "缺少 AI 服务的 API 密钥"],
  ["INVALID_AI_KEY", "AI 服务的 API 密钥无效"],
  ["RATE_LIMITED", "请求频率超限"],
  ["Supadata API key not configured. Open YouTube Digest Settings.", "尚未配置 Supadata API 密钥。请打开 YouTube Digest 设置。"],
  ["Your Supadata API key is invalid. Open YouTube Digest Settings.", "你的 Supadata API 密钥无效。请打开 YouTube Digest 设置。"],
  ["No native subtitle track is available for this video.", "此视频没有可用的原生字幕轨道。"],
  ["No subtitles found for this video.", "未找到此视频的字幕。"],
  ["Supadata rate limit reached. Please wait a minute and try again.", "已达到 Supadata 请求频率上限。请等一分钟再试。"],
  ["Supadata returned an empty transcript for this video.", "Supadata 为此视频返回了空字幕。"],
  ["Failed to fetch transcript", "获取字幕失败"],
  ["Transcript processing failed", "字幕处理失败"],
  ["Transcript processing timed out", "字幕处理超时"],
  ["Invalid YouTube video ID.", "YouTube 视频 ID 无效。"],
  ["DeepSeek API key not configured. Open YouTube Digest Settings.", "尚未配置 DeepSeek API 密钥。请打开 YouTube Digest 设置。"],
  ["DeepSeek API key not configured.", "尚未配置 DeepSeek API 密钥。"],
  ["DeepSeek API key not configured", "尚未配置 DeepSeek API 密钥"],
  ["DeepSeek rejected the API key.", "DeepSeek 拒绝了此 API 密钥。"],
  ["DeepSeek rate-limited this request. Try again shortly.", "此请求受到 DeepSeek 的频率限制。请稍后重试。"],
  ["Rate limited — try again in a moment", "请求频率超限，请稍后重试"],
  ["DeepSeek returned an empty response.", "DeepSeek 返回了空响应。"],
  ["EMPTY_OVERVIEW", "DeepSeek 没有返回可显示的章节或重点引用。"],
  ["DeepSeek response exceeded the 2 MiB limit.", "DeepSeek 响应超过了 2 MiB 上限。"],
  ["DeepSeek request was inactive for 50 seconds. Please Retry.", "DeepSeek 请求已连续 50 秒无响应。请重试。"],
  ["DeepSeek request exceeded the 120-second limit. Please Retry.", "DeepSeek 请求超过了 120 秒上限。请重试。"],
  ["Failed to analyze transcript", "分析字幕失败"],
  ["Failed to explain selection", "讲解所选内容失败"],
  ["Translation request timed out after 130 seconds. Please Retry.", "翻译请求在 130 秒后超时。请重试。"],
  ["Translation unavailable.", "暂无法提供翻译。"],
  ["Translation failed.", "翻译失败。"],
  ["Translation failed", "翻译失败"],
  ["Translation returned no valid Chinese segments", "翻译未返回有效的中文段落"],
  ["Missing or invalid Chinese translation", "缺少中文翻译或翻译无效"],
  ["Failed to fetch", "请求失败"],
]);

function localizeError(message) {
  const text = String(message || "");
  return (ERROR_COPY.get(text) ?? text)
    .replace(/^Supadata API error: (\d{3})$/, "Supadata API 错误：$1")
    .replace(/^DeepSeek error: (\d{3})$/, "DeepSeek 错误：$1")
    .replace(/^Job polling failed: (\d{3})$/, "查询字幕任务进度失败：$1")
    .replace(/^Could not load prompt file: (.+)$/, "无法加载提示词文件：$1")
    .replace(/^Prompt section not found: (.+)$/, "未找到提示词章节：$1")
    .replace(/^Unsupported translation target: (.+)$/, "不支持的翻译目标语言：$1")
    .replace(/^Unsupported translation content type: (.+)$/, "不支持翻译此内容类型：$1");
}

function showError(title, message) {
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "重试";
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  // Capture the transcript position before another tab reuses the same scroll
  // area. Scrolling Overview or Notes must not replace this value.
  if (tabName !== "transcript" && transcriptTabIsActive()) {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  renderTranscriptAcquisition();

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    // Notes always opens at the top, so restore the independent transcript
    // reading position when the user returns here.
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (!contentArea || !transcriptTabIsActive()) return;
      lastAutoScrollTime = Date.now();
      contentArea.scrollTop = lastTranscriptScrollTop;
    });
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Saved notes are stored newest first. Open Notes at the top so the note the
  // user just created is the first item they see.
  if (tabName === "notes") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      const notesPanelIsActive = document.querySelector(
        '.tab-panel[data-panel="notes"].active',
      );
      if (contentArea && notesPanelIsActive) contentArea.scrollTop = 0;
    });
  }

  // Translate only the visible tab. This prevents hidden surfaces from using
  // tokens or competing with the batch queue the user is waiting for.
  if (tabName === "overview") {
    if (!currentAnalysis && !overviewRequest && !overviewError) {
      void triggerAnalysis();
    } else if (currentAnalysis && currentTranscriptMode !== "original") {
      void translateOverviewContent();
    }
  } else if (
    tabName === "notes" &&
    currentTranscriptMode !== "original"
  ) {
    void translateNotesContent();
  } else if (
    tabName === "transcript" &&
    currentTranscriptMode !== "original" &&
    !transcriptScrollObserver
  ) {
    void translateTranscript();
  }
}

/**
 * Generates the overview after the user opens its tab or requests a retry.
 */
async function triggerAnalysis() {
  if (overviewRequest || currentAnalysis) return;
  if (!currentTranscriptTimestamped) {
    renderOverviewStatus({ error: "字幕缺少时间戳，无法生成概览。" });
    return;
  }

  const request = { videoId: currentVideoId };
  overviewRequest = request;
  renderOverviewStatus({ loading: true });

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentTranscriptCoverage?.status === "covered"
        ? currentVideoDuration : Number(currentTranscriptCoverage?.end) || 0,
      partialTranscript: currentTranscriptCoverage?.status !== "covered",
    });

    if (overviewRequest !== request) return;
    if (!analysisResult?.success || !hasOverviewContent(analysisResult.analysis)) {
      const error = analysisResult?.message || analysisResult?.error || "EMPTY_OVERVIEW";
      renderOverviewStatus({ error: localizeError(error), canRetry: true });
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);

    // Save to cache now that we have analysis
    await saveToCache(request.videoId);
  } catch (error) {
    if (overviewRequest !== request) return;
    console.error("[YouTube Digest Panel] Analysis error:", error);
    renderOverviewStatus({ error: localizeError(error.message), canRetry: true });
  } finally {
    if (overviewRequest === request) overviewRequest = null;
  }
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  const target = Number(seconds);
  if (seconds == null || !Number.isFinite(target)) return;
  const request = ++seekRequest;
  const status = document.getElementById("seekStatus");
  status.textContent = "";
  if (embeddedSafariContext?.readingLayout) {
    window.parent.postMessage({ action: "seekSafariDigest", videoId: currentVideoId, seconds: target, request }, "*");
    return;
  }
  try {
    const result = await relayToVideo({ action: "seekTo", seconds: target });
    if (request !== seekRequest || result?.response?.success) return;
    status.textContent = result?.response?.error || result?.error || "无法跳转。请刷新视频页面后重试。";
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
    if (request === seekRequest) status.textContent = "无法跳转。请刷新视频页面后重试。";
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
async function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    return seekTo(note.timestampSeconds);
  }
  if (!embeddedSafariContext) return chrome.tabs.create({ url: note.timestampedUrl });
  const result = await chrome.runtime.sendMessage({
    action: "openSafariVideoAtTimestamp",
    videoId: note.videoId,
    seconds: note.timestampSeconds,
  }).catch(() => null);
  if (!result?.success) document.getElementById("seekStatus").textContent = "无法打开这条笔记对应的视频。";
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    if (embeddedSafariContext) {
      const field = document.createElement("textarea");
      field.value = text;
      field.style.cssText = "position:fixed;inline-size:1px;opacity:0;pointer-events:none";
      field.readOnly = true;
      document.body.append(field);
      field.select();
      try {
        if (document.execCommand("copy")) return true;
      } catch (fallbackError) {
        debugLog("Safari clipboard fallback failed:", fallbackError);
      } finally {
        field.remove();
      }
    }
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  } else if (embeddedSafariContext) {
    document.getElementById("seekStatus").textContent = "复制失败。请长按选择要复制的文字。";
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  if (embeddedSafariContext) document.body.append(a);
  a.click();
  if (embeddedSafariContext) {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } else {
    URL.revokeObjectURL(url);
  }
}

function sanitizeFilename(str) {
  const title = (str || "").normalize().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-")
    .replace(/^-+/, "");
  return [...title].slice(0, 50).join("").replace(/-+$/, "") || "未命名视频";
}

// ============================================================
// TEXT SELECTION ACTIONS
// ============================================================

/**
 * Hides actions that belong only to a live transcript selection. Clearing the
 * browser range also prevents the toolbar from returning on another tab.
 */
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

/**
 * Sets up text selection handling in the transcript.
 * When the user selects text, shows Explain and Note actions.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // This setup can run again after a cached transcript render. Abort old
  // document listeners so one selection creates only one action toolbar.
  selectionActionsController?.abort();
  selectionActionsController = new AbortController();
  const selectionSignal = selectionActionsController.signal;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create one small toolbar for actions on the selected transcript text.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.setAttribute("role", "toolbar");
  tooltip.setAttribute("aria-label", "所选字幕的操作");
  tooltip.innerHTML = `
    <button class="explain-btn" type="button">讲解</button>
    <button class="selection-note-btn" type="button">笔记</button>
  `;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";
  let selectedTimestamp = 0;

  // Interacting with either action must preserve the transcript selection and
  // stay isolated from document and row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener(
    embeddedSafariContext ? "selectionchange" : "mouseup",
    () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

      // Both ends must be inside the transcript. The first selected row
      // supplies the timestamp when the selection spans more than one row.
      const isInTranscript = Boolean(
        range &&
          transcriptList.contains(range.startContainer) &&
          transcriptList.contains(range.endContainer),
      );

      // Allow any selection length.
      if (text.length > 0 && isInTranscript) {
        selectedText = text;
        const startElement =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement;
        const selectedRow = startElement?.closest(".transcript-entry");
        const rowSeconds = Number(selectedRow?.dataset.seconds);
        selectedTimestamp = getTranscriptCueTime(startElement, Number.isFinite(rowSeconds) ? rowSeconds : 0);

        const rect = range.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        if (embeddedSafariContext) {
          tooltip.style.display = "flex";
          const margin = tooltip.offsetWidth / 2 + 8;
          const below = rect.bottom + 8;
          const top = below + tooltip.offsetHeight <= window.innerHeight - 8
            ? below
            : Math.max(8, rect.top - tooltip.offsetHeight - 8);
          tooltip.style.top = `${top}px`;
          tooltip.style.left = `${Math.min(window.innerWidth - margin, Math.max(margin, center))}px`;
        } else {
          // Chrome otherwise paints the toolbar at its default edge for one frame.
          tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
          tooltip.style.left = `${center}px`;
          tooltip.style.display = "flex";
        }
      } else {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Hide tooltip when clicking elsewhere
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!tooltip.contains(event.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });

  // Save the exact selected words at the first selected transcript row. This
  // action does not move playback and does not ask the AI to rewrite the text.
  tooltip
    .querySelector(".selection-note-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText || !currentVideoId) return;

      const button = event.currentTarget;
      const originalText = button.textContent;
      button.textContent = "正在保存…";
      button.disabled = true;

      try {
        const result = await chrome.runtime.sendMessage({
          action: "saveNote",
          videoId: currentVideoId,
          timestamp: selectedTimestamp,
          videoTitle: currentVideoTitle,
          channelName: currentChannelName,
          selectedText,
        });

        if (!result?.success) {
          throw new Error(result?.error || "Could not save note");
        }

        button.textContent = "已保存";
        loadNotes(currentVideoId);
        setTimeout(() => {
          tooltip.style.display = "none";
          button.textContent = originalText;
          button.disabled = false;
        }, 900);
      } catch (error) {
        console.error("[YouTube Digest] Save selected note error:", error);
        button.textContent = "错误";
        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
        }, 1500);
      }
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">讲解</div>
        <button class="explain-modal-close" id="closeExplain">关闭</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>正在分析…</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const explanationContent = modal.querySelector("#explanationContent");

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    if (result.success) {
      explanationContent.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      explanationContent.innerHTML = `<div class="explain-error">未能获取讲解：${escapeHtml(localizeError(result.error))}</div>`;
    }
  } catch (error) {
    explanationContent.innerHTML = `<div class="explain-error">错误：${escapeHtml(localizeError(error.message))}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }
    const interfaceCacheForVideo = {};
    for (const [key, value] of interfaceTranslationCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        interfaceCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptCoverage: currentTranscriptCoverage,
      videoInfo: {
        title: currentVideoTitle, channelName: currentChannelName,
        description: currentVideoDescription, duration: currentVideoDuration,
      },
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      interfaceCache: interfaceCacheForVideo,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached?.transcript?.length) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  const request = ++notesRequest;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success && request === notesRequest && (!videoId || videoId === currentVideoId)) {
      currentNotes = result.notes || [];
      currentNotesFilterVideoId = videoId;
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "此视频还没有笔记。将鼠标移到视频上，点击「笔记」即可保存。"
      : "还没有已保存的笔记。将鼠标移到视频上，点击「笔记」即可保存。";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note, index) => {
    const translationId = getNoteTranslationId(note, index);
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
      </div>
      <div class="note-text">${renderLocalizedContent(note.text, "notes", translationId)}</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">复制文本</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">复制时间戳</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">播放</button>
        <button class="note-delete" data-id="${escapeHtml(note.id)}" type="button" aria-label="删除笔记" title="删除笔记">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="m19 6-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            getLocalizedPlainText(note.text, "notes", translationId),
          );
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "已复制";
          setTimeout(() => {
            btn.textContent = "复制文本";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "已复制";
          setTimeout(() => {
            btn.textContent = "复制时间戳";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });

  if (currentTranscriptMode !== "original" && resultTabIsActive("notes")) {
    void translateNotesContent();
  }
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  const willRestoreReadingPosition =
    pendingTranscriptViewState?.videoId === currentVideoId;
  autoScrollEnabled = !willRestoreReadingPosition;
  document.getElementById("followPlaybackBtn").style.display =
    willRestoreReadingPosition ? "block" : "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  if (embeddedSafariContext?.readingLayout) {
    if (Number.isFinite(safariPlaybackPosition)) highlightActiveEntry(safariPlaybackPosition);
    return;
  }
  try {
    const videoId = currentVideoId;
    const result = await relayToVideo({ action: "getCurrentTime" });

    if (videoId !== currentVideoId || !result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = Number(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? Number(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  scheduleTranscriptViewStateSave();

  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

/**
 * Uses session storage when it is available. Local storage is a safe fallback
 * for older test or browser environments that do not expose session storage.
 */
function getTranscriptViewStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

/**
 * Reads one video's last visible transcript position.
 */
async function loadTranscriptViewState(videoId) {
  if (!videoId) return null;
  try {
    const result = await getTranscriptViewStateStorage().get(
      TRANSCRIPT_VIEW_STATE_KEY,
    );
    const state = result?.[TRANSCRIPT_VIEW_STATE_KEY]?.[videoId];
    const scrollTop = Number(state?.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return { videoId, scrollTop };
  } catch (error) {
    console.error("[YouTube Digest] Reading position load error:", error);
    return null;
  }
}

/**
 * Stores positions for a small recent set of videos. This prevents one value
 * from growing without a limit during a long Chrome session.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!videoId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    const storage = getTranscriptViewStateStorage();
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY] || {};
    states[videoId] = { scrollTop, updatedAt: Date.now() };

    const recentStates = Object.fromEntries(
      Object.entries(states)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  } catch (error) {
    console.error("[YouTube Digest] Reading position save error:", error);
  }
}

/**
 * Saves the visible position after scrolling stops. Capturing the video ID and
 * position now prevents a later video change from writing the wrong state.
 */
function scheduleTranscriptViewStateSave() {
  if (
    isRestoringTranscriptView ||
    !currentVideoId ||
    !transcriptTabIsActive()
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  const videoId = currentVideoId;
  const scrollTop = contentArea.scrollTop;
  lastTranscriptScrollTop = scrollTop;
  clearTimeout(transcriptViewStateSaveTimer);
  transcriptViewStateSaveTimer = setTimeout(() => {
    void saveTranscriptViewState(videoId, scrollTop);
  }, 150);
}

/**
 * Saves immediately before the panel closes.
 */
function saveCurrentTranscriptViewState() {
  clearTimeout(transcriptViewStateSaveTimer);
  const contentArea = document.getElementById("contentArea");
  if (!currentVideoId || !contentArea) return Promise.resolve();
  if (transcriptTabIsActive()) captureCurrentTranscriptScrollTop();
  return saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
}

/**
 * Returns true only while the Transcript tab is the visible results panel.
 */
function transcriptTabIsActive() {
  return resultTabIsActive("transcript");
}

function resultTabIsActive(tabName) {
  return Boolean(
    document.querySelector(
      `.tab-panel[data-panel="${CSS.escape(tabName)}"].active`,
    ),
  );
}

/**
 * Copies the shared scroll area's current value into transcript-only state.
 */
function captureCurrentTranscriptScrollTop() {
  const contentArea = document.getElementById("contentArea");
  if (contentArea) lastTranscriptScrollTop = contentArea.scrollTop;
}

/**
 * Restores the saved position after the transcript becomes visible. Follow
 * Playback stays paused, so the next timer tick cannot move the panel again.
 */
function restorePendingTranscriptViewState(videoId) {
  const state = pendingTranscriptViewState;
  pendingTranscriptViewState = null;
  const contentArea = document.getElementById("contentArea");
  if (!state || state.videoId !== videoId) {
    contentArea?.classList.remove("restoring-transcript-view");
    return;
  }

  requestAnimationFrame(() => {
    if (currentVideoId !== videoId || !contentArea) {
      contentArea?.classList.remove("restoring-transcript-view");
      return;
    }

    isRestoringTranscriptView = true;
    lastAutoScrollTime = Date.now();
    autoScrollEnabled = false;
    contentArea.scrollTop = state.scrollTop;
    lastTranscriptScrollTop = state.scrollTop;
    document.getElementById("followPlaybackBtn").style.display = "block";
    contentArea.classList.remove("restoring-transcript-view");
    requestAnimationFrame(() => {
      isRestoringTranscriptView = false;
    });
  });
}

// ============================================================
// UNIVERSAL DISPLAY LANGUAGE — Original / Chinese / aligned bilingual
// ============================================================

async function loadDisplayLanguageMode(videoId) {
  if (!videoId) {
    setTranscriptModeButtons("original");
    return "original";
  }
  try {
    const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
    const mode = stored?.[DISPLAY_LANGUAGE_MODE_KEY]?.[videoId]?.mode;
    currentTranscriptMode = DISPLAY_LANGUAGE_MODES.has(mode)
      ? mode
      : "original";
  } catch (error) {
    currentTranscriptMode = "original";
  }
  setTranscriptModeButtons(currentTranscriptMode);
  return currentTranscriptMode;
}

async function saveDisplayLanguageMode(videoId, mode) {
  if (!videoId || !DISPLAY_LANGUAGE_MODES.has(mode)) return;
  const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
  const modes = stored?.[DISPLAY_LANGUAGE_MODE_KEY] || {};
  modes[videoId] = { mode, updatedAt: Date.now() };
  const recentModes = Object.fromEntries(
    Object.entries(modes)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50),
  );
  await chrome.storage.local.set({
    [DISPLAY_LANGUAGE_MODE_KEY]: recentModes,
  });
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || [], TRANSCRIPT_SEGMENT_LIMITS, {
    preserveCueTimestamps: currentVideoId?.startsWith("bili:"),
  });
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleDisplayLanguageModeChange(mode) {
  if (!DISPLAY_LANGUAGE_MODES.has(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  await saveDisplayLanguageMode(currentVideoId, mode);
  if (mode !== "original") interfaceTranslationFailures.clear();
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  const activeTabName =
    document.querySelector(".tab.active")?.dataset.tab || "transcript";

  if (mode === "original") {
    renderTranscript();
    if (currentAnalysis) renderAnalysisResults(currentAnalysis);
    if (currentNotes.length) renderNotes(currentNotes, currentNotesFilterVideoId);
    return;
  }

  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  }
  if (currentNotes.length) {
    renderNotes(currentNotes, currentNotesFilterVideoId);
  }
  if (activeTabName === "overview" && currentAnalysis) {
    await translateOverviewContent();
  } else if (activeTabName === "notes" && currentNotes.length) {
    await translateNotesContent();
  } else if (activeTabName === "transcript") {
    await translateTranscript();
  }
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderTranscriptSource(segment);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(localizeError(error))}<button class="translation-retry-btn" type="button">重试</button>`;
  } else {
    translationHtml = "等待翻译…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    div.innerHTML = `
      ${renderTranscriptTimestamp(segment.start)}
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  // Bilingual mode can find source text before each translation arrives.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "正在重试…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, TRANSLATION_BATCH_SIZE);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < TRANSLATION_BATCH_SIZE) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  getOriginalTranscriptRows,
  getTimestampedTranscript,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  findLiteralTranscriptMatches,
  loadTranscriptViewState,
  saveTranscriptViewState,
  loadDisplayLanguageMode,
  saveDisplayLanguageMode,
  getNavigationUrl,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  sanitizeFilename,
};
