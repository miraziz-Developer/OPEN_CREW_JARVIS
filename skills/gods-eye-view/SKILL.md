# gods-eye-view

God's Eye View is a localhost-only 3D globe integration.

The upstream Vite/Cesium application is isolated at:
`vendor/gods-eye-view` (loyiha ildizida).
Install or restore that local checkout with:
`scripts/install-gods-eye-view.sh`.

## Capabilities

- Opens a user-requested place in the 3D globe.
- Opens any combination of supported upstream public layers: flights, vessels,
  satellites, earthquakes, traffic, public cameras, radio, bike-share, rocket
  launches, NASA FIRMS fires, selected infrastructure, and submarine cables.
- Lets the existing screen monitor provide context for an open globe window.

## Use

```js
await skillPlatform.invoke(
  'gods-eye-view',
  'show',
  { place: 'Tashkent, Uzbekistan' },
  { permissions: ['web.open'] }
);
await skillPlatform.invoke('gods-eye-view', 'status');
```

For the OpenClaw agent (from its workspace), use the CLI:

```bash
echo '{"action":"show","place":"Tashkent, Uzbekistan"}' | node skills/gods-eye-view/index.js
echo '{"action":"show","place":"Tashkent, Uzbekistan","layers":["flights","traffic","earthquakes"]}' | node skills/gods-eye-view/index.js
echo '{"action":"available-layers"}' | node skills/gods-eye-view/index.js
```

`show` starts the service on `127.0.0.1` and opens the location share link.
It deliberately starts in Jarvis's keyless mode: no OpenAI key is needed and
the upstream **POWER UP** key dialog is hidden. Provider keys are only optional
enhancements and belong in the vendor app `.env`, never in Jarvis `.env`.

## Layer commands

Use the exact layer ID returned by `available-layers`, or these aliases:

- `cameras` → `cctv`; `vessels` or `ais` → `ais-live-vessels`
- `fires` → `local-firms`; `launches` → `rocket-launches`
- `cables` → `telegeography-submarine-cables`

Example Uzbek requests Jarvis can route directly: “Toshkentni reyslar va
tirbandlik bilan ko‘rsat”, “zilzilalar qatlamini och”, or “kemalarni ko‘rsat”.
Provider coverage is regional: requesting `cameras` or `traffic` for Tashkent
can open the valid layer but may contain no local feed if its public upstream
provider does not cover that area.

## Safety and licensing

- The service binds only to `127.0.0.1`.
- Nominatim receives only the place explicitly requested by the user.
- No hidden person surveillance, named-person search, face recognition, or
  individual tracking is supported.
- `alpr-cameras` and private/credential-gated camera sources are explicitly
  blocked. Public CCTV means a lawful public provider feed only.
- Public-data layers may be delayed, incomplete, inferred, or wrong. They are
  not for navigation, emergencies, or other safety-critical decisions.
- Source code is MIT. Data layers retain their own terms. The bundled
  TeleGeography submarine-cables layer is non-commercial; remove or license it
  before commercial use.