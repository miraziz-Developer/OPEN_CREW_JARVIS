'use strict';

const { assessAction, ActionSafetyPolicy } = require('../action-safety-policy');

const WORKERS = ['agent', 'interpreter', 'browser', 'gui', 'babyagi', 'autogpt', 'think'];

const PLAN_SYSTEM =
  "You are the planning core of JARVIS's autonomous goal engine (BabyAGI/AutoGPT style). Turn the user's goal into " +
  "verifiable success criteria and a short list of concrete tasks. Reply with ONE JSON object only:\n" +
  '{"criteria":["..."],"tasks":[{"title":"...","worker":"agent|interpreter|browser|gui|babyagi|autogpt|think","prompt":"...","priority":1-10}]}\n' +
  "Workers: agent = full computer agent with skills (calendar, email, files, Telegram, memory, desktop apps, web search); " +
  "interpreter = code, terminal, scripts, files, data work and local dev servers; browser = multi-step web research, portals and forms " +
  "with a real browser that is ALREADY signed in to the user's Google and LinkedIn accounts (never type passwords; on login, 2FA or CAPTCHA stop and report it); gui = visual desktop UI when no API or accessibility exists; babyagi = BabyAGI, writes and registers new Python functions on the fly for computational or data subtasks and reuses them later; " +
  "autogpt = AutoGPT, an autonomous think-act loop with web search and file output for open-ended research or writing that ends in a written deliverable; think = pure reasoning or writing, no side effects.\n" +
  "Rules: 3-6 criteria a reviewer could check from evidence; use the FEWEST tasks that make sense (one to three for a simple goal, at most 8 for a large one): " +
  "each worker session is slow, so one task should do as much as it safely can, self-contained, with absolute paths and exact expectations in its prompt, and include its own verification step; each job application or outreach message must be its own task (one job or one recipient per task); prefer read-only inspection first; higher priority number runs first — SEQUENCE the plan: think through the whole job end to end, list tasks in the exact order they must run, give them strictly decreasing priorities (10, 9, 8, …) in that order, and in each later task's prompt name the files or results the earlier tasks produce and where (absolute paths) so no task depends on guessing; never include secrets; " +
  "never plan irreversible, external or costly actions unless the goal explicitly asks for them. For job hunting: research, shortlisting and drafting are separate tasks from actually applying or messaging recruiters, so the approval gate can ask the user first.";

const REFLECT_SYSTEM =
  "You are the verification and reflection core of JARVIS's autonomous goal engine. You receive the goal, success criteria, the task list " +
  "and the result of the task that just ran. Reply with ONE JSON object only:\n" +
  '{"task_status":"done|retry|failed","evidence":"...","skip_tasks":[],"new_tasks":[{"title":"...","worker":"...","prompt":"...","priority":1-10}],' +
  '"goal_achieved":false,"goal_evidence":"","blocked":false,"blocker":"","summary":"one line of progress"}\n' +
  "Rules: task_status=done only if the result shows the task really worked (not just that a command ran); retry when a different approach may " +
  "succeed (put the new approach in new_tasks and leave this one failed) ; goal_achieved=true ONLY when every success criterion is satisfied " +
  "with concrete evidence in the results, otherwise keep working; add new_tasks only when needed and never repeat an identical failing task; " +
  "blocked=true only when progress needs something the user must provide (credentials, a decision, a missing file) and say exactly what in blocker. " +
  "Add \"skip_tasks\":[ids] to drop pending tasks that are already satisfied by the results so far (do this whenever a task already did the work of later ones).";

// Kalit-so'z siyosati inkorlarni ("do not delete") va zararsiz iboralarni ("file permissions", /private/tmp yo'li) ham
// xavfli deb hisoblaydi. Missiyalarda bu doimiy to'siq bo'lardi, shuning uchun baholashdan oldin ularni olib tashlaymiz;
// haqiqiy "delete X", "send an email" kabi buyruqlar esa o'zgarishsiz qoladi.
const RISK_VERBS = 'delet|remov|eras|modif|send|email|post|publish|upload|shar|purchas|buy|pay|transfer|chang|touch|access|writ|creat';
const NEGATED_ACTIONS = new RegExp(
  "\\b(?:do\\s+not|don['’]?t|never|must\\s+not|should\\s+not|without|avoid)\\s+(?:\\w+\\s+){0,3}?(?:" + RISK_VERBS + ")\\w*" +
  "(?:\\s*(?:,|\\bor\\b|\\band\\b|\\bnor\\b)\\s*(?:(?:any|the|a|an|my|or|and)\\s+){0,2}(?:" + RISK_VERBS + ")\\w*)*", 'gi');

