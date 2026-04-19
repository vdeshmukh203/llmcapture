/**
 * One-time auth setup for test 14 (real Claude.ai capture).
 *
 * Run this script ONCE before the test suite:
 *   node tests/setup-auth.js
 *
 * It opens YOUR existing Chrome profile (where you are already logged into
 * claude.ai), navigates there, and saves the session cookies to
 * tests/auth/claude-state.json — bypassing bot-detection entirely.
 *
 * ⚠  Close ALL Chrome windows before running this script.
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const AUTH_DIR  = path.join(__dirname, 'auth');
const AUTH_FILE = path.join(AUTH_DIR, 'claude-state.json');

// Locate the Chrome user-data directory for the current OS.
function chromeUserDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    default:
      return path.join(os.homedir(), '.config', 'google-chrome');
  }
}

async function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main() {
  const userDataDir = chromeUserDataDir();

  console.log('\n🔐  Claude.ai Auth Setup');
  console.log('─────────────────────────────────────────');
  console.log('  Uses your existing Chrome profile (already logged into claude.ai)');
  console.log('  so bot-detection / security checks are bypassed completely.\n');
  console.log(`  Profile: ${userDataDir}\n`);
  console.log('  ⚠  Close ALL Chrome windows (including background apps) before');
  console.log('     continuing — Chrome locks its profile when running.\n');

  await waitForEnter('  → Close Chrome, then press Enter: ');

  if (!fs.existsSync(userDataDir)) {
    console.error(`\n  ✗ Chrome profile not found at:\n    ${userDataDir}`);
    console.error('  Install Chrome or update the chromeUserDataDir() path in this script.');
    process.exit(1);
  }

  console.log('\n  Opening Chrome with your profile…');

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chrome',
    });
  } catch (err) {
    console.error('\n  ✗ Could not open Chrome. Is it still running?');
    console.error('  Close ALL Chrome windows (check system tray too) and try again.');
    console.error(`  Detail: ${err.message}`);
    process.exit(1);
  }

  const page = context.pages()[0] ?? await context.newPage();

  console.log('  Navigating to claude.ai…');
  try {
    await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch {
    // page may redirect — that is fine, keep going
  }

  // Give the page 2 s to settle then check if we landed on the chat UI
  await new Promise(r => setTimeout(r, 2000));
  const url = page.url();

  if (url.includes('/login') || url.includes('accounts.') || url.includes('/auth')) {
    console.log('\n  Not logged in. Log into Claude.ai in the Chrome window that just opened.');
    await waitForEnter('  → Log in, then press Enter: ');
  } else {
    console.log('  Already logged in ✓');
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: AUTH_FILE });

  const kb = (fs.statSync(AUTH_FILE).size / 1024).toFixed(1);
  console.log(`\n  ✓ Auth state saved  →  ${AUTH_FILE}  (${kb} KB)`);
  console.log('  This file is git-ignored — your credentials stay local.');
  console.log('  Re-run this script if test 14 starts failing with a login redirect.\n');

  await context.close();
  process.exit(0);
}

main().catch(err => {
  console.error('\n  ✗ Setup failed:', err.message);
  process.exit(1);
});
