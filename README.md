# 🇺🇿 JARVIS — OpenClaw + Azure (Kimi 2.6) asosidagi O'zbek AI-yordamchi

macOSda 24/7 ishlaydigan, ovoz bilan chaqiriladigan, kompyuterni boshqaruvchi va **100% o'zbek tilida** javob beruvchi AI-yordamchi.

## 📁 Loyiha tuzilishi

```
OPEN_CREW_JARVIS/
├── .env                    # 🔒 Haqiqiy kalitlar (gitignore'da)
├── .env.example            # 📋 Kerakli o'zgaruvchilar namunasi
├── .gitignore              # Maxfiy/lokal fayllarni qo'sh
├── README.md               # Ushbu fayl
├── openclaw.json           # 🔧 OpenClaw konfiguratsiyasi (workspace ichida emas)
└── skills/
    ├── azure-stt/          # 🎤 Azure STT — o'zbekcha ovozni matnga
    │   ├── SKILL.md
    │   ├── index.js
    │   └── package.json
    └── azure-tts/          # 🔊 Azure TTS — o'zbekcha ovoz chiqarish
        ├── SKILL.md
        ├── index.js
        └── package.json
```

- **OpenClaw workspace:** `~/.openclaw/workspace/` — shaxsiyat fayllari (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`)
- **OpenClaw config:** `~/.openclaw/openclaw.json` — provayder, model, gateway sozlamalari

## 🚀 Ishga tushirish

### 1. Tayyorgarlik

1. OpenClaw o'rnatilgan va yangilanganligini tekshiring:
   ```bash
   openclaw --version   # 2026.7.1 va undan yuqori
   ```

2. `.env.example` dan nusxa olib, haqiqiy qiymatlarni kiriting:
   ```bash
   cp .env.example .env
   # .env faylini tahrirlang (Visual Studio Code, nano, vim)
   ```

   Kerakli o'zgaruvchilar:
   - `AZURE_OPENAI_KEY` — Azure AI / Kimi endpoint kaliti
   - `AZURE_SPEECH_KEY` — Azure Speech xizmati kaliti
   - `AZURE_SPEECH_REGION` — masalan `southeastasia`

3. Kalitni terminal session'ga uzating:
   ```bash
   export AZURE_OPENAI_KEY="sizning_kalitingiz"
   export AZURE_SPEECH_KEY="speech_kalitingiz"
   ```

### 2. Konfiguratsiya

Konfiguratsiya allaqachon `~/.openclaw/openclaw.json` ga yozildi. Quyidagilarni tekshiring:

```bash
openclaw config validate
openclaw models list
```

Default model `kimi-azure/Kimi-K2.6` ko'rinishi kerak.

### 3. macOS ruxsatlari (MUHIM — foydalanuvchi qo'lda bajarishi kerak)

System Settings → Maxfiylik va xavfsizlik:

1. **Accessibility** → OpenClaw.app yoki terminal qo'shish
2. **Screen & System Audio Recording** → OpenClaw/qurilma qo'shish
3. **Full Disk Access** → Kerak bo'lsa qo'shish
4. **Microphone** → OpenClaw/qurilma mikrofon ruxsati

### 4. Gateway ishga tushirish

```bash
openclaw gateway start
```

Terminalda `Gateway running on http://127.0.0.1:18789` degan xabar ko'rinadi.

### 5. Suhbat boshlash

```bash
openclaw agent
```

Yoki OpenClaw desktop ilovasini oching.

## 🧪 Sinov rejimi

Quyidagilarni tekshiring:

| # | Sinov | Muvaffaqiyat mezoni |
|---|---|---|
| 1 | Matnli chat: "Salom, bugun qanday ob-havo?" | Agent javobi faqat o'zbek tilida, lotin alifbosida |
| 2 | Ovozli buyruq: "Ekranni skrinshoot qil" | STT o'zbek nutqini to'g'ri matnga aylantiradi |
| 3 | Agent javobini ovoz eshitish | SardorNeural ovozida o'zbek tilida javob beradi |
| 4 | Kompyuter buyrug'i: "Brauzerni och" | Desktop nazorati orqali amal bajariladi |
| 5 | Til barqarorligi | 5 ta turli savolga o'zbek tilida javob (boshqa tilga o'tmaydi) |

## 🛡️ Xavfsizlik

- **`.env`** fayli `.gitignore`da — hech qachon commit qilmang!
- Maxfiy kalitlarni hech qachon kod ichiga yozmang.
- OpenClaw `approval`/`pause` rejimini yoqing (`.env.example` ga qaraganda).
- Barcha bajarilgan amallar `logs/` ga yoziladi.

## 🔧 Texnik tafsilotlar

| Komponent | Provider / Esktra |
|---|---|
| **LLM (Miya)** | Kimi 2.6 via Azure (`kimi-azure`) |
| **TTS (Og'iz)** | Azure Speech (custom skill) — `uz-UZ-SardorNeural` |
| **STT (Quloq)** | Azure Speech (custom skill) — `uz-UZ` locale |
| **Desktop** | macOS Peekaboo bridge / AppleScript |
| **Til** | 100% o'zbek (lotin) — `IDENTITY.md` orqali qattiq qoida |

## ❗ Eslatmalar

- Agar `openclaw config validate` xatolik bersa — `openclaw doctor --fix` bilan tuzatishingiz mumkin.
- Voice wake word uchun OpenClaw desktop ilovasidagi sozlamalardan foydalaning.
- Desktop nazorati faqat macOS'da ishlaydi — OpenClaw.app o'rnatilgan bo'lishi kerak.

## 📜 Litsenziya

Shaxsiy foydalanish uchun. Maxfiy kalitlarni hech kim bilan ulashmang!
