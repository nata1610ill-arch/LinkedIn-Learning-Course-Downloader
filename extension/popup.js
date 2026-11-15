// LinkedInRec popup — talks to the background service worker.

const els = {
  status: document.getElementById('status'),
  li_at: document.getElementById('li_at'),
  jsessionid: document.getElementById('jsessionid'),
  server: document.getElementById('server'),
  page: document.getElementById('page'),
  identity: document.getElementById('identity'),
  identityInput: document.getElementById('identity-input'),
  saveIdentity: document.getElementById('save-identity'),
  clearIdentity: document.getElementById('clear-identity'),
  captureVideo: document.getElementById('capture-video'),
  captureCourse: document.getElementById('capture-course'),
  result: document.getElementById('result-text'),
};

function setBadge(el, text, cls) {
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'error');
  if (cls) el.classList.add(cls);
}

async function refresh() {
  const ping = await chrome.runtime.sendMessage({ type: 'PING_SERVER' });
  setBadge(els.server, ping.ok ? 'online' : 'offline', ping.ok ? 'ok' : 'error');

  const cookiesResp = await chrome.runtime.sendMessage({ type: 'GET_COOKIES' });
  const cookies = cookiesResp.cookies || {};
  const haveLiAt = !!cookies.li_at;
  const haveJsid = !!cookies.JSESSIONID;
  els.li_at.textContent = haveLiAt ? 'present' : '(missing)';
  els.jsessionid.textContent = haveJsid ? 'present' : '(missing)';

  // Corporate/enterprise accounts only get playback URLs when the request
  // carries this header; without it exactly the first videos of a course work.
  const identityResp = await chrome.runtime.sendMessage({ type: 'GET_IDENTITY' });
  const identity = identityResp && identityResp.identity;
  const identityProblem = identityResp && identityResp.problem;
  els.identity.textContent = identity
    ? `set (${identity.length} chars)`
    : (identityProblem ? 'invalid' : '(not set)');
  els.identity.classList.toggle('ok', !!identity);
  // A stored value the content script would discard must say why, otherwise
  // "identity=no" in the log looks identical to "nothing saved".
  els.identity.title = identityProblem || '';
  if (identityProblem) els.identityInput.placeholder = identityProblem;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  const parsed = await chrome.runtime.sendMessage({ type: 'PARSE_URL', url });
  const p = parsed.parsed;
  if (!p || !p.courseSlug) {
    els.page.textContent = 'not a Learning page';
    setBadge(els.status, 'idle', 'warn');
    els.captureVideo.disabled = true;
    els.captureCourse.disabled = true;
    return;
  }
  if (p.isVideo) {
    els.page.textContent = `${p.courseSlug} / ${p.videoSlug}`;
    els.captureVideo.disabled = !haveLiAt || !ping.ok;
    els.captureCourse.disabled = !haveLiAt || !ping.ok;
  } else {
    els.page.textContent = `${p.courseSlug} (course root)`;
    els.captureVideo.disabled = true;
    els.captureCourse.disabled = !haveLiAt || !ping.ok;
  }

  if (!ping.ok) {
    setBadge(els.status, 'server down', 'error');
  } else if (!haveLiAt) {
    setBadge(els.status, 'login missing', 'error');
  } else if (!haveJsid) {
    setBadge(els.status, 'jsid missing', 'warn');
  } else if (p.isVideo) {
    setBadge(els.status, 'ready (video)', 'ok');
  } else {
    setBadge(els.status, 'ready (course)', 'ok');
  }
}

function showResult(obj) {
  els.result.textContent = JSON.stringify(obj, null, 2);
}

els.captureVideo.addEventListener('click', async () => {
  els.captureVideo.disabled = true;
  showResult({ status: 'capturing…' });
  const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIDEO' });
  showResult(resp);
  els.captureVideo.disabled = false;
});

els.saveIdentity.addEventListener('click', async () => {
  const value = els.identityInput.value.trim();
  if (!value) {
    showResult({ ok: false, error: 'paste the x-li-identity header value from DevTools first' });
    return;
  }
  const resp = await chrome.runtime.sendMessage({ type: 'SET_IDENTITY', value });
  els.identityInput.value = '';
  if (!resp || !resp.ok) {
    showResult({ ok: false, error: (resp && resp.error) || 'could not save the header' });
  } else {
    showResult({ ok: true, saved: value.length, note: 'corporate header stored locally — the next video request uses it, no restart needed' });
  }
  await refresh();
});

els.clearIdentity.addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'SET_IDENTITY', value: '' });
  els.identityInput.value = '';
  showResult({ ok: !!(resp && resp.ok), cleared: true });
  await refresh();
});

els.captureCourse.addEventListener('click', async () => {
  els.captureCourse.disabled = true;
  showResult({ status: 'opening course-walk runner…' });
  const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_COURSE' });
  // The walk itself now runs in the runner tab (extension/runner.js) so it is
  // not bound to the service worker's 5-minute event-handler limit. Progress is
  // shown in that tab, not here.
  showResult(resp && resp.ok
    ? { ...resp, note: 'walk running in the LinkedInRec runner tab — watch progress there' }
    : resp);
  els.captureCourse.disabled = false;
});

refresh();
