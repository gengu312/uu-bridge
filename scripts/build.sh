#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
app='.build/UU Bridge.app'
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.uubridge.helper</string>
<key>CFBundleName</key><string>UU Bridge</string>
<key>CFBundleExecutable</key><string>UUBridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAccessibilityUsageDescription</key><string>把浏览器里的操作传给你选中的 UU 窗口。</string>
<key>NSScreenCaptureUsageDescription</key><string>只采集你选中的 UU 窗口，并显示在本机浏览器中。</string>
</dict></plist>
PLIST
xcrun swiftc -parse-as-library -swift-version 5 -O native/Bridge.swift \
  -framework AppKit -framework ScreenCaptureKit -framework ApplicationServices \
  -o "$app/Contents/MacOS/UUBridge"
codesign --force --sign - --identifier local.uubridge.helper "$app"
printf 'Built %s\n' "$app"
