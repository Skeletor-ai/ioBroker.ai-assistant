'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/**
 * Whisper transcription using whisper.cpp via smart-whisper (native Node.js addon).
 * No Python or pip required.
 */
class WhisperTranscriber {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {string} [opts.model='base'] - Whisper model size (tiny, base, small, medium, large-v3)
     * @param {string} [opts.language='de'] - Language code
     */
    constructor({ log, model = 'base', language = 'de' }) {
        this.log = log;
        this.model = model;
        this.language = language;
        this._tmpDir = path.join(os.tmpdir(), 'iobroker-ai-assistant');
        this._modelsDir = path.join(__dirname, '..', 'whisper-models');
        this._whisper = null;
        this._ready = false;
    }

    /**
     * Initialize whisper.cpp via smart-whisper.
     * Downloads the model if not present.
     * @returns {Promise<boolean>}
     */
    async init() {
        // Ensure directories exist
        for (const dir of [this._tmpDir, this._modelsDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        try {
            // Check ffmpeg availability (needed for audio conversion)
            await this._exec('ffmpeg', ['-version']);
        } catch (e) {
            this.log.error('ffmpeg not found. Please install ffmpeg: sudo apt install ffmpeg');
            this._ready = false;
            return false;
        }

        try {
            const { Whisper, manager } = require('smart-whisper');

            // Download model if not present
            const modelName = `ggml-${this.model}.bin`;
            const modelPath = path.join(this._modelsDir, modelName);

            if (!fs.existsSync(modelPath)) {
                this.log.info(`Downloading whisper model "${this.model}"...`);
                try {
                    await manager.download(this.model, this._modelsDir);
                    this.log.info(`Model "${this.model}" downloaded successfully`);
                } catch (downloadErr) {
                    // Fallback: manual download via curl
                    this.log.info('smart-whisper manager download failed, trying direct download...');
                    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`;
                    await this._exec('curl', ['-L', '-o', modelPath, url], 300000);
                    this.log.info(`Model "${this.model}" downloaded via curl`);
                }
            }

            if (!fs.existsSync(modelPath)) {
                throw new Error(`Model file not found: ${modelPath}`);
            }

            // Load model
            this._whisper = new Whisper(modelPath, { gpu: false });
            this._ready = true;
            this.log.info(`whisper.cpp ready (model: ${this.model}, language: ${this.language})`);
            return true;
        } catch (e) {
            this.log.error(`whisper.cpp initialization failed: ${e.message}`);
            this.log.error('Install with: npm install smart-whisper (requires cmake and a C++ compiler)');
            this._ready = false;
            return false;
        }
    }

    /**
     * Convert audio buffer to 16kHz mono Float32Array PCM using ffmpeg.
     * @param {Buffer} audioBuffer
     * @param {string} format - Input format hint (ogg, wav, mp3, etc.)
     * @returns {Promise<Float32Array>}
     * @private
     */
    async _toPCM(audioBuffer, format) {
        const inputFile = path.join(this._tmpDir, `input_${Date.now()}.${format}`);
        const outputFile = path.join(this._tmpDir, `pcm_${Date.now()}.raw`);

        try {
            fs.writeFileSync(inputFile, audioBuffer);

            // Convert to 16kHz mono f32le PCM
            await this._exec('ffmpeg', [
                '-i', inputFile,
                '-ar', '16000',
                '-ac', '1',
                '-f', 'f32le',
                '-acodec', 'pcm_f32le',
                '-y',
                outputFile,
            ], 30000);

            const rawBuffer = fs.readFileSync(outputFile);
            return new Float32Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength / 4);
        } finally {
            try { fs.unlinkSync(inputFile); } catch (_) {}
            try { fs.unlinkSync(outputFile); } catch (_) {}
        }
    }

    /**
     * Transcribe audio buffer.
     * @param {Buffer} audioBuffer - Audio data (WAV, OGG, MP3, etc.)
     * @param {string} [format='ogg'] - Input format hint
     * @returns {Promise<{text: string, language: string, duration: number}>}
     */
    async transcribe(audioBuffer, format = 'ogg') {
        if (!this._ready || !this._whisper) {
            throw new Error('Whisper not initialized');
        }

        const startTime = Date.now();

        // Convert audio to PCM
        const pcm = await this._toPCM(audioBuffer, format);
        const duration = pcm.length / 16000; // 16kHz sample rate

        // Transcribe
        const task = await this._whisper.transcribe(pcm, {
            language: this.language,
        });

        const result = await task.result;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Extract text from segments
        let text = '';
        if (Array.isArray(result)) {
            text = result.map(s => s.text || s).join(' ').trim();
        } else if (typeof result === 'string') {
            text = result.trim();
        } else if (result && result.text) {
            text = result.text.trim();
        }

        this.log.debug(`Transcribed ${duration.toFixed(1)}s audio in ${elapsed}s: "${text}"`);

        return {
            text,
            language: this.language,
            duration,
        };
    }

    /**
     * Execute a command and return stdout.
     * @param {string} cmd
     * @param {string[]} args
     * @param {number} [timeout=30000]
     * @returns {Promise<string>}
     * @private
     */
    _exec(cmd, args, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const proc = spawn(cmd, args, { timeout });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d) => { stdout += d; });
            proc.stderr.on('data', (d) => { stderr += d; });
            proc.on('close', (code) => {
                if (code === 0) resolve(stdout);
                else reject(new Error(`Exit ${code}: ${stderr || stdout}`));
            });
            proc.on('error', reject);
        });
    }

    /**
     * Free resources.
     */
    destroy() {
        if (this._whisper) {
            try {
                this._whisper.free();
            } catch (_) {}
            this._whisper = null;
        }
        this._ready = false;

        // Cleanup temp dir
        try {
            if (fs.existsSync(this._tmpDir)) {
                const files = fs.readdirSync(this._tmpDir);
                for (const f of files) {
                    try { fs.unlinkSync(path.join(this._tmpDir, f)); } catch (_) {}
                }
            }
        } catch (_) {}
    }
}

module.exports = WhisperTranscriber;
