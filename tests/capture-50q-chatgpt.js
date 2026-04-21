/**
 * capture-50q-chatgpt.js
 * Sends 50 questions to ChatGPT, waits for the extension to capture each one,
 * exports a forensic log to session_logs/, and prints a per-prompt result table.
 *
 * Usage: node tests/capture-50q-chatgpt.js
 * Prereq: node tests/setup-auth.js  (creates tests/auth/chatgpt-state.json)
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const SESSION_LOGS   = path.resolve(EXTENSION_PATH, '..', '..', '..', 'session_logs');
const AUTH_FILE      = path.join(__dirname, 'auth', 'chatgpt-state.json');

const QUESTIONS = [
  'What is the third prime number?',
  'What color is a ripe banana?',
  'What planet do humans live on?',
  'What gas do plants absorb from the air?',
  'What is the opposite of hot?',
  'What animal says meow?',
  'What is frozen water called?',
  'What do bees make?',
  'What is the largest ocean on Earth?',
  'What shape has three sides?',
  'What is the first month of the year?',
  'What do you call a baby dog?',
  'What is 2 plus 2?',
  'What do you use to write on a blackboard?',
  'What is the capital of France?',
  'What bird is known for hooting at night?',
  'What do cows drink?',
  'What season comes after summer?',
  'What is the red planet called?',
  'What do you call molten rock from a volcano?',
  'What is the hardest natural substance?',
  'What do spiders build?',
  'What is the tallest animal?',
  'What do you call a group of fish swimming together?',
  'What metal is most associated with jewelry?',
  'What do you call the star at the center of our solar system?',
  'What fruit is famous for keeping the doctor away?',
  'What is the smallest prime number?',
  'What animal is known as man\'s best friend?',
  'What do you call a scientist who studies stars?',
  'What is the main language spoken in Brazil?',
  'What is water turning into vapor called?',
  'What do frogs begin life as?',
  'What is a house made of snow called?',
  'What do you call a person who teaches students?',
  'What organ pumps blood through the body?',
  'What is the fastest land animal?',
  'What do you call a shape with eight sides?',
  'What is the top layer of the Earth called?',
  'What do pandas mainly eat?',
  'What is the nearest star to Earth?',
  'What do you call the sound a lion makes?',
  'What is the chemical symbol for gold?',
  'What do you call a word with the same meaning as another?',
  'What is the boiling point of water in Celsius?',
  'What do you call the person who leads an orchestra?',
  'What fruit has seeds on the outside?',
  'What is the seventh day of the week in many calendars?',
  'What is the main ingredient in guacamole?',
  'What do you call a word read the same backward?',
];

async function run() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error('No chatgpt-state.json — run: node tests/setup-auth.js');
    process.exit(1);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-50q-chatgpt-'));
  const authState   = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));

  const browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const sw = browserContext.serviceWorkers()[0]
    ?? await browserContext.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = sw.url().split('/')[2];
  console.log('Extension ID:', extensionId);

  await sw.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
  await browserContext.addCookies(authState.cookies ?? []);

  const popup = await browserContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForLoadState('domcontentloaded');

  const navStart = Date.now();
  const page = await browserContext.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const url = page.url();
  if (url.includes('login') || url.includes('signin') || url.includes('/auth/') || url.includes('auth0')) {
    console.error('⚠ Login redirect — cookies expired. Re-run: node tests/setup-auth.js');
    await browserContext.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('ChatGPT URL:', page.url());

  const inputSel = 'div[contenteditable="true"][data-lexical-editor], div[contenteditable="true"][role="textbox"], div[contenteditable="true"].ProseMirror, div[contenteditable="true"]';
  await page.locator(inputSel).first().waitFor({ state: 'visible', timeout: 20000 });
  console.log('ChatGPT ready\n');

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const getSessionSnap = () => popup.evaluate(async (since) => {
    const idx = await new Promise(r =>
      chrome.storage.local.get('aicap_session_index', res => r(res['aicap_session_index'] ?? []))
    );
    const candidates = idx
      .filter(s => s.platform === 'chatgpt' && new Date(s.startedAt).getTime() > since)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    if (!candidates.length) return null;
    const s = await SessionStorage.getSession(candidates[0].sessionId);
    if (!s) return null;
    return {
      sessionId:      candidates[0].sessionId,
      promptCount:    s.promptCount,
      assistantCount: s.assistantCount,
      entryCount:     s.entryCount,
      duplicateCount: s.duplicateCount,
    };
  }, navStart);

  // FIX: Use stop-button presence/absence instead of cumulative assistant-message
  // count.  After ~30 messages ChatGPT rate-limits and stops generating, so the
  // DOM count stalls — causing 90s timeouts from Q31 onward.  Stop-button
  // detection is reliable per-turn regardless of overall message count.
  const CHATGPT_STOP_BTN = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop"]',
  ].join(', ');

  const waitForAssistantReply = async (n) => {
    try {
      // Wait for stop button to appear (generation started) — short window.
      await page.waitForFunction(
        sel => !!document.querySelector(sel), CHATGPT_STOP_BTN,
        { timeout: 15000 }
      ).catch(() => {}); // may already be gone for instant responses
      // Wait for stop button to disappear (generation complete).
      await page.waitForFunction(
        sel => !document.querySelector(sel), CHATGPT_STOP_BTN,
        { timeout: 90000 }
      );
      await new Promise(r => setTimeout(r, 2000)); // let DOM settle
    } catch { console.log(`  ⚠ Timeout waiting for ChatGPT reply #${n}`); }
  };

  // Give the extension time to finish waitForStreamingComplete (6+ s after
  // streaming ends) and persist the assistant entry before we check counts.
  const waitForAssistantCount = async (target, timeoutMs = 20000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      const snap = await getSessionSnap();
      if (snap && snap.assistantCount >= target) return snap;
      await new Promise(r => setTimeout(r, 400));
    }
    return await getSessionSnap();
  };

  const waitForPromptCount = async (target, timeoutMs = 40000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      const snap = await getSessionSnap();
      if (snap && snap.promptCount >= target) return snap;
      await new Promise(r => setTimeout(r, 400));
    }
    return await getSessionSnap();
  };

  const sendQuestion = async (text) => {
    const inp = page.locator(inputSel).first();
    await inp.waitFor({ state: 'visible', timeout: 10000 });
    await inp.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(text, { delay: 20 });
    await new Promise(r => setTimeout(r, 300));
    const sendBtn = page.locator(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"]'
    ).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
  };

  // ── Q1: send first, wait for URL redirect + session creation ──────────────────
  console.log(`Q 1: ${QUESTIONS[0].substring(0, 55).padEnd(55)} `, '(sending)');
  await sendQuestion(QUESTIONS[0]);

  await page.waitForFunction(
    () => window.location.href.includes('/c/'),
    { timeout: 20000 }
  ).catch(() => {});
  console.log('     Redirected to:', page.url());

  {
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      const s = await getSessionSnap();
      if (s) { console.log('     Session:', s.sessionId, '\n'); break; }
      await new Promise(r => setTimeout(r, 400));
    }
    if (!(await getSessionSnap())) {
      console.error('Content script did not create a ChatGPT session — giving up');
      await browserContext.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      process.exit(1);
    }
  }

  await waitForAssistantReply(1);
  const snapQ1      = await waitForPromptCount(1, 40000);
  const snapFinalQ1 = await waitForAssistantCount(1, 20000);
  const promptOkQ1    = snapFinalQ1 && snapFinalQ1.promptCount   >= 1;
  const assistantOkQ1 = snapFinalQ1 && snapFinalQ1.assistantCount >= 1;
  console.log(`Q 1: ${QUESTIONS[0].substring(0, 55).padEnd(55)} ${promptOkQ1 && assistantOkQ1 ? '✓ Q+A' : promptOkQ1 ? '~ Q only' : '✗ missed'}`);
  const results = [{ n: 1, q: QUESTIONS[0], promptOk: promptOkQ1, assistantOk: assistantOkQ1 }];

  // ── Q2–Q50 ───────────────────────────────────────────────────────────────────
  for (let i = 1; i < QUESTIONS.length; i++) {
    const n = i + 1;
    const q = QUESTIONS[i];
    process.stdout.write(`Q${String(n).padStart(2)}: ${q.substring(0, 55).padEnd(55)} `);

    await sendQuestion(q);
    await waitForAssistantReply(n);
    const snap      = await waitForPromptCount(n, 40000);
    const snapFinal = await waitForAssistantCount(n, 20000);

    const promptOk    = snapFinal && snapFinal.promptCount   >= n;
    const assistantOk = snapFinal && snapFinal.assistantCount >= n;
    const status = promptOk && assistantOk ? '✓ Q+A' : promptOk ? '~ Q only' : '✗ missed';
    console.log(status);
    results.push({ n, q, promptOk, assistantOk, snap: snapFinal });
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const finalSnap = await getSessionSnap();
  console.log('\n══════════════════════════════════════════');
  console.log(' CHATGPT 50Q TEST RESULTS');
  console.log('══════════════════════════════════════════');
  console.log(`  Prompts captured  : ${finalSnap?.promptCount ?? '?'} / ${QUESTIONS.length}`);
  console.log(`  Responses captured: ${finalSnap?.assistantCount ?? '?'} / ${QUESTIONS.length}`);
  console.log(`  Duplicates skipped: ${finalSnap?.duplicateCount ?? '?'}`);
  console.log(`  Total entries     : ${finalSnap?.entryCount ?? '?'}`);

  const missed = results.filter(r => !r.promptOk);
  if (missed.length) {
    console.log(`\n  Missed prompts (${missed.length}):`);
    missed.forEach(r => console.log(`    Q${r.n}: ${r.q}`));
  }
  const qOnly = results.filter(r => r.promptOk && !r.assistantOk);
  if (qOnly.length) {
    console.log(`\n  Prompt captured but response missed (${qOnly.length}):`);
    qOnly.forEach(r => console.log(`    Q${r.n}: ${r.q}`));
  }

  // ── Export — click "Export All Sessions" in the popup ────────────────────────
  // Clicking the button exercises the real UI flow (chrome.downloads.download).
  // We then also pull the data programmatically so it is always written to
  // session_logs/ regardless of where Chrome chose to save its own download.
  console.log('\n  Clicking "Export All Sessions"...');
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
    console.log(`  Exported: ${logPath}`);
    console.log(`  Exported: ${maniPath}`);
  }
  if (!allSessions.length) console.log('  ⚠ No sessions found to export.');

  await browserContext.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('\nDone.');
}

run().catch(e => { console.error(e); process.exit(1); });
