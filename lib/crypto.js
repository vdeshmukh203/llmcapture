var CryptoChain = (function () {
  "use strict";

  async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function computeEntryHash(entry, previousHash) {
    const canonical = JSON.stringify({
      turn: entry.turn,
      chainPosition: entry.chainPosition,
      timestamp: entry.timestamp,
      status: entry.status,
      role: entry.role,
      renderedText: entry.renderedText,
      errorDetail: entry.errorDetail || null,
      rawInput: entry.rawInput ? {
        text: entry.rawInput.text,
        capturedAt: entry.rawInput.capturedAt,
        source: entry.rawInput.source,
        submittedAt: entry.rawInput.submittedAt !== undefined ? entry.rawInput.submittedAt : null,
      } : null,
      previousHash: previousHash,
    });
    return await sha256(canonical);
  }

  async function computeSessionFingerprint(sessionMeta) {
    const canonical = JSON.stringify({
      sessionId: sessionMeta.sessionId,
      platform: sessionMeta.platform,
      startedAt: sessionMeta.startedAt,
      url: sessionMeta.url,
      threadKey: sessionMeta.threadKey,
    });
    return await sha256(canonical);
  }

  async function verifyChain(entries) {
    const results = [];
    let previousHash = "GENESIS";

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const expectedHash = await computeEntryHash(entry, previousHash);
      const previousHashMatches =
        (entry.previousHash || "GENESIS") === previousHash;
      const valid = expectedHash === entry.hash && previousHashMatches;

      results.push({
        turn: entry.turn,
        chainPosition: entry.chainPosition,
        valid: valid,
        previousHashMatches: previousHashMatches,
        expectedHash: expectedHash,
        actualHash: entry.hash,
      });

      previousHash = entry.hash;
    }

    return {
      valid: results.every((r) => r.valid),
      entries: results,
    };
  }

  return {
    sha256,
    computeEntryHash,
    computeSessionFingerprint,
    verifyChain,
  };
})();
