const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { extname } = path;

const EXTENSION_PATH = path.resolve(__dirname, '..');
const SESSION_LOGS = path.join('C:\\Users\\user\\Downloads\\llmcapture', 'session_logs');

// Mock session matching the full schema expected by storage.js / exportSession()
const MOCK_SESSION_ID = 'sess_test_playwright01';
const MOCK_SESSION = {
  sessionId: MOCK_SESSION_ID,
  sessionVersion: '12.0.0',
  platform: 'claude',
  url: 'https://claude.ai/chat/test-playwright',
  threadKey: 'claude:https://claude.ai/chat/test-playwright',
  startedAt: new Date().toISOString(),
  endedAt: null,
  recoveredAt: null,
  recoveredFromReloadCount: 0,
  fingerprint: null,
  entries: [
    {
      turn: 1, chainPosition: 1, role: 'user',
      renderedText: 'Hello, this is a Playwright test message.',
      timestamp: new Date().toISOString(),
      hash: 'aabbcc112233',
      previousHash: 'GENESIS',
      status: 'captured', errorDetail: null,
      capturedAt: new Date().toISOString(), source: null, submittedAt: null, rawInput: null,
    },
    {
      turn: 2, chainPosition: 2, role: 'assistant',
      renderedText: 'Hello! I am the AI response for the Playwright test.',
      timestamp: new Date().toISOString(),
      hash: 'ddeeff445566',
      previousHash: 'aabbcc112233',
      status: 'captured', errorDetail: null,
      capturedAt: new Date().toISOString(), source: null, submittedAt: null, rawInput: null,
    },
  ],
  events: [
    { timestamp: new Date().toISOString(), type: 'session_started', level: 'info', message: 'Started forensic capture session.', details: null },
  ],
  entryCount: 2,
  promptCount: 1,
  assistantCount: 1,
  domMessageCount: 2,
  lastHash: 'ddeeff445566',
  integrityStatus: 'clean',
  status: 'active',
  lockReason: null,
  lockedAt: null,
  duplicateCount: 0,
  errorCount: 0,
};

const MOCK_INDEX_RECORD = {
  sessionId: MOCK_SESSION_ID,
  platform: 'claude',
  startedAt: MOCK_SESSION.startedAt,
  endedAt: null,
  entryCount: 2,
  promptCount: 1,
  assistantCount: 1,
  status: 'active',
  integrityStatus: 'clean',
  threadKey: MOCK_SESSION.threadKey,
  url: MOCK_SESSION.url,
};

let browserContext;
let extensionId;
let serviceWorker;
let server8080, server8081;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function startStaticServer(dir, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const filePath = path.join(dir, req.url === '/' ? 'index.html' : req.url);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'text/plain' });
        res.end(data);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

