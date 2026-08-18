# gmail

Gmail bilan ishlash: o'qilmagan/muhim xatlarni ko'rish, o'qilgan deb belgilash, yangi xat yuborish.

## Oldindan shart

Foydalanuvchi bir marta `node scripts/google-oauth-setup.js` orqali ulangan bo'lishi kerak.

## Ishlatish

```bash
echo '{"action":"list_messages","query":"is:unread","maxResults":10}' | node skills/gmail/index.js
echo '{"action":"mark_read","id":"<xat id>"}' | node skills/gmail/index.js
echo '{"action":"send_message","to":"someone@example.com","subject":"...","body":"..."}' | node skills/gmail/index.js
```

`query` — Gmail qidiruv sintaksisi (masalan `is:unread is:important`, `from:someone@example.com`).

## Xavfsizlik — MUHIM

Xat yuborish **qaytarib bo'lmaydigan** amal — noto'g'ri odamga yoki noto'g'ri matn bilan ketishi mumkin. Foydalanuvchi to'liq (o'qish+yozish+yuborish) ruxsatni ongli tanlagan bo'lsa-da: xat yuborishdan oldin, agar bu SIZNING o'z tashabbusingiz (so'ralmagan) bo'lsa — kimga va nima yozilishini avval ko'rsatib tasdiqlatib oling (SOUL.md'dagi umumiy xabar yuborish qoidasi bilan bir xil). Foydalanuvchi to'g'ridan-to'g'ri "X ga Y deb yoz" desa — qayta tasdiqlash shart emas.
