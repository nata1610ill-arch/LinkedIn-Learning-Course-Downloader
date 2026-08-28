# LinkedInRec

Local helper that downloads LinkedIn Learning videos you are entitled to view as a
paid subscriber, directly from `linkedin.com`. Everything stays on your machine.
No cloud, no upload.

## What it does

- A local Node.js server on `http://localhost:5177`.
- A Chrome/Edge/Brave MV3 extension loaded from `extension/`.
- The extension detects when you are on a LinkedIn Learning course page, harvests
  your `li_at` + `JSESSIONID` cookies, and forwards them to the local server.
- The server calls LinkedIn's internal
  `/learning-api/detailedCourses?...&resolution=_720&videoSlug=...` endpoint
  with your cookies, parses the JSON response, downloads the progressive MP4
  (`selectedVideo.url.progressiveUrl`), and writes the final MP4 under
  `downloads/<course-slug>/<video-slug>.mp4` after an `ffmpeg` re-mux for
  clean faststart metadata.

This is the same mechanism public tools (yt-dlp, llvd, J3Patel/linkedin-learning-video-downloader)
have used since 2019. It only works for content you can already watch in the
browser; it does not bypass DRM or grant access to content you cannot see.

## Requirements

- Node.js 20 or newer
- Chrome, Edge, or Brave
- `ffmpeg` and `ffprobe` available in `PATH`
- A paid LinkedIn Learning subscription, with the browser logged into
  `https://www.linkedin.com/learning/`

Check tools:

```powershell
node --version
ffmpeg -version
ffprobe -version
```

Install dependencies (none beyond Node, but the step keeps parity with FetchTV):

```powershell
npm.cmd install
```

## Run

Start the server:

```powershell
npm.cmd start
```

…or double-click `start-linkedinrec.bat`.

Open:

```text
http://localhost:5177
```

The server is intended for localhost only. Do not expose it to a network,
tunnel, or reverse proxy — `li_at` is a high-value session token.

## Load the extension

1. Start the server with `npm.cmd start`.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the local `extension/` folder.
6. Reload the extension after any code change.

The extension's required permissions are `activeTab`, `cookies`, `scripting`,
`tabs`, and `host_permissions: <all_urls>` + `http://localhost:5177/*`.
Cookies are read only from `linkedin.com` and only used by the local server to
replay authenticated requests to `learning-api/`.

## Main workflow

1. Start the server.
2. Reload the extension.
3. In the browser, navigate to a LinkedIn Learning course page:
   `https://www.linkedin.com/learning/<course-slug>`.
4. The extension's toolbar icon turns green when auth cookies are detected.
5. Click the toolbar icon → **Capture this video** to grab the currently
   playing video, or **Capture entire course** to walk the sidebar and grab
   every video in order.
6. Watch progress on the **LinkedIn** tab of `http://localhost:5177`.

Final MP4 files appear under:

```text
downloads/<course-slug>/
  01-chapter-one/
    01-introduction.mp4
    02-setup.mp4
  02-chapter-two/
    ...
```

## How a single video capture works

1. Extension content script inspects the active tab's URL and detects the
   `courseSlug` + `videoSlug` from `/learning/<course>/<video>`.
2. Extension background script reads `li_at` + `JSESSIONID` from
   `chrome.cookies.getAll({domain: '.linkedin.com'})`.
3. Background script POSTs `{courseSlug, videoSlug, cookies}` to
   `http://localhost:5177/api/learning/capture`.
4. Server calls
   `https://www.linkedin.com/learning-api/detailedCourses?...&courseSlug=...&resolution=_720&videoSlug=...`
   with `Csrf-Token: <JSESSIONID>` and a browser-like User-Agent + Referer.
5. Server parses JSON, picks the best progressive URL
   (`selectedVideo.url.progressiveUrl` first, falls back to first
   `formats[]` entry).
