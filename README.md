# Allow Right Click + Video Saver

A Chrome/Brave extension (Manifest V3) that re-enables right-click, copy, paste, and text selection on any website — and detects/downloads videos from any webpage.

## Features

### Right-Click & Copy Protection Bypass
- **Re-enable right-click context menu** on sites that block it
- **Re-enable text selection** (overrides `user-select: none`)
- **Re-enable copy/paste** (overrides `oncopy`, `onpaste` blocking)
- **Remove transparent overlays** that block clicks on images/videos
- **Override JavaScript-based blocking** (`addEventListener`, `oncontextmenu`, etc.)
- **Expose background images** for saving via context menu
- **Per-tab toggle** — activate only where needed (blue icon = active)
- **Whitelist system** — auto-enable on specific domains
- **Works in iframes** too

### Video Detection & Download
- **Auto-detect videos** on any page (HTML5 `<video>`, `<source>`, dynamic content)
- **Network interception** — catches `.mp4`, `.webm`, `.m3u8`, `.mpd` URLs from requests
- **Fetch/XHR interception** — detects video URLs set programmatically
- **Shadow DOM traversal** — finds videos in web components
- **HLS stream download** — downloads and merges `.m3u8` segments
- **Blob URL support** — downloads videos using `blob:` URLs
- **DRM detection** — warns about encrypted content (no bypass)
- **Badge count** — shows number of detected videos on the icon
- **One-click download** from the popup

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome/Brave and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `allow-right-click` folder
6. The extension icon appears in your toolbar

## Usage

### Right-Click Toggle
1. Visit a site that blocks right-click
2. Click the extension icon to open the popup
3. Toggle **Allow Right Click** ON
4. Right-click, select text, and copy freely
5. Optionally click **Add to whitelist** to auto-enable on that site

### Video Download
1. Visit any page with videos
2. The badge on the extension icon shows how many videos were detected
3. Click the icon to see all detected videos
4. Click the download button next to any video
5. Right-click any video element and select **Download this video**

## Architecture

```
├── manifest.json                  # MV3 manifest
├── background/
│   └── service-worker.js          # Central coordinator
├── content/
│   ├── right-click.js             # ISOLATED world — CSS/DOM fixes
│   ├── right-click-main.js        # MAIN world — JS API overrides
│   ├── video-detector.js          # ISOLATED world — DOM scanning
│   └── video-detector-main.js     # MAIN world — fetch/XHR intercept
├── popup/
│   ├── popup.html                 # Extension popup UI
│   ├── popup.css                  # Dark theme styles
│   └── popup.js                   # Popup logic
├── lib/
│   └── m3u8-parser.js             # Lightweight HLS manifest parser
└── icons/                         # Extension icons (active/inactive)
```

### Dual-World Content Scripts

The extension uses paired **ISOLATED** and **MAIN** world scripts:
- **ISOLATED world**: handles CSS injection, DOM attribute cleanup, and `chrome.runtime` messaging
- **MAIN world**: overrides page-level JavaScript APIs (`addEventListener`, `oncontextmenu`, `fetch`, etc.)

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab for script injection |
| `scripting` | Inject right-click scripts on demand |
| `webRequest` | Detect video URLs from network requests |
| `downloads` | Download detected videos |
| `contextMenus` | "Download this video" and "Allow Right Click" context menus |
| `storage` | Persist whitelist and settings |
| `tabs` | Tab lifecycle management |

## License

MIT
