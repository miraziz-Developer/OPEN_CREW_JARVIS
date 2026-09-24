# 🤖 JARVIS

Shaxsiy AI-yordamchi: **tez ovozli suhbat**, soatlab/kunlab **mustaqil ishlaydigan missiyalar**, **Telegram** orqali masofadan boshqaruv, xotira va iPhone/Mac boshqaruvi.

Azure Voice Live (ovoz) · OpenClaw agent · BabyAGI / AutoGPT / Open Interpreter / Browser-use ishchilari · Obsidian xotira

## Ikki ishlash rejimi

| | 🖥 **Mac** (to'liq) | 🐳 **Server** (Docker) |
|---|---|---|
| Ovozli suhbat, "Jarvis" chaqiruvi, gap bo'lish | ✅ | ❌ (mikrofon yo'q) |
| Ekran / ilova boshqaruvi, iPhone Mirroring | ✅ | ❌ |
| Telegram bot (matn, ovoz, fayl) | ✅ | ✅ |
| Avtonom missiyalar + agent ishchilari | ✅ | ✅ |
| Brauzer ishchisi | ✅ (Chrome profilingiz bilan) | ✅ (toza headless Chromium) |
| Ertalabki brifing, Gmail/Calendar | ✅ | ✅ |
| Dashboard | ✅ `localhost:7890` | ✅ SSH tunnel orqali |

Tavsiya: Mac'da to'liq JARVIS, serverda 24/7 missiyalar va Telegram uchun server rejimi.

## 🐳 Server o'rnatish (bitta buyruq)

Linux server (Ubuntu/Debian), yoki Docker o'rnatilgan har qanday mashina:

```bash
git clone https://github.com/miraziz-Developer/OPEN_CREW_JARVIS.git && cd OPEN_CREW_JARVIS
./server.sh          # birinchi marta .env yaratadi va nima to'ldirish kerakligini aytadi
nano .env            # kalitlarni yozing
./server.sh          # Docker'ni o'rnatadi (kerak bo'lsa), quradi, ishga tushiradi, tekshiradi
```

Majburiy kalitlar: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_OWNER_IDS` — botni boshqaradigan Telegram ID lar). Gateway tokeni avtomatik yaratiladi.

| Buyruq | Vazifa |
|---|---|
| `./server.sh status` | holat |
| `./server.sh logs` | jonli loglar |
| `./server.sh restart` | `.env` o'zgargandan keyin |
| `./server.sh update` | `git pull` + qayta qurish |
| `./server.sh stop` | to'xtatish (ma'lumotlar saqlanadi) |

Dashboard serverning tashqi tarmog'iga ochilmaydi; ko'rish uchun: `ssh -L 7890:localhost:7890 <server>` → http://localhost:7890.
Ma'lumotlar (xotira, missiyalar, tokenlar) Docker volume'larda — qayta qurishda yo'qolmaydi. Gmail/Calendar tokenini Mac'da olib (`node scripts/google-oauth-setup.js`), `.google-tokens.json` ni serverga nusxalash mumkin.

## 🖥 Mac o'rnatish

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh)
```

Homebrew paketlari, Node/Python muhitlari, `.env` (faqat kalitlarni so'raydi), wake-word, ishchilar, native aks-sado bekor qilish, launchd xizmatlari va `doctor` tekshiruvi. Qayta ishga tushirish xavfsiz. Keyin "Jarvis" deng.
Bir marta qo'lda: Tizim sozlamalari → Maxfiylik → Mikrofon, Accessibility, Automation, Screen Recording.

Kundalik: `npm run doctor` (holat) · `./jarvis restart` · loglar `logs/daemon-YYYYMMDD.log` · panel http://localhost:7890

## ⚙️ Sozlamalar (`.env`)

`.env.example` — barcha kalitlar (sirlar bo'sh). `.env` git'ga tushmaydi.

| Kalit | Ma'nosi |
|---|---|
| `AZURE_OPENAI_*` | agent va missiya modeli |
| `AZURE_VOICELIVE_*`, `AZURE_SPEECH_*` | ovoz (faqat Mac) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_IDS` | Telegram bot va egalari |
| `OPENCLAW_GATEWAY_TOKEN` | agent gateway (avtomatik yaratiladi) |
| `JARVIS_CONFIRM_MODE` | `off` (standart, tasdiqsiz) · `payments` (faqat pul) · `strict` |
| `MISSION_DAILY_TOKEN_BUDGET` | kunlik token ogohlantirishi (to'xtatmaydi, faqat xabar beradi) |

> ⚠️ `JARVIS_CONFIRM_MODE=off` da JARVIS to'lov va o'chirishni ham so'ramasdan bajaradi. Ehtiyot bo'lsangiz `payments` qo'ying.

## 🧭 Imkoniyatlar

- **Ovoz:** ~0.5–0.9 s birinchi audio, gap bo'lish (barge-in), "stop/boldi", doim eshitish, shaxsiy wake-model.
- **Tez amallar:** `web_open` (YouTube/Google/Maps), `close_app`, `file_op` + **undo**, ilova/ovoz boshqaruvi.
- **Missiyalar:** uzoq maqsad → reja → bajarish → dalil bilan tekshirish → takror. Ishchilar: `agent`, `interpreter`, `browser`, `gui`, `phone`, `babyagi`, `autogpt`, `think`.
- **Telefon:** iPhone Mirroring orqali ekranni ko'rish, bosish, yozish (Mac + bog'langan iPhone kerak).
- **Xotira:** Obsidian + semantik qidiruv, ekran/ilova konteksti, ertalabki brifing (missiyalar + kalendar + pochta).
- **Ishonchlilik:** watchdog o'zini tiklaydi, xarajat monitoringi, kunlik zaxira, xavfsizlik chegaralari.

## 🗂 Tuzilma

```
jarvis_daemon.js      Mac: ovozli daemon (mikrofon, wake, realtime)
telegram-bot.js       Telegram bot
core/                 missiyalar, ishchilar, LLM, xavfsizlik siyosati, telefon/ilova boshqaruvi
skills/               agent va ovoz ko'nikmalari (memory, gmail, calendar, desktop/phone-control, ...)
dashboard/            veb-panel
server/               Docker (server) rejimi: supervisor + fon ishlari
server.sh · Dockerfile · docker-compose.yml
scripts/              o'rnatish, doctor, zaxira, launchd, wake-model o'qitish
requirements/         Python muhitlari (aniq versiyalar)
tests/                `npm test`
docs/                 chuqur hujjatlar (autonomiya, xotira, egalik boshqaruvi)
```

## 🧪 Tekshiruv

```bash
npm test             # testlar (haqiqiy .env, tarmoq, Telegram'siz — izolyatsiyalangan)
npm run doctor       # Mac: tizim holati
npm run security:scan
```

## 🔒 Xavfsizlik

- `.env`, tokenlar va shaxsiy ma'lumotlar (`job-search/`, ovoz yozuvlari, modellar) git'ga tushmaydi.
- Telegram bot faqat `TELEGRAM_OWNER_IDS` dagilarga javob beradi.
- Dashboard autentifikatsiyasiz — tashqariga ochmang (faqat loopback / SSH tunnel).
- Ochiq repoga kalit tushib qolsa — darhol almashtiring.

Chuqur hujjatlar: [docs/autonomy.md](docs/autonomy.md) · [docs/memory-postgresql-migration.md](docs/memory-postgresql-migration.md) · [docs/owner-task-controls.md](docs/owner-task-controls.md)
