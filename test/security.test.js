import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [ui, server, background, popup] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../server.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/background.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'),
]);

test('dashboard does not render API data through innerHTML', () => {
  assert.doesNotMatch(ui, /\.innerHTML\s*=/);
});

test('server does not allow wildcard CORS and protects capture routes', () => {
  assert.doesNotMatch(server, /access-control-allow-origin['"]?\s*:\s*['"]\*['"]/i);
  assert.match(server, /x-linkedinrec-client/);
  assert.match(server, /isTrustedMutationRequest/);
});

test('extension marks capture requests and popup never previews cookie bytes', () => {
  assert.match(background, /x-linkedinrec-client/);
  assert.doesNotMatch(popup, /slice\(0,\s*24\)|function preview/);
  assert.match(popup, /present/);
});

test('media errors do not include signed source URLs', async () => {
  const media = await readFile(new URL('../lib/media.js', import.meta.url), 'utf8');
  assert.doesNotMatch(media, /upstream \$\{response\.status\} for \$\{url\}/);
});
