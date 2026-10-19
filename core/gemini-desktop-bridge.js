'use strict';

/**
 * JARVIS Gemini Desktop & Web Cookie Bridge
 * 
 * Ushbu modul foydalanuvchining Gemini Desktop yoki Gemini Pro (Google One AI Premium)
 * obunasini Jarvis uchun quvvat manbai (resource) sifatida ishlatish imkonini beradi.
 * 
 * Imkoniyatlar:
 *  1. Gemini Web Session (__Secure-1PSID va __Secure-1PSIDTS cookie) orqali to'g'ridan-to'g'ri Gemini Pro ga ulanish.
 *  2. macOS Gemini Desktop ilovasini avtomatlashtirish (AppleScript / URL scheme / local bridge).
 *  3. API key mavjud bo'lsa, avtomatik ravishda eng tezkor rejimga o'tish (0 ms kutish).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { PROJECT_DIR } = require('./paths');

let cachedEnv = null;
function getEnv(key, fallback = '') {
  if (process.env[key] !== undefined) return process.env[key];
  if (cachedEnv === null) {
    try { cachedEnv = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) { cachedEnv = ''; }
  }
  const match = cachedEnv.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}

/**
 * Cookie qiymatlarini .env yoki parametrlardan olish
 */
function getCookies() {
  const psid = getEnv('GEMINI_SECURE_1PSID') || getEnv('GEMINI_COOKIE_PSID') || process.env.GEMINI_SECURE_1PSID || '';
  const psidts = getEnv('GEMINI_SECURE_1PSIDTS') || getEnv('GEMINI_COOKIE_PSIDTS') || process.env.GEMINI_SECURE_1PSIDTS || '';
  return { psid, psidts, hasCookies: Boolean(psid && psidts) };
}

/**
 * macOS Gemini Desktop ilovasi holatini tekshirish
 */
function isGeminiDesktopRunning() {
  try {
    const out = execSync('pgrep -x "Gemini" || pgrep -afil "Gemini.app/Contents/MacOS/Gemini"', { encoding: 'utf8' });
    return Boolean(out.trim());
  } catch (_) {
    return false;
  }
}

/**
 * Gemini Desktop ilovasini faollashtirish yoki yangi chat ochish
 */
function openGeminiDesktop(prompt = '') {
  try {
    execSync('open -a "/Applications/Gemini.app"', { stdio: 'ignore' });
    if (prompt) {
      // Promptni clipboardga nusxalash
      execSync(`printf %s ${JSON.stringify(prompt)} | pbcopy`);
    }
    return { ok: true, app: '/Applications/Gemini.app' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Gemini Web orqali so'rov yuborish (Cookie sessiyasi orqali)
 */
async function queryGeminiWeb(prompt, options = {}) {
  const { psid, psidts, hasCookies } = getCookies();
  if (!hasCookies) {
    // Agar cookie yo'q bo'lsa, rasmiy Gemini API ga yo'naltirish
    const gemini = require('./gemini');
    if (gemini.hasGemini()) {
      return gemini.complete({ user: prompt, ...options });
    }
    throw new Error('Gemini Pro obunasidan foydalanish uchun .env faylida GEMINI_SECURE_1PSID va GEMINI_SECURE_1PSIDTS cookie-fayllarini kiriting');
  }

  // Cookie sessiyasidan SNlM0e (Google auth token) ni olish
  const cookieHeader = `__Secure-1PSID=${psid}; __Secure-1PSIDTS=${psidts};`;

  return new Promise((resolve, reject) => {
    // 1-qadam: Gemini asosiy sahifasidan SNlM0e va bl parametrlarini olish
    https.get('https://gemini.google.com/app', {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      },
      timeout: 15000
    }, res => {
      let html = '';
      res.on('data', c => html += c);
      res.on('end', () => {
        const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
        const blMatch = html.match(/"cfb2h":"([^"]+)"/);
        const atToken = atMatch ? atMatch[1] : '';
        const bl = blMatch ? blMatch[1] : 'boq_assistant-bard-web-server_20260218.08_p0';

        if (!atToken) {
          // Cookie muddati tugagan bo'lishi mumkin, API ga fallback
          const gemini = require('./gemini');
          if (gemini.hasGemini()) {
            return gemini.complete({ user: prompt, ...options }).then(resolve).catch(reject);
          }
          return reject(new Error('Gemini sessiyasiga ulanib bo\'lmadi. Cookie muddati o\'tgan bo\'lishi mumkin.'));
        }

        // 2-qadam: StreamGenerate RPC chaqiruvini yuborish
        const reqPayload = [[String(prompt)], null, ["", "", ""]];
        const fReq = JSON.stringify([null, JSON.stringify(reqPayload)]);
        const postData = new URLSearchParams({
          'at': atToken,
          'f.req': fReq
        }).toString();

        const postReq = https.request(`https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${bl}&_reqid=123456&rt=c`, {
          method: 'POST',
          headers: {
            'Cookie': cookieHeader,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
          },
          timeout: 45000
        }, postRes => {
          let postBody = '';
          postRes.on('data', c => postBody += c);
          postRes.on('end', () => {
            try {
              // Google envelope javobidan matnni ajratib olish
              const matches = postBody.match(/\["rc_[^"]+","([^"]+)"\]/);
              if (matches && matches[1]) {
                const text = JSON.parse(`"${matches[1]}"`);
                return resolve(text.trim());
              }
              // Muqobil oddiy parsing
              const jsonChunks = postBody.split(/\n+/).filter(line => line.startsWith('[['));
              if (jsonChunks.length > 0) {
                const last = jsonChunks[jsonChunks.length - 1];
                const parsed = JSON.parse(last);
                const reply = parsed?.[0]?.[2];
                if (reply) {
                  const replyParsed = JSON.parse(reply);
                  const candidate = replyParsed?.[4]?.[0]?.[1]?.[0];
                  if (candidate) return resolve(candidate.trim());
                }
              }
              // Agar envelope format o'zgargan bo'lsa, toza fallback
              const gemini = require('./gemini');
              if (gemini.hasGemini()) {
                return gemini.complete({ user: prompt, ...options }).then(resolve).catch(reject);
              }
              reject(new Error('Gemini Web javobi o\'qilmadi'));
            } catch (err) {
              const gemini = require('./gemini');
              if (gemini.hasGemini()) {
                return gemini.complete({ user: prompt, ...options }).then(resolve).catch(reject);
              }
              reject(err);
            }
          });
        });

        postReq.on('error', reject);
        postReq.write(postData);
        postReq.end();
      });
    }).on('error', reject);
  });
}

module.exports = {
  getCookies,
  isGeminiDesktopRunning,
  openGeminiDesktop,
  queryGeminiWeb
};
