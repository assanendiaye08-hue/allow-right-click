/* ─── Allow Right Click — ISOLATED World Content Script ─── */
/* Handles CSS overrides, DOM attribute cleanup, and overlay removal.
   Always active on every page via manifest content_scripts. */

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__arcRightClickIsolated) return;
  window.__arcRightClickIsolated = true;

  const cleanups = [];

  /* ── 1. CSS Injection ── */

  const style = document.createElement('style');
  style.id = '__arc-right-click-styles';
  style.textContent = `
    *, *::before, *::after {
      -webkit-user-select: auto !important;
      -moz-user-select: auto !important;
      -ms-user-select: auto !important;
      user-select: auto !important;
    }
    [oncontextmenu], [onselectstart], [oncopy], [oncut], [onpaste] {
      -webkit-user-select: auto !important;
      user-select: auto !important;
    }
    .copy-protection-on, .copy-protection-on * {
      pointer-events: auto !important;
      user-select: auto !important;
    }
    ::-moz-selection {
      color: #000 !important;
      background: #accef7 !important;
    }
    ::selection {
      color: #000 !important;
      background: #accef7 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  cleanups.push(() => style.remove());

  /* ── 2. Remove Inline Event Handlers ── */

  const BLOCKED_ATTRS = [
    'oncontextmenu', 'onselectstart', 'oncopy', 'oncut', 'onpaste',
    'onmousedown', 'onmouseup', 'ondragstart', 'ondrag'
  ];

  function cleanElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of BLOCKED_ATTRS) {
      if (el.hasAttribute(attr)) {
        el.removeAttribute(attr);
      }
      // Also clear the JS property
      try { el[attr] = null; } catch (e) { /* read-only */ }
    }
    // Fix inline styles that block interaction
    if (el.style) {
      if (el.style.userSelect === 'none' || el.style.webkitUserSelect === 'none') {
        el.style.userSelect = '';
        el.style.webkitUserSelect = '';
      }
    }
  }

  function cleanAllElements() {
    cleanElement(document.documentElement);
    if (document.body) cleanElement(document.body);

    const selector = BLOCKED_ATTRS.map(a => `[${a}]`).join(',');
    document.querySelectorAll(selector).forEach(cleanElement);

    // Also clean elements with pointer-events: none on media
    document.querySelectorAll('img, canvas, video, picture, svg').forEach(el => {
      const computed = getComputedStyle(el);
      if (computed.pointerEvents === 'none') {
        el.style.setProperty('pointer-events', 'auto', 'important');
      }
    });
  }

  cleanAllElements();

  /* ── 3. Remove Transparent Overlays ── */

  function removeOverlays() {
    const candidates = document.querySelectorAll('div, span, section, aside');
    for (const el of candidates) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') continue;

      const opacity = parseFloat(s.opacity);
      const bg = s.backgroundColor;
      const isTransparent = opacity === 0 ||
        bg === 'transparent' ||
        bg === 'rgba(0, 0, 0, 0)' ||
        (opacity < 0.05 && el.children.length === 0);

      if (!isTransparent) continue;

      // Large overlays covering the page
      const isLargeEnough = el.offsetWidth > window.innerWidth * 0.4 &&
                            el.offsetHeight > window.innerHeight * 0.4;

      // Overlays sitting on top of media (video, img, canvas)
      const parent = el.parentElement;
      const coversMedia = parent && (
        parent.querySelector('video, img, canvas, picture') !== null
      );

      if (isLargeEnough || coversMedia) {
        el.style.setProperty('pointer-events', 'none', 'important');
      }
    }
  }

  removeOverlays();

  /* ── 4. MutationObserver ── */

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          cleanElement(node);
          if (node.querySelectorAll) {
            const selector = BLOCKED_ATTRS.map(a => `[${a}]`).join(',');
            node.querySelectorAll(selector).forEach(cleanElement);
          }
        }
      } else if (mutation.type === 'attributes') {
        cleanElement(mutation.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...BLOCKED_ATTRS, 'style']
  });

  cleanups.push(() => observer.disconnect());

  /* ── 5. Re-enable mouse events on media under overlays ── */
  // When right-clicking, temporarily fix pointer-events on nearby media

  function unblockMediaAtPoint(e) {
    if (e.button !== 2) return; // only right-click
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const media = elements.filter(el =>
      el.tagName === 'IMG' || el.tagName === 'VIDEO' ||
      el.tagName === 'CANVAS' || el.tagName === 'PICTURE'
    );

    if (media.length === 0) return;

    // Temporarily disable pointer-events on overlays above the media
    const restored = [];
    for (const el of elements) {
      if (media.includes(el)) break;
      if (el.dataset && !el.dataset.__arcPointerFixed) {
        el.dataset.__arcPointerFixed = '1';
        const prev = el.style.pointerEvents;
        el.style.setProperty('pointer-events', 'none', 'important');
        restored.push({ el, prev });
      }
    }

    // Restore after a short delay
    setTimeout(() => {
      for (const { el, prev } of restored) {
        el.style.pointerEvents = prev;
        delete el.dataset.__arcPointerFixed;
      }
    }, 500);
  }

  document.addEventListener('mousedown', unblockMediaAtPoint, true);
  cleanups.push(() => document.removeEventListener('mousedown', unblockMediaAtPoint, true));

  /* ── 6. Handle background images — expose on right-click ── */

  document.addEventListener('contextmenu', (e) => {
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elements) {
      const s = getComputedStyle(el);
      const bgImg = s.backgroundImage;
      if (bgImg && bgImg !== 'none') {
        const match = bgImg.match(/url\(["']?(.*?)["']?\)/);
        if (match && match[1]) {
          // Create a temporary invisible image so the browser context menu
          // can offer "Save Image As..."
          const img = new Image();
          img.src = match[1];
          img.style.cssText = `
            position: fixed;
            left: ${e.clientX - 2}px;
            top: ${e.clientY - 2}px;
            width: 4px; height: 4px;
            opacity: 0.01;
            z-index: 2147483647;
            pointer-events: auto;
          `;
          document.body.appendChild(img);
          setTimeout(() => img.remove(), 1000);
          break;
        }
      }
    }
  }, true);

  /* ── 7. Google Docs Copy-Protection Bypass ── */
  // Google Docs renders text on CANVAS — DOM extraction doesn't work.
  // The working approach: redirect to /mobilebasic view which renders
  // as plain HTML where our normal copy/select unblocking works.
  // Also fetch doc content via export URL as a fallback.

  if (location.hostname === 'docs.google.com') {
    const docIdMatch = location.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    const docId = docIdMatch ? docIdMatch[1] : null;
    const isMobileBasic = location.pathname.includes('/mobilebasic');

    // On /mobilebasic view: just make sure copy/select works (our CSS already handles this)
    if (isMobileBasic) {
      const mbStyle = document.createElement('style');
      mbStyle.textContent = `
        * {
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
        }
        body { cursor: text !important; }
      `;
      (document.head || document.documentElement).appendChild(mbStyle);
      cleanups.push(() => mbStyle.remove());
    }

    // On normal /edit or /preview view: add helper UI
    if (docId && !isMobileBasic) {
      // Wait for the page to load before adding UI
      const addDocsUI = () => {
        // Don't add twice
        if (document.getElementById('__arc-gdocs-bar')) return;

        // Create a floating bar at the top
        const bar = document.createElement('div');
        bar.id = '__arc-gdocs-bar';
        bar.style.cssText = `
          position: fixed;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          z-index: 2147483647;
          background: #1a1a2e;
          color: #e0e0e0;
          padding: 8px 16px;
          border-radius: 0 0 10px 10px;
          font-family: -apple-system, sans-serif;
          font-size: 13px;
          display: flex;
          align-items: center;
          gap: 10px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.4);
          border: 1px solid #2a2a4a;
          border-top: none;
        `;

        const label = document.createElement('span');
        label.textContent = 'Copy protected — ';
        label.style.color = '#888';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy All Text';
        copyBtn.style.cssText = `
          background: #e94560;
          color: white;
          border: none;
          padding: 5px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        `;
        copyBtn.addEventListener('click', async () => {
          copyBtn.textContent = 'Fetching...';
          const text = await fetchDocText(docId);
          if (text) {
            await copyToClipboard(text);
            copyBtn.textContent = 'Copied!';
            copyBtn.style.background = '#4ade80';
          } else {
            copyBtn.textContent = 'Failed — try Mobile View';
            copyBtn.style.background = '#666';
          }
          setTimeout(() => {
            copyBtn.textContent = 'Copy All Text';
            copyBtn.style.background = '#e94560';
          }, 3000);
        });

        const mobileBtn = document.createElement('button');
        mobileBtn.textContent = 'Open Mobile View';
        mobileBtn.title = 'Opens a copyable plain-text version of this document';
        mobileBtn.style.cssText = `
          background: transparent;
          color: #60a5fa;
          border: 1px solid #60a5fa;
          padding: 5px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
        `;
        mobileBtn.addEventListener('click', () => {
          window.open(
            `https://docs.google.com/document/d/${docId}/mobilebasic`,
            '_blank'
          );
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00d7';
        closeBtn.style.cssText = `
          background: none;
          border: none;
          color: #666;
          font-size: 18px;
          cursor: pointer;
          padding: 0 4px;
          margin-left: 4px;
        `;
        closeBtn.addEventListener('click', () => bar.remove());

        bar.appendChild(label);
        bar.appendChild(copyBtn);
        bar.appendChild(mobileBtn);
        bar.appendChild(closeBtn);
        document.body.appendChild(bar);
        cleanups.push(() => bar.remove());
      };

      // Fetch document text via multiple methods
      async function fetchDocText(id) {
        // Method 1: Export as plain text
        try {
          const resp = await fetch(
            `https://docs.google.com/document/d/${id}/export?format=txt`,
            { credentials: 'include' }
          );
          if (resp.ok) {
            const text = await resp.text();
            if (text && text.length > 10) return text;
          }
        } catch (e) { /* blocked */ }

        // Method 2: Export as HTML and extract text
        try {
          const resp = await fetch(
            `https://docs.google.com/document/d/${id}/export?format=html`,
            { credentials: 'include' }
          );
          if (resp.ok) {
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const text = doc.body?.textContent;
            if (text && text.length > 10) return text;
          }
        } catch (e) { /* blocked */ }

        // Method 3: Fetch mobilebasic and extract text
        try {
          const resp = await fetch(
            `https://docs.google.com/document/d/${id}/mobilebasic`,
            { credentials: 'include' }
          );
          if (resp.ok) {
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const text = doc.body?.textContent;
            if (text && text.length > 10) return text;
          }
        } catch (e) { /* blocked */ }

        // Method 4: Try extracting from current DOM (kix spans, accessibility)
        const kixLines = document.querySelectorAll('.kix-lineview');
        if (kixLines.length > 0) {
          const text = Array.from(kixLines).map(l => l.textContent).join('\n');
          if (text.trim().length > 0) return text;
        }

        const pages = document.querySelectorAll('.kix-page');
        if (pages.length > 0) {
          const text = Array.from(pages).map(p => p.textContent).join('\n\n');
          if (text.trim().length > 0) return text;
        }

        return null;
      }

      async function copyToClipboard(text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
      }

      // Add UI after page loads
      if (document.readyState === 'complete') {
        setTimeout(addDocsUI, 1000);
      } else {
        window.addEventListener('load', () => setTimeout(addDocsUI, 1000), { once: true });
      }

      // Also try Ctrl+C override using fetched content
      document.addEventListener('keydown', async (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          const selection = window.getSelection()?.toString();
          if (!selection || selection.trim() === '') {
            e.preventDefault();
            e.stopImmediatePropagation();
            const text = await fetchDocText(docId);
            if (text) {
              await copyToClipboard(text);
            }
          }
        }
      }, true);
    }
  }

  /* ── 8. Disable Message Listener ── */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'disable-right-click') {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
      window.__arcRightClickIsolated = false;
    }
  });
})();