function sanitizeForRisk(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')                                                    // URL ichidagi ?format=3, /post/ kabilar
    .replace(/\b(?:error|short|summary|status|log|commit|exception|warning|help|output|explanatory)\s+messages?\b/gi, ' ')
    .replace(/\bmessage\s+(?:field|key|string|text)\b/gi, ' ')
    .replace(/\bformat(?:s|ted|ting)?\b(?!\s+(?:the\s+)?(?:disk|drive|volume|partition|mac|hard))/gi, 'layout')
    .replace(NEGATED_ACTIONS, ' ')
    .replace(/\bread[- ]only\b/gi, ' ')
    .replace(/\b(?:default|file|unix|posix|directory)\s+permissions?\b/gi, ' ')
    .replace(/\bchmod\b/gi, ' ')
    .replace(/\/private\//g, '/');
}

// Ish arizasi, HR/recruiter xabari va shunga o'xshash tashqi yuborish amallari doim tasdiq talab qiladi
// (umumiy siyosat "apply"/"submit" so'zlarini tashqi ta'sir deb bilmaydi).
// Ariza/xat yuborish tasdig'i faqat strict rejimda (standart: to'liq avtonomiya).
function confirmModeStrict() {
  let v = process.env.JARVIS_CONFIRM_MODE;
  if (v === undefined) { try { const m = require('fs').readFileSync(require('path').join(require('../paths').PROJECT_DIR, '.env'), 'utf8').match(/^JARVIS_CONFIRM_MODE\s*=\s*(.*)$/m); if (m) v = m[1]; } catch (_) {} }
  return String(v ?? 'off').trim().toLowerCase() === 'strict';
}
const OUTREACH_RISK = /\b(?:apply(?:ing)?\s+(?:to|for|on)|easy\s+apply|submit(?:ting)?\s+(?:an?\s+|the\s+|your\s+)?(?:job\s+)?(?:application|form|resume|cv)s?|send(?:ing)?\s+(?:an?\s+)?(?:inmail|connection\s+request)|inmail|connection\s+requests?|(?:message|contact|email|write\s+to|dm)\s+(?:the\s+)?(?:hr|recruiters?|hiring\s+managers?))\b/i;

function clip(value, max) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }

function normalizeTasks(rawTasks, existingCount = 0, now = Date.now()) {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return list.filter(task => task && task.prompt).slice(0, 12).map((task, index) => ({
    id: `t${existingCount + index + 1}`,
    title: clip(task.title || task.prompt, 120),
    worker: WORKERS.includes(task.worker) ? task.worker : 'agent',
    prompt: String(task.prompt).slice(0, 4000),
    priority: Math.max(1, Math.min(10, Number(task.priority) || 5)),
    status: 'pending', attempts: 0, result: null, error: null, approved: false,
    createdAt: now, doneAt: null
  }));
}

class GoalEngine {
  constructor(options = {}) {
    this.store = options.store;
    this.llm = options.llm;                 // { completeJson(opts) }
    this.workers = options.workers;         // { name: { run({prompt, mission, task, timeoutMs}) } }
    this.now = options.now || Date.now;
    this.assess = options.assess || assessAction;
    this.fullAutonomy = options.fullAutonomy || (() => new ActionSafetyPolicy().fullAutonomyProvider());
    this.emit = options.emit || (event => this.store.appendEvent(event));
    this.model = options.model;
    // Missiyani boshlash oddiy lokal amallarni (fayl, o'rnatish, hisobot) ruxsat etadi; tashqi xabar, o'chirish, to'lov, parol —
    // doim tasdiq bilan. 'strict' rejimida hammasi tasdiqli.
    this.routineAutonomy = options.routineAutonomy !== false;
    this.standing = options.standing || null;   // StandingApprovals (doimiy ruxsatlar)
  }

  _log(mission, kind, text) {
    mission.log.push({ at: this.now(), iteration: mission.iteration, kind, text: clip(text, 400) });
    if (mission.log.length > 200) mission.log.splice(0, mission.log.length - 200);
  }

  _event(mission, kind, text, extra = {}) {
    this.emit({ kind, missionId: mission.id, n: mission.n, text, ...extra });
  }

