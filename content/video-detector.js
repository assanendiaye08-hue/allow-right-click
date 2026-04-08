/* ─── Video Detector — ISOLATED World Content Script ─── */
/* Auto-injected on all pages. Scans DOM for videos, watches for dynamic
   additions, handles blob fetch requests, and injects MAIN world interceptor. */

(function () {
  'use strict';

  // Guard against double-injection in the same frame
  if (window.__arcVideoDetector) return;
  window.__arcVideoDetector = true;

  const foundVideos = new Map(); // normalized URL -> videoInfo
  const seenElements = new WeakSet();

  /* ── Utility ── */

  function normalizeUrl(url) {
    if (!url) return '';
    try {
      if (url.startsWith('blob:') || url.startsWith('data:')) return url;
      const u = new URL(url, location.href);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  function isVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:') || url.startsWith('data:video')) return true;
    return /\.(mp4|webm|m3u8|mpd|m4v|ogg|ogv|mov|avi|flv|mkv)(\?|#|$)/i.test(url);
  }

  function reportVideo(url, meta = {}) {
    if (!url || url === '' || url === 'about:blank') return;
    // Skip tiny tracking requests and data URIs that aren't video
    if (url.startsWith('data:') && !url.startsWith('data:video')) return;

    const key = normalizeUrl(url);
    if (foundVideos.has(key)) return;

    const videoInfo = {
      url,
      source: meta.source || 'dom',
      type: classifyUrl(url),
      duration: meta.duration || 0,
      videoWidth: meta.videoWidth || 0,
      videoHeight: meta.videoHeight || 0,
      poster: meta.poster || '',
      title: meta.title || document.title || '',
      pageUrl: location.href,
      pageTitle: document.title,
      isBlob: url.startsWith('blob:'),
      encrypted: false,
      timestamp: Date.now()
    };

    foundVideos.set(key, videoInfo);

    try {
      chrome.runtime.sendMessage({ type: 'video-found', video: videoInfo });
    } catch (e) { /* extension context invalidated */ }
  }

  function classifyUrl(url) {
    if (/\.m3u8/i.test(url)) return 'HLS';
    if (/\.mpd/i.test(url)) return 'DASH';
    if (/\.mp4/i.test(url)) return 'MP4';
    if (/\.webm/i.test(url)) return 'WebM';
    if (/\.mov/i.test(url)) return 'MOV';
    if (/\.mkv/i.test(url)) return 'MKV';
    if (/\.flv/i.test(url)) return 'FLV';
    if (/\.ogg|\.ogv/i.test(url)) return 'OGG';
    if (url.startsWith('blob:')) return 'Blob';
    return 'Video';
  }

  /* ── Video Element Processing ── */

  function getVideoMeta(video) {
    if (!video) return {};
    return {
      duration: isFinite(video.duration) ? video.duration : 0,
      videoWidth: video.videoWidth || video.width || 0,
      videoHeight: video.videoHeight || video.height || 0,
      poster: video.poster || '',
      title: video.title || video.getAttribute('aria-label') || ''
    };
  }

  function processVideoElement(video) {
    if (!video || seenElements.has(video)) return;
    seenElements.add(video);

    // Direct src
    const src = video.currentSrc || video.src;
    if (src) {
      reportVideo(src, getVideoMeta(video));
    }

    // <source> children
    video.querySelectorAll('source').forEach(source => {
      if (source.src) reportVideo(source.src, getVideoMeta(video));
    });

    // Watch for src changes on this video element
    const srcObserver = new MutationObserver(() => {
      const newSrc = video.currentSrc || video.src;
      if (newSrc) reportVideo(newSrc, getVideoMeta(video));
    });
    srcObserver.observe(video, { attributes: true, attributeFilter: ['src'] });

    // Listen for loadedmetadata to get updated dimensions/duration
    video.addEventListener('loadedmetadata', () => {
      const newSrc = video.currentSrc || video.src;
      if (newSrc) reportVideo(newSrc, getVideoMeta(video));
    }, { once: true });

    // Listen for play to catch lazy-loaded sources
    video.addEventListener('playing', () => {
      const newSrc = video.currentSrc || video.src;
      if (newSrc) reportVideo(newSrc, getVideoMeta(video));
    }, { once: true });
  }

  /* ── DOM Scanning ── */

  function scanForVideos(root) {
    if (!root) return;

    // 1. <video> elements
    const videos = root.querySelectorAll ? root.querySelectorAll('video') : [];
    videos.forEach(processVideoElement);

    // 2. Elements with video data attributes
    if (root.querySelectorAll) {
      root.querySelectorAll('[data-src], [data-video-src], [data-video-url], [data-video]').forEach(el => {
        const src = el.dataset.src || el.dataset.videoSrc || el.dataset.videoUrl || el.dataset.video;
        if (src && isVideoUrl(src)) reportVideo(src, { source: 'data-attr' });
      });

      // 3. <object> and <embed> elements with video sources
      root.querySelectorAll('object[data], embed[src]').forEach(el => {
        const src = el.data || el.src;
        if (src && isVideoUrl(src)) reportVideo(src, { source: 'embed' });
      });
    }

    // 4. Same-origin iframes
    if (root.querySelectorAll) {
      root.querySelectorAll('iframe').forEach(iframe => {
        try {
          if (iframe.contentDocument) {
            scanForVideos(iframe.contentDocument);
          }
        } catch (e) { /* cross-origin */ }
      });
    }

    // 5. Shadow DOM
    if (root.querySelectorAll) {
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          scanForVideos(el.shadowRoot);
        }
      });
    }
  }

  /* ── MutationObserver for Dynamic Content ── */

  const domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.tagName === 'VIDEO') {
            processVideoElement(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(processVideoElement);
            // Check shadow roots
            if (node.shadowRoot) scanForVideos(node.shadowRoot);
            node.querySelectorAll('*').forEach(el => {
              if (el.shadowRoot) scanForVideos(el.shadowRoot);
            });
          }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target.tagName === 'VIDEO') {
          // Re-process if src changed
          seenElements.delete(target);
          processVideoElement(target);
        }
      }
    }
  });

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'data-src', 'data-video-src']
  });

  /* ── DRM Detection ── */

  document.addEventListener('encrypted', (e) => {
    const video = e.target;
    if (video?.tagName === 'VIDEO') {
      const src = video.currentSrc || video.src;
      if (src) {
        try {
          chrome.runtime.sendMessage({ type: 'drm-detected', url: src });
        } catch (e) { /* context invalidated */ }
      }
    }
  }, true);

  /* ── Periodic Polling Fallback ── */

  let pollCount = 0;
  const pollInterval = setInterval(() => {
    scanForVideos(document);
    pollCount++;
    if (pollCount >= 20) { // ~60 seconds
      clearInterval(pollInterval);
    }
  }, 3000);

  /* ── Handle Messages from Service Worker ── */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'fetch-blob' && msg.url) {
      fetch(msg.url)
        .then(res => res.blob())
        .then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => sendResponse({ dataUrl: reader.result });
          reader.onerror = () => sendResponse({ error: 'FileReader failed' });
          reader.readAsDataURL(blob);
        })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.type === 'download-via-page') {
      // Download through the page context (inherits cookies/auth)
      fetch(msg.url)
        .then(res => res.blob())
        .then(blob => {
          // If file is suspiciously small (< 50KB), it's likely a DASH init
          // segment, not a real video. Report failure so service worker can
          // try the next strategy.
          if (blob.size < 50000) {
            sendResponse({ error: 'File too small (' + blob.size + ' bytes) — likely a DASH segment, not a full video' });
            return;
          }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = msg.filename || 'video.mp4';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          sendResponse({ ok: true, size: blob.size });
        })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.type === 'record-video') {
      // Last resort for blob URLs: find the video element and record it
      const videos = document.querySelectorAll('video');
      let targetVideo = null;

      // Find the video with the matching blob URL
      for (const v of videos) {
        if ((v.currentSrc || v.src) === msg.blobUrl) {
          targetVideo = v;
          break;
        }
      }

      // If no exact match, use the largest playing video
      if (!targetVideo) {
        let maxArea = 0;
        for (const v of videos) {
          const area = v.videoWidth * v.videoHeight;
          if (area > maxArea && !v.paused) {
            maxArea = area;
            targetVideo = v;
          }
        }
      }

      if (!targetVideo) {
        // Pick the largest video element period
        let maxArea = 0;
        for (const v of videos) {
          const area = (v.videoWidth || v.offsetWidth) * (v.videoHeight || v.offsetHeight);
          if (area > maxArea) {
            maxArea = area;
            targetVideo = v;
          }
        }
      }

      if (targetVideo) {
        try {
          const stream = targetVideo.captureStream();
          // Prefer MP4 if supported, fall back to WebM
          const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
            ? 'video/mp4;codecs=avc1' : 'video/webm';
          const ext = mimeType.startsWith('video/mp4') ? '.mp4' : '.webm';
          const recorder = new MediaRecorder(stream, { mimeType });
          const chunks = [];

          recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = () => {
            const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = (msg.filename || 'video').replace(/\.[^.]+$/, '') + ext;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            sendResponse({ ok: true, method: 'record' });
          };

          // Mute to avoid sound while recording
          const origMuted = targetVideo.muted;
          targetVideo.muted = true;
          targetVideo.currentTime = 0;
          targetVideo.play();
          recorder.start(1000);

          targetVideo.addEventListener('ended', () => {
            recorder.stop();
            targetVideo.muted = origMuted;
          }, { once: true });

          // Safety timeout
          const duration = targetVideo.duration || 3600;
          setTimeout(() => {
            if (recorder.state === 'recording') {
              recorder.stop();
              targetVideo.muted = origMuted;
            }
          }, (duration + 5) * 1000);
        } catch (e) {
          sendResponse({ error: 'Recording failed: ' + e.message });
        }
      } else {
        sendResponse({ error: 'No video element found' });
      }
      return true;
    }
  });

  /* ── Listen for Messages from MAIN World ── */
  /* video-detector-main.js is injected via manifest at document_start */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__ARC_VIDEO_FOUND__' && event.data.url) {
      reportVideo(event.data.url, { source: 'network-intercept' });
    }
  });

  /* ── Initial Scan ── */

  function initialScan() {
    scanForVideos(document);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initialScan();
  } else {
    document.addEventListener('DOMContentLoaded', initialScan);
  }

  // Also scan after full page load for lazy content
  window.addEventListener('load', () => {
    setTimeout(initialScan, 1000);
  }, { once: true });
})();
