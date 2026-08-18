#!/usr/bin/env node
/**
 * DEEP THINK — jiddiy savollarni KUCHLI modelga (gpt-5.4) yo'naltiradi.
 *
 * Nega kerak: jonli suhbatda barcha savol-javobga `gpt-realtime-2.1`
 * javob berardi. U ovoz uchun optimallashtirilgan — fikrlash uchun emas.
 * Real o'lchov (bir xil savollar, bir xil sharoitda):
 *
 *   Cheklovli rejalashtirish savoli:  gpt-5.4 3.7s  |  realtime 15.7s
 *   Ochiq maslahat savoli:            gpt-5.4 6.4s  |  realtime 18.6s
 *
 * Ya'ni kuchli model nafaqat aniqroq va konkretroq (aniq raqamlar,
 * tartib bilan), balki 3-4 BARAVAR TEZROQ ham. Shu sabab murakkab
 * savollar shu yerga yo'naltiriladi, oddiy suhbat esa realtime modelda
 * qoladi (u qisqa gaplarda tezroq va tabiiyroq).
 *
 * MUHIM: bu `run_task` EMAS. run_task to'liq agentni (barcha skilllar,
 * brauzer, fayl tizimi) ishga tushiradi va 15-25 soniya oladi. Bu esa
 * modelga to'g'ridan-to'g'ri bitta chaqiruv — hech qanday tool halqasi
 * yo'q, shuning uchun tez.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
let _env = null;
function env(k, def) {
  if (_env === null) { try { _env = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) { _env = ''; } }
  const m = _env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const MODEL = env('DEEP_THINK_MODEL', 'gpt-5.4');
const TIMEOUT_MS = parseInt(env('DEEP_THINK_TIMEOUT_MS'), 10) || 45000;
const MAX_TOKENS = parseInt(env('DEEP_THINK_MAX_TOKENS'), 10) || 500;

// Javob OG'ZAKI o'qiladi — shuning uchun markdown (sarlavha, **qalin**,
// raqamli ro'yxat) mutlaqo yaramaydi: ular ovozda "yulduzcha yulduzcha"
// bo'lib eshitiladi yoki g'alati pauzalar hosil qiladi. Model buni
// bilishi shart, aks holda odatdagi chiroyli formatlangan matn qaytaradi.
const SYSTEM_PROMPT =
  "Sen Jarvis — o'zbek tilida (lotin alifbosida) gaplashadigan shaxsiy yordamchisan. " +
  "Javobing OVOZ orqali o'qib eshittiriladi, shuning uchun:\n" +
  "- HECH QANDAY markdown ishlatma: sarlavha (#), qalin (**), yulduzcha, chiziqcha-ro'yxat, jadval — YO'Q.\n" +
  "- Oddiy, og'zaki gaplar bilan yoz. Ro'yxat kerak bo'lsa \"birinchidan, ikkinchidan\" deb ayt.\n" +
  "- QISQA bo'l: eng ko'pi 4-6 gap. Foydalanuvchi eshitib o'tiradi, o'qimaydi.\n" +
  "- Aniq va konkret bo'l: mavhum maslahat emas, aniq raqam/qadam ayt.\n" +
  "- Muqaddima qilma (\"keling ko'rib chiqamiz\", \"yaxshi savol\") — to'g'ridan-to'g'ri javobning o'zidan boshla.\n" +
  "- Faqat o'zbek tilida javob ber.";

function askExpert(question, context) {
  return new Promise((resolve, reject) => {
    const KEY = env('AZURE_OPENAI_KEY');
    const BASE = (env('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '').replace(/\/openai\/v1$/, '');
    if (!KEY || !BASE) return reject(new Error('AZURE_OPENAI_KEY/ENDPOINT yo\'q'));

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (context) messages.push({ role: 'system', content: 'Suhbat konteksti (foydalanuvchi haqida ma\'lum bo\'lgan narsalar):\n' + String(context).slice(0, 4000) });
    messages.push({ role: 'user', content: String(question).slice(0, 8000) });

    const payload = JSON.stringify({ messages, max_completion_tokens: MAX_TOKENS });
    const url = new URL(BASE + '/openai/deployments/' + MODEL + '/chat/completions?api-version=2025-01-01-preview');
    const req = https.request(url, {
      method: 'POST',
      headers: { 'api-key': KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.error) return reject(new Error(p.error.message));
          const txt = p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content;
          if (!txt) return reject(new Error('bo\'sh javob'));
          resolve(stripMarkdown(txt));
        } catch (e) { reject(new Error('javobni o\'qib bo\'lmadi: ' + String(d).slice(0, 150))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('deep-think timeout')); });
    req.write(payload); req.end();
  });
}

// Yo'riqnomaga qaramay model ba'zan markdown qo'shib yuboradi — ovozda
// g'alati eshitilmasligi uchun qo'shimcha, ishonchli tozalash.
function stripMarkdown(s) {
  return String(s)
    .replace(/^#{1,6}\s*/gm, '')        // sarlavhalar
    .replace(/\*\*(.+?)\*\*/g, '$1')    // qalin
    .replace(/\*(.+?)\*/g, '$1')        // kursiv
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')      // ro'yxat belgilari
    .replace(/^\s*\d+[.)]\s+/gm, '')    // raqamli ro'yxat
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  if (!input.question) { console.log(JSON.stringify({ status: 'error', message: 'question kerak' })); return; }
  askExpert(input.question, input.context)
    .then(answer => console.log(JSON.stringify({ status: 'ok', model: MODEL, answer })))
    .catch(e => console.log(JSON.stringify({ status: 'error', message: e.message })));
}

if (require.main === module) main();

module.exports = { askExpert, stripMarkdown, MODEL };
