/* ─── State Management ─── */

const tabStates = new Map(); // tabId -> { rightClickActive, videos: Map<url, info> }

function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, { rightClickActive: true, videos: new Map() });
  }
  return tabStates.get(tabId);
}

/* ─── Persist state to survive SW restarts ─── */

async function saveState() {
  const data = {};
  for (const [tabId, state] of tabStates) {
    data[tabId] = {
      rightClickActive: state.rightClickActive,
      videos: Array.from(state.videos.entries())
    };
  }
  await chrome.storage.session.set({ tabStates: data });
}

async function restoreState() {
  const result = await chrome.storage.session.get('tabStates');
  if (result.tabStates) {
    for (const [tabId, state] of Object.entries(result.tabStates)) {
      tabStates.set(Number(tabId), {
        rightClickActive: state.rightClickActive,
        videos: new Map(state.videos)
      });
    }
  }
}

restoreState();

/* ─── Context Menus ─── */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-video',
    title: 'Download this video',
    contexts: ['video']
  });
  chrome.contextMenus.create({
    id: 'toggle-right-click',
    title: 'Allow Right Click on this page',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'add-to-whitelist',
    title: 'Always allow right-click on this site',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'download-video') {
    const url = info.srcUrl || info.linkUrl || info.pageUrl;
    if (url) initiateDownload(url, tab);
  } else if (info.menuItemId === 'toggle-right-click') {
    await toggleRightClick(tab.id);
  } else if (info.menuItemId === 'add-to-whitelist') {
    try {
      const hostname = new URL(tab.url).hostname;
      const data = await chrome.storage.sync.get({ whitelist: [] });
      if (!data.whitelist.includes(hostname)) {
        data.whitelist.push(hostname);
        await chrome.storage.sync.set({ whitelist: data.whitelist });
      }
      // Activate immediately
      await activateRightClick(tab.id);
    } catch (e) { /* invalid URL */ }
  }
});

/* ─── Right-Click Toggle ─── */

async function toggleRightClick(tabId) {
  const state = getTabState(tabId);
  if (state.rightClickActive) {
    await deactivateRightClick(tabId);
  } else {
    await activateRightClick(tabId);
  }
  return state.rightClickActive;
}

async function activateRightClick(tabId) {
  const state = getTabState(tabId);
  try {
    // Inject ISOLATED world script
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/right-click.js']
    });
    // Inject MAIN world script
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/right-click-main.js'],
      world: 'MAIN'
    });
    state.rightClickActive = true;
    updateIcon(tabId, true);
    saveState();
  } catch (e) {
    console.error('Failed to activate right-click:', e);
  }
}

async function deactivateRightClick(tabId) {
  const state = getTabState(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'disable-right-click' });
  } catch (e) { /* tab may not have listener */ }
  state.rightClickActive = false;
  updateIcon(tabId, false);
  saveState();
}

function updateIcon(tabId, active) {
  const suffix = active ? '' : '-gray';
  chrome.action.setIcon({
    tabId,
    path: {
      16: `icons/icon-16${suffix}.png`,
      32: `icons/icon-32${suffix}.png`,
      48: `icons/icon-48${suffix}.png`,
      128: `icons/icon-128${suffix}.png`
    }
  });
}

/* ─── Video Detection from Network Requests ─── */