  // ── Boshqaruv buyruqlari (inbox) ─────────────────────────────────────────
  applyCommand(mission, command) {
    const { action, payload = {} } = command;
    const terminal = ['completed', 'failed', 'cancelled', 'blocked'].includes(mission.status);
    if (action === 'cancel' && mission.status !== 'cancelled') {
      mission.status = 'cancelled'; mission.completedAt = this.now();
      for (const task of mission.tasks) if (['pending', 'running'].includes(task.status)) task.status = 'skipped';
      this._log(mission, 'control', 'cancelled by user');
      this._event(mission, 'mission.cancelled', `Mission ${mission.n} cancelled.`);
    } else if (action === 'pause' && ['planning', 'running'].includes(mission.status)) {
      mission.status = 'paused'; this._log(mission, 'control', 'paused by user');
      this._event(mission, 'mission.paused', `Mission ${mission.n} paused.`);
    } else if (action === 'resume' && (mission.status === 'paused' || mission.status === 'blocked')) {
      mission.status = mission.tasks.length ? 'running' : 'planning'; mission.consecutiveFailures = 0;
      this._log(mission, 'control', 'resumed by user');
      this._event(mission, 'mission.resumed', `Mission ${mission.n} resumed.`);
    } else if (action === 'approve' && mission.status === 'awaiting_approval' && mission.pendingApproval) {
      const task = mission.tasks.find(t => t.id === mission.pendingApproval.taskId);
      if (task) task.approved = true;
      mission.pendingApproval = null; mission.status = 'running';
      this._log(mission, 'control', 'approved by user');
      this._event(mission, 'mission.approved', `Mission ${mission.n} approved, continuing.`);
    } else if (action === 'reject' && mission.status === 'awaiting_approval' && mission.pendingApproval) {
      const task = mission.tasks.find(t => t.id === mission.pendingApproval.taskId);
      if (task) { task.status = 'skipped'; task.error = 'rejected by user'; }
      mission.notes.push(`The user rejected the task "${task?.title}". Find a safer way or finish without it.`);
      mission.pendingApproval = null; mission.status = 'running';
      this._log(mission, 'control', 'rejected by user');
      this._event(mission, 'mission.rejected', `Task rejected on mission ${mission.n}; continuing another way.`);
    } else if (action === 'note' && payload.text && !terminal) {
      mission.notes.push(clip(payload.text, 500));
      this._log(mission, 'note', payload.text);
    }
    return mission;
  }

  // ── Budjet ────────────────────────────────────────────────────────────────
  _budgetExceeded(mission) {
    const { maxIterations, maxHours } = mission.budget;
    if (mission.iteration >= maxIterations) return `iteration budget reached (${maxIterations})`;
    if (maxHours > 0 && this.now() - mission.createdAt > maxHours * 3600000) return `time budget reached (${maxHours} hours)`;
    return null;
  }

  _finish(mission, status, text, result = null) {
    mission.status = status; mission.completedAt = this.now(); mission.result = result;
    this._log(mission, status, text);
    const kinds = { completed: 'mission.completed', blocked: 'mission.blocked', failed: 'mission.failed' };
    this._event(mission, kinds[status] || `mission.${status}`, text);
    this.store.save(mission);
    return mission;
  }

  // ── Reja ──────────────────────────────────────────────────────────────────
  async plan(mission) {
    const notes = mission.notes.length ? `\nUser notes:\n- ${mission.notes.join('\n- ')}` : '';
    const plan = await this.llm.completeJson({
      system: PLAN_SYSTEM, user: `Goal: ${mission.goal}${notes}`, model: this.model, effort: 'medium', maxOutputTokens: 6000
    });
    mission.criteria = (Array.isArray(plan.criteria) ? plan.criteria : []).map(c => clip(c, 300)).filter(Boolean).slice(0, 8);
    if (!mission.criteria.length) mission.criteria = [`The goal is fully achieved: ${clip(mission.goal, 200)}`];
    mission.tasks = normalizeTasks(plan.tasks, 0, this.now());
    if (!mission.tasks.length) throw new Error('Reja bo\'sh chiqdi');
    mission.status = 'running';
    this._log(mission, 'plan', `${mission.tasks.length} tasks, ${mission.criteria.length} criteria`);
    this._event(mission, 'mission.planned', `Mission ${mission.n} planned: ${mission.tasks.length} tasks.`);
    return mission;
  }

