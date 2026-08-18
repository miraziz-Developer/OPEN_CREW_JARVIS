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

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const KEY = env('AZURE_OPENAI_KEY');
const ENDPOINT = (env('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '');
const VISION_DEPLOYMENT = env('AZURE_OPENAI_VISION_DEPLOYMENT', 'gpt-4.1');
const DEFAULT_PROMPT = "Bu ekran skrinshotini batafsil tahlil qil. O'zbek tilida javob ber. Agar bir nechta oyna/ilova ko'rinib tursa, HAR BIRINI alohida tasvirlab ber: qaysi ilova/sayt, unda aniq nima ko'rinyapti (fayl nomi, loyiha, mavzu, kim bilan gaplashilyapti, qanday kod/matn yozilyapti va h.k.). Taxmin qilma, faqat aniq ko'rinib turgan narsalarni yoz. Umumiy/sayoz ta'rif emas, konkret detallar bilan yoz.";

function takeScreenshot() {
  const p = path.join(os.tmpdir(), 'jarvis_vision_' + Date.now() + '.png');
  execSync('screencapture -x "' + p + '"');
  if (!fs.existsSync(p)) throw new Error('Skrinshot olinmadi');
  return p;
}

function describeImage(imagePath, prompt) {
  if (!KEY || !ENDPOINT) throw new Error('AZURE_OPENAI_KEY yoki AZURE_OPENAI_ENDPOINT .env da yo\'q');
  const img = fs.readFileSync(imagePath).toString('base64');
  const body = JSON.stringify({
    model: VISION_DEPLOYMENT,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || DEFAULT_PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + img } }
      ]
    }],
    max_tokens: 300
  });
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

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  let imagePath = input.imagePath;
  let ownScreenshot = false;
  try {
    if (!imagePath) { imagePath = takeScreenshot(); ownScreenshot = true; }
    else if (!fs.existsSync(imagePath)) throw new Error('Fayl topilmadi: ' + imagePath);

    const description = await describeImage(imagePath, input.prompt);
    console.log(JSON.stringify({ status: 'ok', description, imagePath }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  } finally {
    if (ownScreenshot && imagePath) { try { fs.unlinkSync(imagePath); } catch (e) {} }
  }
}

if (require.main === module) main();

module.exports = { describeImage, takeScreenshot };
