# desktop-control

Controls macOS apps semantically through the Accessibility tree. Elements are found by name, role, identifier or value, not by screen coordinates. Coordinate and keyboard actions remain only as a fallback.

For anything inside a web browser (opening sites, filling forms, clicking page elements) use the built-in `browser` tool instead; it is more precise and safer. Use `desktop-control` only for work outside the browser (any other app, Finder, System Settings, etc.).

## Usage

Call it through the `exec` tool, for example:

```bash
echo '{"action":"open_app","name":"Safari"}' | node skills/desktop-control/index.js
```

## Actions

- `open_app` — `{ name: "Safari" }` — opens the app or brings it to the front
- `open_url` — `{ url: "https://..." }` — opens a URL in the default browser
- `click_at` — `{ x, y, double?: true }` — clicks a screen coordinate
- `type_text` — `{ text: "..." }` — types into the currently focused field
- `key_press` — `{ key: "return" | "cmd+c" | "cmd+shift+4" | ... }` — presses a key or key combination
- `frontmost_app` — returns the name of the frontmost app
- `inspect_ui` — `{ app?, query?, limit?, maxDepth?, maxElements? }` — returns the Accessibility tree as safe JSON; secure text values are hidden
- `find_element` — `{ app?, query: { name?, role?, identifier?, value?, enabled? }, index? }` — finds an element with a deterministic score; never clicks on an ambiguous tie
- `click_element` — `{ app?, query, expect?, timeoutMs?, maxAttempts? }` — clicks a semantic element and observes the result
- `focus_element` — `{ app?, query }` — focuses an element through Accessibility and confirms it
- `set_text` — `{ app?, query, value }` — focuses a field, sets its text through AXValue and re-checks the value
- `toggle_element` — `{ app?, query, expect? }` — clicks a checkbox or switch
- `select_menu` — `{ app?, menu, item, expect? }` — selects a menu bar menu and item by name
- `scroll` — `{ direction:"up"|"down", query? }` — the element's AXScroll action, or a PageUp/PageDown fallback
- `wait_for_element` — `{ app?, query, absent?, timeoutMs?, intervalMs? }` — waits, with bounded polling, until an element appears or disappears
- `observe_context` — records the frontmost app, the real focused window, its bounds, the browser URL/title and the Accessibility focus in the world model, and returns them
- `verified_action` — runs an action, waits for the next semantic state and confirms it with observable evidence:
  `{ "action":"verified_action", "command": { "action":"open_url", "url":"https://github.com", "expect": { "app":"Chrome", "url":"github.com" }, "timeoutMs":5000 } }`

`expect` fields: `app`, `windowTitle`, `url`, `focusRole`, `focusValue`, `changed`. Prefer giving at least one concrete expectation. `verified_action` proves success with the difference between the world state **before and after** the action, not with a command exit code.

**Output:** `{ "status": "ok", ... }` or `{ "status": "error", "message": "..." }`

## Workflow

1. Read the current UI with `inspect_ui` or `find_element`.
2. Run the semantic action with a concrete `query` and, whenever possible, an `expect`.
3. Check the Accessibility verification evidence the action returns.
4. Use `screen-vision` → `locate_elements` only if the element is missing from Accessibility.
5. Do not click when vision confidence is low or ambiguous. When it is sufficient, pass the center coordinates to `click_at` and observe the result again. **If the click did not produce the expected result (it hit the wrong element), do not continue on a guess: re-locate with a fresh screenshot and retry at most twice.**

Examples:

```bash
echo '{"action":"find_element","app":"TextEdit","query":{"role":"AXTextArea"}}' | node skills/desktop-control/index.js
echo '{"action":"set_text","app":"TextEdit","query":{"role":"AXTextArea"},"value":"Hello","expect":{"role":"AXTextArea","value":"Hello"}}' | node skills/desktop-control/index.js
echo '{"action":"select_menu","app":"TextEdit","menu":"File","item":"Save"}' | node skills/desktop-control/index.js
```

## Coordinate fallback

`click_at` needs coordinates. To find them:

1. Call `screen-vision` with the structured action: `{"action":"locate_elements","query":"the X element"}`.
2. Pass the returned **raw pixel values** straight to `click_at`; scaling (Retina 2x, etc.) is handled inside `desktop-control`, so never divide or multiply them yourself. **Copy the `center.x`/`center.y` numbers from the JSON EXACTLY; do not estimate or round them**, since a few pixels can land on the wrong element.
3. Click, open and type through `verified_action` whenever possible. For a visual result that Accessibility or the URL/title cannot confirm, **check once more with `screen-vision`** and only then move to the next step. Never click without looking, and never say "done" without checking.
4. **If you hit the wrong spot, retry automatically.** Vision coordinates are sometimes off by a few pixels; that is normal. On a failure: if text went into the wrong field, clear it first (Cmd+A, Delete), then RE-compute the coordinates from a fresh screenshot (do not repeat the old value; adjust it), click again and check again. Do this **up to 3 times in a row** without asking the user. Only if it still fails after 3 attempts, explain exactly what failed and ask the user for help.

## Setup

- Environment variable: `DESKTOP_CONTROL_ENABLED` (default `true`; set `false` to disable)
- `click_at`/`type_text`/`key_press` need the macOS **Accessibility** permission: System Settings → Privacy & Security → Accessibility → enable this process (Terminal/node). Without it a clear error is returned.
- `open_app`/`open_url` need no special permission.

## Safety

Be transparent about what you are doing; never act in a hidden, unexplained way.

**Check the focus before `type_text`.** If a text field may not be clearly focused, the letters can be interpreted as the app's keyboard shortcuts and take you somewhere unexpected (for example into settings); this happened in real use. So after clicking a text field with `click_at`, confirm with `screen-vision` that the cursor/focus is in that field, and only then call `type_text`. If the app has a well-known shortcut (e.g. Cmd+K for search), prefer it over guessing coordinates, but still confirm the result with a screenshot.
