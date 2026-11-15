import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
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

function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

// LinkedIn's audio lives in a separate `demuxed-audio-…` rendition that the
// master playlist announces via `#EXT-X-MEDIA:TYPE=AUDIO,URI="…"`. Without it
// the downloaded video would be silent.
export function parseAudioRendition(text, baseUrl) {
  const candidates = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('#EXT-X-MEDIA') || !/TYPE=AUDIO/i.test(line)) continue;
    const uriMatch = line.match(/URI="([^"]+)"/);
    if (!uriMatch) continue;
    const url = resolveUri(uriMatch[1], baseUrl);
    if (!url) continue;
    candidates.push({
      url,
      isDefault: /DEFAULT=YES/i.test(line),
      language: (line.match(/LANGUAGE="([^"]+)"/) || [])[1] || null,
    });
  }
  return candidates.find((candidate) => candidate.isDefault) || candidates[0] || null;
}

// Parse a media playlist (the per-rendition one) into init segment + segments.
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  let init = null;
  let encrypted = false;
  let byterange = false;
  const segments = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-MAP')) {
        const mapMatch = line.match(/URI="([^"]+)"/);
        if (mapMatch) init = resolveUri(mapMatch[1], baseUrl) || init;
      }
      if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/i.test(line)) encrypted = true;
      if (line.startsWith('#EXT-X-BYTERANGE')) byterange = true;
      continue;
    }
    const url = resolveUri(line, baseUrl);
    if (url) segments.push(url);
  }
  return { init, segments, encrypted, byterange };
}

async function fetchPlaylist(url, headers, fetchImpl) {
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`playlist request failed with status ${response.status}`);
  const text = await response.text();
  if (!/^#EXTM3U/m.test(text)) throw new Error('streamingUrl did not return an m3u8 playlist');
  return { text, url: response.url || url };
}

async function fetchSegment(url, headers, fetchImpl) {
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`segment request failed with status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function writeChunk(stream, buffer) {
  if (!stream.write(buffer)) {
    await new Promise((resolve) => stream.once('drain', resolve));
  }
}

// ffmpeg refuses LinkedIn's segments: they end in `/2/…?e=…` with no extension,
// which trips its `allowed_segment_extensions` guard (even with `ALL`). So pull
// the playlist apart and concatenate init + segments ourselves — these are CMAF
// fragments, so byte concatenation yields a valid fragmented MP4.
async function downloadRendition({ playlistUrl, destination, headers, fetchImpl, concurrency = 4 }) {
  const { text, url } = await fetchPlaylist(playlistUrl, headers, fetchImpl);
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const nested = pickHlsVariant(parseHlsVariants(text, url), null);
    if (!nested) throw new Error('nested hls playlist had no variants');
    return downloadRendition({ playlistUrl: nested.url, destination, headers, fetchImpl, concurrency });
  }

  const media = parseMediaPlaylist(text, url);
  if (media.encrypted) throw new Error('encrypted hls rendition is not supported');
  if (media.byterange) throw new Error('hls byterange renditions are not supported');
  if (!media.segments.length) throw new Error('hls playlist has no segments');

  const out = createWriteStream(destination, { flags: 'w' });
  try {
    if (media.init) await writeChunk(out, await fetchSegment(media.init, headers, fetchImpl));
    for (let i = 0; i < media.segments.length; i += concurrency) {
      const batch = media.segments.slice(i, i + concurrency);
      const buffers = await Promise.all(batch.map((segment) => fetchSegment(segment, headers, fetchImpl)));
      for (const buffer of buffers) await writeChunk(out, buffer);
    }
    await new Promise((resolve, reject) => {
      out.end((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    out.destroy();
    throw error;
  }
}

// Parse an HLS master playlist into its variants. LinkedIn serves a master
// playlist with `#EXT-X-STREAM-INF:...RESOLUTION=1280x720...BANDWIDTH=...`
// lines; the progressive URL always points at one fixed rendition instead.
export function parseHlsVariants(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const heightMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
    let uri = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;
    try {
      variants.push({
        height: heightMatch ? Number(heightMatch[1]) : null,
        bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : null,
        url: new URL(uri, baseUrl).toString(),
      });
    } catch {
      /* unresolvable URI — skip it */
    }
  }
  return variants;
}

