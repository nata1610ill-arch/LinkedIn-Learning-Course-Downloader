function getNodeAttributes(node) {
  if (!node || typeof node !== 'object') return null;
  return node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
}

function getNodeSlug(node) {
  if (!node || typeof node !== 'object') return null;
  const attrs = getNodeAttributes(node);
  return node.slug || (attrs && attrs.slug) || null;
}

function getNodeSelectedVideo(node) {
  if (!node || typeof node !== 'object') return null;
  const attrs = getNodeAttributes(node);
  return node.selectedVideo || (attrs && attrs.selectedVideo) || null;
}

function isNodeLocked(node) {
  if (!node || typeof node !== 'object') return false;
  const attrs = getNodeAttributes(node);
  return node.isLocked === true || node.lockedState === 'LOCKED' ||
    Boolean(attrs && (attrs.isLocked === true || attrs.lockedState === 'LOCKED' || attrs.drmProtected === true)) ||
    node.drmProtected === true ||
    node.accessible === false ||
    Boolean(attrs && attrs.accessible === false) ||
    Boolean(node.contextualUnlockErrorType || (attrs && attrs.contextualUnlockErrorType));
}

export function findVideoObject(json, courseSlug, videoSlug) {
  if (!json || typeof json !== 'object') return null;

  if (Array.isArray(json.elements) && json.elements.length) {
    const node = json.elements[0];
    return node && typeof node === 'object' ? { node, source: 'elements[0]' } : null;
  }

  // Helper: check whether a URN, $id, or entityUrn string contains the
  // videoSlug (LinkedIn encodes slugs inside Voyager URNs like
  // "urn:li:lyndaVideo:(urn:li:lyndaCourse:12345,tunnelblick,de_DE)").
  const urnContainsSlug = (node, slug) => {
    if (!slug) return false;
    const id = node.$id || node.entityUrn || node.urn || '';
    return id.includes(slug);
  };

  if (Array.isArray(json.included)) {
    // 1. Direct match: an entity in included whose slug matches videoSlug
    if (videoSlug) {
      const directVideo = json.included.find((item) => item && getNodeSlug(item) === videoSlug);
      if (directVideo) {
        return { node: directVideo, source: 'included[direct-video-slug]' };
      }
    }

    const matchesRequestedVideo = (node) => {
      if (!videoSlug) return true;
      const sel = getNodeSelectedVideo(node);
      if (sel && typeof sel === 'object' && sel.slug === videoSlug) return true;
      const selUrn = node['*selectedVideo'] || (node.attributes && node.attributes['*selectedVideo']) ||
        (typeof sel === 'string' ? sel : null);
      if (selUrn) {
        const resolved = json.included.find((item) =>
          item && (item.entityUrn === selUrn || item.urn === selUrn || item.$id === selUrn)
        );
        if (resolved && getNodeSlug(resolved) === videoSlug) return true;
        // Also check if the resolved node's URN contains the videoSlug
        if (resolved && urnContainsSlug(resolved, videoSlug)) return true;
      }
      // Check if any *selectedVideo URN reference contains the videoSlug
      if (selUrn && selUrn.includes(videoSlug)) return true;
      return false;
    };

    const byExact = json.included.find((node) => node && getNodeSlug(node) === courseSlug &&
      matchesRequestedVideo(node));
    const byStripped = !byExact && json.included.find((node) => {
      const slug = getNodeSlug(node);
      if (!slug) return false;
      return slug.replace(/-\d+$/, '') === courseSlug && matchesRequestedVideo(node);
    });
    const bySelectedVideo = json.included.find((node) => {
      if (!node) return false;
      const sel = getNodeSelectedVideo(node);
      if (sel && typeof sel === 'object') {
        return !videoSlug || sel.slug === videoSlug;
      }
      return false;
    });

    // 2. URN-based match: find a node whose $id / entityUrn contains the videoSlug.
    // LinkedIn's newer Voyager responses often omit a top-level `slug` field and
    // only encode the slug inside the URN.
    const byUrnSlug = !bySelectedVideo && videoSlug
      ? json.included.find((node) => {
          if (!node) return false;
          if (!urnContainsSlug(node, videoSlug)) return false;
          // Prefer nodes that look like a video object (have url, progressiveUrl,
          // selectedVideo, or a Video-ish $type).
          const attrs = getNodeAttributes(node);
          return !!(
            node.selectedVideo || node['*selectedVideo'] ||
            (attrs && (attrs.selectedVideo || attrs['*selectedVideo'])) ||
            node.url || (attrs && attrs.url) ||
            node.progressiveUrl || (attrs && attrs.progressiveUrl) ||
            (typeof node.$type === 'string' && /Video/i.test(node.$type))
          );
        })
      : null;

    // 3. URN-based match in $id/entityUrn for the videoSlug — looser: any node
    //    whose URN contains the videoSlug, even without video-object markers.
    const byUrnSlugLoose = !byUrnSlug && videoSlug
      ? json.included.find((node) => node && urnContainsSlug(node, videoSlug))
      : null;

    // 4. Match via *selectedVideo URN pointer that contains videoSlug — the
    //    course node's *selectedVideo URN may embed the video slug even when
    //    the video node itself doesn't surface it as a `slug` field.
    const bySelectedVideoUrn = !byUrnSlugLoose && videoSlug
      ? json.included.find((node) => {
          if (!node) return false;
          const ref = node['*selectedVideo'] || (node.attributes && node.attributes['*selectedVideo']);
          if (typeof ref === 'string' && ref.includes(videoSlug)) return true;
          return false;
        })
      : null;

    const fallbackCandidate = !videoSlug ? json.included.find((item) => item && getNodeSelectedVideo(item)) : null;
    const node = byExact || byStripped || bySelectedVideo || byUrnSlug || byUrnSlugLoose || bySelectedVideoUrn || fallbackCandidate;
    if (node) {
      const source = byExact
        ? 'included[exact-slug]'
        : byStripped
          ? 'included[stripped-slug]'
          : bySelectedVideo
            ? 'included[match-selectedVideo]'
            : byUrnSlug
              ? 'included[urn-video-slug]'
              : byUrnSlugLoose
                ? 'included[urn-video-slug-loose]'
                : bySelectedVideoUrn
                  ? 'included[selectedVideo-urn-contains-slug]'
                  : 'included[fallback-selectedVideo]';
      return { node, source };
    }
  }

  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    const dataAttrs = getNodeAttributes(json.data);
    const dataSel = getNodeSelectedVideo(json.data);
    if (!videoSlug || (dataSel && typeof dataSel === 'object' && dataSel.slug === videoSlug) || getNodeSlug(json.data) === videoSlug) {
      return { node: json.data, source: 'data' };
    }
    // Check if json.data has a *selectedVideo URN that contains the videoSlug
    const dataSelUrn = json.data['*selectedVideo'] || (dataAttrs && dataAttrs['*selectedVideo']);
    if (dataSelUrn && videoSlug && dataSelUrn.includes(videoSlug)) {
      return { node: json.data, source: 'data-selectedVideo-urn' };
    }
    // Also accept json.data as fallback if nothing else matched
    return { node: json.data, source: 'data-fallback' };
  }
  return null;
}

