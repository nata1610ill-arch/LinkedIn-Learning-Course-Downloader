// Ad-hoc harness: runs extension/content.js against stubbed chrome/document/fetch
// to prove the page-side /learning-api/ request no longer sends a bogus
// `x-li-identity` header, and that a 403 falls back to the plain request that
// works for personal accounts.
//
//   node test/content-csrf.harness.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const CONTENT = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

const PAYLOAD = JSON.stringify({ data: { paging: {} }, included: [{ $type: 'com.linkedin.learning.api.DetailedCourse', slug: 'my-course' }] });
const EMPTY_PAYLOAD = JSON.stringify({ data: { paging: {} }, included: [] });

async function run({ html = '', cookie = 'JSESSIONID="ajax:9999"; lang=v=2', msg, respond, storedIdentity = null }) {
  const requests = [];
  const responses = [];
  let listener = null;

  const sandbox = {
    console,
    window: {},
    location: { href: 'https://www.linkedin.com/learning/my-course/v1', search: '' },
    document: { cookie, documentElement: { innerHTML: html } },
    URLSearchParams,
    Promise, Array, Object, JSON, String, Number, Boolean, RegExp, Error,
    encodeURIComponent,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        local: {
          async get(key) { return storedIdentity ? { [key]: storedIdentity } : {}; },
        },
      },
    },
    fetch: async (url, opts) => {
      const headers = { ...((opts && opts.headers) || {}) };
      requests.push({ url: String(url), headers });
      const { status, body } = respond(String(url), headers, requests.length);
      return { ok: status >= 200 && status < 300, status, async text() { return body; } };
    },
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(CONTENT, ctx, { filename: 'content.js' });
  assert.equal(typeof listener, 'function', 'content.js must register one message listener');

  assert.equal(listener(msg, {}, (v) => responses.push(v)), true, 'listener must keep the channel open');
  for (let i = 0; i < 200; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 200; i++) await Promise.resolve();

  return { requests, last: responses[responses.length - 1], responses };
}

const baseMsg = {
  type: 'PAGE_FETCH_DETAILED_COURSES',
  courseSlug: 'my-course',
  videoSlug: 'v1',
  resolution: '_1080',
};

// --- 1. junk identity scraped from the page is never sent -------------------
{
  // This is what a personal account's page HTML looks like to the old regex:
  // a JS fragment (`!0`), not an identity. 1.0.11 forwarded it verbatim and
  // LinkedIn answered 403 CSRF for every video.
  const { requests, last } = await run({
    html: '<script>window.__c={"x-li-identity":!0}</script>',
    msg: baseMsg,
    respond: () => ({ status: 200, body: PAYLOAD }),
  });
  assert.equal(requests.length, 1, `expected a single request, got ${requests.length}`);
  assert.equal(requests[0].headers['x-li-identity'], undefined,
    `bogus identity must not be sent, saw: ${requests[0].headers['x-li-identity']}`);
  assert.equal(last.ok, true);
  assert.equal(last.usedEnterpriseIdentity, false);
  assert.equal(last.enterpriseIdentity, null, 'no identity may be reported back for persistence');
  console.log('PASS 1  junk x-li-identity from page HTML is dropped, request succeeds');
}

// --- 2. 403 with an identity falls back to the plain request ----------------
{
  const { requests, last } = await run({
    html: '',
    msg: { ...baseMsg, enterpriseIdentity: 'urn:li:fsd_profile:ACoAA123456' },
    respond: (_url, headers) => headers['x-li-identity']
      ? { status: 403, body: 'CSRF check failed.' }
      : { status: 200, body: PAYLOAD },
  });
  assert.equal(requests.length, 2, `expected identity attempt + fallback, got ${requests.length}`);
  assert.equal(requests[0].headers['x-li-identity'], 'urn:li:fsd_profile:ACoAA123456');
  assert.equal(requests[1].headers['x-li-identity'], undefined, 'fallback must omit the identity');
  assert.equal(last.ok, true, `fallback should succeed, got status ${last.status}`);
  assert.equal(last.usedEnterpriseIdentity, false);
  console.log('PASS 2  403 with identity retries without it and succeeds');
}

// --- 3. enterprise `u` parameter is dropped when it is what gets rejected ---
{
  const { requests, last } = await run({
    html: '',
    msg: { ...baseMsg, account: '12345' },
    respond: (url) => url.includes('u=12345')
      ? { status: 403, body: 'CSRF check failed.' }
      : { status: 200, body: PAYLOAD },
  });
  assert.ok(requests[0].url.includes('u=12345'), 'first attempt should carry the account parameter');
  assert.ok(!requests[requests.length - 1].url.includes('u='), 'last attempt should drop it');
  assert.equal(last.ok, true);
  console.log('PASS 3  rejected `u` account parameter is dropped as a last resort');
}

// --- 4. a real 403 still fails, without hammering the same headers ----------
{
  const { requests, last } = await run({
    html: '',
    msg: baseMsg,
    respond: () => ({ status: 403, body: 'CSRF check failed.' }),
  });
  assert.equal(last.ok, false);
  assert.equal(last.status, 403);
  assert.equal(requests.length, 1, `must not retry identical rejected headers, got ${requests.length} requests`);
  console.log('PASS 4  genuine 403 is reported once, no futile retry loop');
}

