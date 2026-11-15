// Verifies the service worker's CAPTURE_COURSE handler end-to-end against a
// stubbed chrome runtime. Reproduces the real failure mode when
// `chrome.tabs.query({url: chrome.runtime.getURL('runner.html*')})` rejects
// (which is exactly what shows up as the red error in the popup).
//
//   node test/capture-course.handler.harness.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const BG = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function makeSandbox({ activeTabs = [], allTabs = [], lastError = null } = {}) {
  const calls = [];
  const sandbox = {
    console,
    URL,
    String,
    Number,
    Array,
    Object,
    JSON,
    Date,
    Math,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: (fn) => fn(),
    clearTimeout,
    Promise,
    RegExp,
    Error,
    structuredClone,
    chrome: {
      runtime: {
        getURL(p) { return `chrome-extension://extid/${p}`; },
        onMessage: { _handlers: [], addListener(fn) { this._handlers.push(fn); } },
        sendMessage: async () => ({}),
      },
      cookies: {
        async getAll() { return [{ name: 'li_at', value: 'DUMMY_LI_AT' }, { name: 'JSESSIONID', value: 'ajax:1234' }]; },
      },
      // captureEntireCourse reads the optional corporate x-li-identity header.
      storage: {
        local: {
          async get() { return {}; },
          async set() {},
          async remove() {},
        },
      },
      tabs: {
        async query({ active, currentWindow, url } = {}) {
          calls.push(['query', { active, currentWindow, url }]);
          if (lastError && url) { throw new Error(`tabs.query: ${lastError}`); }
          if (active) return activeTabs;
          return url ? activeTabs : allTabs;
        },
        async create({ url }) { calls.push(['create', url]); return { id: 999 }; },
        async update(id, props) { calls.push(['update', id, props]); return { id }; },
      },
    },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, calls };
}

async function dispatchCaptureCourse({ tabs = [], activeTab = null, lastError = null } = {}) {
  const { sandbox, calls } = makeSandbox({ allTabs: tabs, activeTabs: activeTab ? [activeTab] : [], lastError });
  const ctx = vm.createContext(sandbox);
  vm.runInContext(BG, ctx, { filename: 'background.js' });
  const handlers = ctx.chrome.runtime.onMessage._handlers;
  assert.equal(handlers.length, 1, `expected exactly one onMessage handler, got ${handlers.length}`);
  const handler = handlers[0];

  // Pretend the popup is on a LinkedIn course root.
  const sendResponseCalls = [];
  const sendResponse = (v) => sendResponseCalls.push(v);
  handler({ type: 'CAPTURE_COURSE' }, { /* sender */ }, sendResponse);

  // Let microtasks settle.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));

  return { calls, sendResponseCalls, lastSend: sendResponseCalls[sendResponseCalls.length - 1] };
}

// --- 1. happy path: no runner tab exists -----------------------------------
{
  const { lastSend, calls } = await dispatchCaptureCourse({
    tabs: [], // no runner tab open
    activeTab: { id: 1, url: 'https://www.linkedin.com/learning/some-course' },
  });
  assert.equal(lastSend.ok, true, `expected ok, got ${JSON.stringify(lastSend)}`);
  assert.equal(lastSend.runner, 'opened', `expected 'opened', got ${lastSend.runner}`);
  const createCall = calls.find((c) => c[0] === 'create');
  assert.ok(createCall, 'a new tab should have been created');
  assert.match(createCall[1], /runner\.html\?course=some-course/, `runner URL wrong: ${createCall[1]}`);
  console.log('PASS 1  CAPTURE_COURSE opens runner tab on a clean state');
}

// --- 2. regression: tabs.query({url:…}) rejects, must NOT bubble to popup ---
{
  const { lastSend, calls } = await dispatchCaptureCourse({
    tabs: [{ id: 7, url: 'chrome-extension://extid/runner.html?course=some-course' }],
    activeTab: { id: 1, url: 'https://www.linkedin.com/learning/some-course' },
    lastError: 'No tab matches the URL pattern.',
  });
  assert.equal(lastSend.ok, true, `popup got an error instead of opening: ${JSON.stringify(lastSend)}`);
  assert.equal(lastSend.runner, 'existing', `expected existing-runner reuse, got ${lastSend.runner}`);
  assert.equal(lastSend.tabId, 7, 'wrong tab id surfaced to popup');
  // Both queries should have happened — the new code path is unfiltered.
  const queries = calls.filter((c) => c[0] === 'query');
  assert.ok(queries.length >= 2, `expected at least 2 queries, saw: ${JSON.stringify(queries)}`);
  // None of them should be using a URL match pattern anymore (regression).
  for (const q of queries) {
    assert.equal(q[1].url, undefined, `query still using URL pattern: ${JSON.stringify(q)}`);
  }
  console.log('PASS 2  no URL-pattern query used; runner reuse works without it');
}

// --- 3. fail-soft when something else throws --------------------------------
{
  const { sandbox } = makeSandbox({ activeTabs: [{ id: 1, url: 'https://www.linkedin.com/learning/some-course' }] });
  // Force captureEntireCourse to throw AFTER opening a tab, to prove the
  // async IIFE's catch block sends a structured error, not a hang/crash.
  sandbox.chrome.tabs.create = async () => { throw new Error('tabs.create denied'); };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(BG, ctx, { filename: 'background.js' });
  const handlers = ctx.chrome.runtime.onMessage._handlers;
  assert.equal(handlers.length, 1, `expected exactly one onMessage handler, got ${handlers.length}`);
  const handler = handlers[0];
  const sr = [];
  handler({ type: 'CAPTURE_COURSE' }, {}, (v) => sr.push(v));
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  const last = sr[sr.length - 1];
  assert.equal(last.ok, false, 'thrown handler should send ok:false');
  assert.match(String(last.error), /tabs\.create denied/, `error string wrong: ${last.error}`);
  console.log('PASS 3  handler exceptions surface as structured errors, never a hung popup');
}

console.log('\nall CAPTURE_COURSE handler checks passed');
