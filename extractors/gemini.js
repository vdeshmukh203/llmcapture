var GeminiExtractor = (function () {
  "use strict";

  const PLATFORM = "gemini";

  const SELECTORS = {
    userMessage: 'user-query, [data-message-author="user"], message-content[data-author-type="user"], .user-query, .query-content',
    assistantMessage: 'model-response, [data-message-author="model"], message-content[data-author-type="model"], .model-response-text, .response-content',
    messageContent: '.markdown-main-panel, .response-container-content, .markdown, .message-text',
    conversationContainer: '.conversation-container, .chat-history, main, [role="main"]',
    inputArea: '.ql-editor, .text-input-field, textarea, [contenteditable="true"], rich-textarea .ql-editor',
    // FIX: Added send button selector — previously absent, causing button-click
    // submissions to have no submittedAt in input-capture's history.
    sendButton: 'button[aria-label*="Send"], button[aria-label*="send"], button.send-button, [data-testid*="send-button"], mat-icon-button[aria-label*="Send"]',
    turnContainer: '.conversation-turn, .chat-turn, .turn-container, model-response, user-query',
  };

  function isMatch(url) {
    return url.includes("gemini.google.com");
  }

  function cleanUserEchoText(text) {
    const normalized = (text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    return normalized.replace(/^You said\s+/i, "").trim();
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
      // FIX: Strip query string entirely. Gemini conversation identity is solely
      // in the path (/app/THREAD_ID). Including parsed.search caused 15+ tracking
      // params (gclid, gbraid, UTM etc.) to enter the threadKey, making it 483
      // chars long and breaking session resume when the user navigates back via
      // a different ad click (different gclid = different key = new session created
      // instead of resuming the existing one).
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

    const observer = new MutationObserver((mutations) => {
      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          hasNewContent = true;
          break;
        }
      }
      if (hasNewContent) {
        callback();
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  return {
    PLATFORM,
    SELECTORS,
    isMatch,
    extractAllMessages,
    extractTextContent,
    getThreadKey,
    getInputElement,
    observeNewMessages,
  };
})();