export function pickHlsVariant(variants, maxHeight = null) {
  const usable = (variants || []).filter((variant) => variant && variant.url);
  if (!usable.length) return null;
  const capped = maxHeight
    ? usable.filter((variant) => !variant.height || variant.height <= maxHeight)
    : usable;
  // Nothing fits under the cap: the closest offer is the smallest rendition, so
  // a 540p request against a 720p-only video still downloads 720p.
  const pool = capped.length ? capped : usable;
  const ascending = !capped.length;
  return [...pool].sort((a, b) =>
    ascending
      ? (Number(a.height || 0) - Number(b.height || 0)) ||
        (Number(a.bandwidth || 0) - Number(b.bandwidth || 0))
      : (Number(b.height || 0) - Number(a.height || 0)) ||
        (Number(b.bandwidth || 0) - Number(a.bandwidth || 0))
  )[0];
}

// Inspect a playlist without downloading it: how many renditions does it have
// and which one would we pick? Used to decide whether a file already on disk is
// worth replacing.
export async function bestHlsVariant({ url, headers, maxHeight = null, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`playlist request failed with status ${response.status}`);
  const text = await response.text();
  if (!/^#EXTM3U/m.test(text)) throw new Error('streamingUrl did not return an m3u8 playlist');
  const variants = parseHlsVariants(text, url);
  return { count: variants.length, picked: pickHlsVariant(variants, maxHeight) };
}

// Download the best rendition of an HLS playlist: fetch every segment of the
// chosen video rendition plus the audio rendition, mux both losslessly, then
// hand the result over as the finished mp4.
export async function downloadHls({
  url,
  destination,
  headers,
  maxHeight = null,
  fetchImpl = fetch,
  processRunner = runProcess,
}) {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workDir = `${destination}.${nonce}.hls`;
  const videoFile = path.join(workDir, 'video.mp4');
  const audioFile = path.join(workDir, 'audio.mp4');
  const muxed = `${destination}.${nonce}.hls.mp4`;

  await mkdir(workDir, { recursive: true });
  try {
    const master = await fetchPlaylist(url, headers, fetchImpl);
    const isMaster = /#EXT-X-STREAM-INF/i.test(master.text);
    const variants = isMaster ? parseHlsVariants(master.text, master.url) : [];
    const picked = isMaster ? pickHlsVariant(variants, maxHeight) : null;
    if (isMaster && !picked) throw new Error('hls master playlist had no variants');

    await downloadRendition({
      playlistUrl: picked ? picked.url : url,
      destination: videoFile,
      headers,
      fetchImpl,
    });
    const videoInfo = await probeMedia(videoFile, processRunner);
    if (!videoInfo) throw new Error('downloaded video rendition is not valid media');

    const audio = isMaster ? parseAudioRendition(master.text, master.url) : null;
    const args = ['-y'];
    if (audio) {
      await downloadRendition({ playlistUrl: audio.url, destination: audioFile, headers, fetchImpl });
      args.push('-i', videoFile, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0?');
    } else {
      args.push('-i', videoFile, '-map', '0:v:0', '-map', '0:a:0?');
    }
    args.push('-c', 'copy', '-movflags', '+faststart', muxed);

    const result = await processRunner('ffmpeg', args);
    if (result.code !== 0) {
      const tail = (result.stderr || '').split('\n').slice(-3).join('\n');
      throw new Error(`ffmpeg mux exit ${result.code}: ${tail}`);
    }

    const info = await probeMedia(muxed, processRunner);
    if (!info) throw new Error('invalid media after hls mux');
    await rename(muxed, destination);
    return {
      ...info,
      variants: variants.length,
      variantHeight: picked ? picked.height : null,
      audio: !!audio,
    };
  } finally {
    await rm(muxed, { force: true });
    await rm(workDir, { recursive: true, force: true });
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
