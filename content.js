(function () {
  "use strict";

  const POLL_INTERVAL = 2000;
  const DEBOUNCE_DELAY = 1500;
  const STREAMING_SETTLE_DELAY = 3000;
  const MIN_ASSISTANT_RESPONSE_LENGTH = 5;

  let currentSession = null;
  let knownMessageCount = 0;
  let isCapturing = false;
  let isProcessing = false;         // FIX #1: re-entrancy lock for processMessages
  let rawInputInitialized = false;  // FIX #6: guard InputCapture.init() to run once
  let debounceTimer = null;
  let extractor = null;
  let observer = null;
  let settingsCache = null;
  let pollIntervalId = null;
  let initPromise = null;
  let currentThreadKey = null;
  let lastKnownUrl = null;

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
    return settingsCache;
  }

  // FIX #6: Guard InputCapture.init() so it is called at most once per
  // content script lifetime, regardless of how often startOrResumeSession runs.
  function ensureRawInputCapture(settings) {
    if (settings.captureRawInput && !rawInputInitialized) {
      InputCapture.init();
      rawInputInitialized = true;
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
  }

  async function finalizeCurrentSession(reason) {
    if (!currentSession) return;

    await SessionStorage.finalizeSession(currentSession.sessionId, reason);
    currentSession = null;
    currentThreadKey = null;
    knownMessageCount = 0;
    isCapturing = false;
  }

  async function startOrResumeSession(reason) {
    const settings = settingsCache || (await loadSettings());
    extractor = detectPlatform();

    if (!extractor) {
      console.log("[AI Chat Capture] No supported platform detected");
      return false;
    }

    ensureRawInputCapture(settings);

    if (!settings.captureEnabled) {
      console.log("[AI Chat Capture] Capture disabled in settings");
      isCapturing = false;
      return false;
    }

    const nextThreadKey = getThreadKey();
    if (!nextThreadKey) return false;

    if (currentSession && currentThreadKey !== nextThreadKey) {
      await finalizeCurrentSession(reason || "thread_changed");
    }

    if (currentSession && currentThreadKey === nextThreadKey) {
      isCapturing = !currentSession.lockedAt;
      return true;
    }

    const result = await SessionStorage.getOrCreateActiveSession(
      extractor.PLATFORM,
      window.location.href,
      nextThreadKey
    );

    currentSession = result.session;
    currentThreadKey = nextThreadKey;
    lastKnownUrl = window.location.href;

    // FIX #2: Restore knownMessageCount from the persisted domMessageCount field
    // rather than entryCount. entryCount includes error stubs and other synthetic
    // chain entries that do not correspond to DOM message nodes. Using entryCount
    // causes a desync after reload, leading to missed or re-processed messages.
    knownMessageCount = currentSession.domMessageCount || 0;

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

    return true;
  }

  async function initCapture() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const started = await startOrResumeSession("init");

      if (!pollIntervalId) {
        pollIntervalId = setInterval(async () => {
          await syncCaptureCycle();
        }, POLL_INTERVAL * 5);
      }

      if (started) {
        await pollAndCapture();
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
        return;
      }

      extractor = nextExtractor;

      if (currentUrl !== lastKnownUrl || getThreadKey() !== currentThreadKey) {
        await startOrResumeSession("thread_changed");
      }

      lastKnownUrl = currentUrl;

      if (isCapturing) {
        await pollAndCapture();
      }
    } catch (error) {
      console.error("[AI Chat Capture] syncCaptureCycle failed", error);
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
    // FIX #1: Re-entrancy lock. waitForStreamingComplete() blocks 6+ seconds per
    // assistant turn. Without this guard, the debounce observer, poll interval,
    // and FORCE_CAPTURE can all call processMessages concurrently, reading the
    // same knownMessageCount and producing duplicate chain entries.
    if (!extractor || !isCapturing || !currentSession || isProcessing) return;

    isProcessing = true;
    try {
      let messages = extractor.extractAllMessages();
      if (messages.length > knownMessageCount) {
        const newMessages = messages.slice(knownMessageCount);
        // FIX #9 guard: if the first new message is an assistant reply but the
        // session has equal promptCount and assistantCount (meaning we haven't
        // yet stored the user turn for this exchange), the user message DOM
        // element was probably filtered out due to empty text during extraction.
        // Wait 2 s and re-extract so ChatGPT's React render has time to populate
        // the text node before we process.
        if (
          newMessages.length > 0 &&
          newMessages[0].role === "assistant" &&
          currentSession.promptCount === currentSession.assistantCount
        ) {
          await sleep(2000);
          messages = extractor.extractAllMessages();
        }
        await processMessages(messages.slice(knownMessageCount));
      }
    } finally {
      isProcessing = false;
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
        // FIX #9: latestVersion.renderedText can be transiently empty if ChatGPT
        // re-renders the element between the two extractAllMessages calls (e.g. a
        // React reconciliation wipes the text node for a split second). Fall back
        // to the original captured text so storedText is never forced to "".
        const finalText = (latestVersion && latestVersion.renderedText)
          ? latestVersion.renderedText
          : msg.renderedText;

        const normalized = normalizeText(finalText);
        const isAssistantErrorEntry =
          msg.role === "assistant" &&
          normalized.length < MIN_ASSISTANT_RESPONSE_LENGTH;
        const storedText = isAssistantErrorEntry ? "" : normalized;

        if (!storedText && msg.role !== "assistant") {
          // Empty user message — skip this slot and keep moving. FIX #9 above
          // prevents genuine text from being lost; if storedText is still empty
          // here the message really is empty (rare). Continue rather than break
          // so subsequent messages are not stalled.
          knownMessageCount += 1;
          await SessionStorage.updateDomMessageCount(
            currentSession.sessionId,
            knownMessageCount
          );
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
          await SessionStorage.updateDomMessageCount(
            currentSession.sessionId,
            knownMessageCount
          );
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
        // FIX #2: Persist DOM count after every successful processed message.
        await SessionStorage.updateDomMessageCount(
          currentSession.sessionId,
          knownMessageCount
        );

        if (!appendResult) continue;

        currentSession = appendResult.session;

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
