'use strict';

const https = require('https');

function telegramRequest(token, method, params = {}, options = {}) {
  const request = options.request || https.request;
  const timeoutMs = options.timeoutMs || 40000;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  const payload = body.toString();

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'api.telegram.org',
      port: 443,
      method: 'POST',
      path: '/bot' + token + '/' + method,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(payload),
        connection: 'close'
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          reject(new Error('Telegram returned invalid JSON (HTTP ' + res.statusCode + '): ' + raw.substring(0, 160)));
          return;
        }
        if (!parsed.ok) {
          const error = new Error('Telegram API ' + (parsed.error_code || res.statusCode) + ': ' + (parsed.description || 'request failed'));
          error.code = parsed.error_code || res.statusCode;
          error.retryAfter = parsed.parameters?.retry_after;
          reject(error);
          return;
        }
        resolve(parsed.result);
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('Telegram HTTPS request timed out')));
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error('Telegram HTTPS request aborted'));
      } else {
        options.signal.addEventListener('abort', () => {
          req.destroy(new Error('Telegram HTTPS request aborted'));
        }, { once: true });
      }
    }
    req.on('error', reject);
    req.end(payload);
  });
}

function createTelegramPoller(options) {
  const { token, onUpdate } = options;
  const request = options.telegramRequest || telegramRequest;
  const log = options.log || console;
  const pollTimeoutSeconds = options.pollTimeoutSeconds || 25;
  let offset = 0;
  let stopped = true;
  let failureCount = 0;
  let retryTimer = null;
  let activeController = null;

  function schedule(delayMs) {
    if (stopped) return;
    retryTimer = setTimeout(poll, delayMs);
  }

  async function poll() {
    if (stopped) return;
    try {
      activeController = new AbortController();
      const updates = await request(token, 'getUpdates', {
        offset,
        timeout: pollTimeoutSeconds,
        allowed_updates: ['message', 'edited_message']
      }, {
        timeoutMs: (pollTimeoutSeconds + 15) * 1000,
        signal: activeController.signal
      });
      if (failureCount > 0) log.log('Telegram native polling reconnected.');
      failureCount = 0;
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          onUpdate(update);
        } catch (error) {
          log.error('Telegram update processing failed:', error.message || error);
        }
      }
      schedule(0);
    } catch (error) {
      failureCount++;
      const retryAfterMs = Number(error.retryAfter) > 0 ? Number(error.retryAfter) * 1000 : 0;
      const delayMs = retryAfterMs || Math.min(30000, 1000 * (2 ** Math.min(failureCount - 1, 5)));
      if (failureCount === 1 || failureCount % 5 === 0) {
        log.error('Telegram native polling failed (attempt ' + failureCount + ', retry in ' + Math.round(delayMs / 1000) + 's): ' + (error.message || error));
      }
      schedule(delayMs);
    } finally {
      activeController = null;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      log.log('Telegram native HTTPS polling started.');
      poll();
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (activeController) activeController.abort();
    }
  };
}

module.exports = { telegramRequest, createTelegramPoller };