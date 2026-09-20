'use strict';

function createOwnerUpdateHandler({ ownerId, dispatch }) {
  const owner = String(ownerId || '').trim();
  const configured = /^[1-9]\d*$/.test(owner);
  return update => {
    // Edited messages must not replay actions; only a private owner message is trusted.
    const message = update?.message;
    if (!configured || !message || message.chat?.type !== 'private' || message.from?.is_bot
      || String(message.from?.id) !== owner || String(message.chat?.id) !== owner) return false;
    dispatch(update);
    return true;
  };
}

function createOwnerTaskCommands({ bridge, notifier, send }) {
  return async message => {
    const text = String(message.text || '').trim();
    const match = text.match(/^\/(approve|reject|tasks|inbox)(?:\s+(.*))?$/i);
    if (!match) return false;
    const command = match[1].toLowerCase();
    const taskId = String(match[2] || '').trim();
    let reply;
    try {
      if (command === 'tasks') {
        reply = bridge.checkpoints.list().slice(0, 15).map(task =>
          `${task.id} — ${task.status}\n${String(task.pauseReason || task.request || '').slice(0, 120)}${task.pendingApproval?.command ? '\nRepair: ' + task.pendingApproval.command : ''}`
        ).join('\n\n') || 'No checkpointed tasks.';
      } else if (command === 'inbox') {
        const result = await notifier.summarizeInbox();
        reply = result.status === 'ok' ? result.messages.map(mail =>
          `${mail.from}: ${mail.subject}\n${mail.summary}`
        ).join('\n\n') || 'No matching messages.' : 'Inbox unavailable: configure owner Gmail reporting and Google OAuth first.';
      } else {
        if (!/^[a-f0-9]{16}$/i.test(taskId)) throw new Error(`Usage: /${command} TASK_ID (see /tasks)`);
        const result = await bridge.approvePersistentTask(taskId, { approved: command === 'approve', source: 'telegram-owner' });
        reply = String(result || 'Task updated.');
      }
    } catch (error) { reply = `Task command failed: ${error.message}`; }
    await send(message.chat.id, reply.slice(0, 4000));
    return true;
  };
}

module.exports = { createOwnerUpdateHandler, createOwnerTaskCommands };