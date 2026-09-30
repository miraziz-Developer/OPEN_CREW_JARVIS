# Home Assistant

Use this skill for Home Assistant entities, rooms, lights, switches, fans, climate, media players, scenes, scripts, and automations.

## Commands

Run from the JARVIS workspace and pass JSON on stdin:

```bash
echo '{"action":"status"}' | node skills/home-assistant/index.js
echo '{"action":"list_entities","domain":"light"}' | node skills/home-assistant/index.js
echo '{"action":"get_entity","entityId":"light.office"}' | node skills/home-assistant/index.js
echo '{"action":"call_service","domain":"light","service":"turn_on","entityId":"light.office","data":{"brightness_pct":40}}' | node skills/home-assistant/index.js
```

## Safety and verification

- Never invent an entity ID. Discover it with `list_entities` or use an exact ID supplied by the owner.
- Only configured domain and entity allowlists are accessible.
- Lock, alarm, and cover operations are disabled by default. They require explicit configuration **and** an explicit confirmation on the exact operation.
- Never put access tokens in command input, output, logs, or conversation text.
- A service call reads state before and after the API write. Report an action as completed only when `verified` is true. Otherwise report the observed final state without claiming the requested physical effect occurred.
- Home Assistant state proves what Home Assistant observed; it cannot prove an uninstrumented physical outcome.