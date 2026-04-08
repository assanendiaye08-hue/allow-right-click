/* ─── Video Detector — MAIN World Script ─── */
/* Runs in the page's JS context to intercept fetch, XHR,
   MediaElement.src, and API responses for video URL detection. */

(function () {
  'use strict';

  if (window.__arcVideoDetectorMain) return;
  window.__arcVideoDetectorMain = true;

  const VIDEO_URL_RE = /\.(mp4|webm|m3u8|mpd|m4v|ogg|ogv|mov|mkv|flv|avi)(\?|#|$)/i;
  const VIDEO_MIME_RE = /^(video\/|application\/x-mpegURL|application\/dash\+xml|application\/vnd\.apple\.mpegurl)/i;

  // URLs that are DASH/CMAF segments (NOT complete videos — skip these)
  const SEGMENT_INDICATORS = /\/(range\/|seg-|chunk-|fragment|init[.-])|stypmsdh|ftypiso5.*cmf2/i;

  function reportUrl(url, meta) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('data:') && !url.startsWith('data:video')) return;
    if (url.length < 10) return;
    window.postMessage({ type: '__ARC_VIDEO_FOUND__', url, meta }, '*');
  }

  /* ── 1. Intercept fetch() — check requests AND responses ── */

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = _fetch.apply(this, arguments);

    try {
      const reqUrl = typeof input === 'string' ? input
        : (input instanceof Request ? input.url : String(input));

      // Don't report DASH segment URLs — they're tiny fragments, not full videos
      if (VIDEO_URL_RE.test(reqUrl) && !SEGMENT_INDICATORS.test(reqUrl)) {
        reportUrl(reqUrl);
      }

      // Parse API responses for embedded video URLs (Twitter, etc.)
      promise.then(async response => {
        try {
          const resUrl = response.url || reqUrl;

          // Check content-type for direct video responses
          const ct = response.headers.get('content-type');
          if (ct && VIDEO_MIME_RE.test(ct) && !SEGMENT_INDICATORS.test(resUrl)) {
            reportUrl(resUrl);
          }

          // Twitter/X GraphQL API — extract video variants
          if (/\/graphql\//i.test(resUrl) || /\/TweetResultByRestId/i.test(resUrl) ||
              /\/TweetDetail/i.test(resUrl) || /\/UserTweets/i.test(resUrl) ||
              /\/HomeTimeline/i.test(resUrl) || /\/SearchTimeline/i.test(resUrl) ||
              /api\.x\.com|api\.twitter\.com/i.test(resUrl)) {
            if (ct && ct.includes('json')) {
              const clone = response.clone();
              clone.text().then(text => extractVideoUrlsFromJson(text)).catch(() => {});
            }
          }

          // Facebook/Instagram API
          if (/\/api\/graphql/i.test(resUrl) || /\/graphql/i.test(resUrl)) {
            if (ct && ct.includes('json')) {
              const clone = response.clone();
              clone.text().then(text => extractVideoUrlsFromJson(text)).catch(() => {});
            }
          }
        } catch (e) { /* ignore */ }
      }).catch(() => {});
    } catch (e) { /* ignore */ }

    return promise;
  };

  /* ── 2. Extract video URLs from API JSON responses ── */

  function extractVideoUrlsFromJson(text) {
    // Method 1: Find video_info.variants (Twitter format)
    // These contain progressive MP4 URLs that are complete, downloadable files
    const variantRegex = /"url"\s*:\s*"(https?:[^"]*(?:\/vid\/|video\.twimg|\/videos\/|fbcdn)[^"]*\.mp4[^"]*)"/gi;
    let match;
    while ((match = variantRegex.exec(text))) {
      let url = match[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      // Skip DASH/CMAF segment URLs — only want progressive (complete) MP4s
      if (!SEGMENT_INDICATORS.test(url) && url.length > 50) {
        reportUrl(url, { source: 'api', progressive: true });
      }
    }

    // Method 2: Find playback_url, video_url, content_url patterns
    const urlPatterns = [
      /"playback_url"\s*:\s*"(https?:[^"]+)"/gi,
      /"video_url"\s*:\s*"(https?:[^"]+)"/gi,
      /"content_url"\s*:\s*"(https?:[^"]+)"/gi,
      /"base_url"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/gi,
      /"browser_native_(?:hd|sd)_url"\s*:\s*"(https?:[^"]+)"/gi,
    ];

    for (const pattern of urlPatterns) {
      while ((match = pattern.exec(text))) {
        let url = match[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
        if (VIDEO_URL_RE.test(url) && !SEGMENT_INDICATORS.test(url)) {
          reportUrl(url, { source: 'api', progressive: true });
        }
      }
    }

    // Method 3: Find bitrate-sorted variants (Twitter specific)
    // Look for the highest bitrate progressive MP4
    try {
      const parsed = JSON.parse(text);
      findVideoVariantsDeep(parsed);
    } catch (e) { /* not valid JSON or too large */ }
  }

  function findVideoVariantsDeep(obj, depth = 0) {
    if (depth > 15 || !obj || typeof obj !== 'object') return;

    // Twitter video_info.variants
    if (Array.isArray(obj.variants)) {
      const mp4Variants = obj.variants
        .filter(v => v.url && v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (mp4Variants.length > 0) {
        // Report the highest quality MP4
        const best = mp4Variants[0];
        const url = best.url.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
        reportUrl(url, {
          source: 'api-variant',
          progressive: true,
          bitrate: best.bitrate,
          quality: 'highest'
        });
      }
    }

    // Recurse into object properties
    if (Array.isArray(obj)) {
      for (const item of obj) findVideoVariantsDeep(item, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        if (key === 'video_info' || key === 'variants' || key === 'media' ||
            key === 'extended_entities' || key === 'legacy' || key === 'result' ||
            key === 'tweet_results' || key === 'entries' || key === 'content' ||
            key === 'tweet' || key === 'core' || key === 'data' || key === 'user' ||
            key === 'timeline' || key === 'instructions') {
          findVideoVariantsDeep(obj[key], depth + 1);
        }
      }
    }
  }

  /* ── 3. Intercept XMLHttpRequest ── */

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__arcUrl = typeof url === 'string' ? url : String(url);
    if (VIDEO_URL_RE.test(this.__arcUrl) && !SEGMENT_INDICATORS.test(this.__arcUrl)) {
      reportUrl(this.__arcUrl);
    }
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const url = this.__arcUrl || '';
        // Parse API responses
        if (/graphql|api\.(x|twitter)\.com/i.test(url)) {
          const ct = this.getResponseHeader('content-type');
          if (ct && ct.includes('json') && this.responseText) {
            extractVideoUrlsFromJson(this.responseText);
          }
        }
      } catch (e) { /* ignore */ }
    });
    return _xhrSend.apply(this, arguments);
  };

  /* ── 4. Intercept HTMLMediaElement.prototype.src setter ── */

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

  /* ── 5. Intercept HTMLSourceElement.prototype.src setter ── */

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

  /* ── 6. Intercept URL.createObjectURL to track blob mapping ── */

  try {
    const _createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = _createObjectURL.call(this, obj);
      if (obj instanceof MediaSource ||
          (obj instanceof Blob && VIDEO_MIME_RE.test(obj.type))) {
        reportUrl(url);
      }
      return url;
    };
  } catch (e) { /* ignore */ }
})();