  _nextTask(mission) {
    return mission.tasks
      .filter(task => task.status === 'pending')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0] || null;
  }

  _needsApproval(task) {
    if (task.approved) return null;
    const text = sanitizeForRisk(`${task.title}. ${task.prompt}`);
    const assessment = this.assess({ kind: 'task', description: text });
    const outreach = confirmModeStrict() && OUTREACH_RISK.test(text);
    if (outreach || assessment.requiresConfirmation) {
      // Doimiy ruxsat (kunlik limit ichida) mos kelsa so'ramaymiz; xavfli toifalar hech qachon qoplanmaydi.
      const rule = this.standing?.consume(text, outreach && !assessment.externalSideEffect ? { ...assessment, category: 'external-communication' } : assessment);
      if (rule) { task.approved = true; task.approvedBy = `standing:${rule.id}`; return null; }
    }
    if (outreach) return 'external-communication (job application or outreach)';
    if (!assessment.requiresConfirmation) return null;
    if (assessment.autonomousEligible && (this.routineAutonomy || this.fullAutonomy())) return null;
    return assessment.category || 'risky action';
  }

  _digest(mission) {
    const lines = mission.tasks.map(task => `${task.id} [${task.status}${task.attempts ? ` x${task.attempts}` : ''}] (${task.worker}) ${task.title}` +
      (task.result ? ` => ${clip(task.result, 160)}` : task.error ? ` !! ${clip(task.error, 160)}` : ''));
    return lines.slice(-30).join('\n');
  }

  // ── Bitta iteratsiya: bajarish → tekshirish → yangilash ─────────────────
  async step(mission) {
    if (mission.status === 'planning') {
      try { await this.plan(mission); } catch (error) {
        mission.consecutiveFailures += 1;
        this._log(mission, 'plan-error', error.message);
        if (mission.consecutiveFailures >= mission.budget.maxConsecutiveFailures) return this._finish(mission, 'failed', `Mission ${mission.n} failed: could not plan (${error.message}).`);
      }
      return this.store.save(mission);
    }
    if (mission.status !== 'running') return mission;

    const exceeded = this._budgetExceeded(mission);
    if (exceeded) return this._finish(mission, 'blocked', `Mission ${mission.n} stopped: ${exceeded}. Say resume to extend it.`);

    const task = this._nextTask(mission);
    if (!task) {
      // Vazifa qolmadi, lekin maqsad tasdiqlanmagan: reja tuzuvchidan yakuniy tekshiruv/yangi vazifalar so'raymiz.
      return this._reflectWithoutTask(mission);
    }

    const approvalReason = this._needsApproval(task);
    if (approvalReason) {
      mission.status = 'awaiting_approval';
      mission.pendingApproval = { taskId: task.id, reason: clip(`${task.title} (${approvalReason})`, 200), at: this.now() };
      this._log(mission, 'approval', mission.pendingApproval.reason);
      this._event(mission, 'mission.needs_approval', `Mission ${mission.n} needs your approval to ${clip(task.title, 120)}. Say approve or reject.`);
      return this.store.save(mission);
    }

    mission.iteration += 1;
    task.status = 'running'; task.attempts += 1;
    this.store.save(mission);
    const worker = this.workers[task.worker] || this.workers.agent;
    let outcome;
    try {
      outcome = await worker.run({ prompt: this._taskPrompt(mission, task), mission, task, timeoutMs: mission.budget.taskTimeoutMs });
    } catch (error) { outcome = { ok: false, output: '', error: error.message }; }
    task.result = clip(outcome.output, 4000) || null;
    task.error = outcome.ok ? null : clip(outcome.error || 'worker failed', 500);
    // Vazifa bajarilayotganda foydalanuvchi bekor/pauza qilgan bo'lishi mumkin — holatni bosib ketmaymiz.
    if (mission.status === 'cancelled') { task.status = 'skipped'; return this.store.save(mission); }
    if (['paused', 'awaiting_approval'].includes(mission.status)) {
      task.status = 'pending'; task.attempts = Math.max(0, task.attempts - 1);
      return this.store.save(mission);
    }
    return this._reflect(mission, task, outcome);
  }

  _taskPrompt(mission, task) {
    const context = mission.notes.length ? `\nUser notes: ${mission.notes.join(' | ')}` : '';
    return `${task.prompt}\n\nOverall goal: ${mission.goal}${context}\nReply with a concise factual summary of what you did and the concrete results (paths, values, outputs).`;
  }

  async _reflect(mission, task, outcome) {
    let verdict;
    try {
      verdict = await this.llm.completeJson({
        system: REFLECT_SYSTEM, model: this.model, effort: 'low', maxOutputTokens: 4000,
        user: `Goal: ${mission.goal}\nSuccess criteria:\n- ${mission.criteria.join('\n- ')}\n${mission.notes.length ? `User notes: ${mission.notes.join(' | ')}\n` : ''}` +
          `\nTasks so far:\n${this._digest(mission)}\n\nTask just run: ${task.id} (${task.worker}) ${task.title}\nPrompt: ${clip(task.prompt, 600)}\n` +
          `Worker ok: ${outcome.ok}\nWorker output:\n${String(outcome.output || outcome.error || '').slice(-3500)}`
      });
    } catch (error) {
      verdict = { task_status: outcome.ok ? 'done' : 'failed', evidence: 'reflection unavailable', new_tasks: [], goal_achieved: false, summary: '' };
      this._log(mission, 'reflect-error', error.message);
    }

    const status = ['done', 'retry', 'failed'].includes(verdict.task_status) ? verdict.task_status : (outcome.ok ? 'done' : 'failed');
    if (status === 'done') {
      task.status = 'done'; task.doneAt = this.now(); mission.consecutiveFailures = 0;
      this._log(mission, 'task-done', `${task.id} ${task.title}: ${clip(verdict.evidence, 200)}`);
    } else {
      mission.consecutiveFailures += 1;
      if (task.attempts < mission.budget.maxTaskAttempts && status === 'retry') task.status = 'pending';
      else task.status = 'failed';
      task.error = clip(verdict.evidence || task.error || 'task failed', 400);
      this._log(mission, 'task-failed', `${task.id} ${task.title}: ${task.error}`);
    }
    if (verdict.summary) mission.summary = clip(verdict.summary, 300);
    this._skipTasks(mission, verdict.skip_tasks);
    const fresh = normalizeTasks(verdict.new_tasks, mission.tasks.length, this.now());
    if (fresh.length) {
      const known = new Set(mission.tasks.map(t => `${t.worker}|${t.prompt}`));
      for (const item of fresh) if (!known.has(`${item.worker}|${item.prompt}`)) mission.tasks.push(item);
    }

    if (verdict.goal_achieved === true && clip(verdict.goal_evidence, 10)) {
      return this._finish(mission, 'completed', `Mission ${mission.n} is complete: ${clip(verdict.summary || verdict.goal_evidence, 240)}`, clip(verdict.goal_evidence, 1500));
    }
    if (verdict.blocked === true && clip(verdict.blocker, 3)) {
      return this._finish(mission, 'blocked', `Mission ${mission.n} blocked: ${clip(verdict.blocker, 90)}.`);
    }
    if (mission.consecutiveFailures >= mission.budget.maxConsecutiveFailures) {
      return this._finish(mission, 'blocked', `Mission ${mission.n} stalled: ${clip(task.error, 70)}.`);
    }
    if (status === 'done' && mission.tasks.filter(t => t.status === 'done').length % 5 === 0) {
      this._event(mission, 'mission.milestone', `Mission ${mission.n} progress: ${mission.tasks.filter(t => t.status === 'done').length} tasks done. ${mission.summary}`, { quiet: true });
    }
    return this.store.save(mission);
  }

  _skipTasks(mission, ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const task = mission.tasks.find(t => t.id === String(id) && t.status === 'pending');
      if (task) { task.status = 'skipped'; task.error = 'already satisfied'; }
    }
  }

  async _reflectWithoutTask(mission) {
    mission.iteration += 1;
    let verdict;
    try {
      verdict = await this.llm.completeJson({
        system: REFLECT_SYSTEM, model: this.model, effort: 'medium', maxOutputTokens: 4000,
        user: `Goal: ${mission.goal}\nSuccess criteria:\n- ${mission.criteria.join('\n- ')}\n\nAll tasks are finished or failed:\n${this._digest(mission)}\n\n` +
          'There is no task that just ran. Decide whether the goal is achieved (with evidence from the results above) or add the new tasks still needed.'
      });
    } catch (error) {
      mission.consecutiveFailures += 1;
      this._log(mission, 'reflect-error', error.message);
      if (mission.consecutiveFailures >= mission.budget.maxConsecutiveFailures) return this._finish(mission, 'blocked', `Mission ${mission.n} stalled: ${error.message}.`);
      return this.store.save(mission);
    }
    if (verdict.summary) mission.summary = clip(verdict.summary, 300);
    if (verdict.goal_achieved === true && clip(verdict.goal_evidence, 10)) {
      return this._finish(mission, 'completed', `Mission ${mission.n} is complete: ${clip(verdict.summary || verdict.goal_evidence, 240)}`, clip(verdict.goal_evidence, 1500));
    }
    const fresh = normalizeTasks(verdict.new_tasks, mission.tasks.length, this.now());
    if (fresh.length) { mission.tasks.push(...fresh); return this.store.save(mission); }
    if (verdict.blocked === true) return this._finish(mission, 'blocked', `Mission ${mission.n} blocked: ${clip(verdict.blocker || 'unknown', 90)}.`);
    return this._finish(mission, 'blocked', `Mission ${mission.n} has no further tasks but the goal is not verified. Tell me what is missing.`);
  }
}

module.exports = { GoalEngine, normalizeTasks, WORKERS, sanitizeForRisk };
