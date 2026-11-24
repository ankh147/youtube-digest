#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash "$repo/scripts/check-release.sh"
node --check "$repo/safari/content.js"
mkdir -p "$repo/dist"
output=$(mktemp -d "$repo/dist/safari.XXXXXX")
resources="$output/Extension"
mkdir -p "$resources/lib" "$resources/icons" "$resources/prompts" "$resources/safari"
cp "$repo/safari/manifest.json" "$resources/"
cp "$repo/"{background.js,settings.js,sidepanel.html,sidepanel.css,sidepanel.js,options.html,options.css,options.js,LICENSE,PRIVACY.md,SECURITY.md} "$resources/"
cp "$repo/lib/"{player.js,wbi.js,bili-api.js,bilibili-digest-LICENSE} "$resources/lib/"
cp "$repo/prompts/"{analysis.md,explain.md,note-cleanup.md,translation.md} "$resources/prompts/"
cp "$repo/safari/"{content.js,panel.css} "$resources/safari/"
cp "$repo/icons/"{icon16.png,icon48.png,icon128.png} "$resources/icons/"

xcrun safari-web-extension-packager "$resources" \
  --project-location "$output" \
  --app-name "YouTube Digest" \
  --bundle-identifier com.ankhlee.YouTube-Digest \
  --ios-only --swift --copy-resources --no-open --no-prompt

cp "$repo/safari/Main.html" "$output/YouTube Digest/YouTube Digest/Resources/Base.lproj/Main.html"
