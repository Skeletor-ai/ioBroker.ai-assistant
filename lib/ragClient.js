'use strict';

const http = require('http');
const https = require('https');

/**
 * Lightweight client for the ioBroker RAG service.
 * Queries a local ChromaDB-backed REST API for relevant documentation context.
 */
class RagClient {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {string} [opts.url='http://localhost:8321'] - RAG service base URL
     * @param {number} [opts.topK=5] - Number of results to retrieve
     * @param {string} [opts.language] - Preferred language filter (en/de)
     * @param {number} [opts.timeoutMs=5000] - Request timeout
     */
    constructor({ log, url, topK, language, timeoutMs }) {
        this.log = log;
        this.url = (url || 'http://localhost:8321').replace(/\/+$/, '');
        this.topK = topK || 5;
        this.language = language || '';
        this.timeoutMs = timeoutMs || 5000;
        this._available = false;
    }

    /**
     * Check if the RAG service is reachable.
     * @returns {Promise<boolean>}
     */
    async ping() {
        try {
            const resp = await this._request('GET', `${this.url}/health`);
            this._available = resp.statusCode === 200;
            if (this._available) {
                const data = JSON.parse(resp.body);
                this.log.info(`RAG service connected: ${data.documents || '?'} documents indexed`);
            }
            return this._available;
        } catch (e) {
            this.log.debug(`RAG service not reachable: ${e.message}`);
            this._available = false;
            return false;
        }
    }

    /**
     * Query the RAG service for relevant context.
     * @param {string} question - User's question/input
     * @param {object} [options]
     * @param {number} [options.topK] - Override default topK
     * @param {string} [options.language] - Override default language
     * @param {string} [options.docType] - Filter by doc type (doc/code/api)
     * @returns {Promise<{context: string, sources: object[], prompt: string}|null>}
     */
    async query(question, options = {}) {
        if (!this._available) {
            // Try to reconnect silently
            await this.ping();
            if (!this._available) return null;
        }

        try {
            const body = JSON.stringify({
                question,
                top_k: options.topK || this.topK,
                language: options.language || this.language || undefined,
                doc_type: options.docType || undefined,
                include_prompt: true,
            });

            const resp = await this._request('POST', `${this.url}/query`, body, {
                'Content-Type': 'application/json',
            });

            if (resp.statusCode !== 200) {
                this.log.warn(`RAG query failed (${resp.statusCode}): ${resp.body}`);
                return null;
            }

            const data = JSON.parse(resp.body);
            this.log.debug(`RAG query: ${data.total_results} results in ${data.query_time_ms}ms`);

            return {
                context: data.context || '',
                sources: data.sources || [],
                prompt: data.prompt || '',
                queryTimeMs: data.query_time_ms || 0,
            };
        } catch (e) {
            this.log.warn(`RAG query error: ${e.message}`);
            this._available = false;
            return null;
        }
    }

    /**
     * Build an enriched system prompt by injecting RAG context.
     * @param {string} basePrompt - Original system prompt
     * @param {string} userText - User's question (for RAG query)
     * @returns {Promise<string>} - Enriched system prompt
     */
    async enrichPrompt(basePrompt, userText) {
        const result = await this.query(userText);
        if (!result || !result.context) {
            return basePrompt;
        }

        const sourceList = result.sources
            .map((s) => `  - ${s.file} (${s.type}, relevance: ${(s.relevance || 0).toFixed(2)})`)
            .join('\n');

        return `${basePrompt}

## ioBroker Documentation Context
The following documentation excerpts are relevant to the user's question.
Use this information to provide accurate, ioBroker-specific answers.

${result.context}

Sources:
${sourceList}`;
    }

    get available() {
        return this._available;
    }

    // ─── HTTP helper ─────────────────────────────────────────────────

    _request(method, url, body = null, headers = {}) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const client = parsed.protocol === 'https:' ? https : http;

            const opts = {
                method,
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                headers,
                timeout: this.timeoutMs,
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
            req.on('timeout', () => { req.destroy(); reject(new Error('RAG request timeout')); });

            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = RagClient;
