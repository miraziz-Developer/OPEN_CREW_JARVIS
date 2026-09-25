# 🤖 JARVIS

Mac uchun shaxsiy AI-yordamchi: **tez ovozli suhbat** ("Jarvis" deb chaqirasiz), soatlab/kunlab **mustaqil ishlaydigan missiyalar**, **Telegram** orqali masofadan boshqaruv, xotira, ekran/ilova va **iPhone boshqaruvi**.

> Azure Voice Live (ovoz) · OpenClaw agenti · BabyAGI / AutoGPT / Open Interpreter / Browser-use ishchilari · Obsidian xotira

---

## 1. O'rnatishdan oldin nima kerak

**Kompyuter:** Mac (macOS 13+; Apple Silicon'da sinalgan). iPhone boshqaruvi uchun macOS 15+ va Apple Silicon. Bo'sh joy ~8 GB. Internet.

**Hisoblar va kalitlar** (o'rnatuvchi ularni so'raydi va darhol tekshiradi):

| Nima | Nima uchun | Qayerdan olinadi |
|---|---|---|
| **Azure OpenAI** — endpoint, kalit, model nomi (`gpt-5-mini`) | JARVIS ning "miyasi": agent va missiyalar | [Azure AI Foundry](https://ai.azure.com) → project → *Endpoints and keys* → *Deploy model* |
| **Azure Voice Live** — realtime model (`gpt-realtime`) | ovozli suhbat | xuddi shu Foundry project'da `gpt-realtime` ni deploy qiling |
| **Azure Speech** — kalit va region | eshitish va gapirish | Azure portal → *Speech service* → *Keys and Endpoint* |
| **Telegram bot** *(ixtiyoriy)* | telefondan boshqarish, xabarnomalar | Telegram'da [@BotFather](https://t.me/BotFather) → `/newbot` |
| **Google OAuth** *(ixtiyoriy)* | Gmail va Calendar | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth client (Desktop) → JSON yuklab olish |

> 💸 Ovozli suhbat va avtonom missiyalar Azure xarajati keltiradi (ayniqsa doim eshitish rejimi). JARVIS xarajat oshsa Telegramga **xabar beradi**, lekin ishni to'xtatmaydi.

## 2. O'rnatish (bitta buyruq)

```bash
git clone https://github.com/miraziz-Developer/OPEN_CREW_JARVIS.git
cd OPEN_CREW_JARVIS
./install.sh
```

Yoki repo'ni klonlamasdan:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh)
```

Skript o'zi, ketma-ket:

1. Kompyuteringizni tekshiradi (macOS, chip, bo'sh joy, internet). Faqat tekshirish uchun: `./install.sh --check` (hech narsa o'zgartirmaydi).
2. Kerak bo'lsa Xcode vositalari va Homebrew'ni o'rnatadi (avval so'raydi).
3. Homebrew paketlari: Node, Python 3.11/3.12, sox, ffmpeg, cliclick, yt-dlp, uv, whisper-cpp; OpenClaw agenti.
4. **Kalitlarni bosqichma-bosqich so'raydi** (yuqoridagi jadval). Har biri nima ekani yoziladi, kalit terminalda ko'rinmaydi va **kiritilishi bilan tekshiriladi** (✅ ishlayapti / ❌ noto'g'ri). Faqat shu kompyuterdagi `.env` (0600) ga yoziladi, git'ga tushmaydi.
5. Xavfsizlik (tasdiq) rejimini so'raydi (4-bo'lim).
6. Wake-word, avtonom ishchilar (Python muhitlari, brauzer) va aks-sadoni bekor qiluvchi native yordamchini kompyuteringizga moslab quradi.
7. Avtostartni (launchd) yoqadi va JARVIS ni ishga tushiradi.
8. `doctor` bilan tekshiradi va macOS ruxsat oynalarini ochishni taklif qiladi.

Qayta ishga tushirish xavfsiz: to'ldirilgan kalitlarni qayta so'ramaydi. Hammasini boshidan sozlash: `./install.sh --reconfigure`. Og'ir ishchilarni keyinga qoldirish: `./install.sh --skip-workers` (keyin `bash scripts/install-workers.sh`).

### macOS ruxsatlari (bir marta, faqat siz bera olasiz)

Tizim sozlamalari → Maxfiylik va xavfsizlik → **Mikrofon**, **Accessibility**, **Automation**, **Screen Recording** → *Terminal* (yoki `node`) ni yoqing. So'ng: `./jarvis restart`.

## 3. Birinchi ishga tushirish

1. `./jarvis status` — "running" va dashboard ko'rinishi kerak. Batafsil: `npm run doctor` (hammasi yashil bo'lsa tayyor).
2. **"Jarvis"** deng — javob berishi kerak. Doim eshitish yoqiq: faqat "Jarvis" deganingizdagina javob beradi.
3. Telegram ulagan bo'lsangiz: botingizga `/start` yozing. `TELEGRAM_OWNER_IDS` bo'sh bo'lsa, birinchi yozgan odam ega bo'lib juftlashadi.
4. Yaxshiroq eshitishi uchun (ixtiyoriy, ~5 daqiqa) wake-word modelini o'z ovozingizda o'qiting: `npm run voice:wake-collect` → `npm run voice:wake-train`.

## 4. Ishlatish

### Ovoz bilan

| Deng | Nima bo'ladi |
|---|---|
| "Jarvis, Safari och" · "Telegram'ni yop" · "ovozni pasaytir" | ilova/tizim amallari (bir soniyada) |
| "YouTube'da Billie Jean qo'y" · "Google'da … ni qidir" | veb amallari (~2 soniya) |
| "Hujjatlar papkasiga report.pdf ni ko'chir" · "**undo**" | fayl amallari; oxirgi amalni qaytaradi (o'chirish Trash'ga tushadi) |
| "Ertaga soat 9 ga eslatma qo'y" · "kalendarimda nima bor?" | eslatma/kalendar (Google ulangan bo'lsa) |
| "Pochtamni tekshir" | Gmail (Google ulangan bo'lsa) |
| "**Missiya boshla:** har kuni ertalab remote Python ishlarini top va reyting qil" | uzoq maqsad — fonda reja → bajarish → tekshirish |
| "Missiyalar holati?" · "3-missiyani pauza qil / davom et / bekor qil" | missiya boshqaruvi |
| "Telefonimdagi WhatsApp'ni tekshir" | iPhone Mirroring orqali telefonni ko'rib boshqaradi (pastga qarang) |
| "stop" / "boldi" | gapirayotganini darhol to'xtatadi |

Gap bo'lish mumkin: JARVIS gapirayotganda gapirsangiz to'xtab, sizni tinglaydi. Javoblar ataylab qisqa.

**Fn+Shift** — JARVIS ni to'liq to'xtatish/uyg'otish (mikrofon ham o'chadi). Doctor'da "JARVIS pauzada" chiqsa, sabab shu.

### Telegram orqali (uydan tashqarida ham)

Botga matn, **ovozli xabar** yoki dumaloq video yuboring — agent javob beradi va ishni bajaradi. "Skrinshot ol", "faylni top va yubor" ham ishlaydi. Missiyalar tugaganda, bloklanganda yoki xarajat oshganda **qisqa xabar** keladi; har kuni ertalab **brifing** (missiyalar + kalendar + pochta).

### Missiyalar

Missiya — soatlab/kunlab davom etadigan maqsad. JARVIS uni bosqichlarga bo'ladi va ishchilarga topshiradi: `agent` (kompyuter), `interpreter` (kod/terminal), `browser` (veb), `gui` (ekran), `phone` (iPhone), `babyagi`, `autogpt`, `think`. Har bosqich dalil bilan tekshiriladi. Holat: ovozda "missiyalar holati", yoki panel: http://localhost:7890.

### iPhone boshqaruvi

Talab: macOS 15+, Apple Silicon, iPhone bir xil Apple ID'da. Bir marta: *iPhone Mirroring* ilovasini oching va telefonni Face ID bilan tasdiqlang. Keyin "telefonimda …" deb so'rang. JARVIS telefon ekranini ko'radi, bosadi, yozadi. Telefon qulflangan yoki uzoqda bo'lsa "ulanmagan" deydi.

### Tasdiq rejimi (`JARVIS_CONFIRM_MODE` `.env` da)

| Qiymat | Ma'nosi |
|---|---|
| `payments` *(o'rnatuvchi tavsiyasi)* | faqat pul/to'lov uchun ovozda "confirm" so'raydi |
| `off` | hech qachon so'ramaydi — **to'lov va o'chirishni ham** o'zi bajaradi |
| `strict` | xat yuborish, o'chirish, ariza va boshqa xavfli ishlarda ham so'raydi |

O'zgartirgach: `./jarvis restart`.

### Ixtiyoriy ulanishlar

```bash
node scripts/google-oauth-setup.js          # Gmail + Calendar (Google Cloud'dan client_secret*.json ~/Downloads da bo'lsin)
python3 scripts/chrome-profile-sync.py      # brauzer ishchisi Chrome akkauntingiz bilan kirsin
```

## 5. Kundalik buyruqlar

| Buyruq | Vazifa |
|---|---|
| `./jarvis status` | ishlayaptimi |
| `./jarvis restart` / `stop` / `start` | boshqaruv |
| `./jarvis logs` | jonli loglar (`logs/` papkasi) |
| `npm run doctor` | to'liq tizim tekshiruvi |
| `./jarvis update` | yangi versiyani olish va qayta ishga tushirish |
| `./jarvis reconfigure` | kalitlarni qayta kiritish |
| `./jarvis uninstall` | avtostart va xizmatlarni o'chirish (kod va ma'lumotlarga tegmaydi) |
| `./jarvis open` | panelni ochish |

Zaxira nusxa har kuni 03:30 da avtomatik (`scripts/backup.sh`).

## 6. Muammolar

| Belgi | Yechim |
|---|---|
| "Jarvis" desam javob bermaydi | Mikrofon ruxsati? `npm run doctor`; pauzada emasmi (Fn+Shift)? `npm run diagnose:voice` |
| doctor: "JARVIS pauzada" | Fn+Shift bosing yoki `./jarvis start` |
| Telegram jim | `.env` da `TELEGRAM_BOT_TOKEN`; botga `/start`; `./jarvis logs` |
| "gateway" qizil | `./jarvis restart`; `openclaw gateway` ni qo'lda ishga tushirib ko'ring |
| Ovoz kesilib/titrab chiqadi | `bash scripts/build-voice-io.sh` (aks-sado bekor qilish), keyin `./jarvis restart` |
| Agent skilllarni ko'rmayapti | `bash scripts/sync-workspace.sh` (har ishga tushishda o'zi bajariladi) |
| Kalit almashtirdim | `.env` ni tahrirlang → `./jarvis restart` |

Loglar: `logs/daemon-YYYYMMDD.log`, `logs/mission-runner.stdout.log`.

## 7. Sozlamalar

`.env.example` — barcha kalitlar (sirlar bo'sh). Eng muhimlari:

| Kalit | Ma'nosi |
|---|---|
| `AZURE_OPENAI_*` | agent va missiya modeli |
| `AZURE_VOICELIVE_*`, `AZURE_SPEECH_*` | ovoz |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_IDS` | Telegram bot va egalari (faqat ular boshqara oladi) |
| `JARVIS_CONFIRM_MODE` | tasdiq rejimi (yuqoriga qarang) |
| `MISSION_DAILY_TOKEN_BUDGET` | kunlik token ogohlantirishi (to'xtatmaydi, faqat xabar beradi) |
| `JARVIS_ALWAYS_LISTEN` | doim eshitish (`true`) yoki faqat chaqirilganda |
| `MORNING_BRIEF_HOUR` | ertalabki brifing soati (standart 8) |

## 8. Tuzilma

```
install.sh · jarvis          o'rnatish va boshqaruv
jarvis_daemon.js             ovozli daemon (mikrofon, wake, realtime)
telegram-bot.js              Telegram bot
core/                        missiyalar, ishchilar, LLM, xavfsizlik, telefon/ilova boshqaruvi
skills/                      agent va ovoz ko'nikmalari (memory, gmail, calendar, desktop/phone-control, ...)
dashboard/                   veb-panel (faqat localhost)
scripts/                     o'rnatish, doctor, update, zaxira, launchd, wake-model o'qitish
requirements/                Python muhitlari (aniq versiyalar)
tests/                       npm test
docs/                        chuqur hujjatlar
```

## 9. Xavfsizlik va cheklovlar

- Faqat **macOS**: mikrofon, ekran, iPhone Mirroring va launchd shunga bog'liq. Intel Mac'da sinalmagan.
- `.env`, tokenlar, ovoz yozuvlari va shaxsiy ma'lumotlar git'ga tushmaydi. Repo'ga kalit tushib qolsa — darhol almashtiring.
- Telegram bot faqat `TELEGRAM_OWNER_IDS` dagilarga javob beradi. Panel autentifikatsiyasiz — tashqariga ochmang.
- JARVIS kompyuteringiz va telefoningizni boshqara oladi: `JARVIS_CONFIRM_MODE=off` ni faqat o'zingiz xohlasangiz qo'ying.
- Ba'zi macOS ruxsatlari faqat siz bera olasiz, o'rnatuvchi ularni avtomatik bermaydi.

## 10. Rivojlantiruvchilar uchun

```bash
npm test                 # testlar (haqiqiy .env, tarmoq va Telegram'siz ishlaydi)
npm run security:scan    # maxfiy ma'lumot skaneri
```

Chuqur hujjatlar: [docs/autonomy.md](docs/autonomy.md) · [docs/memory-postgresql-migration.md](docs/memory-postgresql-migration.md) · [docs/owner-task-controls.md](docs/owner-task-controls.md)
