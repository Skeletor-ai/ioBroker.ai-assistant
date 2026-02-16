'use strict';

const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const RAG_DIR = path.join(__dirname, '..', 'rag');
const DATA_DIR = path.join(RAG_DIR, 'data');
const REPOS_DIR = path.join(DATA_DIR, 'repos');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const STATS_PATH = path.join(DATA_DIR, 'ingest_stats.json');

const REPOS = [
    { name: 'ioBroker.docs', url: 'https://github.com/ioBroker/ioBroker.docs.git' },
    { name: 'ioBroker.template', url: 'https://github.com/ioBroker/ioBroker.template.git' },
    { name: 'create-adapter', url: 'https://github.com/ioBroker/create-adapter.git' },
    { name: 'ioBroker.js-controller', url: 'https://github.com/ioBroker/ioBroker.js-controller.git' },
    { name: 'ioBroker.javascript', url: 'https://github.com/ioBroker/ioBroker.javascript.git' },
    { name: 'ioBroker.simple-api', url: 'https://github.com/ioBroker/ioBroker.simple-api.git' },
];

const REPO_PATHS = {
    'ioBroker.docs': ['docs/en/dev', 'docs/en/basics', 'docs/de/dev', 'docs/de/basics', 'docs/en/admin', 'docs/de/admin'],
    'ioBroker.template': ['.'],
    'create-adapter': ['src', 'templates', 'README.md'],
    'ioBroker.js-controller': ['lib', 'doc', 'README.md', 'packages'],
    'ioBroker.javascript': ['lib', 'docs', 'README.md'],
    'ioBroker.simple-api': ['lib', 'README.md'],
};

