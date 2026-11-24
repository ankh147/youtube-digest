const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sessionStorage = {};
  const localStorage = {};
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      storage: {
        local: {
          get: async (key) => ({ [key]: localStorage[key] }),
          set: async (values) => Object.assign(localStorage, values),
        },
        session: {
          get: async (key) => ({ [key]: sessionStorage[key] }),
          set: async (values) => Object.assign(sessionStorage, values),
        },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: require("../settings.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  biliApi,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
  },
  tabs,
  scripting,
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings };
  const sessionStorage = {};
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    BILI_API: biliApi,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        session: {
          get: async (key) => ({ [key]: sessionStorage[key] }),
          set: async (values) => Object.assign(sessionStorage, values),
          remove: async (key) => { delete sessionStorage[key]; },
        },
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, localStorage[item]]));
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel,
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners, ...tabs },
      scripting,
    },
    YTD_SETTINGS: {
      ...require("../settings.js"),
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

test("YouTube and X try web subtitles without Supadata and paid modes require an explicit method", async () => {
  const calls = [];
  const { getTimestampedTranscript } = loadSidepanelHelpers();
  let tabUrl = "https://x.com/SpaceX/status/1234567890";
  const { handleFetchTranscript } = loadBackgroundHelpers({
    settings: { supadataApiKey: "test-key" },
    tabs: {
      get: async () => ({ url: tabUrl }),
      sendMessage: async (_tabId, message) => message.videoId.startsWith("x:")
        ? { success: false, error: "no track" }
        : { success: true, entries: [{ text: "网页字幕", start: 2 }] },
    },
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify({ content: [{ text: "Speech", offset: 9200 }], lang: "en" }));
    },
  });
  assert.equal((await handleFetchTranscript("x:1234567890", { tabId: 1 })).error, "no track");
  tabUrl = "https://www.youtube.com/watch?v=video123";
  const native = await handleFetchTranscript("video123", { tabId: 1 });
  assert.equal(getTimestampedTranscript(native), "[0:02] 网页字幕");
  assert.equal(calls.length, 0);
  assert.equal((await handleFetchTranscript("video123", { method: "auto" })).success, false);
  assert.equal((await handleFetchTranscript("bili:BV1DXKS6rEYq:2", { method: "generate" })).success, false);
  const [x, repeated] = await Promise.all([
    handleFetchTranscript("x:1234567890", { method: "generate" }),
    handleFetchTranscript("x:1234567890", { method: "generate" }),
  ]);
  assert.equal(x.transcript[0].start, 9.2);
  assert.equal(getTimestampedTranscript(x), "[0:09] Speech");
  assert.equal(repeated.transcriptTimestamped, x.transcriptTimestamped);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get("mode"), "generate");
  assert.equal(calls[0].searchParams.get("url"), "https://x.com/i/status/1234567890");
  const youtube = await handleFetchTranscript("video123", { method: "native" });
  assert.equal(getTimestampedTranscript(youtube), "[0:09] Speech");
  assert.equal(calls[1].searchParams.get("mode"), "native");
});

test("retrying a pending Supadata job polls the same job without submitting it twice", async () => {
  let jobs = 0;
  let polls = 0;
  const { handleFetchTranscript } = loadBackgroundHelpers({
    settings: { supadataApiKey: "test-key" },
    setTimeoutImpl: (fn) => { fn(); return 0; },
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/v1/transcript") {
        jobs += 1;
        return new Response(JSON.stringify({ jobId: "long-job" }), { status: 202 });
      }
      assert.match(url, /long-job$/);
      polls += 1;
      return new Response(JSON.stringify(polls <= 60
        ? { status: "active" }
        : { status: "completed", content: [{ offset: 0, text: "已生成" }] }));
    },
  });
  assert.equal((await handleFetchTranscript("video123", { method: "generate" })).success, false);
  assert.equal((await handleFetchTranscript("video123", { method: "generate" })).success, true);
  assert.equal(jobs, 1);
  assert.equal(polls, 61);
});

