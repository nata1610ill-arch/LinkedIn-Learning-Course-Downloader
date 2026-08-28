// LinkedInRec content script — runs on every LinkedIn Learning page.
// Surfaces course/video context to the popup via the active tab's title + URL,
// which the background script already parses. We keep this script minimal so
// the LinkedIn page itself doesn't notice extra instrumentation.
//
// New: also handles PAGE_FETCH messages from the background script so the
// LinkedIn /learning-api/detailedCourses call happens from the page context.
// The page's fetch rides the same TLS/network path and cookie jar as the
// page itself, which avoids the anti-abuse 403 LinkedIn's edge applies to
// li_at-bearing requests replayed from the local Node server.

(() => {
  window.__linkedinrecReady = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') {
      sendResponse({ ok: false, error: 'bad message' });
      return false;
    }
    if (msg.type !== 'PAGE_FETCH_DETAILED_COURSES') {
      sendResponse({ ok: false, error: 'unknown content-script message type' });
      return false;
    }
    (async () => {
      try {
        const { courseSlug, videoSlug, resolution } = msg;
        if (!courseSlug || !videoSlug) {
          sendResponse({ ok: false, error: 'courseSlug and videoSlug required' });
          return;
        }
        const url = `/learning-api/detailedCourses?addParagraphsToTranscript=false&q=slugs&resolution=${encodeURIComponent(resolution || '_720')}&courseSlug=${encodeURIComponent(courseSlug)}&videoSlug=${encodeURIComponent(videoSlug)}`;
        // Same-origin relative URL — picks up linkedin.com cookies automatically.
        const r = await fetch(url, {
          credentials: 'include',
          headers: {
            accept: 'application/vnd.linkedin.normalized+json+2.1',
            'x-restli-protocol-version': '2.0.0',
            'x-li-lang': 'en_US',
          },
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        sendResponse({
          ok: r.ok,
          status: r.status,
          json,
          bodySnippet: text && text.length > 240 ? text.slice(0, 240) + '…' : text,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // keep the message channel open for the async response.
  });
})();