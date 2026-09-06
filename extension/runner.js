// LinkedInRec course-walk runner.
//
// Why this file exists: the walk used to live inside the MV3 service worker's
// chrome.runtime.onMessage handler. Chrome hard-terminates a service worker
// when a single event handler runs longer than 5 minutes, so any course that
// took longer than that was silently truncated mid-walk — no error, no resume,
// just missing videos. An extension page running in a tab has no such lifetime
// cap, so the loop lives here instead. The service worker only spawns this tab.
//
// Progress is checkpointed to chrome.storage.local after every video, so
// closing this tab costs at most the video in flight.

const SERVER = 'http://localhost:5177';
const STORAGE_KEY = 'linkedinrec.walk';
const CONTENT_SCRIPT_SETTLE_MS = 800;
const CONTENT_SCRIPT_READY_TIMEOUT_MS = 8000;
const PAGE_FETCH_TIMEOUT_MS = 15000;
// Pacing between walk iterations. Persistent-tab strategy mostly avoids 429s,
// but if one slips through, the video-level retry below (RATE_LIMIT_RETRY_*)
// takes care of it. This delay stays small.
const DEFAULT_INTER_VIDEO_DELAY_MS = 1500;
// Per-video retry policy when the page-side fetch returns 429. We DO NOT
// advance past the failing video — instead we wait and try the same video
// again. LinkedIn's edge lifts the throttle after a short pause, and the
// server's "already on disk" check makes each successful retry free. This
// is the key change that turns the gap (silent skip) into a wait-and-retry.
// Capped by attempt count (deterministic, harness-friendly) — at production
// pacing this is ~3 minutes of real wall-clock time before giving up.
const RATE_LIMIT_RETRY_DELAYS_MS = [15000, 30000, 60000]; // 15s, 30s, 60s
const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 4;

const els = {
  status: document.getElementById('status'),
  course: document.getElementById('course'),
  progress: document.getElementById('progress'),
  current: document.getElementById('current'),
  items: document.getElementById('items'),
  stop: document.getElementById('stop'),
  reset: document.getElementById('reset'),
  resolution: document.getElementById('resolution'),
};

const ALLOWED_RESOLUTIONS = ['_1080', '_720', '_540'];
let stopRequested = false;
let activeResolution = '_1080';

function setBadge(text, cls) {
  els.status.textContent = text;
  els.status.classList.remove('ok', 'warn', 'error');
  if (cls) els.status.classList.add(cls);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// checkpoint state
// ---------------------------------------------------------------------------

async function loadCheckpoint(courseSlug) {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const saved = bag[STORAGE_KEY];
  if (!saved || saved.courseSlug !== courseSlug) return null;
  if (!Array.isArray(saved.videos) || !saved.videos.length) return null;
  return saved;
}

async function saveCheckpoint(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function clearCheckpoint() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// tab plumbing (moved verbatim in behaviour from background.js)
// ---------------------------------------------------------------------------

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
    const resp = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: 'PAGE_FETCH_DETAILED_COURSES',
        courseSlug,
        videoSlug,
        resolution,
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`page-fetch timeout after ${PAGE_FETCH_TIMEOUT_MS}ms`)),
        PAGE_FETCH_TIMEOUT_MS,
      )),
    ]);
    return resp;
  } catch (e) {
    return { ok: false, error: `content-script unreachable: ${String(e && e.message || e)}` };
  }
}

// Wait for the content script in `tabId` to have booted (sets window.__linkedinrecReady).
// Returns true if ready, false if we hit the timeout. Without this, sendMessage races the
// content-script attach and silently loses — the walk then skips the video with no log line,
// which is exactly the silent-skip symptom this method was added to fix.
async function waitForContentScriptReady(tabId, timeoutMs = CONTENT_SCRIPT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => Boolean(window.__linkedinrecReady),
      });
      if (results && results[0] && results[0].result === true) return true;
    } catch {
      // The tab may still be navigating; ignore and retry.
    }
    await sleep(250);
  }
  return false;
}