// --- 5. half-hydrated page still retries until the payload arrives ----------
{
  const { requests, last } = await run({
    html: '',
    msg: baseMsg,
    respond: (_url, _headers, count) => ({ status: 200, body: count < 3 ? EMPTY_PAYLOAD : PAYLOAD }),
  });
  assert.equal(last.ok, true);
  assert.equal(requests.length, 3, `expected 2 empty payloads then success, got ${requests.length}`);
  console.log('PASS 5  empty payload retry still works (3 attempts)');
}

// --- 6. httpOnly JSESSIONID: token comes from the cookies API, not the page --
{
  const { requests, last } = await run({
    html: '',
    cookie: 'lang=v=2', // JSESSIONID is not visible to document.cookie here
    msg: { ...baseMsg, csrfToken: 'ajax:4242' },
    respond: (_url, headers) => headers['csrf-token'] === 'ajax:4242'
      ? { status: 200, body: PAYLOAD }
      : { status: 403, body: 'CSRF check failed.' },
  });
  assert.equal(requests.length, 1, `expected one request via the message token, got ${requests.length}`);
  assert.equal(requests[0].headers['csrf-token'], 'ajax:4242');
  assert.equal(last.ok, true);
  assert.equal(last.tokenSource, 'message');
  console.log('PASS 6  unreadable page cookie falls back to the cookies-API token');
}

// --- 7. no token at all: never send an empty csrf-token ---------------------
{
  const { requests, last } = await run({
    html: '',
    cookie: 'lang=v=2',
    msg: baseMsg,
    respond: () => ({ status: 200, body: PAYLOAD }),
  });
  assert.equal(requests.length, 0, 'must not fire a request that is guaranteed to 403');
  assert.equal(last.ok, false);
  assert.match(String(last.error), /CSRF token/, `expected an explicit token error, got: ${last.error}`);
  console.log('PASS 7  missing CSRF token produces no doomed request');
}

// --- 8. corporate tokens (JWT-like, with '=' padding) are sent verbatim ----
// Corporate accounts need the x-li-identity header, and their value is a long
// opaque token rather than a `urn:li:` id. It must not be filtered out.
{
  const identity = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.sig-_123=';
  const { requests, last } = await run({
    html: '',
    msg: { ...baseMsg, enterpriseIdentity: identity },
    respond: (_url, headers) => headers['x-li-identity'] === identity
      ? { status: 200, body: PAYLOAD }
      : { status: 403, body: 'CSRF check failed.' },
  });
  assert.equal(requests.length, 1, `expected the identity request to succeed first, got ${requests.length}`);
  assert.equal(requests[0].headers['x-li-identity'], identity);
  assert.equal(last.ok, true);
  assert.equal(last.usedEnterpriseIdentity, true);
  console.log('PASS 8  corporate x-li-identity token is forwarded verbatim');
}

// --- 9. identity is retried without the optional `u` account parameter -----
{
  const identity = 'urn:li:fsd_profile:ACoAA987654';
  const { requests, last } = await run({
    html: '',
    msg: { ...baseMsg, enterpriseIdentity: identity, account: '999' },
    respond: (url) => url.includes('u=999')
      ? { status: 403, body: 'CSRF check failed.' }
      : { status: 200, body: PAYLOAD },
  });
  assert.equal(requests[0].headers['x-li-identity'], identity, 'identity must be tried first, with the account param');
  assert.ok(requests[0].url.includes('u=999'));
  assert.equal(last.ok, true);
  assert.equal(last.usedEnterpriseIdentity, true, 'the identity must survive dropping `u`');
  console.log('PASS 9  identity kept while dropping a rejected `u` parameter');
}

// --- 10. saved corporate header applies without any message plumbing -------
// The popup stores the header in chrome.storage.local; the content script must
// pick it up directly, so it also works in a runner tab opened before saving.
{
  const identity = 'urn:li:fsd_profile:StoredHeader42';
  const { requests, last } = await run({
    html: '',
    msg: baseMsg,           // neither URL nor runner state carries an identity
    storedIdentity: identity,
    respond: (_url, headers) => headers['x-li-identity'] === identity
      ? { status: 200, body: PAYLOAD }
      : { status: 403, body: 'CSRF check failed.' },
  });
  assert.equal(requests[0].headers['x-li-identity'], identity,
    'the saved header must be used for the first attempt');
  assert.equal(last.ok, true);
  assert.equal(last.usedEnterpriseIdentity, true);
  assert.equal(last.identitySource, 'storage');
  console.log('PASS 10  header saved in the popup is picked up automatically');
}

