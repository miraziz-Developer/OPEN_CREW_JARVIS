'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

test('server.sh, Dockerfile and compose file exist and server.sh is valid bash', () => {
  for (const f of ['server.sh', 'Dockerfile', 'docker-compose.yml', '.dockerignore', 'server/supervisor.js', 'server/jobs.js']) assert.ok(fs.existsSync(path.join(root, f)), f);
  execFileSync('bash', ['-n', path.join(root, 'server.sh')]);
});

test('Dockerfile keeps secrets and state out of the image and drops macOS-only Python packages', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(docker, /pyobjc/);           // filtered out of requirements
  assert.match(docker, /USER node/);       // not root at runtime
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n');
  for (const entry of ['.env', '.google-tokens.json', '.git', 'node_modules']) assert.ok(ignore.includes(entry), entry);
});

test('compose publishes the unauthenticated dashboard only on host loopback', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:7890:7890/);
  assert.doesNotMatch(compose, /^\s*-\s*"?0\.0\.0\.0/m);
});

test('repo config is portable: no personal absolute paths in tracked runtime config', () => {
  const oc = fs.readFileSync(path.join(root, 'openclaw.json'), 'utf8');
  assert.doesNotMatch(oc, /\/Users\/[a-z]/i);
});
