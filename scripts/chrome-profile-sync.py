#!/usr/bin/env python3
"""JARVIS Chrome profili: hozirgi Chrome akkauntingiz (Default) sessiyasini alohida papkaga ko'chiradi.

Nega alohida papka: ochiq Chrome o'z profilini qulflaydi, ikkinchi jarayon uni ocholmaydi. Faqat sessiya uchun zarur
fayllar (cookie, local storage, sozlamalar) ko'chiriladi; saqlangan parollar ("Login Data") va kesh ko'chirilmaydi.
Foydalanish: python3 scripts/chrome-profile-sync.py [Profile nomi, standart: Default]
"""
import os
import shutil
import sys

SRC_ROOT = os.path.expanduser("~/Library/Application Support/Google/Chrome")
DEST_ROOT = os.path.expanduser(os.environ.get("JARVIS_CHROME_DIR", "~/Library/Application Support/JarvisChrome"))
profile = sys.argv[1] if len(sys.argv) > 1 else "Default"
src = os.path.join(SRC_ROOT, profile)
dest = os.path.join(DEST_ROOT, "Default")
if not os.path.isdir(src):
    sys.exit(f"Profil topilmadi: {src}")

os.makedirs(dest, mode=0o700, exist_ok=True)
os.chmod(DEST_ROOT, 0o700)
FILES = ["Preferences", "Secure Preferences", "Cookies", "Cookies-journal", "Network/Cookies", "Network/Cookies-journal",
         "Network/Network Persistent State", "Network/Trust Tokens", "Web Data"]
DIRS = ["Local Storage", "Session Storage", "Sessions", "Extension State"]
copied = []
shutil.copy2(os.path.join(SRC_ROOT, "Local State"), os.path.join(DEST_ROOT, "Local State"))
for rel in FILES:
    s = os.path.join(src, rel)
    if os.path.isfile(s):
        os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
        shutil.copy2(s, os.path.join(dest, rel))
        copied.append(rel)
for rel in DIRS:
    s = os.path.join(src, rel)
    if os.path.isdir(s):
        shutil.copytree(s, os.path.join(dest, rel), dirs_exist_ok=True)
        copied.append(rel + "/")
print(f"OK: {profile} -> {DEST_ROOT}\nko'chirildi: {', '.join(copied)}")
