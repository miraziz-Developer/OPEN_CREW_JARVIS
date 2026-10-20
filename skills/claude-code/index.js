#!/usr/bin/env node
/**
 * CLAUDE CODE skill: hands complex tasks (video editing, writing code, etc.) to
 * Claude Code. Claude Code has real file/exec access (e.g. it can edit video with
 * ffmpeg), but for safety it works only inside the given work folder with a limited
 * tool set (--dangerously-skip-permissions is NOT used).
 *
 * Input (stdin JSON): { task: "...", workDir?: "..." }
 * Output: { status: "ok", result: "...", workDir: "..." } | { status: "error", message }
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_WORK_DIR = path.join(os.homedir(), 'Desktop', 'Jarvis-Video-Projects');
const ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes: video editing can take a while

function runClaudeCode(task, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const args = [
    '-p', task,
    '--add-dir', workDir,
    '--allowedTools', ALLOWED_TOOLS
  ];
  const out = execFileSync('claude', args, {
    cwd: workDir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return out.trim();
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  if (!input.task) { console.log(JSON.stringify({ status: 'error', message: 'task is required' })); return; }
  const workDir = input.workDir || DEFAULT_WORK_DIR;

  try {
    const result = runClaudeCode(input.task, workDir);
    console.log(JSON.stringify({ status: 'ok', result, workDir }));
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
    console.log(JSON.stringify({ status: 'error', message: msg.slice(0, 500) }));
  }
}

if (require.main === module) main();

module.exports = { runClaudeCode, DEFAULT_WORK_DIR };
