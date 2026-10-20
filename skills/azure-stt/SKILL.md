# azure-stt

Turns speech into text with the Azure Speech REST API (speech-to-text). Suited to short, single-shot speech.

## Tool

### `azure_stt_recognize`

Converts an audio file to text. For accuracy it checks several languages in parallel (e.g. Uzbek + English) and picks the best result, so mixed-language speech is still understood.

**Input:**
- `audioFile` (string, optional): WAV file path (16000 Hz, 16-bit, mono)
- `audioBase64` (string, ixtiyoriy): Base64 formatda kodlangan audio (wav)
- `locales` (string[], optional): languages to check, e.g. `["uz-UZ","en-US"]` (default: these two)

One of `audioFile` or `audioBase64` is required.

**Output:**
- `text` (string): Tanilgan matn
- `confidence` (number): 0 dan 1 gacha aniqlik darajasi
- `status` (string): `ok` or `error`

**Example:**
```yaml
tool: azure_stt_recognize
with:
  audioFile: "/tmp/voice_message.wav"
```

## Setup

Environment variables: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_LANGUAGE`

## Notes
- For long speech, split the audio into 10-15 second chunks.
- Audio format: WAV, 16 kHz, 16-bit, mono — Microsoft Speech SDK standarti.
