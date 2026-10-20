'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { createAgentBridge } = require('../core/agent-bridge');
const { readEnvFile } = require('../core/config');
const { PROJECT_DIR } = require('../core/paths');

async function runEndToEndTests() {
  console.log('--- STARTING E2E MULTI-TASK & VOICE TEST ---');

  const envValues = readEnvFile(path.join(PROJECT_DIR, '.env'));
  const env = (k, fb = '') => envValues[k] !== undefined ? envValues[k] : fb;

  const { createSkillPlatform } = require('../skills/platform');
  const skillPlatform = createSkillPlatform({ projectDir: PROJECT_DIR, env });

  const bridge = createAgentBridge({
    chatId: env('TELEGRAM_CHAT_ID'),
    token: env('TELEGRAM_BOT_TOKEN'),
    projectDir: PROJECT_DIR,
    env,
    skillPlatform
  });

  // 1. Direct Voice Conversation Turn
  console.log('\n[1/3] Testing Direct Voice Conversation...');
  const t0 = Date.now();
  const voiceReply = await bridge.askAgent('Hello JARVIS, status report.', undefined, { source: 'voice' });
  const latency = Date.now() - t0;
  console.log(`Voice reply (${latency}ms): "${voiceReply}"`);

  assert.ok(voiceReply && voiceReply.length > 5, 'Voice reply must be non-empty');
  assert.ok(!/cannot|unable|unavailable|qil(?:a\s*)?olmayman/i.test(voiceReply), 'Must NEVER say cannot / unable / qilolmayman');
  assert.ok(latency < 15000, `Voice latency must be snappy (< 15000ms), got ${latency}ms`);

  // 2. TTS Voice Synthesis Verification
  console.log('\n[2/3] Testing Christopher Voice Native Synthesis...');
  const tts0 = Date.now();
  const audioPath = await bridge.ttsToFile(voiceReply);
  const ttsLatency = Date.now() - tts0;
  console.log(`Audio synthesized in ${ttsLatency}ms -> ${audioPath}`);
  assert.ok(audioPath && fs.existsSync(audioPath), 'TTS audio file must exist');
  const size = fs.statSync(audioPath).size;
  console.log(`Audio file size: ${size} bytes`);
  assert.ok(size > 1000, 'Audio file must contain valid speech (> 1000 bytes)');
  try { fs.unlinkSync(audioPath); } catch (_) {}

  // 3. Multi-tasking Concurrency: Background Task + Simultaneous Dialogue
  console.log('\n[3/3] Testing Parallel Multi-tasking + Live Dialogue...');
  let bgTaskDone = false;
  let bgTaskResult = null;

  // Launch background task
  const bgPromise = (async () => {
    console.log('   -> Background task dispatched: "Generate Fibonacci in Python"');
    const res = await bridge.askAgent('Write a Python function for Fibonacci numbers with memoization and verify it.', undefined, {
      source: 'background-task',
      persistent: true
    });
    bgTaskResult = res;
    bgTaskDone = true;
    console.log('   -> Background task finished!');
  })();

  // While background task is running, user asks a real-time question immediately
  console.log('   -> User immediately asks voice question while task is in flight...');
  const q0 = Date.now();
  const immediateVoiceReply = await bridge.askAgent('What is the capital of France and what time is it?', undefined, { source: 'voice' });
  const qLatency = Date.now() - q0;
  console.log(`   -> Immediate voice reply (${qLatency}ms): "${immediateVoiceReply}"`);

  assert.ok(immediateVoiceReply.toLowerCase().includes('paris'), 'Voice reply must correctly answer while background task runs');
  assert.ok(!/cannot|unable|unavailable|qil(?:a\s*)?olmayman/i.test(immediateVoiceReply), 'No excuses during multitasking');
  assert.equal(bgTaskDone, false, 'Voice conversation must return BEFORE the heavy background task completes!');

  // Wait for background task to complete
  await bgPromise;
  assert.ok(bgTaskResult && bgTaskResult.length > 50, 'Background task must produce comprehensive output');
  console.log(`   -> Background task result snippet:\n${bgTaskResult.slice(0, 200)}...\n`);

  console.log('--- ALL E2E MULTI-TASK & VOICE TESTS PASSED SUCCESSFULLY! ---');
}

runEndToEndTests().catch(err => {
  console.error('E2E TEST FAILED:', err);
  process.exit(1);
});
