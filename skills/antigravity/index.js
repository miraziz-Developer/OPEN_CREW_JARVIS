'use strict';

/**
 * ANTIGRAVITY SKILL for JARVIS
 *
 * Delegates software-engineering work (multi-file edits, project generation,
 * debugging, terminal operations) to the Antigravity CLI (`agy`) that ships
 * with Gemini Desktop.
 *
 * Failures are reported as errors, never as output: callers must not mistake
 * an "authentication required" banner for a model answer.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_DIR } = require('../../core/paths');

const AUTH_REQUIRED_PATTERN = /authentication required|run 'agy' to log in|not logged in/i;
const UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;

let unavailableUntil = 0;
let unavailableReason = '';

class AntigravityUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AntigravityUnavailableError';
  }
}

function findAgy() {
  const candidates = [
    process.env.AGY_PATH,
    '/Applications/Gemini.app/Contents/Helpers/agy',
    path.join(process.env.HOME || '', '.gemini', 'antigravity', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy'
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function markUnavailable(reason) {
  unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
  unavailableReason = reason;
}

function assertAvailable() {
  if (Date.now() < unavailableUntil) throw new AntigravityUnavailableError(unavailableReason);
  const agy = findAgy();
  if (!agy) throw new AntigravityUnavailableError('Antigravity CLI (agy) is not installed');
  return agy;
}

function runAgy(args, options = {}) {
  const agy = assertAvailable();
  const cwd = options.cwd || PROJECT_DIR;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(agy, args, {
      cwd,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error(`Antigravity timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdin.on('error', () => {}); // agy may exit before reading stdin

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    if (options.stdin) proc.stdin.write(options.stdin);
    proc.stdin.end();
  });
}

/**
 * Runs a coding task through Antigravity.
 * Resolves with `{ status: 'ok', output }` on success; throws on any failure.
 */
async function executePrompt(prompt, options = {}) {
  const targetDir = options.projectDir;
  const cwd = targetDir || (options.scope === 'workspace' ? PROJECT_DIR : '/tmp');
  const effort = options.effort || 'high';

  const args = [
    '-p', String(prompt),
    '--effort', effort,
    '--dangerously-skip-permissions',
    '--disable-slash-commands'
  ];
  const model = options.model || (effort === 'low' ? 'gemini-3.8-flash-low' : undefined);
  if (model) args.push('--model', model);
  if (targetDir) args.push('--add-dir', targetDir);
  // A mission keeps one Antigravity conversation, so later steps remember
  // what earlier steps changed in the project.
  if (options.conversationId) args.push('--conversation', String(options.conversationId));
  if (options.json) args.push('--output-format', 'json');

  const res = await runAgy(args, { cwd, timeoutMs: options.timeoutMs });
  const combined = `${res.stdout}\n${res.stderr}`;
  if (AUTH_REQUIRED_PATTERN.test(combined)) {
    markUnavailable('Antigravity is not signed in. Run `agy` once in a terminal to log in.');
    throw new AntigravityUnavailableError(unavailableReason);
  }
  if (res.code !== 0) {
    throw new Error(`Antigravity exited with code ${res.code}: ${(res.stderr || res.stdout).slice(0, 300)}`);
  }
  if (!options.json) return { status: 'ok', output: res.stdout, exitCode: res.code };
  const parsed = parseJsonResult(res.stdout);
  if (!parsed) return { status: 'ok', output: res.stdout, exitCode: res.code, conversationId: null };
  if (parsed.status && parsed.status !== 'SUCCESS') {
    throw new Error(`Antigravity finished with status ${parsed.status}: ${String(parsed.response || parsed.error || '').slice(0, 300)}`);
  }
  return { status: 'ok', output: String(parsed.response || '').trim(), exitCode: res.code, conversationId: parsed.conversation_id || null };
}

// `--output-format json` prints one object; tolerate log lines before it.
function parseJsonResult(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try { return JSON.parse(text); } catch (_) {}
  }
  try { return JSON.parse(String(stdout || '').trim()); } catch (_) { return null; }
}

/**
 * Creates a new project directory and asks Antigravity to scaffold it.
 */
async function createProject(name, description, options = {}) {
  const safeName = String(name || '').trim();
  if (!/^[\w.-]+$/.test(safeName) || safeName.startsWith('.')) {
    throw new Error('Project name may only contain letters, digits, ".", "_" and "-"');
  }
  const baseDir = options.targetDir || path.join(process.env.HOME || '', 'projects');
  const projectPath = path.join(baseDir, safeName);
  fs.mkdirSync(projectPath, { recursive: true });

  const prompt = `Create a new project named "${safeName}". Description: ${description}. ` +
    'Create the project files, a README.md, a package manifest or whatever environment it needs, and write the code.';
  return executePrompt(prompt, { projectDir: projectPath, effort: 'high' });
}

function status() {
  const agyPath = findAgy();
  const signedOut = Date.now() < unavailableUntil;
  return {
    status: 'ok',
    available: Boolean(agyPath) && !signedOut,
    agyPath,
    reason: signedOut ? unavailableReason : (agyPath ? '' : 'agy not installed'),
    geminiDesktop: fs.existsSync('/Applications/Gemini.app')
  };
}

module.exports = {
  AntigravityUnavailableError,
  executePrompt,
  createProject,
  status,
  findAgy,
  runAgy
};
