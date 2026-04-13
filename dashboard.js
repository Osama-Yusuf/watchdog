// dashboard.js — Page Watchdog v2.0 Dashboard

let allWatchers = [];
let allChanges = [];
let selectedFilter = 'all';

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatTimeShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

// ── Load data ─────────────────────────────────────────────────
function loadData() {
  chrome.runtime.sendMessage({ type: 'GET_ALL_WATCHERS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    allWatchers = res.watchers || [];
    renderWatchers();
    populateFilter();
  });

  chrome.runtime.sendMessage({ type: 'GET_CHANGE_LOG' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    allChanges = res.changes || [];
    renderLog();
  });
}

// ── Render watcher cards ──────────────────────────────────────
function renderWatchers() {
  const grid = document.getElementById('watcherGrid');
  grid.innerHTML = '';

  if (allWatchers.length === 0) {
    grid.innerHTML = '<div class="empty-state">No watchers yet.<br>Open the extension popup on any page to start watching.</div>';
    return;
  }

  allWatchers.forEach(w => {
    const card = document.createElement('div');
    card.className = `watcher-card ${w.status}`;
    const selectorTitle = escHtml(w.selector || 'Full page');
    const url = escHtml(w.url || '');

    // Current value stored on watcher
    const currentValue = w.currentValue ? escHtml(w.currentValue) : '';

    // Check method badge
    const checkMethodLabel = w.checkMode === 'background' ? 'Stealth (background tab)' : 'This tab (live)';
    const checkMethodClass = w.checkMode === 'background' ? 'stealth' : 'live';

    // Compare mode badge
    const compareModeLabel = w.compareMode === 'visual' ? 'Visual' : 'Content';
    const compareModeClass = w.compareMode === 'visual' ? 'visual' : 'content';

    // Detection mode label
    const detectionLabel = (w.compareMode === 'visual' || w.checkMode === 'background') ? 'Scheduled' : (w.mode === 'mutation' ? 'Instant' : w.mode === 'both' ? 'Instant + Scheduled' : 'Scheduled');

    // Poll interval display
    const hasPoll = w.checkMode === 'background' || w.mode === 'poll' || w.mode === 'both';
    const pollSeconds = hasPoll ? Math.round((w.pollInterval || 30000) / 1000) : 0;

    // Countdown for poll-based watchers
    let countdownHtml = '';
    if (hasPoll && w.status === 'active' && w.lastPollTime && w.pollInterval) {
      const nextPoll = w.lastPollTime + w.pollInterval;
      const remaining = Math.max(0, Math.ceil((nextPoll - Date.now()) / 1000));
      countdownHtml = `<span class="card-countdown" data-next="${nextPoll}" data-interval="${w.pollInterval}">Next check in <strong>${remaining}s</strong></span>`;
    }

    // Changes history
    const changesHtml = (w.changes || []).slice(-10).reverse().map(c =>
      `<div class="card-change-item">
        <div class="card-change-time">${formatTimeShort(c.timestamp)}</div>
        <div class="card-change-preview">${escHtml(c.preview || 'Content changed')}</div>
      </div>`
    ).join('');

    card.innerHTML = `
      <div class="card-header">
        <span class="card-dot ${w.status}"></span>
        <span class="card-label">${selectorTitle}${currentValue ? `<span class="card-value">${currentValue}</span>` : ''}</span>
        <span class="card-status">${w.status}</span>
      </div>
      <div class="card-url">${w.url ? `<a href="${url}" class="card-url-link" data-url="${url}" title="${url}">${url}</a>` : 'No URL'}</div>
      <div class="card-method-row">
        <span class="card-method-badge ${compareModeClass}">${compareModeLabel}</span>
        <span class="card-method-badge ${checkMethodClass}">${checkMethodLabel}</span>
        <span class="card-detection">${detectionLabel}${pollSeconds ? ` · ${pollSeconds}s` : ''}</span>
        ${w.persistent ? '<span class="card-tag">Persistent</span>' : ''}
      </div>
      <div class="card-stats">
        <span class="meta-item">Changes: <span class="meta-value">${w.changeCount || 0}</span></span>
        <span class="meta-item">Last: <span class="meta-value">${formatTime(w.lastChangeTime)}</span></span>
      </div>
      ${countdownHtml}
      <div class="card-actions">
        ${w.status === 'active'
          ? `<button class="card-btn" data-action="pause" data-id="${w.id}">Pause</button>`
          : w.status === 'paused'
            ? `<button class="card-btn primary" data-action="resume" data-id="${w.id}">Resume</button>`
            : ''
        }
        <button class="card-btn edit-btn" data-action="edit" data-id="${w.id}">Edit</button>
        <button class="card-btn danger" data-action="delete" data-id="${w.id}">Delete</button>
      </div>
      ${(w.changes || []).length > 0
        ? `<button class="card-expand-btn" data-expand="${w.id}">Show change history (${w.changes.length})</button>
           <div class="card-changes" id="changes-${w.id}">${changesHtml}</div>`
        : ''
      }
    `;
    grid.appendChild(card);
  });

  // Bind action buttons
  grid.querySelectorAll('.card-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'pause') {
        chrome.runtime.sendMessage({ type: 'PAUSE_WATCH', watcherId: id }, () => loadData());
      } else if (action === 'resume') {
        chrome.runtime.sendMessage({ type: 'RESUME_WATCH', watcherId: id }, () => loadData());
      } else if (action === 'delete') {
        chrome.runtime.sendMessage({ type: 'DELETE_WATCHER', watcherId: id }, () => loadData());
      } else if (action === 'edit') {
        const w = allWatchers.find(x => x.id === id);
        if (w) openEditModal(w);
      }
    });
  });

  // Bind URL links
  grid.querySelectorAll('.card-url-link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: a.dataset.url });
    });
  });

  // Bind expand buttons
  grid.querySelectorAll('.card-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.expand;
      const panel = document.getElementById(`changes-${id}`);
      if (panel) {
        const vis = panel.classList.toggle('visible');
        btn.textContent = vis ? 'Hide change history' : `Show change history`;
      }
    });
  });
}