function findSelectedVideo(node, json, videoSlug) {
  if (!node || typeof node !== 'object') return null;
  const attributes = getNodeAttributes(node);
  let selected = node.selectedVideo || (attributes && attributes.selectedVideo) || null;
  const selectedUrn = node['*selectedVideo'] || (attributes && attributes['*selectedVideo']) ||
    (typeof selected === 'string' ? selected : null);

  // If selectedVideo is a URN pointer string, resolve it from json.included
  if (selectedUrn && json && Array.isArray(json.included)) {
    const resolved = json.included.find((item) => {
      if (!item || typeof item !== 'object') return false;
      return item.entityUrn === selectedUrn || item.urn === selectedUrn || item.$id === selectedUrn;
    });
    if (resolved) {
      selected = resolved;
    }
  }

  if (selected && typeof selected === 'object') {
    return selected;
  }

  // If node itself is already the Video object (e.g. from included[direct-video-slug])
  if (node.url || (attributes && attributes.url) ||
      node.formats || (attributes && attributes.formats) ||
      node.progressiveUrl || (attributes && attributes.progressiveUrl) ||
      (typeof node.$type === 'string' && /Video/i.test(node.$type))) {
    return node;
  }

  // Last resort: scan json.included for a node whose $type looks like a Video
  // and whose URN contains the videoSlug. This handles the case where the
  // parent node is a course wrapper that doesn't directly embed selectedVideo.
  if (videoSlug && json && Array.isArray(json.included)) {
    const videoByUrn = json.included.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const id = item.$id || item.entityUrn || item.urn || '';
      if (!id.includes(videoSlug)) return false;
      const a = getNodeAttributes(item);
      return !!(
        item.url || (a && a.url) ||
        item.progressiveUrl || (a && a.progressiveUrl) ||
        item.formats || (a && a.formats) ||
        (typeof item.$type === 'string' && /Video/i.test(item.$type))
      );
    });
    if (videoByUrn) return videoByUrn;
  }

  return null;
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
  const attributes = getNodeAttributes(node) || node;
  const selected = findSelectedVideo(node, json, videoSlug);
  if (!selected) return null;
  const selectedAttrs = getNodeAttributes(selected) || selected;

  const formats = selected.formats || selectedAttrs.formats;
  let chosenFormat = null;
  let progressiveUrl = null;

  const urlField = selected.url || selectedAttrs.url;
  // LinkedIn may store the video URL as a URN pointer (*url or the url field
  // itself being a URN string like "urn:li:..."). Resolve it from included[].
  let resolvedUrlObject = null;
  const urlUrn = selected['*url'] || (selectedAttrs && selectedAttrs['*url']);
  if (urlUrn && json && Array.isArray(json.included)) {
    resolvedUrlObject = json.included.find((item) =>
      item && (item.entityUrn === urlUrn || item.urn === urlUrn || item.$id === urlUrn)
    );
  }
  if (!resolvedUrlObject && typeof urlField === 'string' && urlField.startsWith('urn:') && json && Array.isArray(json.included)) {
    resolvedUrlObject = json.included.find((item) =>
      item && (item.entityUrn === urlField || item.urn === urlField || item.$id === urlField)
    );
  }

  if (resolvedUrlObject && typeof resolvedUrlObject === 'object' && resolvedUrlObject.progressiveUrl) {
    progressiveUrl = resolvedUrlObject.progressiveUrl;
  } else if (urlField && typeof urlField === 'object' && urlField.progressiveUrl) {
    progressiveUrl = urlField.progressiveUrl;
  } else if (typeof urlField === 'string' && /^https?:\/\//.test(urlField)) {
    progressiveUrl = urlField;
  } else if (selected.progressiveUrl || selectedAttrs.progressiveUrl) {
    progressiveUrl = selected.progressiveUrl || selectedAttrs.progressiveUrl;
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

  const courseLocked = (node.fullCourseUnlocked === false || (attributes && attributes.fullCourseUnlocked === false)) &&
    !progressiveUrl && (!formats || !formats.some((f) => f && f.url));
  const locked = isNodeLocked(node) || isNodeLocked(selected) || courseLocked;
  // "not entitled" is a different thing from DRM: LinkedIn marks the video
  // `accessible: false` and the course `courseVisibilityStatus: "LOCKED"` and
  // simply withholds every playback URL. Callers use this to say that instead
  // of reporting a generic failure.
  const notAccessible = Boolean(
    (selected && (selected.accessible === false ||
      (selected.attributes && selected.attributes.accessible === false))) ||
    (node && node.courseVisibilityStatus === 'LOCKED')
  );

  if (!progressiveUrl && !locked) return null;

  return {
    locked,
    notAccessible,
    title: selectedAttrs.title || selected.title || attributes.title || node.title || '',
    durationInSeconds: Number(selectedAttrs.durationInSeconds || selected.durationInSeconds || attributes.durationInSeconds || node.durationInSeconds || 0),
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
