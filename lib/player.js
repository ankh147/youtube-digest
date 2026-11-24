// Player messages can reconnect after an extension reload without reinjecting page buttons.
var YTD_PLAYER = globalThis.YTD_PLAYER || (() => {
  function currentSource() {
    return YTD_SETTINGS.videoFromUrl(window.location.href);
  }

  function findPostArticle(source) {
    return Array.from(document.querySelectorAll('main article[data-testid="tweet"]')).find(
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
      return document.querySelector("#bilibili-player video, .bpx-player-video-wrap video");
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

  async function seekToTimestamp(seconds, play = true) {
    const source = currentSource();
    if (
      source?.platform === "youtube" &&
      document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting")
    ) {
      return { success: false, error: "广告播放结束后，再点字幕跳转。" };
    }
    const video = findVideo(source);
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

  function handlePlayerMessage(message, _sender, sendResponse) {
    if (!["getVideoInfo", "getCurrentTime", "seekTo"].includes(message.action)) return false;
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

    seekToTimestamp(message.seconds).then(sendResponse);
    return true;
  }

  chrome.runtime.onMessage.addListener(handlePlayerMessage);

  return { currentSource, findPostArticle, findPostPlayer, findVideo, extractVideoInfo, seekToTimestamp };
})();
