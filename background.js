// background.js — Page Watchdog v2.0.0 service worker

// ── Storage Layer ─────────────────────────────────────────────
let watchersCache = new Map(); // id -> watcher object

async function loadWatchers() {
  const { watchers } = await chrome.storage.local.get('watchers');
  watchersCache.clear();
  if (watchers) {
    for (const [id, w] of Object.entries(watchers)) {
      watchersCache.set(id, w);
    }
  }
  return watchersCache;
}

async function saveWatcher(watcher) {
  watchersCache.set(watcher.id, watcher);
  const obj = Object.fromEntries(watchersCache);
  await chrome.storage.local.set({ watchers: obj });
  broadcastUpdate(watcher);
}

async function removeWatcher(id) {
  watchersCache.delete(id);
  const obj = Object.fromEntries(watchersCache);
  await chrome.storage.local.set({ watchers: obj });
}

function generateId() {
  return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function createWatcher(opts) {
  return {
    id: opts.id || generateId(),
    tabId: opts.tabId || null,
    url: opts.url || '',
    urlPattern: opts.urlPattern || '',
    selector: opts.selector || null,
    selectorLabel: opts.selectorLabel || '',
    mode: opts.mode || 'mutation',
    pollInterval: opts.pollInterval || 30000,
    cooldown: opts.cooldown || 30000,
    changeCount: 0,
    lastChangeTime: null,
    lastNotificationTime: null,
    changes: [],
    status: 'active',        // 'active' | 'paused' | 'stopped'
    persistent: opts.persistent || false,
    compareMode: opts.compareMode || 'content',  // 'content' | 'visual'
    checkMode: opts.checkMode || 'current',  // 'current' | 'background'
    lastSnapshotData: opts.lastSnapshotData || null,
    currentValue: '',
    lastPollTime: null,
    createdAt: Date.now()
  };
}

// ── Background tab check ─────────────────────────────────────
async function performBackgroundCheck(watcher) {
  let tempTabId;
  try {
    const tab = await chrome.tabs.create({ url: watcher.url, active: false });
    tempTabId = tab.id;

    // Wait for page load (max 30s)
    await new Promise((resolve) => {
      const onUpdate = (id, info) => {
        if (id === tempTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdate);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdate);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); }, 30000);
    });

    // Short delay for JS-rendered content
    await new Promise(r => setTimeout(r, 1500));

    await chrome.scripting.executeScript({ target: { tabId: tempTabId }, files: ['content.js'] });

    const response = await chrome.tabs.sendMessage(tempTabId, {
      type: 'TAKE_SNAPSHOT',
      selector: watcher.selector
    });

    const curSnap = response?.snapshot;
    if (!curSnap) return;

    if (watcher.lastSnapshotData && curSnap !== watcher.lastSnapshotData) {
      watcher.changeCount = (watcher.changeCount || 0) + 1;
      watcher.lastChangeTime = Date.now();
      // Store current value (just the text part of the snapshot)
      const curText = curSnap.split('|').slice(1).join('|').trim();
      watcher.currentValue = curText.slice(0, 300);

      const preview = diffSnapshots(watcher.lastSnapshotData, curSnap);
      const change = {
        timestamp: Date.now(),
        watcherId: watcher.id,
        watcherLabel: watcher.selectorLabel || watcher.selector || 'Full page',
        selector: watcher.selector || null,
        preview
      };
      watcher.changes.push(change);
      if (watcher.changes.length > 50) watcher.changes = watcher.changes.slice(-50);
      sendNotification(watcher, preview);
    }

    watcher.lastSnapshotData = curSnap;
    await saveWatcher(watcher);
  } catch (e) { /* tab may have been closed manually */ }
  finally {
    if (tempTabId) { try { chrome.tabs.remove(tempTabId); } catch {} }
  }
}

// ── Offscreen document management ─────────────────────────────
async function ensureOffscreen() {
  // Check if offscreen document exists — handle missing hasDocument() gracefully
  try {
    if (typeof chrome.offscreen.hasDocument === 'function') {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) return;
    }
  } catch (e) { /* hasDocument failed, try creating */ }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Canvas image cropping and pixel comparison for visual watcher mode'
    });
  } catch (e) {
    if (!e.message?.includes('already exists')) {
      console.error('[Watchdog] ensureOffscreen error:', e);
      throw e;
    }
  }
}

