'use strict';

/**
 * Gemini Live adapter.
 *
 * Exposes the small WebSocket surface the realtime-voice skill uses
 * (addEventListener / send / close) and translates between the OpenAI Realtime
 * event protocol the skill speaks and Gemini's BidiGenerateContent protocol.
 *
 * Gemini answers spoken turns on its own (native audio-to-audio), which is where
 * its latency advantage comes from. The adapter therefore reports every model
 * turn the way a speculative server-VAD response looks:
 *
 *   speech_started → speech_stopped → response.created
 *     → input_audio_transcription.completed → audio deltas … → response.done
 *
 * The skill holds that audio until it has accepted the transcript, so its noise,
 * wake-word and safety filters still decide whether anything is played or any tool runs.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const INPUT_MIME = 'audio/pcm;rate=24000';

/** Converts an OpenAI/JSON-Schema parameter schema to Gemini's OpenAPI subset. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  if (schema.type) out.type = String(Array.isArray(schema.type) ? schema.type[0] : schema.type).toUpperCase();
  if (schema.description) out.description = String(schema.description);
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) out.properties[key] = toGeminiSchema(value);
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  return out;
}

function toGeminiTools(tools) {
  const declarations = (tools || [])
    .filter(tool => tool && tool.type === 'function' && tool.name)
    .map(tool => ({
      name: tool.name,
      description: tool.description || '',
      ...(tool.parameters ? { parameters: toGeminiSchema(tool.parameters) } : {})
    }));
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function buildSetup(session, options) {
  const turnDetection = session.turn_detection || {};
  const realtimeInputConfig = {
    // The skill performs its own confirmed barge-in; never let room echo cut a reply.
    activityHandling: 'NO_INTERRUPTION',
    automaticActivityDetection: {
      ...(turnDetection.silence_duration_ms ? { silenceDurationMs: turnDetection.silence_duration_ms } : {}),
      ...(turnDetection.prefix_padding_ms ? { prefixPaddingMs: turnDetection.prefix_padding_ms } : {})
    }
  };
  return {
    setup: {
      model: `models/${options.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } }
      },
      ...(session.instructions ? { systemInstruction: { parts: [{ text: session.instructions }] } } : {}),
      tools: toGeminiTools(session.tools),
      realtimeInputConfig,
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

class GeminiLiveSocket extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.model   Gemini Live model id, e.g. "gemini-3.1-flash-live-preview"
   * @param {string} options.voice   Prebuilt voice name, e.g. "Charon"
   * @param {Function} [options.createTransport] test hook: (url) => ws-like object
   */
  constructor(options) {
    super();
    this.options = options;
    this.readyState = WebSocket.CONNECTING;
    this._setupSent = false;
    this._setupComplete = false;
    this._seq = 0;
    this._pendingTexts = [];
    this._pendingToolResponses = [];
    this._toolFlushTimer = null;
    this._callNames = new Map();
    this._resetTurn();
    this._unansweredTranscript = '';

    const url = `${LIVE_ENDPOINT}?key=${encodeURIComponent(options.apiKey)}`;
    this._transport = options.createTransport
      ? options.createTransport(url)
      : new WebSocket(url, { handshakeTimeout: options.handshakeTimeoutMs || 10000 });

    this._transport.on('open', () => {
      this.readyState = WebSocket.OPEN;
      this.emit('open', { type: 'open' });
    });
    this._transport.on('message', data => this._onServerMessage(data));
    this._transport.on('error', error => this.emit('error', { type: 'error', error, message: error.message }));
    this._transport.on('close', (code, reason) => {
      this.readyState = WebSocket.CLOSED;
      if (!this._setupComplete) {
        // A rejected setup (bad model, schema, key) must surface as an error so the
        // skill can fall back to the next provider instead of ending the session.
        const message = `Gemini Live closed before setup completed (${code}${reason ? ': ' + reason : ''})`;
        this.emit('error', { type: 'error', error: new Error(message), message });
        return;
      }
      this.emit('close', { type: 'close', code, reason: String(reason || '') });
    });
  }

  addEventListener(type, listener) { this.on(type, listener); }
  removeEventListener(type, listener) { this.off(type, listener); }

  close() {
    clearTimeout(this._toolFlushTimer);
    this.readyState = WebSocket.CLOSING;
    try { this._transport.close(); } catch (_) {}
  }

  // ── Client (OpenAI Realtime) → Gemini ──────────────────────────────────────

  send(raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
    switch (msg.type) {
      case 'session.update':
        if (!this._setupSent && msg.session?.instructions !== undefined) {
          this._setupSent = true;
          this._sendServer(buildSetup(msg.session, this.options));
        }
        // Gemini cannot change a session mid-stream; later toggles are local-only.
        break;
      case 'input_audio_buffer.append':
        if (this._setupComplete && msg.audio) {
          this._sendServer({ realtimeInput: { audio: { data: msg.audio, mimeType: INPUT_MIME } } });
        }
        break;
      case 'conversation.item.create':
        this._onItemCreate(msg.item || {});
        break;
      case 'response.create':
        this._onResponseCreate(msg.response || {});
        break;
      case 'response.cancel':
        this._cancelTurn('cancelled', 'client_cancelled', { deferred: true });
        break;
      default:
        // conversation.item.delete and other housekeeping have no Gemini equivalent.
        break;
    }
  }

  _onItemCreate(item) {
    if (item.type === 'function_call_output') {
      const name = this._callNames.get(item.call_id) || 'unknown';
      let response;
      try { response = JSON.parse(item.output); } catch (_) { response = { output: String(item.output ?? '') }; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { output: response };
      // Held until the following response.create so its instructions can ride along;
      // flushed on its own if no response.create follows.
      this._pendingToolResponses.push({ id: item.call_id, name, response });
      clearTimeout(this._toolFlushTimer);
      this._toolFlushTimer = setTimeout(() => this._flushToolResponses(), 50);
      return;
    }
    if (item.type === 'message' && item.role === 'user') {
      const text = (item.content || []).map(part => part.text || part.transcript || '').join(' ').trim();
      if (text) this._pendingTexts.push(text);
    }
  }

  _flushToolResponses(instructions) {
    clearTimeout(this._toolFlushTimer);
    if (!this._pendingToolResponses.length) return false;
    const functionResponses = this._pendingToolResponses.splice(0).map(entry => (
      instructions ? { ...entry, response: { ...entry.response, instruction: instructions } } : entry
    ));
    this._sendServer({ toolResponse: { functionResponses } });
    return true; // Gemini continues the model turn on its own after a toolResponse
  }

  _onResponseCreate(response) {
    const instructions = String(response.instructions || '').trim();
    if (this._flushToolResponses(instructions)) return;

    const userText = this._pendingTexts.length ? this._pendingTexts.splice(0).join('\n') : this._unansweredTranscript;
    this._unansweredTranscript = '';
    const text = [instructions, userText].filter(Boolean).join('\n\n');
    if (text) {
      this._sendServer({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
      return;
    }
    // Nothing to answer (Gemini already replied to the spoken turn). Close the request
    // so the skill does not wait forever for a response.done that will never come.
    if (!this._turn.active) {
      const id = `gl_resp_${++this._seq}`;
      setImmediate(() => this._emitClient({ type: 'response.done', response: { id, status: 'completed' } }));
    }
  }

  // ── Gemini → client (OpenAI Realtime) ──────────────────────────────────────

  _onServerMessage(data) {
    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch (_) { return; }

    if (msg.setupComplete) {
      this._setupComplete = true;
      this._emitClient({ type: 'session.updated', session: { provider: 'gemini-live' } });
      return;
    }
    if (msg.toolCall) {
      this._startModelTurn();
      for (const call of msg.toolCall.functionCalls || []) {
        this._callNames.set(call.id, call.name);
        this._emitClient({
          type: 'response.function_call_arguments.done',
          response_id: this._turn.responseId,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args || {})
        });
      }
      return;
    }
    const content = msg.serverContent;
    if (!content) return;

    if (content.inputTranscription?.text) {
      if (!this._userSpeaking) {
        this._userSpeaking = true;
        this._emitClient({ type: 'input_audio_buffer.speech_started' });
      }
      this._inputText += content.inputTranscription.text;
    }

    for (const part of content.modelTurn?.parts || []) {
      if (!part.inlineData?.data) continue;
      this._startModelTurn();
      if (this._turn.dropping) continue;
      this._emitClient({
        type: 'response.output_audio.delta',
        response_id: this._turn.responseId,
        item_id: this._turn.itemId,
        delta: part.inlineData.data
      });
    }

    if (content.outputTranscription?.text) {
      this._startModelTurn();
      if (!this._turn.dropping) {
        this._emitClient({
          type: 'response.output_audio_transcript.delta',
          response_id: this._turn.responseId,
          item_id: this._turn.itemId,
          delta: content.outputTranscription.text
        });
      }
    }

    if (content.interrupted) this._cancelTurn('cancelled', 'turn_detected');

    if (content.turnComplete) {
      if (this._turn.active) {
        this._emitClient({ type: 'response.done', response: { id: this._turn.responseId, status: 'completed' } });
      } else if (this._userSpeaking) {
        // The model chose not to answer: still deliver the transcript so the skill can decide.
        this._closeUserTurn();
        this._unansweredTranscript = this._lastTranscript;
      }
      this._resetTurn();
    }
  }

  _startModelTurn() {
    if (this._turn.active || this._turn.dropping) return;
    this._turn.active = true;
    this._turn.responseId = `gl_resp_${++this._seq}`;
    this._turn.itemId = `gl_item_${this._seq}`;
    const spoken = this._userSpeaking;
    if (spoken) this._emitClient({ type: 'input_audio_buffer.speech_stopped' });
    this._emitClient({ type: 'response.created', response: { id: this._turn.responseId } });
    if (spoken) this._closeUserTurn();
  }

  _closeUserTurn() {
    if (!this._userSpeaking) return;
    if (!this._turn.active) this._emitClient({ type: 'input_audio_buffer.speech_stopped' });
    this._lastTranscript = this._inputText.trim();
    this._emitClient({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `gl_user_${this._seq}`,
      transcript: this._lastTranscript
    });
    this._userSpeaking = false;
    this._inputText = '';
  }

  _cancelTurn(status, reason, { deferred = false } = {}) {
    if (!this._turn.active) return;
    const event = { type: 'response.done', response: { id: this._turn.responseId, status, status_details: { reason } } };
    this._turn.active = false;
    this._turn.dropping = true; // ignore the rest of this model turn until turnComplete
    // A cancel issued from inside the skill's own handler must not re-enter it synchronously.
    if (deferred) setImmediate(() => this._emitClient(event));
    else this._emitClient(event);
  }

  _resetTurn() {
    this._turn = { active: false, dropping: false, responseId: null, itemId: null };
    this._userSpeaking = false;
    this._inputText = '';
  }

  _emitClient(event) {
    this.emit('message', { type: 'message', data: JSON.stringify(event) });
  }

  _sendServer(payload) {
    if (this.readyState !== WebSocket.OPEN) return;
    try { this._transport.send(JSON.stringify(payload)); } catch (_) {}
  }
}

module.exports = { GeminiLiveSocket, toGeminiSchema, toGeminiTools, buildSetup, LIVE_ENDPOINT };
