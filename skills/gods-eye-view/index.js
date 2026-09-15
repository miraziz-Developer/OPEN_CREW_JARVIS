'use strict';

/** Isolated localhost adapter for the upstream God's Eye View Vite app. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { PROJECT_DIR } = require('../../core/paths');

const DEFAULT_PORT = 4173;
const LOOPBACK_HOST = '127.0.0.1';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const MAX_PLACE_LENGTH = 160;
const LAYER_TOKENS = Object.freeze({
  'ais-live-vessels': 'a', bikeshare: 'b', cctv: 'c',
  directions: 'n', earthquakes: 'e', flights: 'f', 'local-dams': 'q',
  'local-datacenters': 'd', 'local-firms': 'w', military: 'm',
  'military-awareness': 'g', 'military-installations': 'i', radio: 'r',
  'rocket-launches': 'x', satellites: 's',
  'telegeography-submarine-cables': 'u', traffic: 't',
});
const BLOCKED_LAYERS = Object.freeze({
  'alpr-cameras': 'ALPR/license-plate camera data is not available through Jarvis.',
});
const LAYER_ALIASES = Object.freeze({
  vessels: 'ais-live-vessels', ais: 'ais-live-vessels', cameras: 'cctv', camera: 'cctv',
  fires: 'local-firms', firms: 'local-firms', launches: 'rocket-launches',
  cables: 'telegeography-submarine-cables', datacenters: 'local-datacenters', dams: 'local-dams',
});
const LAYER_DETAILS = Object.freeze({
  'ais-live-vessels': 'Public AIS vessel positions', bikeshare: 'Public bike-share stations',
  cctv: 'Lawful public camera sources only; regional coverage varies', directions: 'Directions overlay',
  earthquakes: 'Recent earthquakes', flights: 'Public flight positions', 'local-dams': 'Dam infrastructure',
  'local-datacenters': 'Data-center infrastructure', 'local-firms': 'NASA FIRMS active fires',
  military: 'Military flight layer where upstream data permits',
  'military-awareness': 'Military-awareness summary layer',
  'military-installations': 'Military-installation reference layer', radio: 'Public radio directory',
  'rocket-launches': 'Rocket launches', satellites: 'Satellite positions',
  'telegeography-submarine-cables': 'TeleGeography submarine cables (non-commercial terms apply)',
  traffic: 'Traffic flow where the upstream provider has coverage',
});

function readEnv(name, fallback) {
  if (process.env[name] !== undefined) return process.env[name];
  try {
    const source = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
    const match = source.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return match ? match[1].trim() : fallback;
  } catch { return fallback; }
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return DEFAULT_PORT;
  return port;
}

function configuration() {
  const port = parsePort(readEnv('GODS_EYE_VIEW_PORT', String(DEFAULT_PORT)));
  return {
    enabled: String(readEnv('GODS_EYE_VIEW_ENABLED', 'true')).toLowerCase() !== 'false',
    port,
    host: LOOPBACK_HOST,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    appDir: path.join(PROJECT_DIR, 'vendor', 'gods-eye-view'),
    runtimeDir: path.join(PROJECT_DIR, '.run'),
  };
}

function cleanPlace(place) {
  const value = String(place || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('place required');
  if (value.length > MAX_PLACE_LENGTH) throw new Error(`place must be at most ${MAX_PLACE_LENGTH} characters`);
  return value;
}

function validCoordinate(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) throw new Error('Geocoding returned invalid coordinates');
  return numeric;
}

function createViewUrl(baseUrl, latitude, longitude, options = {}) {
  const lat = validCoordinate(latitude, -90, 90);
  const lon = validCoordinate(longitude, -180, 180);
  const altitude = Math.max(250, Math.min(20000000, Number(options.altitude) || 12000));
  const url = new URL(baseUrl);
  const params = new URLSearchParams({
    v: '2', lat: lat.toFixed(6), lon: lon.toFixed(6), alt: String(Math.round(altitude)),
    heading: '0', pitch: '-55', map: 'esri',
  });
  const layers = normalizeLayers(options.layers);
  if (layers.length) params.set('l', layers.map(layer => LAYER_TOKENS[layer]).sort().join('.'));
  url.hash = params.toString();
  return url.toString();
}

function normalizeLayers(value) {
  if (value === undefined || value === null) return [];
  const requested = Array.isArray(value) ? value : String(value).split(',');
  if (requested.length > 17) throw new Error('At most 17 layers may be requested');
  const layers = requested.map(layer => String(layer).trim().toLowerCase()).filter(Boolean).map(layer => LAYER_ALIASES[layer] || layer);
  for (const layer of layers) {
    if (BLOCKED_LAYERS[layer]) throw new Error(BLOCKED_LAYERS[layer]);
    if (!Object.hasOwn(LAYER_TOKENS, layer)) throw new Error(`Unsupported God's Eye View layer: ${layer}`);
  }
  return [...new Set(layers)];
}

function availableLayers() {
  return {
    status: 'ok',
    layers: Object.entries(LAYER_TOKENS).map(([id, token]) => ({ id, token, description: LAYER_DETAILS[id] })),
    blocked: Object.entries(BLOCKED_LAYERS).map(([id, reason]) => ({ id, reason })),
    note: 'Coverage and freshness depend on the upstream public-data provider and requested region.',
  };
}

function requestJson(url, headers = {}, timeoutMs = 10000) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 512 * 1024) request.destroy(new Error('Response too large'));
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON response')); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
  });
}

async function geocode(place) {
  const query = cleanPlace(place);
  const url = new URL(NOMINATIM_URL);
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', addressdetails: '1' }).toString();
  const rows = await requestJson(url.toString(), {
    'User-Agent': 'Open-Crew-Jarvis/1.0 (local Gods-Eye-View integration)', Accept: 'application/json',
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Place not found: ${query}`);
  const hit = rows[0] || {};
  return {
    query,
    name: String(hit.display_name || query).slice(0, 300),
    latitude: validCoordinate(hit.lat, -90, 90),
    longitude: validCoordinate(hit.lon, -180, 180),
  };
}

function probe(url, timeoutMs = 1000) {
  return new Promise(resolve => {
    const request = http.get(url, response => { response.resume(); resolve(response.statusCode > 0 && response.statusCode < 500); });
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function ensureServer(options = {}) {
  const config = configuration();
  if (!config.enabled) throw new Error('GODS_EYE_VIEW_ENABLED=false');
  if (!fs.existsSync(path.join(config.appDir, 'package.json'))) throw new Error(`God's Eye View checkout missing: ${config.appDir}`);
  if (!fs.existsSync(path.join(config.appDir, 'node_modules'))) throw new Error(`God's Eye View dependencies missing; run npm ci in ${config.appDir}`);
  if (await probe(config.baseUrl)) return { ...config, started: false };
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const log = fs.openSync(path.join(config.runtimeDir, 'gods-eye-view.log'), 'a');
  const child = spawn('npm', ['run', 'dev', '--', '--host', config.host, '--port', String(config.port)], {
    cwd: config.appDir, detached: true, stdio: ['ignore', log, log],
    // The upstream standalone app has an optional provider-key onboarding UI.
    // Jarvis owns voice control and opens already-resolved places, so its local
    // embedded view must remain a keyless globe rather than asking for OpenAI.
    env: { ...process.env, HOST: config.host, PORT: String(config.port), VITE_GODS_EYE_VIEW_EMBEDDED: 'true' },
  });
  child.unref();
  const deadline = Date.now() + (options.startTimeoutMs || 30000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await probe(config.baseUrl)) return { ...config, started: true };
  }
  throw new Error(`God's Eye View did not start. Check ${path.join(config.runtimeDir, 'gods-eye-view.log')}`);
}

function openBrowser(url) {
  return new Promise((resolve, reject) => execFile('open', [url], error => error ? reject(error) : resolve()));
}

async function show(input = {}) {
  const server = await ensureServer(input);
  const place = await geocode(input.place);
  const url = createViewUrl(server.baseUrl, place.latitude, place.longitude, input);
  await openBrowser(url);
  return { status: 'ok', started: server.started, place, url, message: `${place.name} God's Eye View oynasida ochildi.` };
}

async function status() {
  const config = configuration();
  return { status: 'ok', enabled: config.enabled, running: config.enabled && await probe(config.baseUrl), url: config.baseUrl, loopbackOnly: true };
}

async function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}');
  } catch {
    throw new Error('Input must be valid JSON');
  }
  const action = String(input.action || 'show').toLowerCase();
  if (action === 'show') return show(input);
  if (action === 'status') return status();
  if (action === 'available-layers' || action === 'layers') return availableLayers();
  throw new Error(`Unknown God's Eye View action: ${action}`);
}

if (require.main === module) {
  main()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(JSON.stringify({ status: 'error', message: error.message }));
      process.exitCode = 1;
    });
}

module.exports = { cleanPlace, parsePort, createViewUrl, normalizeLayers, availableLayers, geocode, ensureServer, show, status, configuration, main };