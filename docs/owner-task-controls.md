# Owner task controls

Set `TELEGRAM_CHAT_ID` to the owner's positive **private Telegram user ID**.
Inbound updates fail closed without it. The sender and private chat must both
match; group, channel, bot-sender, edited-message, and callback updates are not
executed. This gate runs before command, text, voice, and video dispatch.

Owner commands:

- `/tasks`: list checkpoint IDs, statuses and pending-action reasons.
- `/approve TASK_ID`: explicitly approve a paused checkpoint's specific repair.
- `/reject TASK_ID`: cancel the approval-paused task without executing the repair.
- `/inbox`: read-only shortened Gmail snippets, without marking messages read.

Repair approval is scoped to the saved step and exact validated local install
command, not to unrelated actions or future repairs. Public resume methods reject
approval-paused and terminal checkpoints. A failed repair or missing configuration
is blocked rather than endlessly asking for approval. After a crash during approval,
another approval can be required; approvals are not blanket persistent permissions.

For mail, configure `GMAIL_OWNER_RECIPIENT`, complete
`node scripts/google-oauth-setup.js`, then explicitly enable
`GMAIL_TASK_NOTIFICATIONS_ENABLED=true`. Only this configured address receives
automatic reports. The persistent runner reports approval, blocked, failed, paused,
cancelled and completed states; successful delivery markers survive restart. Progress
cadence defaults to six hours. Recovery defaults to 30 days; an existing `.env`
override still takes precedence.

Telegram and Gmail notification failures are isolated. Timeouts bound waiting, not
remote delivery: a timed-out mail request may still have sent, so exactly-once email
delivery is not guaranteed. OAuth, real mailbox delivery, microphone behavior and
running-service health require separate live validation. Restart services deliberately
after review; editing these files does not update an already-running process.