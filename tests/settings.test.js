const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("video identities keep existing YouTube keys and isolate X and Bilibili parts", () => {
  const youtube = settings.videoFromUrl("https://www.youtube.com/watch?v=video123&list=other");
  assert.equal(youtube.id, "video123");
  const x = settings.videoFromUrl("https://twitter.com/SpaceX/status/1481651037291225113?s=42");
  assert.equal(x.id, settings.videoFromUrl("https://x.com/i/status/1481651037291225113").id);
  assert.equal(settings.timestampUrl(x, 12.8), "https://x.com/i/status/1481651037291225113#digest-t=12");
  const bili = settings.videoFromUrl("https://www.bilibili.com/video/BV1DXKS6rEYq/?p=2&spm_id_from=foo");
  assert.equal(bili.id, "bili:BV1DXKS6rEYq:2");
  assert.notEqual(bili.id, settings.videoFromUrl("https://www.bilibili.com/video/BV1DXKS6rEYq/").id);
  assert.equal(settings.timestampUrl(bili, 92), "https://www.bilibili.com/video/BV1DXKS6rEYq?p=2&t=92");
  assert.equal(settings.videoFromUrl("https://x.com.example.org/i/status/123"), null);
  assert.equal(settings.videoFromUrl("https://x.com/SpaceX/status/123/video/2"), null);
});

test("Safari mobile video pages can load the panel and share desktop transcript IDs", () => {
  const manifest = require("../safari/manifest.json");
  for (const [mobile, desktop] of [
    ["https://m.youtube.com/watch?v=video123", "https://www.youtube.com/watch?v=video123"],
    ["https://m.bilibili.com/video/BV1DXKS6rEYq/?p=2", "https://www.bilibili.com/video/BV1DXKS6rEYq/?p=2"],
  ]) {
    assert.deepEqual(settings.videoFromUrl(mobile), settings.videoFromUrl(desktop));
    const pattern = `${new URL(mobile).origin}/*`;
    assert.ok(manifest.host_permissions.includes(pattern), `Missing site permission for ${pattern}`);
    assert.ok(manifest.content_scripts.some(({ matches }) => matches.includes(pattern)), `Missing page scripts for ${pattern}`);
    assert.ok(manifest.web_accessible_resources.some(({ resources, matches }) =>
      resources.includes("sidepanel.html") && matches.includes(pattern)), `Missing panel access for ${pattern}`);
  }
  assert.equal(settings.videoFromUrl("https://m.youtube.com/results?v=video123"), null);
});

test("DeepSeek defaults use V4 Flash", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: "  example-supadata  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(
    settings.chatCompletionsUrl(),
    "https://api.deepseek.com/chat/completions",
  );
});

test("legacy custom migration clears only the AI key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: " supadata-secret ",
  };
  const first = settings.migrateLegacyCustom(legacy);

  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  assert.equal(first.settings.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(first.settings.aiModel, settings.DEFAULTS.aiModel);
  assert.equal(first.settings.aiApiKey, "");
  assert.equal(first.settings.supadataApiKey, "supadata-secret");

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);

  const configuredDeepSeek = settings.normalize({
    ...first.settings,
    aiApiKey: "new-deepseek-key",
  });
  assert.equal(configuredDeepSeek.aiApiKey, "new-deepseek-key");
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});

test("coverage flags a short prefix and interior gaps while allowing normal credits and unknown duration", () => {
  const { transcriptCoverage } = require("../settings.js");
  const cues = (end) => Array.from({ length: end / 10 }, (_, index) => ({
    start: index * 10,
    duration: 8,
  }));
  assert.equal(transcriptCoverage(cues(7100), 7115).status, "covered");
  const prefix = transcriptCoverage(cues(1200), 7200);
  assert.equal(prefix.status, "partial");
  assert.equal(prefix.end, 1198);
  const withGap = transcriptCoverage(cues(1200).filter(({ start }) => start < 300 || start >= 720), 1200);
  assert.equal(withGap.status, "partial");
  assert.deepEqual(withGap.gaps, [{ start: 298, end: 720 }]);
  assert.equal(transcriptCoverage(cues(900), 0).status, "unknown");
});