// Port-based messaging with offscreen document.
// The offscreen document connects TO us (standard MV3 pattern).
// This avoids timing issues and the multi-listener problem with sendMessage.
let offscreenPort = null;
let portRequestId = 0;
const pendingPortRequests = new Map(); // id -> { resolve, reject, timer }
let portReadyResolvers = []; // callbacks waiting for port connection

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'watchdog-offscreen') return;
  offscreenPort = port;

  // Resolve any callers waiting for the port
  for (const resolve of portReadyResolvers) resolve();
  portReadyResolvers = [];

  port.onMessage.addListener((msg) => {
    const pending = pendingPortRequests.get(msg._reqId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPortRequests.delete(msg._reqId);
      pending.resolve(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    offscreenPort = null;
    // Reject all pending requests
    for (const [id, pending] of pendingPortRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Offscreen port disconnected'));
    }
    pendingPortRequests.clear();
  });
});

function waitForOffscreenPort(timeout = 5000) {
  if (offscreenPort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = portReadyResolvers.indexOf(wrappedResolve);
      if (idx >= 0) portReadyResolvers.splice(idx, 1);
      reject(new Error('Offscreen port connection timeout'));
    }, timeout);
    function wrappedResolve() {
      clearTimeout(timer);
      resolve();
    }
    portReadyResolvers.push(wrappedResolve);
  });
}

function sendToOffscreen(msg, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!offscreenPort) {
      reject(new Error('Offscreen port not connected'));
      return;
    }
    const reqId = ++portRequestId;
    const timer = setTimeout(() => {
      pendingPortRequests.delete(reqId);
      reject(new Error(`Offscreen timeout for ${msg.type} after ${timeout}ms`));
    }, timeout);
    pendingPortRequests.set(reqId, { resolve, reject, timer });
    offscreenPort.postMessage({ ...msg, _reqId: reqId });
  });
}

// Lock to prevent overlapping visual checks on the same watcher
const visualCheckLocks = new Set();

// Helper: crop + compare pipeline shared by both check modes.
// Single round-trip to offscreen — baseline stored as raw pixels there (no JPEG re-encoding).
async function cropAndCompare(watcher, screenshotDataUrl, bounds) {
  await ensureOffscreen();
  await waitForOffscreenPort();

  const result = await sendToOffscreen({
    type: 'CROP_AND_COMPARE',
    watcherId: watcher.id,
    dataUrl: screenshotDataUrl,
    rect: {
      x: bounds.x, y: bounds.y,
      width: bounds.width, height: bounds.height,
      devicePixelRatio: bounds.devicePixelRatio
    }
  });

  if (result.error) {
    console.warn('[Watchdog] Visual check failed:', result.error);
    return;
  }

  if (result.baseline) {
    console.log(`[Watchdog] Baseline captured for ${watcher.id}`);
    return;
  }

  if (result.changed) {
    watcher.changeCount = (watcher.changeCount || 0) + 1;
    watcher.lastChangeTime = Date.now();
    const preview = `Visual change detected (${result.changePercent}% area changed)`;
    watcher.currentValue = preview;
    const change = {
      timestamp: Date.now(),
      watcherId: watcher.id,
      watcherLabel: watcher.selectorLabel || watcher.selector || 'Full page',
      selector: watcher.selector || null,
      preview
    };
    watcher.changes.push(change);
    if (watcher.changes.length > 50) watcher.changes = watcher.changes.slice(-50);
    await saveWatcher(watcher);
    sendNotification(watcher, preview);
  }
}

// ── Visual check: current tab ─────────────────────────────────
async function performVisualCheck_CurrentTab(watcher) {
  if (visualCheckLocks.has(watcher.id)) return;
  visualCheckLocks.add(watcher.id);
  try {
    let tab;
    try {
      tab = await chrome.tabs.get(watcher.tabId);
    } catch {
      console.warn('[Watchdog] Visual check: tab not found');
      return;
    }
    if (tab.discarded) {
      console.warn('[Watchdog] Visual check: tab is discarded');
      return;
    }

    // captureVisibleTab requires the tab to be active in its window.
    // If not active, briefly switch to it and restore afterwards.
    let restoreTabId = null;
    if (!tab.active) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        restoreTabId = activeTab?.id;
      } catch {}
      await chrome.tabs.update(watcher.tabId, { active: true });
      await new Promise(r => setTimeout(r, 100));
    }

    try {
      const bounds = await chrome.tabs.sendMessage(watcher.tabId, {
        type: 'GET_ELEMENT_BOUNDS',
        selector: watcher.selector
      });
      if (!bounds || bounds.error) {
        console.warn('[Watchdog] Visual check: could not get bounds', bounds?.error);
        return;
      }

      const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg', quality: 92
      });

      await cropAndCompare(watcher, screenshotDataUrl, bounds);
    } finally {
      // Restore previous active tab as quickly as possible
      if (restoreTabId) {
        chrome.tabs.update(restoreTabId, { active: true }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Watchdog] Visual check (current tab) error:', e);
  } finally {
    visualCheckLocks.delete(watcher.id);
  }
}

