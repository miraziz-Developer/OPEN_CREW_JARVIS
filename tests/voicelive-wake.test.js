const assert = require('assert');
const { EventEmitter } = require('events');
const { VoiceLiveWake } = require('../core/voicelive-wake');

function run() {
  const worker = new VoiceLiveWake({ provider: null });
  // should be an EventEmitter
  assert.ok(worker instanceof EventEmitter);
  // ws is not started, feedAudio should safely return false
  const ok = worker.feedAudio(Buffer.from([0,1,2,3]));
  assert.strictEqual(ok, false);
  // attaching listeners should not throw
  worker.on('ready', () => {});
  worker.on('transcript', () => {});
}

if (typeof test === 'function') {
  test('VoiceLiveWake: basic instantiation and feedAudio behavior', run);
} else {
  // allow running with plain node for compatibility
  run();
}

// Additional test: ensure session.update uses provided model when ws opens
if (typeof test === 'function') {
  test('VoiceLiveWake: session payload includes provided model', () => {
    let sent = null;
    class FakeWS extends EventEmitter {
      constructor(url, opts) {
        super();
        this.readyState = FakeWS.OPEN;
        // schedule open next tick
        process.nextTick(() => this.emit('open'));
      }
      send(data) { sent = data; }
      close() { this.readyState = FakeWS.CLOSED; }
    }
    FakeWS.OPEN = 1; FakeWS.CLOSED = 3;

    const provider = { url: 'wss://example/', headers: {}, model: 'gpt-xyz' };
    const worker = new VoiceLiveWake({ provider, model: 'gpt-abc', wsClass: FakeWS });
    worker.start();
    // give nextTick handlers time
    return new Promise((resolve) => setTimeout(() => {
      assert.ok(sent, 'session update should be sent');
      const payload = JSON.parse(sent.toString());
      assert.equal(payload.type, 'session.update');
      const usedModel = payload.session.audio.input.transcription.model;
      // constructor model should take precedence
      assert.equal(usedModel, 'gpt-abc');
      worker.close();
      resolve();
    }, 10));
  });
} else {
  // plain node compatibility: run quick smoke with FakeWS
  (async () => {
    let sent = null;
    class FakeWS extends EventEmitter {
      constructor(url, opts) { super(); this.readyState = 1; process.nextTick(() => this.emit('open')); }
      send(data) { sent = data; }
      close() {}
    }
    const provider = { url: 'wss://example/', headers: {}, model: 'gpt-xyz' };
    const worker = new VoiceLiveWake({ provider, model: 'gpt-abc', wsClass: FakeWS });
    worker.start();
    await new Promise(r => setTimeout(r, 10));
    if (!sent) throw new Error('session.update was not sent');
  })();
}
