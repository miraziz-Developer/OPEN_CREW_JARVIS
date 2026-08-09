#!/bin/bash
# Mikrofon testi - 5 soniya ovoz yozib, playback qiladi
set -e

echo "🎤 Mikrofon testi: 5 soniya ovoz yozilmoqda..."
echo "   GAPMANG! (5 soniya ichida)"

# MacBook Air Microphone (index 0) dan yozish
ffmpeg -y -f avfoundation -i ":0" -t 5 -acodec pcm_s16le -ar 16000 -ac 1 /tmp/jarvis_mic_test.wav 2>/dev/null

if [ ! -f /tmp/jarvis_mic_test.wav ]; then
  echo "❌ Fayl yozilmadi — mikrofon ishlamayapti"
  exit 1
fi

SIZE=$(stat -f%z /tmp/jarvis_mic_test.wav)
echo "📦 Fayl hajmi: ${SIZE} byte"

if [ "$SIZE" -lt 50000 ]; then
  echo "⚠️ Fayl juda kichik — mikrofon ovoz olmayapti (Input Volume past?)"
  echo "   System Settings → Sound → Input → Input Volume ni ko'paytiring"
else
  echo "✅ Ovoz olindi! Endi tinglaymiz..."
  afplay /tmp/jarvis_mic_test.wav
  echo "✅ Agar ovoz eshitilsa — mikrofon ishlayapti!"
fi

echo ""
echo "💡 Eslatma: Mac mikrofon faqat TASHQI ovozlarni eshitadi."
echo "   Kompyuter ichidagi audio (YouTube, qo'ng'iroq) eshitilmaydi."
echo "   Agar ichki audio ham kerak bo'lsa: brew install blackhole-2ch"
