# claude-code

Hands complex tasks (video editing with ffmpeg, large code jobs) to **Claude Code**, which has real file and terminal access and does the actual work (e.g. cutting video with ffmpeg, adding text or subtitles, changing formats).

## When to use

- Video editing (cutting, joining, subtitles, format conversion with ffmpeg)
- A code task too large or multi-step for you (the main agent) to do yourself

Do NOT use this for ordinary questions, small file edits or browser/desktop actions; do those yourself (`exec`, `browser`, `desktop-control`). Use `claude-code` only as a last resort for genuinely deep work: it is slow and expensive.

## Usage

```bash
echo '{"task":"Join clip1.mp4 and clip2.mp4 in the work folder into output.mp4"}' | node skills/claude-code/index.js
```

Optional: `workDir`, default `~/Desktop/Jarvis-Video-Projects`. The files (video, scripts, etc.) must be in that folder.

**Output:** `{ "status": "ok", "result": "...", "workDir": "..." }` or `{ "status": "error", "message": "..." }`

## Safety

- Claude Code runs with access only to files inside `workDir` and a limited tool set (Bash/Read/Write/Edit); `--dangerously-skip-permissions` is NOT used, so it cannot reach anything else.
- It can take up to 10 minutes (video processing is slow).
- This is a real Claude Code call that uses the user's Claude subscription/quota, so use it only when truly needed.
