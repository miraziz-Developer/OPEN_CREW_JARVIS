'use strict';

/**
 * ANTIGRAVITY SKILL for JARVIS
 * 
 * Allows JARVIS to delegate complex software engineering, multi-file code editing,
 * project generation, debugging, and terminal operations to the Antigravity assistant
 * running inside Gemini Desktop.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_DIR } = require('../../core/paths');

function findAgy() {
  const candidates = [
    '/Applications/Gemini.app/Contents/Helpers/agy',
    path.join(process.env.HOME || '', '.gemini', 'antigravity', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'agy';
}

function runAgy(args, options = {}) {
  const agy = findAgy();
  const cwd = options.cwd || PROJECT_DIR;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(agy, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error(`Antigravity timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    if (options.stdin) {
      try { proc.stdin.write(options.stdin); } catch (_) {}
    }
    try { proc.stdin.end(); } catch (_) {}
  });
}

/**
 * Antigravity orqali dasturlash vazifasini bajarish
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
  if (model) {
    args.push('--model', model);
  }
  if (targetDir) {
    args.push('--add-dir', targetDir);
  }

  const res = await runAgy(args, { cwd, timeoutMs: options.timeoutMs });
  return {
    status: res.code === 0 ? 'ok' : 'error',
    output: res.stdout || res.stderr,
    exitCode: res.code
  };
}

/**
 * Yangi loyiha yaratish yoki mavjud loyihada modul qo'shish
 */
async function createProject(name, description, options = {}) {
  const baseDir = options.targetDir || path.join(process.env.HOME || '', 'projects');
  const projectPath = path.join(baseDir, name);
  fs.mkdirSync(projectPath, { recursive: true });

  const prompt = `Yangi loyiha yarat: ${name}. Tavsif: ${description}. Loyiha fayllarini yarat, README.md, package.json yoki talab qilingan muhitni sozla va kodni yoz.`;
  return executePrompt(prompt, { projectDir: projectPath, effort: 'high' });
}

/**
 * Holatni tekshirish
 */
function status() {
  const agyPath = findAgy();
  const available = fs.existsSync(agyPath);
  return {
    status: 'ok',
    available,
    agyPath,
    geminiDesktop: fs.existsSync('/Applications/Gemini.app')
  };
}

module.exports = {
  executePrompt,
  createProject,
  status,
  findAgy,
  runAgy
};
