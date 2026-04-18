var ChatGPTExtractor = (function () {
  "use strict";

  const PLATFORM = "chatgpt";

  const SELECTORS = {
    messageContainer: '[data-message-author-role]',
    userMessage: '[data-message-author-role="user"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    messageContent: '.markdown, .whitespace-pre-wrap, .text-message',
    inputArea: '#prompt-textarea, textarea[data-id="root"], textarea',
    sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
    conversationContainer: '[role="presentation"], main',
  };

  function isMatch(url) {
    return (
      url.includes("chatgpt.com") || url.includes("chat.openai.com")
    );
  }

  function extractAllMessages() {
    const messages = [];
    const elements = document.querySelectorAll(SELECTORS.messageContainer);

    elements.forEach((el, index) => {
      const role = el.getAttribute("data-message-author-role");
      const contentEl = el.querySelector(SELECTORS.messageContent) || el;
      const renderedText = extractTextContent(contentEl);

      if (renderedText.trim()) {
        messages.push({
          index: index,
          role: role === "user" ? "user" : "assistant",
          renderedText: renderedText.trim(),
          element: el,
          timestamp: new Date().toISOString(),
        });
      }
    });

    return messages;
  }

  function extractTextContent(element) {
    if (!element) return "";

    const clone = element.cloneNode(true);

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

    const lists = clone.querySelectorAll("li");
    lists.forEach((li) => {
      const parent = li.parentElement;
      const isOrdered = parent && parent.tagName === "OL";
      const idx = Array.from(parent?.children || []).indexOf(li) + 1;
      const prefix = isOrdered ? `${idx}. ` : "- ";
      li.textContent = prefix + (li.textContent || "").trim();
    });

    return clone.innerText || clone.textContent || "";
  }

  function getInputElement() {
    return document.querySelector(SELECTORS.inputArea);
  }

  function getThreadKey() {
    try {
      const parsed = new URL(window.location.href);
      // FIX: Strip query string. ChatGPT conversation identity is in the pathname
      // (/c/THREAD_ID). The original code appended parsed.search which could
      // include tracking or share parameters, producing a different threadKey
      // for the same conversation and breaking session resume.
      // The chatId extraction below is retained as a comment for reference but
      // parsed.origin + parsed.pathname is sufficient and unambiguous.
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
              if (
                node.matches?.(SELECTORS.messageContainer) ||
                node.querySelector?.(SELECTORS.messageContainer)
              ) {
                hasNewContent = true;
                break;
              }
            }
          }
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
