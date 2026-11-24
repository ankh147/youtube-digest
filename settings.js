/**
 * Shared, non-secret configuration and video helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and helpers only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: DEFAULTS.aiBaseUrl,
      aiModel: DEFAULTS.aiModel,
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl() {
    return `${DEFAULTS.aiBaseUrl}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  // Keep existing YouTube IDs so saved notes, cache and display modes remain usable.
  function videoFromId(id) {
    if (typeof id !== "string") return null;
    const post = /^x:(\d{1,20})$/.exec(id);
    if (post) return { id, platform: "x", postId: post[1], url: `https://x.com/i/status/${post[1]}` };

    const bili = /^bili:(BV[A-Za-z0-9]{10}):([1-9]\d{0,5})$/.exec(id);
    if (bili) {
      const [, bvid, part] = bili;
      const page = Number(part);
      const url = new URL(`https://www.bilibili.com/video/${bvid}`);
      if (page > 1) url.searchParams.set("p", part);
      return { id, platform: "bilibili", bvid, page, url: url.href };
    }

    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
    return { id, platform: "youtube", url: canonicalYouTubeUrl(id) };
  }

  function videoFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      if (url.hostname === "www.youtube.com" ||
          (url.hostname === "m.youtube.com" && url.pathname === "/watch")) {
        const video = videoFromId(url.searchParams.get("v"));
        return video?.platform === "youtube" ? video : null;
      }
      if (["x.com", "www.x.com", "m.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) {
        const post = /^\/(?:[\w]+|i\/web)\/status\/(\d{1,20})(?:\/video\/1)?\/?$/.exec(url.pathname);
        return post ? videoFromId(`x:${post[1]}`) : null;
      }
      if (url.hostname === "www.bilibili.com" || url.hostname === "m.bilibili.com") {
        const path = /^\/video\/(BV[A-Za-z0-9]{10})\/?$/.exec(url.pathname);
        const page = url.searchParams.get("p") || "1";
        return path ? videoFromId(`bili:${path[1]}:${page}`) : null;
      }
    } catch {
      // Tabs without a standard URL cannot host the panel.
    }
    return null;
  }

  function supportsPanel(value) {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" && url.hostname === "www.youtube.com") || Boolean(videoFromUrl(value));
    } catch {
      return false;
    }
  }

  function timestampUrl(video, seconds) {
    const url = new URL(video.url);
    const time = Math.max(0, Math.floor(seconds));
    if (video.platform === "x") url.hash = `digest-t=${time}`;
    else url.searchParams.set("t", video.platform === "youtube" ? `${time}s` : String(time));
    return url.href;
  }

  function formatTimestampedTranscript(entries = []) {
    return entries.map(({ start, text }) => {
      const seconds = Math.floor(start);
      const timestamp = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      return `[${timestamp}] ${text}`;
    }).join("\n");
  }

  function transcriptCoverage(entries, videoDuration) {
    const duration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 0;
    const ranges = entries.filter(({ start }) => Number.isFinite(start) && start >= 0)
      .map(({ start, duration }) => ({
        start,
        end: start + (Number.isFinite(duration) && duration > 0 ? duration : 0),
      }))
      .sort((a, b) => a.start - b.start);
    if (!ranges.length) return { status: "missing", duration, start: 0, end: 0, gaps: [] };

    const start = ranges[0].start;
    const edgeTolerance = Math.min(90, Math.max(18, duration * 0.02));
    const gapTolerance = Math.min(240, Math.max(35, duration * 0.035));
    const gaps = [];
    let end = ranges[0].end;
    for (const range of ranges.slice(1)) {
      if (range.start - end > gapTolerance) gaps.push({ start: end, end: range.start });
      end = Math.max(end, range.end);
    }

    const partial = start > edgeTolerance || gaps.length > 0 || (duration > 0 && duration - end > edgeTolerance);
    const status = partial ? "partial" : duration ? "covered" : "unknown";
    return { status, duration, start, end, gaps };
  }

  function transcriptCoverageLength({ start, end, gaps }) {
    return end - start - gaps.reduce((total, gap) => total + gap.end - gap.start, 0);
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
    videoFromId,
    videoFromUrl,
    supportsPanel,
    timestampUrl,
    formatTimestampedTranscript,
    transcriptCoverage,
    transcriptCoverageLength,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