const VIDEO_URL_RE = /\.(mp4|webm|m3u8|mpd|m4v|mkv|avi|flv|mov|ogg|ogv)(\?|#|$)/i;
const VIDEO_MIME_RE = /^(video\/|application\/x-mpegURL|application\/dash\+xml|application\/vnd\.apple\.mpegurl)/i;
// Skip DASH/CMAF segments — these are tiny fragments, not complete videos
const SEGMENT_RE = /\.(ts|m4s)(\?|#|$)/i;
const DASH_SEGMENT_RE = /\/(range\/|seg-|chunk-|fragment|init[.-])/i;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    // Skip individual segments
    if (SEGMENT_RE.test(url)) return;
    if (DASH_SEGMENT_RE.test(url)) return;
    // Match by file extension (not CDN pattern — those are often segments)
    if (VIDEO_URL_RE.test(url)) {
      addVideoToTab(details.tabId, {
        url,
        source: 'network',
        type: classifyUrl(url),
        timestamp: Date.now()
      });
    }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const ct = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
    if (ct && VIDEO_MIME_RE.test(ct.value) &&
        !SEGMENT_RE.test(details.url) && !DASH_SEGMENT_RE.test(details.url)) {
      addVideoToTab(details.tabId, {
        url: details.url,
        source: 'network-mime',
        type: classifyMime(ct.value),
        timestamp: Date.now()
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function addVideoToTab(tabId, videoInfo) {
  const state = getTabState(tabId);
  const key = normalizeUrl(videoInfo.url);
  if (state.videos.has(key)) return;
  state.videos.set(key, videoInfo);
  updateBadge(tabId);
  saveState();
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Keep path but strip most query params for dedup
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function classifyUrl(url) {
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  if (/\.mov/i.test(url)) return 'MOV';
  if (/\.mkv/i.test(url)) return 'MKV';
  if (/\.flv/i.test(url)) return 'FLV';
  if (/\.avi/i.test(url)) return 'AVI';
  if (/\.ogg/i.test(url)) return 'OGG';
  return 'Video';
}

function classifyMime(mime) {
  if (/mpegurl/i.test(mime)) return 'HLS';
  if (/dash/i.test(mime)) return 'DASH';
  if (/mp4/i.test(mime)) return 'MP4';
  if (/webm/i.test(mime)) return 'WebM';
  if (/ogg/i.test(mime)) return 'OGG';
  return 'Video';
}

/* ─── Badge ─── */

function updateBadge(tabId) {
  const state = getTabState(tabId);
  const count = state.videos.size;
  chrome.action.setBadgeText({
    text: count > 0 ? String(count) : '',
    tabId
  });
  chrome.action.setBadgeBackgroundColor({ color: '#e94560', tabId });
}

/* ─── Downloads ─── */

// Sites that need cobalt.tools for download (encrypted/DRM/complex formats)
const COBALT_SITES = /youtube\.com|youtu\.be|tiktok\.com|soundcloud\.com|twitch\.tv|dailymotion\.com|bilibili\.com/i;
// Sites where our API interception finds progressive MP4 URLs
const API_INTERCEPT_SITES = /twitter\.com|x\.com|instagram\.com|facebook\.com|fbcdn\.net/i;

async function openCobaltWithUrl(videoUrl, tab) {
  const cobaltTab = await chrome.tabs.create({
    url: 'https://cobalt.tools/',
    index: tab.index + 1
  });
  chrome.tabs.onUpdated.addListener(function cobaltReady(tabId, changeInfo) {
    if (tabId === cobaltTab.id && changeInfo.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(cobaltReady);
      chrome.scripting.executeScript({
        target: { tabId: cobaltTab.id },
        func: (url) => {
          const tryFill = (attempts) => {
            const input = document.querySelector('input');
            if (input) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(input, url);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (attempts > 0) {
              setTimeout(() => tryFill(attempts - 1), 500);
            }
          };
          tryFill(10);
        },
        args: [videoUrl]
      });
    }
  });
}

async function initiateDownload(url, tab) {
  const filename = generateFilename(url, tab);
  const pageUrl = tab.url || '';

  // Strategy 1: YouTube and similar (encrypted URLs) → open cobalt.tools and auto-fill
  if (COBALT_SITES.test(pageUrl)) {
    await openCobaltWithUrl(pageUrl, tab);
    return;
  }

  // Strategy 2: Twitter/FB/IG — use progressive MP4 from API interception
  if (API_INTERCEPT_SITES.test(pageUrl) || API_INTERCEPT_SITES.test(url)) {
    const state = getTabState(tab.id);
    const progressiveVideo = Array.from(state.videos.values())
      .filter(v => v.progressive && /^https?:\/\//i.test(v.url) && /\.mp4/i.test(v.url))
      .sort((a, b) => {
        const brDiff = (b.bitrate || 0) - (a.bitrate || 0);
        if (brDiff !== 0) return brDiff;
        return getUrlResolution(b.url) - getUrlResolution(a.url);
      })[0];

    if (progressiveVideo) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'download-via-page', url: progressiveVideo.url,
          filename: generateFilename(progressiveVideo.url, tab)
        });
        if (!result?.error) return;
      } catch (e) { /* failed */ }
    }

    // Fallback: open cobalt.tools with auto-fill
    await openCobaltWithUrl(pageUrl, tab);
    return;
  }

  // Strategy 3: Direct HTTP URL — download via content script (inherits cookies)
  if (/^https?:\/\//i.test(url)) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'download-via-page', url, filename
      });
      if (!result?.error) return;
    } catch (e) { /* failed */ }

    // Direct chrome.downloads fallback
    chrome.downloads.download({ url, filename, saveAs: true });
    return;
  }

  // Strategy 4: Blob URL
  if (url.startsWith('blob:')) {
    // Try fetching the blob directly
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'fetch-blob', url
      });
      if (response?.dataUrl) {
        chrome.downloads.download({ url: response.dataUrl, filename, saveAs: true });
        return;
      }
    } catch (e) { /* failed */ }

    // Last resort: MediaRecorder
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'record-video', blobUrl: url, filename
      });
    } catch (e) {
      console.error('All download methods failed:', e);
    }
    return;
  }

  if (url.startsWith('data:')) {
    chrome.downloads.download({ url, filename, saveAs: true });
  }
}


