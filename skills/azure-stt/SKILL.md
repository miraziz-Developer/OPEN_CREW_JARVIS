# azure-stt

Azure Speech REST API bilan ovozni matnga aylantiradi (Speech-to-Text). Qisqa nutq (single-shot) uchun qulay.

## Tool

### `azure_stt_recognize`

Ovozli audio faylni matnga aylantiradi. Aniqlikni oshirish uchun bir nechta tilni (masalan o'zbek + ingliz) parallel tekshiradi va eng mos natijani tanlaydi — foydalanuvchi ingliz so'z aralashtirib gapirsa ham tushunadi. Tillar orasidagi confidence solishtirib bo'lmagani uchun o'zbek tiliga ustunlik beriladi (ingliz faqat sezilarli aniqroq bo'lsa tanlanadi).

**Kirish:**
- `audioFile` (string, ixtiyoriy): WAV fayl yo'li (16000 Hz, 16-bit, mono)
- `audioBase64` (string, ixtiyoriy): Base64 formatda kodlangan audio (wav)
- `locales` (string[], ixtiyoriy): Tekshiriladigan tillar ro'yxati, masalan `["uz-UZ","en-US"]` (default: shu ikkalasi)

`audioFile` yoki `audioBase64` maydonlaridan biri kerak.

**Chiqish:**
- `text` (string): Tanilgan matn
- `confidence` (number): 0 dan 1 gacha aniqlik darajasi
- `status` (string): `ok` yoki `error`

**Misol:**
```yaml
tool: azure_stt_recognize
with:
  audioFile: "/tmp/voice_message.wav"
```

## Setup

Kerakli muhit o'zgaruvchilari: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_LANGUAGE`

## Eslatmalar
- Uzun nutq uchun audioni 10-15 soniyali qismlarga bo'lib chaqiring.
- Audio format: WAV, 16 kHz, 16-bit, mono — Microsoft Speech SDK standarti.
