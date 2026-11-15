// LinkedInRec server — local helper that downloads LinkedIn Learning videos
// the user is entitled to view, using the same /learning-api/detailedCourses
// endpoint every public LinkedIn Learning downloader uses.
//
// Architecture: HTTP server on http://localhost:5177. Static UI served from
// public/. The browser extension (extension/) detects Learning pages and POSTs
// {courseSlug, videoSlug, cookies: {li_at, JSESSIONID}} here. We replay the
// auth against LinkedIn's API, parse the JSON, and stream the progressive MP4
// to disk. ffmpeg re-muxes with faststart for clean playback.
//
// NOT supported: Widevine L1/L2 protected content. NOT a login bypass tool.

import { createServer } from 'node:http';
import { mkdir, stat, readdir, appendFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractVideoMetadata, extractTranscriptLines, renderSrt, findVideoObject } from './lib/linkedin-parser.js';
import { atomicDownload, bestHlsVariant, downloadHls, probeMedia } from './lib/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const LOGS_DIR = path.join(__dirname, '_logs');
const LOG_FILE = path.join(LOGS_DIR, 'linkedinrec.log');
const PORT = Number(process.env.PORT) || 5177;
// `LINKEDINREC_FORCE=1` re-downloads even when a file is already on disk —
// needed to upgrade existing 640p files once a higher rendition is available.
const FORCE_REDOWNLOAD = process.env.LINKEDINREC_FORCE === '1';
// Printed on startup. A stale server is the most common reason a fix "does not
// work", so the log line now proves which capture pipeline is loaded.
const PIPELINE = 'hls-segment-concat';

// LinkedIn Learning's detailedCourses endpoint takes a `resolution` hint
// (`_1080` / `_720` / `_540`). The hint is NOT a cap — the response's
// `formats[]` array contains every progressive MP4 the course author uploaded,
// and lib/linkedin-parser.js picks the highest by height, then by bitrate.
// The hint only affects which rendition is put in `selectedVideo.url.progressiveUrl`
// when the API has to choose one. So always ask for `_1080` here; the parser
// degrades gracefully to 720 or 540 if that's all the course has.
const DEFAULT_RESOLUTION = '_1080';
// Ladder used only when the upstream JSON is missing/unparseable (legacy
// CSRF/abuse failures before the browser-side fetch existed). Three rungs is
// enough — most failures short-circuit on the first.
const RESOLUTION_LADDER = ['_1080', '_720', '_540'];
const API_BASE = 'https://www.linkedin.com/learning-api/detailedCourses';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REFERER_BASE = 'https://www.linkedin.com/learning';

// In-memory state for the UI to read. Resets on server restart.
const jobs = new Map(); // jobId -> job
const recentFiles = []; // newest-first list of {path, size, mtime}
let jobSeq = 0;

await mkdir(DOWNLOADS_DIR, { recursive: true });
await mkdir(LOGS_DIR, { recursive: true });
await refreshRecentFiles();

function ts() {
  return new Date().toISOString();
}

function log(level, component, message, fields = {}) {
  const parts = Object.entries(fields)
    .map(([k, v]) => {
      let val;
      if (v === null || v === undefined) val = String(v);
      else if (typeof v === 'string') val = JSON.stringify(v);
      else if (Array.isArray(v) || typeof v === 'object') val = JSON.stringify(v);
      else val = String(v);
      return `${k}=${val}`;
    })
    .join(' ');
  const line = `${ts()} ${level} ${component} ${message}${parts ? ' | ' + parts : ''}\n`;
  appendFile(LOG_FILE, line).catch(() => {});
  process.stdout.write(line);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function securityHeaders(type) {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, securityHeaders(type));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function isTrustedMutationRequest(req) {
  const origin = String(req.headers.origin || '');
  return req.headers['x-linkedinrec-client'] === 'extension' &&
    (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('edge-extension://'));
}

function readBody(req, maxBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function refreshRecentFiles() {
  recentFiles.length = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
        try {
          const s = await stat(full);
          recentFiles.push({ path: full, size: s.size, mtime: s.mtimeMs });
        } catch {}
      }
    }
  }
  await walk(DOWNLOADS_DIR);
  recentFiles.sort((a, b) => b.mtime - a.mtime);
}

