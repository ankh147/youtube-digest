const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);
const playerScript = fs.readFileSync(path.resolve(__dirname, "..", "lib/player.js"), "utf8");

class FakeElement {
  constructor({
    id = "",
    width = 100,
    height = 36,
    inMetadata = false,
    inPrimary = false,
  } = {}) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.inMetadata = inMetadata;
    this.inPrimary = inPrimary;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = {};
  }

  get firstChild() {
    return this.children[0] || null;
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }

  closest(selector) {
    if (selector === "ytd-watch-metadata" && this.inMetadata) return this;
    if (selector === "#primary" && this.inPrimary) return this;
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];

    for (const child of this.children) {
      if (
        selector === "#top-level-buttons-computed" &&
        child.id === selector.slice(1)
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }

    return matches;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }
}

function createHarness(url = "https://www.youtube.com/watch?v=demo123") {
  const actionRows = [];
  const fallbackRows = [];
  const elements = [];
  const documentListeners = {};
  const windowListeners = {};
  const messageListeners = [];
  const observers = [];
  const timers = new Map();
  let nextTimerId = 1;

  const document = {
    readyState: "loading",
    body: new FakeElement(),
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-watch-metadata #actions-inner") return actionRows;
      if (selector === "#ytd-digest-button") {
        return elements.filter(
          (element) => element.id === "ytd-digest-button" && element.isConnected,
        );
      }
      if (selector.includes("top-level-buttons-computed")) return fallbackRows;
      return [];
    },
    querySelector() {
      return null;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.isConnected);
    },
    createElement() {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
  };

  const context = vm.createContext({
    console,
    document,
    YTD_SETTINGS: require("../settings.js"),
    window: {
      location: new URL(url),
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
      getComputedStyle(element) {
        return {
          display: element.display || "flex",
          visibility: element.visibility || "visible",
        };
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        async sendMessage() {
          return { success: true };
        },
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(_target, options) {
        this.options = options;
      }
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
  });

  vm.runInContext(playerScript, context);
  vm.runInContext(contentScript, context);

  return {
    context,
    actionRows,
    fallbackRows,
    elements,
    documentListeners,
    messageListeners,
    windowListeners,
    observers,
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function createActionRow({ width, height }) {
  const row = new FakeElement({
    id: "actions-inner",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  const buttonGroup = new FakeElement({
    id: "top-level-buttons-computed",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  row.appendChild(buttonGroup);
  return { row, buttonGroup };
}

test("Digest button skips a hidden responsive toolbar", () => {
  const harness = createHarness();
  const { row: hiddenRow, buttonGroup: hiddenGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 389,
    height: 36,
  });
  const nativeButton = new FakeElement();
  visibleGroup.appendChild(nativeButton);
  harness.actionRows.push(hiddenRow, visibleRow);

  assert.equal(harness.context.findDigestButtonHost(), visibleGroup);
  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(hiddenGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(visibleGroup.children[1], nativeButton);
  assert.match(visibleGroup.children[0].style.cssText, /flex:\s*0 0 auto/);
  assert.match(visibleGroup.children[0].style.cssText, /width:\s*max-content/);
  assert.doesNotMatch(visibleGroup.children[0].style.cssText, /box-shadow/);
});

test("Digest button replaces stale instances and removes duplicates", () => {
  const harness = createHarness();
  const { row: staleRow, buttonGroup: staleGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  harness.actionRows.push(staleRow, visibleRow);

  const staleButton = new FakeElement();
  staleButton.id = "ytd-digest-button";
  const duplicateButton = new FakeElement();
  duplicateButton.id = "ytd-digest-button";
  harness.elements.push(staleButton, duplicateButton);
  staleGroup.appendChild(staleButton);
  staleGroup.appendChild(duplicateButton);

  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(staleGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children.length, 1);
  assert.notEqual(visibleGroup.children[0], staleButton);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(staleButton.isConnected, false);
  assert.equal(duplicateButton.isConnected, false);
});

test("resize reconciliation follows YouTube to the newly visible toolbar", () => {
  const harness = createHarness();
  const { row: firstRow, buttonGroup: firstGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: secondRow, buttonGroup: secondGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(firstRow, secondRow);

  harness.context.injectDigestButton();
  harness.context.setupDigestButtonResizeListener();
  firstRow.width = 0;
  firstRow.height = 0;
  firstGroup.width = 0;
  firstGroup.height = 0;
  secondRow.width = 389;
  secondRow.height = 36;
  secondGroup.width = 389;
  secondGroup.height = 36;

  harness.windowListeners.resize();
  harness.flushTimers();

  assert.equal(firstGroup.children.length, 0);
  assert.equal(secondRow.children.length, 1);
  assert.equal(secondGroup.children.length, 1);
  assert.equal(secondGroup.children[0].id, "ytd-digest-button");
});

test("DOM mutation reconciliation repairs a replaced toolbar", () => {
  const harness = createHarness();
  const { row: oldRow, buttonGroup: oldGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: newRow, buttonGroup: newGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(oldRow, newRow);

  harness.context.injectDigestButton();
  harness.context.setupButtonObserver();
  oldRow.width = 0;
  oldRow.height = 0;
  oldGroup.width = 0;
  oldGroup.height = 0;
  newRow.width = 500;
  newRow.height = 36;
  newGroup.width = 500;
  newGroup.height = 36;

  harness.observers[0].callback([]);
  harness.flushTimers();

  assert.equal(oldGroup.children.length, 0);
  assert.equal(newRow.children.length, 1);
  assert.equal(newGroup.children.length, 1);
});

test("YouTube waits for the watch page to match the current video before inserting buttons", () => {
  const { context, actionRows, documentListeners, observers, flushTimers } = createHarness();
  const { row, buttonGroup } = createActionRow({ width: 400, height: 36 });
  actionRows.push(row);
  const player = new FakeElement();
  let renderedVideoId = "previous123";
  const watch = { getAttribute: (name) => name === "video-id" ? renderedVideoId : null };
  context.document.querySelector = (selector) => {
    if (selector === "ytd-watch-flexy") return watch;
    if (selector.includes("#movie_player")) return player;
    return null;
  };

  documentListeners.DOMContentLoaded();

  assert.equal(buttonGroup.firstChild, null);
  assert.equal(player.firstChild, null);
  assert.ok(observers[0].options.attributeFilter?.includes("video-id"));

  renderedVideoId = "demo123";
  observers[0].callback([{ type: "attributes", attributeName: "video-id" }]);
  flushTimers();

  assert.equal(buttonGroup.firstChild.id, "ytd-digest-button");
  assert.equal(player.firstChild.id, "ytd-note-button");
});

test("Bilibili waits for hydration before inserting buttons into the toolbar and player", () => {
  const { context, documentListeners, observers, flushTimers } = createHarness(
    "https://www.bilibili.com/video/BV1bcx96aEkX/",
  );
  const toolbar = new FakeElement();
  const player = new FakeElement();
  const serverRenderedRoot = new FakeElement();
  let awaitingHydration = true;
  context.document.querySelector = (selector) => {
    if (selector === "#app[data-server-rendered]") return awaitingHydration ? serverRenderedRoot : null;
    if (selector.startsWith(".video-toolbar-left")) return toolbar;
    if (selector === "#bilibili-player .bpx-player-primary-area") return player;
    return null;
  };

  documentListeners.DOMContentLoaded();

  assert.equal(toolbar.children.length, 0);
  assert.equal(player.children.length, 0);
  assert.equal(player.style.position, undefined);
  assert.ok(observers[0].options.attributeFilter?.includes("data-server-rendered"));

  awaitingHydration = false;
  observers[0].callback([{ type: "attributes", attributeName: "data-server-rendered" }]);
  flushTimers();

  assert.equal(toolbar.firstChild.id, "ytd-digest-button");
  assert.equal(player.firstChild.id, "ytd-note-button");
});

test("X waits for the native action group instead of inserting into the post", () => {
  const postUrl = "https://x.com/SpaceX/status/1481651037291225113";
  const { context, documentListeners, observers, flushTimers } = createHarness(postUrl);
  const querySelectorAll = context.document.querySelectorAll;
  const article = new FakeElement();
  const actions = new FakeElement();
  const player = new FakeElement();
  article.querySelectorAll = () => [{ href: postUrl }];
  article.querySelector = (selector) => {
    if (selector === '[role="group"]') return article.children.includes(actions) ? actions : null;
    if (selector.includes('[data-testid="videoPlayer"]')) return player;
    return null;
  };
  context.document.querySelectorAll = (selector) => selector === "main article"
    ? [article]
    : querySelectorAll.call(context.document, selector);

  documentListeners.DOMContentLoaded();
  assert.equal(article.firstChild, null);

  article.appendChild(actions);
  observers[0].callback([{ type: "childList" }]);
  flushTimers();

  assert.deepEqual(article.children, [actions]);
  assert.equal(actions.firstChild.id, "ytd-digest-button");
});

test("X finds the opened post by its timestamp link and controls its video, not a reply", async () => {
  const postUrl = "https://x.com/SpaceX/status/1481651037291225113";
  const { context } = createHarness(postUrl);
  const querySelectorAll = context.document.querySelectorAll;
  const actions = new FakeElement();
  const video = { currentTime: 0, duration: 17, paused: false };
  const getArticle = (href, player) => ({
    querySelectorAll: () => [{ href, closest: () => ({ role: "link" }) }],
    querySelector: (selector) => selector === "video" ? player : actions,
  });
  const reply = getArticle("https://x.com/example/status/2222222222", { currentTime: 0 });
  context.document.querySelectorAll = (selector) => selector.includes("article")
    ? [reply, getArticle(postUrl, video)]
    : querySelectorAll.call(context.document, selector);

  assert.equal(context.injectDigestButton(), true);
  assert.equal(actions.firstChild.id, "ytd-digest-button");
  assert.equal((await context.YTD_PLAYER.seekToTimestamp(14)).success, true);
  assert.equal(video.currentTime, 14);
  assert.equal(reply.querySelector("video").currentTime, 0);
});

test("X on iPad identifies the main article by its mobile post links", async () => {
  const postId = "1481651037291225113";
  const { context } = createHarness(`https://x.com/SpaceX/status/${postId}`);
  const mainVideo = { currentTime: 0, duration: 20, paused: false };
  const replyVideo = { currentTime: 0, duration: 15, paused: false };
  const mobileArticle = (owner, id, video) => ({
    querySelectorAll: () => [{
      href: `https://m.x.com/${owner}/status/${id}?launch_app_store=true&ct=engagement_view_post`,
    }],
    querySelector: (selector) => selector === "video" ? video : null,
  });
  context.document.querySelectorAll = (selector) => selector === "main article" ? [
    mobileArticle("reply", "1234567890", replyVideo),
    mobileArticle("SpaceX", postId, mainVideo),
  ] : [];

  assert.equal((await context.YTD_PLAYER.seekToTimestamp(12)).success, true);
  assert.equal(mainVideo.currentTime, 12);
  assert.equal(replyVideo.currentTime, 0);
});

test("YouTube waits for the transcript button to render after expanding the description", async () => {
  const { context, flushTimers } = createHarness();
  let expanded = false;
  let visible = false;
  let transcriptOpen = false;
  let now = 0;
  context.Date = { now: () => now };

  const expand = { click: () => { expanded = true; } };
  const collapse = { click: () => { expanded = false; } };
  const expander = {
    contains: () => true,
    hasAttribute: () => expanded,
    querySelector: (selector) => selector === "#expand" ? expand : collapse,
  };
  const button = {
    getClientRects: () => !expanded || visible ? [{}] : [],
    click() {
      assert.ok(visible);
      transcriptOpen = true;
    },
  };
  const panel = {
    querySelector: () => ({ click: () => { transcriptOpen = false; } }),
  };
  const row = {
    closest: () => panel,
    getClientRects: () => [{}],
    querySelector: (selector) => ({ textContent: selector.includes("Timestamp") ? "0:02" : "Caption" }),
  };
  const metadata = {
    querySelector: (selector) => selector === "ytd-text-inline-expander" ? expander : button,
  };
  context.document.querySelector = (selector) => selector === "ytd-watch-metadata" ? metadata : null;
  context.document.querySelectorAll = (selector) =>
    transcriptOpen && selector.includes("transcript-segment-view-model") ? [row] : [];

  const result = context.YTD_PLAYER.readNativeTranscript(context.YTD_PLAYER.currentSource(), 10);
  assert.equal(expanded, true);
  assert.equal(transcriptOpen, false);
  visible = true;
  for (let tick = 0; tick < 3; tick += 1) {
    now += 200;
    flushTimers();
    await Promise.resolve();
  }
  const { entries } = await result;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].start, 2);
  assert.equal(entries[0].text, "Caption");
  assert.equal(transcriptOpen, false);
  assert.equal(expanded, false);
});

test("YouTube mobile reads available media captions without invoking desktop controls", async () => {
  const { context } = createHarness("https://m.youtube.com/watch?v=demo123");
  const track = {
    kind: "captions", language: "en", mode: "disabled",
    cues: [{ text: "Caption", startTime: 0, endTime: 8 }],
  };
  context.document.querySelector = (selector) => {
    if (selector === "ytm-slim-video-metadata-section-renderer") return {};
    return selector === "video.html5-main-video" ? { duration: 8, textTracks: [track] } : null;
  };
  context.YTD_SAFARI_PAGE = {
    waitForYouTubeClick() { assert.fail("The desktop transcript controls are absent on this layout"); },
  };
  const result = await context.YTD_PLAYER.readNativeTranscript(context.YTD_PLAYER.currentSource(), 8);
  assert.equal(result.success, true);
  assert.equal(result.entries[0].text, "Caption");
  assert.equal(track.mode, "disabled");
});

test("YouTube and Bilibili seek the current player and resume paused playback", async () => {
  for (const [url, videoSelector] of [
    ["https://www.youtube.com/watch?v=arj7oStGLkU", "video.html5-main-video"],
    ["https://www.bilibili.com/video/BV1dnuq6dEak/?p=2", ".bpx-player-video-wrap video"],
    ["https://m.bilibili.com/video/BV1dnuq6dEak/?p=2", ".m-video-player video"],
  ]) {
    const { context, messageListeners } = createHarness(url);
    const video = {
      currentTime: 0,
      duration: 73,
      paused: true,
      async play() { this.paused = false; },
    };
    const findVideo = (selector) => selector.split(", ").includes(videoSelector) ? video : null;
    context.document.querySelector = findVideo;
    vm.runInContext(playerScript, context);
    assert.equal(messageListeners.length, 2, "reconnecting must not add a duplicate listener");
    const videoId = context.YTD_PLAYER.currentSource().id;
    const seek = (seconds, id = videoId) => new Promise((resolve) => {
      messageListeners[0]({ action: "seekTo", videoId: id, seconds }, {}, resolve);
    });

    assert.equal((await seek(62.75)).success, true);
    assert.equal(video.currentTime, 62.75);
    assert.equal(video.paused, false);
    assert.equal((await seek(12, "another-video")).success, false);
    assert.equal(video.currentTime, 62.75);

    video.paused = true;
    video.play = async () => { throw new Error("Play blocked"); };
    const blocked = await seek(10);
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /请在网页播放器中点击播放/);
    assert.equal(video.currentTime, 10);

    if (context.YTD_PLAYER.currentSource().platform === "youtube") {
      context.document.querySelector = (selector) =>
        selector.includes(".ad-showing") ? {} : findVideo(selector);
      const duringAd = await seek(25);
      assert.equal(duringAd.success, false);
      assert.match(duringAd.error, /广告播放结束/);
      assert.equal(video.currentTime, 10);
    }
  }
});
