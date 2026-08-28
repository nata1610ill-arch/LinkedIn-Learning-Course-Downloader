// LinkedInRec UI — talks to http://localhost:5177 and renders the three tabs.

const els = {
  serverBadge: document.getElementById('server-badge'),
  lastRefresh: document.getElementById('last-refresh'),
  tabs: document.querySelectorAll('nav button[data-tab]'),
  tabPanels: document.querySelectorAll('.tab'),
  jobsTableBody: document.querySelector('#jobs-table tbody'),
  jobsEmpty: document.getElementById('jobs-empty'),
  downloadsTableBody: document.querySelector('#downloads-table tbody'),
  downloadsEmpty: document.getElementById('downloads-empty'),
  courseSlug: document.getElementById('course-slug'),
  btnEnumerate: document.getElementById('btn-enumerate'),
  enumerateResult: document.getElementById('enumerate-result'),
};

function setBadge(el, text, cls) {
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'error');
  if (cls) el.classList.add(cls);
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString();
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = String(text ?? '');
  if (className) td.className = className;
  return td;
}

async function api(path) {
  const res = await fetch(`http://localhost:5177${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function refreshHealth() {
  try {
    const health = await api('/api/health');
    setBadge(els.serverBadge, `online :${health.port}`, 'ok');
  } catch {
    setBadge(els.serverBadge, 'offline', 'error');
  }
  els.lastRefresh.textContent = `refreshed ${new Date().toLocaleTimeString()}`;
}

async function refreshJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    els.jobsTableBody.replaceChildren();
    if (!jobs.length) {
      els.jobsEmpty.style.display = '';
      return;
    }
    els.jobsEmpty.style.display = 'none';
    const rows = jobs.map((j) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(j.status, `status-cell ${j.status}`),
        cell(`${j.courseSlug} / ${j.videoSlug}`),
        cell(j.resolution || '—'),
        cell(basename(j.file)),
        cell(j.error || ''),
        cell(j.startedAt),
      );
      return tr;
    });
    rows.forEach((r) => els.jobsTableBody.appendChild(r));
  } catch (e) {
    els.jobsEmpty.style.display = '';
    els.jobsEmpty.textContent = `error: ${e.message}`;
  }
}

async function refreshDownloads() {
  try {
    const { files } = await api('/api/downloads');
    els.downloadsTableBody.replaceChildren();
    if (!files.length) {
      els.downloadsEmpty.style.display = '';
      return;
    }
    els.downloadsEmpty.style.display = 'none';
    files.forEach((f) => {
      const tr = document.createElement('tr');
      tr.append(cell(f.path), cell(fmtSize(f.size)), cell(fmtTime(f.mtime)));
      els.downloadsTableBody.appendChild(tr);
    });
  } catch (e) {
    els.downloadsEmpty.style.display = '';
    els.downloadsEmpty.textContent = `error: ${e.message}`;
  }
}

function activateTab(name) {
  els.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  els.tabPanels.forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

els.tabs.forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));

els.btnEnumerate.addEventListener('click', async () => {
  const slug = els.courseSlug.value.trim();
  if (!slug) return;
  els.btnEnumerate.disabled = true;
  els.enumerateResult.textContent = 'listing…';
  try {
    const course = await api(`/api/learning/course/${encodeURIComponent(slug)}`);
    els.enumerateResult.textContent = JSON.stringify(course, null, 2);
  } catch (e) {
    els.enumerateResult.textContent = `error: ${e.message}`;
  } finally {
    els.btnEnumerate.disabled = false;
  }
});

async function refresh() {
  await refreshHealth();
  await refreshJobs();
  await refreshDownloads();
}

refresh();
setInterval(refresh, 5000);
