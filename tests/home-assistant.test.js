'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HomeAssistantClient, publicState, matchesEntity } = require('../skills/home-assistant');

function fixtureServer() {
  const states = {
    'light.office': { entity_id: 'light.office', state: 'off', attributes: { friendly_name: 'Office', brightness: 0, latitude: 1 } },
    'sensor.private_location': { entity_id: 'sensor.private_location', state: 'home', attributes: { latitude: 1 } }
  };
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/') return response.end(JSON.stringify({ message: 'API running.' }));
    if (request.method === 'GET' && request.url === '/api/states') return response.end(JSON.stringify(Object.values(states)));
    if (request.method === 'GET' && request.url.startsWith('/api/states/')) {
      const id = request.url.slice('/api/states/'.length);
      return response.end(JSON.stringify(states[id]));
    }
    if (request.method === 'POST' && request.url === '/api/services/light/turn_on') {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        states[body.entity_id].state = 'on';
        states[body.entity_id].attributes.brightness = 128;
        response.end(JSON.stringify([states[body.entity_id]]));
      });
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  return { server, listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), close: () => new Promise(resolve => server.close(resolve)) };
}

test('Home Assistant filters domains and sensitive attributes', async () => {
  const fixture = fixtureServer();
  await fixture.listen();
  try {
    const client = new HomeAssistantClient({ baseUrl: `http://127.0.0.1:${fixture.server.address().port}`, accessToken: 'test-token', allowedDomains: 'light' });
    assert.equal((await client.status()).connected, true);
    const result = await client.listEntities();
    assert.equal(result.count, 1);
    assert.equal(result.entities[0].entityId, 'light.office');
    assert.equal(result.entities[0].attributes.latitude, undefined);
  } finally { await fixture.close(); }
});

test('Home Assistant service calls use read-back verification', async () => {
  const fixture = fixtureServer();
  await fixture.listen();
  try {
    const client = new HomeAssistantClient({ baseUrl: `http://127.0.0.1:${fixture.server.address().port}`, accessToken: 'test-token', allowedDomains: 'light', allowedEntities: 'light.office' });
    const result = await client.callService({ domain: 'light', service: 'turn_on', entityId: 'light.office', data: { brightness_pct: 50 } });
    assert.equal(result.before.state, 'off');
    assert.equal(result.after.state, 'on');
    assert.equal(result.verified, true);
    assert.equal(result.evidence[1].type, 'entity-state');
  } finally { await fixture.close(); }
});

test('Home Assistant rejects out-of-scope and unconfirmed physical security actions', async () => {
  const client = new HomeAssistantClient({ baseUrl: 'http://127.0.0.1:1', accessToken: 'test-token', allowedDomains: 'light,lock', allowedEntities: 'light.office,lock.front_door' });
  await assert.rejects(client.getEntity('sensor.location'), /domain is not allowed/);
  await assert.rejects(client.callService({ domain: 'lock', service: 'unlock', entityId: 'lock.front_door' }), /security actions are disabled/);
  const optedIn = new HomeAssistantClient({ baseUrl: 'http://127.0.0.1:1', accessToken: 'test-token', allowedDomains: 'lock', allowSecurityActions: true });
  await assert.rejects(optedIn.callService({ domain: 'lock', service: 'unlock', entityId: 'lock.front_door' }), /Explicit confirmation/);
});

test('Home Assistant allowlists and state projection are deterministic', () => {
  assert.equal(matchesEntity('light.office', ['light.*']), true);
  assert.equal(matchesEntity('switch.office', ['light.*']), false);
  assert.deepEqual(publicState({ entity_id: 'light.x', state: 'on', attributes: { friendly_name: 'X', access_token: 'secret' } }).attributes, { friendly_name: 'X' });
});

test('Home Assistant does not claim generic service verification without an observable change', async () => {
  const unchanged = { entity_id: 'script.arrive_home', state: 'off', attributes: { friendly_name: 'Arrive home' } };
  const client = new HomeAssistantClient({
    baseUrl: 'http://homeassistant.local:8123', accessToken: 'test-token', allowedDomains: 'script',
    request: async method => method === 'GET' ? unchanged : []
  });
  const result = await client.callService({ domain: 'script', service: 'run', entityId: 'script.arrive_home' });
  assert.equal(result.verified, false);
  assert.equal(result.verification.observableChanged, false);
});