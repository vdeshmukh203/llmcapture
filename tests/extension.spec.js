const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { extname } = path;

// ── Paths ──────────────────────────────────────────────────────────────────────
// EXTENSION_PATH = worktree root (contains manifest.json)
// SESSION_LOGS   = <project-root>/session_logs — same destination as
//                  chrome.downloads saves to (Downloads/llmcapture/session_logs)
const EXTENSION_PATH = path.resolve(__dirname, '..');
const SESSION_LOGS   = path.resolve(EXTENSION_PATH, '..', '..', '..', 'session_logs');

// ── Mock session ───────────────────────────────────────────────────────────────
// Uses intentionally fake hashes — integrity tests use real computed hashes.
const MOCK_SESSION_ID = 'sess_test_playwright01';
const MOCK_SESSION = {
  sessionId: MOCK_SESSION_ID,
  sessionVersion: '12.0.0',
  platform: 'claude',
  url: 'https://claude.ai/chat/test-playwright',
  threadKey: 'claude:https://claude.ai/chat/test-playwright',
  startedAt: new Date().toISOString(),
  endedAt: null, recoveredAt: null, recoveredFromReloadCount: 0, fingerprint: null,
  entries: [
    { turn: 1, chainPosition: 1, role: 'user',
      renderedText: 'Hello, this is a Playwright test message.',
      timestamp: new Date().toISOString(), hash: 'aabbcc112233',
      previousHash: 'GENESIS', status: 'captured', errorDetail: null,
      capturedAt: new Date().toISOString(), source: null, submittedAt: null, rawInput: null },
    { turn: 2, chainPosition: 2, role: 'assistant',
      renderedText: 'Hello! I am the AI response for the Playwright test.',
      timestamp: new Date().toISOString(), hash: 'ddeeff445566',
      previousHash: 'aabbcc112233', status: 'captured', errorDetail: null,
      capturedAt: new Date().toISOString(), source: null, submittedAt: null, rawInput: null },
  ],
  events: [{ timestamp: new Date().toISOString(), type: 'session_started',
    level: 'info', message: 'Started forensic capture session.', details: null }],
  entryCount: 2, promptCount: 1, assistantCount: 1, domMessageCount: 2,
  lastHash: 'ddeeff445566', integrityStatus: 'clean', status: 'active',
  lockReason: null, lockedAt: null, duplicateCount: 0, errorCount: 0,
};
const MOCK_INDEX_RECORD = {
  sessionId: MOCK_SESSION_ID, platform: 'claude',
  startedAt: MOCK_SESSION.startedAt, endedAt: null,
  entryCount: 2, promptCount: 1, assistantCount: 1,
  status: 'active', integrityStatus: 'clean',
  threadKey: MOCK_SESSION.threadKey, url: MOCK_SESSION.url,
};

// ── Static file server ─────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
function startStaticServer(dir, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const fp = path.join(dir, req.url === '/' ? 'index.html' : req.url);
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'text/plain' });
        res.end(data);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Seed the mock session into extension storage via the service worker.
async function seedMockSession(serviceWorker) {
  await serviceWorker.evaluate(
    async ({ sessionKey, session, indexKey, record }) => {
      await new Promise(r => chrome.storage.local.set({ [sessionKey]: session }, r));
      const idx = await new Promise(r =>
        chrome.storage.local.get(indexKey, res => r(res[indexKey] ?? []))
      );
      const filtered = idx.filter(i => i.sessionId !== session.sessionId);
      await new Promise(r =>
        chrome.storage.local.set({ [indexKey]: [...filtered, record] }, r)
      );
    },
    { sessionKey: `aicap_session_${MOCK_SESSION_ID}`,
      session: MOCK_SESSION, indexKey: 'aicap_session_index',
      record: MOCK_INDEX_RECORD }
  );
}

// Call SessionStorage.exportSession() from inside the popup page context.
async function exportViaPopup(popup, sessionId) {
  return popup.evaluate(async (id) => {
    const r = await SessionStorage.exportSession(id);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }, sessionId);
}

