# gmail

Works with Gmail: view unread/important mail, mark it as read, send new mail.

## Oldindan shart

The user must have connected once with `node scripts/google-oauth-setup.js`.

## Usage

```bash
echo '{"action":"list_messages","query":"is:unread","maxResults":10}' | node skills/gmail/index.js
echo '{"action":"mark_read","id":"<xat id>"}' | node skills/gmail/index.js
echo '{"action":"send_message","to":"someone@example.com","subject":"...","body":"..."}' | node skills/gmail/index.js
```

`query` — Gmail qidiruv sintaksisi (masalan `is:unread is:important`, `from:someone@example.com`).

## Safety — IMPORTANT

Sending mail is **irreversible**: it can reach the wrong person or carry the wrong text. Even though the user deliberately granted full (read+write+send) access, when sending is YOUR OWN initiative (not requested), show who it goes to and what it says and get confirmation first (the same as the general messaging rule in SOUL.md). If the user directly says "write Y to X", no extra confirmation is needed.
