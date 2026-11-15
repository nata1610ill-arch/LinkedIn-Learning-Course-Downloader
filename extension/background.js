// LinkedInRec background service worker.
// Detects LinkedIn Learning pages, harvests auth cookies, and posts capture
// jobs to the local server on http://localhost:5177.

const SERVER = 'http://localhost:5177';

const LINKEDIN_COOKIE_DOMAIN = '.linkedin.com';
const IDENTITY_KEY = 'linkedinrec.xli';
const IDENTITY_MAX = 8192;

// Corporate/enterprise ("connected") accounts get a locked detailedCourses
// response — only the first videos of a course carry playback URLs, everything
// else comes back accessible:false — unless the request carries the account's
// `x-li-identity` header. The value is per session and each account has its
// own, so it is pasted once from DevTools and kept in storage.local (never
// synced, never sent anywhere except to linkedin.com).
// Rejects the mistakes that used to be invisible: a pasted "x-li-identity: …"
// line, a value with whitespace/line breaks, or an obviously wrong literal.
// Returns { value } or { error } with a message the popup can show.
function normalizeIdentity(raw) {
  const value = String(raw == null ? '' : raw).trim().replace(/^["']+|["']+$/g, '');
  if (!value) return { value: null };
  if (/\s/.test(value)) return { error: 'the value contains whitespace — paste only the header value, not "x-li-identity: …"' };
  if (!/^[\x21-\x7E]+$/.test(value)) return { error: 'the value contains non-ASCII characters — copy it again from the request headers' };
  if (!/[A-Za-z0-9]/.test(value)) return { error: 'the value has no letters or digits — that is not a header value' };
  if (/^(?:true|false|null|undefined|!0|!1)$/i.test(value)) return { error: 'that looks like a JavaScript literal, not the header value' };
  if (value.length < 8) return { error: `the value is too short (${value.length} chars) — copy the whole header value` };
  if (value.length > IDENTITY_MAX) return { error: `the value is too long (${value.length} chars, max ${IDENTITY_MAX})` };
  return { value };
}

async function readEnterpriseIdentity() {
  try {
    const bag = await chrome.storage.local.get(IDENTITY_KEY);
    const raw = bag && bag[IDENTITY_KEY];
    if (!raw || !String(raw).trim()) return { identity: null, problem: null };
    const normalized = normalizeIdentity(raw);
    if (normalized.error) return { identity: null, problem: `stored header rejected: ${normalized.error}` };
    return { identity: normalized.value, problem: null };
  } catch (e) {
    return { identity: null, problem: `could not read the saved header: ${e && e.message ? e.message : e}` };
  }
}

async function writeEnterpriseIdentity(raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) {
    await chrome.storage.local.remove(IDENTITY_KEY);
    return { ok: true, identity: null, cleared: true };
  }
  const normalized = normalizeIdentity(value);
  if (normalized.error) return { ok: false, error: normalized.error };
  await chrome.storage.local.set({ [IDENTITY_KEY]: normalized.value });
  return { ok: true, identity: normalized.value };
}

async function pingServer() {
  try {
    const res = await fetch(`${SERVER}/api/health`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

// Ask the active LinkedIn Learning tab to perform the /learning-api/detailedCourses
// fetch from the page context. The page's fetch rides the same TLS/network path
// and cookie jar as the page itself — LinkedIn's edge can't fingerprint it as
// out-of-band. We fall back to the server-side path if no LinkedIn tab is open
// (e.g. captures triggered programmatically).
async function fetchDetailedCoursesFromActiveTab({ courseSlug, videoSlug, resolution, account, csrfToken, enterpriseIdentity }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/linkedin\.com\/learning/.test(tab.url)) {
    return { ok: false, error: 'no active linkedin.com/learning tab' };
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'PAGE_FETCH_DETAILED_COURSES',
      courseSlug,
      videoSlug,
      resolution,
      account,
      csrfToken,
      enterpriseIdentity,
    });
    return resp;
  } catch (e) {
    return { ok: false, error: `content-script unreachable: ${String(e && e.message || e)}` };
  }
}

async function readLinkedInCookies() {
  // Query cookies for linkedin.com: try specific url first, fallback to broad domain.
  let all = [];
  try {
    all = await chrome.cookies.getAll({ url: 'https://www.linkedin.com' });
  } catch {}
  if (!all || !all.length) {
    try {
      all = await chrome.cookies.getAll({ domain: 'linkedin.com' });
    } catch {}
  }
  const map = {};
  for (const c of all) {
    if (c.name === 'li_at' || c.name === 'JSESSIONID') {
      const val = c.value ? String(c.value).replace(/^"|"$/g, '') : '';
      // Prefer host-specific (www.linkedin.com) or exact match over generic subdomain
      if (!map[c.name] || (c.domain && c.domain.startsWith('www.'))) {
        map[c.name] = val;
      }
    }
  }
  return map;
}

function parseLearningUrl(url) {
  // https://www.linkedin.com/learning/<courseSlug>/<videoSlug>
  // https://www.linkedin.com/learning/<courseSlug>             (course root)
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('linkedin.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'learning') return null;
    const courseSlug = parts[1] || null;
    const videoSlug = parts[2] || null;
    const account = u.searchParams.get('u') || u.searchParams.get('account') || null;
    return {
      courseSlug,
      videoSlug,
      account,
      isCourseRoot: !!courseSlug && !videoSlug,
      isVideo: !!courseSlug && !!videoSlug,
    };
  } catch {
    return null;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function captureActiveVideo() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'no active tab' };
  const parsed = parseLearningUrl(tab.url || '');
  if (!parsed || !parsed.isVideo) {
    return { ok: false, error: 'active tab is not a LinkedIn Learning video page' };
  }
  const cookies = await readLinkedInCookies();
  if (!cookies.li_at) {
    return { ok: false, error: 'no li_at cookie — log into linkedin.com in this browser first' };
  }
  const title = tab.title || '';
  // Fetch the API response from inside the active tab so the page's own
  // cookies/network/TLS fingerprint are used. Forward the resulting JSON to
  // the local server so it only has to download + remux the MP4.
  const upstream = await fetchDetailedCoursesFromActiveTab({
    courseSlug: parsed.courseSlug,
    videoSlug: parsed.videoSlug,
    resolution: '_1080',
    account: parsed.account,
    csrfToken: cookies && cookies.JSESSIONID,
    enterpriseIdentity: (await readEnterpriseIdentity()).identity,
  });
  if (!upstream || !upstream.ok) {
    return {
      ok: false,
      upstreamError: upstream && upstream.error ? upstream.error : 'page-side fetch failed',
      error: upstream && upstream.error ? upstream.error : 'page-side fetch failed',
      upstreamStatus: upstream && upstream.status,
    };
  }
  const resp = await fetch(`${SERVER}/api/learning/capture`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-linkedinrec-client': 'extension',
    },
    body: JSON.stringify({
      courseSlug: parsed.courseSlug,
      videoSlug: parsed.videoSlug,
      cookies,
      courseTitle: parsed.courseSlug,
      videoTitle: title.replace(/\s*\|\s*LinkedIn Learning.*$/i, '').trim() || parsed.videoSlug,
      chapterTitle: 'Course',
      upstreamJson: upstream.json,
      upstreamStatus: upstream.status,
      upstreamBodySnippet: upstream.bodySnippet,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  // Always surface the upstream diagnostics in the popup result, even on
  // success — makes it easy to verify the page-side fetch worked.
  return {
    ok: !!json.ok,
    job: json.job,
    error: json.error,
    upstreamStatus: upstream.status,
    upstreamBodySnippet: upstream.bodySnippet,
  };
}

// Open the course walk in a dedicated extension page instead of running it
// here. Chrome hard-terminates an MV3 service worker when a single event
// handler runs longer than 5 minutes, which silently truncated any course that
// took longer than that — no error, no resume, just missing videos. An
// extension page in a tab has no lifetime cap, so runner.js owns the loop and
// checkpoints its progress to chrome.storage.local. See extension/runner.js.
async function captureEntireCourse() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'no active tab' };
  const parsed = parseLearningUrl(tab.url || '');
  if (!parsed || !parsed.courseSlug) {
    return { ok: false, error: 'active tab is not a LinkedIn Learning course page' };
  }
  const cookies = await readLinkedInCookies();
  if (!cookies.li_at) {
    return { ok: false, error: 'no li_at cookie — log into linkedin.com in this browser first' };
  }
  const accountQuery = parsed.account ? `&u=${encodeURIComponent(parsed.account)}` : '';
  const identity = (await readEnterpriseIdentity()).identity;
  const identityQuery = identity ? `&identity=${encodeURIComponent(identity)}` : '';
  const runnerUrl = chrome.runtime.getURL(
    `runner.html?course=${encodeURIComponent(parsed.courseSlug)}${accountQuery}${identityQuery}`,
  );
  // Reuse an existing runner tab for this course if one is already open, so a
  // double-click doesn't start two competing walks. Filter in code — passing a
  // match-pattern glob to chrome.tabs.query({url:...}) is brittle across
  // Chrome versions and isn't worth the runtime dependency for a list of ≤ a
  // handful of tabs.
  const allTabs = await chrome.tabs.query({});
  const courseMarker = `course=${encodeURIComponent(parsed.courseSlug)}`;
  const match = allTabs.find((t) => t.url && t.url.includes('runner.html') && t.url.includes(courseMarker));
  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    return { ok: true, runner: 'existing', tabId: match.id, courseSlug: parsed.courseSlug };
  }
  const created = await chrome.tabs.create({ url: runnerUrl, active: true });
  return { ok: true, runner: 'opened', tabId: created.id, courseSlug: parsed.courseSlug };
}

async function listCourses() {
  // For the popup's dropdown: list the most recently captured course slugs
  // we know about. The server already knows about whatever is on disk; the
  // popup will fetch /api/jobs to show recent jobs.
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== 'object') {
        sendResponse({ ok: false, error: 'bad message' });
        return;
      }
      switch (msg.type) {
        case 'PING_SERVER':
          sendResponse({ ok: await pingServer() });
          return;
        case 'GET_COOKIES':
          sendResponse({ ok: true, cookies: await readLinkedInCookies() });
          return;
        case 'GET_IDENTITY': {
          const state = await readEnterpriseIdentity();
          sendResponse({ ok: true, identity: state.identity, problem: state.problem });
          return;
        }
        case 'SET_IDENTITY':
          sendResponse(await writeEnterpriseIdentity(msg.value));
          return;
        case 'PARSE_URL': {
          const parsed = parseLearningUrl(msg.url || '');
          sendResponse({ ok: !!parsed, parsed });
          return;
        }
        case 'CAPTURE_VIDEO':
          sendResponse(await captureActiveVideo());
          return;
        case 'CAPTURE_COURSE':
          sendResponse(await captureEntireCourse());
          return;
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