// Open popup, wait for it to finish rendering sessions, return the page.
async function openPopup(browserContext, extensionId) {
  const popup = await browserContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}

// Poll chrome.storage.local via service worker until a claude session
// created after `since` (ms epoch) appears with entryCount > 0.
async function waitForCapturedEntry(serviceWorker, since, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await serviceWorker.evaluate(async (since) => {
      const idx = await new Promise(r =>
        chrome.storage.local.get('aicap_session_index', res => r(res['aicap_session_index'] ?? []))
      );
      return idx.some(s =>
        s.platform === 'claude' &&
        s.entryCount > 0 &&
        new Date(s.startedAt).getTime() > since
      );
    }, since);
    if (found) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ── Suite globals ──────────────────────────────────────────────────────────────
let browserContext, extensionId, serviceWorker;
let server8080, server8081;
let userDataDir; // unique per run — avoids stale state between runs

test.describe('AI Chat Capture Extension', () => {

  test.beforeAll(async () => {
    // Fresh isolated profile for every run
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-llmcapture-'));

    // Start static servers
    server8080 = await startStaticServer(EXTENSION_PATH, 8080);
    server8081 = await startStaticServer(EXTENSION_PATH, 8081);
    console.log('  Servers ready on :8080 and :8081');

    // Launch Chrome with extension
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: !!process.env.CI,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
      ],
    });

    serviceWorker = browserContext.serviceWorkers()[0]
      ?? await browserContext.waitForEvent('serviceworker', { timeout: 10000 });

    extensionId = serviceWorker.url().split('/')[2];
    console.log(`  Extension ID: ${extensionId}`);

    // Wipe storage so every run starts with a clean slate
    await serviceWorker.evaluate(async () =>
      new Promise(r => chrome.storage.local.clear(r))
    );

    fs.mkdirSync(SESSION_LOGS, { recursive: true });
  });

  test.afterAll(async () => {
    await browserContext?.close();
    await new Promise(r => server8080?.close(r));
    await new Promise(r => server8081?.close(r));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // ── 1. Extension health ──────────────────────────────────────────────────────

  test('1. service worker is active and has a valid extension ID', async () => {
    expect(extensionId).toMatch(/^[a-z]{32}$/);
    expect(serviceWorker.url()).toContain('background.js');
  });

  // ── 2. Popup UI ──────────────────────────────────────────────────────────────

  test('2. popup renders all key UI elements', async () => {
    const popup = await openPopup(browserContext, extensionId);
    await expect(popup.locator('#captureToggle')).toBeVisible();
    await expect(popup.locator('#exportAll')).toBeVisible();
    await expect(popup.locator('#sessionList')).toBeVisible();
    await expect(popup.locator('#initCapture')).toBeVisible();
    await popup.close();
  });

  // ── 3. Storage defaults ──────────────────────────────────────────────────────

  test('3. chrome.storage initializes with correct defaults', async () => {
    const settings = await serviceWorker.evaluate(async () =>
      new Promise(r =>
        chrome.storage.local.get('aicap_settings', res => r(res['aicap_settings'] ?? null))
      )
    );
    // null on a clean profile before popup init — both valid
    if (settings !== null) {
      expect(typeof settings.captureEnabled).toBe('boolean');
    }
  });

  // ── 4. Session storage → popup list ─────────────────────────────────────────

  test('4. seeding mock session shows it in popup list', async () => {
    await seedMockSession(serviceWorker);

    const popup = await openPopup(browserContext, extensionId);
    // Wait for real render rather than an arbitrary sleep
    await popup.waitForFunction(() =>
      !document.querySelector('#sessionList')?.textContent?.includes('No sessions yet')
    );
    await expect(popup.locator('#sessionList')).toContainText('claude');
    await popup.close();
  });

  // ── 5. Export: button is present and data is retrievable ─────────────────────

  test('5. Export button is clickable and exportSession() returns full payload', async () => {
    const popup = await openPopup(browserContext, extensionId);
    await seedMockSession(serviceWorker); // ensure it's in storage

    const exportBtn = popup.locator(`.export[data-id="${MOCK_SESSION_ID}"]`);
    await exportBtn.waitFor({ state: 'visible' });

    const data = await exportViaPopup(popup, MOCK_SESSION_ID);
    expect(data).not.toBeNull();
    expect(data.forensicLog).toBeDefined();
    expect(data.studyManifest).toBeDefined();

    // Write to SESSION_LOGS (mirrors what chrome.downloads.download does on disk)
    const p = data.forensicLog.session.platform;
    fs.writeFileSync(
      path.join(SESSION_LOGS, `ai-capture-${p}-${MOCK_SESSION_ID}.json`),
      JSON.stringify(data.forensicLog, null, 2)
    );
    fs.writeFileSync(
      path.join(SESSION_LOGS, `ai-capture-${p}-${MOCK_SESSION_ID}-manifest.json`),
      JSON.stringify(data.studyManifest, null, 2)
    );

    // Also exercise the button click path (fires chrome.downloads.download)
    await exportBtn.click();
    await popup.close();
  });

  // ── 6. Forensic log structure (independent of test 5) ────────────────────────

  test('6. forensic log has correct format, session fields, and entries', async () => {
    const popup = await openPopup(browserContext, extensionId);
    await seedMockSession(serviceWorker);

    const data = (await exportViaPopup(popup, MOCK_SESSION_ID)).forensicLog;
    await popup.close();

    expect(data._format).toBe('ai-chat-capture-v12');
    expect(data.session.platform).toBe('claude');
    expect(data.session.sessionId).toBe(MOCK_SESSION_ID);
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].role).toBe('user');
    expect(data.entries[1].role).toBe('assistant');
  });

  // ── 7. Study manifest structure (independent of test 5) ──────────────────────

  test('7. study manifest has correct format, platform, and file references', async () => {
    const popup = await openPopup(browserContext, extensionId);
    await seedMockSession(serviceWorker);

    const manifest = (await exportViaPopup(popup, MOCK_SESSION_ID)).studyManifest;
    await popup.close();

    expect(manifest._format).toBe('ai-chat-capture-study-manifest-v1');
    expect(manifest.platform).toBe('claude');
    expect(manifest.promptCount).toBe(1);
    expect(manifest.entryCount).toBe(2);
    expect(manifest.files.forensicLog).toContain(MOCK_SESSION_ID);
    expect(manifest.files.studyManifest).toContain(MOCK_SESSION_ID);
  });

  // ── 8. Static servers ────────────────────────────────────────────────────────

  test('8. landing page (localhost:8080) renders nav element', async () => {
    const page = await browserContext.newPage();
    await page.goto('http://localhost:8080/ai_chat_capture_landing_page.html');
    await expect(page.locator('nav')).toBeVisible();
    await page.close();
  });

  test('9. chain verifier (localhost:8081) is served with crypto logic', async () => {
    const res = await browserContext.request.get('http://localhost:8081/chain_verifier.tsx');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('sha256');
  });

  // ── 10. Real hash chain integrity ────────────────────────────────────────────

  test('10. real session has a valid and unbroken hash chain', async () => {
    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const threadKey = `chatgpt:https://chatgpt.com/c/integrity-test-${Date.now()}`;
      const session = await SessionStorage.createSession(
        'chatgpt', 'https://chatgpt.com/c/integrity-test', threadKey
      );
      await SessionStorage.appendEntry(session.sessionId, 'user',  'What is 2 + 2?', null, { status: 'captured' });
      await SessionStorage.appendEntry(session.sessionId, 'assistant', 'The answer is 4.', null, { status: 'captured' });
      const exported = await SessionStorage.exportSession(session.sessionId);
      await SessionStorage.deleteSession(session.sessionId);
      return exported ? JSON.parse(JSON.stringify(exported)) : null;
    });

    await popup.close();

    const { forensicLog } = result;
    expect(forensicLog.verification.valid).toBe(true);
    expect(forensicLog.entries).toHaveLength(2);
    for (const e of forensicLog.verification.entries) {
      expect(e.valid).toBe(true);
      expect(e.actualHash).toBe(e.expectedHash);
    }
    // Chain linkage
    expect(forensicLog.entries[1].previousHash).toBe(forensicLog.entries[0].hash);

    const fname = `ai-capture-${forensicLog.session.platform}-${forensicLog.session.sessionId}.json`;
    fs.writeFileSync(path.join(SESSION_LOGS, fname), JSON.stringify(forensicLog, null, 2));
    console.log(`  Chain verified ✓  written: ${fname}`);
  });

  // ── 11. exportAll ────────────────────────────────────────────────────────────

  test('11. exportAll exports data for every session in storage', async () => {
    // Seed a second session so there are ≥ 2 to export
    const popup = await openPopup(browserContext, extensionId);
    await seedMockSession(serviceWorker);

    const sessions = await popup.evaluate(async () => {
      const all = await SessionStorage.getAllSessions();
      const results = [];
      for (const s of all) {
        const exp = await SessionStorage.exportSession(s.sessionId);
        if (exp) results.push({
          id: s.sessionId,
          platform: exp.forensicLog.session.platform,
          entriesLen: exp.forensicLog.entries.length,
        });
      }
      return results;
    });

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.platform).toBeTruthy();
      expect(s.entriesLen).toBeGreaterThanOrEqual(0);
    }

    // Also verify the button itself is clickable without throwing
    await expect(popup.locator('#exportAll')).toBeEnabled();
    await popup.locator('#exportAll').click();

    await popup.close();
  });

  // ── 12. verifyAll modal ───────────────────────────────────────────────────────

  test('12. verifyAll opens integrity modal with per-session results', async () => {
    await seedMockSession(serviceWorker);
    const popup = await openPopup(browserContext, extensionId);
    await popup.waitForFunction(() =>
      !document.querySelector('#sessionList')?.textContent?.includes('No sessions yet')
    );

    await popup.locator('#verifyAll').click();

    // Modal must become visible
    await popup.locator('#verifyModal').waitFor({ state: 'visible' });
    const results = await popup.locator('#verifyResults').textContent();
    expect(results.trim().length).toBeGreaterThan(0);
    expect(results).not.toContain('No sessions');

    // Close modal
    await popup.locator('#closeModal').click();
    await expect(popup.locator('#verifyModal')).toBeHidden();

    await popup.close();
  });

  // ── 13. clearAll ─────────────────────────────────────────────────────────────

  test('13. clearAll removes all sessions after dialog confirmation', async () => {
    await seedMockSession(serviceWorker);
    const popup = await openPopup(browserContext, extensionId);
    await popup.waitForFunction(() =>
      !document.querySelector('#sessionList')?.textContent?.includes('No sessions yet')
    );

    // Auto-accept the window.confirm dialog
    popup.on('dialog', dialog => dialog.accept());
    await popup.locator('#clearAll').click();

    await popup.waitForFunction(() =>
      document.querySelector('#sessionList')?.textContent?.includes('No sessions yet')
    );
    await expect(popup.locator('#sessionList')).toContainText('No sessions yet');

    await popup.close();
  });

  // ── 14. Real Claude.ai e2e capture ───────────────────────────────────────────
  // Loads saved Claude.ai session cookies, navigates to a real conversation,
  // types and sends a message, waits for the assistant reply, and confirms the
  // content script persisted at least one entry in chrome.storage.
  //
  // Prerequisite: run `node tests/setup-auth.js` once to save your login state.
  // The auth file is git-ignored — re-run setup if your session expires.

  test('14. real Claude.ai capture: content script records a live conversation turn', async () => {
    test.setTimeout(90000); // real network + AI response can be slow

    const AUTH_FILE = path.join(__dirname, 'auth', 'claude-state.json');

    if (!fs.existsSync(AUTH_FILE)) {
      console.log('  ⚠ No auth state found.');
      console.log('  Run tests/start-chrome-debug.bat, log into claude.ai, then: node tests/setup-auth.js');
      test.skip();
      return;
    }

    // Restore Claude.ai cookies into the shared browser context (the one with
    // the extension loaded).  addCookies() works on persistent contexts too.
    const authState = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    await browserContext.addCookies(authState.cookies ?? []);

    const navStart = Date.now();
    const page = await browserContext.newPage();

    try {
      // Navigate to a fresh conversation
      await page.goto('https://claude.ai/new', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // If the cookies were expired we end up on a login page — skip cleanly
      const currentUrl = page.url();
      if (!currentUrl.includes('claude.ai') ||
          currentUrl.includes('/login') ||
          currentUrl.includes('accounts.')) {
        console.log(`  ⚠ Redirected to login (${currentUrl}) — re-run: node tests/setup-auth.js`);
        test.skip();
        return;
      }

      // Wait for the ProseMirror contenteditable input to become interactive
      const input = page.locator('[contenteditable="true"]').first();
      await input.waitFor({ state: 'visible', timeout: 20000 });

      // Poll storage: confirm the content script created a session for this tab
      const sessionReady = await (async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const idx = await serviceWorker.evaluate(async () =>
            new Promise(r =>
              chrome.storage.local.get('aicap_session_index', res =>
                r(res['aicap_session_index'] ?? [])
              )
            )
          );
          if (idx.some(s =>
            s.platform === 'claude' &&
            new Date(s.startedAt).getTime() > navStart
          )) return true;
          await new Promise(r => setTimeout(r, 400));
        }
        return false;
      })();

      if (!sessionReady) {
        console.log('  ⚠ Content script did not initialise a session — possible login wall');
        test.skip();
        return;
      }

      // Type a short message using pressSequentially so keyboard events fire
      // and ProseMirror's React state updates correctly.
      await input.click();
      await input.pressSequentially('Say only: ok', { delay: 20 });

      // Click the Send button (try common selectors; fall back to Enter key)
      const sendBtn = page.locator([
        'button[aria-label="Send Message"]',
        'button[aria-label="Send message"]',
        'button[data-testid="send-button"]',
        'button[type="submit"]',
      ].join(', ')).first();

      const sendVisible = await sendBtn.isVisible().catch(() => false);
      if (sendVisible) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      // Wait for the assistant reply node to appear — this gives the content
      // script's MutationObserver + debounce time to fire and persist entries.
      try {
        await page.locator('[data-testid="assistant-message"]').first()
          .waitFor({ state: 'visible', timeout: 45000 });
      } catch {
        // Reply didn't appear in 45 s — still check storage below
        console.log('  ⚠ Assistant reply node not detected in DOM, checking storage anyway…');
      }

      // Hard assertion: at least one entry must have been captured
      const captured = await waitForCapturedEntry(serviceWorker, navStart, 10000);
      expect(captured).toBe(true);

    } finally {
      await page.close();
    }
  });

  // ── 15. Tampered chain detection ─────────────────────────────────────────────
  // Modifies renderedText on a persisted entry (leaving the original hash intact),
  // then re-runs verifyChain and asserts it reports valid:false on that entry.

  test('15. CryptoChain detects a tampered entry hash', async () => {
    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const tKey = `chatgpt:https://chatgpt.com/c/tamper-${Date.now()}`;
      const session = await SessionStorage.createSession(
        'chatgpt', 'https://chatgpt.com/c/tamper', tKey
      );
      await SessionStorage.appendEntry(session.sessionId, 'user',      'Original message', null, {});
      await SessionStorage.appendEntry(session.sessionId, 'assistant', 'Original response', null, {});

      // Tamper: overwrite renderedText in entry[0] but keep the stored hash
      const stored = await SessionStorage.getSession(session.sessionId);
      stored.entries[0].renderedText = 'TAMPERED CONTENT';
      await new Promise(r =>
        chrome.storage.local.set({ [`aicap_session_${session.sessionId}`]: stored }, r)
      );

      const verification = await CryptoChain.verifyChain(stored.entries);
      await SessionStorage.deleteSession(session.sessionId);
      return JSON.parse(JSON.stringify(verification));
    });

    await popup.close();

    expect(result.valid).toBe(false);                                        // chain overall invalid
    expect(result.entries[0].valid).toBe(false);                             // tampered entry flagged
    expect(result.entries[0].actualHash).not.toBe(result.entries[0].expectedHash);
    // verifyChain propagates entry.hash (stored) as previousHash for the next entry,
    // so linkage stays consistent — the forgery is in the content, not the pointer.
    expect(result.entries[1].previousHashMatches).toBe(true);
    expect(result.entries[1].valid).toBe(true);                              // entry 1 itself untouched
  });

  // ── 16. Session resume after reload ──────────────────────────────────────────
  // getOrCreateActiveSession with the same threadKey must resume the session,
  // set resumed:true, and increment recoveredFromReloadCount.

  test('16. getOrCreateActiveSession resumes an existing session for the same threadKey', async () => {
    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const tKey = `claude:https://claude.ai/chat/resume-${Date.now()}`;
      const { session: s1, resumed: r1 } = await SessionStorage.getOrCreateActiveSession(
        'claude', 'https://claude.ai/chat/resume', tKey
      );
      const { session: s2, resumed: r2 } = await SessionStorage.getOrCreateActiveSession(
        'claude', 'https://claude.ai/chat/resume', tKey
      );
      const out = {
        firstResumed:  r1,
        secondResumed: r2,
        sameId:        s1.sessionId === s2.sessionId,
        reloadCount:   s2.recoveredFromReloadCount,
        recoveredAt:   s2.recoveredAt,
      };
      await SessionStorage.deleteSession(s1.sessionId);
      return out;
    });

    await popup.close();

    expect(result.firstResumed).toBe(false);        // created fresh
    expect(result.secondResumed).toBe(true);         // resumed same session
    expect(result.sameId).toBe(true);
    expect(result.reloadCount).toBeGreaterThanOrEqual(1);
    expect(result.recoveredAt).not.toBeNull();
  });

  // ── 17. 50-turn lock mechanism ───────────────────────────────────────────────
  // The 51st user turn must be rejected with reason "session_locked".

  test('17. appendEntry rejects the 51st user turn and locks the session', async () => {
    test.setTimeout(60000); // 50 appends takes a few seconds

    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const tKey = `chatgpt:https://chatgpt.com/c/lock-${Date.now()}`;
      const session = await SessionStorage.createSession(
        'chatgpt', 'https://chatgpt.com/c/lock', tKey
      );
      // Add exactly MAX_PROMPT_TURNS (50) user entries
      for (let i = 0; i < 50; i++) {
        await SessionStorage.appendEntry(session.sessionId, 'user', `Turn ${i + 1}`, null, {});
      }
      // 51st must be rejected
      const r = await SessionStorage.appendEntry(session.sessionId, 'user', 'Blocked', null, {});
      await SessionStorage.deleteSession(session.sessionId);
      return { rejected: r.rejected, reason: r.reason };
    });

    await popup.close();

    expect(result.rejected).toBe(true);
    expect(result.reason).toBe('session_locked');
  });

  // ── 18. Duplicate skipping ───────────────────────────────────────────────────
  // recordDuplicate must increment duplicateCount without adding a chain entry.

  test('18. recordDuplicate increments duplicateCount without adding a chain entry', async () => {
    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const tKey = `claude:https://claude.ai/chat/dup-${Date.now()}`;
      const session = await SessionStorage.createSession(
        'claude', 'https://claude.ai/chat/dup', tKey
      );
      await SessionStorage.appendEntry(session.sessionId, 'user', 'Hello world', null, {});
      // Record the duplicate
      const after = await SessionStorage.recordDuplicate(session.sessionId, {
        role: 'user', textPreview: 'Hello world',
      });
      const out = { duplicateCount: after.duplicateCount, entryCount: after.entryCount };
      await SessionStorage.deleteSession(session.sessionId);
      return out;
    });

    await popup.close();

    expect(result.duplicateCount).toBe(1);
    expect(result.entryCount).toBe(1); // no new chain entry added
  });

  // ── 19. Settings — captureToggle persists ────────────────────────────────────

  test('19. unchecking captureToggle persists captureEnabled:false to storage', async () => {
    const popup = await openPopup(browserContext, extensionId);

    // Ensure it starts checked
    await popup.locator('#captureToggle').waitFor({ state: 'visible' });
    if (!(await popup.locator('#captureToggle').isChecked())) {
      await popup.locator('#captureToggle').click();
      await popup.waitForTimeout(300);
    }

    // Uncheck
    await popup.locator('#captureToggle').click();

    // Wait for storage to reflect the change
    await popup.waitForFunction(() =>
      new Promise(r =>
        chrome.storage.local.get('aicap_settings', res =>
          r(res['aicap_settings']?.captureEnabled === false)
        )
      )
    );

    const settings = await serviceWorker.evaluate(async () =>
      new Promise(r => chrome.storage.local.get('aicap_settings', res => r(res['aicap_settings'])))
    );
    expect(settings.captureEnabled).toBe(false);

    // Restore
    await popup.locator('#captureToggle').click();
    await popup.close();
  });

  // ── 20. Settings — rawInputToggle persists ───────────────────────────────────

  test('20. unchecking rawInputToggle persists captureRawInput:false to storage', async () => {
    const popup = await openPopup(browserContext, extensionId);
    await popup.locator('#rawInputToggle').waitFor({ state: 'visible' });

    if (!(await popup.locator('#rawInputToggle').isChecked())) {
      await popup.locator('#rawInputToggle').click();
      await popup.waitForTimeout(300);
    }

    await popup.locator('#rawInputToggle').click();

    await popup.waitForFunction(() =>
      new Promise(r =>
        chrome.storage.local.get('aicap_settings', res =>
          r(res['aicap_settings']?.captureRawInput === false)
        )
      )
    );

    const settings = await serviceWorker.evaluate(async () =>
      new Promise(r => chrome.storage.local.get('aicap_settings', res => r(res['aicap_settings'])))
    );
    expect(settings.captureRawInput).toBe(false);

    await popup.locator('#rawInputToggle').click();
    await popup.close();
  });

  // ── 21. verifyAll flags tampered session ─────────────────────────────────────
  // The mock session has fake hashes — verifyAll must show "Tampering detected".

  test('21. verifyAll shows "Tampering detected" for a session with fake hashes', async () => {
    await seedMockSession(serviceWorker); // fake hashes → chain invalid
    const popup = await openPopup(browserContext, extensionId);
    await popup.waitForFunction(() =>
      !document.querySelector('#sessionList')?.textContent?.includes('No sessions yet')
    );

    await popup.locator('#verifyAll').click();
    await popup.locator('#verifyModal').waitFor({ state: 'visible' });

    await expect(popup.locator('#verifyResults')).toContainText('Tampering detected');

    await popup.locator('#closeModal').click();
    await popup.close();
  });

  // ── 22. Multi-platform sessions all appear in popup ──────────────────────────

  test('22. chatgpt, claude, and gemini sessions all appear in the session list', async () => {
    // Seed one session per platform
    for (const platform of ['chatgpt', 'claude', 'gemini']) {
      await serviceWorker.evaluate(
        async ({ platform }) => {
          const id = `sess_test_${platform}_mp`;
          const session = {
            sessionId: id, sessionVersion: '12.0.0', platform,
            url: `https://${platform}.com/chat/test`,
            threadKey: `${platform}:https://${platform}.com/chat/test`,
            startedAt: new Date().toISOString(), endedAt: null,
            recoveredAt: null, recoveredFromReloadCount: 0, fingerprint: null,
            entries: [], events: [], entryCount: 0, promptCount: 0,
            assistantCount: 0, domMessageCount: 0, lastHash: 'GENESIS',
            integrityStatus: 'clean', status: 'active',
            lockReason: null, lockedAt: null, duplicateCount: 0, errorCount: 0,
          };
          const record = {
            sessionId: id, platform, startedAt: session.startedAt, endedAt: null,
            entryCount: 0, promptCount: 0, assistantCount: 0,
            status: 'active', integrityStatus: 'clean',
            threadKey: session.threadKey, url: session.url,
          };
          await new Promise(r => chrome.storage.local.set({ [`aicap_session_${id}`]: session }, r));
          const idx = await new Promise(r =>
            chrome.storage.local.get('aicap_session_index', res => r(res['aicap_session_index'] ?? []))
          );
          await new Promise(r =>
            chrome.storage.local.set({
              'aicap_session_index': [...idx.filter(i => i.sessionId !== id), record],
            }, r)
          );
        },
        { platform }
      );
    }

    const popup = await openPopup(browserContext, extensionId);
    await popup.waitForFunction(() =>
      !document.querySelector('#sessionList')?.textContent?.includes('No sessions yet')
    );

    const listText = await popup.locator('#sessionList').textContent();
    expect(listText).toContain('chatgpt');
    expect(listText).toContain('claude');
    expect(listText).toContain('gemini');

    await popup.close();
  });

  // ── 23. rawInput field survives export ───────────────────────────────────────

  test('23. entry with rawInput is preserved verbatim in the forensic log', async () => {
    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const tKey = `claude:https://claude.ai/chat/raw-${Date.now()}`;
      const session = await SessionStorage.createSession(
        'claude', 'https://claude.ai/chat/raw', tKey
      );
      const rawInput = {
        text: 'raw keystrokes typed before submit',
        capturedAt: new Date().toISOString(),
        source: 'keydown',
        submittedAt: new Date().toISOString(),
      };
      await SessionStorage.appendEntry(
        session.sessionId, 'user', 'Rendered message', rawInput, {}
      );
      const exported = await SessionStorage.exportSession(session.sessionId);
      await SessionStorage.deleteSession(session.sessionId);
      return exported
        ? JSON.parse(JSON.stringify(exported.forensicLog.entries[0].rawInput))
        : null;
    });

    await popup.close();

    expect(result).not.toBeNull();
    expect(result.text).toBe('raw keystrokes typed before submit');
    expect(result.source).toBe('keydown');
    expect(result.capturedAt).toBeTruthy();
    expect(result.submittedAt).toBeTruthy();
  });

  // ── 24. Session finalization lifecycle ───────────────────────────────────────

  test('24. finalizeSession sets endedAt and status to "finalized"', async () => {
    const popup = await openPopup(browserContext, extensionId);

    const result = await popup.evaluate(async () => {
      const tKey = `chatgpt:https://chatgpt.com/c/final-${Date.now()}`;
      const session = await SessionStorage.createSession(
        'chatgpt', 'https://chatgpt.com/c/final', tKey
      );
      await SessionStorage.appendEntry(session.sessionId, 'user', 'A message', null, {});
      const finalized = await SessionStorage.finalizeSession(session.sessionId, 'user_navigated_away');
      const out = {
        status:   finalized.status,
        endedAt:  finalized.endedAt,
        reason:   finalized.events.find(e => e.type === 'session_finalized')?.details?.reason,
      };
      await SessionStorage.deleteSession(session.sessionId);
      return out;
    });

    await popup.close();

    expect(result.status).toBe('finalized');
    expect(result.endedAt).not.toBeNull();
    expect(result.reason).toBe('user_navigated_away');
  });
});