// ── Populate filter dropdown ──────────────────────────────────
function populateFilter() {
  const select = document.getElementById('logFilter');
  // Keep the "All watchers" option, remove the rest
  while (select.options.length > 1) select.remove(1);

  allWatchers.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.selector || 'Full page';
    select.appendChild(opt);
  });

  select.value = selectedFilter;
}

// ── Render change log ─────────────────────────────────────────
function renderLog() {
  const list = document.getElementById('logTimeline');
  list.innerHTML = '';

  let filtered = allChanges;
  if (selectedFilter !== 'all') {
    filtered = allChanges.filter(c => c.watcherId === selectedFilter);
  }

  if (filtered.length === 0) {
    list.innerHTML = '<li class="empty-state">No changes recorded yet.</li>';
    return;
  }

  filtered.slice(0, 50).forEach(c => {
    const li = document.createElement('li');
    li.className = 'log-entry';
    li.innerHTML = `
      <div class="log-time-col">${formatTimeShort(c.timestamp)}</div>
      <div class="log-content">
        <div class="log-watcher-label">${escHtml(c.selector || 'Full page')}</div>
        <div class="log-preview-text">${escHtml(c.preview || 'Content changed')}</div>
      </div>
    `;
    list.appendChild(li);
  });
}

// ── Filter handler ────────────────────────────────────────────
document.getElementById('logFilter').addEventListener('change', (e) => {
  selectedFilter = e.target.value;
  renderLog();
});

// ── Listen for real-time updates ──────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WATCHER_UPDATED') {
    loadData();
  }
});

// ── Edit modal ───────────────────────────────────────────────
const $ = id => document.getElementById(id);

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
    loadData();
  });
});

// ── Countdown timer tick ──────────────────────────────────────
setInterval(() => {
  document.querySelectorAll('.card-countdown').forEach(el => {
    const next = parseInt(el.dataset.next);
    const interval = parseInt(el.dataset.interval);
    if (!next || !interval) return;
    let remaining = Math.max(0, Math.ceil((next - Date.now()) / 1000));
    if (remaining <= 0) {
      // Reset for next cycle
      el.dataset.next = String(Date.now() + interval);
      remaining = Math.ceil(interval / 1000);
    }
    el.innerHTML = `Next check in <strong>${remaining}s</strong>`;
  });
}, 1000);

// ── Initial load ──────────────────────────────────────────────
loadData();
