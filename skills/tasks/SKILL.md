# tasks

Manages the user's chosen list of **recurring daily tasks** (Obsidian: `Jarvis/Tasks/DailyTasks.md`). The daemon works through this list automatically every day.

## Usage

Call it through the `exec` tool:

```bash
echo '{"action":"add","text":"Check email"}' | node skills/tasks/index.js
echo '{"action":"list"}' | node skills/tasks/index.js
echo '{"action":"remove","text":"Emaillarni"}' | node skills/tasks/index.js
```

When the user says "do X every day" or "add X to the task list", use `add`. When they say "remove it" or "not needed", use `remove`.

**Output:** `{ "status": "ok", ... }` or `{ "status": "error", "message": "..." }`

## How it works (automatic part)

- Listed tasks need no separate permission: during the day the daemon hands each task to the agent in turn (timed tasks run at their time).
- Each result is reported on Telegram, and done tasks are tracked per day.
- The list is a **standing template**: it repeats every day; the done state is per day.
