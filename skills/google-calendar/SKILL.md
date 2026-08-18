# google-calendar

Google Calendar bilan ishlash: kelayotgan tadbirlarni ko'rish, yangi tadbir/eslatma yaratish.

## Oldindan shart

Foydalanuvchi bir marta `node scripts/google-oauth-setup.js` orqali ulangan bo'lishi kerak (brauzerda o'zi ruxsat beradi). Ulanmagan bo'lsa har ikkala funksiya ham aniq xato qaytaradi.

## Ishlatish

```bash
echo '{"action":"list_events","days":7}' | node skills/google-calendar/index.js
echo '{"action":"create_event","title":"Uchrashuv","start":"2026-08-15T10:00:00","end":"2026-08-15T10:30:00","description":"..."}' | node skills/google-calendar/index.js
```

`start`/`end` — mahalliy vaqt zonasi (`.env`dagi `TIMEZONE`) bo'yicha ISO vaqt, masalan `"2026-08-15T10:00:00"`.

## Xavfsizlik

To'liq o'qish+yozish ruxsati (`calendar` scope) — foydalanuvchi ongli ravishda shu darajani tanlagan. Tadbir o'chirish funksiyasi hozircha yo'q (faqat yaratish/ko'rish).
