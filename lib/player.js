// Player messages can reconnect after an extension reload without reinjecting page buttons.
var YTD_PLAYER = globalThis.YTD_PLAYER || (() => {
  function currentSource() {
    return YTD_SETTINGS.videoFromUrl(window.location.href);
  }

  function findPostArticle(source) {
    return Array.from(document.querySelectorAll("main article")).find(
      (article) => Array.from(article.querySelectorAll('a[href*="/status/"]')).some(
        (link) => YTD_SETTINGS.videoFromUrl(link.href)?.id === source.id,
      ),
    );
  }

  function findPostPlayer(article) {
    return article?.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]') || null;
  }

  function findVideo(source = currentSource()) {
    if (!source) return null;
    if (source.platform === "youtube") return document.querySelector("video.html5-main-video");
    if (source.platform === "bilibili") {
      return document.querySelector("#bilibili-player video, .bpx-player-video-wrap video, .m-video-player video");
    }
    const article = findPostArticle(source);
    if (!article) return null;
    return article.querySelector("video");
  }

  function extractVideoInfo() {
    const source = currentSource();
    const player = findVideo(source);
    const duration = Number.isFinite(player?.duration) ? player.duration : 0;
    if (source?.platform === "x") {
      const article = findPostArticle(source);
      const description = article?.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || "";
      return {
        title: description.slice(0, 150) || document.title,
        channelName: article?.querySelector('[data-testid="User-Name"]')?.innerText?.split("\n")[0] || "",
        description,
        duration,
        hasVideo: Boolean(player || findPostPlayer(article)),
      };
    }
    if (source?.platform === "bilibili") {
      return {
        title: document.querySelector("h1.video-title, .video-title")?.textContent?.trim() || document.title,
        channelName: document.querySelector(".up-info-container .up-name, a.up-name")?.textContent?.trim() || "",
        description: document.querySelector("#v_desc, .basic-desc-info")?.textContent?.trim() || "",
        duration,
      };
    }

    // The video title is in an h1 element inside the #title container
    const titleElement = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
    );

    // The channel name is in the channel info section
    const channelElement = document.querySelector(
      "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
    );

    // Video description — YouTube has this in a few possible places
    const descriptionElement = document.querySelector(
      "#description-inner, " +
        "ytd-watch-metadata #description yt-attributed-string, " +
        "#description yt-formatted-string, " +
        "ytd-expander#description yt-attributed-string",
    );

    return {
      title: titleElement?.textContent?.trim() || "",
      channelName: channelElement?.textContent?.trim() || "",
      duration,
      description: descriptionElement?.textContent?.trim() || "",
    };
  }

  function isYouTubeAdPlaying() {
    return Boolean(document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting"));
  }

  async function seekToTimestamp(seconds, play = true) {
    const source = currentSource();
    if (source?.platform === "youtube" && isYouTubeAdPlaying()) {
      return { success: false, error: "广告播放结束后，再点字幕跳转。" };
    }
    const video = findVideo(source);
    if (!video && source?.platform === "bilibili" && window.location.hostname === "m.bilibili.com") {
      return { success: false, error: "当前页面没有网页播放器。可在 Safari 的页面菜单请求桌面网站后再点时间戳。" };
    }
    if (!video) return { success: false, error: "请先在网页播放器中打开视频，再点字幕跳转。" };
    if (!Number.isFinite(seconds) || seconds < 0) {
      return { success: false, error: "这个时间戳无效。" };
    }
    try {
      video.currentTime = Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds;
    } catch (error) {
      return { success: false, error: "播放器还不能跳转。请等视频加载后重试。" };
    }
    if (play && video.paused) {
      try {
        await video.play();
      } catch (error) {
        return { success: false, error: "已跳转。请在网页播放器中点击播放。" };
      }
    }
    return { success: true };
  }

  const youtubeRowSelector = "transcript-segment-view-model, ytd-transcript-segment-renderer";
  const youtubePanelSelector = "ytd-engagement-panel-section-list-renderer";
  const selectedTabSelector = '[role="tab"][aria-selected="true"]';
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isYouTubeTranscriptTab(tab) {
    return /^(转写文稿|transcript)$/i.test(tab?.ariaLabel || tab?.textContent.trim() || "");
  }

  function readYouTubeRows(rows) {
    return Array.from(rows).flatMap((row) => {
      const stamp = row.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp")
        ?.textContent.match(/\b(?:\d+:)?\d+:\d{2}\b/)?.[0];
      const text = row.querySelector(".ytAttributedStringHost, .segment-text")?.textContent?.trim();
      if (!stamp || !text) return [];
      const start = stamp.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
      return [{ start, duration: 0, text }];
    });
  }

  async function readYouTubeTranscript(source, duration) {
    const metadata = () => document.querySelector("ytd-watch-metadata");
    const initialRows = Array.from(document.querySelectorAll(youtubeRowSelector));
    const selectedTabs = [...document.querySelectorAll(youtubePanelSelector + " " + selectedTabSelector)];
    const alreadyOpen = initialRows.some((row) => row.getClientRects().length > 0) ||
      selectedTabs.some(isYouTubeTranscriptTab);
    let openedDescription;
    let openedTranscript = false;
    let entries = [];
    let observedCount = -1;
    let observedFirstRow;
    let renderedPanel;
    let changedAt = Date.now();

    try {
      if (!alreadyOpen) {
        const buttonDeadline = Date.now() + 9000;
        do {
          if (currentSource()?.id !== source.id) return null;
          const description = metadata();
          const button = description?.querySelector("ytd-video-description-transcript-section-renderer button");
          const expander = description?.querySelector("ytd-text-inline-expander");
          const expand = expander?.querySelector("#expand");
          const needsExpansion = expand && !expander.hasAttribute("is-expanded") &&
            (!button || expander.contains(button));
          if (!needsExpansion && button?.getClientRects().length) {
            button.click();
            openedTranscript = true;
            break;
          }
          if (needsExpansion && !openedDescription) {
            openedDescription = expander;
            expand.click();
          }
          await delay(200);
        } while (Date.now() < buttonDeadline);
        if (!openedTranscript) return null;
      }

      const deadline = Date.now() + 9000;
      do {
        if (currentSource()?.id !== source.id) return null;
        const watch = document.querySelector("ytd-watch-flexy[video-id]");
        const rows = Array.from(document.querySelectorAll(youtubeRowSelector))
          .filter((row) => row.getClientRects().length > 0);
        if (!watch || watch.getAttribute("video-id") === source.id) {
          if (rows.length !== observedCount || rows[0] !== observedFirstRow) {
            entries = readYouTubeRows(rows);
            observedCount = rows.length;
            observedFirstRow = rows[0];
            renderedPanel = rows[0]?.closest(youtubePanelSelector) || renderedPanel;
            changedAt = Date.now();
          }
          if (entries.length && Date.now() - changedAt >= 400 &&
              YTD_SETTINGS.transcriptCoverage(entries, duration).status !== "partial") break;
        }
        await delay(200);
      } while (Date.now() < deadline);
      return entries.length ? { entries, duration } : null;
    } finally {
      if (currentSource()?.id === source.id) {
        if (openedTranscript) {
          const expandedPanels = [...document.querySelectorAll(
            youtubePanelSelector + '[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
          )];
          const panel = renderedPanel || expandedPanels.find((item) =>
            item.getAttribute("target-id")?.includes("transcript") ||
            isYouTubeTranscriptTab(item.querySelector(selectedTabSelector)),
          );
          const previousTab = selectedTabs.find((tab) => panel?.contains(tab));
          if (previousTab) {
            if (previousTab.getAttribute("aria-selected") !== "true") previousTab.click();
          } else {
            panel?.querySelector(
              "#visibility-button button, button[aria-label='关闭转写文稿'], button[aria-label='Close transcript'], button[aria-label='关闭'], button[aria-label='Close']",
            )?.click();
          }
        }
        if (openedDescription?.hasAttribute("is-expanded")) openedDescription.querySelector("#collapse")?.click();
      }
    }
  }

  async function readTextTrackTranscript(source) {
    const enabled = new Set();
    const deadline = Date.now() + 6500;
    let best;
    try {
      do {
        if (currentSource()?.id !== source.id) return null;
        if (source.platform === "youtube" && isYouTubeAdPlaying()) {
          await delay(250);
          continue;
        }
        const video = findVideo(source);
        const tracks = [...(video?.textTracks || [])]
          .filter(({ kind }) => kind === "subtitles" || kind === "captions");
        const preferred = tracks.find(({ language }) => language === "en") ?? tracks[0];
        for (const track of preferred ? [preferred, ...tracks.filter((item) => item !== preferred)] : []) {
          if (track.mode === "disabled") {
            track.mode = "hidden";
            enabled.add(track);
          }
          const entries = Array.from(track.cues || []).flatMap((cue) => {
            const text = cue.getCueAsHTML?.().textContent?.trim() || cue.text?.trim();
            if (!text || !Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime)) return [];
            return [{ start: cue.startTime, duration: Math.max(0, cue.endTime - cue.startTime), text }];
          });
          if (!entries.length) continue;
          const coverage = YTD_SETTINGS.transcriptCoverage(entries, video.duration);
          const result = { entries, duration: video.duration, language: track.language, coverage };
          if (coverage.status === "covered") return result;
          if (!best || YTD_SETTINGS.transcriptCoverageLength(coverage) > YTD_SETTINGS.transcriptCoverageLength(best.coverage)) {
            best = result;
          }
        }
        await delay(250);
      } while (Date.now() < deadline);
      return best || null;
    } finally {
      for (const track of enabled) if (track.mode === "hidden") track.mode = "disabled";
    }
  }

  async function readNativeTranscript(source, duration) {
    const mobileYouTube = source.platform === "youtube" &&
      Boolean(document.querySelector("ytm-slim-video-metadata-section-renderer"));
    if (source.platform === "youtube" && !mobileYouTube && globalThis.YTD_SAFARI_PAGE) {
      await YTD_SAFARI_PAGE.waitForYouTubeClick(source.id);
    }
    if (currentSource()?.id !== source.id) return { success: false, error: "视频页面已切换。" };
    const native = source.platform === "x" || mobileYouTube
      ? await readTextTrackTranscript(source)
      : source.platform === "youtube" ? await readYouTubeTranscript(source, duration) : null;
    if (currentSource()?.id !== source.id) return { success: false, error: "视频页面已切换。" };
    if (native) return { success: true, ...native };
    if (mobileYouTube) {
      return {
        success: false,
        error: "没从 YouTube 手机版读到字幕。可在 Safari 的页面菜单选择「请求桌面网站」，再打开摘要重试。",
      };
    }
    return {
      success: false,
      error: source.platform === "x"
        ? "网页没有提供可读取的字幕。若视频尚未播放，请在播放器打开后重试。"
        : "没有从 YouTube 网页读到转写文稿。",
    };
  }

  function handlePlayerMessage(message, _sender, sendResponse) {
    if (message.action === "openSafariDigest" && globalThis.YTD_SAFARI_PAGE) {
      void YTD_SAFARI_PAGE.openPanel();
      sendResponse({ success: true });
      return false;
    }
    if (!["getVideoInfo", "getCurrentTime", "seekTo", "getNativeTranscript"].includes(message.action)) return false;
    const source = currentSource();
    if (message.videoId && source?.id !== message.videoId) {
      sendResponse({ success: false, error: "视频页面已切换。" });
      return false;
    }

    if (message.action === "getCurrentTime") {
      const video = findVideo(source);
      sendResponse({
        currentTime: video?.currentTime ?? 0,
        paused: video ? video.paused : true,
      });
      return false;
    }

    if (message.action === "getVideoInfo") {
      sendResponse(extractVideoInfo());
      return false;
    }

    if (message.action === "getNativeTranscript") {
      readNativeTranscript(source, message.duration)
        .then(sendResponse, () => sendResponse({ success: false, error: "无法读取网页字幕，请重试。" }));
      return true;
    }

    seekToTimestamp(message.seconds).then(sendResponse);
    return true;
  }

  globalThis.chrome?.runtime?.onMessage.addListener(handlePlayerMessage);

  return {
    currentSource,
    findPostArticle,
    findPostPlayer,
    findVideo,
    extractVideoInfo,
    readNativeTranscript,
    seekToTimestamp,
  };
})();
