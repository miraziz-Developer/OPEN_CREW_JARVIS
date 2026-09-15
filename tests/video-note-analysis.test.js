'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  frameTimestamps, validateVideoNote, buildVideoPrompt, buildVisionBody, analyzeVideoNote
} = require('../core/video-note-analysis');

test('video-note frames are distributed inside the clip rather than only at its start', () => {
  assert.deepEqual(frameTimestamps(12, 5), [2, 4, 6, 8, 10]);
  assert.deepEqual(frameTimestamps(0.5, 5), [0.25]);
});

test('video-note validation rejects missing, oversized, and overlong media', () => {
  assert.equal(validateVideoNote(null).reason, 'missing-file');
  assert.equal(validateVideoNote({ file_id: 'x', file_size: 101 }, { maxFileBytes: 100 }).reason, 'file-too-large');
  assert.equal(validateVideoNote({ file_id: 'x', duration: 91 }, { maxDurationSeconds: 90 }).reason, 'video-too-long');
  assert.equal(validateVideoNote({ file_id: 'x', file_size: 100, duration: 90 }, { maxFileBytes: 100, maxDurationSeconds: 90 }).ok, true);
});

test('video prompt includes caption and transcript while explicitly requiring evidence and uncertainty', () => {
  const prompt = buildVideoPrompt({ caption: 'Which building?', transcript: 'Jarvis, what is this?', durationSeconds: 9, frameCount: 4 });
  assert.match(prompt, /Which building\?/);
  assert.match(prompt, /Jarvis, what is this\?/);
  assert.match(prompt, /Do not invent a precise identity/i);
});

test('vision body sends every extracted JPEG frame as an image input', () => {
  const dir = fs.mkdtempSync('/tmp/jarvis-video-test-');
  try {
    const one = dir + '/one.jpg'; const two = dir + '/two.jpg';
    fs.writeFileSync(one, 'one'); fs.writeFileSync(two, 'two');
    const body = buildVisionBody([one, two], 'look', 'gpt-4.1');
    assert.equal(body.model, 'gpt-4.1');
    assert.equal(body.messages[0].content.filter(item => item.type === 'image_url').length, 2);
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('video analysis continues visually when audio extraction fails and always cleans temporary media', async () => {
  let tempFrame;
  const result = await analyzeVideoNote({
    note: { file_id: 'video', duration: 3 }, fileUrl: 'https://example.invalid/video', caption: 'What is this?',
    endpoint: 'https://example.invalid', key: 'key', deployment: 'vision',
    download: async (_url, destination) => fs.writeFileSync(destination, 'video'),
    getDuration: async () => 3,
    extractFrames: async (_video, _duration, directory) => {
      tempFrame = directory + '/frame.jpg'; fs.writeFileSync(tempFrame, 'frame'); return [tempFrame];
    },
    extractAudio: async () => { throw new Error('no audio stream'); },
    transcribe: async () => { throw new Error('should not run'); },
    requestVision: async input => {
      assert.match(input.prompt, /speech was unavailable or unclear/i);
      return 'A building is visible.';
    }
  });
  assert.equal(result.answer, 'A building is visible.');
  assert.equal(result.transcript, '');
  assert.equal(fs.existsSync(tempFrame), false);
});

test('video analysis enforces the real downloaded file-size limit and cleans it up', async () => {
  let downloadedPath;
  await assert.rejects(() => analyzeVideoNote({
    note: { file_id: 'video', duration: 3, file_size: 1 }, fileUrl: 'https://example.invalid/video', maxFileBytes: 2,
    download: async (_url, destination) => { downloadedPath = destination; fs.writeFileSync(destination, 'too-large'); },
    getDuration: async () => 3,
    transcribe: async () => ({ status: 'ok', text: '' })
  }), error => error.code === 'file-too-large');
  assert.equal(fs.existsSync(downloadedPath), false);
});