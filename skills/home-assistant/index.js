#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { PROJECT_DIR } = require('../../core/paths');

let ENV = '';
try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
function env(name, fallback = '') {
  if (process.env[name] !== undefined) return process.env[name];
  const match = ENV.match(new RegExp('^' + name + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}

const DEFAULT_DOMAINS = 'light,switch,fan,climate,media_player,scene,script,automation,input_boolean';
const SAFE_ATTRIBUTES = new Set([
  'friendly_name', 'device_class', 'unit_of_measurement', 'brightness', 'color_temp_kelvin',
  'temperature', 'current_temperature', 'hvac_action', 'percentage', 'media_title', 'source'
]);
const SECURITY_DOMAINS = new Set(['lock', 'alarm_control_panel', 'cover']);
const SECURITY_SERVICES = /^(?:unlock|lock|open_cover|close_cover|open_cover_tilt|close_cover_tilt|alarm_arm_.*|alarm_disarm)$/;
const NAME = /^[a-z0-9_]+$/;
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function enabled(value) { return /^(?:1|true|yes|on)$/i.test(String(value || '')); }
function csv(value) { return String(value || '').split(',').map(item => item.trim()).filter(Boolean); }
function publicState(state) {
  if (!state || typeof state !== 'object') return null;
  const attributes = {};
  for (const [key, value] of Object.entries(state.attributes || {})) {
    if (SAFE_ATTRIBUTES.has(key)) attributes[key] = value;
  }
  return {
    entityId: String(state.entity_id || ''), state: String(state.state || ''), attributes,
    lastChanged: state.last_changed || null, lastUpdated: state.last_updated || null
  };
}

function matchesEntity(entityId, patterns) {
  if (!patterns.length) return true;
  return patterns.some(pattern => pattern === '*' || pattern === entityId ||
    (pattern.endsWith('.*') && entityId.startsWith(pattern.slice(0, -1))));
}

class HomeAssistantClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? env('HOME_ASSISTANT_URL')).replace(/\/$/, '');
    this.token = String(options.accessToken ?? env('HOME_ASSISTANT_TOKEN'));
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs ?? env('HOME_ASSISTANT_TIMEOUT_MS', '8000')) || 8000));
    this.allowedDomains = new Set(csv(options.allowedDomains ?? env('HOME_ASSISTANT_ALLOWED_DOMAINS', DEFAULT_DOMAINS)));
    this.allowedEntities = csv(options.allowedEntities ?? env('HOME_ASSISTANT_ALLOWED_ENTITIES', ''));
    this.allowSecurityActions = enabled(options.allowSecurityActions ?? env('HOME_ASSISTANT_ALLOW_SECURITY_ACTIONS', 'false'));
    this.request = options.request || this._request.bind(this);
  }

  _configured() {
    if (!this.baseUrl || !this.token) throw new Error('Home Assistant is not configured: set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN');
    const url = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('HOME_ASSISTANT_URL must be a plain http/https base URL without credentials, query, or fragment');
    }
  }

  _request(method, apiPath, body) {
    this._configured();
    const url = new URL(apiPath, this.baseUrl + '/');
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
        }
      }, response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          raw += chunk;
          if (raw.length > 2 * 1024 * 1024) request.destroy(new Error('Home Assistant response exceeded 2 MB'));
        });
        response.on('end', () => {
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const detail = typeof data === 'object' ? data?.message : data;
            return reject(new Error(`Home Assistant HTTP ${response.statusCode}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`));
          }
          resolve(data);
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error(`Home Assistant timeout (${this.timeoutMs}ms)`)));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  _authorizeEntity(entityId, domain = entityId.split('.')[0]) {
    if (!ENTITY_ID.test(entityId)) throw new Error('Invalid Home Assistant entityId');
    if (!this.allowedDomains.has(domain)) throw new Error(`Home Assistant domain is not allowed: ${domain}`);
    if (!matchesEntity(entityId, this.allowedEntities)) throw new Error(`Home Assistant entity is not allowed: ${entityId}`);
  }

  async status() {
    const result = await this.request('GET', '/api/');
    return { status: 'ok', connected: true, message: String(result?.message || 'Home Assistant API reachable').slice(0, 200) };
  }

  async listEntities(input = {}) {
    const states = await this.request('GET', '/api/states');
    const domain = input.domain ? String(input.domain).toLowerCase() : '';
    if (domain && (!NAME.test(domain) || !this.allowedDomains.has(domain))) throw new Error(`Home Assistant domain is not allowed: ${domain}`);
    const entities = (Array.isArray(states) ? states : [])
      .filter(item => ENTITY_ID.test(item?.entity_id || ''))
      .filter(item => this.allowedDomains.has(item.entity_id.split('.')[0]))
      .filter(item => matchesEntity(item.entity_id, this.allowedEntities))
      .filter(item => !domain || item.entity_id.startsWith(domain + '.'))
      .slice(0, Math.max(1, Math.min(500, Number(input.limit) || 100)))
      .map(publicState);
    return { status: 'ok', count: entities.length, entities };
  }

  async getEntity(entityId) {
    const normalized = String(entityId || '').toLowerCase();
    this._authorizeEntity(normalized);
    return { status: 'ok', entity: publicState(await this.request('GET', `/api/states/${normalized}`)) };
  }

  async callService(input = {}) {
    const domain = String(input.domain || '').toLowerCase();
    const service = String(input.service || '').toLowerCase();
    const entityId = String(input.entityId || '').toLowerCase();
    if (!NAME.test(domain) || !NAME.test(service)) throw new Error('Invalid Home Assistant domain or service');
    this._authorizeEntity(entityId, domain);
    if (entityId.split('.')[0] !== domain) throw new Error('Home Assistant entityId domain must match domain');
    const securityAction = SECURITY_DOMAINS.has(domain) || SECURITY_SERVICES.test(service);
    if (securityAction && !this.allowSecurityActions) {
      throw new Error('Physical security actions are disabled; explicitly configure HOME_ASSISTANT_ALLOW_SECURITY_ACTIONS=true and allow the domain');
    }
    if (securityAction && input.confirmed !== true) throw new Error('Explicit confirmation is required for physical security actions');
    const data = input.data === undefined ? {} : input.data;
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Home Assistant service data must be an object');

    const before = publicState(await this.request('GET', `/api/states/${entityId}`));
    const response = await this.request('POST', `/api/services/${domain}/${service}`, { ...data, entity_id: entityId });
    const after = publicState(await this.request('GET', `/api/states/${entityId}`));
    const expected = service === 'turn_on' ? 'on' : service === 'turn_off' ? 'off' : null;
    const observableChanged = JSON.stringify(before) !== JSON.stringify(after);
    const verified = expected ? after?.state === expected : service === 'toggle' ? before?.state !== after?.state : observableChanged;
    return {
      status: 'ok', domain, service, entityId, before, after, verified,
      verification: expected ? { expectedState: expected, actualState: after?.state || null } : { stateObserved: Boolean(after), observableChanged },
      evidence: [{ type: 'api-response', changedEntities: Array.isArray(response) ? response.length : null }, { type: 'entity-state', value: after }]
    };
  }
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (_) {}
  const client = new HomeAssistantClient();
  try {
    let result;
    if (input.action === 'status') result = await client.status();
    else if (input.action === 'list_entities') result = await client.listEntities(input);
    else if (input.action === 'get_entity') result = await client.getEntity(input.entityId);
    else if (input.action === 'call_service') result = await client.callService(input);
    else throw new Error('Unknown action (status|list_entities|get_entity|call_service)');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', message: error.message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { HomeAssistantClient, publicState, matchesEntity };