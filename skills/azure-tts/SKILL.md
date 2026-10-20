# azure-tts

Turns text into speech with Azure Cognitive Services Speech TTS (English by default; Uzbek uz-UZ voices are supported).

## Tool

### `azure_tts_speak`

Converts text to an audio file (PCM WAV, 24 kHz, mono).

**Input:**
- `text` (string, required): the text to speak
- `voice` (string, optional): the voice, e.g. `en-US-AndrewNeural`, `uz-UZ-SardorNeural` or `uz-UZ-MadinaNeural`. Any Azure neural voice works.

**Output:**
- `audioFile` (string): path of the generated 24 kHz mono PCM WAV file
- `format` (string): `audio/wav`
- `status` (string): `ok` or `error`

**Example:**
```yaml
tool: azure_tts_speak
with:
  text: "Good evening. What's on the agenda today?"
  voice: "uz-UZ-SardorNeural"
```

## Setup

Environment variables: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_VOICE`
