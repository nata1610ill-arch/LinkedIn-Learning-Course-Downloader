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
    // Fire the fetch without awaiting it here — the listener must return true
    // synchronously to keep the message channel open in MV3. The async work
    // resolves later via sendResponse().
    (async () => {
      try {
        const { courseSlug, videoSlug, resolution } = msg;
        if (!courseSlug || !videoSlug) {
          sendResponse({ ok: false, error: 'courseSlug and videoSlug required' });
          return;
        }
        const url = `/learning-api/detailedCourses?addParagraphsToTranscript=false&q=slugs&resolution=${encodeURIComponent(resolution || '_720')}&courseSlug=${encodeURIComponent(courseSlug)}&videoSlug=${encodeURIComponent(videoSlug)}`;
        // Same-origin relative URL — picks up linkedin.com cookies automatically.
        // We send the modern browser fetch-metadata headers LinkedIn's edge
        // expects for XHRs from a real Chrome tab.
        const r = await fetch(url, {
          credentials: 'include',
          headers: {
            accept: 'application/vnd.linkedin.normalized+json+2.1',
            'x-restli-protocol-version': '2.0.0',
            'x-li-lang': 'en_US',
            'csrf-token': (() => {
              const m = document.cookie.match(/(?:^|;\s*)JSESSIONID="?([^";]+)/);
              return m ? m[1] : '';
            })(),
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            referer: location.href,
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
        const message = e && e.message ? e.message : (typeof e === 'string' ? e : 'fetch threw (no message)');
        sendResponse({ ok: false, error: message, name: e && e.name });
      }
    })();
    return true; // keep the message channel open for the async response.
  });
})();