var ClaudeExtractor = (function () {
  "use strict";

  const PLATFORM = "claude";

  const SELECTORS = {
    userMessage: '[data-testid="user-message"], .font-user-message, [class*="human-turn"], [class*="UserMessage"]',
    assistantMessage: '[data-testid="assistant-message"], .font-claude-message, [class*="assistant-turn"], [class*="AssistantMessage"]',
    messageContent: '.markdown-content, .prose, [class*="message-content"], [class*="MessageContent"]',
    conversationContainer: '[class*="conversation"], [class*="chat-messages"], main, [role="main"]',
    inputArea: '[contenteditable="true"], .ProseMirror, textarea',
    turnContainer: '[class*="turn"], [data-testid*="message"], [class*="Message"]',
  };

  function isMatch(url) {
    return url.includes("claude.ai");
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
      allTurns.push({
        role: "user",
        element: el,
        y: rect.top + window.scrollY,
      });
    });

    assistantEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      allTurns.push({
        role: "assistant",
        element: el,
        y: rect.top + window.scrollY,
      });
    });

    allTurns.sort((a, b) => a.y - b.y);

    allTurns.forEach((turn, index) => {
      const contentEl =
        turn.element.querySelector(SELECTORS.messageContent) || turn.element;
      const renderedText = extractTextContent(contentEl);

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
      const text = extractTextContent(turn);
      if (!text.trim()) return;

      const isUser =
        turn.querySelector('[class*="human"]') ||
        turn.querySelector('[class*="user"]') ||
        turn.getAttribute("data-testid")?.includes("user") ||
        index % 2 === 0;

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

    const buttons = clone.querySelectorAll("button");
    buttons.forEach((btn) => {
      const text = btn.textContent || "";
      if (
        text.includes("Copy") ||
        text.includes("Retry") ||
        text.includes("Edit")
      ) {
        btn.remove();
      }
    });

    const codeBlocks = clone.querySelectorAll("pre");
    codeBlocks.forEach((pre) => {
      const code = pre.querySelector("code");
      if (code) {
        const lang =
          code.className
            .split(" ")
            .find((c) => c.startsWith("language-"))
            ?.replace("language-", "") || "";
        const codeText = code.textContent || "";
        pre.textContent = `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
      }
    });

    return clone.innerText || clone.textContent || "";
  }

  function getInputElement() {
    return document.querySelector(SELECTORS.inputArea);
  }

  function getThreadKey() {
    try {
      const parsed = new URL(window.location.href);
      return `${parsed.origin}${parsed.pathname}${parsed.search || ""}`;
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
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              hasNewContent = true;
              break;
            }
          }
        }
        if (
          mutation.type === "characterData" ||
          mutation.type === "childList"
        ) {
          hasNewContent = true;
        }
      }
      if (hasNewContent) {
        callback();
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
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
