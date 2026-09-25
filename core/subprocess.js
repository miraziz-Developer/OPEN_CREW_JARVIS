'use strict';

const { spawn } = require('child_process');

function runProcess(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 60000;
  const maxOutputBytes = Number(options.maxOutputBytes) || 1024 * 1024;
  const spawnProcess = options.spawn || spawn;

  return new Promise((resolve, reject) => {
    const proc = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error(command + ' timed out after ' + timeoutMs + 'ms');
      error.code = 'ETIMEDOUT';
      finish(error);
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    timer.unref?.();

    function append(current, chunk) {
      const next = current + chunk.toString();
      return Buffer.byteLength(next) > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
    }
    function finish(error, code = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0) reject(new Error(command + ' failed (exit ' + code + '): ' + stderr.slice(-500)));
      else resolve({ stdout, stderr });
    }

    proc.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    proc.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    proc.once('error', finish);
    proc.once('close', code => finish(null, code));
  });
}

module.exports = { runProcess };