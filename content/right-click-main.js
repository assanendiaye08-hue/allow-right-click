/* ─── Allow Right Click — MAIN World Script ─── */
/* Runs in the page's JS context to override addEventListener,
   event handler properties, and install capture-phase unblocking. */

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__arcRightClickMain) return;
  window.__arcRightClickMain = true;

  const BLOCKED_EVENTS = new Set([
    'contextmenu', 'copy', 'cut', 'paste', 'selectstart',
    'mousedown', 'mouseup', 'dragstart', 'drag'
  ]);

  // Events where we should fully prevent the page from blocking
  const FULL_BLOCK = new Set(['contextmenu', 'copy', 'cut', 'paste', 'selectstart', 'dragstart']);

  /* ── 1. Override EventTarget.prototype.addEventListener ── */

  const _addEventListener = EventTarget.prototype.addEventListener;
  const _removeEventListener = EventTarget.prototype.removeEventListener;

  // Map original listeners to wrapped versions for clean removal
  const listenerMap = new WeakMap();

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!BLOCKED_EVENTS.has(type) || typeof listener !== 'function') {
      return _addEventListener.call(this, type, listener, options);
    }

    const wrapped = function (e) {
      // For fully blocked events, neuter the listener entirely
      if (FULL_BLOCK.has(type)) return;

      // For partially blocked events (mousedown/mouseup), let the listener run
      // but prevent it from blocking the event
      const proxy = new Proxy(e, {
        get(target, prop) {
          if (prop === 'preventDefault') return () => {};
          if (prop === 'stopPropagation') return () => {};
          if (prop === 'stopImmediatePropagation') return () => {};
          if (prop === 'returnValue') return true;
          const val = Reflect.get(target, prop);
          return typeof val === 'function' ? val.bind(target) : val;
        },
        set(target, prop, value) {
          if (prop === 'returnValue') return true;
          target[prop] = value;
          return true;
        }
      });

      try {
        listener.call(this, proxy);
      } catch (err) { /* swallow page script errors */ }
    };

    // Store mapping for potential removeEventListener
    if (!listenerMap.has(listener)) listenerMap.set(listener, new Map());
    listenerMap.get(listener).set(type, wrapped);

    return _addEventListener.call(this, type, wrapped, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (BLOCKED_EVENTS.has(type) && listenerMap.has(listener)) {
      const wrapped = listenerMap.get(listener).get(type);
      if (wrapped) {
        listenerMap.get(listener).delete(type);
        return _removeEventListener.call(this, type, wrapped, options);
      }
    }
    return _removeEventListener.call(this, type, listener, options);
  };

  /* ── 2. Override on<event> Property Setters ── */

  const targets = [document, document.documentElement, window];
  if (document.body) targets.push(document.body);

  const ON_PROPERTIES = [
    'oncontextmenu', 'oncopy', 'oncut', 'onpaste',
    'onselectstart', 'ondragstart'
  ];

  for (const target of targets) {
    for (const prop of ON_PROPERTIES) {
      try {
        Object.defineProperty(target, prop, {
          get() { return null; },
          set() { return true; },
          configurable: true
        });
      } catch (e) { /* non-configurable */ }
    }
  }

  /* ── 3. Capture-Phase Listeners to Ensure Events Propagate ── */

  function captureHandler(e) {
    // Remove preventDefault/stopPropagation from the event for this phase
    Object.defineProperties(e, {
      'returnValue': { get: () => true, set: () => {}, configurable: true },
    });
    // Prevent the page's capture-phase listeners from blocking
    e.stopPropagation = () => {};
    e.stopImmediatePropagation = () => {};
    e.preventDefault = () => {};
  }

  for (const eventType of FULL_BLOCK) {
    _addEventListener.call(document, eventType, captureHandler, true);
  }

  /* ── 4. Override document.onmousedown if it blocks right-click ── */

  try {
    const origOnMouseDown = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onmousedown');
    if (origOnMouseDown) {
      Object.defineProperty(HTMLElement.prototype, 'onmousedown', {
        get() { return origOnMouseDown.get?.call(this); },
        set(fn) {
          if (typeof fn !== 'function') {
            return origOnMouseDown.set?.call(this, fn);
          }
          // Wrap to prevent right-click blocking
          const wrapped = function (e) {
            if (e.button === 2) return; // don't block right-click
            return fn.call(this, e);
          };
          return origOnMouseDown.set?.call(this, wrapped);
        },
        configurable: true
      });
    }
  } catch (e) { /* ignore */ }

  /* ── 5. Remove 'unselectable' attribute handling ── */

  try {
    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (name === 'unselectable' || name === 'oncontextmenu' ||
          name === 'onselectstart' || name === 'oncopy') {
        return; // silently ignore
      }
      return origSetAttr.call(this, name, value);
    };
  } catch (e) { /* ignore */ }

  /* ── 6. Signal readiness ── */

  window.postMessage({ type: '__ARC_MAIN_READY__' }, '*');

  /* ── 7. Listen for cleanup signal ── */

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.type === '__ARC_DISABLE_MAIN__') {
      // Restore original addEventListener
      EventTarget.prototype.addEventListener = _addEventListener;
      EventTarget.prototype.removeEventListener = _removeEventListener;
      // Remove capture handlers
      for (const eventType of FULL_BLOCK) {
        _removeEventListener.call(document, eventType, captureHandler, true);
      }
      window.__arcRightClickMain = false;
    }
  });
})();
