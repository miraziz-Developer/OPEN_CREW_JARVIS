# screen-vision

Foydalanuvchi ekranini haqiqiy ko'radi — Azure OpenAI'ning vision-qo'llab-quvvatlaydigan `gpt-4.1` deployment'i orqali skrinshotni tahlil qiladi. Kimi-K2.6 (asosiy suhbat modeli) rasmni tushunmaydi — shuning uchun ekran haqida savol berilganda ALBATTA shu skill ishlatilishi kerak, taxmin qilib javob berish taqiqlanadi.

## Qachon ishlatish

Foydalanuvchi ekrandagi narsa haqida so'raganda: "ekranda nima bor", "bu nima ekan", "shu xatoni ko'rib chiq", "skrinshot ol va tushuntir" va shunga o'xshash so'rovlarda.

## Ishlatish

`exec` tool orqali chaqiring:

```bash
echo '{}' | node skills/screen-vision/index.js
```

Ixtiyoriy maydonlar (stdin JSON):
- `imagePath` (string): mavjud skrinshot fayli yo'li. Berilmasa — o'zi yangi skrinshot oladi.
- `prompt` (string): nimaga e'tibor berish kerakligini aniqlashtiruvchi qo'shimcha ko'rsatma.

**Chiqish:** `{ "status": "ok", "description": "...", "imagePath": "..." }` yoki `{ "status": "error", "message": "..." }`

`description` maydonidagi matnni to'g'ridan-to'g'ri foydalanuvchiga o'zbek tilida moslab yetkazing.

## Setup

Kerakli muhit o'zgaruvchilari: `AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_VISION_DEPLOYMENT` (default: `gpt-4.1`)