function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function fetchDetailedCourses({ courseSlug, videoSlug, cookies, resolution }) {
  const params = new URLSearchParams({
    addParagraphsToTranscript: 'false',
    q: 'slugs',
    resolution,
    courseSlug,
    videoSlug,
  });
  const url = `${API_BASE}?${params.toString()}`;
  const cleanJsid = cookies.JSESSIONID ? String(cookies.JSESSIONID).replace(/^"|"$/g, '') : '';
  const headers = {
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'csrf-token': cleanJsid,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    referer: `${REFERER_BASE}/${courseSlug}/${videoSlug}`,
    'user-agent': USER_AGENT,
  };
  const cookieHeader = [
    cookies.li_at && `li_at=${cookies.li_at}`,
    cleanJsid && `JSESSIONID="${cleanJsid}"`,
  ].filter(Boolean).join('; ');
  if (cookieHeader) headers.cookie = cookieHeader;

  const res = await fetch(url, { headers, redirect: 'follow' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  // LinkedIn's CSRF rejection (stale/rotated JSESSIONID) comes back as a
  // tiny plain-text body "CSRF check failed." — capture it so callers can
  // distinguish "auth expired, refresh in browser" from a real API failure.
  const bodySnippet = text && text.length > 160 ? text.slice(0, 160) + '…' : text;
  return { status: res.status, json, text, url, bodySnippet };
}

// Normalize LinkedIn's response shape into a uniform { locked, progressiveUrl, title, ... } object.
// The actual shape LinkedIn returns for /learning-api/detailedCourses is roughly:
//   {
//     data: { paging, *elements, cachingKey, $type: "com.linkedin.voyager....Course", ... },
//     included: [ <CourseNode>, <CourseNode>, ... ]
//   }
// where the Course node we're after has `slug` matching courseSlug and a
// direct `selectedVideo` field. LinkedIn does NOT use JSON:API's `type` field
// — it uses Voyager-style URN strings in `$type` (or no type field at all).
// Earlier shapes used `elements: [...]`; older public downloaders still hit
// that path sometimes. We try both.
async function captureVideo({ courseSlug, videoSlug, cookies, courseTitle, chapterTitle, videoTitle, index, total, upstreamJson, upstreamStatus, route, resolutionOverride }) {
  const jobId = `job-${++jobSeq}-${Date.now()}`;
  const captureRoute = route || 'active-video';
  // resolutionOverride pins the API hint ceiling. Ladder shape is computed
  // once per job so the override applies to the first rung too — if you
  // override to _720, the ladder starts at _720.
  const ladder = resolutionOverride
    ? RESOLUTION_LADDER.slice(RESOLUTION_LADDER.indexOf(resolutionOverride))
    : RESOLUTION_LADDER;
  const job = {
    id: jobId,
    courseSlug,
    videoSlug,
    courseTitle: courseTitle || courseSlug,
    chapterTitle: chapterTitle || 'uncategorized',
    index: index || 0,
    total: total || 1,
    route: captureRoute,
    status: 'pending',
    resolution: null,
    error: null,
    file: null,
    startedAt: ts(),
    finishedAt: null,
  };
  jobs.set(jobId, job);
  log('INFO', 'capture', 'start', { jobId, route: captureRoute, courseSlug, videoSlug, index: index || 0, total: total || 1 });

  try {
    job.status = 'resolving';
    let meta = null;
    let lastError = null;
    // If the extension's content script already did the page-context fetch
    // and forwarded the JSON here, skip the local LinkedIn fetch entirely —
    // it would just hit the same anti-abuse 403 / TLS abort.
    if (upstreamJson && typeof upstreamJson === 'object') {
      log('INFO', 'capture', 'using upstream json from content script', { jobId, upstreamStatus });
      const parsed = extractVideoMetadata(upstreamJson, courseSlug, videoSlug);
      if (parsed) {
        if (parsed.locked) {
          job.status = 'drm_protected';
          job.error = parsed.notAccessible
            ? 'subscription-required: LinkedIn reports this video as not accessible (accessible=false / course LOCKED) — the signed-in account is not entitled to it (corporate/enterprise accounts: set the x-li-identity header in the extension popup and re-run)'
            : 'locked or subscription-required';
          log('WARN', 'capture', 'locked', { jobId, videoSlug });
          return job;
        }
        if (!parsed.progressiveUrl) {
          job.status = 'failed';
          job.error = 'no progressive url';
          log('ERROR', 'capture', 'upstream had no progressive url', { jobId });
          return job;
        }
        meta = { ...parsed, resolution: '_upstream' };
        job.resolution = parsed.selectedFormat && parsed.selectedFormat.height
          ? `${parsed.selectedFormat.height}p`
          : 'upstream';
        job.width = parsed.selectedFormat && parsed.selectedFormat.width;
        job.height = parsed.selectedFormat && parsed.selectedFormat.height;
        job.bitrate = parsed.selectedFormat && parsed.selectedFormat.bitrate;
        // Surface which rendition the parser chose so the user can see in the
        // log whether the API returned 1080, 720, 540, or something else.
        const pickedHeight = parsed.selectedFormat && parsed.selectedFormat.height;
        const allHeights = Array.isArray(parsed.formats)
          ? parsed.formats
              .filter((f) => f && (f.type === 'progressive' || f.mimeType === 'video/mp4') && f.url)
              .map((f) => Number(f.height || 0))
              .filter((h) => h > 0)
              .sort((a, b) => b - a)
          : [];
        log('INFO', 'capture', 'format picked', {
          jobId,
          requestedResolution: '_1080',
          pickedHeight,
          pickedBitrate: parsed.selectedFormat && parsed.selectedFormat.bitrate,
          availableHeights: allHeights,
          // What the API actually offered (no signed query string, path only).
          hasStreaming: !!parsed.streamingUrl,
          urlKeys: parsed.urlObjectKeys,
          chosenPath: parsed.progressivePathOnly,
          offeredFormats: Array.isArray(parsed.formatInventory) ? parsed.formatInventory : [],
        });
        // Full inventory on disk, opt-in: `LINKEDINREC_DUMP_FORMATS=1 npm start`.
        // Needed to answer "is there a higher rendition?" without guessing.
        if (process.env.LINKEDINREC_DUMP_FORMATS === '1') {
          const formatDump = path.join(LOGS_DIR, `formats-${videoSlug}.json`);
          try {
            await writeFile(formatDump, JSON.stringify({
              videoSlug,
              requestedResolution: '_1080',
              chosenPath: parsed.progressivePathOnly,
              urlObjectKeys: parsed.urlObjectKeys,
              selectedFormat: parsed.selectedFormat,
              formatInventory: parsed.formatInventory,
            }, null, 2), 'utf8');
            log('INFO', 'capture', 'dumped format inventory', { jobId, formatDump });
          } catch (e) {
            log('WARN', 'capture', 'format dump failed', { jobId, error: String(e && e.message || e) });
          }
        }
      } else {
        lastError = 'no metadata (upstream)';
        // Diagnostic: when the upstream fetch succeeds but the parser can't
        // find a video node, the page-side fetch hit a half-hydrated state.
        // Log the actual top-level shape so we can fix it instead of guessing.
        const topKeys = upstreamJson && typeof upstreamJson === 'object'
          ? Object.keys(upstreamJson) : null;
        const elemLen = upstreamJson && Array.isArray(upstreamJson.elements)
          ? upstreamJson.elements.length : null;
        const incLen = upstreamJson && Array.isArray(upstreamJson.included)
          ? upstreamJson.included.length : null;
        // Deep diagnostic: log $type values and slug fields in included[]
        // so we can see exactly what LinkedIn returned.
        const incTypes = upstreamJson && Array.isArray(upstreamJson.included)
          ? [...new Set(upstreamJson.included.map((n) => n && n.$type).filter(Boolean))]
          : null;
        const incSlugs = upstreamJson && Array.isArray(upstreamJson.included)
          ? upstreamJson.included
              .filter((n) => n && (n.slug || (n.attributes && n.attributes.slug)))
              .map((n) => n.slug || n.attributes.slug)
              .slice(0, 10)
          : null;
        const dataKeys = upstreamJson && upstreamJson.data && typeof upstreamJson.data === 'object'
          ? Object.keys(upstreamJson.data) : null;
        const dataSlug = upstreamJson && upstreamJson.data
          ? upstreamJson.data.slug || (upstreamJson.data.attributes && upstreamJson.data.attributes.slug) || null
          : null;
        const dataType = upstreamJson && upstreamJson.data ? upstreamJson.data.$type : null;
        // Check for selectedVideo pointers in included
        const incWithSelectedVideo = upstreamJson && Array.isArray(upstreamJson.included)
          ? upstreamJson.included
              .filter((n) => n && (n.selectedVideo || n['*selectedVideo'] || (n.attributes && (n.attributes.selectedVideo || n.attributes['*selectedVideo']))))
              .map((n) => ({
                slug: n.slug || (n.attributes && n.attributes.slug),
                $type: n.$type,
                hasSelectedVideo: !!(n.selectedVideo || (n.attributes && n.attributes.selectedVideo)),
                hasSelectedVideoRef: !!(n['*selectedVideo'] || (n.attributes && n.attributes['*selectedVideo'])),
              }))
              .slice(0, 5)
          : null;
        // Check for video-related $id or entityUrn containing the videoSlug
        const incMatchingVideoSlug = upstreamJson && Array.isArray(upstreamJson.included)
          ? upstreamJson.included
              .filter((n) => n && videoSlug && (
                (n.$id && n.$id.includes(videoSlug)) ||
                (n.entityUrn && n.entityUrn.includes(videoSlug)) ||
                (n.urn && n.urn.includes(videoSlug))
              ))
              .map((n) => ({
                $id: n.$id,
                $type: n.$type,
                entityUrn: n.entityUrn,
                keys: Object.keys(n).slice(0, 15),
              }))
              .slice(0, 3)
          : null;
        log('WARN', 'capture', 'upstream json had no metadata', {
          jobId, topKeys, elemLen, includedLen: incLen,
          incTypes, incSlugs, dataKeys, dataSlug, dataType,
          incWithSelectedVideo,
          incMatchingVideoSlug,
        });
        // Dump the upstream JSON for offline debugging (first failure only
        // to avoid filling the disk on a 74-video walk).
        const dumpPath = path.join(LOGS_DIR, `upstream-debug-${videoSlug}.json`);
        try {
          await writeFile(dumpPath, JSON.stringify(upstreamJson, null, 2), 'utf8');
          log('INFO', 'capture', 'dumped upstream json for debugging', { jobId, dumpPath });
        } catch (e) {
          log('WARN', 'capture', 'dump write failed', { jobId, error: String(e && e.message || e) });
        }
        // Do not fall through to the Node-side ladder if upstreamJson was already provided:
        // Node-side fetch triggers LinkedIn anti-abuse TLS abort / 403 CSRF check failure,
        // which would overwrite this diagnostic with a false "JSESSIONID expired" error.
        job.status = 'failed';
        job.error = 'no metadata (upstream)';
        return job;
      }
    }
    if (!meta) {
      for (const res of ladder) {
      try {
        const result = await fetchDetailedCourses({ courseSlug, videoSlug, cookies, resolution: res });
        if (result.status !== 200) {
          // Translate LinkedIn's plain-text CSRF rejection into a clearer
          // message so the user sees "auth expired, refresh in browser"
          // instead of an opaque "api 403".
          let label = `api ${result.status}`;
          if (result.status === 403 && /csrf check failed/i.test(result.bodySnippet || '')) {
            label = 'csrf check failed — JSESSIONID expired, re-open linkedin.com/learning in the browser to mint a fresh session';
          }
          lastError = label;
          log('WARN', 'capture', 'api non-200', {
            jobId, resolution: res, status: result.status, bodySnippet: result.bodySnippet,
          });
          continue;
        }
        // Diagnostic: record the shape LinkedIn returned so "no metadata"
        // failures are debuggable instead of opaque.
        const topKeys = result.json && typeof result.json === 'object' ? Object.keys(result.json) : null;
        const elemLen = result.json && Array.isArray(result.json.elements) ? result.json.elements.length : null;
        const elem0Keys = elemLen && result.json.elements[0] && typeof result.json.elements[0] === 'object'
          ? Object.keys(result.json.elements[0]) : null;
        // Newer responses use JSON:API shape: { data: {...}, included: [...] }.
        // The VideoObject we want is usually in `included` (or in `data` for
        // single-resource fetches). Record its keys too.
        let dataType = null, dataKeys = null, includedLen = null, included0Keys = null;
        if (result.json && result.json.data && typeof result.json.data === 'object') {
          dataType = Array.isArray(result.json.data) ? 'array' : typeof result.json.data;
          dataKeys = Array.isArray(result.json.data)
            ? (result.json.data[0] ? Object.keys(result.json.data[0]) : null)
            : Object.keys(result.json.data);
        }
        if (result.json && Array.isArray(result.json.included)) {
          includedLen = result.json.included.length;
          included0Keys = result.json.included[0] && typeof result.json.included[0] === 'object'
            ? Object.keys(result.json.included[0]) : null;
        }
        log('DEBUG', 'capture', 'api 200 shape', {
          jobId, resolution: res,
          topKeys, elemLen, elem0Keys, dataType, dataKeys, includedLen, included0Keys,
        });
        const parsed = extractVideoMetadata(result.json, courseSlug, videoSlug);
        if (!parsed) {
          lastError = 'no metadata';
          const diag = findVideoObject(result.json, courseSlug, videoSlug);
          log('WARN', 'capture', 'no metadata', {
            jobId, resolution: res, topKeys, elemLen, elem0Keys, dataType, dataKeys,
            includedLen, included0Keys, foundSource: diag && diag.source,
            foundHasSelectedVideo: diag && diag.node && !!diag.node.selectedVideo,
          });
          continue;
        }
        // Diagnostic: log formats[] shape so we can see what resolutions are
        // actually offered, before deciding which one to download.
        log('DEBUG', 'capture', 'parsed', {
          jobId,
          resolution: res,
          progressiveUrlHost: parsed.progressiveUrl ? new URL(parsed.progressiveUrl).host : null,
          formatsCount: (parsed.formats || []).length,
          formatsSummary: (parsed.formats || []).map((f) => ({
            type: f.type, mimeType: f.mimeType,
            width: f.width, height: f.height,
            bitrate: f.bitrate || f.bitRate,
          })),
          pickedFromFormats: !parsed.formats || parsed.formats.length < 2 ? false : true,
        });

        if (parsed.locked) {
          job.status = 'drm_protected';
          job.error = parsed.notAccessible
            ? 'subscription-required: LinkedIn reports this video as not accessible (accessible=false / course LOCKED) — the signed-in account is not entitled to it (corporate/enterprise accounts: set the x-li-identity header in the extension popup and re-run)'
            : 'locked or subscription-required';
          log('WARN', 'capture', 'locked', { jobId, videoSlug });
          return job;
        }
        if (!parsed.progressiveUrl) {
          lastError = 'no progressive url';
          continue;
        }
        meta = { ...parsed, resolution: res };
        job.resolution = parsed.selectedFormat && parsed.selectedFormat.height
          ? `${parsed.selectedFormat.height}p`
          : res.replace('_', '');
        job.width = parsed.selectedFormat && parsed.selectedFormat.width;
        job.height = parsed.selectedFormat && parsed.selectedFormat.height;
        job.bitrate = parsed.selectedFormat && parsed.selectedFormat.bitrate;
        // Same per-job visibility as the browser-side path so the log makes it
        // obvious which rendition was actually picked versus what the API was
        // asked for.
        const ladderHeights = Array.isArray(parsed.formats)
          ? parsed.formats
              .filter((f) => f && (f.type === 'progressive' || f.mimeType === 'video/mp4') && f.url)
              .map((f) => Number(f.height || 0))
              .filter((h) => h > 0)
              .sort((a, b) => b - a)
          : [];
        log('INFO', 'capture', 'format picked', {
          jobId,
          requestedResolution: res,
          pickedHeight: parsed.selectedFormat && parsed.selectedFormat.height,
          pickedBitrate: parsed.selectedFormat && parsed.selectedFormat.bitrate,
          availableHeights: ladderHeights,
        });
        break;
      } catch (e) {
        lastError = String(e && e.message || e);
        log('WARN', 'capture', 'fetch threw', { jobId, resolution: res, error: lastError });
      }
    }
    } // close if (!meta) { for (...) }
    if (!meta) {
      job.status = 'failed';
      job.error = lastError || 'no usable resolution';
      log('ERROR', 'capture', 'all resolutions failed', { jobId, error: job.error });
      return job;
    }

    const safeCourse = sanitizeSegment(courseTitle || courseSlug);
    const safeChapter = sanitizeSegment(chapterTitle || 'uncategorized');
    const safeVideo = sanitizeSegment(videoTitle || videoSlug);
    const prefix = String(index || 0).padStart(2, '0');
    const courseDir = path.join(DOWNLOADS_DIR, safeCourse);
    const chapterDir = path.join(courseDir, safeChapter);
    await mkdir(chapterDir, { recursive: true });
    const dest = path.join(chapterDir, `${prefix}-${safeVideo}.mp4`);

    const headers = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      referer: `${REFERER_BASE}/${courseSlug}/${videoSlug}`,
    };
    const cleanJsid = cookies.JSESSIONID ? String(cookies.JSESSIONID).replace(/^"|"$/g, '') : '';
    const cookieHeader = [
      cookies.li_at && `li_at=${cookies.li_at}`,
      cleanJsid && `JSESSIONID="${cleanJsid}"`,
    ].filter(Boolean).join('; ');
    if (cookieHeader) headers.cookie = cookieHeader;
    const maxHeight = Number(process.env.LINKEDINREC_MAX_HEIGHT || 0) ||
      (resolutionOverride ? Number(String(resolutionOverride).replace('_', '')) : 0) || null;

    try {
      const existingMedia = await probeMedia(dest);
      // Auto-upgrade: when the adaptive stream offers a higher rendition than the
      // file on disk, replace it instead of skipping. Without this, anything
      // first downloaded at 640p would stay at 640p forever — re-running the walk
      // could never improve quality.
      let upgradeTo = null;
      if (existingMedia && !FORCE_REDOWNLOAD && meta.streamingUrl) {
        try {
          const best = await bestHlsVariant({ url: meta.streamingUrl, headers, maxHeight });
          if (best.picked && best.picked.height && existingMedia.height &&
              best.picked.height > existingMedia.height) {
            upgradeTo = best.picked.height;
          }
        } catch {
          /* playlist unavailable — keep the file that is already there */
        }
      }
      if (existingMedia && !FORCE_REDOWNLOAD && !upgradeTo) {
        const s = await stat(dest);
        job.status = 'already_done';
        job.file = dest;
        job.width = existingMedia.width;
        job.height = existingMedia.height;
        job.bitrate = existingMedia.bitrate;
        job.resolution = existingMedia.height ? `${existingMedia.height}p` : job.resolution;
        job.finishedAt = ts();
        log('INFO', 'capture', 'already on disk, skipping', { jobId, dest, size: s.size });
        return job;
      }
      if (upgradeTo) {
        log('INFO', 'capture', 'upgrading existing file', {
          jobId, dest, from: `${existingMedia.height}p`, to: `${upgradeTo}p`,
        });
      }
      await rm(dest, { force: true });
    } catch {
      await rm(dest, { force: true });
    }

    job.status = 'downloading';

    // Prefer the adaptive stream. The progressive URL is pinned to a single
    // rendition (its path reads `.../mp4-640p-30fp-crf28/...`), while the HLS
    // master playlist carries every rendition the player offers. Fall back to the
    // progressive URL whenever the playlist is missing, unparsable, or ffmpeg
    // fails.
    let mediaInfo = null;
    if (meta.streamingUrl) {
      try {
        mediaInfo = await downloadHls({ url: meta.streamingUrl, destination: dest, headers, maxHeight });
        log('INFO', 'capture', 'hls download done', {
          jobId,
          variants: mediaInfo.variants,
          variantHeight: mediaInfo.variantHeight,
          height: mediaInfo.height,
          bitrate: mediaInfo.bitrate,
          audio: mediaInfo.audio,
        });
      } catch (e) {
        log('WARN', 'capture', 'hls failed, falling back to progressive', {
          jobId,
          error: String(e && e.message || e),
        });
        await rm(dest, { force: true });
        mediaInfo = null;
      }
    }
    if (!mediaInfo) {
      mediaInfo = await atomicDownload({
        url: meta.progressiveUrl,
        destination: dest,
        headers,
      });
    }

    job.status = 'done';
    job.file = dest;
    job.width = mediaInfo.width || job.width;
    job.height = mediaInfo.height || job.height;
    job.bitrate = mediaInfo.bitrate || job.bitrate;
    job.resolution = job.height ? `${job.height}p` : job.resolution;
    job.finishedAt = ts();
    // Write English subtitles next to the MP4 if LinkedIn returned them.
    // Captions are in meta.transcriptLines (normalised from either
    // selectedVideo.transcript.lines or .paragraphs by the parser).
    if (Array.isArray(meta.transcriptLines) && meta.transcriptLines.length) {
      const srtPath = dest.replace(/\.mp4$/i, '.srt');
      try {
        await writeFile(srtPath, renderSrt(meta.transcriptLines), 'utf8');
        job.subtitle = srtPath;
        log('INFO', 'capture', 'subtitle written', { jobId, srtPath, lines: meta.transcriptLines.length });
      } catch (e) {
        log('WARN', 'capture', 'subtitle write failed', { jobId, error: String(e && e.message || e) });
      }
    }
    log('INFO', 'capture', 'done', { jobId, dest, resolution: job.resolution });
    await refreshRecentFiles();
    return job;
  } catch (e) {
    job.status = 'failed';
    job.error = String(e && e.message || e);
    job.finishedAt = ts();
    log('ERROR', 'capture', 'failed', { jobId, error: job.error });
    return job;
  }
}

async function enumerateCourse(slug) {
  const url = `${REFERER_BASE}/${slug}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`course page ${res.status}`);
  const courseTitle = (html.match(/<title>([^<]+)<\/title>/) || [, ''])[1]
    .replace(/\s*\|\s*LinkedIn Learning.*$/i, '')
    .trim() || slug;

  const items = [];
  // LinkedIn Learning exposes its curriculum as a JSON-LD block. We pull the
  // first <script type="application/ld+json"> and walk `hasPart`, which is a
  // list of chapter groups, each chapter being a list of VideoObject nodes.
  // The contentUrl embeds a canonical course slug that may include a trailing
  // numeric id (e.g. "learning-python-25309312") which doesn't always match
  // the user-facing slug in the page URL. We accept every video on the page
  // and trust that the page is for one course.
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
  if (ldMatch) {
    try {
      const data = JSON.parse(ldMatch[1]);
      const groups = Array.isArray(data && data.hasPart) ? data.hasPart : [];
      let chapterIndex = -1;
      for (const group of groups) {
        chapterIndex += 1;
        if (!Array.isArray(group)) continue;
        for (const video of group) {
          if (!video || video['@type'] !== 'VideoObject') continue;
          const contentUrl = String(video.contentUrl || video.url || '');
          const parts = contentUrl.replace(/^https?:\/\/[^/]+\/learning\//, '').split('/').filter(Boolean);
          if (parts.length < 2) continue;
          const videoSlug = parts[parts.length - 1];
          const fullName = String(video.name || videoSlug);
          // The video name is "<title> - <chapter>" for most entries; the
          // first video of a chapter is "<chapter> - Introduction".
          const dashIdx = fullName.lastIndexOf(' - ');
          let title = fullName;
          let chapterTitle = `Chapter ${chapterIndex + 1}`;
          if (dashIdx > 0) {
            const left = fullName.slice(0, dashIdx).trim();
            const right = fullName.slice(dashIdx + 3).trim();
            // If "left" already equals what looks like a chapter name in
            // syllabusSections, treat right as chapter. Otherwise right.
            if (/^\d+\./.test(right) || /^[A-Z]/.test(right)) {
              title = left;
              chapterTitle = right;
            }
          }
          const isoDur = String(video.duration || '');
          const m = isoDur.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
          const durationInSeconds = m
            ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)
            : 0;
          items.push({
            chapterIndex,
            videoIndex: items.filter((i) => i.chapterIndex === chapterIndex).length,
            chapterTitle,
            title,
            slug: videoSlug,
            durationInSeconds,
            contentUrl,
          });
        }
      }
    } catch (e) {
      log('WARN', 'enumerate', 'ld+json parse failed', { error: String(e) });
    }
  }
  if (!items.length) {
    // Last-ditch fallback: find any /learning/<slug>/<video> anchors in the HTML.
    const seen = new Set();
    const re = new RegExp(`/learning/${slug}/([a-z0-9-]+)`, 'g');
    let m;
    while ((m = re.exec(html))) {
      if (m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        items.push({
          chapterIndex: 0,
          videoIndex: items.length,
          chapterTitle: 'Course',
          title: m[1],
          slug: m[1],
          durationInSeconds: 0,
        });
      }
    }
  }
  return { courseSlug: slug, courseTitle, videos: items };
}

async function readStatic(req, res, urlPath) {
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let filePath = path.resolve(PUBLIC_DIR, relativePath);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    send(res, 403, 'forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = mime[ext] || 'application/octet-stream';
  res.writeHead(200, securityHeaders(type));
  const { createReadStream } = await import('node:fs');
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 403, { ok: false, error: 'cross-origin requests are not allowed' });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /api/health') {
      send(res, 200, { ok: true, port: PORT, time: ts() });
      return;
    }
    // Debug endpoint: probe a user-supplied Cookie header against LinkedIn
    // using the same code path as a real capture, returning the raw
    // upstream status + body. Lets us distinguish "the extension is reading
    // cookies wrong" from "the cookies themselves are rejected".
    if (route === 'POST /api/debug/probe') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const probeCourse = String(body.courseSlug || 'advanced-facebook-advertising-2021');
      const probeVideo = String(body.videoSlug || 'learn-how-to-master-facebook-ads');
      const cookieHeader = String(body.cookieHeader || '');
      if (!cookieHeader) {
        send(res, 400, { ok: false, error: 'cookieHeader required' });
        return;
      }
      const csrfTokenRaw = (cookieHeader.match(/(?:^|;\s*)JSESSIONID=(?:"([^"]+)"|([^;]+))/i) || [, , ''])[1] || (cookieHeader.match(/(?:^|;\s*)JSESSIONID=(?:"([^"]+)"|([^;]+))/i) || [, , ''])[2];
      const csrfTokenPositive = csrfTokenRaw.replace(/^ajax:-/, 'ajax:');
      const cookieHeaderPositive = cookieHeader.replace(/(JSESSIONID="?)ajax:-/, '$1ajax:').replace(/(JSESSIONID=)ajax:-/, '$1ajax:');
      const probeUrl = `${API_BASE}?addParagraphsToTranscript=false&q=slugs&resolution=_720&courseSlug=${probeCourse}&videoSlug=${probeVideo}`;
      async function attempt(label, csrfToken, cookieHdr) {
        const r = await fetch(probeUrl, {
          headers: {
            accept: 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': csrfToken,
            'x-restli-protocol-version': '2.0.0',
            'x-li-lang': 'en_US',
            cookie: cookieHdr,
            referer: `https://www.linkedin.com/learning/${probeCourse}/${probeVideo}`,
            'user-agent': USER_AGENT,
          },
          redirect: 'follow',
        });
        const text = await r.text();
        return {
          label,
          csrfTokenSent: csrfToken ? `${csrfToken.slice(0, 14)}…` : '(empty)',
          upstreamStatus: r.status,
          upstreamBodySnippet: text.length > 200 ? text.slice(0, 200) + '…' : text,
        };
      }
      const results = [];
      results.push(await attempt('as-given', csrfTokenRaw, cookieHeader));
      if (csrfTokenPositive !== csrfTokenRaw) {
        results.push(await attempt('minus-stripped', csrfTokenPositive, cookieHeaderPositive));
      }
      send(res, 200, { results });
      return;
    }
    if (route === 'GET /api/jobs') {
      const list = Array.from(jobs.values()).sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
      send(res, 200, { jobs: list.slice(0, 200) });
      return;
    }
    if (route === 'GET /api/downloads') {
      send(res, 200, { files: recentFiles.slice(0, 100) });
      return;
    }
    if (route === 'POST /api/learning/capture') {
      if (!isTrustedMutationRequest(req)) {
        send(res, 403, { ok: false, error: 'trusted extension request required' });
        return;
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { courseSlug, videoSlug, cookies, courseTitle, chapterTitle, videoTitle, index, total, upstreamJson, upstreamStatus, route: captureRoute } = body;
      if (!courseSlug || !videoSlug || !cookies || !cookies.li_at) {
        send(res, 400, { ok: false, error: 'courseSlug, videoSlug and cookies.li_at required' });
        return;
      }
      // ?resolution=_1080|_720|_540 on the request URL pins the ceiling the
      // API is asked for. The parser still picks the best available
      // progressive MP4 from formats[], so a course that maxes at 720 still
      // yields 720. Default is the highest LinkedIn serves.
      const resolutionOverride = (() => {
        const requested = url.searchParams.get('resolution');
        return RESOLUTION_LADDER.includes(requested) ? requested : null;
      })();
      const job = await captureVideo({ courseSlug, videoSlug, cookies, courseTitle, chapterTitle, videoTitle, index, total, upstreamJson, upstreamStatus, route: captureRoute, resolutionOverride });
      send(res, 200, { ok: job.status === 'done' || job.status === 'already_done', job });
      return;
    }
    if (route === 'POST /api/learning/capture-all') {
      if (!isTrustedMutationRequest(req)) {
        send(res, 403, { ok: false, error: 'trusted extension request required' });
        return;
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { courseSlug, cookies } = body;
      if (!courseSlug || !cookies || !cookies.li_at) {
        send(res, 400, { ok: false, error: 'courseSlug and cookies.li_at required' });
        return;
      }
      const course = await enumerateCourse(courseSlug);
      const results = [];
      for (let i = 0; i < course.videos.length; i++) {
        const v = course.videos[i];
        const job = await captureVideo({
          courseSlug,
          videoSlug: v.slug,
          cookies,
          courseTitle: course.courseTitle,
          chapterTitle: v.chapterTitle,
          videoTitle: v.title,
          index: v.videoIndex + 1,
          total: course.videos.length,
          route: 'capture-all-server',
        });
        results.push({ slug: v.slug, title: v.title, status: job.status, file: job.file, error: job.error });
        if (job.status === 'failed' && job.error && /401|403/.test(job.error)) {
          log('WARN', 'capture-all', 'auth failure, aborting batch', { courseSlug, at: i });
          break;
        }
      }
      send(res, 200, { ok: true, course: course.courseTitle, results });
      return;
    }
    if (route === 'POST /api/learning/runner-log') {
      if (!isTrustedMutationRequest(req)) {
        send(res, 403, { ok: false, error: 'trusted extension request required' });
        return;
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { courseSlug, videoSlug, index, total, outcome, error: runnerError, upstreamStatus, detail } = body;
      if (!courseSlug || !videoSlug) {
        send(res, 400, { ok: false, error: 'courseSlug and videoSlug required' });
        return;
      }
      // Surface the runner's per-video outcome in the same log the server
      // captures write to. Without this, page-fetch failures during the walk
      // leave no log trace at all.
      log('WARN', 'runner', `video ${outcome}`, {
        courseSlug, videoSlug, index, total,
        error: runnerError ? String(runnerError).slice(0, 240) : null,
        upstreamStatus: upstreamStatus != null ? Number(upstreamStatus) : null,
        // Build/request fingerprint of the failing page-side fetch, so a
        // "CSRF check failed." line is diagnosable without guessing which
        // extension version or request variant produced it.
        detail: detail ? String(detail).slice(0, 400) : null,
      });
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith('/api/learning/course/')) {
      const slug = decodeURIComponent(url.pathname.slice('/api/learning/course/'.length));
      if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
        send(res, 400, { ok: false, error: 'invalid slug' });
        return;
      }
      // Optional ?debug=1 to see what linkedin actually returned (raw HTML size + first sigs).
      try {
        const course = await enumerateCourse(slug);
        if (url.searchParams.get('debug') === '1') {
          send(res, 200, { ...course, _debug: 'enabled' });
        } else {
          send(res, 200, course);
        }
      } catch (e) {
        send(res, 502, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }
    if (route.startsWith('GET ') && (url.pathname === '/' || url.pathname.startsWith('/public/') || /\.[a-z0-9]+$/i.test(url.pathname))) {
      await readStatic(req, res, url.pathname);
      return;
    }
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  } catch (e) {
    log('ERROR', 'http', 'route error', { route, error: String(e && e.message || e) });
    send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('INFO', 'server', 'listening', { url: `http://localhost:${PORT}`, pipeline: PIPELINE, node: process.version });
});
