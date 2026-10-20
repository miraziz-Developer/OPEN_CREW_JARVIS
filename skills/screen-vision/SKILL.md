# screen-vision

Actually sees the user's screen: analyses a screenshot through the vision-capable Azure OpenAI `gpt-4.1` deployment. Whatever the primary agent model's vision abilities, questions about the screen MUST use this skill for a ground-truth screenshot and macOS context; answering by guessing is forbidden.

## When to use

When the user asks about something on screen: "what's on the screen", "what is this", "look at this error", "take a screenshot and explain", and similar requests.

## Usage

Call it through the `exec` tool:

```bash
echo '{}' | node skills/screen-vision/index.js
```

Ixtiyoriy maydonlar (stdin JSON):
- `imagePath` (string): path to an existing screenshot. If omitted, a new screenshot is taken.
- `prompt` (string): extra instruction about what to focus on.
- `action: "locate_elements"`, `query`: locates elements that Accessibility cannot find, as a vision fallback.

Oddiy chiqish: `{ "status": "ok", "description": "...", "imagePath": "..." }`.

Structured output: `{ "status":"ok", "description":"...", "elements":[{"name":"Save","role":"button","confidence":0.96,"bounds":{"x":10,"y":20,"width":80,"height":30},"center":{"x":50,"y":35}}] }`. Coordinates are in the screenshot's raw pixel space; `desktop-control.click_at` adjusts for Retina scaling itself. With low confidence or several equal matches, do not click: observe the UI again or refine the query.

Give the user the `description` in English. Translate it only when the user explicitly asks for a translation or a named language; never switch language automatically.

## Setup

Environment variables: `AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_VISION_DEPLOYMENT` (default `gpt-4.1`)
