'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Whisper transcription wrapper.
 * Calls Python/whisper CLI to transcribe audio files.
 */
class WhisperTranscriber {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {string} [opts.model='base'] - Whisper model size
     * @param {string} [opts.language='de'] - Language code
     */
    constructor({ log, model = 'base', language = 'de' }) {
        this.log = log;
        this.model = model;
        this.language = language;
        this._tmpDir = path.join(os.tmpdir(), 'iobroker-ai-assistant');
        this._ready = false;
    }

    /**
     * Check if Whisper is available.
     * @returns {Promise<boolean>}
     */
    async init() {
        // Ensure temp dir exists
        if (!fs.existsSync(this._tmpDir)) {
            fs.mkdirSync(this._tmpDir, { recursive: true });
        }

        // Check faster-whisper availability (preferred), fallback to original whisper
        try {
            const version = await this._exec('python3', ['-c', 'from faster_whisper import WhisperModel; print("faster-whisper")']);
            this.log.info(`faster-whisper available (model: ${this.model}, language: ${this.language})`);
            this._useFasterWhisper = true;
            this._ready = true;
            return true;
        } catch (e) {
            // Fallback to original whisper
            try {
                const version = await this._exec('python3', ['-c', 'import whisper; print(whisper.__version__)']);
                this.log.info(`Whisper ${version.trim()} available (model: ${this.model}, language: ${this.language})`);
                this.log.warn('Using original whisper - consider installing faster-whisper for 4x speedup: pip3 install faster-whisper');
                this._useFasterWhisper = false;
                this._ready = true;
                return true;
            } catch (e2) {
                this.log.error('Whisper not available. Install with: pip3 install faster-whisper');
                this._ready = false;
                return false;
            }
        }
    }

    /**
     * Transcribe audio buffer.
     * @param {Buffer} audioBuffer - Audio data (WAV, OGG, MP3, etc.)
     * @param {string} [format='ogg'] - Input format hint
     * @returns {Promise<{text: string, language: string, duration: number}>}
     */
    async transcribe(audioBuffer, format = 'ogg') {
        if (!this._ready) throw new Error('Whisper not initialized');

        const tmpFile = path.join(this._tmpDir, `audio_${Date.now()}.${format}`);
        const resultFile = path.join(this._tmpDir, `result_${Date.now()}.json`);

        try {
            // Write audio to temp file
            fs.writeFileSync(tmpFile, audioBuffer);

            let script;
            if (this._useFasterWhisper) {
                // faster-whisper (4x faster, less RAM)
                script = `
import json
from faster_whisper import WhisperModel

model = WhisperModel("${this.model}", device="cpu", compute_type="int8")
segments, info = model.transcribe("${tmpFile}", language="${this.language}")

text_parts = []
last_end = 0
for segment in segments:
    text_parts.append(segment.text)
    last_end = segment.end

output = {
    "text": " ".join(text_parts).strip(),
    "language": info.language,
    "segments": len(text_parts),
    "duration": last_end
}
with open("${resultFile}", "w") as f:
    json.dump(output, f)
print("OK")
`;
            } else {
                // Original whisper (fallback)
                script = `
import whisper, json, sys
model = whisper.load_model("${this.model}")
result = model.transcribe("${tmpFile}", language="${this.language}")
output = {
    "text": result["text"].strip(),
    "language": result.get("language", "${this.language}"),
    "segments": len(result.get("segments", [])),
    "duration": result["segments"][-1]["end"] if result.get("segments") else 0
}
with open("${resultFile}", "w") as f:
    json.dump(output, f)
print("OK")
`;
            }

            const startTime = Date.now();
            const output = await this._exec('python3', ['-c', script], 120000);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (!fs.existsSync(resultFile)) {
                throw new Error(`Transcription produced no output: ${output}`);
            }

            const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
            this.log.debug(`Transcribed ${result.duration.toFixed(1)}s audio in ${elapsed}s: "${result.text}"`);
            return result;
        } finally {
            // Cleanup
            try { fs.unlinkSync(tmpFile); } catch (_) {}
            try { fs.unlinkSync(resultFile); } catch (_) {}
        }
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

    destroy() {
        // Cleanup temp dir
        try {
            if (fs.existsSync(this._tmpDir)) {
                const files = fs.readdirSync(this._tmpDir);
                for (const f of files) {
                    fs.unlinkSync(path.join(this._tmpDir, f));
                }
            }
        } catch (_) {}
    }
}

module.exports = WhisperTranscriber;
