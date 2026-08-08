# azure-tts

Azure Cognitive Services Speech TTS orqali matnni o'zbek tilida (uz-UZ) ovozga aylantiradi.

## Tool

### `azure_tts_speak`

Matnni ovozli faylga aylantiradi (MP3, 24 kHz, Mono).

**Kirish:**
- `text` (string, majburiy): O'qilishi kerak bo'lgan matn
- `voice` (string, ixtiyoriy): Ovoz modeli, masalan `uz-UZ-SardorNeural` yoki `uz-UZ-MadinaNeural`. K boshqa uz-UZ ovozlari qo'llab-quvvatlanadi.

**Chiqish:**
- `audioFile` (string): Yaratilgan MP3 fayl yo'li
- `format` (string): `audio/mp3`
- `status` (string): `ok` yoki `error`

**Misol:**
```yaml
tool: azure_tts_speak
with:
  text: "Salom, Jarvis! Bugun nima rejada?"
  voice: "uz-UZ-SardorNeural"
```

## Setup

Kerakli muhit o'zgaruvchilari: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_TTS_VOICE_MALE`, `AZURE_TTS_VOICE_FEMALE`
