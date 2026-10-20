---
name: antigravity
description: Gemini Desktop Antigravity integration — creates projects, writes code, refactors and runs programming tasks fully autonomously.
---

# Antigravity Skill

Use it when the user asks for:
- A new project (site, bot, API, mobile app, script).
- Debugging or refactoring an existing project.
- Complex coding, writing tests, git operations.

## How to call it:

```bash
# A regular programming task:
echo '{"action":"executePrompt","prompt":"React-da todo ilova yarat"}' | node skills/antigravity/index.js

# Start a new project:
echo '{"action":"createProject","name":"my-app","description":"Telegram mini app"}' | node skills/antigravity/index.js
```