// ── Visual check: background ──────────────────────────────────
async function performVisualCheck_Background(watcher) {
  if (visualCheckLocks.has(watcher.id)) return;
  visualCheckLocks.add(watcher.id);
  let windowId;
  try {
    const win = await chrome.windows.create({
      url: watcher.url,
      type: 'normal',
      state: 'minimized'
    });
    windowId = win.id;
    const tempTabId = win.tabs[0].id;

    // Wait for page load (max 30s)
    await new Promise((resolve) => {
      const onUpdate = (id, info) => {
        if (id === tempTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdate);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdate);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); }, 30000);
    });

    // Render delay
    await new Promise(r => setTimeout(r, 2000));

    await chrome.scripting.executeScript({ target: { tabId: tempTabId }, files: ['content.js'] });

    const bounds = await chrome.tabs.sendMessage(tempTabId, {
      type: 'GET_ELEMENT_BOUNDS',
      selector: watcher.selector
    });
    if (!bounds || bounds.error) {
      console.warn('[Watchdog] Visual bg check: could not get bounds', bounds?.error);
      return;
    }

    // Focus window briefly for captureVisibleTab
    await chrome.windows.update(windowId, { state: 'normal', focused: true });
    await new Promise(r => setTimeout(r, 500));

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg', quality: 92
    });

    await cropAndCompare(watcher, screenshotDataUrl, bounds);
  } catch (e) {
    console.error('[Watchdog] Visual check (background) error:', e);
  } finally {
    visualCheckLocks.delete(watcher.id);
    if (windowId) { try { chrome.windows.remove(windowId); } catch {} }
  }
}

function diffSnapshots(oldSnap, newSnap) {
  const oldText = oldSnap.split('|').slice(1).join('|');
  const newText = newSnap.split('|').slice(1).join('|');

  if (oldText === newText) return 'Structure changed';

  if (newText.length < 100) {
    if (oldText.length < 100) return `${oldText} → ${newText}`;
    return newText || 'Content changed';
  }

  const oldLines = new Set(oldText.split('\n').map(l => l.trim()).filter(Boolean));
  const newLines = newText.split('\n').map(l => l.trim()).filter(Boolean);
  const added = newLines.filter(l => !oldLines.has(l));

  if (added.length > 0) return added.slice(0, 3).join(' | ').slice(0, 200);
  if (newLines.length > 0) return newLines[newLines.length - 1].slice(0, 200);

  return 'Content changed';
}

// Repopulate cache on service worker wake
loadWatchers();

