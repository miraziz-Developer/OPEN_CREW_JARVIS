# JARVIS autonomy, permissions and safety

**Levels (from safest to freest)**
1. Chat/voice questions and read-only tools: always allowed.
2. Routine local actions inside a mission (files, code, research, reports): allowed without asking (`MISSION_AUTONOMY=routine`; `strict` asks for all).
3. Outward actions (email, messages, job applications, recruiter outreach, posting): ask every time, **unless a standing permission covers it**.
4. Money, permanent deletion, passwords/keys, permission or system changes: always ask. Never covered by a standing permission.

**Standing permissions** — say e.g. "you may apply to matching jobs up to 10 a day for a week". JARVIS asks you to say *confirm*,
then stores a rule (`.run/missions/standing-approvals.json`) with scopes (`job-applications`, `recruiter-messages`, `external-messages`),
a per-day limit and an expiry. Each job application / message is its own task, so the limit counts real actions. Say
"list my standing permissions" or "revoke all standing permissions" any time.

**Things JARVIS will not do even with permission**: type passwords or 2FA codes, get around CAPTCHAs/bot checks, move money or trade,
create accounts, permanently delete data. It stops and tells you instead.

**Keeping it running for days**
- The mission runner (`com.jarvis.mission-runner`) keeps the Mac awake while missions run (`caffeinate`). Closing the lid still sleeps the Mac.
- Daily budgets: `MISSION_DAILY_TOKEN_BUDGET` pauses new mission steps when reached; `DAILY_VOICE_MINUTES_ALERT` warns about always-listening cloud audio.
- Daily backup at 03:30 (`scripts/backup.sh` → `~/.jarvis-backups/daily`, last 7 days): code bundle, `.env`, memory, missions, Obsidian `Jarvis` folder.
- Always-listening can be turned off with `JARVIS_ALWAYS_LISTEN=false`.
