export function findVideoObject(json, courseSlug, videoSlug) {
  if (!json || typeof json !== 'object') return null;

  if (Array.isArray(json.elements) && json.elements.length) {
    const node = json.elements[0];
    return node && typeof node === 'object' ? { node, source: 'elements[0]' } : null;
  }

  if (Array.isArray(json.included)) {
    const matchesRequestedVideo = (node) => !videoSlug ||
      (node && node.selectedVideo && node.selectedVideo.slug === videoSlug);
    const byExact = json.included.find((node) => node && node.slug === courseSlug &&
      matchesRequestedVideo(node));
    const byStripped = !byExact && json.included.find((node) => {
      if (!node || !node.slug) return false;
      return node.slug.replace(/-\d+$/, '') === courseSlug && matchesRequestedVideo(node);
    });
    const bySelectedVideo = json.included.find((node) => node && node.selectedVideo && (
      !videoSlug || node.selectedVideo.slug === videoSlug
    ));
    const node = byExact || byStripped || bySelectedVideo || json.included.find((item) => item && item.selectedVideo);
    if (node) {
      const source = byExact
        ? 'included[exact-slug]'
        : byStripped
          ? 'included[stripped-slug]'
          : bySelectedVideo
            ? 'included[match-selectedVideo]'
            : 'included[fallback-selectedVideo]';
      return { node, source };
    }
  }

  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    return { node: json.data, source: 'data' };
  }
  return null;
}

function findSelectedVideo(node) {
  if (!node || typeof node !== 'object') return null;
  const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
  return node.selectedVideo || attributes.selectedVideo || null;
}

function summarizeFormat(format) {
  if (!format) return null;
  return {
    width: Number(format.width || 0) || null,
    height: Number(format.height || 0) || null,
    bitrate: Number(format.bitrate || format.bitRate || 0) || null,
    mimeType: format.mimeType || null,
  };
}

export function extractVideoMetadata(json, courseSlug, videoSlug) {
  const found = findVideoObject(json, courseSlug, videoSlug);
  if (!found) return null;

  const { node } = found;
  const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
  const locked = attributes.isLocked === true || attributes.lockedState === 'LOCKED' ||
    node.isLocked === true || node.lockedState === 'LOCKED';
  const selected = findSelectedVideo(node);
  if (!selected) return null;
  const selectedAttrs = selected.attributes && typeof selected.attributes === 'object' ? selected.attributes : selected;
  const formats = selected.formats || selectedAttrs.formats;
  let chosenFormat = null;
  let progressiveUrl = null;

  const urlField = selected.url || selectedAttrs.url;
  if (urlField && typeof urlField === 'object' && urlField.progressiveUrl) {
    progressiveUrl = urlField.progressiveUrl;
  }

  if (Array.isArray(formats) && formats.length) {
    const progressiveEntries = formats.filter((format) => format &&
      (format.type === 'progressive' || format.mimeType === 'video/mp4') && format.url);
    if (progressiveEntries.length) {
      chosenFormat = [...progressiveEntries].sort((a, b) => {
        const heightDifference = Number(b.height || 0) - Number(a.height || 0);
        if (heightDifference) return heightDifference;
        const bitrateDifference = Number(b.bitrate || b.bitRate || 0) - Number(a.bitrate || a.bitRate || 0);
        if (bitrateDifference) return bitrateDifference;
        return progressiveEntries.indexOf(b) - progressiveEntries.indexOf(a);
      })[0];
      progressiveUrl = chosenFormat.url;
    } else if (!progressiveUrl) {
      chosenFormat = formats.find((format) => format && format.url) || null;
      progressiveUrl = chosenFormat && chosenFormat.url;
    }
  }

  if (!progressiveUrl && !locked) return null;

  return {
    locked,
    title: selectedAttrs.title || selected.title || attributes.title || '',
    durationInSeconds: Number(selectedAttrs.durationInSeconds || selected.durationInSeconds || attributes.durationInSeconds || 0),
    progressiveUrl,
    selectedFormat: summarizeFormat(chosenFormat),
    formats: Array.isArray(formats) ? formats : [],
    thumbnail: (selectedAttrs.thumbnail && selectedAttrs.thumbnail.url) ||
      (attributes.thumbnail && attributes.thumbnail.url) || null,
    transcriptLines: extractTranscriptLines(selectedAttrs.transcript || selected.transcript),
  };
}

// LinkedIn returns the transcript as either:
//   { lines: [{ transcriptStartAt, caption }, ...] }                (addParagraphsToTranscript=false)
//   { paragraphs: [{ transcriptStartAt, caption, ... }] }          (addParagraphsToTranscript=true)
// We normalise both into lines[ { startMs, caption } ] for downstream
// SRT writing. LinkedIn Learning serves English captions here by default.
export function extractTranscriptLines(transcript) {
  if (!transcript || typeof transcript !== 'object') return [];
  const out = [];
  if (Array.isArray(transcript.lines)) {
    for (const line of transcript.lines) {
      if (!line || typeof line !== 'object') continue;
      const caption = String(line.caption || '').trim();
      if (!caption) continue;
      const startMs = Number(line.transcriptStartAt);
      out.push({ startMs: Number.isFinite(startMs) ? startMs : 0, caption });
    }
  } else if (Array.isArray(transcript.paragraphs)) {
    for (const para of transcript.paragraphs) {
      if (!para || typeof para !== 'object') continue;
      const caption = String(para.caption || '').trim();
      if (!caption) continue;
      const startMs = Number(para.transcriptStartAt);
      out.push({ startMs: Number.isFinite(startMs) ? startMs : 0, caption });
    }
  }
  return out;
}

// Render [{ startMs, caption }] as SRT. startMs is ms since video start;
// SRT timestamps are HH:MM:SS,mmm. Lines are 1-indexed per the SRT spec.
export function renderSrt(lines) {
  if (!Array.isArray(lines) || !lines.length) return '';
  const pad = (n, w) => String(n).padStart(w, '0');
  const fmt = (ms) => {
    const safe = Math.max(0, Math.floor(Number(ms) || 0));
    const h = Math.floor(safe / 3600000);
    const m = Math.floor((safe % 3600000) / 60000);
    const s = Math.floor((safe % 60000) / 1000);
    const milli = safe % 1000;
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
  };
  return lines.map((line, idx) => {
    const start = fmt(line.startMs);
    // SRT wants end > start; if we only have one timestamp per line, give
    // it a 2-second window so players don't crash on zero-length cues.
    const end = fmt(line.endMs || (line.startMs + 2000));
    return `${idx + 1}\n${start} --> ${end}\n${line.caption}\n\n`;
  }).join('');
}
