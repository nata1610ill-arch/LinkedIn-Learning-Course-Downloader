import test from 'node:test';
import assert from 'node:assert/strict';

import { extractVideoMetadata, extractTranscriptLines, renderSrt } from '../lib/linkedin-parser.js';

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

test('extractTranscriptLines normalises .lines with ms timestamps', () => {
  const t = { lines: [
    { transcriptStartAt: 0, caption: 'Welcome.' },
    { transcriptStartAt: 3500, caption: 'Today we cover…' },
    { transcriptStartAt: 'bad', caption: '' }, // dropped (empty caption)
  ]};
  assert.deepEqual(extractTranscriptLines(t), [
    { startMs: 0, caption: 'Welcome.' },
    { startMs: 3500, caption: 'Today we cover…' },
  ]);
});

test('extractTranscriptLines falls back to .paragraphs when .lines absent', () => {
  const t = { paragraphs: [
    { transcriptStartAt: 1000, caption: 'First.' },
    { transcriptStartAt: 2500, caption: 'Second.' },
  ]};
  assert.deepEqual(extractTranscriptLines(t).map((l) => l.caption), ['First.', 'Second.']);
});

test('renderSrt produces 1-indexed SRT with HH:MM:SS,mmm timestamps', () => {
  const srt = renderSrt([
    { startMs: 0, caption: 'Hello.' },
    { startMs: 3_600_000 + 5_000, caption: 'Mid.' },
    { startMs: 999, endMs: 1500, caption: 'Quick.' },
  ]);
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:02,000\nHello.\n\n'));
  assert.ok(srt.includes('2\n01:00:05,000 --> 01:00:07,000\nMid.'));
  assert.ok(srt.includes('3\n00:00:00,999 --> 00:00:01,500\nQuick.'));
});

test('extractVideoMetadata surfaces transcriptLines', () => {
  const json = { included: [{
    slug: 'course',
    selectedVideo: {
      slug: 'video',
      formats: [{ type: 'progressive', url: 'https://cdn/v.mp4', height: 720 }],
      transcript: { lines: [{ transcriptStartAt: 0, caption: 'hi' }] },
    },
  }]};
  const md = extractVideoMetadata(json, 'course', 'video');
  assert.equal(md.progressiveUrl, 'https://cdn/v.mp4');
  assert.deepEqual(md.transcriptLines, [{ startMs: 0, caption: 'hi' }]);
});