test("Bilibili uses the requested part and falls back when its first subtitle track is empty", async () => {
  const { getTimestampedTranscript } = loadSidepanelHelpers();
  const preferred = { lang: "zh-CN", url: "first" };
  const alternate = { lang: "ai-en", url: "second" };
  const { handleFetchTranscript } = loadBackgroundHelpers({
    settings: {},
    fetchImpl: () => { throw new Error("Bilibili must not call Supadata"); },
    biliApi: {
      fetchVideoInfo: async (bvid, { page }) => {
        assert.equal(bvid, "BV1DXKS6rEYq");
        assert.equal(page, 2);
        return { pageCount: 2, title: "Part Two" };
      },
      fetchSubtitleTracks: async () => ({ tracks: [preferred, alternate] }),
      pickSubtitleTrack: () => preferred,
      fetchSubtitleTrackContent: async (url) => url === "first" ? [] : [{ text: "Part two", start: 62.5 }],
    },
  });
  const result = await handleFetchTranscript("bili:BV1DXKS6rEYq:2");
  assert.equal(result.transcriptTimestamped, "[1:02] Part two");
  assert.equal(getTimestampedTranscript(result), "[1:02] Part two");
  assert.equal(result.language, "en");
  assert.equal(result.videoInfo.title, "Part Two");
});

test("Bilibili tries another track when the preferred track only covers the beginning", async () => {
  const preferred = { lang: "zh-CN", url: "partial" };
  const alternate = { lang: "en", url: "complete" };
  const { handleFetchTranscript } = loadBackgroundHelpers({
    biliApi: {
      fetchVideoInfo: async () => ({ pageCount: 1, duration: 1000 }),
      fetchSubtitleTracks: async () => ({ tracks: [preferred, alternate] }),
      pickSubtitleTrack: () => preferred,
      fetchSubtitleTrackContent: async (url) => Array.from(
        { length: url === "partial" ? 2 : 20 },
        (_, index) => ({ text: "字幕", start: index * 50, duration: 45 }),
      ),
    },
  });
  const result = await handleFetchTranscript("bili:BV1DXKS6rEYq:1");
  assert.equal(result.language, "en");
  assert.equal(result.transcript.length, 20);
});

test("partial overviews instruct the model to omit missing sections and remove unsupported timestamps", async () => {
  const { handleAnalyzeTranscript } = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.endsWith("/prompts/analysis.md")) return new Response(read("prompts/analysis.md"));
      const { messages } = JSON.parse(options.body);
      assert.match(messages[0].content, /Omit missing sections/);
      assert.doesNotMatch(messages[0].content, /COVER THE ENTIRE VIDEO/);
      const analysis = { chapters: [
        { title: "有字幕", timestampSeconds: 30 },
        { title: "缺失", timestampSeconds: 80 },
      ] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
    },
  });
  const result = await handleAnalyzeTranscript("[0:30] 起点\n[2:00] 下一部分", "标题", "", "", 120, true);
  assert.ok(result.success);
  assert.deepEqual(Array.from(result.analysis.chapters, ({ title }) => title), ["有字幕"]);
});

test("overview uses cached timestamped text or rebuilds it from cached subtitles", () => {
  const { getTimestampedTranscript } = loadSidepanelHelpers();
  const transcript = [{ start: 0.5, text: "开场" }, { start: 62.5, text: "下一段" }];
  assert.equal(getTimestampedTranscript({ transcript }), "[0:00] 开场\n[1:02] 下一段");
  assert.equal(getTimestampedTranscript({ transcript, transcriptTimestamped: "[0:00] 已保存" }), "[0:00] 已保存");
});

test("playback commands reconnect open video tabs once and keep the requested video ID", async () => {
  const settings = require("../settings.js");
  for (const url of [
    "https://www.youtube.com/watch?v=arj7oStGLkU",
    "https://www.bilibili.com/video/BV1dnuq6dEak/?p=2",
    "https://x.com/SpaceX/status/1481651037291225113",
  ]) {
    const source = settings.videoFromUrl(url);
    let targetUrl = url;
    let connected = false;
    let injections = 0;
    const delivered = [];
    const { sendToVideoPage } = loadBackgroundHelpers({
      tabs: {
        get: async () => ({ url: targetUrl }),
        sendMessage: async (tabId, message, { frameId }) => {
          assert.equal(tabId, 47);
          assert.equal(frameId, 0);
          if (!connected) throw new Error("Could not establish connection. Receiving end does not exist.");
          delivered.push(message);
          return { success: true };
        },
      },
      scripting: {
        executeScript: async (request) => {
          assert.equal(request.target.tabId, 47);
          assert.equal(request.files.join(","), "settings.js,lib/player.js");
          injections += 1;
          connected = true;
        },
      },
    });
    assert.equal(await sendToVideoPage(47, source, { action: "getCurrentTime" }), null);
    const seek = { action: "seekTo", seconds: 2.65 };
    await Promise.all([sendToVideoPage(47, source, { action: "getVideoInfo" }), sendToVideoPage(47, source, seek)]);
    assert.equal(injections, 1);
    assert.ok(delivered.every((message) => message.videoId === source.id));
    assert.equal(delivered.find((message) => message.action === seek.action).seconds, seek.seconds);

    connected = false;
    targetUrl = "https://example.com";
    assert.equal((await sendToVideoPage(47, source, seek)).success, false);
    assert.equal(injections, 1);
  }
});

