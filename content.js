// content.js — Page Watchdog v2.0 content script
// Auto-injected on all pages via manifest content_scripts

(function () {
  if (window.__watchdogLoaded) return;
  window.__watchdogLoaded = true;

  const activeWatchers = new Map(); // watcherId -> { observer, pollTimer, lastSnapshot, debounceTimer, selector, mode }
  let pickMode = false;
  let pickerOverlay = null;
  let pickerHighlight = null;
  let floatingBadge = null;

  // ── Utilities ──────────────────────────────────────────────────
  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id && !el.id.startsWith('__watchdog')) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id && !cur.id.startsWith('__watchdog')) {
        sel = `#${cur.id}`;
        parts.unshift(sel);
        break;
      }
      if (cur.className && typeof cur.className === 'string') {
        const cls = [...cur.classList]
          .filter(c => !c.startsWith('__wd'))
          .slice(0, 2)
          .join('.');
        if (cls) sel += `.${cls}`;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
      if (cur === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ').slice(0, 120);
  }

  function getHumanLabel(el) {
    if (!el) return 'Unknown element';

    const tagMap = {
      DIV: 'Container', SECTION: 'Section', ARTICLE: 'Article',
      NAV: 'Navigation', HEADER: 'Header', FOOTER: 'Footer',
      MAIN: 'Main content', ASIDE: 'Sidebar', FORM: 'Form',
      UL: 'List', OL: 'Numbered list', LI: 'List item',
      TABLE: 'Table', TR: 'Table row', TD: 'Table cell', TH: 'Table header',
      P: 'Paragraph', SPAN: 'Text', A: 'Link',
      BUTTON: 'Button', INPUT: 'Input', TEXTAREA: 'Text area',
      SELECT: 'Dropdown', IMG: 'Image', VIDEO: 'Video',
      H1: 'Heading 1', H2: 'Heading 2', H3: 'Heading 3',
      H4: 'Heading 4', H5: 'Heading 5', H6: 'Heading 6',
      IFRAME: 'Embedded frame', DIALOG: 'Dialog'
    };

    const tag = tagMap[el.tagName] || el.tagName.toLowerCase();
    const parts = [tag];

    const aria = el.getAttribute('aria-label');
    if (aria) {
      parts.push(`"${aria.slice(0, 50)}"`);
      return `[${parts[0]}] ${parts[1]}`;
    }

    const title = el.getAttribute('title');
    if (title) {
      return `[${tag}] "${title.slice(0, 50)}"`;
    }

    const role = el.getAttribute('role');
    if (role) {
      parts[0] = role.charAt(0).toUpperCase() + role.slice(1);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      return `[${parts[0]}] "${placeholder.slice(0, 50)}"`;
    }

    // Get visible text content (not from children with lots of nesting)
    const text = (el.textContent || '').trim();
    if (text && text.length <= 60) {
      return `[${parts[0]}] "${text.slice(0, 50)}"`;
    } else if (text) {
      return `[${parts[0]}] "${text.slice(0, 50)}..."`;
    }

    return `[${parts[0]}]`;
  }

  function snapshot(selector) {
    try {
      if (selector) {
        const el = document.querySelector(selector);
        if (!el) return null;
        return el.childElementCount + '|' + el.innerText;
      }
      // Full page: exclude watchdog elements
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('[id^="__watchdog"]').forEach(n => n.remove());
      return clone.childElementCount + '|' + clone.innerText;
    } catch {
      return document.body.innerText;
    }
  }

  function extractPreview(oldSnap, newSnap) {
    if (!oldSnap || !newSnap) return 'Content appeared';
    const oldText = oldSnap.split('|').slice(1).join('|');
    const newText = newSnap.split('|').slice(1).join('|');

    if (oldText === newText) return 'Structure changed';

    // Short content: just show old → new
    if (newText.length < 100) {
      if (oldText.length < 100) return `${oldText} → ${newText}`;
      return newText || 'Content changed';
    }

    // Longer content: find newly added lines
    const oldLines = new Set(oldText.split('\n').map(l => l.trim()).filter(Boolean));
    const newLines = newText.split('\n').map(l => l.trim()).filter(Boolean);
    const added = newLines.filter(l => !oldLines.has(l));

    if (added.length > 0) {
      return added.slice(0, 3).join(' | ').slice(0, 200);
    }

    // Fallback: last line of new content
    if (newLines.length > 0) return newLines[newLines.length - 1].slice(0, 200);

    return 'Content changed';
  }

  function beep(style) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const play = (freq, start, dur, type = 'sine') => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq; o.type = type;
        g.gain.setValueAtTime(0, ctx.currentTime + start);
        g.gain.linearRampToValueAtTime(0.4, ctx.currentTime + start + 0.02);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + start + dur);
        o.start(ctx.currentTime + start);
        o.stop(ctx.currentTime + start + dur + 0.05);
      };
      if (style === 'chat') {
        play(880, 0, 0.15); play(1100, 0.18, 0.2);
      } else {
        play(523, 0, 0.2, 'triangle'); play(784, 0.25, 0.2, 'triangle'); play(1046, 0.5, 0.25, 'triangle');
      }
    } catch (e) {}
  }

  // ── Floating badge ────────────────────────────────────────────
  function updateBadge() {
    removeBadge();
    const count = activeWatchers.size;
    if (count === 0) return;

    const b = document.createElement('div');
    b.id = '__watchdog_badge__';
    b.style.cssText = `
      position: fixed; bottom: 18px; right: 18px;
      background: #00e5a0; color: #000;
      padding: 8px 14px 8px 10px; border-radius: 999px;
      font: 700 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      z-index: 2147483647;
      box-shadow: 0 4px 20px rgba(0,229,160,0.4);
      cursor: pointer; display: flex; align-items: center; gap: 7px;
      transition: background 0.3s; user-select: none;
      animation: __wd_pop 0.3s cubic-bezier(.34,1.56,.64,1);
    `;

    if (!document.getElementById('__watchdog_styles__')) {
      const style = document.createElement('style');
      style.id = '__watchdog_styles__';
      style.textContent = `
        @keyframes __wd_pop { from { transform: scale(0.5) translateY(20px); opacity:0; } to { transform: scale(1) translateY(0); opacity:1; } }
        @keyframes __wd_pulse { 0%,100%{opacity:1}50%{opacity:0.3} }
      `;
      document.head.appendChild(style);
    }

    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#000;display:inline-block;animation:__wd_pulse 2s infinite;';

    const label = document.createElement('span');
    label.id = '__watchdog_badge_label__';
    label.textContent = count === 1 ? 'Watching 1 element' : `Watching ${count} elements`;

    b.appendChild(dot);
    b.appendChild(label);
    b.title = 'Watchdog — click to view details';
    document.body.appendChild(b);
    floatingBadge = b;
  }

  function removeBadge() {
    const b = document.getElementById('__watchdog_badge__');
    if (b) b.remove();
    floatingBadge = null;
  }

  function flashBadge(watcherId) {
    const b = document.getElementById('__watchdog_badge__');
    if (!b) return;
    b.style.background = '#ff6b35';
    b.style.color = '#fff';
    const lbl = document.getElementById('__watchdog_badge_label__');
    if (lbl) lbl.textContent = 'Change detected!';
    setTimeout(() => {
      if (!b.parentElement) return;
      b.style.background = '#00e5a0';
      b.style.color = '#000';
      updateBadge();
    }, 3000);
  }

  // ── Change handler ────────────────────────────────────────────
  function onChanged(oldSnap, newSnap, watcherId) {
    const watcher = activeWatchers.get(watcherId);
    if (!watcher) return;
    watcher.changeCount = (watcher.changeCount || 0) + 1;

    const preview = extractPreview(oldSnap, newSnap);
    // Extract just the current text value from the snapshot
    const currentValue = newSnap ? newSnap.split('|').slice(1).join('|').trim() : '';
    beep(watcher.selector ? 'ticket' : 'chat');
    flashBadge(watcherId);
    chrome.runtime.sendMessage({
      type: 'CHANGE_DETECTED',
      watcherId,
      preview,
      currentValue: currentValue.slice(0, 300)
    });
  }

  // ── Start watching (single watcher) ───────────────────────────
  function startWatch(watcherId, selector, mode, pollInterval) {
    stopSingleWatch(watcherId);

    const watcherState = {
      selector: selector || null,
      mode,
      pollInterval: pollInterval || 30000,
      observer: null,
      pollTimer: null,
      lastSnapshot: null,
      debounceTimer: null,
      changeCount: 0
    };

    // Add to map and update badge BEFORE attaching observer
    // so badge DOM changes don't trigger a false first mutation
    activeWatchers.set(watcherId, watcherState);
    updateBadge();

    // Take initial snapshot AFTER badge is in the DOM
    watcherState.lastSnapshot = snapshot(selector);

    if (mode === 'mutation' || mode === 'both') {
      const target = selector ? document.querySelector(selector) : document.body;
      const watchTarget = target || document.body;
      watcherState.observer = new MutationObserver((mutations) => {
        // Filter out mutations on/within watchdog elements
        const relevant = mutations.filter(m => {
          // Check the mutation target and its ancestors
          let node = m.target;
          while (node && node !== document.body) {
            if (node.id && node.id.startsWith('__watchdog')) return false;
            if (node.nodeType === 1 && node.getAttribute && node.getAttribute('id')?.startsWith('__watchdog')) return false;
            node = node.parentElement || node.parentNode;
          }
          // Also check if added/removed nodes are watchdog elements
          for (const n of [...(m.addedNodes || []), ...(m.removedNodes || [])]) {
            if (n.id && n.id.startsWith('__watchdog')) return false;
          }
          return true;
        });
        if (relevant.length === 0) return;

        clearTimeout(watcherState.debounceTimer);
        watcherState.debounceTimer = setTimeout(() => {
          const cur = snapshot(selector);
          if (cur !== null && cur !== watcherState.lastSnapshot) {
            const old = watcherState.lastSnapshot;
            watcherState.lastSnapshot = cur;
            onChanged(old, cur, watcherId);
          }
        }, 400);
      });
      watcherState.observer.observe(watchTarget, { childList: true, subtree: true, characterData: true, attributes: true });
    }

    if (mode === 'poll' || mode === 'both') {
      const interval = pollInterval || 30000;
      watcherState.pollTimer = setInterval(() => {
        const cur = snapshot(selector);
        if (cur !== null && cur !== watcherState.lastSnapshot) {
          const old = watcherState.lastSnapshot;
          watcherState.lastSnapshot = cur;
          onChanged(old, cur, watcherId);
        }
      }, interval);
    }
  }

  // ── Stop single watcher ───────────────────────────────────────
  function stopSingleWatch(watcherId) {
    const w = activeWatchers.get(watcherId);
    if (!w) return;
    if (w.observer) { w.observer.disconnect(); w.observer = null; }
    if (w.pollTimer) { clearInterval(w.pollTimer); w.pollTimer = null; }
    clearTimeout(w.debounceTimer);
    activeWatchers.delete(watcherId);
    updateBadge();
  }

  // ── Stop all watchers ─────────────────────────────────────────
  function stopAllWatchers() {
    for (const id of activeWatchers.keys()) {
      stopSingleWatch(id);
    }
    stopPicker();
  }

  // ── Wait for element (persistent monitoring) ──────────────────
  function waitForElement(watcherId, selector, mode, pollInterval) {
    // Check immediately
    if (document.querySelector(selector)) {
      startWatch(watcherId, selector, mode, pollInterval);
      chrome.runtime.sendMessage({ type: 'WATCHER_REATTACHED', watcherId });
      return;
    }

    // Observe body for the element to appear
    let waitTimeout;
    const bodyObserver = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        bodyObserver.disconnect();
        clearTimeout(waitTimeout);
        startWatch(watcherId, selector, mode, pollInterval);
        chrome.runtime.sendMessage({ type: 'WATCHER_REATTACHED', watcherId });
      }
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // 5-minute timeout to prevent leaks
    waitTimeout = setTimeout(() => {
      bodyObserver.disconnect();
    }, 5 * 60 * 1000);
  }

  // ── Auto-restore persistent watchers on page load ─────────────
  function autoRestore() {
    chrome.storage.local.get('watchers', ({ watchers }) => {
      if (!watchers) return;
      const currentUrl = window.location.href;

      for (const [id, w] of Object.entries(watchers)) {
        if (!w.persistent) continue;
        if (w.status !== 'paused' && w.status !== 'active') continue;

        // Match by URL (exact or pattern)
        const urlMatch = w.url === currentUrl ||
          (w.urlPattern && new RegExp(w.urlPattern).test(currentUrl)) ||
          (w.url && currentUrl.startsWith(w.url.split('?')[0]));

        if (!urlMatch) continue;

        if (w.selector) {
          waitForElement(id, w.selector, w.mode, w.pollInterval);
        } else {
          startWatch(id, null, w.mode, w.pollInterval);
          chrome.runtime.sendMessage({ type: 'WATCHER_REATTACHED', watcherId: id });
        }
      }
    });
  }

  // Run auto-restore when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoRestore);
  } else {
    autoRestore();
  }

  // ── Element picker ────────────────────────────────────────────
  function startPicker() {
    if (pickMode) return;
    pickMode = true;

    pickerOverlay = document.createElement('div');
    pickerOverlay.id = '__watchdog_picker_overlay__';
    pickerOverlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483646; cursor: crosshair;
    `;

    pickerHighlight = document.createElement('div');
    pickerHighlight.id = '__watchdog_picker_highlight__';
    pickerHighlight.style.cssText = `
      position: fixed; pointer-events: none; z-index: 2147483645;
      border: 2px solid #00e5a0; background: rgba(0,229,160,0.08);
      border-radius: 4px; transition: all 0.1s;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.35);
    `;

    const tooltip = document.createElement('div');
    tooltip.id = '__watchdog_tooltip__';
    tooltip.style.cssText = `
      position: fixed; z-index: 2147483647; pointer-events: none;
      background: #00e5a0; color: #000; padding: 6px 12px; border-radius: 6px;
      font: 700 12px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 350px; word-break: break-word;
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    `;

    document.body.appendChild(pickerOverlay);
    document.body.appendChild(pickerHighlight);
    document.body.appendChild(tooltip);

    let hovered = null;

    pickerOverlay.addEventListener('mousemove', (e) => {
      pickerOverlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      pickerOverlay.style.pointerEvents = '';
      if (!el || el === document.body || (el.id && el.id.startsWith('__watchdog'))) return;
      hovered = el;
      const rect = el.getBoundingClientRect();
      pickerHighlight.style.top = rect.top + 'px';
      pickerHighlight.style.left = rect.left + 'px';
      pickerHighlight.style.width = rect.width + 'px';
      pickerHighlight.style.height = rect.height + 'px';

      const humanLabel = getHumanLabel(el);
      tooltip.textContent = humanLabel;
      tooltip.style.top = Math.max(0, rect.top - 36) + 'px';
      tooltip.style.left = rect.left + 'px';
    });

    pickerOverlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!hovered) return;
      const sel = getSelector(hovered);
      const label = getHumanLabel(hovered);
      const isIframe = hovered.tagName === 'IFRAME';
      stopPicker();
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKED',
        selector: sel,
        selectorLabel: label,
        isIframe
      });
    });

    document.addEventListener('keydown', onEscPicker);
  }

  function onEscPicker(e) {
    if (e.key === 'Escape') {
      stopPicker();
      chrome.runtime.sendMessage({ type: 'PICKER_CANCELLED' });
    }
  }

  function stopPicker() {
    pickMode = false;
    if (pickerOverlay) { pickerOverlay.remove(); pickerOverlay = null; }
    if (pickerHighlight) { pickerHighlight.remove(); pickerHighlight = null; }
    const tt = document.getElementById('__watchdog_tooltip__');
    if (tt) tt.remove();
    document.removeEventListener('keydown', onEscPicker);
  }

  // ── Message listener ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_WATCH':
        startWatch(msg.watcherId, msg.selector, msg.mode, msg.pollInterval);
        sendResponse({ ok: true, watching: true });
        break;
      case 'STOP_WATCH':
        stopAllWatchers();
        sendResponse({ ok: true, watching: false });
        break;
      case 'STOP_SINGLE_WATCH':
        stopSingleWatch(msg.watcherId);
        sendResponse({ ok: true });
        break;
      case 'START_PICKER':
        startPicker();
        sendResponse({ ok: true });
        break;
      case 'GET_STATUS':
        sendResponse({
          watching: activeWatchers.size > 0,
          watcherCount: activeWatchers.size,
          watchers: [...activeWatchers.entries()].map(([id, w]) => ({
            id,
            selector: w.selector,
            changeCount: w.changeCount
          }))
        });
        break;
      case 'POLL_CHECK': {
        const w = activeWatchers.get(msg.watcherId);
        if (w) {
          const cur = snapshot(w.selector);
          if (cur !== w.lastSnapshot) {
            const old = w.lastSnapshot;
            w.lastSnapshot = cur;
            onChanged(old, cur, msg.watcherId);
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case 'TAKE_SNAPSHOT': {
        const snap = snapshot(msg.selector || null);
        sendResponse({ snapshot: snap });
        break;
      }
      case 'GET_ELEMENT_BOUNDS': {
        const target = msg.selector ? document.querySelector(msg.selector) : document.body;
        if (target) {
          const rect = target.getBoundingClientRect();
          sendResponse({
            x: rect.x, y: rect.y,
            width: rect.width, height: rect.height,
            devicePixelRatio: window.devicePixelRatio || 1
          });
        } else {
          sendResponse({ error: 'Element not found' });
        }
        break;
      }
    }
    return true;
  });

})();
