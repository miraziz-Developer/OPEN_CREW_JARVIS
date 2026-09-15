'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createSkillPlatform } = require('../skills/platform');

function envStub(k, def) {
  const values = { AZURE_SPEECH_KEY: 'stub', AZURE_SPEECH_REGION: 'stub' };
  return values[k] !== undefined ? values[k] : def;
}

test('createSkillPlatform registers fast-actions and azure-tts with expected shape', () => {
  const platform = createSkillPlatform({ projectDir: path.join(__dirname, '..'), env: envStub });
  const byId = Object.fromEntries(platform.list().map(s => [s.id, s]));

  assert.ok(byId['fast-actions'], 'fast-actions should be registered');
  assert.deepEqual(Object.keys(byId['fast-actions'].actions).sort(), ['actionIds', 'learnOpenAppAction', 'runFastAction']);
  assert.deepEqual(byId['fast-actions'].actions.runFastAction.input, { required: ['id'] });

  assert.ok(byId.communications, 'communications should be registered');
  assert.deepEqual(Object.keys(byId.communications.actions).sort(), ['lookupContact', 'openWhatsAppDraft', 'searchYouTube', 'startFaceTimeCall']);
  assert.deepEqual(byId.communications.actions.startFaceTimeCall.input, { required: ['phone', 'confirmed'] });

  assert.ok(byId['azure-tts'], 'azure-tts should be registered');
  assert.equal(byId['azure-tts'].actions.synthesize.timeoutMs, 20000);
  assert.deepEqual(byId['azure-tts'].actions.synthesize.input, { required: ['text'] });

  // Pre-existing registrations must survive the createSkillPlatform signature change.
  assert.ok(byId['google-calendar']);
  assert.ok(byId['gmail']);
  assert.ok(byId['deep-think']);
  assert.ok(byId['desktop-control']);
  assert.deepEqual(Object.keys(byId['desktop-control'].actions).sort(), ['clickElement', 'findElement', 'focusElement', 'inspectUi', 'scroll', 'selectMenu', 'setText', 'toggleElement', 'waitForElement']);
  assert.deepEqual(byId['desktop-control'].actions.toggleElement.input, { required: ['query'] });
  assert.deepEqual(byId['desktop-control'].actions.scroll.input, { required: ['direction'] });
  assert.ok(byId['screen-vision']);
  assert.ok(byId['gods-eye-view']);
  assert.deepEqual(Object.keys(byId['gods-eye-view'].actions).sort(), ['availableLayers', 'show', 'status']);
  assert.deepEqual(byId['gods-eye-view'].actions.show.input, { required: ['place'], properties: { place: 'string', altitude: 'number', layers: 'array' } });
});

test('fast-actions.runFastAction rejects when the underlying action reports an error', async () => {
  const platform = createSkillPlatform({ projectDir: path.join(__dirname, '..'), env: envStub });
  await assert.rejects(
    platform.invoke('fast-actions', 'runFastAction', { id: 'nonexistent:action-id' }),
    /nonexistent:action-id|topilmadi|not found/i
  );
});
