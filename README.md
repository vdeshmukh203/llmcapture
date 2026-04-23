# llmcapture — AI Chat Capture: Forensic Logger

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version 12.0.0](https://img.shields.io/badge/version-12.0.0-blue.svg)](https://github.com/vdeshmukh203/llmcapture/releases/tag/v12.0.0)

A Chrome browser extension that captures AI chat conversations (ChatGPT, Claude, Gemini) as **cryptographically chained, tamper-evident session logs** — enabling reproducible research into LLM interaction sessions.

---

## Overview

`llmcapture` instruments web-based LLM interfaces at the browser level, intercepting rendered conversation turns and persisting them with SHA-256 hash chaining. Each captured session produces a verifiable log where any post-hoc modification breaks the chain — making it suitable as forensic evidence of human–AI interactions for research purposes.

This tool was developed in support of research on **integrity-preserving instrumentation for reproducible capture of web-based LLM interaction sessions**.

---

## Key Features

- **Tamper-evident logging** — SHA-256 hash chaining links every message turn; any alteration invalidates the chain
- **Multi-platform support** — captures ChatGPT, Claude, and Gemini conversation threads
- **Input capture** — records user prompts at the point of submission, before any platform processing
- **Structured JSON output** — session logs export as timestamped, structured JSON files
- **Chain verification** — included `chain_verifier.tsx` utility validates log integrity offline
- **Privacy-preserving** — all capture and storage is local; no data leaves the browser

---

## Architecture

```
llmcapture/
├── manifest.json          # Chrome Extension Manifest V3
├── background.js          # Service worker: session orchestration
├── content.js             # Injected coordinator per tab
├── popup.html/js/css      # Extension popup UI
├── extractors/            # Platform-specific DOM extractors
│   ├── chatgpt.js
│   ├── claude.js
│   └── gemini.js
├── lib/
│   ├── crypto.js          # SHA-256 hash chaining
│   ├── storage.js         # IndexedDB session persistence
│   └── input-capture.js   # Prompt interception
├── chain_verifier.tsx     # Offline integrity verification tool
└── tests/                 # Playwright end-to-end tests
```

---

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository root folder
5. The extension icon will appear in your toolbar

---

## Usage

1. Navigate to [ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), or [Gemini](https://gemini.google.com)
2. Click the extension icon to open the capture panel
3. Start a conversation — turns are captured automatically
4. Click **Export Session** to download the JSON log file

---

## Verifying Session Integrity

Use the included chain verifier to validate a session log:

```bash
npx ts-node chain_verifier.tsx path/to/session_log.json
```

A valid chain outputs `✓ Chain intact`. Any modification to message content, timestamps, or metadata will produce a verification failure identifying the broken link.

---

## Research Context

This extension was built as instrumentation infrastructure for studying LLM interaction reproducibility. The session logs it produces serve as primary research data, capturing the full context of human–AI exchanges in a format that can be shared, audited, and cited.

If you use this tool in academic work, please cite the associated paper:

> Deshmukh, V. (2024). *Integrity Preserving Instrumentation for Reproducible Capture of Web-Based LLM Interaction Sessions*.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Contributing

Issues and pull requests welcome. Please open an issue first to discuss significant changes.