// The content script only registers at document_idle. If the tab was already
// open when the extension reloaded, the listener is gone and sendMessage
// fails — force a re-injection and retry once before giving up.
async function pageFetchWithReinject(tabId, params) {
  const ready = await waitForContentScriptReady(tabId);
  if (!ready) {
    // Inject and wait again — the original injection may have raced the page
    // reaching document_idle.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (e) {
      return { ok: false, error: `reinject failed: ${String(e && e.message || e)}` };
    }
    const readyAfterInject = await waitForContentScriptReady(tabId);
    if (!readyAfterInject) {
      return { ok: false, error: 'content-script did not become ready within timeout' };
    }
  }
  return fetchDetailedCoursesFromTab(tabId, params);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function renderList(state) {
  els.items.innerHTML = '';
  for (let i = 0; i < state.videos.length; i++) {
    const v = state.videos[i];
    const r = state.results[i];
    const li = document.createElement('li');
    const status = r ? r.status : (i === state.cursor ? 'running' : 'pending');
    li.className = status;
    li.textContent = v.title || v.slug;
    if (r && r.error) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = ` — ${r.error}`;
      li.appendChild(err);
    }
    els.items.appendChild(li);
  }
}

function renderProgress(state) {
  const done = state.results.filter((r) => r && (r.status === 'done' || r.status === 'already_done')).length;
  const failed = state.results.filter((r) => r && r.status === 'failed').length;
  els.progress.textContent = `${done} done, ${failed} failed, ${state.videos.length} total`;
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

async function readLinkedInCookies() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_COOKIES' });
  return (resp && resp.cookies) || {};
}

// Surface a per-video outcome to the server log so silent skips become
// visible. Without this, a video that fails the page-fetch path looks
// identical to one that was never attempted.
async function reportRunnerOutcome(courseSlug, videoSlug, index, total, outcome, error, upstreamStatus) {
  try {
    await fetch(`${SERVER}/api/learning/runner-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-linkedinrec-client': 'extension' },
      body: JSON.stringify({ courseSlug, videoSlug, index, total, outcome, error, upstreamStatus }),
    });
  } catch { /* logging is best-effort — never let it break the walk */ }
}

async function enumerateCourse(courseSlug) {
  const resp = await fetch(`${SERVER}/api/learning/course/${encodeURIComponent(courseSlug)}`);
  if (!resp.ok) throw new Error(`enumerate failed (${resp.status})`);
  const course = await resp.json();
  if (!Array.isArray(course.videos) || !course.videos.length) {
    throw new Error('no videos in curriculum');
  }
  return course;
}

async function captureOne(state, i, cookies, persistentTabId) {
  const v = state.videos[i];
  const videoUrl = `https://www.linkedin.com/learning/${state.courseSlug}/${v.slug}`;
  let openedTabId = null;
  let openedTabOwnsLifecycle = false;
  let upstream = null;
  try {
    if (persistentTabId) {
      // Reuse one tab for the whole walk. LinkedIn's edge rate-limits the
      // /learning-api/ endpoint per session/origin, and a fresh tab per
      // video appears as a separate session — which is why we kept getting
      // 429s mid-walk even with pacing. Navigating the same tab keeps the
      // cookie jar, the React context, and the limiter budget intact.
      openedTabId = persistentTabId;
      await chrome.tabs.update(openedTabId, { url: videoUrl, active: false });
      await waitForTabComplete(openedTabId);
    } else {
      const created = await chrome.tabs.create({ url: videoUrl, active: false });
      openedTabId = created.id;
      openedTabOwnsLifecycle = true;
      await waitForTabComplete(openedTabId);
    }
    await sleep(CONTENT_SCRIPT_SETTLE_MS);
    // Asking for _1080 doesn't cap a 720-only course — the parser picks the
    // best available progressive MP4 from formats[]. The state.resolution
    // override is the CEILING, only honored when the ladder falls back.
    upstream = await pageFetchWithReinject(openedTabId, {
      courseSlug: state.courseSlug,
      videoSlug: v.slug,
      resolution: '_1080',
    });
  } catch (e) {
    upstream = { ok: false, error: `tab workflow failed: ${String(e && e.message || e)}` };
  } finally {
    // Only close the tab if we created it ourselves. The persistent tab is
    // closed once at the end of the walk.
    if (openedTabId != null && openedTabOwnsLifecycle) {
      try { await chrome.tabs.remove(openedTabId); } catch { /* tab already gone */ }
    }
  }

  if (!upstream || !upstream.ok) {
    // LinkedIn's edge rate-limits aggressive background-tab bursts with 429.
    // Surface it to the runner-log (it has its own upstreamStatus field) but
    // DON'T classify it as an auth failure — that aborts the walk entirely
    // and is the wrong response to a transient throttle. The next iteration's
    // pacing delay gives the limiter time to drain.
    return {
      slug: v.slug,
      title: v.title,
      status: 'failed',
      error: (upstream && upstream.error) || 'no upstream',
      upstreamStatus: upstream ? upstream.status : null,
      authFailure: !!(upstream && (upstream.status === 401 || upstream.status === 403)),
      rateLimited: !!(upstream && upstream.status === 429),
    };
  }

  const captureUrl = `${SERVER}/api/learning/capture?resolution=${encodeURIComponent(state.resolution || '_1080')}`;
  const captureResp = await fetch(captureUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-linkedinrec-client': 'extension',
    },
    body: JSON.stringify({
      courseSlug: state.courseSlug,
      videoSlug: v.slug,
      cookies,
      courseTitle: state.courseTitle || state.courseSlug,
      chapterTitle: v.chapterTitle || 'Course',
      videoTitle: v.title || v.slug,
      index: i + 1,
      total: state.videos.length,
      route: 'capture-all-runner',
      upstreamJson: upstream.json,
      upstreamStatus: upstream.status,
      upstreamBodySnippet: upstream.bodySnippet,
    }),
  });
  const captureJson = await captureResp.json().catch(() => ({}));
  const job = captureJson.job || {};
  return {
    slug: v.slug,
    title: v.title,
    status: job.status || 'failed',
    file: job.file,
    error: job.error || (captureJson.error || null),
    authFailure: !!(job.error && /401|403/.test(job.error)),
  };
}

