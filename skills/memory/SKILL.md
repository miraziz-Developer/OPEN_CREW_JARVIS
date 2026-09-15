# Memory OS

Jarvis xotirasi besh qatlamga ajratiladi: `working`, `episodic`, `semantic`,
`procedural`, `user_profile`. Eski Obsidian Markdown interfeysi backward-compatible
dual-write sifatida saqlanadi; structured store confidence, expiry, contradiction,
entity graph va secret redaction metadata bilan ishlaydi.

```bash
echo '{"action":"remember","layer":"semantic","title":"Project stack","content":"Jarvis Node.js ishlatadi","fact":{"subject":"Jarvis","predicate":"runtime","object":"Node.js"},"confidence":0.9}' | node skills/memory/index.js
echo '{"action":"retrieve","query":"Jarvis runtime","layers":["semantic"],"limit":5}' | node skills/memory/index.js
echo '{"action":"migrate_legacy"}' | node skills/memory/index.js
echo '{"action":"purge_expired"}' | node skills/memory/index.js
```

Parol, token va API key qiymatlari persistence’dan oldin avtomatik redakt qilinadi.

## Legacy Obsidian compatibility

Local Obsidian-backed memory used by the voice daemon and Telegram bot.

- `writeMemory(topic, content, tags)` appends to `Jarvis/Memory/YYYY-MM-DD.md`.
- `searchMemory(query, limit)` returns matching lines grouped by date.
- `readProfile()` reads `Jarvis/Profile/User.md`.
- `profileUpdate(section, value, source)` appends a profile entry.

Set `OBSIDIAN_VAULT` to override the default `~/Documents/Obsidian Vault` location.

## Agent memory lookup

For a user-memory question, use the memory skill's JSON interface from the project
root. It searches only the supported Markdown and structured-memory stores, so it
does not traverse browser databases or other binary files:

```bash
printf '%s\n' '{"action":"search","query":"favorite music","limit":6}' | node skills/memory/index.js
printf '%s\n' '{"action":"profile_read"}' | node skills/memory/index.js
```

- Do **not** use the generic project `search` tool to look up personal memory.
- Do **not** append unsupported filters such as `in !*.sqlite*` to a search
  request. The memory skill already excludes non-Markdown files safely.
- If semantic lookup is unavailable, run the JSON `search` command above as the
  local fallback before answering.
- A failed search command does not establish that memory is unavailable. Report
  only a confirmed result, or say that no matching memory was found after the
  supported lookup completes.