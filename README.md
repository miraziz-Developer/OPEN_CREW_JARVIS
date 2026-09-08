
## 🚀 Quick Install (1-click)

\`\`\`bash
bash <(curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh)
\`\`\`

# 🤖 JARVIS — O'zbek tilidagi Jarvis-darajali AI-yordamchi

## Tarif
**Jarvis** — Mac kompyuteringizda 24/7 doimiy ishlaydigan, ovoz bilan chaqiriladigan, kompyuteringizni avtonom boshqaradigan shaxsiy AI-agent.

> **Texnologiyalar:** OpenClaw + GPT-6 Astra (Azure Responses API) + Azure Realtime/Speech (uz-UZ) + macOS Desktop Control + Telegram

---

## ✨ Imkoniyatlar

### 🎙 Ovozli boshqaruv
- **"Jarvis"** deb chaqiring → eshitib turadi
- Buyruqingizni eshitadi, tushunadi, bajaradi
- Javobni ovozli (SardorNeural) qaytaradi
- Past latency asosiy yo‘l: **Azure Realtime (`gpt-realtime-2.1`) → native English STT/VAD → streaming voice**
- Deterministik desktop amallari lokal fast-action yo‘lidan, murakkab reasoning va grounded savollar esa GPT-6 Astra orqali bajariladi
- Xavfli/destructive amallar explicit, scoped, expiring va one-shot confirmation talab qiladi

### 📱 Telegram Bot
- **Matnli:** suhbat + buyruqlar + fayl topish/yuborish
- **Ovozli:** xabarni matnga aylantirib javob beradi
- **Skrinshot:** "skrinshot ol" buyrug'i bilan ekranni oladi

### 🖥 Kompyuter nazorati
- Ekranni tahlil qiladi
- Brauzer, ilovalar ochadi
- Fayllar bilan ishlash
- Skrinshot olish

### 🔭 Proactive (avtonom) rejim
- Har 30 daqiquda ekranni tahlil qiladi
- Muhim eslatmalarni avtomatik yuboradi
- Vazifalarni o'zi boshqaradi

---

## 🚀 Tez ishga tushirish

### Bitta buyruq bilan to'liq o'rnatish

```bash
cd ~/projects/OPEN_CREW_JARVIS
./setup.sh
```

Bu skript avtomatik ravishda `.env` yaratadi, kalitlar to'g'rligini tekshiradi, OpenClaw config validatsiyasini o'tkazadi, macOS LaunchAgent o'rnatadi, gateway health-check qiladi va "Jarvis tayyor" ovozli tasdiq beradi.

### Qo'lda boshqarish (LaunchAgent)

| Buyruq | Vazifa |
|--------|--------|
| `launchctl kickstart -k gui/$(id -u)/com.jarvis.openclaw` | Qayta ishga tushirish |
| `launchctl bootout gui/$(id -u)/com.jarvis.openclaw` | Joriy agentni to'xtatish |
| `./scripts/disable-autostart.sh` | Avtostartni o'chirish |
| `./scripts/enable-autostart.sh` | Avtostartni qayta yoqish |
| `npm run doctor` | Butun tizim uchun read-only health diagnostika |

### Tizim diagnostikasi

JARVIS holatini config, secret permission, binary, launchd, process ownership,
runtime heartbeat, gateway va dashboard API darajasida bitta buyruqda tekshiring:

```bash
npm run doctor
```

Monitoring yoki avtomatlashtirish uchun machine-readable natija:

```bash
npm run doctor -- --json
npm run doctor -- --strict   # warning mavjud bo‘lsa ham non-zero exit
```

Diagnostika read-only: servislarni restart qilmaydi va secret qiymatlarini
chiqarmaydi. Oddiy rejimda faqat error exit code `1` beradi; `--strict` rejimida
warning ham failure hisoblanadi.

---

## 📋 Tuzilma

```
OPEN_CREW_JARVIS/
├── .env                    # Maxfiy sozlamalar (gitignore)
├── .env.example            # Namuna
├── openclaw.json           # OpenClaw konfiguratsiyasi
├── telegram-bot.js         # Telegram bot (v8)
├── jarvis_daemon.js        # Doimiy eshitish daemon
└── skills/
    ├── azure-tts/          # Ovoz chiqarish (uz-UZ-SardorNeural)
    └── azure-stt/          # Ovozni tushunish (uz-UZ)
