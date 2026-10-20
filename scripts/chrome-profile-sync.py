#!/usr/bin/env python3
"""JARVIS Chrome profile: copies your current Chrome account (Default) session into a separate folder.

Why a separate folder: a running Chrome locks its profile, so a second process cannot open it. Only the files a
session needs (cookies, local storage, settings) are copied; saved passwords ("Login Data") and the cache are not.
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
    sys.exit(f"Profile not found: {src}")

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
print(f"OK: {profile} -> {DEST_ROOT}\ncopied: {', '.join(copied)}")
