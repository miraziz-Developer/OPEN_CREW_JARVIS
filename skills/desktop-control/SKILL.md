# desktop-control

macOS ilovalarini Accessibility daraxti orqali semantik boshqaradi. Elementlar ekran koordinatasiga emas, nomi/roli/identifier/value holatiga ko‘ra topiladi. Koordinata va klaviatura actionlari faqat fallback sifatida saqlangan.

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
- `inspect_ui` — `{ app?, query?, limit?, maxDepth?, maxElements? }` — Accessibility daraxtini xavfsiz JSON sifatida qaytaradi; secure text qiymatlari yashiriladi
- `find_element` — `{ app?, query: { name?, role?, identifier?, value?, enabled? }, index? }` — elementni deterministic score bilan topadi; noaniq teng moslikda bosmaydi
- `click_element` — `{ app?, query, expect?, timeoutMs?, maxAttempts? }` — semantic elementni bosadi va qayta kuzatadi
- `focus_element` — `{ app?, query }` — element fokusini Accessibility orqali o‘rnatib tasdiqlaydi
- `set_text` — `{ app?, query, value }` — maydonni fokuslab AXValue orqali matn o‘rnatadi va qiymatni qayta tekshiradi
- `toggle_element` — `{ app?, query, expect? }` — checkbox/switchni bosadi
- `select_menu` — `{ app?, menu, item, expect? }` — menu bar item va menu itemni nomi bilan tanlaydi
- `scroll` — `{ direction:"up"|"down", query? }` — elementning AXScroll actioni yoki PageUp/PageDown fallback
- `wait_for_element` — `{ app?, query, absent?, timeoutMs?, intervalMs? }` — element paydo/yo‘q bo‘lishini bounded polling bilan kutadi
- `observe_context` — oldingi ilova, haqiqiy focused oyna, bounds, browser URL/title va Accessibility fokus elementini world modelga yozib qaytaradi
- `verified_action` — amalni bajarib, keyingi semantik holatni kutadi va observable dalil bilan tasdiqlaydi:
  `{ "action":"verified_action", "command": { "action":"open_url", "url":"https://github.com", "expect": { "app":"Chrome", "url":"github.com" }, "timeoutMs":5000 } }`

`expect` maydonlari: `app`, `windowTitle`, `url`, `focusRole`, `focusValue`, `changed`. Kamida bitta konkret expectation berish afzal. `verified_action` muvaffaqiyatni command exit-code bilan emas, amaldan **oldingi va keyingi world-state** farqi bilan isbotlaydi.

**Chiqish:** `{ "status": "ok", ... }` yoki `{ "status": "error", "message": "..." }`

## Ishlash tartibi

1. `inspect_ui` yoki `find_element` bilan joriy UI holatini o‘qing.
2. Semantik actionni konkret `query` va imkon qadar `expect` bilan bajaring.
3. Action qaytargan Accessibility verification dalilini tekshiring.
4. Element Accessibility’da yo‘q bo‘lsagina `screen-vision` → `locate_elements` ishlating.
5. Vision confidence past/noaniq bo‘lsa bosmang. Yetarli bo‘lsa center koordinatani `click_at`ga bering va natijani qayta kuzating.

Misollar:

```bash
echo '{"action":"find_element","app":"TextEdit","query":{"role":"AXTextArea"}}' | node skills/desktop-control/index.js
echo '{"action":"set_text","app":"TextEdit","query":{"role":"AXTextArea"},"value":"Salom","expect":{"role":"AXTextArea","value":"Salom"}}' | node skills/desktop-control/index.js
echo '{"action":"select_menu","app":"TextEdit","menu":"File","item":"Save"}' | node skills/desktop-control/index.js
```

## Koordinata fallback

`click_at` koordinata talab qiladi. Buni topish uchun:

1. `screen-vision`ni structured action bilan chaqiring: `{"action":"locate_elements","query":"X elementi"}`.
2. Qaytgan **xom piksel qiymatlarini** to'g'ridan-to'g'ri `click_at`ga bering — masshtab (Retina 2x va h.k.) `desktop-control` ichida avtomatik hisobga olinadi, o'zingiz bo'lish/ko'paytirish shart emas.
3. Bosish/ochildirish/yozishni imkon qadar `verified_action` orqali bajaring. Accessibility yoki URL/title bilan tekshirib bo'lmaydigan vizual natijada **yana bir marta `screen-vision` bilan tekshiring** — keyingi qadamga faqat shundan keyin o'ting. Hech qachon ko'rmasdan yoki tekshirmasdan bosmang/"bajardim" demang.
4. **Noto'g'ri joyga tekkan bo'lsa — avtomatik qayta urining.** Vision-koordinata ba'zan bir necha piksel adashishi mumkin, bu normal. Muvaffaqiyatsizlikni ko'rsangiz: agar noto'g'ri maydonga matn ketgan bo'lsa avval uni tozalang (Cmd+A, Delete), so'ng yangi skrinshotdan koordinatani QAYTA hisoblab (avvalgi qiymatni takrorlamang — bir oz to'g'rilab), qayta bosing va qayta tekshiring. Buni **ketma-ket 3 martagacha** avtomatik qiling — foydalanuvchidan so'ramasdan. Faqat 3 urinishdan keyin ham ishlamasa — nima muvaffaqiyatsiz bo'lganini aniq tushuntirib, foydalanuvchidan yordam so'rang.

## Setup

- Kerakli muhit o'zgaruvchisi: `DESKTOP_CONTROL_ENABLED` (default: `true`, `false` qilib o'chirish mumkin)
- `click_at`/`type_text`/`key_press` uchun macOS **Accessibility** ruxsati kerak: Tizim sozlamalari → Maxfiylik va xavfsizlik → Accessibility → shu jarayonni (Terminal/node) yoqing. Ruxsat bo'lmasa aniq xato qaytaradi.
- `open_app`/`open_url` uchun maxsus ruxsat kerak emas.

## Xavfsizlik

Har doim nima qilayotganingizni foydalanuvchiga tushuntirib bering — sirli, tushuntirmasdan harakat qilmang.

**`type_text` yuborishdan oldin fokusni tekshiring.** Agar matn kiritish maydoni (input) aniq fokusda emasligi mumkin bo'lsa, harflar ilovaning klaviatura qisqa yo'llari sifatida talqin qilinib, kutilmagan joyga (masalan sozlamalarga) olib borib qo'yishi mumkin — buni real holatda ko'rdik. Shuning uchun: `click_at` bilan aniq matn maydoniga bosgandan keyin, `screen-vision` bilan kursor/fokus o'sha maydonda ekanini tasdiqlang, faqat shundan keyin `type_text` chaqiring. Agar ilovada tanish klaviatura qisqa yo'li bo'lsa (masalan qidiruv uchun Cmd+K) — koordinata taxmin qilishdan ko'ra shuni ishlatgan afzal, lekin baribir natijani skrinshot bilan tasdiqlang.
