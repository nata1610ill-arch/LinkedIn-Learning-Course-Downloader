import test from 'node:test';
import assert from 'node:assert/strict';

import { extractVideoMetadata } from '../lib/linkedin-parser.js';

function course(slug, videoSlug, formats) {
  return {
    slug,
    selectedVideo: {
      slug: videoSlug,
      title: `Video ${videoSlug}`,
      formats,
    },
  };
}

test('extractVideoMetadata uses call-local course and video context', () => {
  const json = {
    included: [
      course('course-a', 'video-a', [{ type: 'progressive', url: 'https://cdn/a.mp4', height: 540 }]),
      course('course-b', 'video-b', [{ type: 'progressive', url: 'https://cdn/b.mp4', height: 720 }]),
    ],
  };

  assert.equal(extractVideoMetadata(json, 'course-a', 'video-a').progressiveUrl, 'https://cdn/a.mp4');
  assert.equal(extractVideoMetadata(json, 'course-b', 'video-b').progressiveUrl, 'https://cdn/b.mp4');
});

test('extractVideoMetadata reports the actual best progressive format', () => {
  const json = {
    included: [course('course', 'video', [
      { type: 'progressive', mimeType: 'video/mp4', url: 'https://cdn/720.mp4', width: 1280, height: 720, bitrate: 2_000_000 },
      { type: 'progressive', mimeType: 'video/mp4', url: 'https://cdn/1080-low.mp4', width: 1920, height: 1080, bitrate: 3_000_000 },
      { type: 'progressive', mimeType: 'video/mp4', url: 'https://cdn/1080-high.mp4', width: 1920, height: 1080, bitrate: 5_000_000 },
    ])],
  };

  const metadata = extractVideoMetadata(json, 'course', 'video');
  assert.equal(metadata.progressiveUrl, 'https://cdn/1080-high.mp4');
  assert.deepEqual(metadata.selectedFormat, {
    width: 1920,
    height: 1080,
    bitrate: 5_000_000,
    mimeType: 'video/mp4',
  });
});

test('extractVideoMetadata returns null for missing selected video', () => {
  assert.equal(extractVideoMetadata({ included: [{ slug: 'course' }] }, 'course', 'video'), null);
});

test('extractVideoMetadata skips a matching course node without the requested video', () => {
  const json = {
    included: [
      { slug: 'course' },
      course('canonical-course-123', 'video', [
        { type: 'progressive', url: 'https://cdn/video.mp4', height: 720 },
      ]),
    ],
  };

  assert.equal(
    extractVideoMetadata(json, 'course', 'video').progressiveUrl,
    'https://cdn/video.mp4',
  );
});
