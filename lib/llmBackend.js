'use strict';

const http = require('http');
const https = require('https');

/**
 * Unified LLM backend interface.
 * Supports: Ollama (local), OpenAI API, Anthropic API.
 * Optional tool calling for structured action execution.
 */
class LlmBackend {
    /**
     * @param {object} opts
     * @param {object} opts.log
     * @param {string} opts.backend - 'ollama' | 'openai' | 'anthropic'
     * @param {object} opts.config - Backend-specific config
     */
    constructor({ log, backend, config }) {
        this.log = log;
        this.backend = backend;
        this.config = config;
    }

    /**
     * Send a prompt to the LLM and return the response (no tools).
     * @param {string} systemPrompt
     * @param {string} userMessage
     * @param {object} [options]
     * @param {number} [options.maxTokens=1000]
     * @param {number} [options.temperature=0.7]
     * @returns {Promise<{text: string, usage: object}>}
     */
    async complete(systemPrompt, userMessage, options = {}) {
        const maxTokens = options.maxTokens || 1000;
        const temperature = options.temperature ?? 0.7;

        switch (this.backend) {
            case 'ollama':
                return this._ollamaComplete(systemPrompt, userMessage, maxTokens, temperature);
            case 'openai':
                return this._openaiComplete(systemPrompt, userMessage, maxTokens, temperature);
            case 'anthropic':
                return this._anthropicComplete(systemPrompt, userMessage, maxTokens, temperature);
            default:
                throw new Error(`Unknown LLM backend: ${this.backend}`);
        }
    }

    /**
     * Send a prompt with tool definitions. Executes tool calls in a loop
     * until the LLM produces a final text response.
     * @param {string} systemPrompt
     * @param {string} userMessage
     * @param {object[]} tools - Tool definitions (OpenAI format)
     * @param {function} toolExecutor - async (name, args) => result string
     * @param {object} [options]
     * @param {number} [options.maxTokens=1000]
     * @param {number} [options.temperature=0.7]
     * @param {number} [options.maxToolRounds=5]
     * @returns {Promise<{text: string, usage: object, toolCalls: object[]}>}
     */
    async completeWithTools(systemPrompt, userMessage, tools, toolExecutor, options = {}) {
        const maxTokens = options.maxTokens || 1000;
        const temperature = options.temperature ?? 0.7;
        const maxRounds = options.maxToolRounds || 5;

        switch (this.backend) {
            case 'ollama':
                return this._ollamaToolLoop(systemPrompt, userMessage, tools, toolExecutor, maxTokens, temperature, maxRounds);
            case 'openai':
                return this._openaiToolLoop(systemPrompt, userMessage, tools, toolExecutor, maxTokens, temperature, maxRounds);
            case 'anthropic':
                return this._anthropicToolLoop(systemPrompt, userMessage, tools, toolExecutor, maxTokens, temperature, maxRounds);
            default:
                throw new Error(`Unknown LLM backend: ${this.backend}`);
        }
    }

    /**
     * Check if the backend is reachable.
     * @returns {Promise<boolean>}
     */
    async ping() {
        try {
            switch (this.backend) {
                case 'ollama': {
                    const resp = await this._httpRequest('GET', `${this.config.ollamaUrl}/api/tags`);
                    return resp.statusCode === 200;
                }
                case 'openai':
                    return !!this.config.openaiApiKey;
                case 'anthropic':
                    return !!this.config.anthropicApiKey;
                default:
                    return false;
            }
        } catch (e) {
            this.log.debug(`LLM ping failed: ${e.message}`);
            return false;
        }
    }

    // ─── Ollama (no tools) ───────────────────────────────────────────

    async _ollamaComplete(systemPrompt, userMessage, maxTokens, temperature) {
        const body = JSON.stringify({
            model: this.config.ollamaModel || 'qwen3-vl:4b',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            stream: false,
            options: { temperature, num_predict: maxTokens },
        });

        const resp = await this._httpRequest('POST', `${this.config.ollamaUrl}/api/chat`, body, {
            'Content-Type': 'application/json',
        });

        const data = JSON.parse(resp.body);
        return {
            text: data.message?.content || '',
            usage: {
                prompt_tokens: data.prompt_eval_count || 0,
                completion_tokens: data.eval_count || 0,
            },
        };
    }

    // ─── Ollama (tool loop) ──────────────────────────────────────────
    //  Supports dual-model mode: a small tool model (e.g. functiongemma)
    //  handles function selection, then the main model generates the
    //  user-facing text response with context about executed actions.

