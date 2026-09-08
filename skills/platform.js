'use strict';

const { SkillPlatform } = require('../core/skill-platform');

function createSkillPlatform({ projectDir, env, ...platformOptions } = {}) {
  const platform = new SkillPlatform(platformOptions);
  const deepThinkTimeoutMs = Math.max(5000, parseInt(env?.('DEEP_THINK_TIMEOUT_MS'), 10) || 90000) + 5000;
  platform.register({
    id: 'google-calendar', version: '1.0.0', capabilities: ['calendar.read', 'calendar.write'],
    actions: {
      listEvents: { permissions: ['calendar.read'], input: { properties: { days: 'number', maxResults: 'number' } } },
      createEvent: { permissions: ['calendar.write'], input: { required: ['title', 'start'] } }
    }
  }, async () => {
    const calendar = require('./google-calendar');
    return {
      listEvents: input => calendar.listEvents(input.days, input.maxResults),
      createEvent: input => calendar.createEvent(input.title, input.start, input.end, input.description)
    };
  });
  platform.register({
    id: 'gmail', version: '1.0.0', capabilities: ['mail.read', 'mail.write'],
    actions: {
      listMessages: { permissions: ['mail.read'] },
      markRead: { permissions: ['mail.write'], input: { required: ['id'] } },
      sendMessage: { permissions: ['mail.write'], input: { required: ['to', 'subject', 'body'] } }
    }
  }, async () => {
    const gmail = require('./gmail');
    return {
      listMessages: input => gmail.listMessages(input.query, input.maxResults),
      markRead: input => gmail.markRead(input.id),
      sendMessage: input => gmail.sendMessage(input.to, input.subject, input.body)
    };
  });
  platform.register({
    id: 'deep-think', version: '1.0.0', capabilities: ['reasoning'],
    actions: { askExpert: { input: { required: ['question'] }, timeoutMs: deepThinkTimeoutMs } }
  }, async () => {
    const expert = require('./deep-think');
    return { askExpert: input => expert.askExpert(input.question, input.context) };
  });
  platform.register({
    id: 'fast-actions', version: '1.0.0', capabilities: ['automation'],
    actions: {
      // fa.runFastAction() hech qachon reject qilmaydi, natija sifatida
      // {status:'error'|'ok', ...} qaytaradi -- SkillPlatform.invoke buni
      // avtomatik xatolik sifatida tan oladi. Osilib qolgan holat (masalan
      // ruxsat dialogi kutayotgan osascript) esa platformaning o'z
      // timeout()'i orqali ushlanadi -- fa.runFastAction'ning o'zi hech
      // qachon tugamasa ham.
      runFastAction: { input: { required: ['id'] } },
      learnOpenAppAction: { input: { required: ['appName'] } },
      actionIds: {}
    }
  }, async () => {
    const fa = require('./fast-actions');
    return {
      runFastAction: input => fa.runFastAction(input.id),
      learnOpenAppAction: input => fa.learnOpenAppAction(input.appName),
      actionIds: () => fa.actionIds()
    };
  });
  platform.register({
    id: 'azure-tts', version: '1.0.0', capabilities: ['tts'],
    actions: { synthesize: { input: { required: ['text'] }, timeoutMs: 20000 } }
  }, async () => {
    const fs = require('fs');
    const { spawn } = require('child_process');
    return {
      synthesize: (input) => new Promise((resolve, reject) => {
        const tmpIn = '/tmp/tts_' + Date.now() + '.json';
        fs.writeFileSync(tmpIn, JSON.stringify({ text: input.text }), 'utf8');
        const proc = spawn('node', ['skills/azure-tts/index.js'], {
          cwd: projectDir,
          env: {
            ...process.env,
            AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'),
            AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'),
            AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || 'en-US-GuyNeural'
          }
        });
        let out = '';
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', () => {});
        proc.on('error', () => reject(new Error('azure-tts spawn xatolik')));
        proc.on('close', (code) => {
          try { fs.unlinkSync(tmpIn); } catch (e) {}
          try {
            const audioFile = JSON.parse(out.trim()).audioFile;
            if (code === 0 && audioFile && fs.statSync(audioFile).size > 512) resolve(audioFile);
            else reject(new Error('audio fayl yaratilmadi (code=' + code + ')'));
          } catch (e) { reject(new Error('azure-tts javobini o\'qib bo\'lmadi')); }
        });
        fs.createReadStream(tmpIn).pipe(proc.stdin);
      })
    };
  });
  return platform;
}

module.exports = { createSkillPlatform };