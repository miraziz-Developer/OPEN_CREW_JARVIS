'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createCheckpointStore(projectDir) {
  const directory = path.join(projectDir, '.run', 'agent-task-checkpoints');

  function createId(request, sessionKey) {
    return crypto.createHash('sha256')
      .update(String(sessionKey || '') + '\n' + String(request || '') + '\n' + Date.now())
      .digest('hex')
      .slice(0, 16);
  }

  function save(task) {
    if (!/^[a-f0-9]{16}$/i.test(String(task?.id || ''))) throw new Error('Invalid checkpoint task ID');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    task.updatedAt = new Date().toISOString();
    const file = path.join(directory, task.id + '.json');
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(task, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    return file;
  }

  function load(id) {
    if (!/^[a-f0-9]{16}$/i.test(String(id || ''))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(directory, id + '.json'), 'utf8')); } catch (_) { return null; }
  }

  function list() {
    try {
      return fs.readdirSync(directory).filter(name => /^[a-f0-9]{16}\.json$/i.test(name))
        .map(name => { try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch (_) { return null; } })
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    } catch (_) { return []; }
  }

  return { directory, createId, save, load, list };
}

module.exports = { createCheckpointStore };