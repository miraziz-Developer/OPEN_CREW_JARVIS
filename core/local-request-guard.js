'use strict';

/**
 * Guards state-changing requests to localhost-only HTTP servers (the dashboard).
 *
 * Binding to 127.0.0.1 is not enough: any web page open in the user's browser can
 * POST a "simple" cross-origin request (text/plain, no preflight) to localhost, and
 * DNS rebinding can make a remote hostname resolve to 127.0.0.1. For a server that
 * forwards messages to an agent with full computer control, that is remote command
 * execution. A request is trusted only when:
 *   - the Host header names this machine (defeats DNS rebinding),
 *   - the Origin, if present, is this server itself (defeats cross-site POSTs), and
 *   - the body is declared as JSON (forces a CORS preflight that the server never grants).
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

function isTrustedLocalRequest(req, port) {
  const headers = req.headers || {};
  if (!LOCAL_HOSTNAMES.has(hostnameOf(headers.host))) return { ok: false, reason: 'host' };

  if (headers.origin !== undefined) {
    let origin;
    try { origin = new URL(headers.origin); } catch (_) { return { ok: false, reason: 'origin' }; }
    const originPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
    if (!LOCAL_HOSTNAMES.has(origin.hostname) || originPort !== String(port)) return { ok: false, reason: 'origin' };
  }

  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return { ok: false, reason: 'content-type' };
  return { ok: true };
}

module.exports = { isTrustedLocalRequest };
