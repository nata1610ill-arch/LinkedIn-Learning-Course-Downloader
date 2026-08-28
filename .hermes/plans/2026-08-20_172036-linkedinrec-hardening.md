# LinkedInRec Reliability and Security Implementation Plan

**Goal:** Harden the first release against corrupt downloads, concurrency races, misleading media quality, local cross-origin abuse, and dashboard XSS.

**Architecture:** Keep the dependency-free Node 20 design. Extract pure LinkedIn response parsing into a testable module, make media writes transactional with ffprobe validation, lock mutation routes to trusted local/extension clients, and render dashboard values only through text nodes.

**Tech Stack:** Node.js 20+ ESM, node:test, ffmpeg/ffprobe, Chrome MV3.

## Scope

1. Add a Node test harness and parser tests covering concurrent/call-local context and actual selected format metadata.
2. Extract LinkedIn metadata parsing from `server.js` into `lib/linkedin-parser.js`; pass slugs explicitly and remove global capture context.
3. Add media tests and `lib/media.js` for ffprobe validation plus atomic `.part` download/remux/final rename.
4. Change resume behavior to skip only ffprobe-valid MP4s and clean invalid/partial output.
5. Guard null parser results before diagnostics and report actual width/height/bitrate rather than requested API resolution.
6. Remove dashboard `innerHTML` sinks and render server-controlled data with `textContent`.
7. Restrict API CORS/origins, require an extension-only custom header on capture routes, and stop exposing cookie fragments in the popup.
8. Harden static path containment and add standard browser security/no-store headers.
9. Update README and run tests, syntax checks, npm audit, a live health check, and an independent review.

## Files

- Create: `lib/linkedin-parser.js`
- Create: `lib/media.js`
- Create: `test/linkedin-parser.test.js`
- Create: `test/media.test.js`
- Create: `test/security.test.js`
- Modify: `server.js`
- Modify: `public/app.js`
- Modify: `extension/background.js`
- Modify: `extension/popup.js`
- Modify: `package.json`
- Modify: `README.md`

## Acceptance criteria

- `npm test` passes.
- Invalid existing MP4s are never marked `already_done`.
- Failed downloads leave no final `.mp4`; transient files use `.part`/`.remux` and are cleaned.
- Two metadata parses cannot affect each other's course/video selection.
- Jobs expose actual media dimensions/bitrate where available.
- No dashboard data path uses `innerHTML`.
- Browser websites cannot invoke capture endpoints through permissive CORS.
- Popup displays only cookie presence, never cookie bytes.
- Server starts on 127.0.0.1 and health/download endpoints work.

## Risks and tradeoffs

- LinkedIn's undocumented response schema can change; fixtures cover known legacy and Voyager shapes.
- Extension origins are dynamic IDs, so origin validation accepts the `chrome-extension://` scheme while the custom request header prevents ordinary cross-origin simple requests.
- ffprobe adds a small resume-time cost in exchange for reliable corruption detection.
- Existing corrupt nonempty files will be replaced on the next capture.
