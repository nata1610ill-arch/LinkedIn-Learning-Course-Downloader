// LinkedInRec content script — runs on every LinkedIn Learning page.
// Surfaces course/video context to the popup via the active tab's title + URL,
// which the background script already parses. We keep this script minimal so
// the LinkedIn page itself doesn't notice extra instrumentation.

(() => {
  // Tiny heartbeat so the popup can confirm the content script is alive in
  // the active tab. No DOM mutation, no event listeners attached.
  window.__linkedinrecReady = true;
})();