// Inline lightweight M3U8 parser for service worker
function parseM3U8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const result = { isMaster: false, variants: [], segments: [], totalDuration: 0 };

  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    result.isMaster = true;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = {};
        const match = lines[i].match(/#EXT-X-STREAM-INF:(.*)/);
        if (match) {
          const regex = /([A-Z-]+)=(?:"([^"]*)"|([^,]*))/g;
          let m;
          while ((m = regex.exec(match[1]))) attrs[m[1]] = m[2] || m[3];
        }
        const url = resolveUrl(lines[i + 1], baseUrl);
        result.variants.push({
          bandwidth: parseInt(attrs.BANDWIDTH) || 0,
          resolution: attrs.RESOLUTION || '',
          url
        });
      }
    }
    result.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  } else {
    let dur = 0;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        dur = parseFloat(line.split(':')[1]) || 0;
      } else if (!line.startsWith('#')) {
        result.segments.push({ url: resolveUrl(line, baseUrl), duration: dur });
        result.totalDuration += dur;
        dur = 0;
      }
    }
  }
  return result;
}

function resolveUrl(url, baseUrl) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  try { return new URL(url, baseUrl).href; } catch { return url; }
}

function getUrlResolution(url) {
  // Extract resolution from URL path like /1280x720/ or /720x1280/
  const match = url.match(/\/(\d{3,4})x(\d{3,4})\//);
  if (match) return parseInt(match[1]) * parseInt(match[2]);
  return 0;
}

function generateFilename(url, tab) {
  // Try to extract from URL path
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /\.\w{2,5}$/.test(last)) {
      return decodeURIComponent(last);
    }
  } catch {}
  // Fall back to page title
  const title = (tab?.title || 'video').replace(/[^\w\s-]/g, '').trim().substring(0, 60);
  const ext = 'mp4';
  return `${title}.${ext}`;
}

/* ─── Tab Lifecycle ─── */

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  saveState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // Page is navigating — clear video list, reset to ON (scripts auto-inject)
    const state = getTabState(tabId);
    state.videos.clear();
    state.rightClickActive = true;
    updateBadge(tabId);
    updateIcon(tabId, true);
  }
});

/* ─── Message Router ─── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case 'toggle-right-click': {
        const tabId = message.tabId;
        const active = await toggleRightClick(tabId);
        return { active: getTabState(tabId).rightClickActive };
      }

      case 'get-state': {
        const tabId = message.tabId;
        const state = getTabState(tabId);
        return {
          rightClickActive: state.rightClickActive,
          videoCount: state.videos.size
        };
      }

      case 'video-found': {
        const tabId = sender.tab?.id;
        if (tabId) {
          addVideoToTab(tabId, message.video);
        }
        return { ok: true };
      }

      case 'get-videos': {
        const tabId = message.tabId;
        const state = getTabState(tabId);
        return Array.from(state.videos.values());
      }

      case 'download-video': {
        const tab = message.tab || sender.tab;
        if (message.video?.url) {
          await initiateDownload(message.video.url, tab);
        }
        return { ok: true };
      }

      case 'whitelist-update': {
        const data = await chrome.storage.sync.get({ whitelist: [] });
        if (message.action === 'add' && message.domain) {
          if (!data.whitelist.includes(message.domain)) {
            data.whitelist.push(message.domain);
          }
        } else if (message.action === 'remove' && message.domain) {
          data.whitelist = data.whitelist.filter(d => d !== message.domain);
        } else if (message.action === 'get') {
          return { whitelist: data.whitelist };
        }
        await chrome.storage.sync.set({ whitelist: data.whitelist });
        return { whitelist: data.whitelist };
      }

      case 'drm-detected': {
        const tabId = sender.tab?.id;
        if (tabId && message.url) {
          const state = getTabState(tabId);
          const key = normalizeUrl(message.url);
          const existing = state.videos.get(key);
          if (existing) {
            existing.encrypted = true;
          }
        }
        return { ok: true };
      }

      default:
        return null;
    }
  };

  handler().then(sendResponse).catch(e => {
    console.error('Message handler error:', e);
    sendResponse({ error: e.message });
  });
  return true; // async sendResponse
});