// --- 11. long corporate tokens are not truncated or dropped -----------------
// A 2048-char validator cap silently discarded real tokens: the popup said
// "set (…)" while every request went out without a header.
{
  const identity = 'A' + 'b9-_'.repeat(750) + '=';   // 3003 chars
  const { requests, last } = await run({
    html: '',
    msg: baseMsg,
    storedIdentity: identity,
    respond: (_url, headers) => headers['x-li-identity'] === identity
      ? { status: 200, body: PAYLOAD }
      : { status: 403, body: 'CSRF check failed.' },
  });
  assert.equal(requests[0].headers['x-li-identity'], identity);
  assert.equal(last.usedEnterpriseIdentity, true);
  console.log('PASS 11  long corporate token (3003 chars) is forwarded in full');
}

// --- 12. a stored value that fails validation is reported, not hidden ------
{
  const { requests, last } = await run({
    html: '',
    msg: baseMsg,
    storedIdentity: 'x-li-identity: not-a-real-value',   // pasted header line
    respond: () => ({ status: 200, body: PAYLOAD }),
  });
  assert.equal(requests[0].headers['x-li-identity'], undefined, 'an invalid saved value must not be sent');
  assert.equal(last.usedEnterpriseIdentity, false);
  assert.ok(/rejected/.test(last.identityProblem || ''), `expected a rejection reason, got ${last.identityProblem}`);
  console.log('PASS 12  invalid saved header is reported instead of silently ignored');
}

// --- 13. corporate identity is read from enterpriseProfileHash ------------
// llvd documents this page-source key as the reliable way to obtain the
// x-li-identity value; page source HTML-escapes '=' as `&#61;`.
{
  const identity = 'MTU2NDI0NjQ5LDIxNzM4MTk5Nik=';
  const html = `<script>{"enterpriseProfileHash&#61;&#61;"}no</script>`
    + `<script>{"enterpriseProfileHash":"MTU2NDI0NjQ5LDIxNzM4MTk5Nik&#61;"}</script>`;
  const { requests, last } = await run({
    html,
    msg: baseMsg,
    respond: (_url, headers) => headers['x-li-identity'] === identity
      ? { status: 200, body: PAYLOAD }
      : { status: 403, body: 'CSRF check failed.' },
  });
  assert.equal(requests[0].headers['x-li-identity'], identity,
    'the HTML-escaped enterpriseProfileHash must be decoded and sent');
  assert.equal(last.ok, true);
  assert.equal(last.identitySource, 'page:enterpriseProfileHash');
  console.log('PASS 13  enterpriseProfileHash in the page source is used as the identity');
}

// --- 14. a junk enterpriseProfileHash is never sent -----------------------
{
  const { requests, last } = await run({
    html: '<script>{"enterpriseProfileHash":"!0"}</script>',
    msg: baseMsg,
    respond: () => ({ status: 200, body: PAYLOAD }),
  });
  assert.equal(requests[0].headers['x-li-identity'], undefined);
  assert.equal(last.usedEnterpriseIdentity, false);
  assert.equal(last.identitySource, 'none');
  console.log('PASS 14  junk enterpriseProfileHash is dropped');
}

// --- 15. real InitialContext block: entity-escaped, several candidates -----
// Copied from the live page (bpr-guid block): quotes arrive as &quot; and the
// block carries enterpriseProfileHash, enterpriseIdentityHash and identityToken.
// A rejected first candidate must not abort the attempt — the next one is tried.
{
  const profileHash = 'dXJuOmxpOmVudGVycHJpc2VQcm9maWxlOih1cm46bGk6ZW50ZXJwcmlzZUFjY291bnQ6NzI2MDUwOTAsOTczOTc3OTA4KQ==';
  const identityHash = 'dXJuOmxpOmVudGVycHJpc2VBdXRoVG9rZW46ZUp4alpBQUNsdUM3aTBDMEZlOU9FekMvVzZPTEVjUW8xNU9UQXpNU29oOTFNREFEQUp1UEIxZz0=';
  const token = 'ABkAAAAAAART3aIAAAAAOg25NAAAAaHfmv3DAf4hxEqY7IcyFpN2RGLV2LquvwNO';
  const html = '&lt;code id=&quot;bpr-guid-562&quot;&gt;{&quot;data&quot;:{'
    + `&quot;enterpriseProfileHash&quot;:&quot;${profileHash}&quot;,`
    + `&quot;enterpriseIdentityHash&quot;:&quot;${identityHash}&quot;,`
    + `&quot;subscription&quot;:&quot;NONE&quot;,&quot;identityToken&quot;:&quot;${token}&quot;}}&lt;/code&gt;`;
  const { requests, last } = await run({
    html,
    msg: baseMsg,
    // The documented value is rejected, the second candidate is accepted.
    respond: (_url, headers) => headers['x-li-identity'] === identityHash
      ? { status: 200, body: PAYLOAD }
      : { status: 403, body: 'CSRF check failed.' },
  });
  assert.equal(requests[0].headers['x-li-identity'], profileHash,
    'enterpriseProfileHash must be attempted first');
  assert.equal(requests[1].headers['x-li-identity'], identityHash,
    'the next candidate must be tried after a rejection');
  assert.equal(last.ok, true);
  assert.equal(last.identitySource, 'page:enterpriseIdentityHash');
  console.log('PASS 15  entity-escaped InitialContext: candidates are tried in order');
}

console.log('\nall content-script CSRF checks passed');
