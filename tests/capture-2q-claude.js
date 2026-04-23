/**
 * capture-2q-claude.js
 * Quick 2-prompt smoke test for Claude — verifies auth and capture are working.
 * Usage: node tests/capture-2q-claude.js
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const SESSION_LOGS   = path.resolve(EXTENSION_PATH, '..', '..', '..', 'session_logs');
const AUTH_FILE      = path.join(__dirname, 'auth', 'claude-state.json');

const STOP_BTN = [
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  'button[data-testid="stop-button"]',
].join(', ');

async function run() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error('No claude-state.json — run: node tests/setup-auth.js');
    process.exit(1);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-2q-claude-'));
  const authState   = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const sw = ctx.serviceWorkers()[0]
    ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = sw.url().split('/')[2];
  console.log('Extension ID:', extId);

  await sw.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
  await ctx.addCookies(authState.cookies ?? []);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState('domcontentloaded');

  const navStart = Date.now();
  const page = await ctx.newPage();
  await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  const url = page.url();
  if (url.includes('login') || url.includes('signin') || url.includes('/auth/')) {
    console.error('Not signed in — cookies expired. Re-run: node tests/setup-auth.js');
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('Claude URL:', url);

  const inputSel = '[contenteditable="true"].ProseMirror, div[contenteditable="true"], .ProseMirror';
  await page.locator(inputSel).first().waitFor({ state: 'visible', timeout: 20000 });
  console.log('Claude ready\n');

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const getSnap = () => popup.evaluate(async (since) => {
    const idx = await new Promise(r =>
      chrome.storage.local.get('aicap_session_index', res => r(res['aicap_session_index'] ?? []))
    );
    const candidates = idx
      .filter(s => s.platform === 'claude' && new Date(s.startedAt).getTime() > since)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    if (!candidates.length) return null;
    const s = await SessionStorage.getSession(candidates[0].sessionId);
    return s ? { sessionId: candidates[0].sessionId, promptCount: s.promptCount, assistantCount: s.assistantCount } : null;
  }, navStart);

  const waitStop = async (n) => {
    try {
      await page.waitForFunction(
        sel => !!document.querySelector(sel), STOP_BTN, { timeout: 15000 }
      ).catch(() => {});
      await page.waitForFunction(
        sel => !document.querySelector(sel), STOP_BTN, { timeout: 90000 }
      );
      await new Promise(r => setTimeout(r, 2000));
    } catch { console.log(`  ⚠ Timeout waiting for reply #${n}`); }
  };

  const waitAssist = async (target, ms = 20000) => {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      const s = await getSnap();
      if (s && s.assistantCount >= target) return s;
      await new Promise(r => setTimeout(r, 400));
    }
    return getSnap();
  };

  const send = async (text) => {
    const inp = page.locator(inputSel).first();
    await inp.waitFor({ state: 'visible', timeout: 10000 });
    await inp.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(text, { delay: 20 });
    await new Promise(r => setTimeout(r, 300));
    const btn = page.locator([
      'button[aria-label="Send message"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
    ].join(', ')).first();
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.keyboard.press('Enter');
  };

  // ── Q1 ───────────────────────────────────────────────────────────────────────
  console.log('Q1: What is the capital of France?');
  await send('What is the capital of France?');

  await page.waitForFunction(
    () => window.location.href.includes('/chat/'),
    { timeout: 20000 }
  ).catch(() => {});
  console.log('     URL:', page.url());

  // Wait for session to appear
  {
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      const s = await getSnap();
      if (s) { console.log('     Session:', s.sessionId); break; }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  await waitStop(1);
  const s1 = await waitAssist(1, 60000);
  console.log(`     prompts=${s1?.promptCount ?? '?'}  responses=${s1?.assistantCount ?? '?'}  → ${s1?.promptCount >= 1 && s1?.assistantCount >= 1 ? '✓ Q+A' : '✗'}\n`);

  // ── Q2 ───────────────────────────────────────────────────────────────────────
  console.log('Q2: What is the tallest mountain on Earth?');
  await send('What is the tallest mountain on Earth?');

  await waitStop(2);
  const s2 = await waitAssist(2, 60000);
  console.log(`     prompts=${s2?.promptCount ?? '?'}  responses=${s2?.assistantCount ?? '?'}  → ${s2?.promptCount >= 2 && s2?.assistantCount >= 2 ? '✓ Q+A' : '✗'}\n`);

  // ── Export — click "Export All Sessions" in the popup ────────────────────────
  // Clicking the button exercises the real UI flow (chrome.downloads.download).
  // We then also pull the data programmatically so it is always written to
  // session_logs/ regardless of where Chrome chose to save its own download.
  // Finalize all sessions so exported data shows status:"finalized" + endedAt
  await popup.evaluate(async () => {
    const idx = await new Promise(r =>
      chrome.storage.local.get('aicap_session_index', res => r(res['aicap_session_index'] ?? []))
    );
    for (const rec of idx) {
      await SessionStorage.finalizeSession(rec.sessionId, 'test_complete');
    }
  });

  console.log('\nClicking "Export All Sessions"...');
  await popup.bringToFront();
  await popup.click('#exportAll');
  await new Promise(r => setTimeout(r, 3000)); // let UI attempt its own download

  const allSessions = await popup.evaluate(async () => {
    const sessions = await SessionStorage.getAllSessions();
    const out = [];
    for (const s of sessions) {
      const exp = await SessionStorage.exportSession(s.sessionId);
      if (exp) out.push(JSON.parse(JSON.stringify(exp)));
    }
    return out;
  });

  fs.mkdirSync(SESSION_LOGS, { recursive: true });
  for (const exp of allSessions) {
    const p   = exp.forensicLog.session.platform;
    const sid = exp.forensicLog.session.sessionId;
    const logPath  = path.join(SESSION_LOGS, `ai-capture-${p}-${sid}.json`);
    const maniPath = path.join(SESSION_LOGS, `ai-capture-${p}-${sid}-manifest.json`);
    fs.writeFileSync(logPath,  JSON.stringify(exp.forensicLog,   null, 2));
    fs.writeFileSync(maniPath, JSON.stringify(exp.studyManifest, null, 2));
    console.log(`Exported: ${logPath}`);
    console.log(`Exported: ${maniPath}`);
  }
  if (!allSessions.length) console.log('⚠ No sessions found to export.');

  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('Done.');
}

run().catch(e => { console.error(e); process.exit(1); });