const EXTENSIONS = new Set(['.md', '.js', '.ts', '.jsx', '.tsx', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.nyc_output', 'test', 'tests']);

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;

/**
 * Pure Node.js RAG engine — replaces Python-based RAG server.
 * Uses @xenova/transformers for embeddings and a file-based vector store.
 */
class RagEngine {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {number} [opts.port] - Kept for compat, unused
     * @param {string} [opts.dataDir] - Override data directory
     * @param {function} [opts.onStatusChange] - Called with (status: string)
     * @param {number} [opts.topK=5] - Default number of results
     * @param {string} [opts.language] - Default language filter
     */
    constructor({ log, port, dataDir, onStatusChange, topK, language }) {
        this.log = log;
        this.port = port; // unused, kept for compat
        this.dataDir = dataDir || DATA_DIR;
        this.onStatusChange = onStatusChange || (() => {});
        this.topK = topK || 5;
        this.language = language || '';

        this._pipeline = null;
        this._index = null; // { documents: [...], version: 1 }
        this._ready = false;
        this._tokenizer = null;
    }

    // ─── Public API ──────────────────────────────────────────────────

    async start() {
        try {
            this.onStatusChange('starting');
            this.log.info('RAG: Loading embedding model...');

            // Dynamic import for ESM module
            const { pipeline } = await import('@xenova/transformers');
            this._pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                quantized: true,
            });
            this.log.info('RAG: Embedding model loaded');

            // Load existing index if available
            if (fs.existsSync(INDEX_PATH)) {
                try {
                    const raw = fs.readFileSync(INDEX_PATH, 'utf-8');
                    this._index = JSON.parse(raw);
                    this.log.info(`RAG: Loaded index with ${this._index.documents.length} documents`);
                } catch (e) {
                    this.log.warn(`RAG: Failed to load index: ${e.message}`);
                    this._index = null;
                }
            }

            // If no index, build one
            if (!this._index || !this._index.documents || this._index.documents.length === 0) {
                this.log.info('RAG: No index found, building...');
                this.onStatusChange('indexing');
                await this._cloneRepos();
                await this._buildIndex();
            }

            this._ready = true;
            this.onStatusChange('running');
            return true;
        } catch (e) {
            this.log.error(`RAG start failed: ${e.message}`);
            this.onStatusChange(`error: ${e.message}`);
            return false;
        }
    }

    async stop() {
        this._ready = false;
        this._pipeline = null;
        this._index = null;
        this.onStatusChange('stopped');
    }

    /**
     * Query the index.
     * @param {string} question
     * @param {object} [options]
     * @param {number} [options.topK]
     * @param {string} [options.language]
     * @param {string} [options.docType]
     * @returns {Promise<{context: string, sources: object[], prompt: string, queryTimeMs: number}|null>}
     */
    async query(question, options = {}) {
        if (!this._ready || !this._index) return null;

        const start = Date.now();
        const topK = options.topK || this.topK;
        const langFilter = options.language || this.language || null;
        const typeFilter = options.docType || null;

        try {
            // Embed query
            const queryEmb = await this._embed(question);

            // Filter + score
            let candidates = this._index.documents;
            if (langFilter) {
                candidates = candidates.filter(d => d.metadata.language === langFilter);
            }
            if (typeFilter) {
                candidates = candidates.filter(d => d.metadata.type === typeFilter);
            }

            // Cosine similarity
            const scored = candidates.map(doc => ({
                doc,
                score: cosineSimilarity(queryEmb, doc.embedding),
            }));

            scored.sort((a, b) => b.score - a.score);
            const topResults = scored.slice(0, topK);

            if (topResults.length === 0) {
                return {
                    context: 'No relevant documents found.',
                    sources: [],
                    prompt: '',
                    queryTimeMs: Date.now() - start,
                };
            }

            // Build context
            const contextParts = [];
            const sources = [];

            for (const { doc, score } of topResults) {
                const m = doc.metadata;
                const relevance = Math.max(0, score);

                sources.push({
                    file: m.source,
                    type: m.type,
                    language: m.language,
                    adapter: m.adapter_name,
                    section: m.section || '',
                    relevance: Math.round(relevance * 1000) / 1000,
                });

                let header = `[Source: ${m.source}`;
                if (m.section) header += ` § ${m.section}`;
                header += ` | ${m.type} | relevance: ${relevance.toFixed(2)}]`;

                contextParts.push(`${header}\n${doc.text}`);
            }

            const context = contextParts.join('\n\n---\n\n');
            const prompt =
                `Based on the following ioBroker documentation and code references:\n\n` +
                `${context}\n\n---\n\n` +
                `Answer the following question accurately. ` +
                `Reference specific files and code examples where applicable. ` +
                `If the documentation doesn't fully cover the question, say so.\n\n` +
                `Question: ${question}`;

            return {
                context,
                sources,
                prompt,
                queryTimeMs: Date.now() - start,
            };
        } catch (e) {
            this.log.warn(`RAG query error: ${e.message}`);
            return null;
        }
    }

    /**
     * Build an enriched system prompt by injecting RAG context.
     * @param {string} basePrompt
     * @param {string} userText
     * @returns {Promise<string>}
     */
    async enrichPrompt(basePrompt, userText) {
        const result = await this.query(userText);
        if (!result || !result.context) return basePrompt;

        const sourceList = result.sources
            .map(s => `  - ${s.file} (${s.type}, relevance: ${(s.relevance || 0).toFixed(2)})`)
            .join('\n');

        return `${basePrompt}

## ioBroker Documentation Context
The following documentation excerpts are relevant to the user's question.
Use this information to provide accurate, ioBroker-specific answers.

${result.context}

Sources:
${sourceList}`;
    }

    /**
     * Re-index all documentation.
     * @returns {Promise<object>} Ingestion stats
     */
    async reindex() {
        this.log.info('RAG: Re-indexing documentation...');
        this.onStatusChange('indexing');

        await this._updateRepos();
        const stats = await this._buildIndex();

        this._ready = true;
        this.onStatusChange('running');
        return stats;
    }

    get ready() {
        return this._ready;
    }

    get available() {
        return this._ready;
    }

    async ping() {
        return this._ready;
    }

    // ─── Embedding ───────────────────────────────────────────────────

    async _embed(text) {
        const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }

    async _embedBatch(texts, batchSize = 32) {
        const embeddings = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            for (const text of batch) {
                embeddings.push(await this._embed(text));
            }
            if ((i + batchSize) % 256 === 0 || i + batchSize >= texts.length) {
                this.log.info(`RAG: Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks`);
            }
        }
        return embeddings;
    }

    // ─── Repos ───────────────────────────────────────────────────────

    async _cloneRepos() {
        fs.mkdirSync(REPOS_DIR, { recursive: true });

        for (const repo of REPOS) {
            const repoDir = path.join(REPOS_DIR, repo.name);
            if (fs.existsSync(repoDir)) {
                this.log.debug(`RAG: Repo ${repo.name} exists, skipping`);
                continue;
            }
            this.log.info(`RAG: Cloning ${repo.name}...`);
            try {
                await this._exec('git', ['clone', '--depth', '1', repo.url, repoDir], 120000);
            } catch (e) {
                this.log.warn(`RAG: Failed to clone ${repo.name}: ${e.message}`);
            }
        }
    }

    async _updateRepos() {
        for (const repo of REPOS) {
            const repoDir = path.join(REPOS_DIR, repo.name);
            if (!fs.existsSync(repoDir)) {
                try {
                    await this._exec('git', ['clone', '--depth', '1', repo.url, repoDir], 120000);
                } catch (e) {
                    this.log.warn(`RAG: Failed to clone ${repo.name}: ${e.message}`);
                }
                continue;
            }
            this.log.info(`RAG: Updating ${repo.name}...`);
            try {
                await this._exec('git', ['-C', repoDir, 'pull', '--depth', '1'], 60000);
            } catch (e) {
                this.log.debug(`RAG: Pull failed for ${repo.name}: ${e.message}`);
            }
        }
    }

    // ─── Indexing ────────────────────────────────────────────────────

    async _buildIndex() {
        const startTime = Date.now();

        // Collect files
        const files = this._collectFiles();
        this.log.info(`RAG: Found ${files.length} files to process`);

        // Chunk
        const allChunks = [];
        for (const [filepath, displayPath] of files) {
            try {
                const content = fs.readFileSync(filepath, 'utf-8');
                if (!content.trim()) continue;

                const ext = path.extname(filepath).toLowerCase();
                let chunks;
                if (ext === '.md') {
                    chunks = chunkMarkdown(content, displayPath);
                } else {
                    chunks = chunkCode(content, displayPath);
                }

                for (const chunk of chunks) {
                    chunk.language = detectLanguage(displayPath);
                    chunk.adapter_name = detectAdapterName(displayPath);
                    if (chunk.type === 'doc' && ext !== '.md') {
                        chunk.type = detectFileType(displayPath);
                    }
                }

                allChunks.push(...chunks);
            } catch (e) {
                this.log.debug(`RAG: Error processing ${displayPath}: ${e.message}`);
            }
        }

        this.log.info(`RAG: Created ${allChunks.length} chunks from ${files.length} files`);

        if (allChunks.length === 0) {
            this.log.warn('RAG: No chunks created');
            return { filesProcessed: 0, chunksCreated: 0 };
        }

        // Embed all chunks
        this.log.info('RAG: Embedding chunks...');
        const texts = allChunks.map(c => c.text);
        const embeddings = await this._embedBatch(texts);

        // Build index
        const documents = allChunks.map((chunk, i) => ({
            id: makeDocId(chunk.source_file, i),
            text: chunk.text,
            metadata: {
                source: chunk.source_file,
                type: chunk.type,
                language: chunk.language,
                adapter_name: chunk.adapter_name,
                section: chunk.section || '',
                token_count: chunk.token_count,
            },
            embedding: embeddings[i],
        }));

        this._index = { documents, version: 1 };

        // Save to disk
        fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
        fs.writeFileSync(INDEX_PATH, JSON.stringify(this._index));
        this.log.info(`RAG: Index saved (${documents.length} documents, ${Math.round(fs.statSync(INDEX_PATH).size / 1024 / 1024 * 10) / 10}MB)`);

        // Stats
        const typeCounts = {};
        const langCounts = {};
        for (const c of allChunks) {
            typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
            langCounts[c.language] = (langCounts[c.language] || 0) + 1;
        }

        const stats = {
            files_processed: files.length,
            chunks_created: allChunks.length,
            total_in_collection: documents.length,
            type_distribution: typeCounts,
            language_distribution: langCounts,
            elapsed_seconds: Math.round((Date.now() - startTime) / 100) / 10,
        };

        fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
        this.log.info(`RAG: Indexing complete in ${stats.elapsed_seconds}s`);

        return stats;
    }

    _collectFiles() {
        const files = [];

        for (const [repoName, paths] of Object.entries(REPO_PATHS)) {
            const repoDir = path.join(REPOS_DIR, repoName);
            if (!fs.existsSync(repoDir)) continue;

            for (const relPath of paths) {
                const target = path.join(repoDir, relPath);

                if (!fs.existsSync(target)) continue;

                const stat = fs.statSync(target);
                if (stat.isFile()) {
                    if (EXTENSIONS.has(path.extname(target).toLowerCase())) {
                        files.push([target, `${repoName}/${relPath}`]);
                    }
                } else if (stat.isDirectory()) {
                    this._walkDir(target, repoDir, repoName, files);
                }
            }
        }

        return files;
    }

    _walkDir(dir, repoDir, repoName, files) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }

        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walkDir(fullPath, repoDir, repoName, files);
            } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                const rel = path.relative(repoDir, fullPath);
                files.push([fullPath, `${repoName}/${rel}`]);
            }
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    _exec(command, args, timeout = 120000) {
        return new Promise((resolve, reject) => {
            const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';

            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`Timeout: ${command} ${args.join(' ')}`));
            }, timeout);

            proc.stdout.on('data', d => { output += d.toString(); });
            proc.stderr.on('data', d => { output += d.toString(); });

            proc.on('exit', code => {
                clearTimeout(timer);
                if (code === 0) resolve(output);
                else reject(new Error(`Exit ${code}: ${command} ${args.join(' ')}\n${output.slice(0, 500)}`));
            });

            proc.on('error', err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
}

