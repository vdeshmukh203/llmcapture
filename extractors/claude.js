var ClaudeExtractor = (function () {
  "use strict";

  const PLATFORM = "claude";

  const SELECTORS = {
    userMessage: '[data-testid="user-message"], .font-user-message, [class*="human-turn"], [class*="UserMessage"]',
    assistantMessage: '[data-testid="assistant-message"], .font-claude-message, [class*="assistant-turn"], [class*="AssistantMessage"]',
    messageContent: '.markdown-content, .prose, [class*="message-content"], [class*="MessageContent"]',
    conversationContainer: '[class*="conversation"], [class*="chat-messages"], main, [role="main"]',
    inputArea: '[contenteditable="true"], .ProseMirror, textarea',
    // FIX: Added send button selector — previously absent, so button-click
    // submissions had no submittedAt recorded in input-capture history.
    sendButton: 'button[aria-label="Send message"], button[data-testid="send-button"], button[aria-label*="Send"]',
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

    // User messages: always use the known-working direct selector. Do NOT fall
    // through to extractByStructure() for user messages — that path can silently
    // return [] if the container query picks the wrong element, breaking capture.
    userEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      allTurns.push({ role: "user", element: el, y: rect.top + window.scrollY });
    });

    if (assistantEls.length > 0) {
      // Assistant selector is working — use it directly.
      assistantEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        allTurns.push({ role: "assistant", element: el, y: rect.top + window.scrollY });
      });
    } else if (userEls.length > 0) {
      // Assistant selector yielded nothing (stale/changed DOM). Try to locate
      // assistant turns by DOM proximity: each assistant response is typically
      // the next top-level sibling of the user message's container ancestor.
      findAssistantsByProximity(userEls).forEach((el) => {
        const rect = el.getBoundingClientRect();
        allTurns.push({ role: "assistant", element: el, y: rect.top + window.scrollY });
      });
    }

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

  // Returns the direct child of `container` that is an ancestor of `el`,
  // or null when `el` is not a descendant of `container`.
  function getTopLevelChild(el, container) {
    let current = el;
    while (current && current.parentElement !== container) {
      current = current.parentElement;
    }
    return current !== container ? current : null;
  }

  // Locates assistant response elements by walking the DOM siblings that
  // immediately follow each user message's container anchor. Used when the
  // specific assistant-message CSS selector matches nothing.
  function findAssistantsByProximity(userEls) {
    const found = [];
    const seen  = new Set();

    // Prefer main > [role="main"] — more specific than [class*="conversation"]
    // which can match sidebar/header elements that appear earlier in the DOM.
    const container =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector(SELECTORS.conversationContainer);
    if (!container) return found;

    Array.from(userEls).forEach((userEl) => {
      const anchor = getTopLevelChild(userEl, container);
      if (!anchor || seen.has(anchor)) return;
      seen.add(anchor);

      // Walk forward from the anchor to find the first non-user sibling with
      // meaningful text — that is the assistant response for this turn.
      let sibling = anchor.nextElementSibling;
      while (sibling) {
        if (
          sibling.matches(SELECTORS.userMessage) ||
          sibling.querySelector(SELECTORS.userMessage)
        ) {
          break; // Hit the next user turn; no response exists for this turn yet.
        }
        if (!seen.has(sibling)) {
          const contentEl =
            sibling.querySelector(SELECTORS.messageContent) || sibling;
          const text = extractTextContent(contentEl).trim();
          if (text) {
            seen.add(sibling);
            found.push(sibling);
            break;
          }
        }
        sibling = sibling.nextElementSibling;
      }
    });

    return found;
  }

  function extractByStructure() {
    const messages = [];
    const container =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector(SELECTORS.conversationContainer);
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
        index,
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
      // FIX: Strip query string. Claude.ai conversation identity is the path
      // (/chat/UUID). Original code appended parsed.search which can include
      // UTM or share parameters, breaking session resume across navigations.
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
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              hasNewContent = true;
              break;
            }
          }
        }
        // FIX: Removed unconditional characterData/childList branch. The original
        // code set hasNewContent=true for EVERY characterData mutation, which fires
        // on every streaming token (~10-50/sec). This caused continuous debounce
        // resets, preventing the settle timer from ever firing during long responses.
        // childList mutations on addedNodes (above) already cover structural changes.
        // characterData is only needed to detect in-place text edits, which Claude
        // does not use for message rendering — it appends new nodes during streaming.
      }
      if (hasNewContent) {
        callback();
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      // FIX: characterData removed — was firing thousands of times per response
      // during Claude's streaming, causing continuous debounce resets and
      // preventing processMessages from ever being called until streaming stopped
      // naturally. childList:true is sufficient for detecting new message nodes.
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