test("overview rejects results with no displayable entries and accepts a partial overview", async () => {
  const transcriptText = "[0:00] 开场\n[1:02] 下一段";
  const responses = [
    { chapters: [{ title: "超出视频范围", timestampSeconds: 145 }], keyQuotes: [] },
    { chapters: [], keyQuotes: [{ quote: "下一段", timestampSeconds: 62 }] },
  ];
  const { handleAnalyzeTranscript } = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.endsWith("/prompts/analysis.md")) return new Response(read("prompts/analysis.md"));
      assert.ok(JSON.parse(options.body).messages.some(({ content }) => content.includes(transcriptText)));
      const content = JSON.stringify(responses.shift());
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    },
  });
  const invalid = await handleAnalyzeTranscript(transcriptText, "标题", "作者", "简介", 64);
  assert.equal(invalid.success, false);
  assert.equal(invalid.error, "EMPTY_OVERVIEW");
  const partial = await handleAnalyzeTranscript(transcriptText, "标题", "作者", "简介", 64);
  assert.equal(partial.success, true);
  assert.equal(partial.analysis.keyQuotes[0].timestamp, "1:02");
  assert.equal(partial.analysis.chapters.length, 0);
});

test("unrelated tabs explicitly close before their panel is disabled", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => calls.push(["close", options]),
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  });

  await background.updatePanelForTab(17, "https://example.com/page", 4);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["close", { tabId: 17 }],
    ["setOptions", { tabId: 17, enabled: false }],
  ]);
});

test("a global panel closes by window when the tab close is rejected", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => {
        calls.push(["close", options]);
        if (options.tabId) throw new Error("Global panel");
      },
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  });

  await background.updatePanelForTab(17, "https://example.com/page", 4);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["close", { tabId: 17 }],
    ["close", { windowId: 4 }],
    ["setOptions", { tabId: 17, enabled: false }],
  ]);
});

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("the header exposes one universal language control for all result tabs", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /id="transcriptModeControl"[\s\S]*aria-label="内容语言"/);
  assert.match(html, /id="transcriptModeControl"[\s\S]*id="tabsNav"/);
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>原文</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /handleDisplayLanguageModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.match(js, /contentType: "interfaceBatch"/);
  assert.match(js, /translateOverviewContent/);
  assert.match(js, /translateNotesContent/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.doesNotMatch(`${html}\n${js}`, /From video subtitles/);
});

test("new videos default to Original while returning videos restore their choice", async () => {
  const { loadDisplayLanguageMode, saveDisplayLanguageMode } =
    loadSidepanelHelpers();

  await saveDisplayLanguageMode("video-a", "bilingual");
  assert.equal(await loadDisplayLanguageMode("video-a"), "bilingual");
  assert.equal(await loadDisplayLanguageMode("unseen-video"), "original");
});

test("Overview shares the Transcript batch generation and retries when opened", () => {
  const js = read("sidepanel.js");
  const transcriptFunction = js.match(
    /async function translateTranscript\(\)[\s\S]*?\n}\n\nfunction setTranslatingSpinner/,
  )?.[0];

  assert.ok(transcriptFunction);
  assert.doesNotMatch(transcriptFunction, /translationGeneration \+= 1/);
  assert.match(js, /const TRANSLATION_BATCH_SIZE = 3/);
  assert.match(
    js,
    /const batch = missing\.slice\(start, start \+ TRANSLATION_BATCH_SIZE\)[\s\S]*?rerender\(\);[\s\S]*?await updateCache\(\)/,
  );
  assert.match(
    js,
    /tabName === "overview"[\s\S]*?currentAnalysis[\s\S]*?currentTranscriptMode !== "original"[\s\S]*?translateOverviewContent\(\)/,
  );
  assert.match(
    js,
    /Translate only the visible tab[\s\S]*?tabName === "notes"[\s\S]*?translateNotesContent\(\)/,
  );
  assert.match(
    js,
    /activeTabName === "overview"[\s\S]*?translateOverviewContent\(\)[\s\S]*?activeTabName === "notes"[\s\S]*?translateNotesContent\(\)[\s\S]*?activeTabName === "transcript"[\s\S]*?translateTranscript\(\)/,
  );
});