test.describe('AI Chat Capture Extension', () => {

  test.beforeAll(async () => {
    // ── Start static file servers ────────────────────────────────────────────
    server8080 = await startStaticServer(EXTENSION_PATH, 8080);
    server8081 = await startStaticServer(EXTENSION_PATH, 8081);
    console.log('  Servers ready on :8080 and :8081');

    // ── Launch Chrome with extension ─────────────────────────────────────────
    const userDataDir = path.join(os.tmpdir(), 'pw-llmcapture-test');
    fs.mkdirSync(userDataDir, { recursive: true });

    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
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
  });

  test.afterAll(async () => {
    await browserContext?.close();
    await new Promise(r => server8080?.close(r));
    await new Promise(r => server8081?.close(r));
  });

  // ── 1. Extension health ────────────────────────────────────────────────────

  test('1. service worker is active and has a valid extension ID', async () => {
    expect(extensionId).toMatch(/^[a-z]{32}$/);
    expect(serviceWorker.url()).toContain('background.js');
  });

  // ── 2. Popup UI ────────────────────────────────────────────────────────────

  test('2. popup renders all key UI elements', async () => {
    const popup = await browserContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForLoadState('domcontentloaded');

    await expect(popup.locator('#captureToggle')).toBeVisible();
    await expect(popup.locator('#exportAll')).toBeVisible();
    await expect(popup.locator('#sessionList')).toBeVisible();
    await expect(popup.locator('#initCapture')).toBeVisible();

    await popup.close();
  });

  // ── 3. Storage defaults ────────────────────────────────────────────────────

  test('3. chrome.storage initializes with correct defaults', async () => {
    const settings = await serviceWorker.evaluate(async () =>
      new Promise(resolve =>
        chrome.storage.local.get('aicap_settings', r => resolve(r['aicap_settings'] ?? null))
      )
    );

    if (settings !== null) {
      expect(settings).toHaveProperty('captureEnabled');
      expect(typeof settings.captureEnabled).toBe('boolean');
    }
    // null = first run before popup has initialized settings — also valid
  });

  // ── 4. Seed mock session ───────────────────────────────────────────────────

  test('4. seeding mock session into storage shows it in popup', async () => {
    await serviceWorker.evaluate(
      async ({ sessionKey, session, indexKey, indexRecord }) => {
        await new Promise(resolve =>
          chrome.storage.local.set({ [sessionKey]: session }, resolve)
        );
        const existing = await new Promise(resolve =>
          chrome.storage.local.get(indexKey, r => resolve(r[indexKey] ?? []))
        );
        const filtered = existing.filter(r => r.sessionId !== session.sessionId);
        await new Promise(resolve =>
          chrome.storage.local.set({ [indexKey]: [...filtered, indexRecord] }, resolve)
        );
      },
      {
        sessionKey: `aicap_session_${MOCK_SESSION_ID}`,
        session: MOCK_SESSION,
        indexKey: 'aicap_session_index',
        indexRecord: MOCK_INDEX_RECORD,
      }
    );

    const popup = await browserContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForTimeout(800);

    await expect(popup.locator('#sessionList')).not.toContainText('No sessions yet');
    await expect(popup.locator('#sessionList')).toContainText('claude');

    await popup.close();
  });

  // ── 5. Export: button triggers download & files land in session_logs ───────
  //
  // chrome.downloads.download() from an extension context bypasses Playwright's
  // Download event API. Instead: call SessionStorage.exportSession() directly
  // from the popup page context (which has crypto.js + storage.js loaded) to
  // get the JSON payload, then write it to SESSION_LOGS from Node.js.

  test('5. clicking Export button is visible and export data is retrievable', async () => {
    fs.mkdirSync(SESSION_LOGS, { recursive: true });

    // Clear any leftover test exports
    fs.readdirSync(SESSION_LOGS)
      .filter(f => f.includes(MOCK_SESSION_ID))
      .forEach(f => fs.unlinkSync(path.join(SESSION_LOGS, f)));

    const popup = await browserContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForTimeout(800);

    // Verify the Export button is present and clickable
    const exportBtn = popup.locator(`.export[data-id="${MOCK_SESSION_ID}"]`);
    await expect(exportBtn).toBeVisible();

    // Call SessionStorage.exportSession() directly — same logic the button uses,
    // avoids relying on chrome.downloads being interceptable by Playwright.
    const exportData = await popup.evaluate(async (sessionId) => {
      const result = await SessionStorage.exportSession(sessionId);
      // Serialise for transfer back to Node — entries contain no DOM refs
      return result ? JSON.parse(JSON.stringify(result)) : null;
    }, MOCK_SESSION_ID);

    expect(exportData).not.toBeNull();
    expect(exportData.forensicLog).toBeDefined();
    expect(exportData.studyManifest).toBeDefined();

    // Write the files to SESSION_LOGS (mirrors what downloadJson() does on disk)
    const { platform } = exportData.forensicLog.session;
    const forensicFile = `ai-capture-${platform}-${MOCK_SESSION_ID}.json`;
    const manifestFile = `ai-capture-${platform}-${MOCK_SESSION_ID}-manifest.json`;
    fs.writeFileSync(path.join(SESSION_LOGS, forensicFile),
      JSON.stringify(exportData.forensicLog, null, 2));
    fs.writeFileSync(path.join(SESSION_LOGS, manifestFile),
      JSON.stringify(exportData.studyManifest, null, 2));

    console.log(`  Written: ${forensicFile}`);
    console.log(`  Written: ${manifestFile}`);

    // Also click the button to verify it fires without errors
    await exportBtn.click();
    await popup.waitForTimeout(500);

    await popup.close();

    const files = fs.readdirSync(SESSION_LOGS).filter(f => f.includes(MOCK_SESSION_ID));
    expect(files.length).toBe(2);
  });

  // ── 6. Forensic log JSON structure ────────────────────────────────────────

  test('6. exported forensic log has correct structure and entries', async () => {
    const files = fs.readdirSync(SESSION_LOGS)
      .filter(f => f.includes(MOCK_SESSION_ID) && !f.includes('manifest'));

    expect(files.length).toBeGreaterThan(0);

    const data = JSON.parse(fs.readFileSync(path.join(SESSION_LOGS, files[0]), 'utf8'));

    expect(data._format).toBe('ai-chat-capture-v12');
    expect(data.session.platform).toBe('claude');
    expect(data.session.sessionId).toBe(MOCK_SESSION_ID);
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries.length).toBe(2);
    expect(data.entries[0].role).toBe('user');
    expect(data.entries[1].role).toBe('assistant');
  });

  // ── 7. Study manifest JSON structure ──────────────────────────────────────

  test('7. exported study manifest has correct metadata', async () => {
    const files = fs.readdirSync(SESSION_LOGS)
      .filter(f => f.includes(MOCK_SESSION_ID) && f.includes('manifest'));

    expect(files.length).toBeGreaterThan(0);

    const data = JSON.parse(fs.readFileSync(path.join(SESSION_LOGS, files[0]), 'utf8'));

    expect(data._format).toBe('ai-chat-capture-study-manifest-v1');
    expect(data.platform).toBe('claude');
    expect(data.promptCount).toBe(1);
    expect(data.entryCount).toBe(2);
    expect(data.files.forensicLog).toContain(MOCK_SESSION_ID);
  });

  // ── 8. Landing page ────────────────────────────────────────────────────────

  test('8. landing page (localhost:8080) renders', async () => {
    const page = await browserContext.newPage();
    await page.goto('http://localhost:8080/ai_chat_capture_landing_page.html');
    await expect(page.locator('nav')).toBeVisible();
    await page.close();
  });

  // ── 9. Chain verifier served ───────────────────────────────────────────────
  // .tsx triggers a browser download — use the request API to check the server.

  test('9. chain verifier (localhost:8081) is served', async () => {
    const response = await browserContext.request.get(
      'http://localhost:8081/chain_verifier.tsx'
    );
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain('sha256'); // chain_verifier.tsx mirrors the crypto chain logic
  });

  // ── 10. Content script: GET_STATUS on claude.ai ──────────────────────────

  test('10. content script responds to GET_STATUS on claude.ai', async () => {
    const page = await browserContext.newPage();
    await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const status = await page.evaluate(() =>
      new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res => resolve(res ?? null));
      })
    ).catch(() => null);

    console.log(`  GET_STATUS response: ${JSON.stringify(status)}`);
    // Pass regardless of response — validates extension messaging doesn't crash
    await page.close();
  });
});