// ── Badge helpers ─────────────────────────────────────────────
function updateBadge(tabId) {
  const count = [...watchersCache.values()].filter(w => w.tabId === tabId && w.status === 'active').length;
  if (count > 0) {
    chrome.action.setBadgeText({ tabId, text: String(count) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#00e5a0' });
  } else {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

function setBadgeAlert(tabId) {
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff6b35' });
  setTimeout(() => updateBadge(tabId), 5000);
}

// ── Notification ──────────────────────────────────────────────
function sendNotification(watcher, preview) {
  const now = Date.now();
  if (watcher.lastNotificationTime && (now - watcher.lastNotificationTime) < watcher.cooldown) {
    return; // cooldown active
  }
  watcher.lastNotificationTime = now;

  const label = watcher.selectorLabel || watcher.selector || 'Full page';
  const body = preview
    ? `${preview.slice(0, 120)}\n— Change #${watcher.changeCount}`
    : `Change #${watcher.changeCount} detected`;

  chrome.notifications.create(`wd-${watcher.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: `Watchdog: ${label}`,
    message: body,
    priority: 2,
    requireInteraction: false
  });

  if (watcher.tabId) setBadgeAlert(watcher.tabId);
}

// ── Broadcast watcher updates to popup/dashboard ──────────────
function broadcastUpdate(watcher) {
  // Strip lastSnapshotData to avoid sending large screenshot data URLs via messaging
  const { lastSnapshotData, ...lite } = watcher;
  chrome.runtime.sendMessage({ type: 'WATCHER_UPDATED', watcher: lite }).catch(() => {});
}

// ── Alarm-based polling ───────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('wd-poll-')) return;
  const watcherId = alarm.name.replace('wd-poll-', '');
  await loadWatchers();
  const watcher = watchersCache.get(watcherId);
  if (!watcher || watcher.status !== 'active') {
    chrome.alarms.clear(alarm.name);
    return;
  }

  watcher.lastPollTime = Date.now();
  await saveWatcher(watcher);

  if (watcher.compareMode === 'visual') {
    if (watcher.checkMode === 'background') {
      await performVisualCheck_Background(watcher);
    } else {
      await performVisualCheck_CurrentTab(watcher);
    }
    return;
  }

  if (watcher.checkMode === 'background') {
    await performBackgroundCheck(watcher);
    return;
  }

  if (!watcher.tabId) {
    chrome.alarms.clear(alarm.name);
    return;
  }
  chrome.tabs.sendMessage(watcher.tabId, {
    type: 'POLL_CHECK',
    watcherId
  }).catch(() => {});
});

// ── Tab close handling ────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadWatchers();
  for (const [id, watcher] of watchersCache) {
    if (watcher.tabId !== tabId) continue;

    chrome.alarms.clear(`wd-poll-${id}`);

    if (watcher.persistent) {
      watcher.status = 'paused';
      watcher.tabId = null;
      await saveWatcher(watcher);
      chrome.notifications.create(`wd-paused-${id}`, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Watchdog: Watcher Paused',
        message: `"${watcher.selectorLabel || watcher.selector || 'Full page'}" paused — tab closed. Will resume when you reopen the URL.`,
        priority: 1,
        requireInteraction: false
      });
    } else {
      watcher.status = 'stopped';
      watcher.tabId = null;
      await saveWatcher(watcher);
    }
  }
});

// ── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg.tabId;

  (async () => {
    await loadWatchers();

    switch (msg.type) {

      case 'START_WATCH': {
        const checkMode = msg.checkMode || 'current';
        const compareMode = msg.compareMode || 'content';
        const forceScheduled = compareMode === 'visual' || checkMode === 'background';
        const watcher = createWatcher({
          id: msg.watcherId,
          tabId: checkMode === 'background' ? null : tabId,
          url: msg.url || '',
          selector: msg.selector,
          selectorLabel: msg.selectorLabel || '',
          mode: forceScheduled ? 'poll' : (msg.mode || 'mutation'),
          pollInterval: msg.pollInterval,
          persistent: msg.persistent || false,
          checkMode,
          compareMode
        });
        // Set initial poll time for countdown display
        if (checkMode === 'background' || watcher.mode === 'poll' || watcher.mode === 'both') {
          watcher.lastPollTime = Date.now();
        }
        await saveWatcher(watcher);
        if (checkMode !== 'background' && tabId) updateBadge(tabId);

        // Background mode always uses poll alarm; current mode only if poll/both
        if (checkMode === 'background' || watcher.mode === 'poll' || watcher.mode === 'both') {
          const periodMinutes = Math.max((watcher.pollInterval) / 60000, 0.5);
          chrome.alarms.create(`wd-poll-${watcher.id}`, {
            periodInMinutes: periodMinutes
          });
        }

        sendResponse({ ok: true, watcherId: watcher.id });

        // Capture baseline immediately for visual watchers (don't wait 30s for first alarm)
        if (compareMode === 'visual') {
          setTimeout(async () => {
            await loadWatchers();
            const w = watchersCache.get(watcher.id);
            if (w && w.status === 'active') {
              try {
                if (w.checkMode === 'background') {
                  await performVisualCheck_Background(w);
                } else {
                  await performVisualCheck_CurrentTab(w);
                }
              } catch (e) {
                console.error('[Watchdog] Initial visual check error:', e);
              }
            }
          }, 2000);
        }
        break;
      }

      case 'STOP_WATCH': {
        const watcherId = msg.watcherId;
        if (watcherId) {
          const w = watchersCache.get(watcherId);
          if (w) {
            w.status = 'stopped';
            w.tabId = null;
            chrome.alarms.clear(`wd-poll-${watcherId}`);
            await saveWatcher(w);
          }
          updateBadge(tabId);
        } else {
          // Stop all watchers on this tab
          for (const [id, w] of watchersCache) {
            if (w.tabId === tabId) {
              w.status = 'stopped';
              w.tabId = null;
              chrome.alarms.clear(`wd-poll-${id}`);
              await saveWatcher(w);
            }
          }
          updateBadge(tabId);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'PAUSE_WATCH': {
        const w = watchersCache.get(msg.watcherId);
        if (w) {
          w.status = 'paused';
          chrome.alarms.clear(`wd-poll-${w.id}`);
          await saveWatcher(w);
          if (w.tabId) {
            chrome.tabs.sendMessage(w.tabId, {
              type: 'STOP_SINGLE_WATCH',
              watcherId: w.id
            }).catch(() => {});
            updateBadge(w.tabId);
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'PAUSE_ALL': {
        for (const [id, w] of watchersCache) {
          if (w.tabId === tabId && w.status === 'active') {
            w.status = 'paused';
            chrome.alarms.clear(`wd-poll-${id}`);
            await saveWatcher(w);
          }
        }
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'STOP_WATCH' }).catch(() => {});
          updateBadge(tabId);
        }
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      }

      case 'RESUME_WATCH': {
        const w = watchersCache.get(msg.watcherId);
        if (w) {
          w.status = 'active';
          const targetTab = msg.tabId || w.tabId;
          w.tabId = targetTab;
          await saveWatcher(w);

          // Content watchers need content script observation
          if (targetTab && w.compareMode !== 'visual') {
            chrome.tabs.sendMessage(targetTab, {
              type: 'START_WATCH',
              watcherId: w.id,
              selector: w.selector,
              mode: w.mode,
              pollInterval: w.pollInterval
            }).catch(() => {});
          }

          // Create alarm for poll-based watchers (works without tabId for background mode)
          if (w.mode === 'poll' || w.mode === 'both') {
            const periodMinutes = Math.max(w.pollInterval / 60000, 0.5);
            chrome.alarms.create(`wd-poll-${w.id}`, {
              periodInMinutes: periodMinutes
            });
          }

          if (targetTab) updateBadge(targetTab);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'DELETE_WATCHER': {
        const w = watchersCache.get(msg.watcherId);
        if (w) {
          chrome.alarms.clear(`wd-poll-${w.id}`);
          if (w.tabId && w.status === 'active') {
            chrome.tabs.sendMessage(w.tabId, {
              type: 'STOP_SINGLE_WATCH',
              watcherId: w.id
            }).catch(() => {});
            updateBadge(w.tabId);
          }
          if (w.compareMode === 'visual' && offscreenPort) {
            sendToOffscreen({ type: 'CLEAR_BASELINE', watcherId: w.id }).catch(() => {});
          }
          await removeWatcher(w.id);
          broadcastUpdate({ ...w, status: 'deleted' });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CHANGE_DETECTED': {
        const w = watchersCache.get(msg.watcherId);
        if (!w) break;
        w.changeCount = (w.changeCount || 0) + 1;
        w.lastChangeTime = Date.now();
        if (msg.currentValue !== undefined) w.currentValue = msg.currentValue;

        const change = {
          timestamp: Date.now(),
          watcherId: w.id,
          watcherLabel: w.selectorLabel || w.selector || 'Full page',
          selector: w.selector || null,
          preview: msg.preview || ''
        };
        w.changes.push(change);
        if (w.changes.length > 50) w.changes = w.changes.slice(-50);

        await saveWatcher(w);
        sendNotification(w, msg.preview);
        sendResponse({ ok: true });
        break;
      }

      case 'GET_STATUS': {
        const tid = msg.tabId;
        const tabWatchers = [...watchersCache.values()].filter(w => w.tabId === tid && w.status === 'active');
        sendResponse({
          watching: tabWatchers.length > 0,
          watchers: tabWatchers
        });
        break;
      }

      case 'GET_ALL_WATCHERS': {
        sendResponse({ watchers: [...watchersCache.values()] });
        break;
      }

      case 'GET_CHANGE_LOG': {
        const allChanges = [];
        for (const w of watchersCache.values()) {
          for (const c of w.changes) {
            allChanges.push(c);
          }
        }
        allChanges.sort((a, b) => b.timestamp - a.timestamp);
        sendResponse({ changes: allChanges.slice(0, 50) });
        break;
      }

      case 'UPDATE_WATCHER': {
        const w = watchersCache.get(msg.watcherId);
        if (w) {
          const wasActive = w.status === 'active';
          const modeChanged = msg.mode && msg.mode !== w.mode;
          const intervalChanged = msg.pollInterval && msg.pollInterval !== w.pollInterval;
          const selectorChanged = msg.selector !== undefined && msg.selector !== w.selector;
          const checkModeChanged = msg.checkMode !== undefined && msg.checkMode !== w.checkMode;
          const compareModeChanged = msg.compareMode !== undefined && msg.compareMode !== w.compareMode;

          // Update all editable fields
          if (msg.mode) w.mode = msg.mode;
          if (msg.pollInterval) w.pollInterval = msg.pollInterval;
          if (msg.cooldown) w.cooldown = msg.cooldown;
          if (msg.persistent !== undefined) w.persistent = msg.persistent;
          if (msg.selectorLabel !== undefined) w.selectorLabel = msg.selectorLabel;
          if (msg.selector !== undefined) w.selector = msg.selector;
          if (msg.compareMode !== undefined) {
            w.compareMode = msg.compareMode;
            if (msg.compareMode === 'visual') {
              w.mode = 'poll';
              w.lastSnapshotData = null;
            }
          }
          if (msg.checkMode !== undefined) {
            w.checkMode = msg.checkMode;
            if (msg.checkMode === 'background') {
              w.mode = 'poll';
              w.tabId = null;
              w.lastSnapshotData = null;
            }
          }

          // Clear baselines when comparison-relevant settings change
          if (compareModeChanged || selectorChanged) {
            w.lastSnapshotData = null;
            if (offscreenPort) {
              sendToOffscreen({ type: 'CLEAR_BASELINE', watcherId: w.id }).catch(() => {});
            }
          }

          await saveWatcher(w);

          // Restart alarm/observer if settings changed
          if (wasActive && (modeChanged || intervalChanged || selectorChanged || checkModeChanged || compareModeChanged)) {
            chrome.alarms.clear(`wd-poll-${w.id}`);

            if (w.compareMode === 'visual' || w.checkMode === 'background') {
              const periodMinutes = Math.max(w.pollInterval / 60000, 0.5);
              chrome.alarms.create(`wd-poll-${w.id}`, { periodInMinutes: periodMinutes });
            } else if (w.tabId) {
              chrome.tabs.sendMessage(w.tabId, {
                type: 'START_WATCH',
                watcherId: w.id,
                selector: w.selector,
                mode: w.mode,
                pollInterval: w.pollInterval
              }).catch(() => {});

              if (w.mode === 'poll' || w.mode === 'both') {
                const periodMinutes = Math.max(w.pollInterval / 60000, 0.5);
                chrome.alarms.create(`wd-poll-${w.id}`, { periodInMinutes: periodMinutes });
              }
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'WATCHER_REATTACHED': {
        const w = watchersCache.get(msg.watcherId);
        if (w) {
          w.tabId = tabId;
          w.status = 'active';
          await saveWatcher(w);
          updateBadge(tabId);

          if (w.mode === 'poll' || w.mode === 'both') {
            const periodMinutes = Math.max(w.pollInterval / 60000, 0.5);
            chrome.alarms.create(`wd-poll-${w.id}`, {
              periodInMinutes: periodMinutes
            });
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'ELEMENT_PICKED': {
        // Persist pick so popup can load it when reopened
        chrome.storage.local.set({
          pendingPick: {
            selector: msg.selector,
            selectorLabel: msg.selectorLabel,
            isIframe: msg.isIframe || false
          }
        });
        // Also relay to popup if it's still open
        chrome.runtime.sendMessage(msg).catch(() => {});
        // Auto-reopen the popup so user doesn't have to click the icon
        try { chrome.action.openPopup(); } catch {}
        sendResponse({ ok: true });
        break;
      }

      case 'PICKER_CANCELLED': {
        chrome.storage.local.remove('pendingPick');
        chrome.runtime.sendMessage(msg).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();

  return true; // keep channel open for async sendResponse
});
