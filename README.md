
## 🚀 Quick Install (1-click)

\`\`\`bash
bash <(curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh)
\`\`\`

# 🤖 JARVIS — O'zbek tilidagi Jarvis-darajali AI-yordamchi

## Tarif
**Jarvis** — Mac kompyuteringizda 24/7 doimiy ishlaydigan, ovoz bilan chaqiriladigan, kompyuteringizni avtonom boshqaradigan shaxsiy AI-agent.

> **Texnologiyalar:** OpenClaw + Kimi K2.6 (Azure) + Azure Speech (uz-UZ) + macOS Desktop Control + Telegram

---

## ✨ Imkoniyatlar

### 🎙 Ovozli boshqaruv
- **"Jarvis"** deb chaqiring → eshitib turadi
- Buyruqingizni eshitadi, tushunadi, bajaradi
- Javobni ovozli (SardorNeural) qaytaradi

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
| `launchctl start com.jarvis.openclaw` | Qo'lda ishga tushirish |
| `launchctl stop com.jarvis.openclaw` | To'xtatish |
| `./scripts/disable-autostart.sh` | Avtostartni o'chirish |
| `./scripts/enable-autostart.sh` | Avtostartni qayta yoqish |
```

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
    ├── azure-tts/          # Ovoz chiqarish (uz-UZ-ZardorNeural)
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

# AZURE AI (Kimi K2.6)
AZURE_OPENAI_KEY=...
AZURE_OPENAI_ENDPOINT=...

# TELEGRAM
TELEGRAM_BOT_TOKEN=...
JARVIS_CHAT_ID=...         # Sizning Telegram chat ID
```

---

## 🧪 Sinov

1. **Telegramda:** `@JarvisOzbekBot` ga `/start` yozing
2. **Ovozli:** "Jarvis, skrinshot ol" deb ayting
3. **Proactive:** 30 daqiqa kuting — avtomatik xabar keladi

---

## ⚠️ Eslatmalar

- Mac-da **Accessibility**, **Screen Recording**, **Microphone** ruxsatlari kerak
- `.env` faylni **HECH QACHON** gitga qo'shmang
- Hotword eshitish mikrofonni doimiy ishlatadi

---

## 📜 Litsenziya
Loyiha maxfiy. FAQAT shaxsiy foydalanish uchun.
