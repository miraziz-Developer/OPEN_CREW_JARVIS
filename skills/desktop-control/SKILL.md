# desktop-control

Kompyuterni to'g'ridan-to'g'ri boshqaradi — ilova ochish, URL ochish, sichqoncha bosish, klaviaturada yozish/tugma bosish. macOS'ning native `open` va AppleScript/System Events orqali, qo'shimcha o'rnatish shart emas.

Brauzer ichidagi harakatlar (sayt ochish, forma to'ldirish, sahifadagi elementga bosish) uchun buning o'rniga o'rnatilgan `browser` tool'ni ishlating — u aniqroq va xavfsizroq. `desktop-control`ni faqat brauzerdan tashqari (istalgan boshqa ilova, Finder, System Preferences va h.k.) ishlarga ishlating.

## Ishlatish

`exec` tool orqali chaqiring, masalan:

```bash
echo '{"action":"open_app","name":"Safari"}' | node skills/desktop-control/index.js
```

## Action'lar

- `open_app` — `{ name: "Safari" }` — ilovani ochadi/oldinga chiqaradi
- `open_url` — `{ url: "https://..." }` — URL'ni standart brauzerda ochadi
- `click_at` — `{ x, y, double?: true }` — ekrandagi koordinatga bosadi
- `type_text` — `{ text: "..." }` — joriy fokusdagi maydonga yozadi
- `key_press` — `{ key: "return" | "cmd+c" | "cmd+shift+4" | ... }` — tugma/kombinatsiya bosadi
- `frontmost_app` — hozir oldingi planda turgan ilova nomini qaytaradi

**Chiqish:** `{ "status": "ok", ... }` yoki `{ "status": "error", "message": "..." }`

## Muhim: koordinata kerak bo'lganda avval ko'ring

`click_at` koordinata talab qiladi. Buni topish uchun:

1. `screen-vision`ni chaqiring, `prompt` orqali aniq so'rang: *"X elementi qayerda? Markazining piksel koordinatasini {\"x\":...,\"y\":...} formatida qaytar."*
2. Qaytgan **xom piksel qiymatlarini** to'g'ridan-to'g'ri `click_at`ga bering — masshtab (Retina 2x va h.k.) `desktop-control` ichida avtomatik hisobga olinadi, o'zingiz bo'lish/ko'paytirish shart emas.
3. Bosgandan keyin **yana bir marta `screen-vision` bilan tekshiring** — to'g'ri joyga tegdimi (masalan kerakli element tanlandimi/fokusda) — keyingi qadamga faqat shundan keyin o'ting. Hech qachon ko'rmasdan yoki tekshirmasdan bosmang/"bajardim" demang.
4. **Noto'g'ri joyga tekkan bo'lsa — avtomatik qayta urining.** Vision-koordinata ba'zan bir necha piksel adashishi mumkin, bu normal. Muvaffaqiyatsizlikni ko'rsangiz: agar noto'g'ri maydonga matn ketgan bo'lsa avval uni tozalang (Cmd+A, Delete), so'ng yangi skrinshotdan koordinatani QAYTA hisoblab (avvalgi qiymatni takrorlamang — bir oz to'g'rilab), qayta bosing va qayta tekshiring. Buni **ketma-ket 3 martagacha** avtomatik qiling — foydalanuvchidan so'ramasdan. Faqat 3 urinishdan keyin ham ishlamasa — nima muvaffaqiyatsiz bo'lganini aniq tushuntirib, foydalanuvchidan yordam so'rang.

## Setup

- Kerakli muhit o'zgaruvchisi: `DESKTOP_CONTROL_ENABLED` (default: `true`, `false` qilib o'chirish mumkin)
- `click_at`/`type_text`/`key_press` uchun macOS **Accessibility** ruxsati kerak: Tizim sozlamalari → Maxfiylik va xavfsizlik → Accessibility → shu jarayonni (Terminal/node) yoqing. Ruxsat bo'lmasa aniq xato qaytaradi.
- `open_app`/`open_url` uchun maxsus ruxsat kerak emas.

## Xavfsizlik

Har doim nima qilayotganingizni foydalanuvchiga tushuntirib bering — sirli, tushuntirmasdan harakat qilmang.

**`type_text` yuborishdan oldin fokusni tekshiring.** Agar matn kiritish maydoni (input) aniq fokusda emasligi mumkin bo'lsa, harflar ilovaning klaviatura qisqa yo'llari sifatida talqin qilinib, kutilmagan joyga (masalan sozlamalarga) olib borib qo'yishi mumkin — buni real holatda ko'rdik. Shuning uchun: `click_at` bilan aniq matn maydoniga bosgandan keyin, `screen-vision` bilan kursor/fokus o'sha maydonda ekanini tasdiqlang, faqat shundan keyin `type_text` chaqiring. Agar ilovada tanish klaviatura qisqa yo'li bo'lsa (masalan qidiruv uchun Cmd+K) — koordinata taxmin qilishdan ko'ra shuni ishlatgan afzal, lekin baribir natijani skrinshot bilan tasdiqlang.
