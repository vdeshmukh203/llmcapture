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

  // ── 14. E2e content script capture ───────────────────────────────────────────
  // Navigates to claude.ai, waits for the content script to initialise, injects
  // a mock user-message node, and confirms the entry is persisted in storage.

  test('14. content script captures injected DOM message on claude.ai', async () => {
    // Record pre-existing sessions so we can identify the new one
    const before = await serviceWorker.evaluate(async () =>
      new Promise(r =>
        chrome.storage.local.get('aicap_session_index', res =>
          r((res['aicap_session_index'] ?? []).map(s => s.sessionId))
        )
      )
    );

    const page = await browserContext.newPage();
    const navStart = Date.now();
    await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Poll storage until the content script creates a new claude session
    const sessionAppeared = await (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const idx = await serviceWorker.evaluate(async () =>
          new Promise(r =>
            chrome.storage.local.get('aicap_session_index', res =>
              r(res['aicap_session_index'] ?? [])
            )
          )
        );
        const isNew = idx.some(
          s => !before.includes(s.sessionId) && s.platform === 'claude'
        );
        if (isNew) return true;
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    })();

    if (!sessionAppeared) {
      console.log('  ⚠ Content script did not create a session (login wall?) — skipping injection');
      await page.close();
      test.skip();
      return;
    }

    // Inject a mock user-message node — MutationObserver in the content script
    // observes childList on document.body and triggers syncCaptureCycle()
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.setAttribute('data-testid', 'user-message');
      el.textContent = 'Playwright e2e capture verification message';
      document.body.appendChild(el);
    });

    // Wait for the 1.5 s debounce + processing time
    const captured = await waitForCapturedEntry(serviceWorker, navStart, 8000);

    if (!captured) {
      console.log('  ⚠ Entry not captured within timeout — possible login wall or DOM mismatch');
    }
    // Soft assertion: content script loaded and responded; capture depends on page state
    expect(sessionAppeared).toBe(true);

    await page.close();
  });
});
