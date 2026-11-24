(() => {
  const host = document.createElement("div");
  host.id = "ytd-safari-digest";

  const launcher = document.createElement("button");
  launcher.className = "ytd-safari-launcher";
  launcher.type = "button";
  launcher.textContent = "摘要";
  launcher.setAttribute("aria-label", "打开 YouTube Digest 摘要");
  launcher.setAttribute("aria-expanded", "false");

  const panel = document.createElement("aside");
  panel.id = "ytd-safari-panel";
  panel.className = "ytd-safari-panel";
  panel.setAttribute("aria-label", "YouTube Digest");
  panel.hidden = true;
  launcher.setAttribute("aria-controls", panel.id);
  const playbackStatus = document.createElement("p");
  playbackStatus.className = "ytd-safari-playback-status";
  playbackStatus.setAttribute("role", "status");
  playbackStatus.hidden = true;
  host.append(launcher, panel, playbackStatus);

  const readingLayout = Math.min(screen.width, screen.height) <= 600 && matchMedia("(pointer: coarse)").matches;
  host.toggleAttribute("data-reading", readingLayout);

  let source;
  let frame;
  let observedPlayer;
  let pendingOpen;
  let syncQueued = false;
  let youtubeClickReadyAt = 0;
  let lastXTimestampUrl = "";
  let timestampRestore;
  let playbackTimer;
  const playerResize = new ResizeObserver(updateDock);

  document.addEventListener("touchend", () => {
    if (source?.platform !== "youtube") return;
    // YouTube's Polymer controls cancel synthetic clicks for 2.5 seconds after touchend.
    // https://github.com/Polymer/polymer/blob/master/lib/utils/gestures.js
    youtubeClickReadyAt = performance.now() + 2600;
  }, { capture: true, passive: true });

  globalThis.YTD_SAFARI_PAGE = {
    openPanel,
    async waitForYouTubeClick(videoId) {
      while (YTD_PLAYER.currentSource()?.id === videoId && performance.now() < youtubeClickReadyAt) {
        await new Promise((resolve) => setTimeout(resolve, youtubeClickReadyAt - performance.now()));
      }
    },
  };

  function playerFor(videoSource) {
    if (videoSource?.platform === "youtube") return document.querySelector("#movie_player");
    if (videoSource?.platform === "bilibili") return document.querySelector("#bilibili-player, .bpx-player-container, .m-video-player");
    const article = videoSource && YTD_PLAYER.findPostArticle(videoSource);
    return article && (YTD_PLAYER.findPostPlayer(article) || article.querySelector("video"));
  }

  function updateDock() {
    const player = playerFor(source);
    const space = player ? document.documentElement.clientWidth - player.getBoundingClientRect().right : 0;
    host.toggleAttribute("data-docked", space >= 300);
    if (space >= 300) host.style.setProperty("--ytd-safari-dock", `${Math.min(space - 24, 470)}px`);
  }

  function hidePanel(restoreFocus = false) {
    pendingOpen = null;
    clearInterval(playbackTimer);
    playerResize.disconnect();
    observedPlayer = null;
    panel.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute("aria-expanded", "false");
    if (restoreFocus && host.isConnected) launcher.focus({ preventScroll: true });
  }

  function closePanel(restoreFocus = false) {
    hidePanel(restoreFocus);
    playbackStatus.hidden = true;
    frame?.remove();
    frame = null;
  }

  function restoreXTimestamp() {
    if (source?.platform !== "x" || location.href === lastXTimestampUrl) return;
    const offset = /^#digest-t=(\d{1,8})$/.exec(location.hash);
    const video = offset && YTD_PLAYER.findVideo(source);
    if (!video) return;
    const url = location.href;
    timestampRestore?.abort();
    const restore = new AbortController();
    timestampRestore = restore;
    const seek = () => {
      if (location.href !== url || YTD_PLAYER.findVideo(source) !== video) {
        restore.abort();
        if (location.href === url) lastXTimestampUrl = "";
        return;
      }
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || !Number.isFinite(video.duration)) return;
      const seconds = Math.min(Number(offset[1]), video.duration);
      const ranges = video.seekable;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= seconds && seconds <= ranges.end(i)) {
          restore.abort();
          if (seconds > 0) void YTD_PLAYER.seekToTimestamp(seconds, false);
          break;
        }
      }
    };
    lastXTimestampUrl = url;
    for (const event of ["canplay", "progress"]) {
      video.addEventListener(event, seek, { signal: restore.signal });
    }
    seek();
  }

  function syncPage() {
    syncQueued = false;
    const next = YTD_PLAYER.currentSource();
    if (next?.id !== source?.id) {
      closePanel();
      timestampRestore?.abort();
      source = next;
      lastXTimestampUrl = "";
    }
    restoreXTimestamp();

    const player = playerFor(source);
    if (!source || (source.platform === "x" && !player)) {
      if (frame || !panel.hidden) closePanel();
      host.remove();
      return;
    }
    if (!host.isConnected) document.body.append(host);
    if (panel.hidden || player === observedPlayer) return;
    playerResize.disconnect();
    observedPlayer = player;
    if (player) playerResize.observe(player);
    updateDock();
  }

  function scheduleSync() {
    if (syncQueued || document.hidden) return;
    syncQueued = true;
    requestAnimationFrame(syncPage);
  }

  async function openPanel() {
    syncPage();
    if (!source || !host.isConnected || !panel.hidden || pendingOpen) return;
    if (frame) {
      showPanel();
      return;
    }
    const requestedVideo = source.id;
    const request = {};
    pendingOpen = request;
    try {
      const context = await chrome.runtime.sendMessage({ action: "getSafariDigestTab", videoId: requestedVideo });
      if (pendingOpen !== request || YTD_PLAYER.currentSource()?.id !== requestedVideo) return;
      if (!Number.isInteger(context?.tabId)) throw new Error("无法连接当前视频页面。");
      const address = new URL(chrome.runtime.getURL("sidepanel.html"));
      address.searchParams.set("tab", String(context.tabId));
      address.searchParams.set("video", requestedVideo);
      if (readingLayout) address.searchParams.set("layout", "reading");
      frame = document.createElement("iframe");
      frame.src = address.href;
      frame.title = "YouTube Digest";
      frame.className = "ytd-safari-frame";
      frame.allow = "clipboard-write";
      panel.replaceChildren(frame);
      showPanel();
    } catch {
      if (pendingOpen === request) {
        launcher.textContent = "重试打开摘要";
      }
    } finally {
      if (pendingOpen === request) pendingOpen = null;
    }
  }

  function showPanel() {
    playbackStatus.hidden = true;
    launcher.hidden = true;
    launcher.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    syncPage();
    updateDock();
    if (readingLayout) {
      sendReadingPlaybackPosition();
      playbackTimer = setInterval(sendReadingPlaybackPosition, 500);
    }
  }

  function sendReadingPlaybackPosition() {
    if (document.hidden || !frame || !source || panel.hidden) return;
    const seconds = YTD_PLAYER.findVideo(source)?.currentTime;
    frame.contentWindow?.postMessage({ action: "safariDigestPlaybackPosition", videoId: source.id, seconds }, "*");
  }

  async function seekFromReadingPanel({ videoId, seconds, request }) {
    if (panel.hidden || videoId !== source?.id || videoId !== YTD_PLAYER.currentSource()?.id) return;
    const currentFrame = frame;
    const result = await YTD_PLAYER.seekToTimestamp(seconds, false);
    if (frame !== currentFrame || panel.hidden || videoId !== YTD_PLAYER.currentSource()?.id) return;
    if (!result.success) {
      currentFrame.contentWindow.postMessage({ action: "safariDigestSeekFailed", request, error: result.error }, "*");
      return;
    }
    hidePanel(true);
    const video = YTD_PLAYER.findVideo(source);
    video?.scrollIntoView({ block: "center", inline: "nearest" });
    if (!video?.paused) return;
    try {
      await video.play();
    } catch {
      if (frame !== currentFrame || !panel.hidden) return;
      playbackStatus.textContent = "已跳转，请点播放器播放。";
      playbackStatus.hidden = false;
      video.addEventListener("play", () => { playbackStatus.hidden = true; }, { once: true });
    }
  }

  launcher.addEventListener("click", () => void openPanel());
  window.addEventListener("message", (event) => {
    if (!event.isTrusted || !frame || event.source !== frame.contentWindow) return;
    if (readingLayout && event.data?.action === "seekSafariDigest") {
      void seekFromReadingPanel(event.data);
    } else if (event.data?.action === "closeSafariDigest") {
      launcher.textContent = "摘要";
      if (readingLayout) hidePanel(true);
      else closePanel(true);
    }
  });
  const pageObserver = new MutationObserver(scheduleSync);
  pageObserver.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", scheduleSync);
  for (const event of ["yt-navigate-finish", "popstate", "hashchange", "pageshow"]) {
    window.addEventListener(event, scheduleSync);
  }
  window.addEventListener("resize", () => {
    if (!panel.hidden) updateDock();
  });
  syncPage();
})();
