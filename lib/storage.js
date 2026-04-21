var SessionStorage = (function () {
  "use strict";

  const STORAGE_KEY_PREFIX = "aicap_session_";
  const INDEX_KEY = "aicap_session_index";
  const SETTINGS_KEY = "aicap_settings";
  const ACTIVE_SESSION_KEY = "aicap_active_sessions";
  const MAX_PROMPT_TURNS = 50;

  function generateSessionId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `sess_${ts}_${rand}`;
  }

  function toStorageKey(sessionId) {
    return STORAGE_KEY_PREFIX + sessionId;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sanitizeThreadKey(platform, url, threadKey) {
    if (threadKey) return threadKey;
    try {
      const parsed = new URL(url);
      const search = parsed.search || "";
      return `${platform}:${parsed.origin}${parsed.pathname}${search}`;
    } catch (e) {
      return `${platform}:${url}`;
    }
  }

  function makeEvent(type, message, details, level) {
    return {
      timestamp: new Date().toISOString(),
      type: type,
      level: level || "info",
      message: message,
      details: details || null,
    };
  }

  async function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        const defaults = {
          captureEnabled: true,
          captureRawInput: true,
          maxSessionsRetained: 100,
          maxPromptTurns: MAX_PROMPT_TURNS,
        };
        resolve(Object.assign({}, defaults, result[SETTINGS_KEY] || {}));
      });
    });
  }

  async function saveSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: settings }, resolve);
    });
  }

  async function getSessionIndex() {
    return new Promise((resolve) => {
      chrome.storage.local.get(INDEX_KEY, (result) => {
        resolve(result[INDEX_KEY] || []);
      });
    });
  }

  async function saveSessionIndex(index) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [INDEX_KEY]: index }, resolve);
    });
  }

  async function getActiveSessionMap() {
    return new Promise((resolve) => {
      chrome.storage.local.get(ACTIVE_SESSION_KEY, (result) => {
        resolve(result[ACTIVE_SESSION_KEY] || {});
      });
    });
  }

  async function saveActiveSessionMap(map) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: map }, resolve);
    });
  }

  function updateIndexRecord(index, session) {
    const nextRecord = {
      sessionId: session.sessionId,
      platform: session.platform,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      entryCount: session.entryCount,
      promptCount: session.promptCount,
      assistantCount: session.assistantCount,
      status: session.status,
      integrityStatus: session.integrityStatus,
      threadKey: session.threadKey,
      url: session.url,
    };

    const idx = index.findIndex((item) => item.sessionId === session.sessionId);
    if (idx === -1) {
      index.push(nextRecord);
    } else {
      index[idx] = nextRecord;
    }
  }

  async function persistSession(session) {
    const key = toStorageKey(session.sessionId);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [key]: session }, resolve);
    });
    const index = await getSessionIndex();
    updateIndexRecord(index, session);
    await saveSessionIndex(index);
    return session;
  }

  async function trimStoredSessions(maxSessionsRetained) {
    const index = await getSessionIndex();
    if (index.length <= maxSessionsRetained) return;
    const sorted = [...index].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    const keep = sorted.slice(0, maxSessionsRetained);
    const remove = sorted.slice(maxSessionsRetained);
    for (const session of remove) {
      await new Promise((resolve) => {
        chrome.storage.local.remove(toStorageKey(session.sessionId), resolve);
      });
    }
    await saveSessionIndex(keep);
  }

  async function createSession(platform, url, threadKey) {
    const sessionId = generateSessionId();
    const normalizedThreadKey = sanitizeThreadKey(platform, url, threadKey);
    const settings = await getSettings();
    const sessionMaxTurns = (settings.maxPromptTurns && settings.maxPromptTurns > 0)
      ? settings.maxPromptTurns
      : MAX_PROMPT_TURNS;
    const session = {
      sessionId: sessionId,
      sessionVersion: "12.0.0",
      maxPromptTurns: sessionMaxTurns,
      platform: platform,
      url: url,
      threadKey: normalizedThreadKey,
      startedAt: new Date().toISOString(),
      endedAt: null,
      recoveredAt: null,
      recoveredFromReloadCount: 0,
      fingerprint: null,
      entries: [],
      events: [],
      entryCount: 0,
      promptCount: 0,
      assistantCount: 0,
      // FIX #2: domMessageCount tracks the count of DOM-visible messages processed
      // by content.js. Separate from entryCount (which counts chain entries including
      // error stubs). Used by content.js to restore knownMessageCount on reload.
      domMessageCount: 0,
      lastHash: "GENESIS",
      integrityStatus: "clean",
      status: "active",
      lockReason: null,
      lockedAt: null,
      duplicateCount: 0,
      errorCount: 0,
    };

    session.fingerprint = await CryptoChain.computeSessionFingerprint(session);
    session.events.push(
      makeEvent(
        "session_started",
        "Started forensic capture session.",
        { platform: platform, url: url, threadKey: normalizedThreadKey },
        "info"
      )
    );

    await persistSession(session);

    const active = await getActiveSessionMap();
    active[normalizedThreadKey] = sessionId;
    await saveActiveSessionMap(active);

    await trimStoredSessions(settings.maxSessionsRetained || 100);

    return session;
  }

  async function getSession(sessionId) {
    const key = toStorageKey(sessionId);
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        resolve(result[key] || null);
      });
    });
  }

  async function getOrCreateActiveSession(platform, url, threadKey) {
    const normalizedThreadKey = sanitizeThreadKey(platform, url, threadKey);
    const active = await getActiveSessionMap();
    const existingId = active[normalizedThreadKey];

    if (existingId) {
      const existing = await getSession(existingId);
      if (existing && !existing.endedAt && existing.status !== "finalized") {
        existing.status = existing.lockedAt ? "locked" : "active";
        existing.url = url;

        // FIX #4: Preserve first recovery timestamp. Was overwritten on every
        // reload, losing the original event. Now set only if not already recorded.
        existing.recoveredAt = existing.recoveredAt || new Date().toISOString();
        existing.recoveredFromReloadCount += 1;

        // FIX #2: Backward compatibility — sessions stored before domMessageCount
        // was introduced will not have this field; default to 0.
        if (typeof existing.domMessageCount !== "number") {
          existing.domMessageCount = 0;
        }

        existing.events.push(
          makeEvent(
            "session_recovered",
            "Recovered active session after reload or navigation.",
            {
              threadKey: normalizedThreadKey,
              recoveredFromReloadCount: existing.recoveredFromReloadCount,
            },
            "info"
          )
        );
        await persistSession(existing);
        return { session: existing, resumed: true };
      }
    }

    return {
      session: await createSession(platform, url, normalizedThreadKey),
      resumed: false,
    };
  }

  // FIX #2: Lightweight write of the DOM-side message count. Called by content.js
  // after every processed message. Does not rebuild the session index (domMessageCount
  // is not an indexed field) so it avoids the full persistSession overhead on each turn.
  async function updateDomMessageCount(sessionId, count) {
    const session = await getSession(sessionId);
    if (!session) return null;
    session.domMessageCount = count;
    const key = toStorageKey(sessionId);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [key]: session }, resolve);
    });
    return session;
  }

  async function logSessionEvent(sessionId, type, message, details) {
    const session = await getSession(sessionId);
    if (!session) return null;
    session.events.push(makeEvent(type, message, details, "info"));
    await persistSession(session);
    return session;
  }

  async function logSessionError(sessionId, message, details) {
    const session = await getSession(sessionId);
    if (!session) return null;
    session.errorCount += 1;
    session.events.push(makeEvent("error", message, details, "error"));
    await persistSession(session);
    return session;
  }

  async function lockSession(sessionId, reason, details) {
    const session = await getSession(sessionId);
    if (!session) return null;
    if (!session.lockedAt) {
      session.lockedAt = new Date().toISOString();
      session.lockReason = reason || "locked";
      session.status = "locked";
      session.events.push(
        makeEvent(
          "session_locked",
          "Locked session from further prompt capture.",
          details || { reason: reason || "locked" },
          "warning"
        )
      );
    }
    await persistSession(session);
    return session;
  }

  async function appendEntry(sessionId, role, renderedText, rawInput, options) {
    const session = await getSession(sessionId);
    if (!session) return null;

    const opts = options || {};

    const sessionMaxTurns = (session.maxPromptTurns && session.maxPromptTurns > 0)
      ? session.maxPromptTurns
      : MAX_PROMPT_TURNS;

    if (role === "user" && session.promptCount >= sessionMaxTurns) {
      const locked = await lockSession(sessionId, "max_prompt_turns_reached", {
        maxPromptTurns: sessionMaxTurns,
      });
      return { rejected: true, reason: "session_locked", session: locked };
    }

    const previousHash = session.lastHash || "GENESIS";

    // FIX #7: Old formula for assistant turn was Math.max(promptCount, assistantCount+1),
    // which produced the same turn number for a user and assistant in the same exchange
    // (e.g., both user and assistant in exchange 2 received turn=2). This made turn
    // non-unique across roles. Turn is now independently sequential per role:
    //   user turn N  = the Nth user message
    //   assistant turn N = the Nth assistant message
    // chainPosition remains the globally unique sequential identifier.
    const turn = role === "user"
      ? session.promptCount + 1
      : session.assistantCount + 1;

    const entry = {
      turn: turn,
      chainPosition: session.entryCount + 1,
      timestamp: new Date().toISOString(),
      status: opts.status || "captured",
      role: role,
      renderedText: renderedText,
      errorDetail: opts.errorDetail || null,
      rawInput: rawInput || null,
      previousHash: previousHash,
      hash: null,
    };

    entry.hash = await CryptoChain.computeEntryHash(entry, previousHash);

    session.entries.push(entry);
    session.entryCount = entry.chainPosition;
    session.lastHash = entry.hash;

    if (role === "user") session.promptCount += 1;
    if (role === "assistant") session.assistantCount += 1;

    if (
      role === "assistant" &&
      session.assistantCount >= sessionMaxTurns &&
      !session.lockedAt
    ) {
      session.lockedAt = new Date().toISOString();
      session.lockReason = "max_prompt_turns_reached";
      session.status = "locked";
      session.events.push(
        makeEvent(
          "session_locked",
          `Reached the ${sessionMaxTurns}-turn session limit.`,
          { maxPromptTurns: sessionMaxTurns },
          "warning"
        )
      );
    } else if (!session.lockedAt) {
      session.status = "active";
    }

    await persistSession(session);
    return { entry: entry, session: session, rejected: false };
  }

  async function recordDuplicate(sessionId, details) {
    const session = await getSession(sessionId);
    if (!session) return null;
    session.duplicateCount += 1;
    session.events.push(
      makeEvent(
        "duplicate_skipped",
        "Skipped duplicate message capture.",
        details || null,
        "warning"
      )
    );
    await persistSession(session);
    return session;
  }

  async function finalizeSession(sessionId, reason) {
    const session = await getSession(sessionId);
    if (!session) return null;

    session.endedAt = session.endedAt || new Date().toISOString();
    session.status = session.lockedAt ? "locked" : "finalized";

    const verification = await CryptoChain.verifyChain(session.entries);
    session.integrityStatus = verification.valid ? "verified" : "tampered";
    session.events.push(
      makeEvent(
        "session_finalized",
        "Finalized forensic capture session.",
        { reason: reason || "unknown", integrityStatus: session.integrityStatus },
        "info"
      )
    );

    await persistSession(session);

    const active = await getActiveSessionMap();
    if (active[session.threadKey] === session.sessionId) {
      delete active[session.threadKey];
      await saveActiveSessionMap(active);
    }

    return session;
  }

  function buildStudyManifest(session, verification) {
    return {
      _format: "ai-chat-capture-study-manifest-v1",
      _exportedAt: new Date().toISOString(),
      sessionId: session.sessionId,
      platform: session.platform,
      url: session.url,
      threadKey: session.threadKey,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      sessionStatus: session.status,
      integrityStatus: verification.valid ? "verified" : "tampered",
      promptCount: session.promptCount,
      assistantCount: session.assistantCount,
      entryCount: session.entryCount,
      duplicateCount: session.duplicateCount,
      errorCount: session.errorCount,
      // FIX #10: Field present in forensicLog but previously absent from the
      // study manifest, creating an inconsistency in the academic record.
      recoveredFromReloadCount: session.recoveredFromReloadCount,
      maxPromptTurns: session.maxPromptTurns || MAX_PROMPT_TURNS,
      sessionLocked: !!session.lockedAt,
      lockReason: session.lockReason,
      verificationValid: verification.valid,
      files: {
        forensicLog: `ai-capture-${session.platform}-${session.sessionId}.json`,
        studyManifest: `ai-capture-${session.platform}-${session.sessionId}-manifest.json`,
      },
    };
  }

  async function exportSession(sessionId) {
    const session = await getSession(sessionId);
    if (!session) return null;

    const verification = await CryptoChain.verifyChain(session.entries);
    const manifest = buildStudyManifest(session, verification);

    return {
      forensicLog: {
        _format: "ai-chat-capture-v12",
        _exportedAt: new Date().toISOString(),
        session: {
          sessionId: session.sessionId,
          sessionVersion: session.sessionVersion,
          platform: session.platform,
          url: session.url,
          threadKey: session.threadKey,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          recoveredAt: session.recoveredAt,
          recoveredFromReloadCount: session.recoveredFromReloadCount,
          fingerprint: session.fingerprint,
          integrityStatus: verification.valid ? "verified" : "tampered",
          status: session.status,
          lockReason: session.lockReason,
          lockedAt: session.lockedAt,
          maxPromptTurns: session.maxPromptTurns || MAX_PROMPT_TURNS,
          promptCount: session.promptCount,
          assistantCount: session.assistantCount,
          entryCount: session.entryCount,
          duplicateCount: session.duplicateCount,
          errorCount: session.errorCount,
        },
        entries: session.entries,
        events: session.events,
        verification: verification,
      },
      studyManifest: manifest,
    };
  }

  async function exportStudyManifest(sessionId) {
    const exported = await exportSession(sessionId);
    return exported ? exported.studyManifest : null;
  }

  async function deleteSession(sessionId) {
    const session = await getSession(sessionId);
    await new Promise((resolve) => {
      chrome.storage.local.remove(toStorageKey(sessionId), resolve);
    });
    const index = await getSessionIndex();
    const filtered = index.filter((s) => s.sessionId !== sessionId);
    await saveSessionIndex(filtered);
    if (session) {
      const active = await getActiveSessionMap();
      if (active[session.threadKey] === sessionId) {
        delete active[session.threadKey];
        await saveActiveSessionMap(active);
      }
    }
  }

  async function getAllSessions() {
    return await getSessionIndex();
  }

  return {
    MAX_PROMPT_TURNS,
    generateSessionId,
    getSettings,
    saveSettings,
    createSession,
    getSession,
    getOrCreateActiveSession,
    appendEntry,
    updateDomMessageCount,  // FIX #2: exposed for content.js
    logSessionEvent,
    logSessionError,
    recordDuplicate,
    lockSession,
    finalizeSession,
    exportSession,
    exportStudyManifest,
    deleteSession,
    getAllSessions,
  };
})();
