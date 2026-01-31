'use strict';

const utils = require('@iobroker/adapter-core');
const WhisperTranscriber = require('./lib/whisperTranscriber');
const LlmBackend = require('./lib/llmBackend');
const TemplateEngine = require('./lib/templateEngine');
const ActionExecutor = require('./lib/actionExecutor');
const AudioServer = require('./lib/audioServer');

class AiAssistant extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'ai-assistant' });

        this.whisper = null;
        this.llm = null;
        this.templateEngine = null;
        this.actionExecutor = null;
        this.audioServer = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────────

    async onReady() {
        const cfg = this.config || {};

        // ── States ───────────────────────────────────────────────────
        await this._createStates();

        // ── Whisper ──────────────────────────────────────────────────
        this.whisper = new WhisperTranscriber({
            log: this.log,
            model: cfg.whisperModel || 'base',
            language: cfg.whisperLanguage || 'de',
        });

        const whisperOk = await this.whisper.init();
        await this.setStateAsync('info.whisperAvailable', whisperOk, true);

        // ── LLM Backend ──────────────────────────────────────────────
        this.llm = new LlmBackend({
            log: this.log,
            backend: cfg.llmBackend || 'ollama',
            config: cfg,
        });

        const llmOk = await this.llm.ping();
        await this.setStateAsync('info.llmAvailable', llmOk, true);
        this.log.info(`LLM backend: ${cfg.llmBackend} (${llmOk ? 'connected' : 'offline'})`);

        // ── Template Engine ──────────────────────────────────────────
        this.templateEngine = new TemplateEngine({ log: this.log, adapter: this });
        this.templateEngine.loadTemplates(cfg.templates || []);

        // ── Action Executor ──────────────────────────────────────────
        this.actionExecutor = new ActionExecutor({
            log: this.log,
            adapter: this,
            templateEngine: this.templateEngine,
        });

        // ── Audio Server ─────────────────────────────────────────────
        const audioPort = cfg.audioPort || 8089;
        this.audioServer = new AudioServer({
            log: this.log,
            port: audioPort,
            onAudio: (buffer, format, deviceId) => this._processAudio(buffer, format, deviceId),
        });

        try {
            await this.audioServer.start();
        } catch (e) {
            this.log.error(`Audio server failed to start: ${e.message}`);
        }

        // ── Subscribe ────────────────────────────────────────────────
        this.subscribeStates('*');

        await this.setStateAsync('info.connection', true, true);
        this.log.info('AI Assistant started');
    }

    async onUnload(callback) {
        try {
            if (this.audioServer) await this.audioServer.stop();
            if (this.whisper) this.whisper.destroy();
            await this.setStateAsync('info.connection', false, true);
        } catch (_) {}
        callback();
    }

    // ─────────────────────────────────────────────────────────────────
    //  Core pipeline: Audio → Transcription → Template → LLM → Action
    // ─────────────────────────────────────────────────────────────────

    /**
     * Process incoming audio.
     * @param {Buffer} audioBuffer
     * @param {string} format
     * @param {string} deviceId
     * @returns {Promise<object>}
     */
    async _processAudio(audioBuffer, format, deviceId) {
        const startTime = Date.now();

        // Step 1: Transcribe
        if (!this.whisper) throw new Error('Whisper not available');
        const transcription = await this.whisper.transcribe(audioBuffer, format);

        if (!transcription.text) {
            return { step: 'transcription', text: '', response: '(Kein Text erkannt)' };
        }

        await this.setStateAsync('lastTranscription', transcription.text, true);
        await this.setStateAsync('lastDevice', deviceId, true);
        this.log.info(`[${deviceId}] Transcribed: "${transcription.text}"`);

        // Step 2: Process text through LLM pipeline
        const result = await this._processText(transcription.text);
        result.transcription = transcription.text;
        result.device = deviceId;
        result.processingTimeMs = Date.now() - startTime;

        return result;
    }

    /**
     * Process text input (from transcription or direct text input).
     * @param {string} userText
     * @returns {Promise<object>}
     */
    async _processText(userText) {
        // Step 2: Match template
        const template = this.templateEngine.matchTemplate(userText);

        if (!template) {
            // No template matched — use generic response
            const response = await this.llm.complete(
                'Du bist ein Smart-Home-Assistent. Antworte kurz und hilfreich auf Deutsch.',
                userText,
            );
            await this.setStateAsync('lastResponse', response.text, true);
            return { step: 'generic', template: null, response: response.text };
        }

        this.log.info(`Template matched: ${template.id} (${template.name})`);
        await this.setStateAsync('lastTemplate', template.id, true);

        // Step 3: Build context-enriched prompt
        const systemPrompt = await this.templateEngine.buildSystemPrompt(template);

        // Step 4: LLM completion
        const response = await this.llm.complete(systemPrompt, userText);
        this.log.info(`LLM response: "${response.text.substring(0, 100)}..."`);

        // Step 5: Execute actions if any
        const actionResult = await this.actionExecutor.execute(response.text, template);

        if (actionResult.executed.length > 0) {
            this.log.info(`Executed ${actionResult.executed.length} action(s)`);
        }
        if (actionResult.denied.length > 0) {
            this.log.warn(`Denied ${actionResult.denied.length} action(s)`);
        }

        await this.setStateAsync('lastResponse', actionResult.text, true);

        return {
            step: 'template',
            template: template.id,
            response: actionResult.text,
            actions: {
                executed: actionResult.executed,
                denied: actionResult.denied,
            },
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  State changes
    // ─────────────────────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        const localId = id.replace(`${this.namespace}.`, '');

        // Manual text input
        if (localId === 'textInput' && state.val) {
            const text = String(state.val);
            this.log.info(`Text input: "${text}"`);
            try {
                const result = await this._processText(text);
                await this.setStateAsync('lastResponse', result.response, true);
            } catch (e) {
                this.log.warn(`Text processing error: ${e.message}`);
                await this.setStateAsync('lastResponse', `Fehler: ${e.message}`, true);
            }
            await this.setStateAsync('textInput', '', true);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Admin messages
    // ─────────────────────────────────────────────────────────────────

    async onMessage(msg) {
        if (!msg || !msg.command) return;

        switch (msg.command) {
            case 'testLlm': {
                try {
                    const ok = await this.llm.ping();
                    this.sendTo(msg.from, msg.command, {
                        result: ok ? 'Verbindung erfolgreich' : 'Nicht erreichbar',
                    }, msg.callback);
                } catch (e) {
                    this.sendTo(msg.from, msg.command, { error: e.message }, msg.callback);
                }
                break;
            }
            case 'testWhisper': {
                this.sendTo(msg.from, msg.command, {
                    result: this.whisper?._ready ? 'Whisper verfügbar' : 'Whisper nicht installiert',
                }, msg.callback);
                break;
            }
            case 'getTemplates': {
                const templates = this.templateEngine ? this.templateEngine.getTemplates() : [];
                this.sendTo(msg.from, msg.command, templates, msg.callback);
                break;
            }
            default:
                if (msg.callback) {
                    this.sendTo(msg.from, msg.command, { error: 'Unknown command' }, msg.callback);
                }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────────

    async _createStates() {
        const states = {
            'info.connection': { type: 'boolean', role: 'indicator.connected', name: 'Adapter connected', write: false },
            'info.whisperAvailable': { type: 'boolean', role: 'indicator', name: 'Whisper available', write: false },
            'info.llmAvailable': { type: 'boolean', role: 'indicator', name: 'LLM backend available', write: false },
            'textInput': { type: 'string', role: 'text', name: 'Text input (manual)', write: true, def: '' },
            'lastTranscription': { type: 'string', role: 'text', name: 'Last transcribed text', write: false, def: '' },
            'lastResponse': { type: 'string', role: 'text', name: 'Last LLM response', write: false, def: '' },
            'lastTemplate': { type: 'string', role: 'text', name: 'Last matched template ID', write: false, def: '' },
            'lastDevice': { type: 'string', role: 'text', name: 'Last audio device ID', write: false, def: '' },
        };

        for (const [id, common] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { read: true, write: false, ...common },
                native: {},
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
//  Startup
// ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
    new AiAssistant();
} else {
    module.exports = (options) => new AiAssistant(options);
}
