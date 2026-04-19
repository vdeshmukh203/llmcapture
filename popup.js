(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Platform URL patterns — mirrors the isMatch() logic in each extractor.
  const PLATFORMS = [
    {
      name: 'ChatGPT',
      hostMatch: url => url.includes('chatgpt.com') || url.includes('chat.openai.com'),
      conversationMatch: url => /\/c\/[a-zA-Z0-9-]+/.test(url),
      conversationHint: 'Open or start a conversation on chatgpt.com.',
    },
    {
      name: 'Claude',
      hostMatch: url => url.includes('claude.ai'),
      conversationMatch: url => /\/chat\/[a-zA-Z0-9-]+/.test(url),
      conversationHint: 'Open or start a chat on claude.ai.',
    },
    {
      name: 'Gemini',
      hostMatch: url => url.includes('gemini.google.com'),
      conversationMatch: url => /\/app\/[a-zA-Z0-9]+/.test(new URL(url).pathname),
      conversationHint: 'Open a conversation on gemini.google.com.',
    },
  ];

  const captureStatus    = $('captureStatus');
  const platformName     = $('platformName');
  const messageCount     = $('messageCount');
  const promptCount      = $('promptCount');
  const sessionIdEl      = $('sessionId');
  const lockReason       = $('lockReason');
  const activeTabUrl     = $('activeTabUrl');
  const captureToggle    = $('captureToggle');
  const rawInputToggle   = $('rawInputToggle');
  const autoRefreshToggle = $('autoRefreshToggle');
  const refreshBtn       = $('refreshStatus');
  const forceCapture     = $('forceCapture');
  const sessionList      = $('sessionList');
  const exportAll        = $('exportAll');
  const verifyAll        = $('verifyAll');
  const clearAll         = $('clearAll');
  const verifyModal      = $('verifyModal');
  const verifyResults    = $('verifyResults');
  const closeModal       = $('closeModal');
  const initCaptureBtn   = $('initCapture');
  const preCheckPanel    = $('preCheckPanel');

  let timer = null;

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function setInactive(msg) {
    captureStatus.textContent = msg || 'Inactive';
    captureStatus.className = 'status-badge status-inactive';
    platformName.textContent = '-';
    messageCount.textContent = '0';
    promptCount.textContent = '0';
    sessionIdEl.textContent = '-';
    lockReason.textContent = '-';
  }

  async function refreshStatus() {
    try {
      const tab = await activeTab();
      activeTabUrl.textContent = tab?.url || '-';
      if (!tab) { setInactive('Inactive'); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, res => {
        if (chrome.runtime.lastError || !res) { setInactive('Inactive'); return; }
        if (res.locked) {
          captureStatus.textContent = 'Locked';
          captureStatus.className = 'status-badge status-inactive';
        } else if (res.isCapturing) {
          captureStatus.textContent = 'Active';
          captureStatus.className = 'status-badge status-active';
        } else {
          captureStatus.textContent = 'Paused';
          captureStatus.className = 'status-badge status-inactive';
        }
        platformName.textContent = res.platform || '-';
        messageCount.textContent = String(res.messageCount || 0);
        promptCount.textContent = String(res.promptCount || 0);
        sessionIdEl.textContent = res.sessionId || '-';
        lockReason.textContent = res.lockReason || '-';
      });
    } catch (e) {
      setInactive('Error');
    }
  }

  function integrityBadge(status) {
    if (status === 'verified') return '<span class="integrity-badge integrity-verified">&#10003; verified</span>';
    if (status === 'tampered') return '<span class="integrity-badge integrity-tampered">&#10007; tampered</span>';
    return '<span class="integrity-badge integrity-active">&#9679; active</span>';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
      return iso.slice(0, 16).replace('T', ' ');
    }
  }

  async function refreshSessionList() {
    const sessions = await SessionStorage.getAllSessions();
    if (!sessions.length) {
      sessionList.innerHTML = '<div class="empty-state">No sessions yet</div>';
      return;
    }
    sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    sessionList.innerHTML = sessions.map(s => `
      <div class="session-item">
        <div class="session-info">
          <div class="session-platform-row">
            <span class="session-platform">${s.platform}</span>
            ${integrityBadge(s.integrityStatus)}
          </div>
          <div class="session-meta">${s.promptCount || 0} prompts &middot; ${s.entryCount || 0} entries &middot; ${formatDate(s.startedAt)}</div>
        </div>
        <div class="session-actions">
          <button class="session-action-btn export" data-id="${s.sessionId}" title="Export forensic log + study manifest">Export</button>
        </div>
      </div>
    `).join('');
    document.querySelectorAll('.export').forEach(b => b.onclick = () => exportSession(b.dataset.id));
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: `llmcapture/session_logs/${filename}`, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          // Subdirectory creation failed (e.g. permission issue) — fall back to
          // root Downloads folder so the export is never silently lost.
          console.warn(
            '[AI Chat Capture] session_logs/ download failed:',
            chrome.runtime.lastError.message,
            '— retrying at Downloads root.'
          );
          chrome.downloads.download(
            { url, filename, saveAs: false },
            () => URL.revokeObjectURL(url)
          );
        } else {
          URL.revokeObjectURL(url);
        }
      }
    );
  }

  async function exportSession(id) {
    const exported = await SessionStorage.exportSession(id);
    if (!exported) return;
    const p = exported.forensicLog.session.platform;
    downloadJson(`ai-capture-${p}-${id}.json`, exported.forensicLog);
    downloadJson(`ai-capture-${p}-${id}-manifest.json`, exported.studyManifest);
  }

  async function refreshAll() {
    await refreshStatus();
    await refreshSessionList();
  }

  function startTimer() {
    clearInterval(timer);
    if (autoRefreshToggle.checked) {
      timer = setInterval(refreshAll, 2000);
    }
  }

  async function init() {
    const settings = await SessionStorage.getSettings();
    captureToggle.checked = settings.captureEnabled;
    rawInputToggle.checked = settings.captureRawInput;
    autoRefreshToggle.checked = true;
    await refreshAll();
    startTimer();
  }

  refreshBtn.onclick = refreshAll;
  autoRefreshToggle.onchange = startTimer;

  captureToggle.onchange = async () => {
    const s = await SessionStorage.getSettings();
    s.captureEnabled = captureToggle.checked;
    await SessionStorage.saveSettings(s);
    const tab = await activeTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CAPTURE', enabled: captureToggle.checked });
    await refreshAll();
  };

  rawInputToggle.onchange = async () => {
    const s = await SessionStorage.getSettings();
    s.captureRawInput = rawInputToggle.checked;
    await SessionStorage.saveSettings(s);
    // Notify content script so ensureRawInputCapture() runs immediately if now enabled.
    const tab = await activeTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED' });
  };

  forceCapture.onclick = async () => {
    const tab = await activeTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'FORCE_CAPTURE' }, () => refreshAll());
  };

  exportAll.onclick = async () => {
    const sessions = await SessionStorage.getAllSessions();
    for (const s of sessions) await exportSession(s.sessionId);
  };

  verifyAll.onclick = async () => {
    const sessions = await SessionStorage.getAllSessions();
    let html = '';
    for (const s of sessions) {
      const session = await SessionStorage.getSession(s.sessionId);
      if (!session) continue;
      const result = await CryptoChain.verifyChain(session.entries);
      html += `
        <div class="verify-session ${result.valid ? 'verify-valid' : 'verify-invalid'}">
          <div>${s.platform} &middot; ${s.promptCount || 0} prompts</div>
          <div class="verify-session-status ${result.valid ? 'valid' : 'invalid'}">
            ${result.valid ? 'Chain intact' : 'Tampering detected'}
          </div>
        </div>`;
    }
    verifyResults.innerHTML = html || '<div class="empty-state">No sessions</div>';
    verifyModal.classList.remove('hidden');
  };

  closeModal.onclick = () => verifyModal.classList.add('hidden');

  clearAll.onclick = async () => {
    const sessions = await SessionStorage.getAllSessions();
    if (!sessions.length) return;
    if (!window.confirm(`Delete all ${sessions.length} session(s)? This permanently removes all captured forensic records and cannot be undone.`)) return;
    for (const s of sessions) await SessionStorage.deleteSession(s.sessionId);
    await refreshAll();
  };

  // ── Pre-check & Initialize ─────────────────────────────────────────────────

  async function runPreCheck() {
    const checks = [];
    const tab = await activeTab();

    if (!tab?.url) {
      checks.push({ id: 'tab', label: 'Active tab', status: 'error', message: 'No active tab detected.' });
      return checks;
    }

    // 1. Platform
    const platform = PLATFORMS.find(p => p.hostMatch(tab.url));
    if (!platform) {
      checks.push({ id: 'platform', label: 'Platform', status: 'error',
        message: 'Not a supported platform. Navigate to ChatGPT, Claude, or Gemini.' });
      return checks;
    }
    checks.push({ id: 'platform', label: 'Platform', status: 'ok', message: platform.name + ' detected.' });

    // 2. Conversation URL (warn only — some platforms start a thread on first message)
    let isConversation = false;
    try { isConversation = platform.conversationMatch(tab.url); } catch (_) {}
    if (!isConversation) {
      checks.push({ id: 'conversation', label: 'Conversation', status: 'warn',
        message: platform.conversationHint });
    } else {
      checks.push({ id: 'conversation', label: 'Conversation', status: 'ok', message: 'Conversation URL confirmed.' });
    }

    // 3. Content script responding
    const scriptStatus = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, res => {
        if (chrome.runtime.lastError || !res) resolve(null);
        else resolve(res);
      });
    });

    if (!scriptStatus) {
      checks.push({ id: 'script', label: 'Content script', status: 'error',
        message: 'Extension not responding on this tab. Reload the page and try again.' });
      // Storage and session checks can't run without the content script
      const settings = await SessionStorage.getSettings();
      checks.push({ id: 'capture', label: 'Capture setting', status: settings.captureEnabled ? 'ok' : 'warn',
        message: settings.captureEnabled ? 'Enabled.' : 'Disabled — toggle "Capture Enabled" above.' });
      checks.push({ id: 'rawinput', label: 'Raw input', status: settings.captureRawInput ? 'ok' : 'warn',
        message: settings.captureRawInput ? 'Enabled.' : 'Disabled — keystroke layer will be absent from forensic log.' });
      return checks;
    }
    checks.push({ id: 'script', label: 'Content script', status: 'ok', message: 'Responding.' });

    // 4. Session / capture state
    if (scriptStatus.locked) {
      checks.push({ id: 'session', label: 'Session', status: 'warn',
        message: `Locked (${scriptStatus.lockReason || 'max turns reached'}). Export this session, then reload the page to start a new one.` });
    } else if (!scriptStatus.isCapturing) {
      checks.push({ id: 'session', label: 'Session', status: 'warn',
        message: 'Capture is paused on this tab. Initialization will re-enable it.' });
    } else {
      checks.push({ id: 'session', label: 'Session', status: 'ok',
        message: `Active — ${scriptStatus.promptCount || 0} prompt(s) recorded so far.` });
    }

    // 5. Settings
    const settings = await SessionStorage.getSettings();
    checks.push({ id: 'capture', label: 'Capture setting', status: settings.captureEnabled ? 'ok' : 'warn',
      message: settings.captureEnabled ? 'Enabled.' : 'Disabled — initialization will re-enable it.' });
    checks.push({ id: 'rawinput', label: 'Raw input', status: settings.captureRawInput ? 'ok' : 'warn',
      message: settings.captureRawInput ? 'Enabled.' : 'Off — keystroke layer absent. Toggle "Capture Raw Input" for full forensic records.' });

    return checks;
  }

  function renderPreCheckPanel(checks, resultStatus, resultMsg) {
    const icon = { ok: '✓', warn: '⚠', error: '✗' };
    const rows = checks.map(c => `
      <div class="precheck-item precheck-${c.status}">
        <span class="precheck-icon">${icon[c.status]}</span>
        <span class="precheck-label">${c.label}</span>
        <span class="precheck-msg">${c.message}</span>
      </div>`).join('');
    const resultClass = `precheck-result precheck-result-${resultStatus}`;
    preCheckPanel.innerHTML = rows + `<div class="${resultClass}">${resultMsg}</div>`;
    preCheckPanel.classList.remove('hidden');
  }

  initCaptureBtn.onclick = async () => {
    initCaptureBtn.textContent = 'Checking…';
    initCaptureBtn.disabled = true;
    preCheckPanel.classList.add('hidden');

    const checks = await runPreCheck();
    const hasError = checks.some(c => c.status === 'error');
    const hasWarn  = checks.some(c => c.status === 'warn');

    if (hasError) {
      renderPreCheckPanel(checks, 'error', '✗ Fix the errors above before capture can start.');
      initCaptureBtn.textContent = 'Re-check';
      initCaptureBtn.disabled = false;
      return;
    }

    // No hard errors — attempt to initialize capture.
    const tab = await activeTab();
    const settings = await SessionStorage.getSettings();

    // Ensure settings flag is on before telling the content script.
    if (!settings.captureEnabled) {
      settings.captureEnabled = true;
      await SessionStorage.saveSettings(settings);
      captureToggle.checked = true;
    }

    if (tab) {
      await new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CAPTURE', enabled: true }, () => resolve());
      });
    }

    await refreshAll();

    const resultStatus = hasWarn ? 'warn' : 'ok';
    const resultMsg = hasWarn
      ? '✓ Capture started — review warnings above.'
      : '✓ All checks passed — capture active.';
    renderPreCheckPanel(checks, resultStatus, resultMsg);

    initCaptureBtn.textContent = 'Re-check';
    initCaptureBtn.disabled = false;
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  window.addEventListener('unload', () => clearInterval(timer));

  init();
})();
