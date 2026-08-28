# LinkedInRec

Local helper that downloads LinkedIn Learning videos you are entitled to view as
a paid subscriber, directly from `linkedin.com`. Everything stays on your
machine. No cloud, no upload.

## What it does

- A local Node.js server on `http://localhost:5177`.
- A Chrome/Edge/Brave MV3 extension loaded from `extension/`.
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
- Single-video capture (`Capture this video`) runs the fetch from the
  user's active tab.
- Whole-course capture (`Capture entire course`) opens each video URL in
  a hidden background tab, page-fetches it, captures it, closes the tab,
  and moves to the next.

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

Install dependencies (none beyond Node, but the step keeps parity with
FetchTV):

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
`scripting`, `tabs`, and `host_permissions: <all_urls>` +
`http://localhost:5177/*`. Cookies are read only from `linkedin.com` and
only used to invoke the content script's same-origin page fetch.

## Main workflow

1. Start the server.
2. Reload the extension.
3. In the browser, navigate to a LinkedIn Learning page:
   - **Single video**: `https://www.linkedin.com/learning/<course>/<video>`
   - **Course root**: `https://www.linkedin.com/learning/<course>`
4. The extension's toolbar icon turns green when auth cookies are
   detected.
5. Click the toolbar icon:
   - **Capture this video** — grabs the currently playing video (active
     tab must be a video URL).
   - **Capture entire course** — walks the curriculum and grabs every
     video in order (active tab can be the course root).
6. Watch progress on the **LinkedIn** tab of `http://localhost:5177`.

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
   page's `JSESSIONID` cookie.
5. Content script returns `{ok, status, json, bodySnippet}` to the
   background script.
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

1. Background script GETs `/api/learning/course/<slug>` from the local
   server, which fetches the course HTML and parses the embedded
   `application/ld+json` curriculum.
2. For each video in the curriculum, the background script:
   - opens `https://www.linkedin.com/learning/<course>/<video>` in a
     hidden tab via `chrome.tabs.create({active:false})`,
   - waits for `chrome.tabs.onUpdated` to report `status: 'complete'`,
   - gives the content script ~800ms to register its message listener,
   - sends `PAGE_FETCH_DETAILED_COURSES` and reads the upstream JSON,
   - POSTs `{…, upstreamJson}` to `/api/learning/capture`,
   - closes the tab.
3. The local server handles each capture identically to single-video
   mode.

## What will NOT work

- **Widevine L1/L2 protected content.** A subset of new
  Hollywood-licensed courses (Disney, Marvel, etc.) play through EME on
  desktop. The API returns no `progressiveUrl` and the HLS manifest is
  encrypted. Those videos are reported as `DRM_PROTECTED` in the UI;
  bypassing them requires extracting a CDM from a hardware device, which
  is out of scope.
- **Content you cannot already view.** The tool does not authenticate
  you. You must be logged in with an active subscription in the browser
  that the extension is loaded into.
- **Login automation.** The extension does not log you in. LinkedIn's
  bot detection makes scripted logins fragile; reusing the browser's
  existing session is simpler and more reliable.

## Troubleshooting

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
│   ├── background.js       service worker (cookie harvest, tab orchestration)
│   ├── content.js          page-side /learning-api fetch + subtitle extraction
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

Run tests (17 specs covering parser, media pipeline, security):

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

List completed MP4s newest first (Windows):

```powershell
Get-ChildItem -Recurse downloads -Filter *.mp4 | Sort-Object LastWriteTime -Descending
```