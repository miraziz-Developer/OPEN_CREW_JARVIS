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