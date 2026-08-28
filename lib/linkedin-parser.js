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
  };
}
