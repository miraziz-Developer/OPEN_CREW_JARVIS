#!/usr/bin/env node
/**
 * REALTIME VOICE — Azure OpenAI Realtime API (gpt-realtime-2.1) orqali
 * haqiqiy real-vaqtli, oqim (streaming) ovozli suhbat.
 *
 * Eski STT(batch)->matn model->TTS(batch) zanjiridan farqli — bu yerda
 * bitta uzluksiz WebSocket seansi ichida mikrofon audiosi to'g'ridan-to'g'ri
 * oqim sifatida yuboriladi va javob audiosi ham bo'lak-bo'lak (chunk)
 * kelgan zahoti ijro etiladi — foydalanuvchi butun javobni kutmaydi.
 *
 * Murakkab, ko'p bosqichli vazifalar (brauzer, fayl, ekran) uchun
 * `run_task` funksiyasi orqali mavjud to'liq agentga (gpt-5.4, barcha
 * skilllar bilan) topshiriladi — shu bilan hech qanday imkoniyat
 * yo'qolmaydi, faqat oddiy suhbat ancha tezlashadi.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const KEY = env('AZURE_OPENAI_KEY');
const RAW_ENDPOINT = (env('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '');
const BASE = RAW_ENDPOINT.replace(/\/openai\/v1$/, '').replace(/^https:/, 'wss:');
const DEPLOYMENT = env('AZURE_REALTIME_DEPLOYMENT', 'gpt-realtime-2.1');
const API_VERSION = '2024-10-01-preview';

// Media (video/musiqa) "hali ijro etilyapti" holati — avval bu faqat
// bitta RealtimeSession obyekti ichida (xotirada) saqlanardi. Muammo:
// har bir Fn/hotword chaqiruvi YANGI RealtimeSession yaratadi (avvalgi
// suhbat 20s jimlikdan keyin tugaydi) — shuning uchun video bir
// suhbatda ishga tushirilib, keyingi (yangi) suhbat boshlanganda
// _mediaModeActive qayta false'dan boshlanardi, video esa fonda hali
// ham ijro etilayotgan bo'lardi. Natija: real logda tasdiqlandi — video
// subtitr/outro matnlari (koreys/turk/yapon tillarida) "foydalanuvchi
// gapirdi" deb qayta-qayta noto'g'ri transkript qilingan, chunki YANGI
// suhbat past chegara (0.6) bilan boshlangan. Fayl orqali saqlash bu
// holatni suhbatlar orasida ("session"lar orasida) saqlab qoladi.
const MEDIA_STATE_FILE = path.join(PROJECT_DIR, '.media-playing-state.json');
const MEDIA_STATE_TTL_MS = 40 * 60 * 1000; // 40 daqiqadan keyin eskirgan deb hisoblanadi (video/qo'shiq odatda shuncha davom etmaydi)
function saveMediaState() {
  try { fs.writeFileSync(MEDIA_STATE_FILE, JSON.stringify({ active: true, setAt: Date.now() })); } catch (e) {}
}
function isMediaRecentlyLikelyPlaying() {
  try {
    const s = JSON.parse(fs.readFileSync(MEDIA_STATE_FILE, 'utf8'));
    return s.active && (Date.now() - s.setAt) < MEDIA_STATE_TTL_MS;
  } catch (e) { return false; }
}

// TIZIM DARAJASIDA media ijro etilayotganini aniqlash. Yuqoridagi fayl-holati
// faqat JARVIS O'ZI video/musiqa ochganda ishlaydi — foydalanuvchi o'zi
// YouTube ochsa, tizim bundan bexabar qolardi. Real logda oqibati ko'rindi:
// mikrofon video ovozini olib, uni "foydalanuvchi gapirdi" deb transkript
// qilgan (turkcha YouTube outro matni aynan shunday tushib qolgan).
//
// macOS bunga aniq signal beradi: media ijro etuvchi ilova (Chrome, Spotify
// va h.k.) "Playing audio" nomli assertion qo'yadi. Sinab tasdiqlandi:
// Jarvisning O'Z ovozi (afplay) bu assertion'ni QO'YMAYDI — ya'ni o'zimizning
// ovozimizdan soxta ishga tushish bo'lmaydi.
function checkSystemAudioPlaying() {
  return new Promise((resolve) => {
    try {
      const p = spawn('pmset', ['-g', 'assertions']);
      let out = '';
      p.stdout.on('data', d => out += d);
      p.on('error', () => resolve(null));
      p.on('close', () => resolve(/named: "Playing audio"/.test(out)));
      setTimeout(() => { try { p.kill(); } catch (e) {} resolve(null); }, 3000);
    } catch (e) { resolve(null); }
  });
}
const VOICE = env('AZURE_REALTIME_VOICE', 'alloy');
// Jarvis gapirib bo'lgach, mikrofon yana necha ms kutib turadi (xona
// akustikasi/karnay ovozi pasayishi uchun) — real foydalanishda 500ms
// yetarli emasligi aniqlandi (Jarvis o'z ovozini qayta eshitib qolgan).
const MIC_MUTE_GRACE_MS = parseInt(env('MIC_MUTE_GRACE_MS'), 10) || 1500;

const IN_RATE = 16000;   // jarvis_daemon.js mikrofon oqimi shu tezlikda
const OUT_RATE = 24000;  // Realtime API kutgan/qaytaradigan tezlik

// ── 16kHz → 24kHz oddiy chiziqli interpolyatsiya (real-vaqtli, sox spawn qilmasdan) ──
function resample16to24(pcm16) {
  const inSamples = pcm16.length / 2;
  const outSamples = Math.floor(inSamples * OUT_RATE / IN_RATE);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * IN_RATE / OUT_RATE;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, inSamples - 1);
    const frac = srcPos - idx0;
    const s0 = pcm16.readInt16LE(Math.min(idx0, inSamples - 1) * 2);
    const s1 = pcm16.readInt16LE(idx1 * 2);
    const s = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

// Suhbat BOSHLANISHIDAN oldin, foydalanuvchi so'nggi soatlarda nima qilgani
// haqidagi qisqa xulosa. Avval har bir suhbat "bo'sh sahifadan" boshlanardi —
// foydalanuvchi "o'sha ishni davom ettir" desa, Jarvis nima haqida ketayotganini
// bilmasdan qayta so'rashi kerak edi. Endi u allaqachon xabardor holda ochiladi.
const RECENT_CONTEXT_HOURS = parseFloat(env('RECENT_CONTEXT_HOURS')) || 2;
const RECENT_CONTEXT_MAX_BLOCKS = 8;

function recentContextBlock() {
  try {
    const mem = require('../memory');
    const now = new Date();
    const items = [];
    // Kun almashgan payt (masalan 00:15) kechagi faylda hali yangi yozuvlar
    // bo'lishi mumkin — shuning uchun ikkala kun ham ko'riladi.
    for (let dayBack = 0; dayBack <= 1; dayBack++) {
      const d = new Date(now); d.setDate(d.getDate() - dayBack);
      const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
      const fp = path.join(mem.MEMORY_DIR, y + '-' + mo + '-' + da + '.md');
      if (!fs.existsSync(fp)) continue;
      const content = fs.readFileSync(fp, 'utf8');
      for (const block of content.split(/^---$/m)) {
        const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
        if (!m) continue;
        const bt = new Date(d); bt.setHours(+m[1], +m[2], 0, 0);
        const ageH = (now - bt) / 3600000;
        if (ageH < 0 || ageH > RECENT_CONTEXT_HOURS) continue;
        const body = block.replace(/^## .+$/m, '').replace(/\*\*Teglar:\*\*.*$/m, '').trim();
        if (body) items.push({ t: bt, line: m[1] + ':' + m[2] + ' — ' + m[3] + ': ' + body.replace(/\s+/g, ' ').slice(0, 220) });
      }
    }
    if (!items.length) return '';
    items.sort((a, b) => a.t - b.t);
    return "\n\nSO'NGGI FAOLIYAT (foydalanuvchi shu yaqin soatlarda nima qilgani — siz buni ALLAQACHON " +
      "bilasiz, qayta so'ramang; \"o'shani davom ettir\", \"o'sha ish\" desa, shu ro'yxatdan tushuning):\n" +
      items.slice(-RECENT_CONTEXT_MAX_BLOCKS).map(i => '- ' + i.line).join('\n') + '\n\n';
  } catch (e) { return ''; }
}

// SOUL.md ning FAQAT ovozli suhbatga taalluqli bo'limlari. Qolganlari
// (xotira yozish qoidalari, ekran kuzatuv, brauzer/skill ishlatish,
// kunlik vazifalar) — `run_task` ichidagi TO'LIQ AGENTNING ishi, ovozli
// model ularni umuman bajarmaydi. To'liq fayl ~2800 token bo'lib, butun
// yo'riqnomaning 69% ini egallardi va har bir javobda qayta qayta ishlanardi.
const SOUL_VOICE_SECTIONS = ['Klondek harakat qilish', 'Chegaralar', 'Uslub', 'Asl Maqsad'];
const SOUL_FULL_FOR_VOICE = (env('SOUL_FULL_FOR_VOICE') || 'false') === 'true'; // A/B sinov uchun

function loadSoulForVoice() {
  let raw = '';
  try { raw = fs.readFileSync(path.join(PROJECT_DIR, 'SOUL.md'), 'utf8'); } catch (e) { return ''; }
  if (SOUL_FULL_FOR_VOICE) return raw;
  const out = [];
  // Sarlavhagacha bo'lgan kirish qismi (Jarvis kimligi) — qisqa, saqlanadi
  const firstHeading = raw.indexOf('\n## ');
  if (firstHeading > 0) out.push(raw.slice(0, firstHeading).trim());
  for (const part of raw.split(/^## /m).slice(1)) {
    const title = part.split('\n', 1)[0].trim();
    if (SOUL_VOICE_SECTIONS.some(s => title.startsWith(s))) out.push('## ' + part.trim());
  }
  return out.join('\n\n');
}

function loadInstructions() {
  const soul = loadSoulForVoice();
  let pronunciationNotes = [];
  try { pronunciationNotes = require('../memory').getPronunciationNotes(40); } catch (e) {}
  const pronunciationBlock = pronunciationNotes.length
    ? "\n\nMUHIM — FOYDALANUVCHINING SHAXSIY TALAFFUZ LUG'ATI: quyidagi juftliklar — avvalgi suhbatlarda " +
      "siz noto'g'ri tushungan va foydalanuvchi to'g'rilagan haqiqiy holatlar. Shu so'zlarni eshitsangiz, " +
      "chapdagi emas, o'ngdagi ma'noni nazarda tuting:\n" +
      pronunciationNotes.map(e => `- "${e.misheard}" emas, "${e.actual}"`).join('\n') + '\n' +
      "Foydalanuvchi yana sizni to'g'rilasa (\"yo'q, men ... dedim\"), `note_pronunciation` funksiyasini chaqirib, " +
      "javob bermasdan (ovozsiz) yozib qo'ying — shu bilan lug'at o'sib boradi.\n\n"
    : "";
  return (
    "Sen Jarvis — o'zbek tilida (lotin alifbosida) gaplashadigan shaxsiy ovozli yordamchisan. " +
    "HAR DOIM faqat o'zbek tilida javob ber, hech qachon boshqa tilga o'tma (foydalanuvchi aniq boshqa til so'ramasa). " +
    "Qisqa, tabiiy, suhbatdek gapir — yozma matn emas, OG'ZAKI nutq kabi. " +
    "Agar foydalanuvchi kompyuterda biror amal (ekranni ko'rish, dastur/brauzer ochish, fayl bilan ishlash, " +
    "eslab qolish/eslatib berish, vazifalar bilan ishlash, internetdan qidirish yoki boshqa har qanday real ish) so'rasa — " +
    "албатта `run_task` funksiyasini chaqir va natijani tabiiy tilda ayt. Oddiy suhbat/savol-javob uchun run_task shart emas, " +
    "o'zing to'g'ridan-to'g'ri javob ber.\n\n" +
    "MUHIM — ko'p vazifali (multi-tasking) ishlash: har bir `run_task` chaqiruvi MUSTAQIL, alohida ishchi sifatida " +
    "fon rejimida ishlaydi va boshqa vazifalarga XALAQIT BERMAYDI. Shuning uchun: agar bitta vazifa (masalan brauzer/ekran " +
    "bilan ishlash) davom etayotgan bo'lsa-yu, foydalanuvchi BOSHQA, mustaqil vazifa so'rasa — birinchisi tugashini KUTMASDAN " +
    "darhol ikkinchi `run_task`'ni ham chaqir. Har biri qachon tugasa, o'sha payt natijasini alohida aytib ber. Faqat ikkinchi " +
    "vazifa BIRINCHISIGA bevosita bog'liq bo'lsa (masalan 'o'sha oynada davom et') — o'shanda birinchisi tugashini kutish kerak.\n\n" +
    "MUHIM — ORTIQCHA GAPIRMASLIK: siz juda ko'p, keraksiz, takrorlanuvchi gap aytib yuborishga moyilsiz — bu qat'iyan man etiladi. " +
    "Qoidalar: (1) Bir xil fikrni (\"hammasi joyida\", \"davom eting\", \"yordam kerak bo'lsa ayting\") ketma-ket ikkinchi marta " +
    "TAKRORLAMANG — buni faqat bir marta ayting, keyin jim turing. (2) Har javob oxirida \"agar boshqa narsa kerak bo'lsa ayting\" " +
    "kabi odatiy jumla QO'SHMANG — foydalanuvchi buni allaqachon biladi. (3) Foydalanuvchi hech narsa demasa yoki noaniq/tushunarsiz " +
    "tovush eshitilsa (masalan fon shovqini) — O'ZINGIZDAN gapirmang, hech qanday javob yaratmang, jim kuting. (4) Vazifa " +
    "bajarilgach faqat NATIJANI 1 gapda ayting (masalan \"Chrome ochildi.\") — jarayon haqida hikoya qilmang, \"hozir " +
    "tekshiryapman\", \"jarayon davom etyapti\" kabi status-yangilanishlarni faqat foydalanuvchi ANIQ so'rasa ayting. " +
    "(5) ENG MUHIMI — foydalanuvchi sizga shunchaki qisqa tasdiq/aks-sado bersa (\"ha\", \"xo'p\", \"to'g'ri\", \"tushunarli\", " +
    "\"a\", \"mm\", yoki hatto tovush aniq eshitilmasa) — SIZ ALLAQACHON AYTGAN gapni QAYTA AYTMANG. Bunday holatda faqat " +
    "juda qisqa (1-2 so'z: \"xo'p\", \"ha\", yoki hech narsa) javob bering yoki umuman javob bermang — YANGI ma'lumot yo'q " +
    "bo'lsa gapirishning hojati yo'q. NOTO'G'RI MISOL (buni HECH QACHON qilmang): foydalanuvchi \"soat nechchi\" deb so'raydi, " +
    "siz \"Hozir soat 13:07\" deysiz, foydalanuvchi \"ha\" yoki aniqsiz tovush chiqaradi, va siz yana \"Ha, to'g'ri, hozir " +
    "soat 13:07\" deb TAKRORLAYSIZ — bu 3-4 marta ketma-ket takrorlanib, judayam yomon eshitiladi. TO'G'RI: bunday holatda " +
    "sukut saqlang yoki faqat \"xo'p\" deng, raqamni qayta aytmang. " +
    "Maqsad: kino JARVIS kabi — lo'nda, aniq, keraksiz so'zsiz.\n\n" +
    "MUHIM — JIDDIY SAVOLGA O'ZINGIZ JAVOB BERMANG: siz ovoz uchun optimallashtirilgan modelsiz — qisqa " +
    "suhbatda tez va tabiiysiz, lekin ko'p bosqichli FIKRLASHDA sekin va suvli bo'lib qolasiz (real o'lchov: " +
    "bir xil rejalashtirish savoliga siz 15.7 soniya sarfladingiz, `ask_expert` esa 3.5 soniyada aniqroq javob " +
    "berdi). Shuning uchun QUYIDAGI hollarda HAR DOIM `ask_expert` chaqiring, o'zingiz javob berishga URINMANG:\n" +
    "  • tahlil, sabab-oqibat (\"nega bunday bo'lyapti\", \"sabab nima\")\n" +
    "  • maslahat (\"nima qilsam\", \"qanday yaxshilayman\", \"nimani o'zgartiray\")\n" +
    "  • taqqoslash (\"qaysi biri afzal\", \"farqi nima\")\n" +
    "  • rejalashtirish, vaqt/tartib hisobi (\"ulguraman-mi\", \"qanday tartibda\")\n" +
    "  • hisob-kitob, mantiqiy masala, ko'p shartli vaziyat\n" +
    "  • biror mavzuni tushuntirish (\"bu nima\", \"qanday ishlaydi\")\n" +
    "O'ZINGIZ javob beradigan holatlar FAQAT shular: salomlashish, qisqa suhbat, hazil, tasdiq (\"xo'p\", \"ha\"), " +
    "va allaqachon bilgan qisqa fakt (soat nechchi — buni fast_action beradi). Ikkilansangiz — `ask_expert` " +
    "chaqiring, bu deyarli har doim to'g'ri qaror. Javob qaytgach uni qayta yozmang, tabiiy ohangda o'qib bering.\n\n" +
    "MUHIM — FUNKSIYA CHAQIRISHDAN OLDIN JIM BO'LING: `see_screen`, `recall_memory`, `fast_action` kabi TEZ " +
    "funksiyalarni chaqirayotganda, oldindan \"hozir qarayman\", \"bir oz eslab ko'ray\", \"hozir izlab ko'raman\", " +
    "\"bir zum\" kabi HECH QANDAY oraliq gap AYTMANG. Bu funksiyalar bir-ikki soniyada tugaydi — oraliq gap esa " +
    "butun boshqa javob navbatini band qilib, foydalanuvchini QO'SHIMCHA 4-5 soniya bekorga kutdiradi va " +
    "sekinroq taassurot qoldiradi. To'g'ri yo'l: jim chaqiring, natija kelgach faqat ASL javobning o'zini " +
    "ayting. Faqat `run_task` (uzoq, bir necha daqiqalik ish) chaqirilganda qisqa ogohlantirish o'rinli.\n\n" +
    "MUHIM — TUSHUNISH ANIQLIGI: og'zaki o'zbek tilida rus va ingliz tillaridan olingan so'zlar juda ko'p " +
    "ishlatiladi (masalan \"kompyuter\", \"telefon\", \"internet\", \"pochta\" yoki hatto alohida rus so'zlari) — " +
    "bu tabiiy holat, XATOLIK EMAS. Bunday so'zlarni eshitganda chalkashib qolmang, gapni boshqa til deb " +
    "hisoblamang va HECH QACHON shu sabab bilan javob tilini o'zgartirmang. Aksent yoki talaffuz sabab biror " +
    "so'z noaniq eshitilsa, gapning umumiy MA'NOSI va KONTEKSTIDAN (oldingi suhbat, joriy vazifa) foydalanib " +
    "eng ehtimoliy to'g'ri ma'noni tanlang — so'zma-so'z, harfma-harf tushunishga urinmang. Foydalanuvchi " +
    "chindan gapirdi-yu, lekin nima deganini tushunolmasangiz (fon shovqini emas, balki tushunarsiz gap) — " +
    "taxmin qilib noto'g'ri amal bajarishdan ko'ra, qisqa qilib qayta so'rang (masalan \"Kechirasiz, aniqroq " +
    "ayting\").\n\n" +
    "MUHIM — OVOZ OHANGINI SEZISH: siz foydalanuvchining xom ovozini (matn emas) eshitasiz — shundan uning kayfiyati, " +
    "shoshilinchligi va charchoqligini his qiling va shunga moslashing: (1) Ovozi tez, keskin yoki xafa bo'lsa — darhol " +
    "eng qisqa, aniq javob bering, hazil/ortiqcha so'z ishlatmang, tezda yordam bering. (2) Charchagan/xotirjam ovozda " +
    "gapirsa — sekinroq, yumshoqroq ohangda javob bering. (3) Xursand/hazil ohangda gapirsa — siz ham biroz erkinroq, " +
    "iliqroq javob berishingiz mumkin. (4) HECH QACHON \"ovozingiz charchagandek eshitilyapti\" kabi buni ochiqchasiga " +
    "aytmang yoki sharh bermang — faqat o'z javobingiz ohangi va uslubi bilan moslashing, sezilmasdan.\n\n" +
    pronunciationBlock +
    recentContextBlock() +
    // Eslatma: avval bu yerda soul.slice(0, 1500) edi — SOUL.md 10.3KB,
    // eng muhim XARAKTER/USLUB bo'limi esa faylning OXIRIDA (~10100-belgida)
    // joylashgan bo'lib chiqdi. Natijada u HECH QACHON real ovozli suhbatga
    // yetib bormagan (haqiqiy topilma, real belgi-hisobi bilan tasdiqlangan)
    // — bu "kino JARVIS kabi hissiyot yo'q" shikoyatining asosiy sababi
    // bo'lgan bo'lishi mumkin. To'liq fayl (~2500 token) bemalol context
    // doirasiga sig'adi, shuning uchun kesish olib tashlandi.
    "To'liq shaxsiyat qoidalari:\n" + soul
  );
}

// Tools har bir ulanishda YANGIDAN quriladi (statik emas) — shunda
// fast-actions ro'yxatiga yangi o'rganilgan yozuvlar qo'shilsa (qarang:
// skills/fast-actions), keyingi suhbat ularni DARHOL ko'radi, daemon'ni
// qayta ishga tushirish shart emas.
function buildTools() {
  let fastActionIds = [];
  let fastActionsDoc = '';
  try {
    const fa = require('../fast-actions');
    const actions = fa.loadActions();
    fastActionIds = actions.map(a => a.id);
    fastActionsDoc = actions.map(a => a.id + ' — ' + a.uz).join('; ');
  } catch (e) {}

  const tools = [{
    type: 'function',
    name: 'run_task',
    description: "Kompyuterda MURAKKAB, ko'p bosqichli amal bajarish kerak bo'lganda (brauzerda kezish/bosish/forma " +
      "to'ldirish, ekranni ko'rib tahlil qilish, fayl/kod bilan ishlash, eslab qolish/eslab olish, vazifalar ro'yxati, " +
      "internetdan qidirish, va h.k.) shuni chaqir. Oddiy, bir qadamlik amal (dastur ochish, sayt ochish, ovoz, " +
      "skrinshot, vaqt/sana/batareya so'rash) uchun BUNI EMAS, `fast_action`ni ishlating — u ANCHA TEZROQ. " +
      "To'liq imkoniyatli yordamchi vazifani MUSTAQIL, fon rejimida bajaradi (boshqa vazifalarni to'xtatmaydi) va tugagach " +
      "natijani matn sifatida qaytaradi. Bir nechta mustaqil vazifa uchun bir nechta marta chaqirishingiz mumkin — ular " +
      "parallel bajariladi.",
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: "Bajarilishi kerak bo'lgan aniq vazifa, foydalanuvchi so'zlari bilan" } },
      required: ['description']
    }
  }, {
    type: 'function',
    name: 'note_pronunciation',
    description: "Foydalanuvchi sizni noto'g'ri tushunganingiz uchun to'g'rilasa (masalan \"yo'q, men ... dedim\", " +
      "\"men ... demadim, ... dedim\", yoki shunga o'xshash tuzatish) — DARHOL shuni chaqiring, hech narsa demasdan " +
      "javob qaytarmang (bu foydalanuvchiga eshitilmaydi, faqat xotiraga yoziladi). Shu bilan xuddi shu so'z keyingi " +
      "safar yana adashib eshitilmaydi.",
    parameters: {
      type: 'object',
      properties: {
        misheard: { type: 'string', description: "Siz avval noto'g'ri tushungan/eshitgan so'z yoki ibora" },
        actual: { type: 'string', description: "Foydalanuvchi aslida nima degani (to'g'rilagandan keyin)" }
      },
      required: ['misheard', 'actual']
    }
  }];

  // Jonli suhbatda EKRANNI KO'RISH — rasm to'g'ridan-to'g'ri shu suhbatga
  // qo'shiladi (real endpoint sinovidan o'tkazilgan: gpt-realtime-2.1 rasmni
  // qabul qiladi va aniq tasvirlaydi). Avval buning yagona yo'li `run_task`
  // orqali alohida vision-modelga yuborish edi — 15-20 soniya; bu esa ~1
  // soniya, va model javob berayotgan paytda ekranni "ko'rib turadi".
  tools.push({
    type: 'function',
    name: 'see_screen',
    description: "Ekranda hozir nima borligini KO'RISH kerak bo'lganda shuni chaqiring — rasm to'g'ridan-to'g'ri " +
      "sizga ko'rsatiladi va uni o'zingiz tahlil qilasiz. Qachon: foydalanuvchi \"bu nima\", \"shu xato nima\", " +
      "\"ekranimda nima ko'rinyapti\", \"buni o'qib ber\", \"shu yerda nima yozilgan\" kabi KO'RISHGA oid narsa " +
      "so'raganda, yoki uning gapini tushunish uchun ekran konteksti kerak bo'lganda. Bu `run_task`dan ANCHA " +
      "TEZROQ — ekranni ko'rish uchun HECH QACHON run_task ishlatmang, doim shuni ishlating. Eslatma: bu faqat " +
      "KO'RADI, hech narsani bosmaydi/o'zgartirmaydi — ekranda biror amal bajarish kerak bo'lsa `run_task` kerak. " +
      "MUHIM: chaqirishdan oldin \"hozir qarayman\", \"bir zum ko'ray\" kabi HECH NARSA AYTMANG — jim chaqiring va " +
      "rasmni ko'rgach TO'G'RIDAN-TO'G'RI javobning o'zini ayting. Bu oraliq gap ortiqcha bir necha soniya " +
      "kechikish qo'shadi va foydalanuvchini bekorga kutdiradi.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  // BUTUN TARIX bo'yicha ma'no (semantik) izlash. Instructionsdagi
  // "so'nggi faoliyat" bloki faqat oxirgi bir necha soatni qamraydi —
  // u "hozir nima qilayotgan eding" uchun. Bu tool esa vaqt chegarasiz:
  // kecha, bir hafta, bir yil oldin bo'lganini ham topa oladi, va so'zlar
  // aynan mos kelmasa ham ma'noga qarab qidiradi.
  tools.push({
    type: 'function',
    name: 'recall_memory',
    description: "Foydalanuvchi O'TMISHDAGI biror narsaga ishora qilsa — \"o'sha loyiha\", \"avval nima degandik\", " +
      "\"qachondir aytgan edim\", \"o'tgan hafta/oy\", biror nom/mavzu haqida \"eslaysanmi\" — DARHOL shuni chaqiring. " +
      "Butun xotira tarixi bo'ylab (kecha ham, bir yil oldin ham) MA'NO bo'yicha qidiradi, so'zlar aynan mos " +
      "kelmasa ham topadi. Tez ishlaydi (~1 soniya) — ikkilanmasdan ishlating. Taxmin qilib javob berishdan " +
      "ko'ra, shu bilan ANIQ eslab javob bering. So'nggi bir necha soatlik ish uchun bu shart emas — u " +
      "allaqachon yuqoridagi \"so'nggi faoliyat\" ro'yxatida bor. " +
      "MUHIM: chaqirishdan oldin \"hozir eslab ko'ray\", \"bir oz o'ylab ko'ray\" kabi HECH NARSA AYTMANG — " +
      "jim chaqiring va natijani ko'rgach TO'G'RIDAN-TO'G'RI javobning o'zini ayting. Eslab aytganda, qachon " +
      "bo'lganini ham qisqa qo'shing (masalan \"o'tgan seshanba\", \"13-avgustda\") — bu ishonchni oshiradi.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: "Nimani eslash kerakligi — mavzu/nom/savol, foydalanuvchi so'zlari bilan" } },
      required: ['query']
    }
  });

  // JIDDIY SAVOLLARNI KUCHLI MODELGA yo'naltirish. Siz (realtime model)
  // ovoz uchun optimallashtirilgansiz — qisqa suhbatda tez va tabiiysiz,
  // lekin ko'p bosqichli fikrlashda sekin va suvli bo'lib qolasiz.
  // Real o'lchov (bir xil savol): gpt-5.4 3.7s, siz 15.7s.
  tools.push({
    type: 'function',
    name: 'ask_expert',
    description: "Foydalanuvchi CHINDAN FIKRLASH talab qiladigan savol bersa — tahlil, maslahat, taqqoslash, " +
      "rejalashtirish, sabab-oqibat, hisob-kitob, \"nima qilsam yaxshi\", \"nega bunday\", \"qaysi biri afzal\" — " +
      "shuni chaqiring. Savolni TO'LIQ, kerakli kontekst bilan birga bering (foydalanuvchi aytgan raqamlar, " +
      "cheklovlar, vaziyat) — chunki ekspert sizning suhbatingizni ko'rmaydi. Javob qaytgach, uni O'Z SO'ZINGIZ " +
      "bilan qayta aytib bermang — deyarli o'zgartirmasdan, tabiiy ohangda o'qib bering. " +
      "Qachon KERAK EMAS: oddiy suhbat, salomlashish, qisqa faktik savol (soat nechchi, ob-havo), " +
      "kompyuterda amal bajarish (buning uchun run_task yoki fast_action). " +
      "MUHIM: chaqirishdan oldin \"o'ylab ko'ray\" kabi hech narsa demang — jim chaqiring.",
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: "To'liq savol + barcha kerakli kontekst (ekspert suhbatni ko'rmaydi)" } },
      required: ['question']
    }
  });

  tools.push({
    type: 'function',
    name: 'cancel_task',
    description: "Foydalanuvchi bajarilayotgan vazifani TO'XTATISHNI so'rasa (\"to'xtat\", \"bekor qil\", \"kerak emas\", " +
      "\"qo'y\", \"shart emas endi\") — darhol shuni chaqiring. Hozir ishlayotgan barcha `run_task` vazifalari to'xtatiladi. " +
      "Hech qanday vazifa ishlamayotgan bo'lsa ham chaqirsa bo'ladi — shunchaki to'xtatadigan narsa yo'qligini qaytaradi.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  if (fastActionIds.length) {
    tools.push({
      type: 'function',
      name: 'fast_action',
      // Eslatma: avval bu yerda barcha 115 ta action "id — izoh" ko'rinishida
      // sanab chiqilardi, ustiga yana AYNAN o'sha id'lar quyidagi enum'da
      // takrorlanardi — ya'ni ro'yxat ikki marta yuborilib, har javobda
      // bekorga ~1500 token qayta ishlanardi. id'larning o'zi tushunarli
      // ("open:chrome", "volume:up", "info:battery"), shuning uchun enum
      // yetarli; bu yerda faqat qanday turlari borligi qisqa aytiladi.
      description: "TEZ, ODDIY, bir qadamlik amallar uchun — dastur ochish (open:*), sayt ochish (web:*), " +
        "ovoz balandligi (volume:*), tizim amallari (system:*), ekran surati (screenshot:*), " +
        "Music/Spotify boshqarish (media:*), ma'lumot so'rash — vaqt/sana/batareya/Wi-Fi/disk (info:*). " +
        "`run_task`dan ANCHA TEZROQ ishlaydi (to'liq agent ishga tushirilmaydi) — mos action topilsa, " +
        "har doim buni run_task'dan USTUN qo'ying. Aniq ro'yxat quyidagi `id` maydonining enum'ida.",
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', enum: fastActionIds, description: "Bajarilishi kerak bo'lgan action id'si (ro'yxatdan)" } },
        required: ['id']
      }
    });
  }

  return tools;
}

const RUN_TASK_TIMEOUT_MS = parseInt(env('RUN_TASK_TIMEOUT_MS'), 10) || 180000;

// Har bir chaqiruv o'ziga xos, izolyatsiyalangan session'da ishlaydi — shu
// bilan bir nechta vazifa CHINDAN parallel, bir-birining kontekstini
// buzmasdan bajarilishi mumkin (bitta umumiy session'ni ishlatishsa,
// bir vaqtda ikkita jarayon uni yozsa, bir-birining natijasini
// buzib qo'yishi mumkin edi).
// onProc — ishga tushgan jarayonni chaqiruvchiga qaytaradi, shunda uni
// keyinroq to'xtatish (foydalanuvchi "to'xtat" desa) yoki suhbat tugaganda
// tozalash mumkin bo'ladi.
function runFullAgent(description, sessionKey, onProc) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', ['agent', '--session-key', sessionKey, '--message', description, '--agent', 'main'], {
      cwd: PROJECT_DIR, env: { ...process.env, AZURE_OPENAI_KEY: KEY }, timeout: RUN_TASK_TIMEOUT_MS
    });
    if (typeof onProc === 'function') onProc(proc);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', (code, signal) => {
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      // Foydalanuvchi o'zi to'xtatgan bo'lsa — bu xato emas, ataylab qilingan.
      if (proc._jarvisCancelled) { resolve('Vazifa to\'xtatildi.'); return; }
      // Vaqt chegarasi: jarayon SIGTERM bilan o'ldirilgan. Bu holda yig'ilgan
      // matn CHALA — avval u to'liq natija sifatida qaytarilardi, ya'ni
      // yarim bajarilgan ish "bajarildi" deb ko'rsatilardi.
      if (signal === 'SIGTERM' && proc.killed) {
        const mins = Math.round(RUN_TASK_TIMEOUT_MS / 60000);
        resolve(clean
          ? 'Vazifa ' + mins + ' daqiqada tugamadi, to\'xtatildi. Shu yergacha bajarildi: ' + clean
          : 'Vazifa ' + mins + ' daqiqada tugamadi va to\'xtatildi — natija olinmadi.');
        return;
      }
      resolve(clean || "Kechirasiz, bajara olmadim.");
    });
    proc.on('error', () => resolve("Xatolik yuz berdi."));
  });
}

class RealtimeSession extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.playProc = null;
    this.assistantSpeaking = false;
    this._speakEndedAt = 0;
    this.userTranscript = '';
    this.assistantTranscript = '';
    this._pendingFnArgs = {};
    this._mediaModeActive = false;
    // Hozir ishlayotgan run_task jarayonlari (call_id -> {proc, description}).
    // Ikki narsa uchun kerak: (1) foydalanuvchi "to'xtat" desa o'chirish,
    // (2) suhbat tugaganda qolib ketgan jarayonlarni tozalash — avval ular
    // suhbat yopilgandan keyin ham fonda ishlashda davom etardi.
    this._runningTasks = new Map();
  }

  // Ishlayotgan vazifalarni to'xtatadi. Nechtasi to'xtatilganini qaytaradi.
  cancelRunningTasks() {
    let n = 0;
    for (const [, t] of this._runningTasks) {
      try { t.proc._jarvisCancelled = true; t.proc.kill('SIGTERM'); n++; } catch (e) {}
    }
    this._runningTasks.clear();
    return n;
  }

  connect() {
    if (!KEY || !RAW_ENDPOINT) { this.emit('error', new Error('AZURE_OPENAI_KEY/ENDPOINT yo\'q')); return; }
    const url = BASE + '/openai/realtime?api-version=' + API_VERSION + '&deployment=' + DEPLOYMENT + '&api-key=' + KEY;
    this.ws = new WebSocket(url);
    this._startPlayback();

    // Oldingi (endi tugagan) suhbatda video/musiqa ishga tushirilgan bo'lsa
    // va hali eskirmagan bo'lsa, YANGI suhbat ham boshidanoq yuqori
    // chegara bilan boshlanadi — pastki izohga qarang (MEDIA_STATE_FILE).
    const startMediaAware = isMediaRecentlyLikelyPlaying();
    if (startMediaAware) this._mediaModeActive = true;

    this.ws.addEventListener('open', () => {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: loadInstructions(),
          voice: VOICE,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          // silence_duration_ms oshirildi (600->900) — juda qisqa pauza/nafas
          // olishni ham "gap tugadi" deb bo'lib yubormasin (bitta uzun gap
          // ikkiga bo'linib, har biriga alohida javob berilishi natijada
          // "bir xil narsani bir necha marta aytish" holatiga sabab bo'lgan).
          turn_detection: startMediaAware
            ? { type: 'server_vad', threshold: 0.92, silence_duration_ms: 1000, prefix_padding_ms: 300 }
            : { type: 'server_vad', threshold: 0.6, silence_duration_ms: 900, prefix_padding_ms: 300 },
          // Eslatma: bu yerdagi transkript FAQAT lognoma/diagnostika va
          // ish-holatini kuzatish (idle-timer) uchun ishlatiladi — asosiy
          // ovozli javob gpt-realtime modelining o'zi TO'G'RIDAN-TO'G'RI
          // audio orqali (bu transkriptga BOG'LIQ BO'LMAGAN holda) generatsiya
          // qilinadi. Shunga qaramay aniqroq bo'lgani foydali (loglarni
          // tekshirish, xatolarni topish uchun) — shuning uchun whisper-1'dan
          // gpt-4o-transcribe'ga o'tkazildi (real Azure endpoint sinovidan
          // o'tkazilgan: qabul qilinishi tasdiqlandi, WER ko'p tillarda
          // whisper-1'dan sezilarli yaxshiroq). "uz" tili kodi bu resursda
          // (whisper-1'da HAM, gpt-4o-transcribe'da HAM) qo'llab-quvvatlanmaydi
          // — Azure'ning o'zi qaytargan ro'yxatda yo'q (real xato orqali
          // tasdiqlandi) — shuning uchun language maydoni qo'yilmaydi,
          // model avtomatik aniqlashiga tayaniladi. "prompt" ORQALI namuna
          // gap qo'yish avval xavfli bo'lib chiqqan edi (audio xira/tinch
          // bo'lganda Whisper prompt matnini AYNAN o'zini "foydalanuvchi
          // shuni aytdi" deb halyutsinatsiya qilib qaytargan) — shuning
          // uchun prompt hamon qo'yilmaydi.
          input_audio_transcription: { model: 'gpt-4o-transcribe' },
          tools: buildTools(),
          tool_choice: 'auto'
        }
      }));
      this.ready = true;
      this.emit('ready');
    });

    this.ws.addEventListener('message', (ev) => this._onMessage(ev));
    this.ws.addEventListener('error', (ev) => {
      // Node'ning ErrorEvent'ida .message/.error xususiyatlari ko'pincha
      // enumerable emas — JSON.stringify(ev) shunchaki "{}" berardi, hech
      // narsa ko'rsatmasdan. Xususiyatlarga to'g'ridan-to'g'ri murojaat
      // qilamiz.
      const reason = ev?.error?.message || ev?.message || ev?.error?.code || ev?.type || 'noma\'lum (ws close race bo\'lishi mumkin)';
      this.emit('error', new Error('WebSocket xatolik: ' + reason));
    });
    this.ws.addEventListener('close', () => { this.closed = true; this._stopPlayback(); this.emit('close'); });
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    switch (msg.type) {
      case 'input_audio_buffer.speech_started':
        // Foydalanuvchi gapira boshladi — agar Jarvis gapirayotgan bo'lsa, to'xtatib eshitishga o'tadi (barge-in)
        if (this.assistantSpeaking) {
          try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
          this._flushPlayback();
        }
        this.emit('user_speaking');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.userTranscript = msg.transcript || '';
        this.emit('user_transcript', this.userTranscript);
        break;
      case 'response.audio_transcript.delta':
        this.assistantTranscript += msg.delta || '';
        break;
      case 'response.audio.delta':
        this.assistantSpeaking = true;
        this._playChunk(Buffer.from(msg.delta, 'base64'));
        break;
      case 'response.function_call_arguments.delta':
        this._pendingFnArgs[msg.call_id] = (this._pendingFnArgs[msg.call_id] || '') + (msg.delta || '');
        break;
      case 'response.function_call_arguments.done':
        this._handleFunctionCall(msg);
        break;
      case 'response.done':
        this.assistantSpeaking = false;
        this._speakEndedAt = Date.now();
        if (this.assistantTranscript.trim()) {
          this.emit('assistant_transcript', this.assistantTranscript.trim());
        }
        this.assistantTranscript = '';
        this.emit('turn_done');
        break;
      case 'error': {
        const errMsg = msg.error?.message || JSON.stringify(msg);
        // Bular haqiqiy xatolik emas — javob aynan tugab qolgan payt bekor
        // qilishga urinish yoki ikkita response bir vaqtda so'ralishi kabi
        // tabiiy poyga holatlari (Realtime API'ning o'zi shunday ishlaydi).
        // Konsolni chalg'itmasdan jim o'tkazib yuboriladi.
        const benign = /no active response found|already has an active response in progress/i.test(errMsg);
        if (!benign) this.emit('error', new Error(errMsg));
        break;
      }
    }
  }

  // Bu funksiya har bir chaqiruv uchun MUSTAQIL ravishda (kutmasdan) chaqiriladi
  // (qarang: _onMessage'dagi 'response.function_call_arguments.done' — await
  // qilinmaydi), shuning uchun bir nechta task chindan parallel ishlaydi.
  // Har biriga o'ziga xos session_key berilishi — ular bir-birining
  // kontekstini buzmasligini kafolatlaydi.
  async _handleFunctionCall(msg) {
    if (msg.name === 'note_pronunciation') { this._handleNotePronunciation(msg); return; }
    if (msg.name === 'fast_action') { this._handleFastAction(msg); return; }
    if (msg.name === 'see_screen') { this._handleSeeScreen(msg); return; }
    if (msg.name === 'cancel_task') { this._handleCancelTask(msg); return; }
    if (msg.name === 'recall_memory') { this._handleRecallMemory(msg); return; }
    if (msg.name !== 'run_task') return;
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const description = args.description || '';
    const taskSessionKey = 'agent:main:jarvis-task-' + msg.call_id;
    this.emit('tool_call', description, msg.call_id);

    // MUHIM: media-tekshiruvi vazifa TUGAGANDAN keyin emas, DARHOL (hali
    // bajarilayotganda) qo'llaniladi — chunki video ko'pincha vazifaning
    // o'zi tugashidan OLDIN, uning ICHIDA (masalan play tugmasi bosilgan
    // zahoti) ijro bo'la boshlaydi. Kech qo'llansa, video allaqachon bir
    // necha soniya ijro bo'lib, noto'g'ri "gapirish" sifatida qabul
    // qilinib ulgurgan bo'lardi (real holatlarda kuzatildi).
    if (/video|musiqa|youtube|ijro|play|pauz|davom ettir|qo'shiq|klip/i.test(description)) {
      this._setMediaLikelyPlaying();
    }

    const result = await runFullAgent(description, taskSessionKey, (proc) => {
      this._runningTasks.set(msg.call_id, { proc, description });
    });
    this._runningTasks.delete(msg.call_id);
    this.emit('tool_result', result, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: result.slice(0, 4000) }
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    } catch (e) {}
  }

  // Butun xotira tarixi bo'ylab ma'no qidiruvi. Indeks fonda (daemon
  // tomonidan) yangilab turilgani uchun bu yerda faqat o'qish bo'ladi —
  // ~1 soniya. run_task orqali qilinsa 15-25 soniya ketardi.
  async _handleRecallMemory(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const query = args.query || '';
    this.emit('tool_call', 'recall_memory: ' + query, msg.call_id);
    let output;
    try {
      const r = await require('../memory').semanticSearch(query, 5);
      if (r.status === 'ok' && r.results && r.results.length) {
        output = r.results
          .map(x => '[' + x.date + ' ' + x.time + '] ' + x.topic + ': ' + String(x.snippet || '').replace(/\s+/g, ' ').slice(0, 400))
          .join('\n---\n');
      } else {
        output = 'Bu haqda xotirada hech narsa topilmadi.';
      }
    } catch (e) {
      output = 'Xotirani qidirib bo\'lmadi: ' + (e.message || '').slice(0, 150);
    }
    this.emit('tool_result', output.slice(0, 200), msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 4000) }
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    } catch (e) {}
  }

  // Foydalanuvchi "to'xtat" deganda — ishlayotgan run_task jarayonlarini
  // darhol o'ldiradi. Avval boshlangan vazifani to'xtatishning umuman
  // iloji yo'q edi: u tugaguncha (3 daqiqagacha) kutish kerak edi.
  _handleCancelTask(msg) {
    const n = this.cancelRunningTasks();
    const output = n > 0 ? ('To\'xtatildi (' + n + ' ta vazifa).') : 'Hozir bajarilayotgan vazifa yo\'q edi.';
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output }
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    } catch (e) {}
  }

  // run_task'dan farqli — bu og'ir sub-agent'ni ishga tushirmaydi, faqat
  // faylga tez yozadi (xotira, LLM chaqiruvi shart emas), shuning uchun
  // to'g'ridan-to'g'ri (await'siz) va sinxron tarzda bajariladi.
  _handleNotePronunciation(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    let result = 'ok';
    try { require('../memory').addPronunciationNote(args.misheard, args.actual); }
    catch (e) { result = 'error: ' + e.message; }
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: result }
      }));
      // response.create atayin CHAQIRILMAYDI — bu foydalanuvchiga aytiladigan
      // gap emas, faqat ichki xotira yozuvi (tool description'da ham shu
      // aniq aytilgan: "hech narsa demasdan javob qaytarmang").
    } catch (e) {}
  }

  // run_task'ga qaraganda ANCHA tez — to'liq agent (LLM fikrlash zanjiri)
  // ishga tushirilmaydi, to'g'ridan-to'g'ri tizim buyrug'i bajariladi
  // (qarang: skills/fast-actions). "tool_call"/"tool_result" hodisalari
  // atayin run_task bilan BIR XIL nomda emitted qilinadi — shu bilan
  // jarvis_daemon.js'dagi mavjud rtTaskStarted/rtTaskCompleted kuzatuvi
  // (dashboard "JONLI VAZIFALAR" paneli) buni ham avtomatik ko'rsatadi,
  // qo'shimcha ulash shart emas.
  async _handleFastAction(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const id = args.id || '';
    this.emit('tool_call', 'fast_action: ' + id, msg.call_id);
    // Musiqa/video ijro qiluvchi action'lar ham mikrofonga "sizib kirish"
    // xavfini tug'diradi — run_task'dagi bilan bir xil himoya.
    if (/^media:/.test(id)) this._setMediaLikelyPlaying();
    let result;
    try { result = await require('../fast-actions').runFastAction(id); }
    catch (e) { result = { status: 'error', message: e.message }; }
    const output = (result.status === 'ok' ? result.message : ('Xatolik: ' + result.message)) || 'Bajarildi.';
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 1000) }
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    } catch (e) {}
  }

  // Ekranni suratga olib, rasmni SHU suhbatga qo'shadi — model uni
  // o'zi ko'radi (alohida vision-model chaqiruvi ham, run_task ham
  // kerak emas). Rasm 900px gacha kichraytiriladi: token narxi va
  // yuborish vaqti ancha kamayadi, matn esa hali o'qish uchun yetarli.
  async _handleSeeScreen(msg) {
    this.emit('tool_call', 'see_screen: ekranga qaraldi', msg.call_id);
    const tmpRaw = path.join('/tmp', 'jarvis-rt-see-' + Date.now() + '.png');
    const tmpSmall = tmpRaw.replace('.png', '-s.png');
    let b64 = null, errMsg = null;
    try {
      execFileSync('screencapture', ['-x', tmpRaw], { timeout: 8000 });
      try { execFileSync('sips', ['-Z', '900', tmpRaw, '--out', tmpSmall], { timeout: 8000, stdio: 'ignore' }); }
      catch (e) { /* sips ishlamasa, asl o'lchamdagi rasm ishlatiladi */ }
      const useFile = fs.existsSync(tmpSmall) ? tmpSmall : tmpRaw;
      b64 = fs.readFileSync(useFile).toString('base64');
    } catch (e) {
      errMsg = 'Ekranni suratga ololmadim: ' + (e.message || '').slice(0, 150);
    }
    for (const f of [tmpRaw, tmpSmall]) { try { fs.unlinkSync(f); } catch (e) {} }

    try {
      // Avval funksiya natijasi (protokol talabi), keyin rasmning o'zi
      // alohida element sifatida qo'shiladi — function_call_output faqat
      // matn qabul qiladi, rasm esa 'user' rolli xabar ichida yuboriladi.
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: errMsg || 'Ekran surati qo\'shildi.' }
      }));
      if (b64) {
        this.ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message', role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,' + b64 },
              { type: 'input_text', text: '(Foydalanuvchining hozirgi ekrani — savoliga shu asosda javob bering.)' }
            ]
          }
        }));
      }
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    } catch (e) {}
    this.emit('tool_result', errMsg || 'Ekran ko\'rildi', msg.call_id);
  }

  _setMediaLikelyPlaying() {
    saveMediaState(); // keyingi (yangi) suhbatlar ham buni bilishi uchun — connect() dagi izohga qarang
    if (this._mediaModeActive) return;
    this._mediaModeActive = true;
    try {
      // 0.8 yetarli emasligi real holatlarda tasdiqlandi (YouTube video
      // audiosi — musiqa, "obuna bo'ling" kabi urg'ular — hali ham
      // "foydalanuvchi gapiryapti" deb qabul qilinardi). 0.92'ga
      // oshirildi — foydalanuvchining yaqin, aniq ovozi baribir
      // ushlanadi, video/fon tovushi esa deyarli hech qachon o'zi
      // shuncha balandlikda bo'lmaydi.
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: { turn_detection: { type: 'server_vad', threshold: 0.92, silence_duration_ms: 1000, prefix_padding_ms: 300 } }
      }));
    } catch (e) {}
  }

  // Suhbat davomida foydalanuvchi haqiqatan gapirganda (transkript kelganda)
  // — bu media rejimi kerak bo'lmasligi mumkinligini bildiradi, lekin xato
  // bilan qayta pasaytirib false-negative qilib qo'ymaslik uchun shu
  // holatni qayta oddiy sezgirlikka QAYTARMAYMIZ (mediyaning o'zi
  // to'xtatilmagan bo'lishi mumkin) — session tugaguncha shu darajada qoladi.

  // Mikrofondan kelgan xom 16kHz PCM chunk'ni oqimga qo'shadi.
  // Jarvis gapirayotganda (va gapirib bo'lgandan keyin qisqa vaqt) mikrofon
  // audiosi YUBORILMAYDI — aks holda karnaydan chiqqan o'z ovozini mikrofon
  // qayta eshitib, server buni "foydalanuvchi gapiryapti" deb tushunib,
  // Jarvisni o'zini-o'zi uzluksiz to'xtatib qo'yardi (echo/aks-sado bekor
  // qilish apparat darajasida yo'q, shuning uchun dasturiy chora).
  // MUHIM: 500ms yetarli emas ekan (real loglarda tasdiqlandi — Jarvis o'z
  // gapini "foydalanuvchi aytdi" deb qayta eshitib, o'ziga javob berardi).
  // Sabablari: (1) xona akustikasi/karnay balandligiga qarab tovush
  // pasayishi 500ms'dan ko'proq davom etishi mumkin, (2) `response.done`
  // audio ijrosi TUGAGANDA emas, SERVERDAN oxirgi bo'lak kelganda keladi —
  // sox'ning o'z pleer navbatida hali ijro etilmagan audio qolgan bo'lishi
  // mumkin. Shuning uchun grace vaqti ancha oshirildi.
  feedAudio(pcm16_16k) {
    if (!this.ready || this.closed) return;
    if (this.assistantSpeaking || (Date.now() - this._speakEndedAt) < MIC_MUTE_GRACE_MS) return;
    const resampled = resample16to24(pcm16_16k);
    try {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: resampled.toString('base64') }));
    } catch (e) {}
  }

  _startPlayback() {
    this.playProc = spawn('sox', ['-t', 'raw', '-r', String(OUT_RATE), '-e', 'signed', '-b', '16', '-c', '1', '-', '-d'], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    this.playProc.on('error', () => {});
    // stdin EPIPE (masalan pleer jarayoni kutilmaganda o'lsa) qo'lga
    // olinmasa butun daemon'ni yiqitadi — shu yerda "yutib" qo'yiladi.
    this.playProc.stdin.on('error', () => {});
  }

  _playChunk(buf) {
    if (this.playProc && this.playProc.stdin.writable) {
      try { this.playProc.stdin.write(buf); } catch (e) {}
    }
  }

  _flushPlayback() {
    this._stopPlayback();
    this._startPlayback();
  }

  _stopPlayback() {
    if (this.playProc) { try { this.playProc.kill('SIGKILL'); } catch (e) {} this.playProc = null; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._stopPlayback();
    try { this.ws && this.ws.close(); } catch (e) {}
  }
}

module.exports = { RealtimeSession, resample16to24 };
