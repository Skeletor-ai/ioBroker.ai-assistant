'use strict';

const utils = require('@iobroker/adapter-core');
const WhisperTranscriber = require('./lib/whisperTranscriber');
const LlmBackend = require('./lib/llmBackend');
const RagClient = require('./lib/ragClient');
const RagManager = require('./lib/ragManager');
const TemplateEngine = require('./lib/templateEngine');
const ActionExecutor = require('./lib/actionExecutor');
const AudioServer = require('./lib/audioServer');
const TtsEngine = require('./lib/ttsEngine');
const EnumResolver = require('./lib/enumResolver');

class AiAssistant extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'ai-assistant' });

        this.whisper = null;
        this.llm = null;
        this.rag = null;
        this.ragManager = null;
        this.templateEngine = null;
        this.enumResolver = null;
        this.actionExecutor = null;
        this.audioServer = null;
        this.tts = null;

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

        // ── RAG (Retrieval Augmented Generation) ─────────────────────
        if (cfg.ragEnabled) {
            const ragPort = cfg.ragPort || 8321;
            const ragManaged = cfg.ragManaged === true; // default: false (external RAG server)
            const ragUrl = cfg.ragUrl || `http://127.0.0.1:${ragPort}`;
            let ragOk = false;

            if (ragManaged) {
                // Adapter starts and manages its own RAG server process
                this.ragManager = new RagManager({
                    log: this.log,
                    port: ragPort,
                    onStatusChange: async (status) => {
                        this.log.info(`RAG status: ${status}`);
                        try {
                            await this.setStateAsync('info.ragStatus', status, true);
                            await this.setStateAsync('info.ragAvailable', status === 'running', true);
                        } catch (_) {}
                    },
                });

                ragOk = await this.ragManager.start();
            } else {
                // External RAG server — just connect to it
                this.log.info(`RAG: Connecting to external service at ${ragUrl}`);
                await this.setStateAsync('info.ragStatus', 'external', true);
            }

            this.rag = new RagClient({
                log: this.log,
                url: ragManaged && this.ragManager ? this.ragManager.url : ragUrl,
                topK: cfg.ragTopK || 5,
                language: cfg.ragLanguage || '',
                timeoutMs: cfg.ragTimeoutMs || 5000,
            });

            ragOk = await this.rag.ping();
            await this.setStateAsync('info.ragAvailable', ragOk, true);
        } else {
            await this.setStateAsync('info.ragAvailable', false, true);
            await this.setStateAsync('info.ragStatus', 'disabled', true);
        }

        // ── Template Engine ──────────────────────────────────────────
        this.templateEngine = new TemplateEngine({ log: this.log, adapter: this });
        this.templateEngine.loadTemplates(cfg.templates || []);

        // ── Enum Resolver (rooms & functions) ────────────────────────
        this.enumResolver = new EnumResolver({ log: this.log, adapter: this });
        await this.enumResolver.load();

        // ── Action Executor ──────────────────────────────────────────
        this.actionExecutor = new ActionExecutor({
            log: this.log,
            adapter: this,
            templateEngine: this.templateEngine,
            enumResolver: this.enumResolver,
        });

        // ── TTS Engine ───────────────────────────────────────────────
        if (cfg.ttsEnabled) {
            this.tts = new TtsEngine({
                log: this.log,
                backend: cfg.ttsBackend || 'piper',
                config: cfg,
            });

            const ttsOk = await this.tts.init();
            await this.setStateAsync('info.ttsAvailable', ttsOk, true);
            this.log.info(`TTS engine: ${cfg.ttsBackend} (${ttsOk ? 'available' : 'not found'})`);
        } else {
            await this.setStateAsync('info.ttsAvailable', false, true);
        }

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
            if (this.ragManager) await this.ragManager.stop();
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

        // TTS: synthesize response text if enabled
        if (this.tts && this.tts.available && result.response) {
            try {
                const ttsResult = await this.tts.synthesize(result.response);
                result.audioBase64 = ttsResult.audioBuffer.toString('base64');
                result.audioFormat = ttsResult.format;
                result.audioSampleRate = ttsResult.sampleRate;
            } catch (e) {
                this.log.warn(`TTS synthesis failed: ${e.message}`);
            }
        }

        return result;
    }

    /**
     * Process text input (from transcription or direct text input).
     * @param {string} userText
     * @returns {Promise<object>}
     */
    async _processText(userText) {
        const cfg = this.config || {};

        // Step 1: Try enum-based resolution (rooms + functions)
        if (this.enumResolver && this.enumResolver.rooms.size > 0) {
            const enumResult = await this._processWithEnums(userText);
            if (enumResult) return enumResult;
        }

        // Step 2: Match template
        const template = this.templateEngine.matchTemplate(userText);

        if (!template) {
            // No template matched — use generic response with RAG context
            let systemPrompt = 'Du bist ein Smart-Home-Assistent. Antworte kurz und hilfreich auf Deutsch.';

            // Add enum summary so LLM knows about available rooms/functions
            if (this.enumResolver) {
                const summary = this.enumResolver.getSummary();
                if (summary) {
                    systemPrompt += '\n\n' + summary;
                }
            }

            if (this.rag && this.rag.available) {
                systemPrompt = await this.rag.enrichPrompt(systemPrompt, userText);
                this.log.debug('RAG context injected into generic prompt');
            }

            const response = await this.llm.complete(systemPrompt, userText);
            await this.setStateAsync('lastResponse', response.text, true);
            return { step: 'generic', template: null, response: response.text, ragEnriched: !!(this.rag && this.rag.available) };
        }

        this.log.info(`Template matched: ${template.id} (${template.name})`);
        await this.setStateAsync('lastTemplate', template.id, true);

        // Step 3: Build context-enriched prompt (template + RAG)
        let systemPrompt = await this.templateEngine.buildSystemPrompt(template);

        if (this.rag && this.rag.available) {
            systemPrompt = await this.rag.enrichPrompt(systemPrompt, userText);
            this.log.debug('RAG context injected into template prompt');
        }

        // ── Tool Calling Mode ────────────────────────────────────────
        if (cfg.toolCallingEnabled && template.allowedActions?.length > 0) {
            this.log.info('Using tool calling mode');

            const tools = this.actionExecutor.buildToolDefinitions(template);
            const toolExecutor = this.actionExecutor.createToolExecutor(template);

            const response = await this.llm.completeWithTools(
                systemPrompt,
                userText,
                tools,
                toolExecutor,
                { maxTokens: cfg.maxContextTokens || 1000, maxToolRounds: cfg.maxToolRounds || 5 },
            );

            this.log.info(`LLM response (tools): "${response.text.substring(0, 100)}..."`);
            this.log.info(`Tool calls: ${response.toolCalls?.length || 0}`);

            if (toolExecutor._executed.length > 0) {
                this.log.info(`Executed ${toolExecutor._executed.length} action(s) via tool calling`);
            }
            if (toolExecutor._denied.length > 0) {
                this.log.warn(`Denied ${toolExecutor._denied.length} action(s) via tool calling`);
            }

            await this.setStateAsync('lastResponse', response.text, true);

            return {
                step: 'template-tools',
                template: template.id,
                response: response.text,
                toolCalls: response.toolCalls || [],
                actions: {
                    executed: toolExecutor._executed,
                    denied: toolExecutor._denied,
                },
            };
        }

        // ── Legacy Mode (JSON parsing) ──────────────────────────────
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
    //  Enum-based processing
    // ─────────────────────────────────────────────────────────────────

    /**
     * Try to process user text using enum-based resolution.
     * Returns null if no room/function could be identified.
     * @param {string} userText
     * @returns {Promise<object|null>}
     */
    async _processWithEnums(userText) {
        const cfg = this.config || {};
        const lower = userText.toLowerCase();

        // Try to identify room and function from user text
        let matchedRoom = null;
        let matchedFunction = null;

        for (const [, room] of this.enumResolver.rooms) {
            if (lower.includes(room.name.toLowerCase())) {
                matchedRoom = room.name;
                break;
            }
            // Also check enum ID suffix (e.g. "wohnzimmer" from "enum.rooms.wohnzimmer")
            const suffix = room.id.split('.').pop().toLowerCase();
            if (lower.includes(suffix)) {
                matchedRoom = room.name;
                break;
            }
        }

        for (const [, func] of this.enumResolver.functions) {
            if (lower.includes(func.name.toLowerCase())) {
                matchedFunction = func.name;
                break;
            }
            const suffix = func.id.split('.').pop().toLowerCase();
            if (lower.includes(suffix)) {
                matchedFunction = func.name;
                break;
            }
        }

        // Need at least one match to proceed
        if (!matchedRoom && !matchedFunction) return null;

        this.log.info(`Enum match: room="${matchedRoom || '-'}", function="${matchedFunction || '-'}"`);

        // Find matching states
        const stateIds = this.enumResolver.findStates({
            room: matchedRoom,
            function: matchedFunction,
        });

        if (stateIds.length === 0) {
            this.log.info('Enum match found but no states in intersection');
            return null; // Fall through to template/generic
        }

        this.log.info(`Enum resolved ${stateIds.length} state(s)`);

        // Build context with actual state values
        const stateContext = await this.enumResolver.buildStateContext(stateIds);
        const writableIds = await this.enumResolver.getWritableStates(stateIds);

        // Build system prompt with enum context
        let systemPrompt = `Du bist ein Smart-Home-Assistent. Antworte kurz und präzise auf Deutsch.

## Gefundene Geräte
${stateContext}

## Anweisungen
- Wenn der Nutzer ein Gerät steuern will, antworte mit einer JSON-Aktion:
  {"stateId": "<exakte State-ID von oben>", "value": <Wert>}
- Verwende NUR die oben gelisteten State-IDs (exakte Schreibweise).
- Für Schalter: value = true (ein) oder false (aus)
- Für Dimmer: value = 0-100
- Für Thermostate: value = Temperatur als Zahl
- Wenn du den Zustand nur abfragst, antworte mit dem aktuellen Wert.`;

        // Add writable states info
        if (writableIds.length > 0) {
            systemPrompt += `\n\n## Schreibbare States\n${writableIds.map((id) => '- `' + id + '`').join('\n')}`;
        }

        // RAG context if available
        if (this.rag && this.rag.available) {
            systemPrompt = await this.rag.enrichPrompt(systemPrompt, userText);
            this.log.debug('RAG context injected into enum prompt');
        }

        // Tool calling mode
        if (cfg.toolCallingEnabled) {
            this.log.info('Enum + tool calling mode');

            // Build dynamic template for permission checks
            const dynamicTemplate = {
                id: '_enum_dynamic',
                allowedActions: writableIds.map((id) => ({ pattern: id, label: 'enum-resolved' })),
            };

            const tools = this.actionExecutor.buildToolDefinitions(dynamicTemplate);
            const toolExecutor = this.actionExecutor.createToolExecutor(dynamicTemplate);

            const response = await this.llm.completeWithTools(
                systemPrompt,
                userText,
                tools,
                toolExecutor,
                { maxTokens: cfg.maxContextTokens || 1000, maxToolRounds: cfg.maxToolRounds || 5 },
            );

            await this.setStateAsync('lastResponse', response.text, true);

            return {
                step: 'enum-tools',
                room: matchedRoom,
                function: matchedFunction,
                stateIds,
                response: response.text,
                actions: {
                    executed: toolExecutor._executed,
                    denied: toolExecutor._denied,
                },
            };
        }

        // Legacy mode (JSON parsing)
        const response = await this.llm.complete(systemPrompt, userText);
        this.log.info(`LLM response (enum): "${response.text.substring(0, 100)}..."`);

        // Parse and execute actions — use exact state ID matching for permission
        const actionResult = await this._executeEnumActions(response.text, writableIds);

        await this.setStateAsync('lastResponse', actionResult.text, true);

        return {
            step: 'enum',
            room: matchedRoom,
            function: matchedFunction,
            stateIds,
            response: actionResult.text,
            actions: {
                executed: actionResult.executed,
                denied: actionResult.denied,
            },
        };
    }

    /**
     * Execute actions from LLM response using enum-resolved writable states.
     * @param {string} llmResponse
     * @param {string[]} writableIds - Allowed state IDs
     * @returns {Promise<{executed: object[], denied: object[], text: string}>}
     */
    async _executeEnumActions(llmResponse, writableIds) {
        const executed = [];
        const denied = [];
        const allowedSet = new Set(writableIds);

        // Parse JSON actions from response
        const actions = [];
        const singleMatches = llmResponse.match(/\{"stateId":\s*"[^"]+",\s*"value":\s*[^}]+\}/g);
        if (singleMatches) {
            for (const match of singleMatches) {
                try { actions.push(JSON.parse(match)); } catch (_) {}
            }
        }

        for (const action of actions) {
            if (!action.stateId || action.value === undefined) continue;

            if (!allowedSet.has(action.stateId)) {
                this.log.warn(`Enum action denied (not in resolved states): ${action.stateId}`);
                denied.push({ ...action, reason: 'Not in enum-resolved states' });
                continue;
            }

            try {
                const obj = await this.adapter.getForeignObjectAsync(action.stateId);
                if (!obj) {
                    denied.push({ ...action, reason: 'State not found' });
                    continue;
                }

                let value = action.value;
                const stateType = obj.common?.type;
                if (stateType === 'number') value = Number(value);
                else if (stateType === 'boolean') value = Boolean(value);
                else if (stateType === 'string') value = String(value);

                await this.adapter.setForeignStateAsync(action.stateId, { val: value, ack: false });
                this.log.info(`Enum action executed: ${action.stateId} = ${value}`);
                executed.push({ ...action, actualValue: value });
            } catch (e) {
                denied.push({ ...action, reason: e.message });
            }
        }

        return { executed, denied, text: llmResponse };
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
            case 'testRag': {
                try {
                    if (!this.rag) {
                        this.sendTo(msg.from, msg.command, { result: 'RAG nicht aktiviert (ragEnabled=false)' }, msg.callback);
                        break;
                    }
                    const ok = await this.rag.ping();
                    if (ok && msg.message?.query) {
                        const result = await this.rag.query(msg.message.query);
                        this.sendTo(msg.from, msg.command, {
                            result: `RAG verbunden, ${result?.sources?.length || 0} Ergebnisse`,
                            sources: result?.sources || [],
                        }, msg.callback);
                    } else {
                        this.sendTo(msg.from, msg.command, {
                            result: ok ? 'RAG Service verbunden' : 'RAG Service nicht erreichbar',
                        }, msg.callback);
                    }
                } catch (e) {
                    this.sendTo(msg.from, msg.command, { error: e.message }, msg.callback);
                }
                break;
            }
            case 'reindexRag': {
                try {
                    if (!this.ragManager) {
                        this.sendTo(msg.from, msg.command, { error: 'RAG nicht aktiviert' }, msg.callback);
                        break;
                    }
                    const stats = await this.ragManager.reindex();
                    // Reconnect RAG client after reindex
                    if (this.rag) await this.rag.ping();
                    this.sendTo(msg.from, msg.command, {
                        result: 'Re-Indexierung abgeschlossen',
                        stats,
                    }, msg.callback);
                } catch (e) {
                    this.sendTo(msg.from, msg.command, { error: e.message }, msg.callback);
                }
                break;
            }
            case 'getTemplates': {
                const templates = this.templateEngine ? this.templateEngine.getTemplates() : [];
                this.sendTo(msg.from, msg.command, templates, msg.callback);
                break;
            }
            case 'getEnums': {
                if (!this.enumResolver) {
                    this.sendTo(msg.from, msg.command, { error: 'EnumResolver not loaded' }, msg.callback);
                    break;
                }
                const rooms = [...this.enumResolver.rooms.values()].map((r) => ({ id: r.id, name: r.name, members: r.members.length }));
                const functions = [...this.enumResolver.functions.values()].map((f) => ({ id: f.id, name: f.name, members: f.members.length }));
                this.sendTo(msg.from, msg.command, { rooms, functions }, msg.callback);
                break;
            }
            case 'reloadEnums': {
                try {
                    await this.enumResolver.load();
                    this.sendTo(msg.from, msg.command, {
                        result: `Enums neu geladen: ${this.enumResolver.rooms.size} Räume, ${this.enumResolver.functions.size} Funktionen`,
                    }, msg.callback);
                } catch (e) {
                    this.sendTo(msg.from, msg.command, { error: e.message }, msg.callback);
                }
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
            'info.ttsAvailable': { type: 'boolean', role: 'indicator', name: 'TTS engine available', write: false },
            'info.ragAvailable': { type: 'boolean', role: 'indicator', name: 'RAG service available', write: false },
            'info.ragStatus': { type: 'string', role: 'text', name: 'RAG service status', write: false, def: 'disabled' },
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
