/*!
 * lib/crypto.js
 *
 * CryptoChain — tamper-evident hashing utilities for browser-extension logs.
 *
 * Goals:
 * - Runs in extension pages (popup/options), content scripts (isolated world),
 *   and worker contexts (extension service worker / Web Worker).
 * - Uses Web Crypto (crypto.subtle) when available; fails with clear errors when not.
 * - Produces deterministic canonical JSON for hashing with stable key order.
 * - Exposes exactly one global: globalThis.CryptoChain.
 *
 * No top-level await; safe for classic <script> and module contexts.
 */

(function initCryptoChain(root) {
  "use strict";

  /** @type {string} */
  const VERSION = "crypto-chain/2026-04-15";

  /**
   * Internal configuration; modify via CryptoChain.configure().
   * @type {{
   *   debug: boolean,
   *   normalize: "strict" | "legacy",
   *   verifyFallback: boolean
   * }}
   */
  const CONFIG = {
    debug: false,
    // "strict": normalizes common type inconsistencies; makes canonical shape explicit.
    // "legacy": closely matches the original canonicalization behavior (for back-compat).
    normalize: "strict",
    // When true, verifyChain() will attempt legacy canonicalization if strict does not match.
    verifyFallback: true,
  };

  /**
   * @param {...any} args
   */
  function debugLog(...args) {
    if (!CONFIG.debug) return;
    try {
      // eslint-disable-next-line no-console
      (root.console && root.console.debug ? root.console.debug : root.console.log).call(
        root.console,
        "[CryptoChain]",
        ...args
      );
    } catch (_) {
      // ignore logging failures
    }
  }

  /**
   * Create a rich error without leaking globals.
   * @param {string} code
   * @param {string} message
   * @param {any=} cause
   * @returns {Error & {code: string, cause?: any}}
   */
  function makeCryptoError(code, message, cause) {
    const err = new Error(message);
    err.name = "CryptoChainError";
    // @ts-ignore
    err.code = code;
    if (cause !== undefined) {
      // @ts-ignore
      err.cause = cause;
    }
    return /** @type {any} */ (err);
  }

  /**
   * @param {any} value
   * @returns {boolean}
   */
  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  /**
   * @param {any} value
   * @returns {boolean}
   */
  function isArrayBuffer(value) {
    return typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer;
  }

  /**
   * @param {any} value
   * @returns {boolean}
   */
  function isArrayBufferView(value) {
    return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value);
  }

  /**
   * Convert input into a Uint8Array suitable for crypto.subtle.digest().
   *
   * @param {string | ArrayBuffer | ArrayBufferView} input
   * @returns {Uint8Array}
   */
  function toUtf8Bytes(input) {
    if (typeof input === "string") {
      if (typeof TextEncoder === "undefined") {
        throw makeCryptoError(
          "TEXT_ENCODER_UNAVAILABLE",
          "TextEncoder is not available in this context; cannot UTF-8 encode input."
        );
      }
      return new TextEncoder().encode(input);
    }

    if (isArrayBuffer(input)) {
      return new Uint8Array(input);
    }

    if (isArrayBufferView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    throw makeCryptoError(
      "INVALID_ARGUMENT",
      "sha256() expects a string, ArrayBuffer, or ArrayBufferView as input.",
      { receivedType: typeof input }
    );
  }

  /**
   * @returns {SubtleCrypto}
   */
  function getSubtleCryptoOrThrow() {
    const cryptoObj = /** @type {any} */ (root.crypto);
    const subtle = cryptoObj && cryptoObj.subtle;

    if (!subtle || typeof subtle.digest !== "function") {
      const diagnostics = {
        hasCrypto: !!cryptoObj,
        hasSubtle: !!(cryptoObj && cryptoObj.subtle),
        isSecureContext: typeof root.isSecureContext === "boolean" ? root.isSecureContext : undefined,
        location: (() => {
          try {
            return root.location ? String(root.location) : undefined;
          } catch (_) {
            return undefined;
          }
        })(),
      };

      throw makeCryptoError(
        "WEBCRYPTO_UNAVAILABLE",
        "Web Crypto API is unavailable (crypto.subtle.digest not found). " +
          "This commonly occurs in non-secure contexts or heavily restricted environments.",
        diagnostics
      );
    }

    return /** @type {SubtleCrypto} */ (subtle);
  }

  /**
   * Convert an ArrayBuffer to lowercase hex.
   *
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  function bufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  /**
   * Deterministically stringify a canonical object for hashing.
   *
   * Uses JSON.stringify with a "replacer array" listing allowed keys in the desired order.
   * This enforces key inclusion/order and drops unexpected properties deterministically.
   *
   * @param {any} value
   * @param {string[]} keyOrder
   * @returns {string}
   */
  function canonicalStringify(value, keyOrder) {
    try {
      return JSON.stringify(value, keyOrder);
    } catch (err) {
      throw makeCryptoError(
        "STRINGIFY_FAILED",
        "Failed to JSON.stringify canonical object (circular reference or unsupported type like BigInt).",
        { cause: String(err) }
      );
    }
  }

  /** @type {string[]} */
  const ENTRY_KEY_ORDER = [
    "turn",
    "chainPosition",
    "timestamp",
    "status",
    "role",
    "renderedText",
    "errorDetail",
    "rawInput",
    "previousHash",
    // rawInput sub-keys (applied to nested objects too):
    "text",
    "capturedAt",
    "source",
    "submittedAt",
  ];

  /** @type {string[]} */
  const SESSION_KEY_ORDER = ["sessionId", "platform", "startedAt", "url", "threadKey"];

  /**
   * Normalize integers that are expected to be small counters (turn, chainPosition).
   *
   * @param {any} value
   * @param {string} field
   * @param {"strict"|"legacy"} mode
   * @returns {number | string | null | undefined}
   */
  function normalizeCounter(value, field, mode) {
    if (value === undefined) return mode === "strict" ? null : undefined;
    if (value === null) return null;

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw makeCryptoError("INVALID_ARGUMENT", `${field} must be a finite number.`, {
          field,
          received: value,
        });
      }
      return value;
    }

    if (typeof value === "string") {
      if (mode === "strict") {
        const s = value.trim();
        if (s === "") return null;
        if (/^-?\d+$/.test(s)) {
          const n = Number(s);
          return Number.isFinite(n) ? n : s;
        }
        return s;
      }
      // legacy: preserve as-is (including whitespace)
      return value;
    }

    if (mode === "strict") {
      debugLog("normalizeCounter: coercing unexpected type for", field, "=>", typeof value);
      return String(value);
    }

    return String(value);
  }

  /**
   * Normalize a timestamp-like value.
   *
   * Strict mode:
   * - string -> string (trim empty -> null)
   * - Date/number -> ISO string
   *
   * Legacy mode:
   * - string -> string (as-is)
   * - Date/number -> ISO string (best-effort; legacy code typically stored strings already)
   * - undefined stays undefined
   *
   * @param {any} value
   * @param {string} field
   * @param {"strict"|"legacy"} mode
   * @returns {string | null | undefined}
   */
  function normalizeTimestamp(value, field, mode) {
    if (value === undefined) return mode === "strict" ? null : undefined;
    if (value === null) return null;

    if (typeof value === "string") {
      if (mode === "strict") {
        const s = value.trim();
        return s === "" ? null : s;
      }
      return value;
    }

    if (value instanceof Date) {
      const t = value.getTime();
      if (!Number.isFinite(t)) {
        throw makeCryptoError("INVALID_ARGUMENT", `${field} is an invalid Date.`, { field });
      }
      return value.toISOString();
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw makeCryptoError("INVALID_ARGUMENT", `${field} must be a finite number.`, {
          field,
          received: value,
        });
      }
      return new Date(value).toISOString();
    }

    if (mode === "strict") {
      debugLog("normalizeTimestamp: coercing unexpected type for", field, "=>", typeof value);
      return String(value);
    }

    return String(value);
  }

  /**
   * Normalize a string-like field.
   *
   * @param {any} value
   * @param {string} field
   * @param {"strict"|"legacy"} mode
   * @param {{ allowEmpty?: boolean, nullIfEmpty?: boolean }=} opts
   * @returns {string | null | undefined}
   */
  function normalizeString(value, field, mode, opts) {
    const options = opts || {};
    const allowEmpty = options.allowEmpty !== false;
    const nullIfEmpty = options.nullIfEmpty === true;

    if (value === undefined) return mode === "strict" ? null : undefined;
    if (value === null) return null;

    let s;
    if (typeof value === "string") {
      s = value;
    } else if (mode === "strict") {
      debugLog("normalizeString: coercing non-string", field, "=>", typeof value);
      s = String(value);
    } else {
      s = String(value);
    }

    if (!allowEmpty && s.length === 0) {
      throw makeCryptoError("INVALID_ARGUMENT", `${field} must be a non-empty string.`, { field });
    }

    if (nullIfEmpty && s.length === 0) return null;

    return s;
  }

  /**
   * Normalize errorDetail with legacy semantics:
   * - previous implementation used `entry.errorDetail || null`, meaning falsy values become null.
   *
   * @param {any} value
   * @param {"strict"|"legacy"} mode
   * @returns {string | null | undefined}
   */
  function normalizeErrorDetail(value, mode) {
    if (value === undefined) return mode === "strict" ? null : undefined;
    if (!value) return null; // legacy falsy => null
    return typeof value === "string" ? value : String(value);
  }

  /**
   * Normalize rawInput to the canonical shape.
   *
   * Strict mode:
   * - Ensures keys exist (null when missing) to keep canonical structure stable.
   *
   * Legacy mode:
   * - Mirrors original behavior:
   *   - rawInput sub-keys text/capturedAt/source: copied as-is (undefined may be omitted)
   *   - submittedAt: null when undefined (explicitly present)
   *
   * @param {any} rawInput
   * @param {"strict"|"legacy"} mode
   * @returns {{text?: any, capturedAt?: any, source?: any, submittedAt: any} | null}
   */
  function normalizeRawInput(rawInput, mode) {
    if (!rawInput) return null;

    if (!isObject(rawInput)) {
      if (mode === "strict") {
        throw makeCryptoError("INVALID_ARGUMENT", "entry.rawInput must be an object when provided.", {
          receivedType: typeof rawInput,
        });
      }
      return null;
    }

    if (mode === "legacy") {
      return {
        text: rawInput.text,
        capturedAt: rawInput.capturedAt,
        source: rawInput.source,
        submittedAt: rawInput.submittedAt !== undefined ? rawInput.submittedAt : null,
      };
    }

    return {
      text: normalizeString(rawInput.text, "rawInput.text", mode, { allowEmpty: true }),
      capturedAt: normalizeTimestamp(rawInput.capturedAt, "rawInput.capturedAt", mode),
      source: normalizeString(rawInput.source, "rawInput.source", mode, { allowEmpty: true }),
      submittedAt:
        rawInput.submittedAt !== undefined && rawInput.submittedAt !== null
          ? normalizeTimestamp(rawInput.submittedAt, "rawInput.submittedAt", mode)
          : null,
    };
  }

  /**
   * Build the canonical entry object used for hashing.
   *
   * Key structure intentionally matches the prior implementation:
   * { turn, chainPosition, timestamp, status, role, renderedText, errorDetail, rawInput, previousHash }
   *
   * @param {any} entry
   * @param {any} previousHash
   * @param {"strict"|"legacy"} mode
   * @returns {object}
   */
  function buildCanonicalEntry(entry, previousHash, mode) {
    if (!isObject(entry)) {
      throw makeCryptoError(
        "INVALID_ARGUMENT",
        "computeEntryHash(entry, previousHash): entry must be an object.",
        { receivedType: typeof entry }
      );
    }

    // Strict mode keeps a stable chain anchor even if previousHash is missing/non-string.
    // Legacy mode preserves the passed value as-is to match older stored hashes.
    const prev =
      mode === "legacy"
        ? previousHash
        : typeof previousHash === "string" && previousHash.length > 0
          ? previousHash
          : "GENESIS";

    return {
      turn: normalizeCounter(entry.turn, "entry.turn", mode),
      chainPosition: normalizeCounter(entry.chainPosition, "entry.chainPosition", mode),
      timestamp: normalizeTimestamp(entry.timestamp, "entry.timestamp", mode),
      status: normalizeString(entry.status, "entry.status", mode, { allowEmpty: true }),
      role: normalizeString(entry.role, "entry.role", mode, { allowEmpty: true }),
      renderedText: normalizeString(entry.renderedText, "entry.renderedText", mode, { allowEmpty: true }),
      errorDetail: normalizeErrorDetail(entry.errorDetail, mode),
      rawInput: normalizeRawInput(entry.rawInput, mode),
      previousHash: prev,
    };
  }

  /**
   * Build the canonical session metadata object used for fingerprinting.
   *
   * Key structure intentionally matches the prior implementation:
   * { sessionId, platform, startedAt, url, threadKey }
   *
   * @param {any} sessionMeta
   * @param {"strict"|"legacy"} mode
   * @returns {object}
   */
  function buildCanonicalSessionMeta(sessionMeta, mode) {
    if (!isObject(sessionMeta)) {
      throw makeCryptoError(
        "INVALID_ARGUMENT",
        "computeSessionFingerprint(sessionMeta): sessionMeta must be an object.",
        { receivedType: typeof sessionMeta }
      );
    }

    return {
      sessionId: normalizeString(sessionMeta.sessionId, "sessionMeta.sessionId", mode, { allowEmpty: false }),
      platform: normalizeString(sessionMeta.platform, "sessionMeta.platform", mode, { allowEmpty: true }),
      startedAt: normalizeTimestamp(sessionMeta.startedAt, "sessionMeta.startedAt", mode),
      url: normalizeString(sessionMeta.url, "sessionMeta.url", mode, { allowEmpty: true }),
      threadKey: normalizeString(sessionMeta.threadKey, "sessionMeta.threadKey", mode, { allowEmpty: true }),
    };
  }

  /**
   * Compute SHA-256 hex digest of a message.
   *
   * Uses Web Crypto (SubtleCrypto.digest). Async; returns a Promise.
   *
   * @param {string | ArrayBuffer | ArrayBufferView} message - Usually a UTF-8 string.
   * @returns {Promise<string>} Lowercase hex digest.
   * @throws {CryptoChainError} when Web Crypto is unavailable or inputs are invalid.
   */
  async function sha256(message) {
    const subtle = getSubtleCryptoOrThrow();
    const data = toUtf8Bytes(message);
    debugLog("sha256: input bytes", data.byteLength);
    const hashBuffer = await subtle.digest("SHA-256", data);
    return bufferToHex(hashBuffer);
  }

  /**
   * Internal helper: compute entry hash with a given canonicalization mode.
   *
   * @param {any} entry
   * @param {any} previousHash
   * @param {"strict"|"legacy"} mode
   * @returns {Promise<string>}
   */
  async function computeEntryHashWithMode(entry, previousHash, mode) {
    const canonicalObj = buildCanonicalEntry(entry, previousHash, mode);
    const canonicalJson = canonicalStringify(canonicalObj, ENTRY_KEY_ORDER);
    debugLog("computeEntryHash:", mode, "canonical JSON", canonicalJson);
    return await sha256(canonicalJson);
  }

  /**
   * Compute the tamper-evident hash for a single log entry, chained to a previous hash.
   *
   * @param {object} entry - Log entry object.
   * @param {string} previousHash - The prior entry's hash (or "GENESIS" for the first).
   * @returns {Promise<string>} SHA-256 hex digest of the canonical entry payload.
   */
  async function computeEntryHash(entry, previousHash) {
    return await computeEntryHashWithMode(entry, previousHash, CONFIG.normalize);
  }

  /**
   * Internal helper: compute session fingerprint with a given canonicalization mode.
   *
   * @param {any} sessionMeta
   * @param {"strict"|"legacy"} mode
   * @returns {Promise<string>}
   */
  async function computeSessionFingerprintWithMode(sessionMeta, mode) {
    const canonicalObj = buildCanonicalSessionMeta(sessionMeta, mode);
    const canonicalJson = canonicalStringify(canonicalObj, SESSION_KEY_ORDER);
    debugLog("computeSessionFingerprint:", mode, "canonical JSON", canonicalJson);
    return await sha256(canonicalJson);
  }

  /**
   * Compute a SHA-256 fingerprint for session metadata.
   *
   * @param {object} sessionMeta
   * @returns {Promise<string>} SHA-256 hex digest of canonical session metadata.
   */
  async function computeSessionFingerprint(sessionMeta) {
    return await computeSessionFingerprintWithMode(sessionMeta, CONFIG.normalize);
  }

  /**
   * Verify a chain of entries.
   *
   * This function is designed to be robust in UI contexts (e.g., popup) and attempts
   * to avoid throwing. If an entry cannot be verified due to missing crypto or bad data,
   * it is marked invalid and annotated with an error message.
   *
   * @param {Array<any>} entries
   * @returns {Promise<{valid: boolean, entries: Array<{turn:any, chainPosition:any, valid:boolean, previousHashMatches:boolean, expectedHash:string|null, actualHash:any, error?:string, modeUsed?: "strict"|"legacy"}>}>}
   */
  async function verifyChain(entries) {
    const results = [];

    if (!Array.isArray(entries)) {
      return {
        valid: false,
        entries: [
          {
            turn: null,
            chainPosition: null,
            valid: false,
            previousHashMatches: false,
            expectedHash: null,
            actualHash: null,
            error: "verifyChain(entries) expected an array.",
          },
        ],
      };
    }

    let previousHash = "GENESIS";

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const actualHash = entry && isObject(entry) ? entry.hash : null;

      // Previous-hash linkage check uses legacy semantics: falsy => GENESIS.
      const entryPrevHash = entry && isObject(entry) ? entry.previousHash : undefined;
      const previousHashMatches = (entryPrevHash || "GENESIS") === previousHash;

      let expectedHash = null;
      let valid = false;
      let error;
      let modeUsed = /** @type {"strict"|"legacy"} */ (CONFIG.normalize);

      try {
        expectedHash = await computeEntryHashWithMode(entry, previousHash, CONFIG.normalize);
        valid = expectedHash === actualHash && previousHashMatches;

        if (!valid && CONFIG.verifyFallback && CONFIG.normalize === "strict") {
          const legacyExpected = await computeEntryHashWithMode(entry, previousHash, "legacy");
          if (legacyExpected === actualHash && previousHashMatches) {
            expectedHash = legacyExpected;
            valid = true;
            modeUsed = "legacy";
            debugLog("verifyChain: legacy canonicalization matched for entry", i);
          }
        }
      } catch (e) {
        const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
        error = msg;
        valid = false;
        expectedHash = null;
        debugLog("verifyChain: error verifying entry", i, e);
      }

      results.push({
        turn: entry && isObject(entry) ? entry.turn : null,
        chainPosition: entry && isObject(entry) ? entry.chainPosition : null,
        valid,
        previousHashMatches,
        expectedHash,
        actualHash,
        modeUsed,
        ...(error ? { error } : {}),
      });

      // Preserve original behavior: chain advances using the stored hash, even if invalid/missing.
      previousHash = actualHash;
    }

    return {
      valid: results.every((r) => r.valid),
      entries: results,
    };
  }

  /**
   * Configure CryptoChain behavior.
   *
   * @param {{debug?: boolean, normalize?: "strict" | "legacy", verifyFallback?: boolean}=} options
   * @returns {{debug: boolean, normalize: "strict" | "legacy", verifyFallback: boolean}}
   */
  function configure(options) {
    if (options && typeof options === "object") {
      if (typeof options.debug === "boolean") CONFIG.debug = options.debug;
      if (options.normalize === "strict" || options.normalize === "legacy") CONFIG.normalize = options.normalize;
      if (typeof options.verifyFallback === "boolean") CONFIG.verifyFallback = options.verifyFallback;
    }
    return { debug: CONFIG.debug, normalize: CONFIG.normalize, verifyFallback: CONFIG.verifyFallback };
  }

  /**
   * Enable or disable debug logging.
   * @param {boolean} enabled
   */
  function setDebug(enabled) {
    CONFIG.debug = !!enabled;
  }

  /**
   * @returns {boolean}
   */
  function getDebug() {
    return !!CONFIG.debug;
  }

  /**
   * Public API. The four core methods preserve the original exported functionality.
   * @type {{
   *   sha256: typeof sha256,
   *   computeEntryHash: typeof computeEntryHash,
   *   computeSessionFingerprint: typeof computeSessionFingerprint,
   *   verifyChain: typeof verifyChain,
   *   configure: typeof configure,
   *   setDebug: typeof setDebug,
   *   getDebug: typeof getDebug,
   *   _version: string
   * }}
   */
  const API = {
    sha256,
    computeEntryHash,
    computeSessionFingerprint,
    verifyChain,
    configure,
    setDebug,
    getDebug,
    _version: VERSION,
  };

  // Export to the global object. Works in window, content script isolated-world,
  // and worker/service-worker contexts (module or classic).
  try {
    Object.defineProperty(root, "CryptoChain", {
      value: API,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (_) {
    // eslint-disable-next-line no-param-reassign
    root.CryptoChain = API;
  }

  /*
   * ------------------------------------------------------------
   * Test harness snippets (copy/paste into Popup DevTools console)
   * ------------------------------------------------------------
   *
   * 1) Sanity checks:
   *    typeof CryptoChain
   *    typeof globalThis.crypto
   *    typeof globalThis.crypto?.subtle
   *    CryptoChain._version
   *
   * 2) Basic hashing:
   *    (async () => {
   *      console.log(await CryptoChain.sha256("hello"));
   *    })();
   *
   * 3) Compute an entry hash:
   *    (async () => {
   *      const entry = {
   *        turn: 1,
   *        chainPosition: 1,
   *        timestamp: new Date().toISOString(),
   *        status: "captured",
   *        role: "user",
   *        renderedText: "Hi",
   *        errorDetail: null,
   *        rawInput: null,
   *      };
   *      const h = await CryptoChain.computeEntryHash(entry, "GENESIS");
   *      console.log("entry hash:", h);
   *    })();
   *
   * 4) Verify a chain with an intentional tamper:
   *    (async () => {
   *      const e1 = {
   *        turn: 1,
   *        chainPosition: 1,
   *        timestamp: "2026-04-15T00:00:00.000Z",
   *        status: "captured",
   *        role: "user",
   *        renderedText: "hello",
   *        errorDetail: null,
   *        rawInput: null,
   *        previousHash: "GENESIS",
   *      };
   *      e1.hash = await CryptoChain.computeEntryHash(e1, "GENESIS");
   *
   *      const e2 = {
   *        turn: 2,
   *        chainPosition: 2,
   *        timestamp: "2026-04-15T00:00:01.000Z",
   *        status: "captured",
   *        role: "assistant",
   *        renderedText: "world",
   *        errorDetail: null,
   *        rawInput: null,
   *        previousHash: e1.hash,
   *      };
   *      e2.hash = await CryptoChain.computeEntryHash(e2, e1.hash);
   *
   *      // Tamper e2:
   *      e2.renderedText = "WORLD!";
   *
   *      const report = await CryptoChain.verifyChain([e1, e2]);
   *      console.log(report);
   *    })();
   *
   * 5) Debug mode to see canonical JSON:
   *    CryptoChain.setDebug(true);
   *    // Optionally: CryptoChain.configure({ normalize: "legacy" });
   */
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this);
