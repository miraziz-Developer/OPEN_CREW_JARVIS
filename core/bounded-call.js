'use strict';

// Bounds the caller's wait. The underlying operation may still finish; callers
// must not retry side effects blindly after a timeout.
async function boundedCall(work, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation timed out')), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { boundedCall };