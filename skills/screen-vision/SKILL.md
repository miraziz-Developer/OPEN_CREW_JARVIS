# screen-vision

Foydalanuvchi ekranini haqiqiy ko'radi — Azure OpenAI'ning vision-qo'llab-quvvatlaydigan `gpt-4.1` deployment'i orqali skrinshotni tahlil qiladi. Primary agent modelining vision imkoniyatidan qat'i nazar, ekran haqida savol berilganda ground-truth screenshot va macOS konteksti uchun ALBATTA shu skill ishlatilishi kerak; taxmin qilib javob berish taqiqlanadi.

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
- `action: "locate_elements"`, `query` — Accessibility’da topilmagan elementlarni vision fallback bilan lokalizatsiya qiladi.

Oddiy chiqish: `{ "status": "ok", "description": "...", "imagePath": "..." }`.

Structured chiqish: `{ "status":"ok", "description":"...", "elements":[{"name":"Save","role":"button","confidence":0.96,"bounds":{"x":10,"y":20,"width":80,"height":30},"center":{"x":50,"y":35}}] }`. Koordinatalar screenshotning xom piksel tizimida; `desktop-control.click_at` Retina scale’ni o‘zi moslaydi. Confidence past yoki bir nechta teng moslik bo‘lsa bosmang — UI’ni qayta kuzating yoki query’ni aniqlashtiring.

`description` maydonini foydalanuvchiga English tilida yetkazing. Faqat foydalanuvchi aniq tarjima yoki boshqa nomlangan tilda javob so‘rasa, tavsifni o‘sha tilga tarjima qiling; aks holda tilni avtomatik almashtirmang.

## Setup

Kerakli muhit o'zgaruvchilari: `AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_VISION_DEPLOYMENT` (default: `gpt-4.1`)
