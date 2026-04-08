/* ─── Video Detector — MAIN World Script ─── */
/* Runs in the page's JS context to intercept fetch, XHR,
   and MediaElement.src assignments for video URL detection. */

(function () {
  'use strict';

  if (window.__arcVideoDetectorMain) return;
  window.__arcVideoDetectorMain = true;

  const VIDEO_URL_RE = /\.(mp4|webm|m3u8|mpd|m4v|ogg|ogv|mov|mkv|flv|avi)(\?|#|$)/i;
  const VIDEO_MIME_RE = /^(video\/|application\/x-mpegURL|application\/dash\+xml|application\/vnd\.apple\.mpegurl)/i;

  function reportUrl(url) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('data:') && !url.startsWith('data:video')) return;
    if (url.length < 10) return; // skip garbage
    window.postMessage({ type: '__ARC_VIDEO_FOUND__', url }, '*');
  }

  /* ── 1. Intercept fetch() ── */

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input
        : (input instanceof Request ? input.url : String(input));
      if (VIDEO_URL_RE.test(url)) {
        reportUrl(url);
      }
    } catch (e) { /* ignore */ }
    return _fetch.apply(this, arguments);
  };

  /* ── 2. Intercept XMLHttpRequest.open() ── */

  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (VIDEO_URL_RE.test(urlStr)) {
        reportUrl(urlStr);
      }
    } catch (e) { /* ignore */ }
    return _xhrOpen.apply(this, arguments);
  };

  /* ── 3. Intercept HTMLMediaElement.prototype.src setter ── */

  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get: desc.get,
        set(value) {
          if (value && typeof value === 'string') {
            reportUrl(value);
          }
          return desc.set.call(this, value);
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) { /* ignore */ }

  /* ── 4. Intercept HTMLSourceElement.prototype.src setter ── */

  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLSourceElement.prototype, 'src', {
        get: desc.get,
        set(value) {
          if (value && typeof value === 'string' && VIDEO_URL_RE.test(value)) {
            reportUrl(value);
          }
          return desc.set.call(this, value);
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) { /* ignore */ }

  /* ── 5. Intercept URL.createObjectURL to track blob mapping ── */

  try {
    const _createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = _createObjectURL.call(this, obj);
      // If a MediaSource or Blob that looks like video, report it
      if (obj instanceof MediaSource ||
          (obj instanceof Blob && VIDEO_MIME_RE.test(obj.type))) {
        reportUrl(url);
      }
      return url;
    };
  } catch (e) { /* ignore */ }

  /* ── 6. Monitor Response headers in fetch for video content-type ── */

  // Wrap fetch response to check content-type headers
  const _fetchOriginal = _fetch; // use our saved reference
  window.fetch = function (input, init) {
    const promise = _fetchOriginal.apply(this, arguments);
    promise.then(response => {
      try {
        const ct = response.headers.get('content-type');
        if (ct && VIDEO_MIME_RE.test(ct)) {
          reportUrl(response.url || (typeof input === 'string' ? input : input?.url));
        }
      } catch (e) { /* ignore */ }
    }).catch(() => {});
    return promise;
  };
})();
