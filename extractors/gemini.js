var GeminiExtractor = (function () {
  "use strict";

  const PLATFORM = "gemini";
  const DEBOUNCE_DELAY = 2500; // Gemini DOM settles slower than ChatGPT/Claude

  const SELECTORS = {
    userMessage: 'user-query, [data-message-author="user"], message-content[data-author-type="user"], .user-query, .query-content',
    assistantMessage: 'model-response, [data-message-author="model"], message-content[data-author-type="model"], .model-response-text, .response-content',
    messageContent: '.markdown-main-panel, .response-container-content, .markdown, .message-text',
    conversationContainer: '.conversation-container, .chat-history, main, [role="main"]',
    inputArea: '.ql-editor, .text-input-field, textarea, [contenteditable="true"], rich-textarea .ql-editor',
    turnContainer: '.conversation-turn, .chat-turn, .turn-container, model-response, user-query',
  };

  // Selectors that indicate substantive new message content (not UI chrome).
  // Used by observeNewMessages to filter out post-streaming decoration mutations.
  const MESSAGE_TRIGGER_SELECTORS = [
    "user-query",
    "model-response",
    '[data-message-author="user"]',
    '[data-message-author="model"]',
    'message-content[data-author-type="user"]',
    'message-content[data-author-type="model"]',
    ".model-response-text",
    ".response-container-content",
  ].join(",");

  function isMatch(url) {
    return url.includes("gemini.google.com");
  }

  function cleanUserEchoText(text) {
    const normalized = (text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    // FIX: strip both "You said" and "Gemini said" UI-injected prefixes.
    // Previously only "You said" was stripped; "Gemini said" leaked into
    // pre-settle assistant captures (CP:2 in the live log, 2026-04-18).
    return normalized.replace(/^(You said|Gemini said)\s+/i, "").trim();
  }

  function extractUserText(element) {
    if (!element) return "";

    const preferred = [
      '[data-test-id="user-query"]',
      '[data-testid="user-query"]',
      '.query-text',
      '.user-query-text',
      '.query-content',
      '.text-content',
      '.markdown',
    ];

    for (const selector of preferred) {
      const found = element.querySelector(selector);
      if (found) {
        const text = cleanUserEchoText(extractTextContent(found));
        if (text) return text;
      }
    }

    return cleanUserEchoText(extractTextContent(element));
  }

  function extractAssistantText(element) {
    const contentEl = element.querySelector(SELECTORS.messageContent) || element;
    return extractTextContent(contentEl).trim();
  }

  function extractAllMessages() {
    const messages = [];

    const userEls = document.querySelectorAll(SELECTORS.userMessage);
    const assistantEls = document.querySelectorAll(SELECTORS.assistantMessage);

    if (userEls.length === 0 && assistantEls.length === 0) {
      return extractByStructure();
    }

    const allTurns = [];

    userEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      allTurns.push({ role: "user", element: el, y: rect.top + window.scrollY });
    });

    assistantEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      allTurns.push({ role: "assistant", element: el, y: rect.top + window.scrollY });
    });

    allTurns.sort((a, b) => a.y - b.y);

    allTurns.forEach((turn, index) => {
      const renderedText = turn.role === "user"
        ? extractUserText(turn.element)
        : extractAssistantText(turn.element);

      if (renderedText.trim()) {
        messages.push({
          index: index,
          role: turn.role,
          renderedText: renderedText.trim(),
          element: turn.element,
          timestamp: new Date().toISOString(),
        });
      }
    });

    return messages;
  }

  function extractByStructure() {
    const messages = [];
    const container =
      document.querySelector(SELECTORS.conversationContainer) ||
      document.querySelector("main");
    if (!container) return messages;

    const turns = container.querySelectorAll(SELECTORS.turnContainer);
    turns.forEach((turn, index) => {
      const isUser =
        turn.tagName?.toLowerCase() === "user-query" ||
        turn.querySelector('[class*="user"]') ||
        turn.getAttribute("data-author-type") === "user" ||
        index % 2 === 0;

      const text = isUser ? extractUserText(turn) : extractAssistantText(turn);
      if (!text.trim()) return;

      messages.push({
        index: index,
        role: isUser ? "user" : "assistant",
        renderedText: text.trim(),
        element: turn,
        timestamp: new Date().toISOString(),
      });
    });

    return messages;
  }

  function extractTextContent(element) {
    if (!element) return "";

    const clone = element.cloneNode(true);

    const uiElements = clone.querySelectorAll(
      'button, [class*="action"], [class*="toolbar"], [class*="copy-button"]'
    );
    uiElements.forEach((el) => {
      const text = el.textContent || "";
      if (
        text.includes("Copy") ||
        text.includes("Share") ||
        text.includes("Modify") ||
        text.length < 15
      ) {
        el.remove();
      }
    });

    const codeBlocks = clone.querySelectorAll("pre, code-block");
    codeBlocks.forEach((pre) => {
      const code = pre.querySelector("code") || pre;
      const lang =
        code.className
          ?.split(" ")
          .find((c) => c.startsWith("language-"))
          ?.replace("language-", "") || "";
      const codeText = code.textContent || "";
      pre.textContent = `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
    });

    return clone.innerText || clone.textContent || "";
  }

  function getInputElement() {
    return document.querySelector(SELECTORS.inputArea);
  }

  function getThreadKey() {
    try {
      const parsed = new URL(window.location.href);
      // FIX: strip search entirely — UTM/tracking params make threadKey
      // non-deterministic for the same conversation thread, breaking session
      // resumption and fingerprint reproducibility (sess_mo4itkoh, 2026-04-18).
      return `${parsed.origin}${parsed.pathname}`;
    } catch (e) {
      return window.location.href;
    }
  }

  function observeNewMessages(callback) {
    const container =
      document.querySelector(SELECTORS.conversationContainer) ||
      document.querySelector("main") ||
      document.body;

    // FIX: only trigger callback when a substantive message node is added.
    // Previously any addedNodes fired the callback, causing Gemini's
    // post-streaming decoration mutations (copy buttons, formatting wrappers,
    // toolbar chrome) to reset the debounce timer repeatedly — producing
    // duplicateCount:3 against entryCount:4 in the 2026-04-18 live capture.
    const observer = new MutationObserver((mutations) => {
      let hasNewContent = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (
            node.matches?.(MESSAGE_TRIGGER_SELECTORS) ||
            node.querySelector?.(MESSAGE_TRIGGER_SELECTORS)
          ) {
            hasNewContent = true;
            break;
          }
        }
        if (hasNewContent) break;
      }
      if (hasNewContent) callback();
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  return {
    PLATFORM,
    DEBOUNCE_DELAY,
    SELECTORS,
    isMatch,
    extractAllMessages,
    extractTextContent,
    getThreadKey,
    getInputElement,
    observeNewMessages,
  };
})();
