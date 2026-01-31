'use strict';

const { spawn } = require('child_process');

/**
 * Text-to-Speech engine.
 * Supports: Piper (local), Edge-TTS (online, free).
 */
class TtsEngine {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {string} opts.backend - 'piper' | 'edge-tts'
     * @param {object} opts.config - Backend-specific config
     */
    constructor({ log, backend, config }) {
        this.log = log;
        this.backend = backend || 'piper';
        this.config = config || {};
        this._available = false;
    }

    /**
     * Check if the configured TTS backend is available.
     * @returns {Promise<boolean>}
     */
    async init() {
        try {
            switch (this.backend) {
                case 'piper':
                    return await this._initPiper();
                case 'edge-tts':
                    return await this._initEdgeTts();
                default:
                    this.log.error(`Unknown TTS backend: ${this.backend}`);
                    return false;
            }
        } catch (e) {
            this.log.error(`TTS init failed: ${e.message}`);
            this._available = false;
            return false;
        }
    }

    /**
     * Synthesize text to audio.
     * @param {string} text - Text to synthesize
     * @returns {Promise<{audioBuffer: Buffer, format: string, sampleRate: number}>}
     */
    async synthesize(text) {
        if (!this._available) {
            throw new Error('TTS engine not available');
        }

        if (!text || !text.trim()) {
            throw new Error('Empty text');
        }

        // Sanitize text — remove characters that could break shell commands
        const sanitized = text.replace(/[`$\\]/g, '').replace(/"/g, '\\"');

        switch (this.backend) {
            case 'piper':
                return this._synthesizePiper(sanitized);
            case 'edge-tts':
                return this._synthesizeEdgeTts(sanitized);
            default:
                throw new Error(`Unknown TTS backend: ${this.backend}`);
        }
    }

    /**
     * Whether the engine is ready.
     * @returns {boolean}
     */
    get available() {
        return this._available;
    }

    // ─── Piper ───────────────────────────────────────────────────────

    async _initPiper() {
        try {
            const version = await this._exec('piper', ['--version']);
            const model = this.config.piperModel || 'de_DE-thorsten-high';
            this.log.info(`Piper TTS available: ${version.trim()} (model: ${model})`);
            this._available = true;
            return true;
        } catch (e) {
            this.log.warn('Piper not found. Install: pip3 install piper-tts  or download from https://github.com/rhasspy/piper');
            this._available = false;
            return false;
        }
    }

    async _synthesizePiper(text) {
        const model = this.config.piperModel || 'de_DE-thorsten-high';

        return new Promise((resolve, reject) => {
            const proc = spawn('piper', [
                '--model', model,
                '--output_file', '-',
            ], {
                timeout: 30000,
            });

            const chunks = [];
            let stderr = '';

            proc.stdout.on('data', (chunk) => chunks.push(chunk));
            proc.stderr.on('data', (d) => { stderr += d; });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Piper exit ${code}: ${stderr}`));
                    return;
                }
                const audioBuffer = Buffer.concat(chunks);
                if (audioBuffer.length === 0) {
                    reject(new Error('Piper produced no audio output'));
                    return;
                }
                resolve({
                    audioBuffer,
                    format: 'wav',
                    sampleRate: 22050,
                });
            });

            proc.on('error', (err) => reject(new Error(`Piper spawn failed: ${err.message}`)));

            // Feed text via stdin
            proc.stdin.write(text);
            proc.stdin.end();
        });
    }

    // ─── Edge-TTS ────────────────────────────────────────────────────

    async _initEdgeTts() {
        try {
            const version = await this._exec('edge-tts', ['--version']);
            const voice = this.config.edgeTtsVoice || 'de-DE-ConradNeural';
            this.log.info(`Edge-TTS available: ${version.trim()} (voice: ${voice})`);
            this._available = true;
            return true;
        } catch (e) {
            // edge-tts might not support --version, try --list-voices as fallback
            try {
                await this._exec('python3', ['-c', 'import edge_tts; print("ok")']);
                const voice = this.config.edgeTtsVoice || 'de-DE-ConradNeural';
                this.log.info(`Edge-TTS (Python module) available (voice: ${voice})`);
                this._available = true;
                return true;
            } catch (_) {
                this.log.warn('edge-tts not found. Install: pip3 install edge-tts');
                this._available = false;
                return false;
            }
        }
    }

    async _synthesizeEdgeTts(text) {
        const voice = this.config.edgeTtsVoice || 'de-DE-ConradNeural';

        return new Promise((resolve, reject) => {
            const proc = spawn('edge-tts', [
                '--text', text,
                '--voice', voice,
                '--write-media', '-',
            ], {
                timeout: 30000,
            });

            const chunks = [];
            let stderr = '';

            proc.stdout.on('data', (chunk) => chunks.push(chunk));
            proc.stderr.on('data', (d) => { stderr += d; });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`edge-tts exit ${code}: ${stderr}`));
                    return;
                }
                const audioBuffer = Buffer.concat(chunks);
                if (audioBuffer.length === 0) {
                    reject(new Error('edge-tts produced no audio output'));
                    return;
                }
                resolve({
                    audioBuffer,
                    format: 'mp3',
                    sampleRate: 24000,
                });
            });

            proc.on('error', (err) => reject(new Error(`edge-tts spawn failed: ${err.message}`)));
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /**
     * Execute a command and return stdout.
     * @param {string} cmd
     * @param {string[]} args
     * @param {number} [timeout=10000]
     * @returns {Promise<string>}
     * @private
     */
    _exec(cmd, args, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const proc = spawn(cmd, args, { timeout });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d) => { stdout += d; });
            proc.stderr.on('data', (d) => { stderr += d; });
            proc.on('close', (code) => {
                if (code === 0) resolve(stdout || stderr);
                else reject(new Error(`Exit ${code}: ${stderr || stdout}`));
            });
            proc.on('error', reject);
        });
    }
}

module.exports = TtsEngine;
