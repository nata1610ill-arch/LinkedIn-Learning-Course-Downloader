import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { atomicDownload, isValidMedia } from '../lib/media.js';

async function missing(file) {
  try { await stat(file); return false; } catch { return true; }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('isValidMedia rejects missing and invalid files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-media-'));
  try {
    const invalid = path.join(dir, 'invalid.mp4');
    await writeFile(invalid, 'not video');
    assert.equal(await isValidMedia(path.join(dir, 'missing.mp4')), false);
    assert.equal(await isValidMedia(invalid), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomicDownload never leaves a final file when validation fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-media-'));
  const destination = path.join(dir, 'video.mp4');
  try {
    await assert.rejects(
      atomicDownload({
        url: 'https://example.invalid/video.mp4',
        destination,
        headers: {},
        fetchImpl: async () => new Response('not video'),
      }),
      /invalid media/,
    );
    assert.equal(await missing(destination), true);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomicDownload promotes only validated remux output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-media-'));
  const destination = path.join(dir, 'video.mp4');
  const runProcess = async (_command, args) => {
    if (args[0] === '-v') return { code: 0, stdout: '{"streams":[{"codec_type":"video","width":640,"height":360}]}' };
    const source = args[args.indexOf('-i') + 1];
    await writeFile(args.at(-1), await readFile(source));
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const info = await atomicDownload({
      url: 'https://cdn.test/video.mp4',
      destination,
      headers: {},
      fetchImpl: async () => new Response('media bytes'),
      runProcess,
    });
    assert.equal((await readFile(destination, 'utf8')), 'media bytes');
    assert.equal(info.width, 640);
    assert.equal(info.height, 360);
    assert.deepEqual(await readdir(dir), ['video.mp4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomicDownload remuxes successfully with real ffmpeg', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-media-'));
  const source = path.join(dir, 'source.mp4');
  const destination = path.join(dir, 'video.mp4');
  try {
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
    ]);
    const bytes = await readFile(source);
    await rm(source);
    const info = await atomicDownload({
      url: 'https://cdn.test/video.mp4',
      destination,
      headers: {},
      fetchImpl: async () => new Response(bytes),
    });
    assert.equal(info.width, 16);
    assert.equal(info.height, 16);
    assert.deepEqual(await readdir(dir), ['video.mp4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent downloads of one destination share one operation safely', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-media-'));
  const destination = path.join(dir, 'video.mp4');
  let fetchCount = 0;
  const runProcess = async (command, args) => {
    if (command === 'ffprobe') {
      try {
        await stat(args.at(-1));
        return { code: 0, stdout: '{"streams":[{"codec_type":"video","width":640,"height":360}]}' };
      } catch {
        return { code: 1, stdout: '' };
      }
    }
    const source = args[args.indexOf('-i') + 1];
    await writeFile(args.at(-1), await readFile(source));
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = {
    url: 'https://cdn.test/video.mp4', destination, headers: {}, runProcess,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(`media-${fetchCount}`);
    },
  };
  try {
    const [first, second] = await Promise.all([
      atomicDownload(options),
      atomicDownload(options),
    ]);
    assert.equal(first.height, 360);
    assert.equal(second.height, 360);
    assert.equal(fetchCount, 1);
    assert.equal(await readFile(destination, 'utf8'), 'media-1');
    assert.deepEqual(await readdir(dir), ['video.mp4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
