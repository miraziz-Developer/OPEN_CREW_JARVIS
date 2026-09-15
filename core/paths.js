'use strict';

const path = require('path');

// OpenClaw skilllarni private workspace nusxasidan ishga tushiradi. Runtime
// state, .env va loglar esa yagona authoritative loyiha papkasida qolishi
// kerak; daemon agent child'iga shu yo'lni beradi. Oddiy lokal chaqiruvda
// avvalgi __dirname xulqi saqlanadi.
const PROJECT_DIR = process.env.JARVIS_PROJECT_DIR
  ? path.resolve(process.env.JARVIS_PROJECT_DIR)
  : path.resolve(__dirname, '..');

module.exports = { PROJECT_DIR };