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

  // Bumped together with manifest.json. The runner refuses to walk when the
  // injected content script does not match, because Chrome keeps serving the
  // snapshot from the last "Reload" on chrome://extensions — which silently
  // reintroduces bugs the runner has already been fixed for.
  const BUILD = '1.0.17';

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
        const { courseSlug, videoSlug, resolution, account, enterpriseIdentity: initialEnterpriseIdentity } = msg;
        if (!courseSlug || !videoSlug) {
          sendResponse({ ok: false, error: 'courseSlug and videoSlug required' });
          return;
        }
        const effectiveAccount = account ||
          new URLSearchParams(location.search).get('u') ||
          new URLSearchParams(location.search).get('account') ||
          null;
        const accountParam = effectiveAccount ? `&u=${encodeURIComponent(effectiveAccount)}` : '';
        const baseUrl = `/learning-api/detailedCourses?addParagraphsToTranscript=false&q=slugs&resolution=${encodeURIComponent(resolution || '_720')}&courseSlug=${encodeURIComponent(courseSlug)}&videoSlug=${encodeURIComponent(videoSlug)}`;
        const url = `${baseUrl}${accountParam}`;
        function csrfTokenFromPage() {
          // document.cookie carries the same session cookie Chrome sends with
          // credentials: 'include' — but only while JSESSIONID is readable by
          // JavaScript. An empty token makes LinkedIn answer 403 "CSRF check
          // failed." for every request, so it is never sent as an empty header.
          if (typeof document !== 'undefined' && document.cookie) {
            const m = document.cookie.match(/(?:^|;\s*)JSESSIONID=(?:"([^"]*)"|([^;]*))/);
            if (m) {
              const val = (m[1] !== undefined ? m[1] : m[2] || '').trim().replace(/^"|"$/g, '');
              if (val) return val;
            }
          }
          return '';
        }

        function csrfTokenFromMessage() {
          // The cookies API (background/runner) can read httpOnly cookies, so it
          // still has a usable token when document.cookie does not expose one.
          if (msg && msg.csrfToken) {
            return String(msg.csrfToken).trim().replace(/^"|"$/g, '');
          }
          return '';
        }

        function extractCsrfToken() {
          return csrfTokenFromPage() || csrfTokenFromMessage();
        }

        // A wrong `x-li-identity` header makes LinkedIn answer every
        // /learning-api/ request with 403 "CSRF check failed.", so only ever
        // send an identity we are confident about. 1.0.11 scraped the value out
        // of the whole page HTML with a loose pattern; on a personal
        // (non-enterprise) account that matched JavaScript fragments such as
        // `!0`, and every page-side fetch was rejected.
        // Corporate tokens are long opaque strings (they legitimately contain
        // '=', '/', '+', '.', ':'), so the accepted set is deliberately broad:
        // printable ASCII on a single line, at least 8 and up to 8192 chars.
        // A 2048-char cap silently dropped real tokens while the popup happily
        // reported "set (…)", which looked exactly like "no header sent".
        function identityLooksSane(value) {
          if (!value) return false;
          if (!/^[\x21-\x7E]{8,8192}$/.test(value)) return false;
          if (!/[A-Za-z0-9]/.test(value)) return false;
          return !/^(?:true|false|null|undefined|!0|!1)$/i.test(value);
        }

        function sanitizeIdentity(value) {
          const raw = String(value == null ? '' : value).trim().replace(/^["']+|["']+$/g, '');
          return identityLooksSane(raw) ? raw : null;
        }

        // The page source carries the corporate identity under
        // `enterpriseProfileHash` (the route llvd documents as "Method 2") — that
        // is the same string the site sends as `x-li-identity`. Looking for that
        // key is far less ambiguous than hunting for the header name, which is
        // how 1.0.11 ended up sending the JavaScript literal `!0`. Page source
        // HTML-escapes '=' as `&#61;`, so the capture allows entities and they
        // are decoded before validation.
        function decodeHtmlEntities(value) {
          return String(value)
            .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)))
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
        }

        // The page advertises more than one enterprise identity value and the SPA
        // does not reveal which one it puts in `x-li-identity`, so every plausible
        // candidate is collected (in order of confidence) and the request loop
        // tries them until LinkedIn answers with playback URLs. The whole HTML is
        // entity-decoded first: page source escapes '=' as `&#61;` and quotes as
        // `&quot;`, which used to shift the captured value by a few characters.
        function identitiesFromPageHtml() {
          if (typeof document === 'undefined' || !document.documentElement) return [];
          const html = decodeHtmlEntities(document.documentElement.innerHTML || '');
          const out = [];
          const push = (value, label) => {
            const clean = sanitizeIdentity(value);
            if (clean) out.push({ value: clean, label });
          };
          const valueRe = (key) => new RegExp(
            `\\b${key}["']?\\s*[:=]\\s*["']?([A-Za-z0-9_\\-.:,()\\[\\]=/+]{8,600})`, 'g',
          );
          // llvd documents `enterpriseProfileHash` as the x-li-identity value; the
          // other two appear in the same InitialContext block.
          for (const m of html.matchAll(valueRe('enterpriseProfileHash'))) push(m[1], 'page:enterpriseProfileHash');
          for (const m of html.matchAll(valueRe('enterpriseIdentityHash'))) push(m[1], 'page:enterpriseIdentityHash');
          for (const m of html.matchAll(valueRe('identityToken'))) push(m[1], 'page:identityToken');
          for (const m of html.matchAll(/["']?x-li-identity["']?\s*[:=]\s*["']?([A-Za-z0-9_\-.:,()\[\]=\/+]{8,2048})/gi)) {
            push(m[1], 'page:header');
          }
          return out;
        }

        // The header the user saved in the popup. Read straight from storage so a
        // saved value applies to the very next video — even in a runner tab that
        // was opened before the value was saved, and on a resumed walk whose
        // checkpoint predates it. A stored value that fails validation is
        // reported, not silently ignored: "identity=no" with no reason was
        // indistinguishable from "nothing saved" during diagnosis.
        async function readStoredIdentity() {
          try {
            if (!chrome || !chrome.storage || !chrome.storage.local) {
              return { identity: null, problem: 'chrome.storage is unavailable in this context' };
            }
            const bag = await chrome.storage.local.get('linkedinrec.xli');
            const raw = bag && bag['linkedinrec.xli'];
            if (!raw) return { identity: null, problem: null };
            const value = sanitizeIdentity(raw);
            if (!value) {
              return { identity: null, problem: `saved header rejected (${String(raw).length} chars)` };
            }
            return { identity: value, problem: null };
          } catch (e) {
            return { identity: null, problem: `storage read failed: ${e && e.message ? e.message : e}` };
          }
        }

        const storedIdentity = await readStoredIdentity();
        const identityProblem = storedIdentity.problem;
        const identityCandidates = [];
        const addCandidate = (value, label) => {
          const clean = sanitizeIdentity(value);
          if (!clean) return;
          if (identityCandidates.some((c) => c.value === clean)) return;
          identityCandidates.push({ value: clean, label });
        };
        // A value the user pasted stays authoritative; the page is the fallback.
        addCandidate(storedIdentity.identity, 'storage');
        addCandidate(initialEnterpriseIdentity, 'runner');
        for (const candidate of identitiesFromPageHtml()) addCandidate(candidate.value, candidate.label);

        // Same-origin relative URL — picks up linkedin.com cookies automatically.
        // We send the modern browser fetch-metadata headers LinkedIn's edge
        // expects for XHRs from a real Chrome tab.
        const headers = {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
          'csrf-token': extractCsrfToken(),
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
        // Try the richest request first and fall back to the plain one that is
        // known to work for personal accounts:
        //   identity + enterprise account → same URL without identity →
        //   without identity and without the `u` account parameter.
        // A non-2xx moves to the NEXT variant instead of retrying the same
        // rejected headers, which is what made 1.0.11 fail on the first video.
        const variants = [];
        for (const candidate of identityCandidates) {
          // Each identity is tried with and without the optional `u` account
          // parameter before falling back to a request with no identity at all.
          variants.push({ url, identity: candidate.value, label: candidate.label });
          if (accountParam) variants.push({ url: baseUrl, identity: candidate.value, label: candidate.label });
        }
        variants.push({ url, identity: null, label: 'none' });
        if (accountParam) variants.push({ url: baseUrl, identity: null, label: 'none' });

        const MAX_PAYLOAD_ATTEMPTS = 3;
        const RETRY_DELAY_MS = 600;
        let r = null, text = null, json = null, attempt = 0, usedVariant = null;
        let usedTokenSource = null, fetchCount = 0;

        // Stop retrying if the page returned a real payload, i.e. one of:
        // - the new JSON:API shape has included populated
        // - the legacy shape has elements populated
        const hasVideoPayload = (body) =>
          (body && Array.isArray(body.included) && body.included.length > 0) ||
          (body && Array.isArray(body.elements) && body.elements.length > 0);

        // Two passes over the same variants: the first reads the CSRF token from
        // document.cookie (what worked historically), the second reads it through
        // the cookies API. If LinkedIn ever hides JSESSIONID as httpOnly, the page
        // token is empty and every request would fail with 403 CSRF, with no
        // other visible symptom.
        for (const tokenSource of ['page', 'message']) {
          for (const variant of variants) {
            usedVariant = variant;
            usedTokenSource = tokenSource;
            for (attempt = 0; attempt < MAX_PAYLOAD_ATTEMPTS; attempt++) {
              const token = tokenSource === 'message' ? csrfTokenFromMessage() : csrfTokenFromPage();
              if (!token) break; // this source has no token — try the next one
              const attemptHeaders = { ...headers, 'csrf-token': token };
              if (variant.identity) attemptHeaders['x-li-identity'] = variant.identity;
              fetchCount += 1;
              r = await fetch(variant.url, { credentials: 'include', headers: attemptHeaders });
              text = await r.text();
              json = null;
              try { json = JSON.parse(text); } catch { /* leave null */ }
              if (r.ok && hasVideoPayload(json)) break;
              if (!r.ok) break; // non-2xx: next variant, don't hammer the same headers
              await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
            }
            if (r && r.ok && hasVideoPayload(json)) break;
          }
          if (r && r.ok && hasVideoPayload(json)) break;
        }
        const result = {
          ok: !!(r && r.ok),
          build: BUILD,
          status: r ? r.status : 0,
          json,
          account: effectiveAccount,
          // Only ever report an identity that was actually accepted, so the
          // runner never persists a scraped fragment as the session identity.
          enterpriseIdentity: (usedVariant && usedVariant.identity) || null,
          usedEnterpriseIdentity: !!(usedVariant && usedVariant.identity),
          identitySource: (usedVariant && usedVariant.identity) ? (usedVariant.label || 'page') : 'none',
          identityCandidates: identityCandidates.length,
          identityProblem,
          tokenSource: usedTokenSource,
          fetchCount,
          bodySnippet: text && text.length > 240 ? text.slice(0, 240) + '…' : text,
          attempts: attempt + 1,
        };
        if (!r) {
          // No request was attempted because there was no CSRF token at all.
          // Say so, instead of letting it look like a generic network failure.
          result.error = 'no CSRF token available — JSESSIONID is missing or unreadable; re-open linkedin.com/learning and reload the extension';
        }
        sendResponse(result);
      } catch (e) {
        const message = e && e.message ? e.message : (typeof e === 'string' ? e : 'fetch threw (no message)');
        sendResponse({ ok: false, error: message, name: e && e.name });
      }
    })();
    return true; // keep the message channel open for the async response.
  });
})();
