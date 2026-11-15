// Ad-hoc harness: runs extension/runner.js against stubbed chrome/DOM/fetch to
// prove the walk loop, per-video checkpointing, and mid-walk resume actually
// work. Not part of `npm test` (that suite is Node-only); this is a throwaway
// verification of browser-context code.
//
//   node test/runner-walk.harness.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const RUNNER = readFileSync(new URL('../extension/runner.js', import.meta.url), 'utf8');

function makeEl() {
  const el = {
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    children: [],
    classList: { add() {}, remove() {} },
    appendChild(c) { this.children.push(c); },
    addEventListener(_ev, fn) { this._handler = fn; },
  };
  return el;
}

function buildSandbox({ videos, storage, failAt = new Set(), rateLimitAt = new Set(), rateLimitRecoverAfter = new Map(), dieAt = null, resolutionSelect = '_1080', contentBuild = '1.0.17' }) {
  const buildField = contentBuild ? { build: contentBuild } : {};
  const els = {};
  for (const id of ['status', 'course', 'progress', 'current', 'items', 'stop', 'reset', 'resolution']) {
    els[id] = makeEl();
  }
  els.resolution.value = resolutionSelect;
  els.resolution.disabled = false;
  const captured = [];
  const runnerLog = [];
  const tabEvents = [];
  const rateLimitAtTracker = new Map();
  let tabSeq = 100;

  // Bump every time waitForContentScriptReady polls executeScript. After
  // PROBE_CAP polls (irrespective of result) we treat it as ready so the
  // harness loop terminates in bounded time even though the sandbox's
  // setTimeout collapses every sleep to instant.
  let probeCount = 0;
  const PROBE_CAP = 1;

  const sandbox = {
    console,
    setTimeout: (fn) => fn(),           // collapse all sleeps
    clearTimeout,
    URLSearchParams,
    Date,
    Array,
    Object,
    JSON,
    String,
    Boolean,
    RegExp,
    Error,
    Promise,
    encodeURIComponent,
    location: { search: '?course=my-course' },
    document: {
      getElementById: (id) => els[id],
      createElement: () => makeEl(),
    },
    chrome: {
      storage: {
        local: {
          async get(key) { return key in storage ? { [key]: storage[key] } : {}; },
          async set(obj) { Object.assign(storage, structuredClone(obj)); },
          async remove(key) { delete storage[key]; },
        },
      },
      runtime: {
        async sendMessage(msg) {
          if (msg.type === 'GET_COOKIES') return { ok: true, cookies: { li_at: 'DUMMY' } };
          throw new Error(`unexpected runtime msg ${msg.type}`);
        },
      },
      tabs: {
        async create({ url }) { const id = ++tabSeq; tabEvents.push(['create', id, url]); return { id }; },
        async update(id, props) { tabEvents.push(['update', id, props.url || null]); return { id }; },
        async remove(id) { tabEvents.push(['remove', id]); },
        get(id, cb) { cb({ id, status: 'complete' }); },
        async sendMessage(_id, msg) {
          if (rateLimitAt.has(msg.videoSlug)) {
            // Track per-slug attempt counts so the harness can simulate
            // "429 clears after N attempts" for the rate-limit-retry test.
            const attempts = (rateLimitAtTracker.get(msg.videoSlug) || 0) + 1;
            rateLimitAtTracker.set(msg.videoSlug, attempts);
            const recoverAfter = rateLimitRecoverAfter.get(msg.videoSlug) || Infinity;
            if (attempts >= recoverAfter) {
              return { ok: true, status: 200, json: { recovered: msg.videoSlug }, bodySnippet: '{}', ...buildField };
            }
            return { ok: false, status: 429, error: 'no upstream' };
          }
          if (failAt.has(msg.videoSlug)) return { ok: false, error: 'content-script unreachable: boom' };
          return { ok: true, status: 200, json: { fake: msg.videoSlug }, bodySnippet: '{}', ...buildField };
        },
      },
      scripting: {
        async executeScript() {
          probeCount++;
          return [{ result: probeCount >= PROBE_CAP, frameId: 0 }];
        },
      },
    },
    async fetch(url, opts) {
      if (String(url).includes('/api/learning/course/')) {
        return { ok: true, async json() { return { courseTitle: 'My Course', videos }; } };
      }
      if (String(url).includes('/api/learning/capture')) {
        const body = JSON.parse(opts.body);
        captured.push({ url: String(url), body });
        if (dieAt !== null && captured.length >= dieAt) {
          // Simulate the tab being closed / worker dying: hard-abort the walk
          // right after the checkpoint for this video is written.
          throw new Error('__HARNESS_ABORT__');
        }
        return { ok: true, async json() { return { ok: true, job: { status: 'done', file: `${body.videoSlug}.mp4` } }; } };
      }
      if (String(url).includes('/api/learning/runner-log')) {
        const body = JSON.parse(opts.body);
        runnerLog.push(body);
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    structuredClone,
  };
  sandbox.globalThis = sandbox;
  return { sandbox, els, captured, runnerLog, tabEvents };
}

async function run(opts) {
  const built = buildSandbox(opts);
  const ctx = vm.createContext(built.sandbox);
  // runner.js kicks off its own IIFE; wrap so we can await the walk settling.
  vm.runInContext(RUNNER, ctx, { filename: 'runner.js' });
  // Drain the microtask/timer queue until the walk stops progressing.
  for (let i = 0; i < 5000; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5000; i++) await Promise.resolve();
  return built;
}

const videos = Array.from({ length: 12 }, (_, i) => ({
  slug: `v${i + 1}`,
  title: `Video ${i + 1}`,
  chapterTitle: `Chapter ${Math.floor(i / 4) + 1}`,
}));

// --- 1. clean full walk ----------------------------------------------------
{
  const storage = {};
  const { captured, els } = await run({ videos, storage });
  assert.equal(captured.length, 12, `expected 12 captures, got ${captured.length}`);
  assert.deepEqual(captured.map((c) => c.body.videoSlug), videos.map((v) => v.slug));
  assert.ok(captured.every((c) => c.body.route === 'capture-all-runner'), 'every capture tagged capture-all-runner');
  assert.deepEqual(captured.map((c) => c.body.index), videos.map((_, i) => i + 1), 'index is 1-based and sequential');
  assert.ok(captured.every((c) => c.body.total === 12), 'total is the full course length');
  // Default resolution is the highest hint, surfaced as a query string on the
  // capture POST so the server can pin the ladder ceiling.
  assert.ok(captured.every((c) => c.url.includes('resolution=_1080')),
    `every capture POST should carry resolution=_1080, saw: ${captured.map((c) => c.url).join(', ')}`);
  assert.equal(storage['linkedinrec.walk'], undefined, 'checkpoint cleared after a clean finish');
  assert.match(els.status.textContent, /finished/);
  console.log('PASS 1  clean walk: 12/12 captured in order, tagged, resolution=_1080 sent, checkpoint cleared');
}

// --- 2. interrupted walk checkpoints, then resumes exactly once ------------
{
  const storage = {};
  const first = await run({ videos, storage, dieAt: 5 });
  assert.equal(first.captured.length, 5, `first leg should abort during video 5, got ${first.captured.length}`);
  const cp = storage['linkedinrec.walk'];
  assert.ok(cp, 'checkpoint persisted after interruption');
  assert.equal(cp.courseSlug, 'my-course');
  assert.equal(cp.videos.length, 12);
  // Video 5's capture threw before its checkpoint, so cursor sits at 4 (0-based)
  // and video 5 is retried — at most one repeat, never a skip.
  assert.equal(cp.cursor, 4, `cursor should be 4 after 4 committed videos, got ${cp.cursor}`);
  assert.equal(cp.resolution, '_1080', 'resolution pinned to the dropdown value at walk start');

  const second = await run({ videos, storage });
  const resumedSlugs = second.captured.map((c) => c.body.videoSlug);
  assert.deepEqual(resumedSlugs, ['v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v12'],
    `resume should pick up at v5, got ${resumedSlugs.join(',')}`);
  const total = 4 + resumedSlugs.length;
  assert.equal(total, 12, 'no video skipped across the interruption');
  // Resume uses the checkpoint's pinned resolution even if the dropdown is
  // changed in the UI.
  assert.ok(second.captured.every((c) => c.url.includes('resolution=_1080')),
    `resume should preserve pinned resolution, saw: ${second.captured.map((c) => c.url).join(', ')}`);
  assert.equal(storage['linkedinrec.walk'], undefined, 'checkpoint cleared once the resumed leg finishes');
  console.log('PASS 2  interrupt after 4: resumed at v5, 12/12 covered, resolution preserved across resume');
}

// --- 3. a failing video does not abort the rest of the walk ----------------
{
  const storage = {};
  const { captured, runnerLog, els } = await run({ videos, storage, failAt: new Set(['v3', 'v7']) });
  const slugs = captured.map((c) => c.body.videoSlug);
  assert.ok(!slugs.includes('v3') && !slugs.includes('v7'), 'failed videos never reach the server');
  assert.equal(captured.length, 10, `10 of 12 should capture, got ${captured.length}`);
  assert.ok(slugs.includes('v12'), 'walk continued to the last video despite mid-course failures');
  assert.match(els.status.textContent, /2 failed/);
  assert.ok(storage['linkedinrec.walk'], 'checkpoint retained so failures can be retried');
  console.log('PASS 3  2 failures mid-course: walk continued to v12, checkpoint kept for retry');
}

// --- 4. tab bookkeeping ----------------------------------------------------
// The walker uses ONE persistent tab for the whole course (not one per video)
// to avoid LinkedIn's per-session rate-limit on /learning-api/. Verify:
//   - exactly one tab opened at the start, closed at the end
//   - 12 tab.update() calls (one per video) — none open new tabs
//   - the persistent tab never gets recreated mid-walk
{
  const storage = {};
  const { tabEvents } = await run({ videos, storage });
  const creates = tabEvents.filter((e) => e[0] === 'create').length;
  const removes = tabEvents.filter((e) => e[0] === 'remove').length;
  const updates = tabEvents.filter((e) => e[0] === 'update').length;
  assert.equal(creates, 1, `expected exactly 1 persistent tab opened, got ${creates}`);
  assert.equal(removes, 1, `expected exactly 1 tab closed, got ${removes}`);
  assert.equal(updates, videos.length, `expected ${videos.length} update() calls (one per video), got ${updates}`);
  // All updates target the same tab id as the create.
  const createdId = tabEvents.find((e) => e[0] === 'create')[1];
  assert.ok(tabEvents.filter((e) => e[0] === 'update').every((e) => e[1] === createdId),
    'every update() should target the persistent tab');
  console.log(`PASS 4  tab hygiene: 1 opened, 1 closed, ${updates} navigations on the same tab`);
}

// --- 5. dropdown ceiling is honored end-to-end ------------------------------
{
  const storage = {};
  const { captured, els } = await run({ videos, storage, resolutionSelect: '_720' });
  assert.equal(captured.length, 12, 'full walk should still complete at 720p');
  assert.ok(captured.every((c) => c.url.includes('resolution=_720')),
    `every capture POST should carry resolution=_720, saw: ${captured.map((c) => c.url).join(', ')}`);
  assert.ok(els.resolution.disabled, 'dropdown locked after the walk starts');
  console.log('PASS 5  _720 ceiling flows to capture POSTs and locks the dropdown');
}

// --- 6. dropdown change mid-walk is ignored (no half-cooked batches) --------
{
  const storage = {};
  const first = await run({ videos, storage, resolutionSelect: '_1080', dieAt: 3 });
  assert.equal(first.captured.length, 3);
  assert.ok(first.captured.every((c) => c.url.includes('resolution=_1080')));
  // Simulate the user moving the dropdown to _720 before re-opening.
  storage['__change_me'] = true;
  const second = await run({ videos, storage, resolutionSelect: '_720' });
  assert.ok(second.captured.every((c) => c.url.includes('resolution=_1080')),
    `resume must keep the original pinned ceiling, saw: ${second.captured.map((c) => c.url).join(', ')}`);
  console.log('PASS 6  mid-walk dropdown change does not flip the resume ceiling');
}

// --- 7. silent skips now surface via /api/learning/runner-log ---------------
// This is the regression test for the actual bug the user hit: the walk
// advancing past failed videos with no log trace. Pre-fix, v3 and v7 would
// be checkpointed past and the gap would be invisible. Post-fix, every
// non-success outcome posts to /api/learning/runner-log with the failure
// reason so the log shows exactly which videos were skipped and why.
{
  const storage = {};
  const { captured, runnerLog, els } = await run({ videos, storage, failAt: new Set(['v3', 'v7']) });
  assert.equal(captured.length, 10, '10 successes');
  assert.ok(!captured.some((c) => c.body.videoSlug === 'v3' || c.body.videoSlug === 'v7'),
    'v3 and v7 never reach the capture POST');
  // The new side channel reports each failed video to the server log so the
  // skip is visible in _logs/linkedinrec.log instead of vanishing.
  const reportedSkips = runnerLog.filter((r) => r.outcome === 'failed');
  assert.deepEqual(reportedSkips.map((r) => r.videoSlug).sort(), ['v3', 'v7'],
    `runner-log should report v3 and v7 as failed, got: ${JSON.stringify(reportedSkips)}`);
  assert.ok(reportedSkips.every((r) => /content-script unreachable/.test(String(r.error || ''))),
    `each skip should carry the failure reason, got: ${JSON.stringify(reportedSkips.map((r) => r.error))}`);
  // The upstreamStatus field also flows through, so a 429 from LinkedIn's
  // edge can be distinguished from a half-hydrated page.
  assert.ok(reportedSkips.every((r) => 'upstreamStatus' in r),
    `runner-log entries should carry upstreamStatus, got: ${JSON.stringify(reportedSkips)}`);
  console.log('PASS 7  failed videos are reported via /api/learning/runner-log, gap is visible');
}

// --- 8. rate-limit pacing: 429 widens the inter-video delay -----------------
// When LinkedIn's edge returns 429, the walk backs off 8s instead of the
// default 2.5s so the limiter can drain. The harness's collapsed setTimeout
// makes the pacing invisible to wall-clock but the rateLimited flag should
// still flow into the result shape that the runner uses to choose the delay.
{
  const storage = {};
  const { captured, runnerLog, els } = await run({ videos, storage, failAt: new Set(['v3']), rateLimitAt: new Set(['v7']) });
  // v3 and v7 fail at the page-fetch step; v7 also tags itself rateLimited.
  const v7 = runnerLog.find((r) => r.videoSlug === 'v7');
  assert.ok(v7, 'v7 should appear in runner-log');
  assert.equal(v7.upstreamStatus, 429, `v7 should carry upstreamStatus=429, got: ${v7.upstreamStatus}`);
  assert.ok(captured.every((c) => !['v3', 'v7'].includes(c.body.videoSlug)),
    'v3 and v7 should never reach the capture POST');
  console.log('PASS 8  429 status flows through to runner-log for backoff decision');
}

// --- 9. 429 retry: same video retried in-place, not skipped -----------------
// This is the user's reported symptom: previously, a 429 caused the walk to
// advance past the failing video, leaving a permanent gap. Now the walk
// retries the same video until it succeeds (or hits the attempt cap).
// The harness simulates "LinkedIn's 429 clears on the 3rd attempt".
{
  const storage = {};
  const { captured, runnerLog, els } = await run({
    videos,
    storage,
    rateLimitAt: new Set(['v5']),                  // v5 always 429s in the harness
    rateLimitRecoverAfter: new Map([['v5', 3]]),  // …except after 3 attempts
  });
  // v5 should appear in captured (not skipped) because the runner retried
  // until success instead of advancing past it on the first 429.
  const v5Capture = captured.find((c) => c.body.videoSlug === 'v5');
  assert.ok(v5Capture, `v5 should have been captured after retrying through 429, captured: ${captured.map((c) => c.body.videoSlug).join(',')}`);
  // And every video should be captured — no gaps left.
  assert.equal(captured.length, videos.length, `every video should be captured, got ${captured.length}/${videos.length}`);
  // The runner-log should not have a "failed" entry for v5.
  const v5Failures = runnerLog.filter((r) => r.videoSlug === 'v5' && r.outcome === 'failed');
  assert.equal(v5Failures.length, 0, `v5 should not appear as failed in runner-log, got: ${JSON.stringify(v5Failures)}`);
  console.log('PASS 9  429 retries the same video in-place until success — no gap');
}

// --- 10. 429 retry budget: persistent 429 gives up after the cap ------------
// If the throttle never lifts, the walk eventually marks the video failed
// and continues, instead of pinning forever.
{
  const storage = {};
  const { captured, runnerLog } = await run({
    videos: videos.slice(0, 3),
    storage,
    rateLimitAt: new Set(['v2']),
    // never recovers
  });
  assert.equal(captured.length, 2, `v1 and v3 should capture, v2 should fail. got: ${captured.map((c) => c.body.videoSlug)}`);
  const v2Failures = runnerLog.filter((r) => r.videoSlug === 'v2' && r.outcome === 'failed');
  assert.ok(v2Failures.length > 0, `v2 should appear as failed after retry cap, got: ${JSON.stringify(v2Failures)}`);
  console.log('PASS 10  persistent 429 exhausts retry budget and continues');
}

// --- 11. stale content script aborts at once with a clear instruction ------
// Chrome serves content scripts from the snapshot taken at the last extension
// reload. A runner that has been fixed but a content script that has not would
// otherwise fail on every video with a puzzling error (that is exactly what
// produced the 403 "CSRF check failed." round trip).
{
  const storage = {};
  const { captured, runnerLog, els } = await run({ videos, storage, contentBuild: null });
  assert.equal(captured.length, 0, `a stale content script must not reach the server, got ${captured.length} captures`);
  assert.match(els.status.textContent, /stale/i, `expected a stale-build badge, got: ${els.status.textContent}`);
  assert.ok(runnerLog.some((r) => /reload the extension/.test(String(r.error || ''))),
    `the runner-log entry should name the fix, got: ${JSON.stringify(runnerLog)}`);
  console.log('PASS 11  stale content-script build aborts with a reload instruction');
}

console.log('\nall runner harness checks passed');
