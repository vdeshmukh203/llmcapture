/**
 * One-time auth setup for test 14 (real Claude.ai capture).
 *
 * Run this script ONCE before the test suite to save your login session:
 *   node tests/setup-auth.js
 *
 * It will open a visible Chromium window pointed at claude.ai.
 * Log in normally with your account, then come back here and press Enter.
 * Your session cookies are saved to tests/auth/claude-state.json.
 *
 * This file is git-ignored. Re-run if your session expires.
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const AUTH_DIR  = path.join(__dirname, 'auth');
const AUTH_FILE = path.join(AUTH_DIR, 'claude-state.json');

async function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main() {
  console.log('\n🔐  Claude.ai Auth Setup');
  console.log('─────────────────────────────────────────');
  console.log('  A Chromium window will open at claude.ai.');
  console.log('  Log in with your account as normal.');
  console.log('  When you are on the main chat page, come');
  console.log('  back here and press Enter to save your session.\n');

  // Use the real installed Chrome (not Playwright's Chromium) so that
  // Claude.ai's bot-detection / security checks pass normally.
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded' });
  console.log('  Browser opened → log in at the Claude.ai window.');
  console.log('  (The window stays open until you press Enter here.)\n');

  await waitForEnter('  → Press Enter once you are logged in and see the chat interface: ');

  // Save cookies + localStorage for claude.ai
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: AUTH_FILE });

  const stat = fs.statSync(AUTH_FILE);
  console.log(`\n  ✓ Auth state saved  →  ${AUTH_FILE}  (${(stat.size / 1024).toFixed(1)} KB)`);
  console.log('  This file is git-ignored — your credentials stay local.');
  console.log('  Re-run this script if test 14 starts failing with a login redirect.\n');

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('\n  ✗ Setup failed:', err.message);
  process.exit(1);
});
