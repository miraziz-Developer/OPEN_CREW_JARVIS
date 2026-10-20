# google-calendar

Works with Google Calendar: view upcoming events and create new events or reminders.

## Oldindan shart

The user must have connected once with `node scripts/google-oauth-setup.js` (they grant access in the browser). Without that, both functions return a clear error.

## Usage

```bash
echo '{"action":"list_events","days":7}' | node skills/google-calendar/index.js
echo '{"action":"create_event","title":"Uchrashuv","start":"2026-08-15T10:00:00","end":"2026-08-15T10:30:00","description":"..."}' | node skills/google-calendar/index.js
```

`start`/`end` are ISO times in the local timezone (`TIMEZONE` in `.env`, or the Mac's timezone), e.g. `"2026-08-15T10:00:00"`.

## Safety

Full read+write access (`calendar` scope), chosen deliberately by the user. Deleting events is not supported yet (create and view only).
