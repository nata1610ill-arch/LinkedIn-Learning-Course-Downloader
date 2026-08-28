// LinkedInRec background service worker.
// Detects LinkedIn Learning pages, harvests auth cookies, and posts capture
// jobs to the local server on http://localhost:5177.

const SERVER = 'http://localhost:5177';

const LINKEDIN_COOKIE_DOMAIN = '.linkedin.com';

async function pingServer() {
  try {
    const res = await fetch(`${SERVER}/api/health`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

async function readLinkedInCookies() {
  // chrome.cookies.getAll with domain = '.linkedin.com' returns every cookie
  // visible to the extension. We only need li_at + JSESSIONID; everything else
  // is ignored.
  const all = await chrome.cookies.getAll({ domain: LINKEDIN_COOKIE_DOMAIN });
  const map = {};
  for (const c of all) {
    if (c.name === 'li_at' || c.name === 'JSESSIONID') {
      map[c.name] = c.value;
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
    return {
      courseSlug,
      videoSlug,
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
    }),
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: !!json.ok, job: json.job, error: json.error };
}

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
  const resp = await fetch(`${SERVER}/api/learning/capture-all`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-linkedinrec-client': 'extension',
    },
    body: JSON.stringify({
      courseSlug: parsed.courseSlug,
      cookies,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: !!json.ok, course: json.course, results: json.results, error: json.error };
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