```

---

## 🔧 Sozlamalar

`.env` faylga quyidagilarni kiriting:

```bash
# AZURE SPEECH
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus2
AZURE_SPEECH_VOICE=uz-UZ-SardorNeural

# AZURE AI (GPT-6 Astra)
AZURE_OPENAI_KEY=...
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.services.ai.azure.com/openai/v1
AZURE_OPENAI_DEPLOYMENT=gpt-6-astra

# TELEGRAM
TELEGRAM_BOT_TOKEN=...
JARVIS_CHAT_ID=...         # Sizning Telegram chat ID

# OPENCLAW GATEWAY (openssl rand -hex 32 bilan yarating)
OPENCLAW_GATEWAY_TOKEN=...
```

---

## 🧪 Sinov

1. **Telegramda:** `@JarvisOzbekBot` ga `/start` yozing
2. **Ovozli:** "Jarvis, skrinshot ol" deb ayting
3. **Proactive:** 30 daqiqa kuting — avtomatik xabar keladi

### Shaxsiy audio kalibratsiya va real benchmark

```bash
npm run voice:calibrate
```

Kalibratsiya xona jimligi, tabiiy nutq va qisqa karnay probe'i orqali gain,
noise gate, barge-in hamda echo lag qiymatlarini o‘lchaydi. Xom audio
saqlanmaydi yoki bulutga yuborilmaydi; faqat raqamli profil
`.run/audio-calibration.json` ichida `0600` ruxsat bilan qoladi. So‘ng daemonni
restart qiling. `.env` ichidagi explicit qiymatlar profil ustidan ustun turadi.

Foydalanuvchi tekshirgan real natijalarni raw audio saqlamasdan private
benchmark corpusga qo‘shish:

```bash
npm run voice:sample -- --stt --expected="Chrome ni och" --recognized="Chrome och"
npm run voice:sample -- --wake --expected=true --detected=true --hours=1
npm run benchmark
```

Corpus `benchmarks/private/voice-corpus.json`da saqlanadi, Git’dan chiqarilgan
va `0600`. U WER/STT accuracy, wake recall va false-wake/day gate’larini real
namunalar bilan hisoblaydi.

Default benchmark faqat joriy daemon ishga tushganidan keyingi telemetry’ni
baholaydi. Shu sabab yangi build eski pipeline latency’si bilan aralashmaydi;
yangi live turn hali bo‘lmasa metric `not_measured` bo‘lib qoladi va false-green
release bermaydi. Tarixiy trendni alohida ko‘rish uchun:

```bash
node scripts/benchmark.js --all-history
node scripts/benchmark.js --since=1788854053767  # Unix epoch millisecond
```

`reports/quality-latest.json` latency’ni route (`realtime-conversation`,
`direct-fast-action`, `grounded-answer`, `expert-answer`) bo‘yicha ham ajratadi.
`voiceTelemetry.latency.stages` va `stagesByRoute` esa command acceptance’dan
routing, provider request/acknowledgement, first text, first server audio va
haqiqiy playback start’gacha bo‘lgan P50/P95 bosqichlarni ko‘rsatadi. Shu bilan
server/model kechikishi playback prebuffer yoki lokal action vaqtiga
aralashtirilmaydi; sample yo‘q bosqichlar `null` bo‘lib qoladi.

---

## ⚠️ Eslatmalar

- Mac-da **Accessibility**, **Screen Recording**, **Microphone** ruxsatlari kerak
- `.env` faylni **HECH QACHON** gitga qo'shmang
- Chat, issue yoki logga yuborilgan API key'ni darhol revoke/rotate qiling
- `openclaw.json` faqat `${OPENCLAW_GATEWAY_TOKEN}` environment reference saqlaydi; plaintext token commit qilmang
- Secret sizib chiqsa yangi qiymat yarating, servisni restart qiling va Git tarixini alohida tozalang
- Hotword eshitish mikrofonni doimiy ishlatadi

---

## 📜 Litsenziya
Loyiha maxfiy. FAQAT shaxsiy foydalanish uchun.