    async _ollamaToolLoop(systemPrompt, userMessage, tools, toolExecutor, maxTokens, temperature, maxRounds) {
        const mainModel = this.config.ollamaModel || 'qwen3-vl:4b';
        const toolModel = this.config.ollamaToolModel || '';
        const useDualModel = toolModel && toolModel !== mainModel;

        if (useDualModel) {
            this.log.info(`Dual-model mode: tools → ${toolModel}, response → ${mainModel}`);
        }

        const activeModel = useDualModel ? toolModel : mainModel;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];
        const allToolCalls = [];
        let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

        // ── Phase 1: Tool calling loop (tool model or main model) ────
        for (let round = 0; round < maxRounds; round++) {
            const body = JSON.stringify({
                model: activeModel,
                messages,
                tools,
                stream: false,
                options: { temperature, num_predict: maxTokens },
            });

            const resp = await this._httpRequest('POST', `${this.config.ollamaUrl}/api/chat`, body, {
                'Content-Type': 'application/json',
            });

            const data = JSON.parse(resp.body);
            totalUsage.prompt_tokens += data.prompt_eval_count || 0;
            totalUsage.completion_tokens += data.eval_count || 0;

            const msg = data.message || {};
            const calls = msg.tool_calls || [];

            if (calls.length === 0) {
                if (!useDualModel) {
                    // Single model — its text response is the final answer
                    return { text: msg.content || '', usage: totalUsage, toolCalls: allToolCalls };
                }
                // Dual model, no tools called — fall through to Phase 2
                break;
            }

            // Append assistant message with tool calls
            messages.push(msg);

            // Execute each tool call and append results
            for (const call of calls) {
                const fn = call.function || {};
                const name = fn.name;
                const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {});

                this.log.debug(`Tool call [${round}]: ${name}(${JSON.stringify(args)})`);
                allToolCalls.push({ name, arguments: args });

                let result;
                try {
                    result = await toolExecutor(name, args);
                } catch (e) {
                    result = JSON.stringify({ error: e.message });
                }

                messages.push({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result) });
            }
        }

        // ── Phase 2: Response generation (main model, dual-model only) ──
        if (useDualModel) {
            // Build a summary of what happened for the main model
            const actionSummary = allToolCalls.length > 0
                ? allToolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')
                : 'keine Aktionen ausgeführt';

            const responsePrompt = `${systemPrompt}\n\n## Ausgeführte Aktionen\n${actionSummary}\n\nAntworte dem Benutzer kurz und natürlich auf Deutsch. Bestätige was du getan hast.`;

            this.log.debug(`Dual-model: generating response with ${mainModel}`);
            const respBody = JSON.stringify({
                model: mainModel,
                messages: [
                    { role: 'system', content: responsePrompt },
                    { role: 'user', content: userMessage },
                ],
                stream: false,
                options: { temperature, num_predict: maxTokens },
            });

            const resp = await this._httpRequest('POST', `${this.config.ollamaUrl}/api/chat`, respBody, {
                'Content-Type': 'application/json',
            });

            const data = JSON.parse(resp.body);
            totalUsage.prompt_tokens += data.prompt_eval_count || 0;
            totalUsage.completion_tokens += data.eval_count || 0;

            return { text: data.message?.content || '', usage: totalUsage, toolCalls: allToolCalls };
        }

        // Max rounds hit (single model) — return whatever we have
        this.log.warn(`Tool calling: max rounds (${maxRounds}) reached`);
        return { text: '(Max Tool-Runden erreicht)', usage: totalUsage, toolCalls: allToolCalls };
    }

    // ─── OpenAI (no tools) ───────────────────────────────────────────

    async _openaiComplete(systemPrompt, userMessage, maxTokens, temperature) {
        const body = JSON.stringify({
            model: this.config.openaiModel || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            max_tokens: maxTokens,
            temperature,
        });

        const resp = await this._httpRequest('POST', 'https://api.openai.com/v1/chat/completions', body, {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.openaiApiKey}`,
        });

        const data = JSON.parse(resp.body);
        return {
            text: data.choices?.[0]?.message?.content || '',
            usage: data.usage || {},
        };
    }

    // ─── OpenAI (tool loop) ──────────────────────────────────────────

    async _openaiToolLoop(systemPrompt, userMessage, tools, toolExecutor, maxTokens, temperature, maxRounds) {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];
        const allToolCalls = [];
        let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

        for (let round = 0; round < maxRounds; round++) {
            const body = JSON.stringify({
                model: this.config.openaiModel || 'gpt-4o-mini',
                messages,
                tools,
                max_tokens: maxTokens,
                temperature,
            });

            const resp = await this._httpRequest('POST', 'https://api.openai.com/v1/chat/completions', body, {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.openaiApiKey}`,
            });

            const data = JSON.parse(resp.body);
            const usage = data.usage || {};
            totalUsage.prompt_tokens += usage.prompt_tokens || 0;
            totalUsage.completion_tokens += usage.completion_tokens || 0;

            const choice = data.choices?.[0] || {};
            const msg = choice.message || {};
            const calls = msg.tool_calls || [];

            if (choice.finish_reason !== 'tool_calls' || calls.length === 0) {
                // Final text response
                return { text: msg.content || '', usage: totalUsage, toolCalls: allToolCalls };
            }

            // Append the assistant message (with tool_calls)
            messages.push(msg);

            // Execute each tool call
            for (const call of calls) {
                const name = call.function?.name;
                const args = JSON.parse(call.function?.arguments || '{}');

                this.log.debug(`Tool call [${round}]: ${name}(${JSON.stringify(args)})`);
                allToolCalls.push({ name, arguments: args });

                let result;
                try {
                    result = await toolExecutor(name, args);
                } catch (e) {
                    result = JSON.stringify({ error: e.message });
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }
        }

        this.log.warn(`Tool calling: max rounds (${maxRounds}) reached`);
        return { text: '(Max Tool-Runden erreicht)', usage: totalUsage, toolCalls: allToolCalls };
    }

    // ─── Anthropic (no tools) ────────────────────────────────────────

    async _anthropicComplete(systemPrompt, userMessage, maxTokens, temperature) {
        const body = JSON.stringify({
            model: this.config.anthropicModel || 'claude-sonnet-4-20250514',
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [
                { role: 'user', content: userMessage },
            ],
            temperature,
        });

        const resp = await this._httpRequest('POST', 'https://api.anthropic.com/v1/messages', body, {
            'Content-Type': 'application/json',
            'x-api-key': this.config.anthropicApiKey,
            'anthropic-version': '2023-06-01',
        });

        const data = JSON.parse(resp.body);
        return {
            text: data.content?.[0]?.text || '',
            usage: data.usage || {},
        };
    }

    // ─── Anthropic (tool loop) ───────────────────────────────────────

    async _anthropicToolLoop(systemPrompt, userMessage, tools, toolExecutor, maxTokens, temperature, maxRounds) {
        // Convert OpenAI-format tools to Anthropic format
        const anthropicTools = tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
        }));

        const messages = [
            { role: 'user', content: userMessage },
        ];
        const allToolCalls = [];
        let totalUsage = { input_tokens: 0, output_tokens: 0 };

        for (let round = 0; round < maxRounds; round++) {
            const body = JSON.stringify({
                model: this.config.anthropicModel || 'claude-sonnet-4-20250514',
                max_tokens: maxTokens,
                system: systemPrompt,
                messages,
                tools: anthropicTools,
                temperature,
            });

            const resp = await this._httpRequest('POST', 'https://api.anthropic.com/v1/messages', body, {
                'Content-Type': 'application/json',
                'x-api-key': this.config.anthropicApiKey,
                'anthropic-version': '2023-06-01',
            });

            const data = JSON.parse(resp.body);
            const usage = data.usage || {};
            totalUsage.input_tokens += usage.input_tokens || 0;
            totalUsage.output_tokens += usage.output_tokens || 0;

            const content = data.content || [];
            const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
            const textBlocks = content.filter((b) => b.type === 'text');

            if (data.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
                // Final text response
                const text = textBlocks.map((b) => b.text).join('\n');
                return { text, usage: totalUsage, toolCalls: allToolCalls };
            }

            // Append assistant message (full content)
            messages.push({ role: 'assistant', content });

            // Execute tool calls and build tool_result blocks
            const toolResults = [];
            for (const block of toolUseBlocks) {
                const name = block.name;
                const args = block.input || {};

                this.log.debug(`Tool call [${round}]: ${name}(${JSON.stringify(args)})`);
                allToolCalls.push({ name, arguments: args });

                let result;
                try {
                    result = await toolExecutor(name, args);
                } catch (e) {
                    result = JSON.stringify({ error: e.message });
                }

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }

            messages.push({ role: 'user', content: toolResults });
        }

        this.log.warn(`Tool calling: max rounds (${maxRounds}) reached`);
        return { text: '(Max Tool-Runden erreicht)', usage: totalUsage, toolCalls: allToolCalls };
    }

    // ─── HTTP helper ─────────────────────────────────────────────────

    _httpRequest(method, url, body = null, headers = {}) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const client = parsed.protocol === 'https:' ? https : http;

            const opts = {
                method,
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                headers,
                timeout: 120000,
            };

            if (body) {
                opts.headers['Content-Length'] = Buffer.byteLength(body);
            }

            const req = client.request(opts, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
                });
            });

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = LlmBackend;
