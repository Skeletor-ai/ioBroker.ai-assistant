'use strict';

const http = require('http');
const https = require('https');

/**
 * Unified LLM backend interface.
 * Supports: Ollama (local), OpenAI API, Anthropic API.
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
     * Send a prompt to the LLM and return the response.
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

    // ─── Ollama ──────────────────────────────────────────────────────

    async _ollamaComplete(systemPrompt, userMessage, maxTokens, temperature) {
        const body = JSON.stringify({
            model: this.config.ollamaModel || 'phi3:mini',
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

    // ─── OpenAI ──────────────────────────────────────────────────────

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

    // ─── Anthropic ───────────────────────────────────────────────────

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
