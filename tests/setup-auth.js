/**
 * Cookie extractor for test 14+ (real AI platform capture).
 *
 * Prerequisites:
 *   1. Run  tests/start-chrome-debug.bat  (closes Chrome, reopens with debug port 9222)
 *   2. In that Chrome window, log into claude.ai, chat.openai.com, gemini.google.com
 *   3. Run this script:  node tests/setup-auth.js
 *
 * Connects to the running Chrome via CDP (no new browser launch, no bot detection),
 * extracts all cookies for each platform, and saves them as Playwright storage-state
 * files in tests/auth/.
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_DIR = path.join(__dirname, 'auth');

const PLATFORMS = [
  {
    name: 'claude',
    domains: ['claude.ai', '.claude.ai', 'anthropic.com', '.anthropic.com'],
  },
  {
    name: 'chatgpt',
    domains: [
      'chatgpt.com', '.chatgpt.com',
      'chat.openai.com', '.chat.openai.com',
      'openai.com', '.openai.com',
      'auth0.openai.com',
    ],
  },
  {
    name: 'gemini',
    domains: [
      'gemini.google.com', '.gemini.google.com',
      'google.com', '.google.com',
      'accounts.google.com', '.accounts.google.com',
    ],
  },
];

function toPlaywrightSameSite(val) {
  if (!val) return 'None';
  switch (String(val).toLowerCase()) {
    case 'strict': return 'Strict';
    case 'lax':    return 'Lax';
    default:       return 'None';
  }
}

async function main() {
  console.log('\n🍪  AI Platform Cookie Extractor');
  console.log('─────────────────────────────────────────');
  console.log('  Connecting to Chrome on localhost:9222…\n');

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222');
  } catch {
    console.error('  ✗ Could not connect to Chrome.');
    console.error('  Run tests/start-chrome-debug.bat first, then retry.\n');
    process.exit(1);
  }

  console.log('  Connected ✓  Reading cookies from your Chrome session…\n');

  // Browser-level CDP session — gives us ALL cookies across all tabs.
  const cdp = await browser.newBrowserCDPSession();
  const { cookies } = await cdp.send('Network.getAllCookies');
  console.log(`  Found ${cookies.length} total cookies.\n`);

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  let saved = 0;
  for (const { name, domains } of PLATFORMS) {
    const filtered = cookies.filter(c =>
      domains.some(d => c.domain === d || c.domain === `.${d.replace(/^\./, '')}`)
    );

    if (!filtered.length) {
      console.log(`  ⚠  ${name.padEnd(8)} — no cookies found (not logged in?)`);
      continue;
    }

    const state = {
      cookies: filtered.map(c => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain,
        path:     c.path  ?? '/',
        expires:  c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure:   c.secure   ?? false,
        sameSite: toPlaywrightSameSite(c.sameSite),
      })),
      origins: [],
    };

    const file = path.join(AUTH_DIR, `${name}-state.json`);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  ✓  ${name.padEnd(8)} — ${filtered.length} cookies saved → ${name}-state.json  (${kb} KB)`);
    saved++;
  }

  console.log(`\n  ${saved}/3 platforms saved to tests/auth/  (git-ignored)`);
  if (saved < 3) {
    console.log('  Re-open start-chrome-debug.bat, log into any missing platforms, and re-run this script.');
  } else {
    console.log('  All done — run:  npx playwright test\n');
  }

  // Disconnect without closing the user's Chrome session.
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('\n  ✗ Error:', err.message);
  process.exit(1);
});
