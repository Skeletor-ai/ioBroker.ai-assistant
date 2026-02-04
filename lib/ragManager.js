'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const RAG_DIR = path.join(__dirname, '..', 'rag');
const VENV_DIR = path.join(RAG_DIR, 'venv');
const DATA_DIR = path.join(RAG_DIR, 'data');
const REPOS_DIR = path.join(DATA_DIR, 'repos');
const CHROMA_DIR = path.join(DATA_DIR, 'chroma');
const REQUIREMENTS = path.join(RAG_DIR, 'requirements.txt');
const SERVER_SCRIPT = path.join(RAG_DIR, 'server.py');
const INGEST_SCRIPT = path.join(RAG_DIR, 'ingest.py');
const SETUP_MARKER = path.join(DATA_DIR, '.setup_complete');

const REPOS = [
    { name: 'ioBroker.docs', url: 'https://github.com/ioBroker/ioBroker.docs.git' },
    { name: 'ioBroker.template', url: 'https://github.com/ioBroker/ioBroker.template.git' },
    { name: 'create-adapter', url: 'https://github.com/ioBroker/create-adapter.git' },
    { name: 'ioBroker.js-controller', url: 'https://github.com/ioBroker/ioBroker.js-controller.git' },
    { name: 'ioBroker.javascript', url: 'https://github.com/ioBroker/ioBroker.javascript.git' },
    { name: 'ioBroker.simple-api', url: 'https://github.com/ioBroker/ioBroker.simple-api.git' },
];

/**
 * Manages the RAG Python service lifecycle:
 * - Auto-setup (venv, deps, repos, ingestion) on first run
 * - Start/stop the FastAPI server as child process
 * - Health monitoring
 */
class RagManager {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {number} [opts.port=8321] - Server port
     * @param {function} [opts.onStatusChange] - Called with (status: string) on state changes
     */
    constructor({ log, port, onStatusChange }) {
        this.log = log;
        this.port = port || 8321;
        this.onStatusChange = onStatusChange || (() => {});
        this._process = null;
        this._ready = false;
        this._stopping = false;
    }

    /**
     * Full lifecycle: setup if needed, then start server.
     * @returns {Promise<boolean>} true if server is running
     */
    async start() {
        try {
            // Check Python availability
            if (!this._hasPython()) {
                this.log.error('Python 3 not found. RAG service requires Python >= 3.9');
                this.onStatusChange('error: python not found');
                return false;
            }

            // First-time setup
            if (!this._isSetupComplete()) {
                this.log.info('RAG: First-time setup starting...');
                this.onStatusChange('setup');
                await this._setup();
            }

            // Check if ChromaDB has data
            if (!this._hasData()) {
                this.log.info('RAG: ChromaDB empty, running ingestion...');
                this.onStatusChange('indexing');
                await this._runIngest();
            }

            // Start server
            this.onStatusChange('starting');
            await this._startServer();
            return this._ready;
        } catch (e) {
            this.log.error(`RAG start failed: ${e.message}`);
            this.onStatusChange(`error: ${e.message}`);
            return false;
        }
    }

    /**
     * Stop the RAG server process.
     */
    async stop() {
        this._stopping = true;
        this._ready = false;

        if (this._process) {
            this.log.info('RAG: Stopping server...');
            try {
                this._process.kill('SIGTERM');
                // Give it 3 seconds to gracefully shut down
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        if (this._process) {
                            this._process.kill('SIGKILL');
                        }
                        resolve();
                    }, 3000);
                    if (this._process) {
                        this._process.on('exit', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    } else {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            } catch (_) {}
            this._process = null;
        }
        this.onStatusChange('stopped');
    }

    /**
     * Re-index all documentation (can be triggered from admin).
     * Server will be restarted after.
     * @returns {Promise<object>} Ingestion stats
     */
    async reindex() {
        this.log.info('RAG: Re-indexing documentation...');
        this.onStatusChange('indexing');

        // Stop server first
        await this.stop();

        // Update repos
        await this._updateRepos();

        // Re-run ingestion with reset
        const stats = await this._runIngest(true);

        // Restart server
        this._stopping = false;
        await this._startServer();

        return stats;
    }

    get ready() {
        return this._ready;
    }

    get url() {
        return `http://127.0.0.1:${this.port}`;
    }

    // ─── Setup ───────────────────────────────────────────────────────

    _hasPython() {
        try {
            const version = execSync('python3 --version 2>&1', { encoding: 'utf-8' }).trim();
            this.log.debug(`Found: ${version}`);
            return true;
        } catch (_) {
            return false;
        }
    }

    _isSetupComplete() {
        return fs.existsSync(SETUP_MARKER) && fs.existsSync(path.join(VENV_DIR, 'bin', 'python'));
    }

    _hasData() {
        // Check if ChromaDB directory exists and has files
        if (!fs.existsSync(CHROMA_DIR)) return false;
        try {
            const files = fs.readdirSync(CHROMA_DIR);
            return files.length > 0;
        } catch (_) {
            return false;
        }
    }

