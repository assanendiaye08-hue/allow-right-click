/* ─── Popup Controller ─── */

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  /* ── State ── */

  const state = await chrome.runtime.sendMessage({ type: 'get-state', tabId: tab.id });

  /* ── Right-Click Toggle ── */

  const toggleBtn = document.getElementById('toggle-btn');
  const toggleStatus = document.getElementById('toggle-status');

  function updateToggleUI(active) {
    toggleBtn.setAttribute('aria-pressed', String(active));
    toggleStatus.textContent = active ? 'ON' : 'OFF';
    toggleStatus.className = 'status-badge ' + (active ? 'active' : 'inactive');
  }

  updateToggleUI(state?.rightClickActive || false);

  toggleBtn.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'toggle-right-click',
      tabId: tab.id
    });
    updateToggleUI(response?.active || false);
  });

  /* ── Whitelist Button ── */

  const whitelistBtn = document.getElementById('whitelist-btn');

  // Check if current site is already whitelisted
  try {
    const hostname = new URL(tab.url).hostname;
    const wlData = await chrome.runtime.sendMessage({
      type: 'whitelist-update',
      action: 'get'
    });
    if (wlData?.whitelist?.includes(hostname)) {
      whitelistBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Whitelisted
      `;
      whitelistBtn.classList.add('success');
    }
  } catch (e) { /* invalid URL */ }

  whitelistBtn.addEventListener('click', async () => {
    try {
      const hostname = new URL(tab.url).hostname;
      await chrome.runtime.sendMessage({
        type: 'whitelist-update',
        action: 'add',
        domain: hostname
      });
      whitelistBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Whitelisted!
      `;
      whitelistBtn.classList.add('success');

      // Also activate right-click immediately
      if (!toggleBtn.getAttribute('aria-pressed') === 'true') {
        const response = await chrome.runtime.sendMessage({
          type: 'toggle-right-click',
          tabId: tab.id
        });
        updateToggleUI(response?.active || false);
      }
    } catch (e) { /* invalid URL */ }
  });

  /* ── Video List ── */

  const videoList = document.getElementById('video-list');
  const emptyState = document.getElementById('empty-state');
  const videoCount = document.getElementById('video-count');

  const videos = await chrome.runtime.sendMessage({ type: 'get-videos', tabId: tab.id });

  renderVideos(videos || []);

  function renderVideos(videos) {
    const count = videos.length;
    videoCount.textContent = count;
    videoCount.className = 'count-badge' + (count === 0 ? ' zero' : '');

    if (count === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    // Remove existing cards
    videoList.querySelectorAll('.video-card').forEach(c => c.remove());

    for (const video of videos) {
      const card = createVideoCard(video, tab);
      videoList.appendChild(card);
    }
  }

  /* ── Settings Panel ── */

  const settingsPanel = document.getElementById('settings-panel');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsClose = document.getElementById('settings-close');
  const whitelistTextarea = document.getElementById('whitelist-textarea');
  const saveBtn = document.getElementById('save-settings');

  settingsBtn.addEventListener('click', async () => {
    settingsPanel.classList.remove('hidden');
    const data = await chrome.runtime.sendMessage({
      type: 'whitelist-update',
      action: 'get'
    });
    whitelistTextarea.value = (data?.whitelist || []).join('\n');
  });

  settingsClose.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  saveBtn.addEventListener('click', async () => {
    const domains = whitelistTextarea.value
      .split('\n')
      .map(d => d.trim().toLowerCase())
      .filter(d => d && d.includes('.'));

    // Clear existing and set new
    const current = await chrome.runtime.sendMessage({
      type: 'whitelist-update',
      action: 'get'
    });

    // Remove all current
    for (const d of (current?.whitelist || [])) {
      await chrome.runtime.sendMessage({
        type: 'whitelist-update',
        action: 'remove',
        domain: d
      });
    }

    // Add new
    for (const d of domains) {
      await chrome.runtime.sendMessage({
        type: 'whitelist-update',
        action: 'add',
        domain: d
      });
    }

    saveBtn.textContent = 'Saved!';
    setTimeout(() => {
      saveBtn.textContent = 'Save Settings';
      settingsPanel.classList.add('hidden');
    }, 1000);
  });
});

/* ─── Video Card Builder ─── */

function createVideoCard(video, tab) {
  const card = document.createElement('div');
  card.className = 'video-card';

  const type = video.type || classifyVideoType(video.url);
  const resolution = video.videoWidth && video.videoHeight
    ? `${video.videoWidth}x${video.videoHeight}`
    : '';
  const duration = video.duration ? formatDuration(video.duration) : '';
  const filename = extractFilename(video.url, video.pageTitle || video.title);
  const typeClass = 'type-' + type.toLowerCase();

  card.innerHTML = `
    <div class="thumb-wrap">
      ${video.poster
        ? `<img src="${escapeAttr(video.poster)}" alt="" loading="lazy">`
        : `<div class="thumb-placeholder">${escapeHtml(type)}</div>`
      }
      ${video.encrypted ? '<span class="drm-badge">DRM</span>' : ''}
    </div>
    <div class="video-info">
      <span class="video-title" title="${escapeAttr(filename)}">${escapeHtml(filename)}</span>
      <div class="video-meta">
        <span class="meta-tag ${typeClass}">${escapeHtml(type)}</span>
        ${resolution ? `<span class="meta-tag">${resolution}</span>` : ''}
        ${duration ? `<span class="meta-tag">${duration}</span>` : ''}
      </div>
    </div>
    <button class="download-btn ${video.encrypted ? 'disabled' : ''}"
            title="${video.encrypted ? 'DRM protected — cannot download' : 'Download video'}"
            ${video.encrypted ? 'disabled' : ''}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    </button>
  `;

  if (!video.encrypted) {
    const btn = card.querySelector('.download-btn');
    btn.addEventListener('click', () => {
      btn.classList.add('downloading');
      chrome.runtime.sendMessage({
        type: 'download-video',
        video,
        tab: { id: tab.id, title: tab.title, url: tab.url }
      });
      setTimeout(() => btn.classList.remove('downloading'), 2000);
    });
  }

  return card;
}

/* ─── Helpers ─── */

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function classifyVideoType(url) {
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  if (/^blob:/i.test(url)) return 'Blob';
  return 'Video';
}

function extractFilename(url, pageTitle) {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /\.\w{2,5}$/.test(last)) {
      const decoded = decodeURIComponent(last);
      if (decoded.length < 80) return decoded;
    }
  } catch {}
  return (pageTitle || 'video').substring(0, 60) || 'video';
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
