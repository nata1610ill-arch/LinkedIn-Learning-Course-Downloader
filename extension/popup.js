// LinkedInRec popup — talks to the background service worker.

const els = {
  status: document.getElementById('status'),
  li_at: document.getElementById('li_at'),
  jsessionid: document.getElementById('jsessionid'),
  server: document.getElementById('server'),
  page: document.getElementById('page'),
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

els.captureCourse.addEventListener('click', async () => {
  els.captureCourse.disabled = true;
  showResult({ status: 'walking course…' });
  const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_COURSE' });
  showResult(resp);
  els.captureCourse.disabled = false;
});

refresh();
