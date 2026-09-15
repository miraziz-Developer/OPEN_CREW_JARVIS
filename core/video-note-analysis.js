'use strict';

/**
 * Telegram video-note analysis pipeline.
 * Raw media is kept only in a private temporary directory and is removed when
 * processing finishes. The caller may persist only the resulting text.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DURATION_SECONDS = 90;
const DEFAULT_FRAME_COUNT = 5;

function frameTimestamps(durationSeconds, count = DEFAULT_FRAME_COUNT) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const frames = Math.max(1, Math.min(8, Math.floor(Number(count) || DEFAULT_FRAME_COUNT)));
  if (duration <= 1 || frames === 1) return [Math.max(0, duration / 2)];
  // Do not sample the very first/last frame: they are commonly blurred during
  // a camera movement or Telegram's encode transition.
  return Array.from({ length: frames }, (_, index) => Number((duration * (index + 1) / (frames + 1)).toFixed(2)));
}

function validateVideoNote(note, options = {}) {
  const maxFileBytes = Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES;
  const maxDurationSeconds = Number(options.maxDurationSeconds) || DEFAULT_MAX_DURATION_SECONDS;
  if (!note || !note.file_id) return { ok: false, reason: 'missing-file' };
  if (Number(note.file_size || 0) > maxFileBytes) return { ok: false, reason: 'file-too-large', maxFileBytes };
  if (Number(note.duration || 0) > maxDurationSeconds) return { ok: false, reason: 'video-too-long', maxDurationSeconds };
  return { ok: true };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(command + ' failed (exit ' + code + '): ' + stderr.slice(-500)));
    });
  });
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error('Telegram media download failed (HTTP ' + response.status + ')');
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  await pipeline(Readable.fromWeb(response.body), output);
}

async function mediaDuration(videoPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath]);
  return Math.max(0, Number.parseFloat(stdout.trim()) || 0);
}

async function extractAudio(videoPath, wavPath) {
  await run('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
  return wavPath;
}

async function extractFrames(videoPath, durationSeconds, directory, count = DEFAULT_FRAME_COUNT) {
  const timestamps = frameTimestamps(durationSeconds, count);
  const frames = [];
  for (let index = 0; index < timestamps.length; index++) {
    const output = path.join(directory, 'frame-' + index + '.jpg');
    await run('ffmpeg', ['-y', '-ss', String(timestamps[index]), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=1024:-2', '-q:v', '4', output]);
    if (fs.existsSync(output) && fs.statSync(output).size > 0) frames.push(output);
  }
  if (!frames.length) throw new Error('No usable video frames could be extracted');
  return frames;
}

function buildVideoPrompt({ caption, transcript, durationSeconds, frameCount }) {
  return [
    'You are Jarvis analyzing frames sampled from one short Telegram video note.',
    'Answer in the same language as the user. Combine the spoken words, optional caption, and visible evidence.',
    'Identify buildings, objects, signs, places, or actions only when visual evidence supports it. Do not invent a precise identity or location. Clearly state uncertainty and say what extra view, sign, or location would confirm it.',
    'Do not mention internal reasoning, frame extraction, model prompts, or that you are an AI.',
    'Keep the answer direct and useful.',
    '',
    'Video duration: ' + Math.round(Number(durationSeconds) || 0) + ' seconds. Sampled frames: ' + Number(frameCount || 0) + '.',
    'Caption: ' + (String(caption || '').trim() || '(none)'),
    'Spoken transcript: ' + (String(transcript || '').trim() || '(speech was unavailable or unclear)')
  ].join('\n');
}

function buildVisionBody(framePaths, prompt, deployment) {
  const content = [{ type: 'text', text: prompt }];
  for (const framePath of framePaths) {
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(framePath).toString('base64') } });
  }
  return { model: deployment, messages: [{ role: 'user', content }], max_tokens: 700 };
}

function requestVision({ endpoint, key, deployment, framePaths, prompt, request = https.request }) {
  if (!endpoint || !key) return Promise.reject(new Error('AZURE_OPENAI_KEY yoki AZURE_OPENAI_ENDPOINT sozlanmagan'));
  const body = JSON.stringify(buildVisionBody(framePaths, prompt, deployment || 'gpt-4.1'));
  const url = new URL(String(endpoint).replace(/\/$/, '') + '/chat/completions');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed.error?.message || ('Vision HTTP ' + res.statusCode)));
          const answer = String(parsed.choices?.[0]?.message?.content || '').trim();
          if (!answer) return reject(new Error('Vision model returned an empty response'));
          resolve(answer);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Vision request timed out')); });
    req.end(body);
  });
}

async function analyzeVideoNote(options) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-video-note-'));
  const videoPath = path.join(directory, 'video.mp4');
  const wavPath = path.join(directory, 'audio.wav');
  try {
    await (options.download || downloadFile)(options.fileUrl, videoPath);
    const downloadedSize = (await fsp.stat(videoPath)).size;
    const fileCheck = validateVideoNote({ ...options.note, file_size: downloadedSize }, options);
    if (!fileCheck.ok) {
      const error = new Error(fileCheck.reason);
      error.code = fileCheck.reason;
      throw error;
    }
    const measuredDuration = await (options.getDuration || mediaDuration)(videoPath);
    const durationSeconds = measuredDuration || Number(options.note?.duration) || 0;
    const durationCheck = validateVideoNote({ ...options.note, duration: durationSeconds }, options);
    if (!durationCheck.ok) {
      const error = new Error(durationCheck.reason);
      error.code = durationCheck.reason;
      throw error;
    }
    const framePaths = await (options.extractFrames || extractFrames)(videoPath, durationSeconds, directory, options.frameCount);
    let transcript = '';
    try {
      await (options.extractAudio || extractAudio)(videoPath, wavPath);
      const stt = await options.transcribe(wavPath);
      transcript = stt?.status === 'ok' ? String(stt.text || '').trim() : '';
    } catch (error) {
      // Silent videos and malformed audio must not prevent visual analysis.
      options.log?.warn?.('Video-note audio was unavailable:', error.message || error);
    }
    const prompt = buildVideoPrompt({ caption: options.caption, transcript, durationSeconds, frameCount: framePaths.length });
    const answer = await (options.requestVision || requestVision)({
      endpoint: options.endpoint, key: options.key, deployment: options.deployment, framePaths, prompt
    });
    return { answer, transcript, durationSeconds, frameCount: framePaths.length };
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_DURATION_SECONDS, DEFAULT_FRAME_COUNT,
  frameTimestamps, validateVideoNote, buildVideoPrompt, buildVisionBody,
  requestVision, analyzeVideoNote, downloadFile, mediaDuration, extractAudio, extractFrames
};