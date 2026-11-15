# LinkedInRec

Local helper that downloads LinkedIn Learning videos you are entitled to view as
a paid subscriber, directly from `linkedin.com`. Everything stays on your
machine. No cloud, no upload.

## What it does

- A local Node.js server on `http://localhost:5177`.
- A Chrome / Edge / Brave MV3 extension loaded from `extension/`.
- When you open a LinkedIn Learning page, the extension's content script
  fetches `/learning-api/detailedCourses` from the page context (so the
  request rides your browser's own cookie jar, network path, and TLS
  fingerprint — this is what makes it work where replaying cookies from a
  Node-side fetch gets blocked).
- The JSON is forwarded to the local server, which downloads the
  progressive MP4 (`selectedVideo.url.progressiveUrl`) and writes
  `downloads/<course-slug>/<chapter>/<index>-<video-slug>.mp4` after an
  `ffmpeg` re-mux for clean faststart metadata.
- Each download also writes an English `.srt` subtitle file alongside the
  MP4 from the `selectedVideo.transcript.lines[]` block already in the same
  JSON — no separate API call, no language selection needed.
- **Single-video capture** (`Capture this video`) runs the fetch from the
  user's active tab.
- **Whole-course capture** (`Capture entire course`) opens a dedicated
  runner tab (`extension/runner.html`) that walks the curriculum end to
  end with one persistent LinkedIn tab, retrying rate-limited videos
  in-place instead of skipping them. Progress checkpoints to
  `chrome.storage.local` after every video.

This is the same mechanism public tools (yt-dlp, llvd,
J3Patel/linkedin-learning-video-downloader) have used since 2019. It only
works for content you can already watch in the browser; it does not bypass
DRM or grant access to content you cannot see.

## Why the fetch happens in the browser

The naive flow — Node server reads `li_at` + `JSESSIONID` from the
extension and replays them server-side — breaks on machines where
LinkedIn's edge tears down the TCP/TLS connection the moment it sees the
`li_at` cookie from anything other than the browser. The CSRF check then
returns `403` with body `CSRF check failed.` even though the same cookies
work fine when the browser itself makes the request.

The fix is structural: the `/learning-api/detailedCourses` call happens
*inside* a LinkedIn Learning tab via the extension's content script, then
the JSON is handed to the local server. The server only downloads the
signed MP4 (which uses a different auth path that works from any
egress) and writes the file.

## Why the walk lives in a runner tab (and uses one persistent tab)

Two MV3 / LinkedIn realities shaped the runner:

1. **5-minute handler cap.** Chrome hard-terminates an MV3 service worker
   when a single event handler runs longer than 5 minutes. The walk used
   to live inside `chrome.runtime.onMessage` and was truncated mid-course
   with no error and no resume. The runner tab (an extension page) has no
   such cap.

2. **Per-tab rate-limit budget.** LinkedIn's edge rate-limits
   `/learning-api/` per session/origin. Opening a fresh background tab per
   video appeared as a new session — even with pacing, bursts of new tabs
   produced `429 Too Many Requests`. The runner now opens **one
   persistent tab** for the whole walk and navigates it between videos.
   Same JS context, same cookies, same rate-limit budget.

The combined effect: a 123-video course completes in one click without
gaps. Each video takes ~2-3 seconds when throttled only by inter-iteration
pacing, and a 429-blocked video is retried in place with a 15s / 30s / 60s
backoff ladder (cap: 4 attempts, ~3 min) before the walk gives up on it.

## Requirements

- Node.js 20 or newer
- Chrome, Edge, or Brave
- `ffmpeg` and `ffprobe` available in `PATH`
- A paid LinkedIn Learning subscription, with the browser logged into
  `https://www.linkedin.com/learning/`

Check tools:

```bash
node --version
ffmpeg -version
ffprobe -version
```

Install dependencies (none beyond Node, but the step keeps parity):

```bash
npm install
```

## Run

Start the server:

```bash
npm start
```

…or double-click `start-linkedinrec.bat`.

Open:

```
http://localhost:5177
```

The server is intended for localhost only. Do not expose it to a network,
tunnel, or reverse proxy — `li_at` is a high-value session token.

## Load the extension

