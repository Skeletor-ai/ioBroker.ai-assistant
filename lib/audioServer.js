'use strict';

const http = require('http');

/**
 * HTTP server that accepts audio uploads for transcription.
 *
 * Endpoints:
 *   POST /audio          - Upload audio for transcription (body = raw audio)
 *   POST /audio?format=wav - Specify format (default: ogg)
 *   GET  /status         - Health check
 *
 * Headers:
 *   X-Device-Id: optional device identifier
 *   Content-Type: audio/ogg, audio/wav, audio/mpeg, etc.
 */
class AudioServer {
    /**
     * @param {object} opts
     * @param {object} opts.log
     * @param {number} opts.port
     * @param {function} opts.onAudio - async (audioBuffer, format, deviceId) => result
     */
    constructor({ log, port, onAudio }) {
        this.log = log;
        this.port = port;
        this.onAudio = onAudio;
        this._server = null;
    }

    /**
     * Start the HTTP audio server.
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => {
                this._handleRequest(req, res);
            });

            this._server.on('error', (err) => {
                this.log.error(`Audio server error: ${err.message}`);
                reject(err);
            });

            this._server.listen(this.port, () => {
                this.log.info(`Audio server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Stop the server.
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            if (this._server) {
                this._server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }

    /**
     * Handle incoming HTTP requests.
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @private
     */
    async _handleRequest(req, res) {
        // CORS headers for browser clients
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // GET /status
        if (req.method === 'GET' && req.url?.startsWith('/status')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', port: this.port }));
            return;
        }

        // POST /audio
        if (req.method === 'POST' && req.url?.startsWith('/audio')) {
            await this._handleAudioUpload(req, res);
            return;
        }

        // POST /text - receive pre-transcribed text (from on-device STT)
        if (req.method === 'POST' && req.url?.startsWith('/text')) {
            await this._handleTextInput(req, res);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    /**
     * Handle audio upload and transcription.
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @private
     */
    async _handleAudioUpload(req, res) {
        const maxSize = 10 * 1024 * 1024; // 10 MB max
        const chunks = [];
        let size = 0;

        try {
            // Collect body
            await new Promise((resolve, reject) => {
                req.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > maxSize) {
                        reject(new Error('Audio too large (max 10 MB)'));
                        req.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', resolve);
                req.on('error', reject);
            });

            const audioBuffer = Buffer.concat(chunks);

            if (audioBuffer.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Empty audio' }));
                return;
            }

            // Determine format
            const url = new URL(req.url, `http://localhost:${this.port}`);
            const contentType = req.headers['content-type'] || '';
            let format = url.searchParams.get('format') || this._guessFormat(contentType) || 'ogg';
            const deviceId = req.headers['x-device-id'] || 'unknown';

            this.log.debug(`Audio received: ${audioBuffer.length} bytes, format: ${format}, device: ${deviceId}`);

            // Process audio
            const result = await this.onAudio(audioBuffer, format, deviceId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            this.log.warn(`Audio processing error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    }

    /**
     * Handle pre-transcribed text input (from on-device STT like sherpa-onnx).
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @private
     */
    async _handleTextInput(req, res) {
        try {
            const chunks = [];
            await new Promise((resolve, reject) => {
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', resolve);
                req.on('error', reject);
            });

            const body = Buffer.concat(chunks).toString('utf-8');
            let text = '';
            let deviceId = req.headers['x-device-id'] || 'unknown';

            try {
                const json = JSON.parse(body);
                text = json.text || '';
                if (json.device_id) deviceId = json.device_id;
            } catch {
                text = body.trim();
            }

            if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Empty text' }));
                return;
            }

            this.log.debug(`Text received: "${text}", device: ${deviceId}`);

            // Process text through the same pipeline as transcribed audio
            // onAudio callback expects (buffer, format, deviceId) but we pass text directly
            // Use a special format marker so main.js can skip transcription
            const result = await this.onAudio(Buffer.from(text, 'utf-8'), '_text', deviceId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            this.log.warn(`Text processing error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    }

    /**
     * Guess audio format from Content-Type.
     * @param {string} contentType
     * @returns {string|null}
     * @private
     */
    _guessFormat(contentType) {
        if (contentType.includes('ogg')) return 'ogg';
        if (contentType.includes('wav')) return 'wav';
        if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
        if (contentType.includes('webm')) return 'webm';
        if (contentType.includes('flac')) return 'flac';
        return null;
    }
}

module.exports = AudioServer;