6. Server downloads into a temporary `.part` file and validates it with
   `ffprobe`; invalid or interrupted downloads never become final MP4s.
7. Server re-muxes to a second temporary file with
   `ffmpeg -c copy -movflags +faststart`, validates it again, then atomically
   renames it to `downloads/<course>/<chapter>/<index>-<video>.mp4`.
8. Server returns `{ok, file}` to the extension popup.

Resolution ladder: tries `_1080`, falls back to `_720`, falls back to `_540`.
Most LinkedIn Learning titles top out at 720p; 1080p is offered on a
growing subset. The first resolution that returns a `progressiveUrl` is used.

## Course walk (capture all videos)

The server route `GET /api/learning/course/:slug` fetches the public course
page HTML and parses the embedded JSON curriculum (`application/ld+json` +
`__NEXT_DATA__` fallback). It returns an ordered list of
`{chapter, title, slug, duration}` records.

The server route `POST /api/learning/capture-all` accepts `{courseSlug,
cookies}` and downloads every video in order, with the same per-video
auth + resolution ladder. Each video is a separate job with status
`pending → downloading → done | failed | drm_protected`.

A resumable design: if the browser session expires mid-course, re-running
`POST /api/learning/capture-all` skips only files that pass `ffprobe` validation;
partial or corrupt files are replaced.

The dashboard reports the actual probed video height (for example `540p`), not
just the quality requested from LinkedIn. The extension popup reports cookies
as present/missing and never displays cookie bytes.

Course downloads use the curriculum item title for each filename; single-video
captures use the page title and fall back to the stable video slug.

## What will NOT work

- **Widevine L1/L2 protected content.** A subset of new Hollywood-licensed
  courses (Disney, Marvel, etc.) play through EME on desktop. The API
  returns no `progressiveUrl` and the HLS manifest is encrypted. Those
  videos are reported as `DRM_PROTECTED` in the UI; bypassing them
  requires extracting a CDM from a hardware device, which is out of scope.
- **Content you cannot already view.** The tool does not authenticate
  you. You must be logged in with an active subscription in the browser
  that the extension is loaded into.
- **Login automation.** The extension does not log you in. LinkedIn's
  bot detection makes scripted logins fragile; reusing the browser's
  existing session is simpler and more reliable.

## Troubleshooting

### "no cookies" or 401 from the API

- Make sure you are logged into `linkedin.com` in the same browser where
  the extension is loaded.
- The toolbar popup shows a red cookie badge if `li_at` or `JSESSIONID`
  is missing.

### "DRM_PROTECTED" on every video of a course

The course is Widevine-protected on desktop. The mobile app offers
offline downloads for some of these; this tool does not.

### "403 Forbidden" mid-batch

Your `JSESSIONID` rotated or expired. Re-open the LinkedIn Learning page
in the browser to mint a fresh session, then re-run the capture.

### Server won't start

- Port 5177 is already taken by FetchTV. Stop the other instance, or
  edit `PORT` near the top of `server.js`.
- Check `node --version` (must be ≥ 20).

## File layout

```
LinkedInRec/
├── extension/
│   ├── manifest.json
│   ├── background.js       service worker (cookie harvest, server bridge)
│   ├── content.js          page-side URL + course walker
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── downloads/              all MP4 outputs land here
├── _logs/
│   └── linkedinrec.log     structured log of every capture
├── server.js               Node 20 HTTP server on port 5177
├── package.json
├── start-linkedinrec.bat   Windows launcher
└── README.md
```

## Useful commands

Start server:

```powershell
npm.cmd start
```

Syntax check:

```powershell
node --check server.js
node --check public\app.js
node --check extension\background.js
node --check extension\content.js
node --check extension\popup.js
```

Tail the log:

```powershell
Get-Content -Wait _logs\linkedinrec.log
```

List completed MP4s newest first:

```powershell
Get-ChildItem -Recurse downloads -Filter *.mp4 | Sort-Object LastWriteTime -Descending
```
