#!/usr/bin/env node
/**
 * SCREEN VISION Skill — Azure OpenAI (gpt-4.1) orqali ekranni haqiqiy ko'rish
 * Kirish (stdin JSON): { imagePath?: string, prompt?: string }
 *   imagePath berilmasa — o'zi yangi skrinshot oladi
 * Chiqish: { status: "ok", description: "...", imagePath: "..." } | { status: "error", message }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');
const { collectMacOSContext } = require('../../core/macos-context');
const { WorldModel } = require('../../core/world-model');

const { PROJECT_DIR } = require('../../core/paths');
let ENV = '';
try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
function env(k, def) {
  if (process.env[k] !== undefined) return process.env[k];
  const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const KEY = env('AZURE_OPENAI_KEY');
const ENDPOINT = (env('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '');
const VISION_DEPLOYMENT = env('AZURE_OPENAI_VISION_DEPLOYMENT', 'gpt-4.1');
const DEFAULT_PROMPT = "Analyze this screen screenshot in detail and answer in natural English. If multiple windows or apps are visible, describe each separately: identify the app or site and the concrete visible details, such as file names, project, topic, conversation, code, or text. Do not guess; report only what is visibly supported. Avoid a generic description and include concrete details.";
const LOCATE_PROMPT = `Screenshotdagi so'ralgan interaktiv UI elementlarni top. FAQAT JSON qaytar, markdown yo'q:
{"summary":"qisqa tavsif","elements":[{"name":"ko'rinadigan nom","role":"button|field|menu|other","confidence":0.0,"bounds":{"x":0,"y":0,"width":0,"height":0},"center":{"x":0,"y":0}}]}
Koordinatalar screenshotning xom piksel koordinatasida bo'lsin. Faqat aniq ko'ringan elementlarni qo'sh; confidence 0..1. Topilmasa elements bo'sh bo'lsin.`;
const worldModel = new WorldModel({ file: path.join(PROJECT_DIR, '.jarvis-world-model.json') });

function buildGroundedPrompt(prompt, context) {
  const grounded = context ? {
    app: context.app, bundleId: context.bundleId,
    windowTitle: context.window?.title || '', windowBounds: context.window?.bounds || null,
    browser: context.browser || null, focusedElement: context.focus || null
  } : null;
  return (prompt || DEFAULT_PROMPT) + '\n\nMACOS SEMANTIC CONTEXT (ground-truth metadata; state any conflict with the image):\n' +
    JSON.stringify(grounded) + '\nDo not invent invisible elements or coordinates. If coordinates are requested, return screenshot pixel coordinates.';
}

function takeScreenshot() {
  const p = path.join(os.tmpdir(), 'jarvis_vision_' + Date.now() + '.png');
  execSync('screencapture -x "' + p + '"');
  if (!fs.existsSync(p)) throw new Error('Skrinshot olinmadi');
  return p;
}

function buildVisionRequestBody(imageBase64, prompt, options = {}) {
  return {
    model: VISION_DEPLOYMENT,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || DEFAULT_PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } }
      ]
    }],
    max_tokens: options.structured ? 1200 : 300,
    ...(options.structured ? { response_format: { type: 'json_object' } } : {})
  };
}

function describeImage(imagePath, prompt, options = {}) {
  if (!KEY || !ENDPOINT) throw new Error('AZURE_OPENAI_KEY yoki AZURE_OPENAI_ENDPOINT .env da yo\'q');
  const img = fs.readFileSync(imagePath).toString('base64');
  const body = JSON.stringify(buildVisionRequestBody(img, prompt, options));
  const url = new URL(ENDPOINT + '/chat/completions');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY, 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (res.statusCode !== 200) return reject(new Error(parsed.error?.message || ('HTTP ' + res.statusCode)));
          const text = parsed.choices?.[0]?.message?.content;
          if (!text) return reject(new Error('Model javob bermadi'));
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch (_) {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('Vision modeli structured JSON qaytarmadi');
  }
}

function normalizeVisionResult(value) {
  const source = value && typeof value === 'object' ? value : {};
  const elements = (Array.isArray(source.elements) ? source.elements : []).slice(0, 50).map(item => {
    const bounds = item?.bounds || {};
    const x = Number(bounds.x), y = Number(bounds.y), width = Number(bounds.width), height = Number(bounds.height);
    if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
    const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
    const center = item.center && Number.isFinite(Number(item.center.x)) && Number.isFinite(Number(item.center.y))
      ? { x: Number(item.center.x), y: Number(item.center.y) }
      : { x: x + width / 2, y: y + height / 2 };
    return {
      name: String(item.name || '').trim().slice(0, 200), role: String(item.role || 'other').trim().slice(0, 80),
      confidence, bounds: { x, y, width, height }, center
    };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  return { summary: String(source.summary || '').trim().slice(0, 1000), elements };
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  let imagePath = input.imagePath;
  let ownScreenshot = false;
  try {
    let context = null;
    try { context = collectMacOSContext(); } catch (e) {}
    if (!imagePath) { imagePath = takeScreenshot(); ownScreenshot = true; }
    else if (!fs.existsSync(imagePath)) throw new Error('Fayl topilmadi: ' + imagePath);

    const structured = input.action === 'locate_elements' || input.structured === true;
    const prompt = structured ? LOCATE_PROMPT + '\nSo‘rov: ' + String(input.prompt || input.query || 'barcha muhim interaktiv elementlar') : input.prompt;
    const description = await describeImage(imagePath, buildGroundedPrompt(prompt, context), { structured });
    const vision = structured ? normalizeVisionResult(extractJson(description)) : null;
    if (context) {
      context.screen = { summary: description, imagePath: ownScreenshot ? '' : imagePath };
      worldModel.observe(context, { type: 'screen.analyzed', forceEvent: true });
    }
    console.log(JSON.stringify({ status: 'ok', description: structured ? vision.summary : description, elements: vision?.elements, imagePath, context }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  } finally {
    if (ownScreenshot && imagePath) { try { fs.unlinkSync(imagePath); } catch (e) {} }
  }
}

if (require.main === module) main();

module.exports = { describeImage, takeScreenshot, buildGroundedPrompt, buildVisionRequestBody, extractJson, normalizeVisionResult, LOCATE_PROMPT };
