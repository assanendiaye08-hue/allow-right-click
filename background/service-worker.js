/* ─── State Management ─── */

const tabStates = new Map(); // tabId -> { rightClickActive, videos: Map<url, info> }

function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, { rightClickActive: false, videos: new Map() });
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

const VIDEO_URL_RE = /\.(mp4|webm|m3u8|mpd|ts|m4s|m4v|mkv|avi|flv|mov|ogg|ogv)(\?|#|$)/i;
const VIDEO_MIME_RE = /^(video\/|application\/x-mpegURL|application\/dash\+xml|application\/vnd\.apple\.mpegurl)/i;
// Skip tiny segments and tracking pixels
const SEGMENT_RE = /\.(ts|m4s)(\?|#|$)/i;
// CDN patterns that serve video without file extensions (Twitter, Facebook, etc.)
const VIDEO_CDN_RE = /\/(video|vid|amplify_video|ext_tw_video|tweet_video)\//i;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    // Skip individual TS/m4s segments — we want the m3u8/mpd manifest instead
    if (SEGMENT_RE.test(url)) return;
    // Match by file extension OR known video CDN URL patterns
    if (VIDEO_URL_RE.test(url) || (details.type === 'media' && VIDEO_CDN_RE.test(url))) {
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
    if (ct && VIDEO_MIME_RE.test(ct.value) && !SEGMENT_RE.test(details.url)) {
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

async function initiateDownload(url, tab) {
  const filename = generateFilename(url, tab);

  if (/^https?:\/\//i.test(url)) {
    // Check if it's an HLS manifest
    if (/\.m3u8/i.test(url)) {
      await downloadHLS(url, filename);
      return;
    }
    // Try direct download first
    try {
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
      if (!downloadId) throw new Error('Download returned no ID');
    } catch (e) {
      console.warn('Direct download failed, trying via content script:', e.message);
      // Fallback: download through the content script (has page cookies/auth)
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'download-via-page',
          url,
          filename
        });
      } catch (e2) {
        console.error('Content script download also failed:', e2);
      }
    }
  } else if (url.startsWith('blob:')) {
    // Blob URLs from MediaSource can't be fetched directly.
    // Strategy 1: Ask content script to fetch + convert to data URL
    // Strategy 2: If that fails, ask content script to capture via MediaRecorder
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'fetch-blob',
        url
      });
      if (response?.dataUrl) {
        chrome.downloads.download({ url: response.dataUrl, filename, saveAs: true });
      } else if (response?.error) {
        console.warn('Blob fetch failed:', response.error);
        // Fallback: try to find an HTTP URL for this video from our network cache
        const state = getTabState(tab.id);
        const httpVideo = Array.from(state.videos.values()).find(
          v => v.source === 'network' && /^https?:\/\//i.test(v.url)
        );
        if (httpVideo) {
          console.log('Found HTTP fallback URL:', httpVideo.url);
          await initiateDownload(httpVideo.url, tab);
        } else {
          // Last resort: ask content script to record the video
          await chrome.tabs.sendMessage(tab.id, {
            type: 'record-video',
            blobUrl: url,
            filename
          });
        }
      }
    } catch (e) {
      console.error('Blob download failed:', e);
    }
  } else if (url.startsWith('data:')) {
    chrome.downloads.download({ url, filename, saveAs: true });
  }
}

async function downloadHLS(m3u8Url, filename) {
  try {
    const resp = await fetch(m3u8Url);
    const text = await resp.text();
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    const parsed = parseM3U8(text, baseUrl);

    if (parsed.isMaster && parsed.variants.length > 0) {
      // Pick highest bandwidth variant
      const best = parsed.variants[0];
      const variantResp = await fetch(best.url);
      const variantText = await variantResp.text();
      const variantBase = best.url.substring(0, best.url.lastIndexOf('/') + 1);
      const media = parseM3U8(variantText, variantBase);
      await downloadSegments(media.segments, filename);
    } else if (parsed.segments.length > 0) {
      await downloadSegments(parsed.segments, filename);
    }
  } catch (e) {
    console.error('HLS download failed:', e);
  }
}

async function downloadSegments(segments, filename) {
  const buffers = [];
  const batchSize = 5;

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (seg) => {
        const resp = await fetch(seg.url);
        return resp.arrayBuffer();
      })
    );
    buffers.push(...results);
  }

  // Concatenate all buffers
  const totalSize = buffers.reduce((s, b) => s + b.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  // Convert to data URL for download
  const blob = new Blob([combined], { type: 'video/mp2t' });
  const reader = new FileReader();
  reader.onloadend = () => {
    const tsFilename = filename.replace(/\.[^.]+$/, '.ts');
    chrome.downloads.download({ url: reader.result, filename: tsFilename, saveAs: true });
  };
  reader.readAsDataURL(blob);
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
  const ext = /\.m3u8/i.test(url) ? 'ts' : 'mp4';
  return `${title}.${ext}`;
}

/* ─── Tab Lifecycle ─── */

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  saveState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // Page is navigating — clear video list, check whitelist
    const state = getTabState(tabId);
    state.videos.clear();
    state.rightClickActive = false;
    updateBadge(tabId);
    updateIcon(tabId, false);
  }

  if (changeInfo.status === 'complete' && tab.url) {
    // Check whitelist for auto-activation
    try {
      const hostname = new URL(tab.url).hostname;
      const data = await chrome.storage.sync.get({ whitelist: [] });
      if (data.whitelist.includes(hostname)) {
        await activateRightClick(tabId);
      }
    } catch (e) { /* chrome:// URLs etc */ }
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
