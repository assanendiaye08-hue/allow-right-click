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
  // Google Docs renders text on canvas and uses custom selection.
  // When "Viewers can't copy" is enabled, the JS copy handler is blocked.
  // The text content lives in hidden accessibility spans we can extract.

  if (location.hostname === 'docs.google.com') {
    // Add a "Copy All Text" button to the page for protected docs
    const isViewOnly = !!document.querySelector('.docs-title-save-label-saving-disabled') ||
                       document.querySelector('[aria-label="Document status: View only"]') !== null ||
                       document.body.classList.contains('view-only-mode') ||
                       !!document.querySelector('.app-viewmode');

    // Extract text from Google Docs DOM structure
    function extractGoogleDocsText() {
      // Method 1: Get text from kix spans (Google Docs editor)
      const kixSpans = document.querySelectorAll(
        '.kix-wordhtmlgenerator-word-node, ' +
        '.kix-lineview-text-block, ' +
        '[class*="kix-lineview"] span'
      );
      if (kixSpans.length > 0) {
        const lines = [];
        let currentLine = '';
        const lineViews = document.querySelectorAll('.kix-lineview');
        if (lineViews.length > 0) {
          lineViews.forEach(line => {
            const text = line.textContent || '';
            if (text.trim()) lines.push(text);
          });
        } else {
          kixSpans.forEach(span => {
            currentLine += span.textContent;
          });
          if (currentLine) lines.push(currentLine);
        }
        return lines.join('\n');
      }

      // Method 2: Get text from the document content wrapper
      const contentWrapper = document.querySelector(
        '.kix-appview-editor, ' +
        '.docs-texteventtarget-iframe, ' +
        '[contenteditable="true"]'
      );
      if (contentWrapper) {
        return contentWrapper.textContent || '';
      }

      // Method 3: Try getting from accessibility tree
      const pages = document.querySelectorAll('.kix-page');
      if (pages.length > 0) {
        return Array.from(pages).map(p => p.textContent).join('\n\n');
      }

      return '';
    }

    // Override Ctrl+C / Cmd+C to actually copy the selected/all text
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const selection = window.getSelection();
        let text = selection?.toString();

        if (!text || text.trim() === '') {
          // No selection — try extracting from Google Docs DOM
          text = extractGoogleDocsText();
        }

        if (text && text.trim()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          navigator.clipboard.writeText(text).catch(() => {
            // Fallback: use textarea trick
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          });
        }
      }
    }, true);

    // Also hook Ctrl+A to select all text visually
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // Let the default Ctrl+A work, but also make sure text is selectable
        const pages = document.querySelectorAll('.kix-page-content-wrapper, .kix-page');
        pages.forEach(p => {
          p.style.setProperty('user-select', 'text', 'important');
          p.style.setProperty('-webkit-user-select', 'text', 'important');
        });
      }
    }, true);

    // Make the Google Docs content selectable
    const docsStyle = document.createElement('style');
    docsStyle.textContent = `
      .kix-page-content-wrapper,
      .kix-page,
      .kix-lineview,
      .kix-wordhtmlgenerator-word-node,
      .kix-paragraphrenderer,
      .kix-lineview-text-block {
        user-select: text !important;
        -webkit-user-select: text !important;
        pointer-events: auto !important;
      }
      .kix-selection-overlay {
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(docsStyle);
    cleanups.push(() => docsStyle.remove());
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
