'use strict';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', X = '\x1b[0m';

function ok(m)  { console.log(G + '✅ ' + m + X); }
function er(m)  { console.error(R + '❌ ' + m + X); }
function inf(m) { console.log(B + 'ℹ️  ' + m + X); }
function wrn(m) { console.log(Y + '⚠️  ' + m + X); }

module.exports = { ok, er, inf, wrn };
