'use strict';

const { SkillPlatform } = require('../core/skill-platform');

function createSkillPlatform({ projectDir, env, ...platformOptions } = {}) {
  const platform = new SkillPlatform(platformOptions);
  // Keep the outer skill deadline beyond the HTTP request deadline.
  const deepThinkTimeoutMs = Math.max(30000, parseInt(env?.('DEEP_THINK_TIMEOUT_MS'), 10) || 240000) + 5000;
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
    id: 'communications', version: '1.0.0', capabilities: ['contacts.read', 'web.open', 'communications.call'],
    actions: {
      searchYouTube: { permissions: ['web.open'], input: { required: ['query'] } },
      lookupContact: { permissions: ['contacts.read'], input: { required: ['query'] } },
      openWhatsAppDraft: { permissions: ['web.open'], input: { required: ['phone', 'message'] } },
      startFaceTimeCall: { permissions: ['communications.call'], input: { required: ['phone', 'confirmed'] } }
    }
  }, async () => {
    const communications = require('./communications');
    return {
      searchYouTube: input => communications.searchYouTube(input.query),
      lookupContact: input => communications.lookupContact(input.query),
      openWhatsAppDraft: input => communications.openWhatsAppDraft(input),
      startFaceTimeCall: input => communications.startFaceTimeCall(input)
    };
  });
  platform.register({
    id: 'desktop-control', version: '2.0.0', capabilities: ['desktop.read', 'desktop.write'],
    actions: {
      inspectUi: { permissions: ['desktop.read'] },
      findElement: { permissions: ['desktop.read'], input: { required: ['query'] } },
      waitForElement: { permissions: ['desktop.read'], input: { required: ['query'] } },
      clickElement: { permissions: ['desktop.write'], input: { required: ['query'] } },
      focusElement: { permissions: ['desktop.write'], input: { required: ['query'] } },
      setText: { permissions: ['desktop.write'], input: { required: ['query', 'value'] } },
      toggleElement: { permissions: ['desktop.write'], input: { required: ['query'] } },
      scroll: { permissions: ['desktop.write'], input: { required: ['direction'] } },
      selectMenu: { permissions: ['desktop.write'], input: { required: ['menu', 'item'] } }
    }
  }, async () => {
    const desktop = require('./desktop-control');
    return {
      inspectUi: input => desktop.inspectUi(input), findElement: input => desktop.findElement(input),
      waitForElement: input => desktop.waitForElement(input), clickElement: input => desktop.actOnElement(input, 'press'),
      focusElement: input => desktop.actOnElement(input, 'focus'), setText: input => desktop.actOnElement(input, 'set_value'),
      toggleElement: input => desktop.actOnElement(input, 'press'), scroll: input => desktop.scroll(input),
      selectMenu: input => desktop.selectMenu(input)
    };
  });
  platform.register({
    id: 'screen-vision', version: '2.0.0', capabilities: ['screen.read'],
    actions: { normalizeElements: { permissions: ['screen.read'], input: { required: ['result'] } } }
  }, async () => {
    const vision = require('./screen-vision');
    return { normalizeElements: input => vision.normalizeVisionResult(input.result) };
  });
  platform.register({
    id: 'gods-eye-view', version: '1.0.0', capabilities: ['web.open', 'geospatial.visualization'],
    actions: {
      show: { permissions: ['web.open'], input: { required: ['place'], properties: { place: 'string', altitude: 'number', layers: 'array' } }, timeoutMs: 45000 },
      status: { timeoutMs: 5000 },
      availableLayers: { timeoutMs: 5000 }
    }
  }, async () => require('./gods-eye-view'));
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
            AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || 'en-US-GuyNeural',
            AZURE_SPEECH_LANGUAGE: env('AZURE_SPEECH_LANGUAGE') || 'en-US',
            AZURE_SPEECH_RATE_PERCENT: env('AZURE_SPEECH_RATE_PERCENT') || '-12',
            AZURE_SPEECH_PITCH_PERCENT: env('AZURE_SPEECH_PITCH_PERCENT') || '-12'
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