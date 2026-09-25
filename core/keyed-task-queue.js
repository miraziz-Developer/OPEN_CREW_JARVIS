'use strict';

function createKeyedTaskQueue() {
  const pending = new Map();

  function enqueue(key, task) {
    const previous = pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    pending.set(key, current);
    return current.finally(() => {
      if (pending.get(key) === current) pending.delete(key);
    });
  }

  function onIdle(key) {
    return pending.get(key) || Promise.resolve();
  }

  return { enqueue, onIdle, size: () => pending.size };
}

module.exports = { createKeyedTaskQueue };