test("transcript reading position survives a side panel close", async () => {
  const { saveTranscriptViewState, loadTranscriptViewState } =
    loadSidepanelHelpers();

  await saveTranscriptViewState("video-a", 427.5);
  const restored = await loadTranscriptViewState("video-a");

  assert.deepEqual(JSON.parse(JSON.stringify(restored)), {
    videoId: "video-a",
    scrollTop: 427.5,
  });
});

test("selected transcript notes keep exact text and row timestamp", async () => {
  const providerMustNotRun = async () => {
    throw new Error("Selected note must not call a provider");
  };
  const { handleSaveNote } = loadBackgroundHelpers({
    fetchImpl: providerMustNotRun,
  });

  const result = await handleSaveNote(
    "video123",
    92.9,
    "Test video",
    "Test channel",
    "  The selected words stay exact.  ",
  );

  assert.equal(result.success, true);
  assert.equal(result.note.text, "The selected words stay exact.");
  assert.equal(result.note.rawText, "The selected words stay exact.");
  assert.equal(result.note.timestamp, "1:32");
  assert.equal(result.note.timestampSeconds, 92);
  assert.equal(
    result.note.timestampedUrl,
    "https://www.youtube.com/watch?v=video123&t=92s",
  );
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("Bilibili groups original cues at sentences, pauses and size limits while keeping exact times", () => {
  const { getOriginalTranscriptRows, groupTranscriptEntries, renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const entries = [
    { start: 308.25, duration: 2, text: "先打开设置页" },
    { start: 310.4, duration: 3, text: "然后填写 API Key" },
    { start: 313.8, duration: 2.6, text: "点击保存。" },
    { start: 316.5, duration: 2, text: "开始下一个说明" },
    { start: 319.7, duration: 10, text: "明显停顿之后" },
    { start: 329.8, duration: 3, text: "没有标点也会分段" },
    { start: 333, duration: 2, text: "长".repeat(110) },
  ];
  const rows = getOriginalTranscriptRows(entries, "bili:BV1dnuq6dEak:1");
  assert.deepEqual(Array.from(rows, ({ start }) => start), [308.25, 316.5, 319.7, 329.8, 333]);
  assert.deepEqual(Array.from(rows[0].cues, ({ start }) => start), [308.25, 310.4, 313.8]);
  assert.equal(rows[0].text, "先打开设置页 然后填写 API Key 点击保存。");

  const defaultGroups = groupTranscriptEntries(entries);
  const withTimestamps = groupTranscriptEntries(entries, undefined, { preserveCueTimestamps: true });
  assert.deepEqual(Array.from(withTimestamps, ({ id, text }) => [id, text]), Array.from(defaultGroups, ({ id, text }) => [id, text]));
  assert.match(renderTranscriptSegmentContent(withTimestamps[0], "bilingual", "", ""), /data-cue-start="310\.4">然后填写 API Key<\/span> /);
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /unavailable/i);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.match(source, /\["transcriptBatch", "interfaceBatch"\]/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    4,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("interface batches use the dedicated Overview and Notes translation prompt", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '{"segments":[{"id":"note-1","text":"\u4e2d\u6587\u7b14\u8bb0\u3002"}]}',
            },
          }],
        }),
      };
    },
  });

  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "note-1", text: "Saved note." }] },
    "interfaceBatch",
    "zh",
    "Video",
  );

  assert.equal(result.success, true);
  assert.equal(result.translatedContent.segments[0].text, "\u4e2d\u6587\u7b14\u8bb0\u3002");
  assert.match(
    requests[0].messages[0].content,
    /chapter titles, summaries, quotes, and saved notes/,
  );
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 130 seconds.*Retry/i);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});
