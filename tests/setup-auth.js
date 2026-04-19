/**
 * Cookie converter for test 14+ (real AI platform capture).
 *
 * Prerequisites:
 *   1. Install the "Cookie-Editor" Chrome extension:
 *      https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm
 *
 *   2. While logged in, visit each site, click Cookie-Editor → Export → Export as JSON,
 *      and save the exported text to:
 *        tests/auth/claude-cookies.json      (from claude.ai)
 *        tests/auth/chatgpt-cookies.json     (from chat.openai.com)
 *        tests/auth/gemini-cookies.json      (from gemini.google.com)
 *
 *   3. Run:  node tests/setup-auth.js
 *      → Converts each file to Playwright storageState format in tests/auth/
 *
 * The tests/auth/ folder is git-ignored — credentials stay local.
 */

const path = require('path');
const fs   = require('fs');

const AUTH_DIR = path.join(__dirname, 'auth');

const PLATFORMS = [
  { name: 'claude',  input: 'claude-cookies.json',  output: 'claude-state.json'  },
  { name: 'chatgpt', input: 'chatgpt-cookies.json', output: 'chatgpt-state.json' },
  { name: 'gemini',  input: 'gemini-cookies.json',  output: 'gemini-state.json'  },
];

// Cookie-Editor uses different sameSite strings than Playwright.
function toPlaywrightSameSite(val) {
  if (!val) return 'None';
  switch (String(val).toLowerCase()) {
    case 'strict':         return 'Strict';
    case 'lax':            return 'Lax';
    case 'no_restriction': return 'None';
    case 'unspecified':    return 'None';
    default:               return 'None';
  }
}

function convert(rawCookies) {
  return {
    cookies: rawCookies.map(c => ({
      name:     c.name,
      value:    c.value,
      domain:   c.domain,
      path:     c.path     ?? '/',
      expires:  c.expirationDate != null ? Math.round(c.expirationDate) : -1,
      httpOnly: c.httpOnly  ?? false,
      secure:   c.secure    ?? false,
      sameSite: toPlaywrightSameSite(c.sameSite),
    })),
    origins: [],
  };
}

function main() {
  console.log('\n🍪  Cookie Converter — Cookie-Editor → Playwright');
  console.log('─────────────────────────────────────────────────');

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  let converted = 0;
  let missing   = 0;

  for (const { name, input, output } of PLATFORMS) {
    const inputFile  = path.join(AUTH_DIR, input);
    const outputFile = path.join(AUTH_DIR, output);

    if (!fs.existsSync(inputFile)) {
      console.log(`  ⚠  ${name.padEnd(8)} — ${input} not found, skipping`);
      missing++;
      continue;
    }

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    } catch (err) {
      console.error(`  ✗  ${name.padEnd(8)} — failed to parse ${input}: ${err.message}`);
      missing++;
      continue;
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      console.error(`  ✗  ${name.padEnd(8)} — ${input} is empty or not a JSON array`);
      missing++;
      continue;
    }

    const state = convert(raw);
    fs.writeFileSync(outputFile, JSON.stringify(state, null, 2));
    const kb = (fs.statSync(outputFile).size / 1024).toFixed(1);
    console.log(`  ✓  ${name.padEnd(8)} — ${raw.length} cookies → ${output}  (${kb} KB)`);
    converted++;
  }

  console.log(`\n  ${converted}/${PLATFORMS.length} platforms converted.`);

  if (missing > 0) {
    console.log('\n  For any missing platforms:');
    console.log('    1. Open the site in Chrome (logged in)');
    console.log('    2. Click Cookie-Editor → Export → Export as JSON');
    console.log('    3. Save to tests/auth/<platform>-cookies.json');
    console.log('    4. Re-run: node tests/setup-auth.js\n');
  } else {
    console.log('\n  All done — run:  npx playwright test\n');
  }
}

main();
