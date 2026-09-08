'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Bu ovoz ijro etilayotgan vaqtda mikrofon jonli sessiyaga UMUMAN
// yuborilmaydi (Jarvis o'z ovozini "foydalanuvchi gapirdi" deb qabul
// qilmasligi uchun) — ya'ni bu butunlay O'LIK vaqt: foydalanuvchi
// gapirsa ham eshitilmaydi. Shuning uchun ovoz imkon qadar QISQA
// bo'lishi kerak. Davomiylik fayldan O'QIB olinadi — fayl almashtirilsa,
// qo'lda raqam yangilash esdan chiqib, mos kelmay qolmasin.
function detectWakeSoundMs(wakeSoundPath) {
  try {
    const out = execSync('afinfo "' + wakeSoundPath + '" 2>/dev/null | grep -i "estimated duration"', { encoding: 'utf8' });
    const m = out.match(/([\d.]+)\s*sec/);
    // `afplay` qaytishidan oldingi karnay/driver dumini yopish uchun bitta
    // kichik zaxira yetadi. Daemon bu qiymat ustiga yana guard qo'shmaydi:
    // aks holda 0.84s "Labbay, boss" amalda 1.12s mikrofon dead-time bergan.
    if (m) return Math.round(parseFloat(m[1]) * 1000) + 100;
  } catch (e) {}
  return 1000; // afinfo ishlamasa — ehtiyotkor, lekin eski 2400dan ancha kichik qiymat
}

function playWakeSound(wakeSoundPath) {
  if (!fs.existsSync(wakeSoundPath)) return;
  try {
    const p = spawn('afplay', [wakeSoundPath], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {}
}

// ── QOSHIMCHA TOVUSH BELGILARI ── tizimning tayyor (macOS) tovushlaridan
// foydalaniladi — sifatli, yangi audio generatsiya qilish shart emas.
// Sosumi = klassik "diqqat" ogohlantirish tovushi (shoshilinch signal
// oldidan); Glass = yengil, ijobiy "tugadi" tovushi (uzoqroq run_task
// vazifasi tugaganda — HUD-dek "bajarildi" hissi beradi). fast_action
// uchun ATAYIN ishlatilmaydi — u allaqachon deyarli oniy, qo'shimcha
// tovush faqat ortiqcha shovqin bo'lardi.
function playSystemSound(name) {
  const p_ = path.join('/System/Library/Sounds', name + '.aiff');
  if (!fs.existsSync(p_)) return;
  try {
    const p = spawn('afplay', [p_], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {}
}
function playUrgentSound() { playSystemSound('Sosumi'); }
function playTaskDoneSound() { playSystemSound('Glass'); }

module.exports = { detectWakeSoundMs, playWakeSound, playSystemSound, playUrgentSound, playTaskDoneSound };
