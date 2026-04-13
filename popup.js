// popup.js — Page Watchdog v2.0.0

let currentTabId = null;
let currentTabUrl = '';
let selectedMode = 'mutation';
let selectedCheckMode = 'current';
let selectedCompareMode = 'content';
let isPicking = false;
let currentSelectorLabel = '';

const $ = id => document.getElementById(id);

// Ensure content script is injected before sending a message to the tab
function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ['content.js'] },
      () => {
        if (chrome.runtime.lastError) { /* ignore */ }
        resolve();
      }
    );
  });
}

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`panel-${btn.dataset.tab}`).classList.add('active');

    if (btn.dataset.tab === 'active') refreshActiveList();
    if (btn.dataset.tab === 'log') refreshLogList();
  });
});

// ── Init ──────────────────────────────────────────────────────
// Check for a pending picked element (from a previous picker session)
chrome.storage.local.get(['pendingPick', 'modalPickWatcherId'], ({ pendingPick, modalPickWatcherId }) => {
  if (pendingPick) {
    if (modalPickWatcherId) {
      // Re-pick from edit modal — reopen modal with new selector
      chrome.storage.local.remove('modalPickWatcherId');
      chrome.runtime.sendMessage({ type: 'GET_ALL_WATCHERS' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const w = (res.watchers || []).find(x => x.id === modalPickWatcherId);
        if (w) {
          openEditModal(w);
          $('modalSelector').value = pendingPick.selector;
          $('modalLabel').value = pendingPick.selectorLabel || w.selectorLabel || '';
        }
      });
    } else {
      // Normal pick — populate the Watch tab
      $('selectorInput').value = pendingPick.selector;
      currentSelectorLabel = pendingPick.selectorLabel || '';
      if (pendingPick.selectorLabel) {
        $('selectorLabelDisplay').textContent = pendingPick.selectorLabel;
        $('selectorLabelDisplay').classList.add('visible');
      }
      if (pendingPick.isIframe) {
        applyCompareMode('visual');
        $('iframeHint').style.display = 'block';
      }
      revealOptions();
    }
    chrome.storage.local.remove('pendingPick');
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  currentTabId = tab.id;
  currentTabUrl = tab.url || '';

  // Inject content script then check status
  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, files: ['content.js'] },
    () => {
      if (chrome.runtime.lastError) return;
      chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tab.id }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.watching) {
          $('statusDot').className = 'status-dot active';
          $('stopRow').style.display = '';
        }
      });
    }
  );
});

// ── Progressive disclosure ────────────────────────────────────
function revealOptions() {
  $('revealOnPick').classList.add('visible');
}

function updateOptionsSummary() {
  const modeLabels = { mutation: 'Instant', poll: 'Scheduled', both: 'Both' };
  const checkLabels = { current: 'This tab', background: 'Background' };
  const parts = [modeLabels[selectedMode] || 'Instant', checkLabels[selectedCheckMode] || 'This tab'];
  if ($('persistentToggle').checked) parts.push('Persistent');
  $('optionsSummary').textContent = parts.join(' · ');
}

// Options toggle
$('optionsToggle').addEventListener('click', () => {
  $('optionsToggle').classList.toggle('open');
  $('optionsPanel').classList.toggle('visible');
});

// ── Mode selection ────────────────────────────────────────────
document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn[data-mode]').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedMode = btn.dataset.mode;
    $('pollRow').classList.toggle('visible', selectedMode === 'poll' || selectedMode === 'both');
    updateOptionsSummary();
  });
});

// ── Check method selection ────────────────────────────────────
document.querySelectorAll('.check-btn[data-check]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.check-btn[data-check]').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedCheckMode = btn.dataset.check;

    const modeBtns = document.querySelectorAll('.mode-btn[data-mode]');
    const bgHint = $('bgHint');
    const modeLabel = $('modeLabel');

    if (selectedCheckMode === 'background') {
      bgHint.style.display = 'block';
      // Force poll mode
      modeBtns.forEach(b => {
        b.classList.remove('selected');
        b.style.opacity = '0.3';
        b.style.pointerEvents = 'none';
      });
      document.querySelector('[data-mode="poll"]').classList.add('selected');
      selectedMode = 'poll';
      $('pollRow').classList.add('visible');
      modeLabel.style.opacity = '0.35';
    } else if (selectedCompareMode !== 'visual') {
      bgHint.style.display = 'none';
      modeBtns.forEach(b => {
        b.style.opacity = '1';
        b.style.pointerEvents = '';
      });
      modeLabel.style.opacity = '1';
    } else {
      bgHint.style.display = 'none';
    }
    updateOptionsSummary();
  });
});

