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
        const headers = {
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
        };

        // LinkedIn's SPA returns `data: {paging, *elements: [...]}` with empty
        // elements for the first ~1-3 seconds after navigation while React
        // hydrates. The walk used to fire this fetch once, get an empty payload,
        // and silently skip the video. Retry up to 5 times with a 600ms gap
        // until the payload actually contains the video node — a real page fetch
        // from a fully-loaded tab returns metadata on the first try, so the
        // loop only fires on genuinely half-hydrated pages.
        const MAX_ATTEMPTS = 5;
        const RETRY_DELAY_MS = 600;
        let r = null, text = null, json = null, attempt = 0;
        for (attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          r = await fetch(url, { credentials: 'include', headers });
          text = await r.text();
          json = null;
          try { json = JSON.parse(text); } catch { /* leave null */ }
          // Stop retrying if the page returned a real payload, i.e. one of:
          // - the new JSON:API shape has elements or included populated
          // - the legacy shape has elements populated
          const hasPayload =
            (json && Array.isArray(json.included) && json.included.length > 0) ||
            (json && Array.isArray(json.elements) && json.elements.length > 0);
          if (r.ok && hasPayload) break;
          if (!r.ok) break; // non-2xx won't fix itself by retrying
          await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
        }
        sendResponse({
          ok: r && r.ok,
          status: r ? r.status : 0,
          json,
          bodySnippet: text && text.length > 240 ? text.slice(0, 240) + '…' : text,
          attempts: attempt + 1,
        });
      } catch (e) {
        const message = e && e.message ? e.message : (typeof e === 'string' ? e : 'fetch threw (no message)');
        sendResponse({ ok: false, error: message, name: e && e.name });
      }
    })();
    return true; // keep the message channel open for the async response.
  });
})();