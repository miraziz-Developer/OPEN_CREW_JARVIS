'use strict';

const { SkillPlatform } = require('../core/skill-platform');

function createSkillPlatform(options = {}) {
  const platform = new SkillPlatform(options);
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
    actions: { askExpert: { input: { required: ['question'] }, timeoutMs: 45000 } }
  }, async () => {
    const expert = require('./deep-think');
    return { askExpert: input => expert.askExpert(input.question, input.context) };
  });
  return platform;
}

module.exports = { createSkillPlatform };