// ── Compare mode selection ────────────────────────────────────
function applyCompareMode(mode) {
  selectedCompareMode = mode;
  document.querySelectorAll('.compare-btn[data-compare]').forEach(b => b.classList.remove('selected'));
  document.querySelector(`.compare-btn[data-compare="${mode}"]`).classList.add('selected');

  const modeBtns = document.querySelectorAll('.mode-btn[data-mode]');
  const modeLabel = $('modeLabel');

  if (mode === 'visual') {
    // Hide detection mode row, force scheduled, always show check-every
    modeBtns.forEach(b => {
      b.classList.remove('selected');
      b.style.opacity = '0.3';
      b.style.pointerEvents = 'none';
    });
    document.querySelector('[data-mode="poll"]').classList.add('selected');
    selectedMode = 'poll';
    modeLabel.style.opacity = '0.35';
    $('pollRow').classList.add('visible');
  } else if (selectedCheckMode !== 'background') {
    // Restore detection mode row
    modeBtns.forEach(b => {
      b.style.opacity = '1';
      b.style.pointerEvents = '';
    });
    modeLabel.style.opacity = '1';
    $('pollRow').classList.toggle('visible', selectedMode === 'poll' || selectedMode === 'both');
  }
}

document.querySelectorAll('.compare-btn[data-compare]').forEach(btn => {
  btn.addEventListener('click', () => {
    applyCompareMode(btn.dataset.compare);
    $('iframeHint').style.display = 'none';
  });
});

// ── Pick button ───────────────────────────────────────────────
$('pickBtn').addEventListener('click', async () => {
  if (!currentTabId) return;
  if (isPicking) {
    cancelPicker();
    return;
  }
  isPicking = true;
  $('pickBtn').classList.add('picking');
  $('pickBtn').textContent = '✕';
  $('pickerMsg').classList.add('visible');

  await ensureContentScript(currentTabId);
  chrome.tabs.sendMessage(currentTabId, { type: 'START_PICKER' });
  window.close(); // Close popup so user can interact with page
});

function cancelPicker() {
  isPicking = false;
  $('pickBtn').classList.remove('picking');
  $('pickBtn').textContent = '🎯';
  $('pickerMsg').classList.remove('visible');
}

// ── Start ─────────────────────────────────────────────────────
$('startBtn').addEventListener('click', async () => {
  if (!currentTabId) return;

  const selector = $('selectorInput').value.trim() || null;
  const pollInterval = parseInt($('pollInterval').value);
  const persistent = $('persistentToggle').checked;
  const selectorLabel = currentSelectorLabel || selector || 'Full page';
  const checkMode = selectedCheckMode;

  const compareMode = selectedCompareMode;

  // Send to background first to get watcherId
  chrome.runtime.sendMessage({
    type: 'START_WATCH',
    tabId: currentTabId,
    url: currentTabUrl,
    selector,
    selectorLabel,
    mode: (compareMode === 'visual' || checkMode === 'background') ? 'poll' : selectedMode,
    pollInterval,
    persistent,
    checkMode,
    compareMode
  }, async (res) => {
    if (!res?.ok) return;
    const watcherId = res.watcherId;

    if (compareMode !== 'visual' && checkMode === 'current') {
      // Forward to content script for live watching (not needed for visual mode)
      await ensureContentScript(currentTabId);
      chrome.tabs.sendMessage(currentTabId, {
        type: 'START_WATCH',
        watcherId,
        selector,
        mode: selectedMode,
        pollInterval
      });
    }

    $('statusDot').className = 'status-dot active';
    $('stopRow').style.display = '';
    $('revealOnPick').classList.remove('visible');
    $('selectorInput').value = '';
    $('selectorLabelDisplay').classList.remove('visible');
    currentSelectorLabel = '';
    $('tipText').innerHTML = 'Watcher started. Pick another element or manage in <strong>Active</strong> tab.';
  });
});

// ── Pause all ────────────────────────────────────────────────
$('stopBtn').addEventListener('click', async () => {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: 'PAUSE_ALL', tabId: currentTabId }, () => {
    $('statusDot').className = 'status-dot';
    $('stopRow').style.display = 'none';
    $('tipText').innerHTML = 'All watchers paused. Resume from the <strong>Active</strong> tab.';
  });
});

