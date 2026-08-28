import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const activeDownloads = new Map();

export function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function probeMedia(file, processRunner = runProcess) {
  try {
    const result = await processRunner('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
    ]);
    if (result.code !== 0) return null;
    const data = JSON.parse(result.stdout || '{}');
    const video = Array.isArray(data.streams)
      ? data.streams.find((stream) => stream.codec_type === 'video')
      : null;
    if (!video) return null;
    return {
      width: Number(video.width || 0) || null,
      height: Number(video.height || 0) || null,
      bitrate: Number(video.bit_rate || (data.format && data.format.bit_rate) || 0) || null,
      durationInSeconds: Number(video.duration || (data.format && data.format.duration) || 0) || null,
      codec: video.codec_name || null,
    };
  } catch {
    return null;
  }
}

export async function isValidMedia(file, processRunner = runProcess) {
  return !!(await probeMedia(file, processRunner));
}

async function performAtomicDownload({
  url,
  destination,
  headers,
  fetchImpl = fetch,
  runProcess: processRunner = runProcess,
}) {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const part = `${destination}.${nonce}.part`;
  const remux = `${destination}.${nonce}.remux.mp4`;

  try {
    const response = await fetchImpl(url, { headers, redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`upstream media request failed with status ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: 'wx' }));

    const downloaded = await probeMedia(part, processRunner);
    if (!downloaded) throw new Error('invalid media download');

    const remuxResult = await processRunner('ffmpeg', [
      '-y', '-i', part, '-c', 'copy', '-movflags', '+faststart', remux,
    ]);
    if (remuxResult.code !== 0) {
      throw new Error(`ffmpeg exit ${remuxResult.code}: ${(remuxResult.stderr || '').split('\n').slice(-3).join('\n')}`);
    }

    const finalInfo = await probeMedia(remux, processRunner);
    if (!finalInfo) throw new Error('invalid media after remux');
    await rename(remux, destination);
    return finalInfo;
  } finally {
    await rm(part, { force: true });
    await rm(remux, { force: true });
  }
}

export function atomicDownload(options) {
  const existing = activeDownloads.get(options.destination);
  if (existing) return existing;

  const operation = performAtomicDownload(options);
  activeDownloads.set(options.destination, operation);
  operation.finally(() => {
    if (activeDownloads.get(options.destination) === operation) {
      activeDownloads.delete(options.destination);
    }
  }).catch(() => {});
  return operation;
}
