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
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, task.id + '.json');
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(task, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
    return file;
  }

  return { directory, createId, save };
}

module.exports = { createCheckpointStore };