// ── Active list ───────────────────────────────────────────────
function refreshActiveList() {
  chrome.runtime.sendMessage({ type: 'GET_ALL_WATCHERS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const list = $('activeList');
    list.innerHTML = '';

    const watchers = (res.watchers || []).filter(w => w.status !== 'stopped');
    if (watchers.length === 0) {
      list.innerHTML = '<li class="empty-state">No active watchers.<br>Go to the Watch tab to start one.</li>';
      return;
    }

    watchers.forEach(w => {
      const li = document.createElement('li');
      li.className = `watcher-item ${w.status}`;

      const selectorTitle = escHtml(w.selector || 'Full page');
      const currentValue = w.currentValue ? escHtml(w.currentValue) : '';

      // Check method
      const checkLabel = w.checkMode === 'background' ? 'Stealth' : 'This tab';
      const checkClass = w.checkMode === 'background' ? 'stealth' : 'live';

      // Poll interval
      const hasPoll = w.checkMode === 'background' || w.mode === 'poll' || w.mode === 'both';
      const pollSeconds = hasPoll ? Math.round((w.pollInterval || 30000) / 1000) : 0;

      // Countdown
      let countdownHtml = '';
      if (hasPoll && w.status === 'active' && w.lastPollTime && w.pollInterval) {
        const nextPoll = w.lastPollTime + w.pollInterval;
        const remaining = Math.max(0, Math.ceil((nextPoll - Date.now()) / 1000));
        countdownHtml = `<div class="watcher-countdown" data-next="${nextPoll}" data-interval="${w.pollInterval}">Next check in <strong>${remaining}s</strong></div>`;
      }

      li.innerHTML = `
        <div class="watcher-item-header">
          <span class="watcher-status-dot ${w.status}"></span>
          <span class="watcher-label">${selectorTitle}${currentValue ? `<span class="watcher-value">${currentValue}</span>` : ''}</span>
        </div>
        <div class="watcher-method-row">
          <span class="watcher-method-badge ${checkClass}">${checkLabel}</span>
          <span class="watcher-meta-text">${w.changeCount} change${w.changeCount !== 1 ? 's' : ''}${pollSeconds ? ` · ${pollSeconds}s` : ''}</span>
          ${w.persistent ? '<span class="watcher-tag">Persistent</span>' : ''}
        </div>
        ${countdownHtml}
        <div class="watcher-actions">
          ${w.status === 'active'
            ? `<button class="watcher-action-btn" data-action="pause" data-id="${w.id}">Pause</button>`
            : `<button class="watcher-action-btn" data-action="resume" data-id="${w.id}">Resume</button>`
          }
          <button class="watcher-action-btn edit-btn" data-action="edit" data-id="${w.id}">Edit</button>
          <button class="watcher-action-btn danger" data-action="delete" data-id="${w.id}">Delete</button>
        </div>
      `;
      list.appendChild(li);
    });

    // Bind action buttons
    list.querySelectorAll('.watcher-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'pause') {
          chrome.runtime.sendMessage({ type: 'PAUSE_WATCH', watcherId: id }, () => refreshActiveList());
        } else if (action === 'resume') {
          chrome.runtime.sendMessage({ type: 'RESUME_WATCH', watcherId: id, tabId: currentTabId }, () => refreshActiveList());
        } else if (action === 'delete') {
          chrome.runtime.sendMessage({ type: 'DELETE_WATCHER', watcherId: id }, () => refreshActiveList());
        } else if (action === 'edit') {
          const w = watchers.find(x => x.id === id);
          if (w) openEditModal(w);
        }
      });
    });
  });
}

// ── Log list ──────────────────────────────────────────────────
function refreshLogList() {
  chrome.runtime.sendMessage({ type: 'GET_CHANGE_LOG' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const list = $('logList');
    list.innerHTML = '';

    const changes = (res.changes || []).slice(0, 30);
    if (changes.length === 0) {
      list.innerHTML = '<li class="empty-state">No changes recorded yet.</li>';
      return;
    }

    changes.forEach(c => {
      const li = document.createElement('li');
      li.className = 'log-item';
      const time = new Date(c.timestamp).toLocaleTimeString();
      li.innerHTML = `
        <div class="log-time">${time}</div>
        <div class="log-label">${escHtml(c.selector || 'Full page')}</div>
        <div class="log-preview">${escHtml(c.preview || 'Content changed')}</div>
      `;
      list.appendChild(li);
    });
  });
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ── Listen for picker result and updates ──────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ELEMENT_PICKED') {
    $('selectorInput').value = msg.selector;
    currentSelectorLabel = msg.selectorLabel || '';
    if (msg.selectorLabel) {
      $('selectorLabelDisplay').textContent = msg.selectorLabel;
      $('selectorLabelDisplay').classList.add('visible');
    }
    if (msg.isIframe) {
      applyCompareMode('visual');
      $('iframeHint').style.display = 'block';
    }
    revealOptions();
    cancelPicker();
  }
  if (msg.type === 'PICKER_CANCELLED') {
    cancelPicker();
  }
  if (msg.type === 'WATCHER_UPDATED') {
    // Refresh active panel if it's visible
    if ($('panel-active').classList.contains('active')) {
      refreshActiveList();
    }
    if ($('panel-log').classList.contains('active')) {
      refreshLogList();
    }
    // Auto-reset UI when no active watchers remain
    chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: currentTabId }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (!res.watching) {
        $('statusDot').className = 'status-dot';
        $('stopRow').style.display = 'none';
      }
    });
  }
});

