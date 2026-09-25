'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { prepareVoiceMessage, transcodeVoiceReply } = require('../core/telegram-media');

test('voice preparation uses argument-safe ffmpeg and exposes cleanup', async () => {
  let command;
  const media = await prepareVoiceMessage('https://example.invalid/voice', {
    download: async (_url, destination) => fs.writeFileSync(destination, 'voice'),
    run: async (name, args) => { command = { name, args }; fs.writeFileSync(args.at(-1), 'wav'); }
  });
  assert.equal(command.name, 'ffmpeg');
  assert.deepEqual(command.args.slice(0, 2), ['-y', '-i']);
  assert.equal(fs.existsSync(media.wavPath), true);
  const directory = require('path').dirname(media.wavPath);
  await media.cleanup();
  assert.equal(fs.existsSync(directory), false);
});

test('voice reply transcode passes paths as arguments instead of shell text', async () => {
  let call;
  const output = await transcodeVoiceReply('/tmp/audio with spaces.mp3', {
    run: async (name, args) => { call = { name, args }; }
  });
  assert.equal(output, '/tmp/audio with spaces.ogg');
  assert.deepEqual(call, { name: 'ffmpeg', args: ['-y', '-i', '/tmp/audio with spaces.mp3', '-c:a', 'libopus', '/tmp/audio with spaces.ogg'] });
});