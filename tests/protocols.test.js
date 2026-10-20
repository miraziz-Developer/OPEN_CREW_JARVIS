'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocols = require('../core/protocols');
const { MissionStore } = require('../core/missions/store');
const { matchDirectFastAction } = require('../skills/realtime-voice');

const LSOF = `COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
ControlCe   612 me    9u  IPv4 0x1      0t0  TCP *:7000 (LISTEN)
rapportd    590 me    4u  IPv6 0x2      0t0  TCP *:55395 (LISTEN)
postgres    800 me    7u  IPv4 0x3      0t0  TCP *:5432 (LISTEN)
node        900 me   20u  IPv4 0x4      0t0  TCP 127.0.0.1:7890 (LISTEN)
node        901 me   21u  IPv6 0x5      0t0  TCP [::1]:18789 (LISTEN)`;

function fakeRun(overrides = {}) {
  const calls = [];
  const outputs = {
    socketfilterfw: 'Firewall is disabled. (State = 0)',
    fdesetup: 'FileVault is On.',
    spctl: 'assessments enabled',
    lsof: LSOF,
    df: 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 1000 950 50 95% /System/Volumes/Data',
    pmset: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t15%; discharging; 1:02 remaining present: true",
    memory_pressure: 'System-wide memory free percentage: 64%',
    ps: '%CPU COMM\n 97.0 /Applications/Foo.app/Contents/MacOS/Foo',
    curl: '200',
    launchctl: '123\t0\tcom.jarvis.openclaw\n-\t1\tcom.jarvis.mission-runner',
    osascript: '40,false',
    ...overrides
  };
  const run = async (command, args) => {
    calls.push([path.basename(command), ...args]);
    const out = outputs[path.basename(command)];
    return { ok: out !== false, stdout: out || '', stderr: '' };
  };
  return { run, calls };
}

test('combat sweep reports real problems and leaves expected Apple listeners unflagged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-protocol-'));
  const report = await protocols.combatSweep({ run: fakeRun().run, reportFile: path.join(dir, 'r.json') });
  const warnings = report.findings.filter(f => f.level === 'warn').map(f => f.text);
  assert.deepEqual(warnings, [
    'Firewall is off',
    '1 app port open to the network: postgres:5432',
    'Disk 5% free',
    'Battery 15%',
    'Foo is using 97% CPU',
    'JARVIS services down: mission-runner'
  ]);
  assert.ok(report.findings.some(f => f.level === 'info' && /ControlCe:7000, rapportd:55395/.test(f.text)));
  assert.match(report.summary, /^Sweep complete, sir\. 6 issues: Firewall is off;/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8')).warnings, 6);
});

test('a probe that fails is reported as unknown, not as a problem', () => {
  assert.equal(protocols.parseFirewall(''), null);
  const report = protocols.buildReport({ exposedPorts: null, services: [] });
  assert.equal(report.warnings, 0);
});

test('lockdown pauses running missions, mutes and locks; standby restores exactly that', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-protocol-'));
  const store = new MissionStore({ dir: path.join(dir, 'missions') });
  const running = store.create('build the thing'); running.status = 'running'; store.save(running);
  const waiting = store.create('apply to jobs'); waiting.status = 'awaiting_approval'; store.save(waiting);
  const stateFile = path.join(dir, 'state.json');

  const lock = fakeRun();
  const locked = await protocols.lockdown({ run: lock.run, stateFile, missionStore: store });
  assert.equal(locked.paused, 1);
  assert.match(locked.summary, /Screen locked and audio muted\. 1 running mission paused/);
  const scripts = lock.calls.filter(c => c[0] === 'osascript').map(c => c[2]);
  assert.ok(scripts.includes('set volume with output muted'));
  assert.ok(scripts.some(s => /keystroke "q" using \{control down, command down\}/.test(s)));
  assert.deepEqual(store.drainInbox().map(c => [c.id, c.action]), [[running.id, 'pause']], 'only the running mission is paused');

  // The runner applies the pause; standby must resume only what lockdown paused.
  running.status = 'paused'; store.save(running);
  const wake = fakeRun();
  const result = await protocols.standby({ run: wake.run, stateFile, missionStore: store });
  assert.equal(result.summary, 'Standing down. audio restored, 1 mission resumed.');
  const restore = wake.calls.filter(c => c[0] === 'osascript').map(c => c[2]);
  assert.deepEqual(restore, ['set volume output volume 40', 'set volume without output muted']);
});

test('voice phrases reach the protocols directly', () => {
  assert.equal(matchDirectFastAction('Jarvis, combat protocol'), 'protocol:combat');
  assert.equal(matchDirectFastAction('run a security sweep'), 'protocol:combat');
  assert.equal(matchDirectFastAction('lockdown'), 'protocol:lockdown');
  assert.equal(matchDirectFastAction('stand down'), 'protocol:standby');
});
