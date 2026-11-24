/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
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
      if (url.hostname === "www.youtube.com") {
        const video = videoFromId(url.searchParams.get("v"));
        return video?.platform === "youtube" ? video : null;
      }
      if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) {
        const post = /^\/(?:[\w]+|i\/web)\/status\/(\d{1,20})(?:\/video\/1)?\/?$/.exec(url.pathname);
        return post ? videoFromId(`x:${post[1]}`) : null;
      }
      if (url.hostname === "www.bilibili.com") {
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
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
