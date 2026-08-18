# tasks

Foydalanuvchi tanlagan **kunlik takrorlanuvchi vazifalar** ro'yxatini boshqaradi (Obsidian: `Jarvis/Tasks/DailyTasks.md`). Bu ro'yxat — daemon har kuni ruxsat so'rab, keyin avtomatik bajaradigan vazifalar shabloni.

## Ishlatish

`exec` tool orqali chaqiring:

```bash
echo '{"action":"add","text":"Emaillarni tekshirish"}' | node skills/tasks/index.js
echo '{"action":"list"}' | node skills/tasks/index.js
echo '{"action":"remove","text":"Emaillarni"}' | node skills/tasks/index.js
```

Foydalanuvchi "har kuni X qilib qo'y" yoki "vazifalar ro'yxatiga X qo'sh" desa — `add` bilan qo'shing. "O'chir"/"kerak emas" desa — `remove`.

**Chiqish:** `{ "status": "ok", ... }` yoki `{ "status": "error", "message": "..." }`

## Qanday ishlaydi (avtomatik qism)

- Daemon har kuni bir marta shu ro'yxatni Telegram orqali ko'rsatib, "bugun bajarishga ruxsat berasizmi?" deb so'raydi.
- Foydalanuvchi tasdiqlasa, daemon kun davomida har bir vazifani navbat bilan agentga topshiradi va natijani xabar qiladi.
- Ro'yxatdagi vazifalar **doimiy shablon** — har kuni qayta so'raladi, checklist holati kunlik emas.
