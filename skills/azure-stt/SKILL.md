# azure-stt

Azure Speech REST API bilan ovozni matnga aylantiradi (Speech-to-Text). Qisqa nutq (single-shot) uchun qulay.

## Tool

### `azure_stt_recognize`

Ovozli audio faylni o'zbek tilida (uz-UZ) matnga aylantiradi.

**Kirish:**
- `audioFile` (string, ixtiyoriy): WAV fayl yo'li (16000 Hz, 16-bit, mono)
- `audioBase64` (string, ixtiyoriy): Base64 formatda kodlangan audio (wav)

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

Kerakli muhit o'zgaruvchilari: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_STT_LOCALE`

## Eslatmalar
- Uzun nutq uchun audioni 10-15 soniyali qismlarga bo'lib chaqiring.
- Audio format: WAV, 16 kHz, 16-bit, mono — Microsoft Speech SDK standarti.