1. Start the server with `npm start`.
2. Open `chrome://extensions` (or `edge://extensions`,
   `brave://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the local `extension/` folder.
6. Reload the extension after any code change. The version number
   (`chrome://extensions` → LinkedInRec) tells you which build is loaded.

The extension's required permissions are `activeTab`, `cookies`,
`scripting`, `storage`, `tabs`, and `host_permissions:
https://*.linkedin.com/*` + `http://localhost:5177/*`. Cookies are read
only from `linkedin.com` and only used to invoke the content script's
same-origin page fetch. `storage` holds nothing but the course-walk
checkpoint (course slug, video list, cursor, resolution) — never cookies.

## Main workflow

1. Start the server.
2. Reload the extension.
3. In the browser, navigate to a LinkedIn Learning page:
   - **Single video**: `https://www.linkedin.com/learning/<course>/<video>`
   - **Course root**: `https://www.linkedin.com/learning/<course>`
4. The extension's toolbar icon turns green when auth cookies are
   detected.
5. Click the toolbar icon:
   - **Capture this video** — grabs the currently playing video. The
     active tab must be a video URL.
   - **Capture entire course** — walks the curriculum end to end. The
     active tab can be the course root or any video in the course. A
     runner tab opens and shows live progress.
6. Watch progress in the runner tab (not the popup — the popup returns
   immediately when the runner is spawned).

The runner has a **resolution ceiling** dropdown that defaults to
"highest available" (asks the API for `_1080`, parser picks the highest
progressive MP4 LinkedIn serves). Pin to 720p or 540p to save bandwidth
or disk; the choice is baked into the checkpoint so a mid-walk change
can't produce a half-1080 half-720 batch.

Final files appear under:

```
downloads/<course-slug>/
  01-chapter-one/
    01-introduction.mp4
    01-introduction.srt       # English captions, SRT format
    02-setup.mp4
    02-setup.srt
  02-chapter-two/
    ...
```

## How a single video capture works

1. Extension content script registers a `chrome.runtime.onMessage`
   listener for `PAGE_FETCH_DETAILED_COURSES`.
2. Extension background script reads `li_at` + `JSESSIONID` from
   `chrome.cookies.getAll({domain: '.linkedin.com'})`.
3. User clicks **Capture this video**. Background script asks the active
   LinkedIn tab's content script to perform the page fetch.
4. Content script calls `fetch('/learning-api/detailedCourses?...')` from
   the page context with `credentials: 'include'`, modern
   `sec-fetch-*` headers, and a `csrf-token` header built from the
   page's `JSESSIONID` cookie. If the response is a 200 with an empty
   payload (`elements: []`, `included: []`) — the SPA hadn't hydrated
   yet — it retries up to 5 times with a 600ms gap.
5. Content script returns `{ok, status, json, bodySnippet, attempts}` to
   the background script.
6. Background script POSTs `{courseSlug, videoSlug, cookies, …,
   upstreamJson}` to `http://localhost:5177/api/learning/capture`.
7. Server extracts `selectedVideo.progressiveUrl` from the upstream
   JSON, downloads into a `.part` file, validates with `ffprobe`,
   re-muxes to a second temporary file with
   `ffmpeg -c copy -movflags +faststart`, validates again, then atomically
   renames it to `downloads/<course>/<chapter>/<index>-<video>.mp4`.
8. Server also extracts `selectedVideo.transcript.lines[]`, renders it
   as SRT, and writes `<index>-<video>.srt` next to the MP4.
9. Server returns `{ok, file, job}` to the extension popup.

## How a course walk works

1. Popup sends `CAPTURE_COURSE`. The background script resolves the course
   slug from the active tab and opens
   `runner.html?course=<slug>` in a new tab, then returns immediately. It
   does **not** run the walk itself (see "Why the walk lives in a runner
   tab").
2. `runner.js` GETs `/api/learning/course/<slug>` from the local server,
   which fetches the course HTML and parses the embedded
   `application/ld+json` curriculum. The result (videos list + pinned
   resolution) is written to `chrome.storage.local` as
   `{courseSlug, videos, cursor, resolution}`.
3. The runner opens **one persistent LinkedIn tab** seeded with the first
   video's URL, then walks the rest:
   - `chrome.tabs.update({url})` to navigate the persistent tab to the
     next video URL.
   - Wait for `status: 'complete'`, then poll
     `window.__linkedinrecReady` for up to 8s. If it never sets, force
     `chrome.scripting.executeScript({files:['content.js']})` and wait
     again — covers the case where the content script didn't auto-inject.
   - Send `PAGE_FETCH_DETAILED_COURSES` with a 15s `sendMessage` race.
   - POST `{…, upstreamJson, route: 'capture-all-runner'}` to
     `/api/learning/capture`. The `route` tag distinguishes walk
     captures from single-video ones in the log.
   - Save checkpoint with `cursor = i + 1`. Closing the runner tab loses
     at most the video in flight.
4. **Rate-limit handling.** If `captureOne` returns
   `result.rateLimited === true` (the page-side fetch got HTTP 429), the
   runner does not advance. It sleeps `[15s, 30s, 60s]` between attempts,
   capped at 4 attempts (~3 min total), and re-tries the same video.
   Status line updates live: `429 on video 12 — retrying in 30s (attempt 2)`.
   If the cap is hit, the video is marked failed and the walk continues
   — the user can resume manually to retry it.
5. **Per-video outcome reporting.** Every non-success outcome is posted
   to `POST /api/learning/runner-log`, which writes
   `WARN runner video <outcome> | ...` to `_logs/linkedinrec.log`. This
   is what made the 429 issue visible — without it, the walk's silent
   skips looked identical to "no videos attempted yet".
6. On a clean finish the checkpoint is deleted. If any video failed, the
   checkpoint is kept so reopening the walk retries only what's missing.
7. The persistent tab is closed in a `finally` block so the tab is
   released no matter how the walk ends (success, stop, exception,
   tab-closed-mid-walk).

Re-clicking **Capture entire course** for a slug that already has a runner
tab open focuses that tab instead of starting a competing walk.

## What will NOT work

- **Widevine L1/L2 protected content.** A subset of new
  Hollywood-licensed courses (Disney, Marvel, etc.) play through EME on
  desktop. The API returns no `progressiveUrl` and the HLS manifest is
  encrypted. Those videos are reported as `DRM_PROTECTED` in the UI;
  bypassing them requires extracting a CDM from a hardware device, which
  is out of scope.
- **Some enterprise-licensed courses** (Red Hat, certain training
  vendors) use the same EME / HLS path on desktop even though they
  aren't Hollywood content. The progressive MP4 endpoint simply isn't
  available for those videos, and the player falls back to the encrypted
  stream. The tool can see the videos in the curriculum (it reads the
  HTML `ld+json`) but cannot download them.
- **Content you cannot already view.** The tool does not authenticate
  you. You must be logged in with an active subscription in the browser
  that the extension is loaded into.
- **Login automation.** The extension does not log you in. LinkedIn's
  bot detection makes scripted logins fragile; reusing the browser's
  existing session is simpler and more reliable.

## Troubleshooting

### Runaway gaps — videos silently skipped during a course walk

Three failure modes have produced this historically. Always check
`_logs/linkedinrec.log` for the exact signature:

| Log signature | Root cause | Fix |
|---|---|---|
| `WARN runner video failed \| error="content-script unreachable"` | Tab opened, content script never attached | Already mitigated — `waitForContentScriptReady` polls `window.__linkedinrecReady` for 8s and force-injects if needed. If still happening: reload extension at `chrome://extensions`, then reload the LinkedIn tab. |
| `WARN runner video failed \| error="no upstream"` with no `upstreamStatus` | Older 1.0.x versions — invisible skip | Upgrade to ≥ 1.0.7; that field is in the log now. |
| `WARN runner video failed \| upstreamStatus=429` | LinkedIn's edge throttled the request | Already mitigated by 1.0.9 (persistent tab) and 1.0.10 (retry-in-place with 15s/30s/60s backoff). If a video hits the retry cap and stays failed, the walk continues; click "Capture entire course" again to retry just it. |
| Walk stops with no log line at all | Old MV3 service-worker 5-minute cap | Fixed in 1.0.5 — walk runs in `runner.html`, not the service worker. |

### Corporate / enterprise accounts: the first two videos download, then everything is `LOCKED`

**Exact symptoms — all three are the same root cause:**

| Where | Exact text |
|---|---|
| Runner list | first videos `done`, then every remaining video: `subscription-required: LinkedIn reports this video as not accessible (accessible=false / course LOCKED) — the signed-in account is not entitled to it` |
| `_logs/linkedinrec.log` | `INFO capture start` -> `INFO capture using upstream json from content script` (HTTP 200!) -> `WARN capture locked` -> `WARN runner video drm_protected` |
| Upstream JSON (`_logs/upstream-debug-*.json`) | `courseVisibilityStatus: "LOCKED"`, `coursePurchased: false`, `fullCourseUnlocked: false`, `selectedVideo.accessible: false`, no `url`, `formats[]` only `{width: 960, height: 540, extension: "mp4"}` |
| Second symptom of the same cause | downloads that *do* work are `resolution="640p"` — the free preview rendition |

**Why:** on an enterprise/connected ("corporate") account the
`/learning-api/detailedCourses` request must carry that account's
`x-li-identity` header. Without it LinkedIn still answers `200`, but with a
locked course — the first one or two videos of a course are the free
previews, which is exactly why "2 videos download, then it stops".
`subscription: "NONE"` and `coursePurchased: false` in that payload are
**not** the problem: the entitlement comes from the enterprise account
(`permissions` contains `HAS_FULL_CONTENT_ACCESS`), so the `drm_protected` /
`subscription-required` verdict is misleading. Sending a *wrong* identity
instead of none gives the other classic signature: `403` with body
`CSRF check failed.` on the very first video.

**Fix (>= 1.0.17):** the content script reads the identity out of the page's
`InitialContext` block (the `bpr-guid-*` element llvd calls
`enterpriseProfileHash`), tries `enterpriseProfileHash` ->
`enterpriseIdentityHash` -> `identityToken`, each with and without the
optional `u` parameter, and stops at the first value LinkedIn accepts. No
manual step is needed; if the page exposes nothing usable, paste the value
from DevTools (Network -> `learning-api` -> Request Headers ->
`x-li-identity`) into the extension popup — a stored value wins over the
page. `identity=yes identitySrc=...` in the log line proves which one was
sent.

### "no resolution found" / jobs in `failed` status

Check `_logs/linkedinrec.log`. Each failed job carries an `error` string.
Common values:

- `csrf check failed — JSESSIONID expired, re-open linkedin.com/learning in the browser to mint a fresh session`
  — your `JSESSIONID` rotated. Open the LinkedIn Learning page once to
  refresh it, then re-run the capture.
- `content-script unreachable: …`
  — the extension wasn't reloaded after a code change, or the active
  tab isn't a LinkedIn Learning page. Reload the extension at
  `chrome://extensions` and make sure the active tab is on
  `linkedin.com/learning/...`.

### "no progressive url" / `DRM_PROTECTED` on every video of a course

The course is Widevine-protected on desktop. The mobile app offers
offline downloads for some of these; this tool does not.

### A long course stops partway through with no error in the log

Fixed in 1.0.5 — the walk runs in the runner tab, not the service
worker. If you still see this, check that the version number at
`chrome://extensions` matches `extension/manifest.json` (Chrome MV3
caches the old service worker otherwise — toggle OFF and ON to force a
clean reload). The walk's last line in the log shows the
`route="capture-all-runner"` capture index it reached; reopen the walk to
resume from the checkpoint.

### Subtitle file is empty or missing

The course's video has no transcript in LinkedIn's response. This is
rare but happens for some older courses.

### Server won't start

- Port 5177 is already taken. Stop the other instance, or edit `PORT`
  near the top of `server.js`.
- Check `node --version` (must be ≥ 20).

## File layout

```
LinkedInRec/
├── extension/
│   ├── manifest.json
│   ├── background.js       service worker (cookie harvest, spawns runner tab)
│   ├── content.js          page-side /learning-api fetch + retry on empty payload
│   ├── runner.html         course-walk UI (no service-worker lifetime cap)
│   ├── runner.css
│   ├── runner.js           walk loop, persistent tab, 429 retry-in-place
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── lib/
│   ├── linkedin-parser.js  extractVideoMetadata + transcript/SRT helpers
│   └── media.js            atomicDownload + ffprobe wrappers
├── test/
│   ├── *.test.js                Node test suite (run via `npm test`)
│   ├── runner-walk.harness.mjs  vm-based harness for runner.js (10 scenarios)
│   └── capture-course.handler.harness.mjs  service-worker CAPTURE_COURSE harness
├── downloads/              all MP4 + SRT outputs land here (gitignored)
├── _logs/
│   └── linkedinrec.log     structured log of every capture (gitignored)
├── server.js               Node 20 HTTP server on port 5177
├── package.json
├── start-linkedinrec.bat   Windows launcher
├── .gitignore
└── README.md
```

## Useful commands

Start server:

```bash
npm start
```

Run tests (19 specs across parser, media pipeline, security, plus 10
runner-harness scenarios + 3 service-worker handler scenarios):

```bash
npm test
```

Lint (syntax check across all source files):

```bash
npm run lint
```

Tail the log:

```bash
tail -f _logs/linkedinrec.log
```

Look for skipped videos (per-video outcome reporter added in 1.0.7):

```bash
grep "runner video failed" _logs/linkedinrec.log
```

Look for resolution that's actually getting picked (per-video log line
added in 1.0.6):

```bash
grep "format picked" _logs/linkedinrec.log
```

List completed MP4s newest first (Windows):

```powershell
Get-ChildItem -Recurse downloads -Filter *.mp4 | Sort-Object LastWriteTime -Descending
```
