# claude-code

Murakkab vazifalarni (video montaj/ffmpeg, ancha katta kod ishlari) **Claude Code**'ga topshiradi — u haqiqiy fayl/terminal huquqiga ega, real ishni bajaradi (masalan ffmpeg orqali videoni kesish, matn/subtitr qo'shish, formatni o'zgartirish).

## Qachon ishlatish

- Video montaj/tahrirlash kerak bo'lganda (kesish, birlashtirish, subtitr, format o'zgartirish — ffmpeg orqali)
- O'zingiz (asosiy agent) bajara olmaydigan darajada katta/ko'p bosqichli kod vazifasi bo'lsa

Oddiy savol-javob, kichik fayl tahriri, brauzer/desktop harakatlari uchun BUNI ishlatmang — buning o'rniga to'g'ridan-to'g'ri o'zingiz (`exec`, `browser`, `desktop-control`) bajaring. `claude-code` faqat haqiqatan chuqur ishlash kerak bo'lganda, oxirgi chora sifatida ishlatiladi — sekin va qimmat.

## Ishlatish

```bash
echo '{"task":"Ish papkasidagi clip1.mp4 va clip2.mp4 ni birlashtirib, output.mp4 qil"}' | node skills/claude-code/index.js
```

Ixtiyoriy: `workDir` — default `~/Desktop/Jarvis-Video-Projects`. Fayllar (video, skript va h.k.) shu papkada bo'lishi kerak.

**Chiqish:** `{ "status": "ok", "result": "...", "workDir": "..." }` yoki `{ "status": "error", "message": "..." }`

## Xavfsizlik

- Claude Code faqat `workDir` ichidagi fayllarga va cheklangan tool to'plamiga (Bash/Read/Write/Edit) ruxsat bilan ishga tushadi — `--dangerously-skip-permissions` ISHLATILMAYDI, boshqa joylarga kira olmaydi.
- 10 daqiqagacha davom etishi mumkin (video ishlov berish sekin).
- Bu haqiqiy Claude Code chaqiruvi — foydalanuvchining Claude obunasi/kvotasidan foydalanadi, shuning uchun faqat chindan kerak bo'lganda ishlating.
