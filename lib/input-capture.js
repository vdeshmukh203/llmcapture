var InputCapture = (function () {
  "use strict";

  let _lastRawInput = null;
  let _inputHistory = [];
  let _observers = [];
  let _initialized = false;

  function init() {
    if (_initialized) return;
    _initialized = true;

    document.addEventListener("keydown", handleKeydown, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("paste", handlePaste, true);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            attachToInputs(node);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    attachToInputs(document.body);
  }

  function attachToInputs(root) {
    const inputs = root.querySelectorAll
      ? root.querySelectorAll(
          'textarea, [contenteditable="true"], [role="textbox"]'
        )
      : [];
    inputs.forEach((el) => {
      if (!el._aicapAttached) {
        el._aicapAttached = true;
        el.addEventListener("input", handleInput, true);
        el.addEventListener("keydown", handleKeydown, true);
      }
    });
  }

  function handleInput(e) {
    const target = e.target;
    if (!target) return;

    let value = "";
    if (
      target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT"
    ) {
      value = target.value;
    } else if (
      target.getAttribute("contenteditable") === "true" ||
      target.getAttribute("role") === "textbox"
    ) {
      value = target.innerText || target.textContent || "";
    }

    if (value.trim()) {
      _lastRawInput = {
        text: value,
        timestamp: new Date().toISOString(),
        source: "input_event",
        element: target.tagName.toLowerCase(),
      };
    }
  }

  function handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (_lastRawInput && _lastRawInput.text.trim()) {
        _inputHistory.push({ ..._lastRawInput, submittedAt: new Date().toISOString() });
        if (_inputHistory.length > 200) {
          _inputHistory = _inputHistory.slice(-100);
        }
      }
    }
  }

  function handlePaste(e) {
    const pastedText = e.clipboardData
      ? e.clipboardData.getData("text/plain")
      : "";
    if (pastedText.trim()) {
      _lastRawInput = {
        text: pastedText,
        timestamp: new Date().toISOString(),
        source: "paste_event",
        element: e.target ? e.target.tagName.toLowerCase() : "unknown",
      };
    }
  }

  function getLastRawInput() {
    return _lastRawInput;
  }

  function consumeLastRawInput() {
    const input = _lastRawInput;
    _lastRawInput = null;
    return input;
  }

  function getInputHistory() {
    return [..._inputHistory];
  }

  function findMatchingRawInput(renderedText) {
    if (!renderedText) return null;

    const normalizedRendered = renderedText.trim().toLowerCase();

    for (let i = _inputHistory.length - 1; i >= 0; i--) {
      const entry = _inputHistory[i];
      const normalizedRaw = entry.text.trim().toLowerCase();

      if (normalizedRaw === normalizedRendered) {
        return entry;
      }

      if (
        normalizedRendered.includes(normalizedRaw) ||
        normalizedRaw.includes(normalizedRendered)
      ) {
        return entry;
      }

      if (normalizedRaw.length > 20) {
        const similarity = computeSimilarity(normalizedRaw, normalizedRendered);
        if (similarity > 0.85) {
          return entry;
        }
      }
    }

    return null;
  }

  function computeSimilarity(a, b) {
    if (a === b) return 1.0;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;

    let matches = 0;
    const windowSize = Math.min(3, shorter.length);
    for (let i = 0; i <= shorter.length - windowSize; i++) {
      const substr = shorter.substring(i, i + windowSize);
      if (longer.includes(substr)) matches++;
    }
    const possible = shorter.length - windowSize + 1;
    return possible > 0 ? matches / possible : 0;
  }

  return {
    init,
    getLastRawInput,
    consumeLastRawInput,
    getInputHistory,
    findMatchingRawInput,
  };
})();