// ─── Chunking (ported from ingest.py) ────────────────────────────────

/**
 * Simple token counting approximation (splits on whitespace/punctuation).
 * Avoids needing tiktoken dependency. ~1.3 tokens per word for English.
 */
function countTokens(text) {
    // Rough approximation: split on whitespace and punctuation boundaries
    return Math.ceil(text.split(/\s+/).length * 1.3);
}

function chunkMarkdown(text, sourceFile) {
    const chunks = [];
    const parts = text.split(/(```[\s\S]*?```)/);
    let currentChunk = '';
    let currentSection = '';

    for (const part of parts) {
        if (part.startsWith('```') && part.endsWith('```')) {
            // Flush text
            if (currentChunk.trim()) {
                chunks.push(...splitByTokens(currentChunk.trim(), sourceFile, 'doc', currentSection));
                currentChunk = '';
            }
            chunks.push(...splitByTokens(part.trim(), sourceFile, 'code', currentSection));
        } else {
            for (const line of part.split('\n')) {
                const m = line.match(/^(#{1,3})\s+(.+)/);
                if (m) currentSection = m[2].trim();
            }
            currentChunk += part;

            if (countTokens(currentChunk) > CHUNK_SIZE) {
                chunks.push(...splitByTokens(currentChunk.trim(), sourceFile, 'doc', currentSection));
                currentChunk = '';
            }
        }
    }

    if (currentChunk.trim()) {
        chunks.push(...splitByTokens(currentChunk.trim(), sourceFile, 'doc', currentSection));
    }

    return chunks;
}

function chunkCode(text, sourceFile) {
    const chunks = [];
    const boundaries = text.split(/(?=\n(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+\w+)/);
    let currentChunk = '';

    for (const block of boundaries) {
        if (countTokens(currentChunk + block) > CHUNK_SIZE && currentChunk.trim()) {
            chunks.push(...splitByTokens(currentChunk.trim(), sourceFile, 'code', ''));
            currentChunk = block;
        } else {
            currentChunk += block;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(...splitByTokens(currentChunk.trim(), sourceFile, 'code', ''));
    }

    return chunks;
}

function splitByTokens(text, sourceFile, chunkType, section) {
    if (!text.trim()) return [];

    const tokenCount = countTokens(text);
    if (tokenCount <= CHUNK_SIZE) {
        return [{
            text,
            source_file: sourceFile,
            type: chunkType,
            section,
            token_count: tokenCount,
        }];
    }

    // Split into roughly equal parts
    const words = text.split(/(\s+)/);
    const chunks = [];
    let currentWords = [];
    let currentLen = 0;
    const wordsPerChunk = Math.floor(CHUNK_SIZE / 1.3);
    const overlapWords = Math.floor(CHUNK_OVERLAP / 1.3);

    for (const word of words) {
        currentWords.push(word);
        if (!word.match(/^\s+$/)) currentLen++;

        if (currentLen >= wordsPerChunk) {
            const chunkText = currentWords.join('');
            const tc = countTokens(chunkText);
            chunks.push({
                text: chunkText,
                source_file: sourceFile,
                type: chunkType,
                section,
                token_count: tc,
            });

            // Keep overlap
            const overlapStart = Math.max(0, currentWords.length - overlapWords * 2);
            currentWords = currentWords.slice(overlapStart);
            currentLen = currentWords.filter(w => !w.match(/^\s+$/)).length;
        }
    }

    if (currentWords.length > 0) {
        const chunkText = currentWords.join('');
        if (chunkText.trim()) {
            chunks.push({
                text: chunkText,
                source_file: sourceFile,
                type: chunkType,
                section,
                token_count: countTokens(chunkText),
            });
        }
    }

    return chunks;
}

// ─── Utilities ───────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

function detectFileType(filepath) {
    const ext = path.extname(filepath).toLowerCase();
    const lower = filepath.toLowerCase();
    if (ext === '.md') {
        return (lower.includes('api') || lower.includes('reference')) ? 'api' : 'doc';
    }
    if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
        return (lower.includes('adapter') || lower.includes('lib')) ? 'api' : 'code';
    }
    if (ext === '.json') return 'config';
    return 'doc';
}

function detectLanguage(filepath) {
    return (filepath.includes('/de/') || filepath.includes('\\de\\')) ? 'de' : 'en';
}

function detectAdapterName(filepath) {
    const parts = filepath.replace(/\\/g, '/').split('/');
    for (const part of parts) {
        if (part.startsWith('ioBroker.')) return part;
        if (part === 'create-adapter') return part;
    }
    return 'iobroker-core';
}

function makeDocId(source, idx) {
    const h = crypto.createHash('md5').update(`${source}:${idx}`).digest('hex').slice(0, 12);
    return `${h}_${idx}`;
}

module.exports = RagEngine;
