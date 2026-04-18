(function () {
  "use strict";

  const POLL_INTERVAL = 2000;
  const DEBOUNCE_DELAY = 1500;
  const STREAMING_SETTLE_DELAY = 3000;
  const MIN_ASSISTANT_RESPONSE_LENGTH = 5;

  let currentSession = null;
  let knownMessageCount = 0;
  let isCapturing = false;
  let debounceTimer = null;
  let extractor = null;
  let observer = null;
  let settingsCache = null;
  let pollIntervalId = null;
  let initPromise = null;
  let currentThreadKey = null;
  let lastKnownUrl = null;
  let lastDebug = {
    stage: "boot",
    reason: "not_initialized",
    captureEnabled: null,
    threadKey: null,
    lastError: null,
    extractorFound: false,
    lastMessageScanCount: 0,
  };

  function setDebug(patch) {
    lastDebug = { ...lastDebug, ...patch };
  }

  function detectPlatform() {
    const url = window.location.href;
    if (typeof ChatGPTExtractor !== "undefined" && ChatGPTExtractor.isMatch(url)) {
      return ChatGPTExtractor;
    }
    if (typeof ClaudeExtractor !== "undefined" && ClaudeExtractor.isMatch(url)) {
      return ClaudeExtractor;
    }
    if (typeof GeminiExtractor !== "undefined" && GeminiExtractor.isMatch(url)) {
      return GeminiExtractor;
    }
    return null;
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getThreadKey() {
    if (!extractor) return null;

    if (typeof extractor.getThreadKey === "function") {
      const extractorKey = extractor.getThreadKey();
      if (extractorKey) return `${extractor.PLATFORM}:${extractorKey}`;
    }

    try {
      const parsed = new URL(window.location.href);
      return `${extractor.PLATFORM}:${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch (e) {
      return `${extractor.PLATFORM}:${window.location.href}`;
    }
  }

  async function loadSettings() {
    settingsCache = await SessionStorage.getSettings();
    setDebug({ captureEnabled: !!settingsCache.captureEnabled });
    return settingsCache;
  }

  function ensureRawInputCapture(settings) {
    if (settings.captureRawInput) {
      InputCapture.init();
      console.log("[AI Chat Capture] Raw input capture enabled");
    }
  }

  function bindObserver() {
    if (!extractor) return;

    if (observer) {
      observer.disconnect();
    }

    observer = extractor.observeNewMessages(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await syncCaptureCycle();
      }, DEBOUNCE_DELAY);
    });
    setDebug({ stage: "observer_bound", reason: "observer_active" });
  }

  async function finalizeCurrentSession(reason) {
    if (!currentSession) return;

    await SessionStorage.finalizeSession(currentSession.sessionId, reason);
    currentSession = null;
    currentThreadKey = null;
    knownMessageCount = 0;
    isCapturing = false;
    setDebug({ stage: "finalized", reason: reason || "finalized", threadKey: null });
  }

  async function startOrResumeSession(reason) {
    const settings = settingsCache || (await loadSettings());
    extractor = detectPlatform();
    setDebug({
      stage: "start_or_resume",
      reason: reason || "manual",
      extractorFound: !!extractor,
      captureEnabled: !!settings.captureEnabled,
      lastError: null,
    });

    if (!extractor) {
      console.log("[AI Chat Capture] No supported platform detected");
      setDebug({ stage: "unsupported", reason: "no_supported_platform" });
      return false;
    }

    ensureRawInputCapture(settings);

    if (!settings.captureEnabled) {
      console.log("[AI Chat Capture] Capture disabled in settings");
      isCapturing = false;
      setDebug({ stage: "disabled", reason: "capture_disabled_in_settings" });
      return false;
    }

    const nextThreadKey = getThreadKey();
    setDebug({ threadKey: nextThreadKey || null });
    if (!nextThreadKey) {
      setDebug({ stage: "blocked", reason: "missing_thread_key" });
      return false;
    }

    if (currentSession && currentThreadKey !== nextThreadKey) {
      await finalizeCurrentSession(reason || "thread_changed");
    }

    if (currentSession && currentThreadKey === nextThreadKey) {
      isCapturing = !currentSession.lockedAt;
      setDebug({ stage: "resumed", reason: "existing_session", threadKey: currentThreadKey });
      return true;
    }

    try {
      const result = await SessionStorage.getOrCreateActiveSession(
        extractor.PLATFORM,
        window.location.href,
        nextThreadKey
      );

      currentSession = result.session;
      currentThreadKey = nextThreadKey;
      lastKnownUrl = window.location.href;
      knownMessageCount = currentSession.entryCount;
      isCapturing = !currentSession.lockedAt;

      bindObserver();

      chrome.runtime.sendMessage({
        type: "SESSION_STARTED",
        sessionId: currentSession.sessionId,
        platform: extractor.PLATFORM,
        resumed: result.resumed,
        locked: !!currentSession.lockedAt,
      });

      console.log(
        `[AI Chat Capture] ${result.resumed ? "Recovered" : "Started"} session ${currentSession.sessionId} (${currentThreadKey})`
      );

      setDebug({
        stage: result.resumed ? "session_resumed" : "session_started",
        reason: result.resumed ? "existing_active_session" : "new_session_created",
        threadKey: currentThreadKey,
      });

      return true;
    } catch (error) {
      setDebug({ stage: "session_error", reason: "get_or_create_failed", lastError: String(error) });
      throw error;
    }
  }

  async function initCapture() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      setDebug({ stage: "init_capture", reason: "starting_init" });
      const started = await startOrResumeSession("init");

      if (!pollIntervalId) {
        pollIntervalId = setInterval(async () => {
          await syncCaptureCycle();
        }, POLL_INTERVAL * 5);
      }

      if (started) {
        await pollAndCapture();
      }

      if (!started) {
        setDebug({ stage: "init_complete", reason: lastDebug.reason || "not_started" });
      }

      return started;
    })();

    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function syncCaptureCycle() {
    try {
      const currentUrl = window.location.href;
      const nextExtractor = detectPlatform();

      if (!nextExtractor) {
        if (currentSession) {
          await finalizeCurrentSession("left_supported_platform");
        }
        setDebug({ stage: "sync", reason: "no_supported_platform" });
        return;
      }

      extractor = nextExtractor;

      if (currentUrl !== lastKnownUrl || getThreadKey() !== currentThreadKey) {
        await startOrResumeSession("thread_changed");
      }

      lastKnownUrl = currentUrl;

      if (isCapturing) {
        await pollAndCapture();
      } else {
        setDebug({ stage: "sync_idle", reason: lastDebug.reason || "capture_not_active" });
      }
    } catch (error) {
      console.error("[AI Chat Capture] syncCaptureCycle failed", error);
      setDebug({ stage: "sync_error", reason: "syncCaptureCycle_failed", lastError: String(error) });
      if (currentSession) {
        await SessionStorage.logSessionError(
          currentSession.sessionId,
          "syncCaptureCycle failed",
          { error: String(error) }
        );
      }
    }
  }

  async function pollAndCapture() {
    if (!extractor || !isCapturing || !currentSession) return;

    const messages = extractor.extractAllMessages();
    setDebug({ stage: "poll", reason: "message_scan", lastMessageScanCount: messages.length });
    if (messages.length > knownMessageCount) {
      const newMessages = messages.slice(knownMessageCount);
      await processMessages(newMessages);
    }
  }

  async function findRawInput(msg, settings) {
    if (!settings.captureRawInput || msg.role !== "user") return null;

    const matchedRaw = InputCapture.findMatchingRawInput(msg.renderedText);
    if (!matchedRaw) return null;

    return {
      text: matchedRaw.text,
      capturedAt: matchedRaw.timestamp,
      source: matchedRaw.source,
      submittedAt: matchedRaw.submittedAt || null,
    };
  }

  function isDuplicateMessage(role, renderedText) {
    if (!currentSession || currentSession.entries.length === 0) return false;

    const lastEntry = currentSession.entries[currentSession.entries.length - 1];
    return (
      lastEntry.role === role &&
      normalizeText(lastEntry.renderedText) === normalizeText(renderedText)
    );
  }

  async function processMessages(messages) {
    const settings = settingsCache || (await loadSettings());

    for (const msg of messages) {
      if (!currentSession) break;

      try {
        let rawInput = await findRawInput(msg, settings);

        if (msg.role === "assistant") {
          await waitForStreamingComplete(msg);
        }

        const currentMessages = extractor.extractAllMessages();
        const latestVersion = currentMessages.find(
          (m) => m.index === msg.index && m.role === msg.role
        );
        const finalText = latestVersion
          ? latestVersion.renderedText
          : msg.renderedText;

        const normalized = normalizeText(finalText);
        const isAssistantErrorEntry =
          msg.role === "assistant" &&
          normalized.length < MIN_ASSISTANT_RESPONSE_LENGTH;
        const storedText = isAssistantErrorEntry ? "" : normalized;

        if (!storedText && msg.role !== "assistant") {
          knownMessageCount += 1;
          continue;
        }

        if (isDuplicateMessage(msg.role, storedText)) {
          currentSession = await SessionStorage.recordDuplicate(
            currentSession.sessionId,
            {
              role: msg.role,
              textPreview: storedText.substring(0, 120),
            }
          );
          knownMessageCount += 1;
          continue;
        }

        const appendResult = await SessionStorage.appendEntry(
          currentSession.sessionId,
          msg.role,
          storedText,
          rawInput,
          {
            status: isAssistantErrorEntry
              ? "ERROR"
              : currentSession.recoveredAt
                ? "recovered"
                : "captured",
            errorDetail: isAssistantErrorEntry
              ? "Empty or minimal assistant response"
              : null,
          }
        );

        knownMessageCount += 1;

        if (!appendResult) continue;

        currentSession = appendResult.session;
        setDebug({ stage: "captured", reason: `entry_added_${msg.role}` });

        if (appendResult.rejected) {
          isCapturing = false;
          chrome.runtime.sendMessage({
            type: "SESSION_LOCKED",
            sessionId: currentSession ? currentSession.sessionId : null,
            reason: appendResult.reason,
          });
          break;
        }

        const entry = appendResult.entry;
        chrome.runtime.sendMessage({
          type: "ENTRY_ADDED",
          sessionId: currentSession.sessionId,
          turn: entry.turn,
          chainPosition: entry.chainPosition,
          role: entry.role,
          textPreview: storedText.substring(0, 100),
          hasRawInput: !!rawInput,
          status: entry.status,
        });

        if (currentSession.lockedAt) {
          isCapturing = false;
          chrome.runtime.sendMessage({
            type: "SESSION_LOCKED",
            sessionId: currentSession.sessionId,
            reason: currentSession.lockReason,
          });
          break;
        }
      } catch (error) {
        console.error("[AI Chat Capture] processMessages failed", error);
        setDebug({ stage: "process_error", reason: "processMessages_failed", lastError: String(error) });
        await SessionStorage.logSessionError(
          currentSession.sessionId,
          "processMessages failed",
          {
            role: msg.role,
            error: String(error),
          }
        );
      }
    }
  }

  async function waitForStreamingComplete(msg) {
    let lastText = msg.renderedText;
    let stableCount = 0;

    while (stableCount < 2) {
      await sleep(STREAMING_SETTLE_DELAY);
      const messages = extractor.extractAllMessages();
      const current = messages.find(
        (m) => m.index === msg.index && m.role === msg.role
      );

      if (!current) break;

      if (current.renderedText === lastText) {
        stableCount += 1;
      } else {
        lastText = current.renderedText;
        stableCount = 0;
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_STATUS") {
      sendResponse({
        isCapturing: isCapturing,
        platform: extractor ? extractor.PLATFORM : null,
        sessionId: currentSession ? currentSession.sessionId : null,
        messageCount: currentSession ? currentSession.entryCount : 0,
        promptCount: currentSession ? currentSession.promptCount : 0,
        locked: currentSession ? !!currentSession.lockedAt : false,
        lockReason: currentSession ? currentSession.lockReason : null,
        debug: lastDebug,
      });
      return true;
    }

    if (message.type === "TOGGLE_CAPTURE") {
      if (message.enabled) {
        initCapture().then((started) => {
          sendResponse({
            isCapturing,
            started: !!started,
            sessionId: currentSession ? currentSession.sessionId : null,
          });
        });
      } else {
        isCapturing = false;
        setDebug({ stage: "paused", reason: "toggle_capture_disabled" });
        sendResponse({ isCapturing });
      }
      return true;
    }

    if (message.type === "FORCE_CAPTURE") {
      syncCaptureCycle().then(() => {
        sendResponse({
          success: true,
          messageCount: currentSession ? currentSession.entryCount : 0,
        });
      });
      return true;
    }

    if (message.type === "SETTINGS_UPDATED") {
      loadSettings().then((settings) => {
        ensureRawInputCapture(settings);
        setDebug({ captureEnabled: !!settings.captureEnabled, stage: "settings_updated", reason: "settings_reloaded" });
      });
      return true;
    }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(initCapture, 1000);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(initCapture, 1000);
    });
  }
})();
