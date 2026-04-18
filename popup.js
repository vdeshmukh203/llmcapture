(function () {
  "use strict";

  const captureStatus = document.getElementById("captureStatus");
  const platformName = document.getElementById("platformName");
  const messageCount = document.getElementById("messageCount");
  const sessionIdEl = document.getElementById("sessionId");
  const captureToggle = document.getElementById("captureToggle");
  const rawInputToggle = document.getElementById("rawInputToggle");
  const forceCapture = document.getElementById("forceCapture");
  const sessionList = document.getElementById("sessionList");
  const exportAll = document.getElementById("exportAll");
  const verifyAll = document.getElementById("verifyAll");
  const clearAll = document.getElementById("clearAll");
  const verifyModal = document.getElementById("verifyModal");
  const verifyResults = document.getElementById("verifyResults");
  const closeModal = document.getElementById("closeModal");

  async function init() {
    const settings = await SessionStorage.getSettings();
    captureToggle.checked = settings.captureEnabled;
    rawInputToggle.checked = settings.captureRawInput;

    await refreshStatus();
    await refreshSessionList();
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function refreshStatus() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) return;

      chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_STATUS" },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            captureStatus.textContent = "Inactive";
            captureStatus.className = "status-badge status-inactive";
            platformName.textContent = "Not on AI chat page";
            messageCount.textContent = "0";
            sessionIdEl.textContent = "-";
            return;
          }

          if (response.locked) {
            captureStatus.textContent = "Locked";
            captureStatus.className = "status-badge status-inactive";
          } else if (response.isCapturing) {
            captureStatus.textContent = "Active";
            captureStatus.className = "status-badge status-active";
          } else {
            captureStatus.textContent = "Paused";
            captureStatus.className = "status-badge status-inactive";
          }

          platformName.textContent = response.platform || "-";
          messageCount.textContent = String(response.messageCount || 0);
          sessionIdEl.textContent = response.sessionId || "-";
        }
      );
    } catch (e) {
      console.log("Could not get status:", e);
    }
  }

  async function refreshSessionList() {
    const sessions = await SessionStorage.getAllSessions();

    if (sessions.length === 0) {
      sessionList.innerHTML = '<div class="empty-state">No sessions yet</div>';
      return;
    }

    sessions.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    sessionList.innerHTML = sessions
      .map((s) => {
        const date = new Date(s.startedAt);
        const dateStr = date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const status = s.status || "unknown";
        const prompts = typeof s.promptCount === "number" ? s.promptCount : 0;

        return `
        <div class="session-item" data-session-id="${s.sessionId}">
          <div class="session-info">
            <div class="session-platform">${s.platform}</div>
            <div class="session-meta">${dateStr} - ${prompts} prompts - ${status}</div>
          </div>
          <div class="session-actions">
            <button class="session-action-btn export" title="Export JSON" data-session-id="${s.sessionId}">
              Export
            </button>
            <button class="session-action-btn delete" title="Delete" data-session-id="${s.sessionId}">
              Del
            </button>
          </div>
        </div>`;
      })
      .join("");

    sessionList.querySelectorAll(".session-action-btn.export").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        exportSession(btn.dataset.sessionId);
      });
    });

    sessionList.querySelectorAll(".session-action-btn.delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSession(btn.dataset.sessionId);
      });
    });
  }

  async function exportSession(sessionId) {
    const exported = await SessionStorage.exportSession(sessionId);
    if (!exported) return;

    const platform = exported.forensicLog.session.platform;
    downloadJson(
      `ai-capture-${platform}-${sessionId}.json`,
      exported.forensicLog
    );
    downloadJson(
      `ai-capture-${platform}-${sessionId}-manifest.json`,
      exported.studyManifest
    );
  }

  async function deleteSession(sessionId) {
    await SessionStorage.deleteSession(sessionId);
    await refreshSessionList();
  }

  captureToggle.addEventListener("change", async () => {
    const settings = await SessionStorage.getSettings();
    settings.captureEnabled = captureToggle.checked;
    await SessionStorage.saveSettings(settings);

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          type: "TOGGLE_CAPTURE",
          enabled: captureToggle.checked,
        });
        chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" });
      }
    } catch (e) {
      console.log("Could not send toggle:", e);
    }

    await refreshStatus();
    await refreshSessionList();
  });

  rawInputToggle.addEventListener("change", async () => {
    const settings = await SessionStorage.getSettings();
    settings.captureRawInput = rawInputToggle.checked;
    await SessionStorage.saveSettings(settings);

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" });
      }
    } catch (e) {
      console.log("Could not send settings update:", e);
    }
  });

  forceCapture.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        chrome.tabs.sendMessage(
          tab.id,
          { type: "FORCE_CAPTURE" },
          async (response) => {
            if (response) {
              messageCount.textContent = String(response.messageCount || 0);
            }
            await refreshSessionList();
            await refreshStatus();
          }
        );
      }
    } catch (e) {
      console.log("Could not force capture:", e);
    }

    forceCapture.textContent = "Captured!";
    setTimeout(() => {
      forceCapture.textContent = "Force Capture Now";
    }, 1500);
  });

  exportAll.addEventListener("click", async () => {
    const sessions = await SessionStorage.getAllSessions();
    const forensicLogs = [];
    const studyManifests = [];

    for (const s of sessions) {
      const exported = await SessionStorage.exportSession(s.sessionId);
      if (!exported) continue;
      forensicLogs.push(exported.forensicLog);
      studyManifests.push(exported.studyManifest);
    }

    if (forensicLogs.length === 0) return;

    downloadJson(`ai-capture-bundle-${Date.now()}.json`, {
      _format: "ai-chat-capture-bundle-v12",
      _exportedAt: new Date().toISOString(),
      sessionCount: forensicLogs.length,
      sessions: forensicLogs,
    });

    downloadJson(`ai-capture-study-manifest-bundle-${Date.now()}.json`, {
      _format: "ai-chat-capture-study-manifest-bundle-v1",
      _exportedAt: new Date().toISOString(),
      sessionCount: studyManifests.length,
      manifests: studyManifests,
    });
  });

  verifyAll.addEventListener("click", async () => {
    const sessions = await SessionStorage.getAllSessions();
    let html = "";

    for (const s of sessions) {
      const session = await SessionStorage.getSession(s.sessionId);
      if (!session) continue;

      const result = await CryptoChain.verifyChain(session.entries);
      const validClass = result.valid ? "verify-valid" : "verify-invalid";
      const statusClass = result.valid ? "valid" : "invalid";
      const statusText = result.valid
        ? "Chain intact - no tampering detected"
        : `TAMPERING DETECTED - ${result.entries.filter((e) => !e.valid).length} broken link(s)`;

      html += `
        <div class="verify-session ${validClass}">
          <div class="verify-session-name">${s.platform} (${s.promptCount || 0} prompts)</div>
          <div class="verify-session-status ${statusClass}">${statusText}</div>
        </div>`;
    }

    if (!html) {
      html = '<div class="empty-state">No sessions to verify</div>';
    }

    verifyResults.innerHTML = html;
    verifyModal.classList.remove("hidden");
  });

  closeModal.addEventListener("click", () => {
    verifyModal.classList.add("hidden");
  });

  clearAll.addEventListener("click", async () => {
    const sessions = await SessionStorage.getAllSessions();
    for (const s of sessions) {
      await SessionStorage.deleteSession(s.sessionId);
    }
    await refreshSessionList();
    await refreshStatus();
  });

  init();
})();
