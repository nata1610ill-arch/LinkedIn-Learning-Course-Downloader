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

// Ask the active LinkedIn Learning tab to perform the /learning-api/detailedCourses
// fetch from the page context. The page's fetch rides the same TLS/network path
// and cookie jar as the page itself — LinkedIn's edge can't fingerprint it as
// out-of-band. We fall back to the server-side path if no LinkedIn tab is open
// (e.g. captures triggered programmatically).
async function fetchDetailedCoursesFromActiveTab({ courseSlug, videoSlug, resolution }) {
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
    });
    return resp;
  } catch (e) {
    return { ok: false, error: `content-script unreachable: ${String(e && e.message || e)}` };
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
  // Fetch the API response from inside the active tab so the page's own
  // cookies/network/TLS fingerprint are used. Forward the resulting JSON to
  // the local server so it only has to download + remux the MP4.
  const upstream = await fetchDetailedCoursesFromActiveTab({
    courseSlug: parsed.courseSlug,
    videoSlug: parsed.videoSlug,
    resolution: '_1080',
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
  // Ask the local server for the curriculum (it scrapes LinkedIn's HTML
  // for the ld+json chapter list — that doesn't need /learning-api/).
  const enumResp = await fetch(`${SERVER}/api/learning/course/${encodeURIComponent(parsed.courseSlug)}`);
  if (!enumResp.ok) {
    return { ok: false, error: `enumerate failed (${enumResp.status})` };
  }
  const course = await enumResp.json().catch(() => ({}));
  if (!Array.isArray(course.videos) || !course.videos.length) {
    return { ok: false, error: 'no videos in curriculum' };
  }
  const results = [];
  for (let i = 0; i < course.videos.length; i++) {
    const v = course.videos[i];
    const videoUrl = `https://www.linkedin.com/learning/${parsed.courseSlug}/${v.slug}`;
    let openedTabId = null;
    let upstream = null;
    try {
      // Open the video in a background tab so the content script registers.
      // We use the chrome.tabs API to avoid stealing the user's active tab.
      const created = await chrome.tabs.create({ url: videoUrl, active: false });
      openedTabId = created.id;
      // Wait until the tab is fully loaded — the content script only
      // registers on document_idle.
      await waitForTabComplete(openedTabId);
      // Give the content script a beat to attach its message listener.
      await sleep(800);
      upstream = await fetchDetailedCoursesFromTab(openedTabId, {
        courseSlug: parsed.courseSlug,
        videoSlug: v.slug,
        resolution: '_1080',
      });
    } catch (e) {
      upstream = { ok: false, error: `tab workflow failed: ${String(e && e.message || e)}` };
    } finally {
      if (openedTabId != null) {
        try { await chrome.tabs.remove(openedTabId); } catch {}
      }
    }
    if (!upstream || !upstream.ok) {
      results.push({ slug: v.slug, title: v.title, status: 'failed', error: (upstream && upstream.error) || 'no upstream' });
      if (upstream && /40[13]/.test(String(upstream.status || ''))) {
        // auth-shaped failure mid-batch: abort.
        break;
      }
      continue;
    }
    // Forward to the server with upstreamJson so the server skips its own
    // LinkedIn fetch (which would hit the same li_at TLS-abort issue).
    const captureResp = await fetch(`${SERVER}/api/learning/capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-linkedinrec-client': 'extension',
      },
      body: JSON.stringify({
        courseSlug: parsed.courseSlug,
        videoSlug: v.slug,
        cookies,
        courseTitle: course.courseTitle || parsed.courseSlug,
        chapterTitle: v.chapterTitle || 'Course',
        videoTitle: v.title || v.slug,
        index: i + 1,
        total: course.videos.length,
        upstreamJson: upstream.json,
        upstreamStatus: upstream.status,
        upstreamBodySnippet: upstream.bodySnippet,
      }),
    });
    const captureJson = await captureResp.json().catch(() => ({}));
    const job = captureJson.job || {};
    results.push({
      slug: v.slug,
      title: v.title,
      status: job.status,
      file: job.file,
      error: job.error,
    });
    if (job.status === 'failed' && job.error && /401|403/.test(job.error)) {
      break;
    }
  }
  return { ok: true, course: course.courseTitle, results };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'tab gone'));
          return;
        }
        if (t.status === 'complete') {
          resolve(t);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('tab load timeout'));
          return;
        }
        sleep(250).then(check);
      });
    };
    check();
  });
}

async function fetchDetailedCoursesFromTab(tabId, { courseSlug, videoSlug, resolution }) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'PAGE_FETCH_DETAILED_COURSES',
      courseSlug,
      videoSlug,
      resolution,
    });
  } catch (e) {
    return { ok: false, error: `content-script unreachable: ${String(e && e.message || e)}` };
  }
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
