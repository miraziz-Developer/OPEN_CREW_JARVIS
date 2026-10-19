---
name: antigravity
description: Gemini Desktop Antigravity integratsiyasi — loyihalar yaratish, kod yozish, refactoring va dasturlash vazifalarini to'liq avtonom bajarish.
---

# Antigravity Skill

Foydalanuvchi quyidagi vazifalarni so'raganda ishlatiladi:
- Yangi loyiha (sayt, bot, api, mobil ilova, skript) yaratish.
- Mavjud loyihada xatolarni tuzatish (debug), refactoring qilish.
- Murakkab kodlash, test yozish, git amallarini bajarish.

## Chaqirish usullari:

```bash
# Oddiy dasturlash vazifasi:
echo '{"action":"executePrompt","prompt":"React-da todo ilova yarat"}' | node skills/antigravity/index.js

# Yangi loyiha boshlash:
echo '{"action":"createProject","name":"my-app","description":"Telegram mini app"}' | node skills/antigravity/index.js
```
