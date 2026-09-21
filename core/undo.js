'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_BACKUP_BYTES = 1024 * 1024;

// Bitta umumiy "undo" stek: har amal o'zini qanday qaytarishini ro'yxatdan o'tkazadi.
class UndoStack {
  constructor(limit = 50) { this.limit = limit; this.items = []; }
  push(label, undo) {
    this.items.push({ label, undo, at: Date.now() });
    if (this.items.length > this.limit) this.items.shift();
  }
  peek() { return this.items[this.items.length - 1] || null; }
  async undoLast() {
    const item = this.items.pop();
    if (!item) return { ok: false, message: 'Nothing to undo.' };
    try { await item.undo(); return { ok: true, message: `Undid: ${item.label}` }; }
    catch (e) { return { ok: false, message: `Could not undo "${item.label}": ${e.message}` }; }
  }
}
const shared = new UndoStack();

function safePath(p, home = os.homedir()) {
  const abs = path.resolve(String(p || '').replace(/^~(?=$|\/)/, home));
  const inHome = abs === home || abs.startsWith(home + path.sep);
  const protectedTop = ['Library', '.ssh', '.gnupg', '.Trash', '.claude'].some(d => abs === path.join(home, d) || abs.startsWith(path.join(home, d) + path.sep));
  if (!inHome || abs === home || protectedTop) throw new Error('Path not allowed: ' + abs);
  return abs;
}

function uniqueTrashPath(name, home) {
  const dir = path.join(home, '.Trash');
  let target = path.join(dir, name), i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${path.parse(name).name} ${i++}${path.extname(name)}`);
  return target;
}

// Fayl amallari — hammasi qaytariladigan. O'chirish = Trash'ga ko'chirish.
function fileOps({ stack = shared, home = os.homedir() } = {}) {
  const P = p => safePath(p, home);
  return {
    mkdir(dir) {
      const abs = P(dir);
      const created = [];
      for (let cur = abs; !fs.existsSync(cur); cur = path.dirname(cur)) created.push(cur);
      fs.mkdirSync(abs, { recursive: true });
      stack.push(`create folder ${abs}`, () => { for (const d of created) { try { fs.rmdirSync(d); } catch (_) {} } });
      return `Created ${abs}`;
    },
    move(from, to) {
      const src = P(from); let dst = P(to);
      if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) dst = path.join(dst, path.basename(src));
      if (fs.existsSync(dst)) throw new Error('Destination exists: ' + dst);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      stack.push(`move ${path.basename(src)}`, () => { if (fs.existsSync(src)) throw new Error('original spot is occupied'); fs.renameSync(dst, src); });
      return `Moved to ${dst}`;
    },
    copy(from, to) {
      const src = P(from); let dst = P(to);
      if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) dst = path.join(dst, path.basename(src));
      if (fs.existsSync(dst)) throw new Error('Destination exists: ' + dst);
      fs.cpSync(src, dst, { recursive: true, errorOnExist: true });
      // Nusxani o'chirish faqat u o'zgarmagan/bo'sh emas holda ham Trash orqali — hech qachon buzuvchi emas.
      stack.push(`copy ${path.basename(src)}`, () => { fs.renameSync(dst, uniqueTrashPath(path.basename(dst), home)); });
      return `Copied to ${dst}`;
    },
    write(file, content) {
      const abs = P(file);
      const existed = fs.existsSync(abs);
      let old = null;
      if (existed) {
        if (fs.statSync(abs).size > MAX_BACKUP_BYTES) throw new Error('File over 1 MB — refusing an un-undoable overwrite');
        old = fs.readFileSync(abs);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ''));
      stack.push(`write ${path.basename(abs)}`, () => { if (existed) fs.writeFileSync(abs, old); else fs.renameSync(abs, uniqueTrashPath(path.basename(abs), home)); });
      return `Wrote ${abs}`;
    },
    trash(target) {
      const src = P(target);
      const dst = uniqueTrashPath(path.basename(src), home);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      stack.push(`trash ${path.basename(src)}`, () => { if (fs.existsSync(src)) throw new Error('original spot is occupied'); fs.renameSync(dst, src); });
      return `Moved ${path.basename(src)} to Trash (undoable)`;
    }
  };
}

const osa = script => new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', script], { timeout: 4000, encoding: 'utf8' }, (e, out) => e ? reject(e) : resolve(String(out).trim())));

// Sozlamalar: joriy qiymat AVVAL o'qiladi (taxmin emas); o'qib bo'lmasa — undo ro'yxatga olinmaydi.
async function captureSetting(actionId, { stack = shared, run = osa } = {}) {
  if (/^volume:/.test(actionId)) {
    try {
      const before = parseInt(await run('output volume of (get volume settings)'), 10);
      if (Number.isFinite(before)) stack.push(`volume (was ${before})`, () => run(`set volume output volume ${before}`));
    } catch (_) {}
  }
}

module.exports = { UndoStack, sharedUndo: shared, fileOps, safePath, captureSetting };