async function runWalk(courseSlug) {
  const cookies = await readLinkedInCookies();
  if (!cookies.li_at) {
    setBadge('login missing', 'error');
    els.current.textContent = 'no li_at cookie — log into linkedin.com in this browser first';
    return;
  }

  // Pin the resolution at the moment the walk starts so a mid-walk change of
  // the dropdown doesn't produce a capture-batch where video 1 is 1080 and
  // video 30 is 720. Changing the dropdown after this only affects the next
  // walk (a resume, or a fresh click of Capture entire course).
  const requestedResolution = ALLOWED_RESOLUTIONS.includes(els.resolution.value)
    ? els.resolution.value
    : '_1080';
  activeResolution = requestedResolution;
  els.resolution.disabled = true;

  let state = await loadCheckpoint(courseSlug);
  if (state) {
    // On resume, the original resolution wins (captures done at a different
    // ceiling can't be re-picked without re-downloading).
    setBadge(`resuming at ${state.cursor + 1}`, 'warn');
    els.resolution.value = state.resolution || '_1080';
  } else {
    setBadge('enumerating…', 'warn');
    let course;
    try {
      course = await enumerateCourse(courseSlug);
    } catch (e) {
      setBadge('enumerate failed', 'error');
      els.current.textContent = String(e && e.message || e);
      return;
    }
    state = {
      courseSlug,
      courseTitle: course.courseTitle || courseSlug,
      videos: course.videos.map((v) => ({
        slug: v.slug,
        title: v.title,
        chapterTitle: v.chapterTitle,
      })),
      results: [],
      cursor: 0,
      resolution: requestedResolution,
      startedAt: new Date().toISOString(),
    };
    await saveCheckpoint(state);
  }

  els.course.textContent = state.courseTitle;
  renderProgress(state);
  renderList(state);

  let persistentTabId = null;
  try {
    // Single tab for the whole walk — see captureOne(). The first video's
    // URL seeds it so we don't waste an extra navigation.
    const firstVideo = state.videos[state.cursor];
    const created = await chrome.tabs.create({
      url: `https://www.linkedin.com/learning/${state.courseSlug}/${firstVideo.slug}`,
      active: false,
    });
    persistentTabId = created.id;
  } catch (e) {
    setBadge('tab creation failed', 'error');
    els.current.textContent = `could not open a persistent tab: ${String(e && e.message || e)}`;
    return;
  }

  try {
    for (let i = state.cursor; i < state.videos.length; i++) {
      if (stopRequested) {
        setBadge('stopped', 'warn');
        els.current.textContent = `stopped before video ${i + 1} — reopen to resume`;
        return;
      }
      state.cursor = i;
      setBadge(`capturing ${i + 1}/${state.videos.length}`, 'warn');
      els.current.textContent = state.videos[i].title || state.videos[i].slug;
      renderList(state);

      // Retry-the-same-video loop for 429. LinkedIn's edge lifts the throttle
      // after a short pause; we sleep and try again instead of advancing past
      // the video and leaving a permanent gap in the course. Capped by
      // RATE_LIMIT_RETRY_MAX_ATTEMPTS so a truly stuck video doesn't pin the
      // walk forever — at the cap we fall through to the normal failure
      // path and the user can resume.
      let result = null;
      let rateLimitAttempt = 0;
      while (true) {
        result = await captureOne(state, i, cookies, persistentTabId);
        if (!result.rateLimited) break;
        if (rateLimitAttempt >= RATE_LIMIT_RETRY_MAX_ATTEMPTS) {
          // Budget exhausted — give up on this video this session, mark it
          // failed, move on. The user can resume manually.
          break;
        }
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[
          Math.min(rateLimitAttempt, RATE_LIMIT_RETRY_DELAYS_MS.length - 1)
        ];
        rateLimitAttempt++;
        // Tell the user what we're doing. The walk feels alive even when it
        // spends minutes waiting on a single video.
        const waitSec = Math.round(delay / 1000);
        setBadge(`429 on video ${i + 1} — retrying in ${waitSec}s (attempt ${rateLimitAttempt + 1})`, 'warn');
        els.current.textContent = `rate-limited, waiting ${waitSec}s before retrying ${state.videos[i].title || state.videos[i].slug}`;
        await sleep(delay);
        if (stopRequested) {
          setBadge('stopped', 'warn');
          els.current.textContent = `stopped during rate-limit wait — reopen to resume`;
          return;
        }
        setBadge(`retrying ${i + 1}/${state.videos.length}`, 'warn');
      }
      state.results[i] = result;
      // Checkpoint AFTER the video so a crash re-runs at most one video. The
      // server's already-on-disk check makes a repeat cheap.
      state.cursor = i + 1;
      await saveCheckpoint(state);
      renderProgress(state);
      renderList(state);

      // Mirror the per-video outcome to the server log so silent skips surface
      // in `_logs/linkedinrec.log` instead of vanishing into the runner's UI.
      if (result.status !== 'done' && result.status !== 'already_done') {
        await reportRunnerOutcome(state.courseSlug, state.videos[i].slug, i + 1, state.videos.length,
          result.status || 'unknown', result.error || null, result.upstreamStatus || null);
      }

      // Light pacing between successful iterations. 429 backoff is now handled
      // inside the retry loop above, so this just keeps us polite.
      await sleep(DEFAULT_INTER_VIDEO_DELAY_MS);

      if (result.authFailure) {
        setBadge('auth failure — aborted', 'error');
        els.current.textContent = `${result.error} (re-open linkedin.com/learning to refresh the session, then reopen this walk to resume)`;
        return;
      }
    }

    const failed = state.results.filter((r) => r && r.status === 'failed').length;
    setBadge(failed ? `finished with ${failed} failed` : 'finished', failed ? 'warn' : 'ok');
    els.current.textContent = failed
      ? 'reopen the walk to retry the failed videos'
      : 'all videos captured';
    if (!failed) await clearCheckpoint();
  } finally {
    // Close the persistent tab no matter how the walk ends — success,
    // abort, or thrown exception. The walk's checkpoint lets the next
    // resume open a fresh persistent tab.
    if (persistentTabId != null) {
      try { await chrome.tabs.remove(persistentTabId); } catch { /* tab already gone */ }
    }
  }
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

els.stop.addEventListener('click', () => {
  stopRequested = true;
  els.stop.disabled = true;
  setBadge('stopping after current video…', 'warn');
});

els.reset.addEventListener('click', async () => {
  await clearCheckpoint();
  els.current.textContent = 'saved progress cleared — reload this tab to start from the top';
});

(async () => {
  const courseSlug = new URLSearchParams(location.search).get('course');
  if (!courseSlug) {
    setBadge('no course', 'error');
    els.current.textContent = 'missing ?course=<slug> in the URL';
    return;
  }
  els.course.textContent = courseSlug;
  try {
    await runWalk(courseSlug);
  } catch (e) {
    setBadge('crashed', 'error');
    els.current.textContent = String(e && e.message || e);
  }
})();