    async _setup() {
        // Create directories
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(REPOS_DIR, { recursive: true });

        // Create venv (try with pip, fallback to without)
        this.log.info('RAG: Creating Python virtual environment...');
        try {
            await this._exec('python3', ['-m', 'venv', VENV_DIR]);
        } catch (_) {
            this.log.info('RAG: venv with pip failed, trying --without-pip...');
            await this._exec('python3', ['-m', 'venv', '--without-pip', VENV_DIR]);
        }

        const pipPath = path.join(VENV_DIR, 'bin', 'pip');
        const pythonPath = path.join(VENV_DIR, 'bin', 'python');

        // Install pip if not available
        if (!fs.existsSync(pipPath)) {
            this.log.info('RAG: Installing pip via ensurepip...');
            try {
                await this._exec(pythonPath, ['-m', 'ensurepip', '--upgrade']);
            } catch (_) {
                this.log.info('RAG: ensurepip failed, using get-pip.py...');
                await this._exec('bash', ['-c', `curl -sS https://bootstrap.pypa.io/get-pip.py | ${pythonPath}`], { timeout: 60000 });
            }
        }

        // Install requirements
        this.log.info('RAG: Installing Python dependencies...');
        await this._exec(pipPath, ['install', '-r', REQUIREMENTS], { timeout: 300000 });

        // Clone repos
        await this._cloneRepos();

        // Mark setup as complete
        fs.writeFileSync(SETUP_MARKER, new Date().toISOString());
        this.log.info('RAG: Setup complete');
    }

    async _cloneRepos() {
        for (const repo of REPOS) {
            const repoDir = path.join(REPOS_DIR, repo.name);
            if (fs.existsSync(repoDir)) {
                this.log.debug(`RAG: Repo ${repo.name} already exists, skipping clone`);
                continue;
            }
            this.log.info(`RAG: Cloning ${repo.name}...`);
            try {
                await this._exec('git', ['clone', '--depth', '1', repo.url, repoDir], { timeout: 120000 });
            } catch (e) {
                this.log.warn(`RAG: Failed to clone ${repo.name}: ${e.message}`);
            }
        }
    }

    async _updateRepos() {
        for (const repo of REPOS) {
            const repoDir = path.join(REPOS_DIR, repo.name);
            if (!fs.existsSync(repoDir)) continue;
            this.log.info(`RAG: Updating ${repo.name}...`);
            try {
                await this._exec('git', ['-C', repoDir, 'pull', '--depth', '1'], { timeout: 60000 });
            } catch (e) {
                this.log.debug(`RAG: Pull failed for ${repo.name}: ${e.message}`);
            }
        }
    }

    // ─── Ingestion ───────────────────────────────────────────────────

    async _runIngest(reset = false) {
        const pythonPath = path.join(VENV_DIR, 'bin', 'python');
        const args = [INGEST_SCRIPT];
        if (reset) args.push('--reset');

        this.log.info('RAG: Running ingestion pipeline...');
        const output = await this._exec(pythonPath, args, { timeout: 600000, captureOutput: true });
        this.log.info('RAG: Ingestion complete');

        // Try to read stats
        try {
            const statsPath = path.join(DATA_DIR, 'ingest_stats.json');
            if (fs.existsSync(statsPath)) {
                return JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
            }
        } catch (_) {}

        return { output };
    }

    // ─── Server Process ──────────────────────────────────────────────

    _startServer() {
        return new Promise((resolve) => {
            const pythonPath = path.join(VENV_DIR, 'bin', 'python');

            this._process = spawn(pythonPath, [SERVER_SCRIPT], {
                cwd: RAG_DIR,
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let resolved = false;
            const startTimeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    // Check if process is still running
                    if (this._process && !this._process.killed) {
                        this._ready = true;
                        this.log.info(`RAG: Server assumed ready on port ${this.port}`);
                        this.onStatusChange('running');
                    }
                    resolve(true);
                }
            }, 15000);

            this._process.stdout.on('data', (data) => {
                const line = data.toString().trim();
                if (line) this.log.debug(`RAG: ${line}`);

                // Detect when uvicorn is ready
                if (!resolved && (line.includes('Uvicorn running') || line.includes('Application startup complete'))) {
                    resolved = true;
                    clearTimeout(startTimeout);
                    this._ready = true;
                    this.log.info(`RAG: Server running on port ${this.port}`);
                    this.onStatusChange('running');
                    resolve(true);
                }
            });

            this._process.stderr.on('data', (data) => {
                const line = data.toString().trim();
                if (line) {
                    // uvicorn logs to stderr
                    if (line.includes('Uvicorn running') || line.includes('Application startup complete')) {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(startTimeout);
                            this._ready = true;
                            this.log.info(`RAG: Server running on port ${this.port}`);
                            this.onStatusChange('running');
                            resolve(true);
                        }
                    } else if (line.includes('ERROR') || line.includes('Error')) {
                        this.log.warn(`RAG: ${line}`);
                    } else {
                        this.log.debug(`RAG: ${line}`);
                    }
                }
            });

            this._process.on('exit', (code, signal) => {
                this._ready = false;
                this._process = null;

                if (!this._stopping) {
                    this.log.warn(`RAG: Server exited unexpectedly (code=${code}, signal=${signal})`);
                    this.onStatusChange('crashed');
                }

                if (!resolved) {
                    resolved = true;
                    clearTimeout(startTimeout);
                    resolve(false);
                }
            });

            this._process.on('error', (err) => {
                this.log.error(`RAG: Server process error: ${err.message}`);
                this._ready = false;

                if (!resolved) {
                    resolved = true;
                    clearTimeout(startTimeout);
                    resolve(false);
                }
            });
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    _exec(command, args = [], options = {}) {
        return new Promise((resolve, reject) => {
            const timeout = options.timeout || 120000;
            const captureOutput = options.captureOutput || false;
            let output = '';

            const proc = spawn(command, args, {
                cwd: RAG_DIR,
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
                stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
            });

            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`Command timed out after ${timeout}ms: ${command} ${args.join(' ')}`));
            }, timeout);

            if (captureOutput) {
                proc.stdout.on('data', (d) => { output += d.toString(); });
                proc.stderr.on('data', (d) => { output += d.toString(); });
            }

            proc.on('exit', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(output);
                } else {
                    reject(new Error(`Command failed (code ${code}): ${command} ${args.join(' ')}\n${output}`));
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
}

module.exports = RagManager;