// ── Edit modal ───────────────────────────────────────────────
function openEditModal(w) {
  $('modalWatcherId').value = w.id;
  $('modalLabel').value = w.selectorLabel || w.selector || '';
  $('modalSelector').value = w.selector || '';
  $('modalCompareMode').value = w.compareMode || 'content';
  $('modalCheckMode').value = w.checkMode || 'current';
  $('modalMode').value = w.mode;
  $('modalPollInterval').value = String(w.pollInterval || 30000);
  $('modalCooldown').value = String(w.cooldown || 30000);
  $('modalPersistent').checked = !!w.persistent;
  toggleModalFields();
  $('editModal').classList.add('visible');
}

function closeEditModal() {
  $('editModal').classList.remove('visible');
}

function toggleModalFields() {
  const compareMode = $('modalCompareMode').value;
  const checkMode = $('modalCheckMode').value;
  const mode = $('modalMode').value;

  if (compareMode === 'visual' || checkMode === 'background') {
    $('modalModeGroup').style.display = 'none';
    $('modalPollGroup').style.display = '';
  } else {
    $('modalModeGroup').style.display = '';
    $('modalPollGroup').style.display = (mode === 'poll' || mode === 'both') ? '' : 'none';
  }
}

$('modalCompareMode').addEventListener('change', toggleModalFields);
$('modalMode').addEventListener('change', toggleModalFields);
$('modalCheckMode').addEventListener('change', toggleModalFields);
$('modalClose').addEventListener('click', closeEditModal);
$('modalCancelBtn').addEventListener('click', closeEditModal);

// ── Modal pick button ────────────────────────────────────────
$('modalPickBtn').addEventListener('click', async () => {
  if (!currentTabId) return;
  const watcherId = $('modalWatcherId').value;
  chrome.storage.local.set({ modalPickWatcherId: watcherId });
  closeEditModal();
  await ensureContentScript(currentTabId);
  chrome.tabs.sendMessage(currentTabId, { type: 'START_PICKER' });
  window.close();
});

$('editModal').addEventListener('click', (e) => {
  if (e.target === $('editModal')) closeEditModal();
});

$('modalSaveBtn').addEventListener('click', () => {
  const id = $('modalWatcherId').value;
  const compareMode = $('modalCompareMode').value;
  const checkMode = $('modalCheckMode').value;
  const forceScheduled = compareMode === 'visual' || checkMode === 'background';
  chrome.runtime.sendMessage({
    type: 'UPDATE_WATCHER',
    watcherId: id,
    selectorLabel: $('modalLabel').value.trim(),
    selector: $('modalSelector').value.trim() || null,
    compareMode,
    checkMode,
    mode: forceScheduled ? 'poll' : $('modalMode').value,
    pollInterval: parseInt($('modalPollInterval').value),
    cooldown: parseInt($('modalCooldown').value),
    persistent: $('modalPersistent').checked
  }, () => {
    closeEditModal();
    refreshActiveList();
  });
});

// ── Countdown timer tick ──────────────────────────────────────
setInterval(() => {
  document.querySelectorAll('.watcher-countdown').forEach(el => {
    const next = parseInt(el.dataset.next);
    const interval = parseInt(el.dataset.interval);
    if (!next || !interval) return;
    let remaining = Math.max(0, Math.ceil((next - Date.now()) / 1000));
    if (remaining <= 0) {
      el.dataset.next = String(Date.now() + interval);
      remaining = Math.ceil(interval / 1000);
    }
    el.innerHTML = `Next check in <strong>${remaining}s</strong>`;
  });
}, 1000);

// ── Dashboard link ────────────────────────────────────────────
$('dashboardLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// Clear label display when selector input is manually changed, reveal options
$('selectorInput').addEventListener('input', () => {
  currentSelectorLabel = '';
  $('selectorLabelDisplay').classList.remove('visible');
  if ($('selectorInput').value.trim()) revealOptions();
});

// Update options summary when persistent toggle changes
$('persistentToggle').addEventListener('change', updateOptionsSummary);
