# Jarvis Memory

Local Obsidian-backed memory used by the voice daemon and Telegram bot.

- `writeMemory(topic, content, tags)` appends to `Jarvis/Memory/YYYY-MM-DD.md`.
- `searchMemory(query, limit)` returns matching lines grouped by date.
- `readProfile()` reads `Jarvis/Profile/User.md`.
- `profileUpdate(section, value, source)` appends a profile entry.

Set `OBSIDIAN_VAULT` to override the default `~/Documents/Obsidian Vault` location.