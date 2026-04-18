chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SESSION_STARTED") {
    console.log(
      `[AI Chat Capture] Session started: ${message.sessionId} on ${message.platform}`
    );
    updateBadge(sender.tab?.id, "ON");
  }

  if (message.type === "ENTRY_ADDED") {
    console.log(
      `[AI Chat Capture] Turn ${message.turn} (${message.role}): ${message.textPreview}${message.hasRawInput ? " [+raw]" : ""}`
    );
    updateBadge(sender.tab?.id, String(message.chainPosition || message.turn), "#10b981");
  }

  if (message.type === "SESSION_LOCKED") {
    console.log(
      `[AI Chat Capture] Session locked: ${message.sessionId} (${message.reason})`
    );
    updateBadge(sender.tab?.id, "50", "#f59e0b");
  }
});

function updateBadge(tabId, text, color) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text: text, tabId: tabId });
  chrome.action.setBadgeBackgroundColor({ color: color || "#10b981", tabId: tabId });
}

chrome.action.onClicked.addListener((tab) => {});
