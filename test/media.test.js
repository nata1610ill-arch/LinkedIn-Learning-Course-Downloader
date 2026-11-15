import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  atomicDownload,
  downloadHls,
  isValidMedia,
  parseAudioRendition,
  parseHlsVariants,
  parseMediaPlaylist,
  pickHlsVariant,
} from '../lib/media.js';

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

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES,URI="audio/128k/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="alt",URI="audio/64k/index.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=960x540,AUDIO="aud"',
  'video/540/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"',
  'video/720/index.m3u8',
].join('\n');

test('parseHlsVariants resolves renditions and pickHlsVariant honours the cap', () => {
  const variants = parseHlsVariants(MASTER_PLAYLIST, 'https://cdn.test/master.m3u8');
  assert.equal(variants.length, 2);
  assert.equal(variants[0].url, 'https://cdn.test/video/540/index.m3u8');
  assert.equal(pickHlsVariant(variants).height, 720);
  assert.equal(pickHlsVariant(variants, 540).height, 540);
  // a cap below every rendition still yields the lowest available one
  assert.equal(pickHlsVariant(variants, 240).height, 540);
});

test('parseAudioRendition prefers the default audio group', () => {
  const audio = parseAudioRendition(MASTER_PLAYLIST, 'https://cdn.test/master.m3u8');
  assert.equal(audio.url, 'https://cdn.test/audio/128k/index.m3u8');
  assert.equal(audio.isDefault, true);
  assert.equal(parseAudioRendition('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8', 'https://cdn.test/m'), null);
});

test('parseMediaPlaylist collects the init segment and every segment', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg1',
    '#EXTINF:4.0,',
    'https://other.test/seg2?e=1',
  ].join('\n');
  const media = parseMediaPlaylist(playlist, 'https://cdn.test/video/720/index.m3u8');
  assert.equal(media.init, 'https://cdn.test/video/720/init.mp4');
  assert.deepEqual(media.segments, [
    'https://cdn.test/video/720/seg1',
    'https://other.test/seg2?e=1',
  ]);
  assert.equal(media.encrypted, false);
  assert.equal(media.byterange, false);

  const encrypted = parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\nseg', 'https://cdn.test/p.m3u8');
  assert.equal(encrypted.encrypted, true);
  const byterange = parseMediaPlaylist('#EXTM3U\n#EXT-X-BYTERANGE:100@0\nseg', 'https://cdn.test/p.m3u8');
  assert.equal(byterange.byterange, true);
});

test('downloadHls concatenates segments and muxes the audio rendition', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-hls-'));
  const destination = path.join(dir, 'video.mp4');
  const requested = [];
  const bodies = {
    'https://cdn.test/master.m3u8': MASTER_PLAYLIST,
    'https://cdn.test/video/720/index.m3u8':
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg1.m4s\n#EXTINF:2,\nseg2.m4s',
    'https://cdn.test/video/720/init.mp4': 'VINIT',
    'https://cdn.test/video/720/seg1.m4s': 'V1',
    'https://cdn.test/video/720/seg2.m4s': 'V2',
    'https://cdn.test/audio/128k/index.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="ainit.mp4"\n#EXTINF:2,\naseg1.m4s',
    'https://cdn.test/audio/128k/ainit.mp4': 'AINIT',
    'https://cdn.test/audio/128k/aseg1.m4s': 'A1',
  };
  const fetchImpl = async (url) => {
    requested.push(url);
    const body = bodies[url];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  };
  let videoBytes = null;
  let audioBytes = null;
  const runProcess = async (command, args) => {
    if (command === 'ffprobe') {
      return { code: 0, stdout: '{"streams":[{"codec_type":"video","width":1280,"height":720}]}' };
    }
    const first = args[args.indexOf('-i') + 1];
    const second = args.slice(args.indexOf('-i') + 2).find((arg, index, all) => all[index - 1] === '-i');
    videoBytes = await readFile(first, 'utf8');
    if (second) audioBytes = await readFile(second, 'utf8');
    await writeFile(args.at(-1), 'muxed');
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const info = await downloadHls({
      url: 'https://cdn.test/master.m3u8',
      destination,
      headers: {},
      fetchImpl,
      processRunner: runProcess,
    });
    assert.equal(info.height, 720);
    assert.equal(info.variantHeight, 720);
    assert.equal(info.variants, 2);
    assert.equal(info.audio, true);
    assert.equal(videoBytes, 'VINITV1V2');
    assert.equal(audioBytes, 'AINITA1');
    assert.ok(!requested.includes('https://cdn.test/video/540/index.m3u8'));
    assert.equal(await readFile(destination, 'utf8'), 'muxed');
    assert.deepEqual(await readdir(dir), ['video.mp4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloadHls reports playlist and segment failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedinrec-hls-'));
  const destination = path.join(dir, 'video.mp4');
  try {
    await assert.rejects(
      downloadHls({
        url: 'https://cdn.test/master.m3u8',
        destination,
        headers: {},
        fetchImpl: async () => new Response('nope', { status: 403 }),
      }),
      /playlist request failed with status 403/,
    );
    await assert.rejects(
      downloadHls({
        url: 'https://cdn.test/p.m3u8',
        destination,
        headers: {},
        fetchImpl: async (url) => {
          if (url.endsWith('p.m3u8')) return new Response('#EXTM3U\n#EXTINF:2,\nseg1');
          return new Response('nope', { status: 403 });
        },
        processRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
      /segment request failed with status 403/,
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
