'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { runProcess } = require('./subprocess');

async function downloadMedia(url, destination, options = {}) {
  const fetchMedia = options.fetch || fetch;
  const response = await fetchMedia(url, { signal: AbortSignal.timeout(options.timeoutMs || 60000) });
  if (!response.ok || !response.body) throw new Error('Telegram media download failed (HTTP ' + response.status + ')');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { mode: 0o600 }));
}

async function prepareVoiceMessage(fileUrl, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-telegram-voice-'));
  const source = path.join(directory, 'voice.oga');
  const wav = path.join(directory, 'voice.wav');
  try {
    await (options.download || downloadMedia)(fileUrl, source, options);
    await (options.run || runProcess)('ffmpeg', ['-y', '-i', source, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wav], { timeoutMs: options.timeoutMs || 60000 });
    return { wavPath: wav, cleanup: () => fsp.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function transcodeVoiceReply(audioPath, options = {}) {
  const extension = path.extname(audioPath);
  const oggPath = audioPath.slice(0, extension ? -extension.length : undefined) + '.ogg';
  await (options.run || runProcess)('ffmpeg', ['-y', '-i', audioPath, '-c:a', 'libopus', oggPath], { timeoutMs: options.timeoutMs || 60000 });
  return oggPath;
}

module.exports = { downloadMedia, prepareVoiceMessage, transcodeVoiceReply };