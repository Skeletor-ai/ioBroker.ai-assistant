'use strict';

/**
 * Standalone test: Dual-model tool calling with Ollama.
 * Tests functiongemma (tool selection) + phi3:mini (response generation).
 * No ioBroker required — simulates adapter states.
 */

const http = require('http');

const OLLAMA_URL = 'http://localhost:11434';
const TOOL_MODEL = 'functiongemma';
const MAIN_MODEL = 'phi3:mini';

// ── Simulated Smart Home States ──────────────────────────────────

const fakeStates = {
    'hm-rpc.0.wohnzimmer.TEMPERATURE': { val: 21.5, type: 'number', unit: '°C', name: 'Wohnzimmer Temperatur' },
    'hm-rpc.0.wohnzimmer.SET_POINT_TEMPERATURE': { val: 20, type: 'number', unit: '°C', name: 'Wohnzimmer Sollwert', writable: true },
    'hm-rpc.0.schlafzimmer.TEMPERATURE': { val: 18.2, type: 'number', unit: '°C', name: 'Schlafzimmer Temperatur' },
    'hm-rpc.0.schlafzimmer.SET_POINT_TEMPERATURE': { val: 18, type: 'number', unit: '°C', name: 'Schlafzimmer Sollwert', writable: true },
    'hue.0.wohnzimmer.on': { val: false, type: 'boolean', name: 'Wohnzimmer Licht', writable: true },
    'hue.0.wohnzimmer.brightness': { val: 50, type: 'number', unit: '%', name: 'Wohnzimmer Helligkeit', writable: true },
    'hue.0.kueche.on': { val: true, type: 'boolean', name: 'Küche Licht', writable: true },
};

// ── Tool Definitions ─────────────────────────────────────────────

const tools = [
    {
        type: 'function',
        function: {
            name: 'setState',
            description: 'Set an ioBroker state value. Allowed: hm-rpc.0.*.SET_POINT_TEMPERATURE (Thermostat), hue.0.*.on (Licht), hue.0.*.brightness (Helligkeit)',
            parameters: {
                type: 'object',
                properties: {
                    stateId: { type: 'string', description: 'Full ioBroker state ID' },
                    value: { description: 'Value to set' },
                },
                required: ['stateId', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'getState',
            description: 'Read the current value of an ioBroker state.',
            parameters: {
                type: 'object',
                properties: {
                    stateId: { type: 'string', description: 'Full ioBroker state ID to read' },
                },
                required: ['stateId'],
            },
        },
    },
];

// ── Tool Executor ────────────────────────────────────────────────

function executeToolCall(name, args) {
    if (name === 'getState') {
        const state = fakeStates[args.stateId];
        if (!state) return JSON.stringify({ error: `State not found: ${args.stateId}` });
        return JSON.stringify({ stateId: args.stateId, name: state.name, value: state.val, unit: state.unit || '' });
    }
    if (name === 'setState') {
        const state = fakeStates[args.stateId];
        if (!state) return JSON.stringify({ error: `State not found: ${args.stateId}` });
        if (!state.writable) return JSON.stringify({ error: `State not writable: ${args.stateId}` });
        const oldVal = state.val;
        state.val = args.value;
        console.log(`  ✅ setState: ${state.name} (${args.stateId}): ${oldVal} → ${args.value}`);
        return JSON.stringify({ success: true, stateId: args.stateId, name: state.name, value: args.value });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ── HTTP helper ──────────────────────────────────────────────────

function ollamaChat(model, messages, useTools = false) {
    return new Promise((resolve, reject) => {
        const payload = { model, messages, stream: false };
        if (useTools) payload.tools = tools;
        const body = JSON.stringify(payload);

        const req = http.request(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 120000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

// ── System Prompt ────────────────────────────────────────────────

const systemPrompt = `Du bist ein Smart-Home-Assistent. Du steuerst Geräte über ioBroker.

## Aktuelle Werte
- Wohnzimmer Temperatur: 21.5°C (Sollwert: 20°C)
- Schlafzimmer Temperatur: 18.2°C (Sollwert: 18°C)
- Wohnzimmer Licht: aus (Helligkeit: 50%)
- Küche Licht: an

## Erlaubte Aktionen
- hm-rpc.0.wohnzimmer.SET_POINT_TEMPERATURE (Wohnzimmer Thermostat)
- hm-rpc.0.schlafzimmer.SET_POINT_TEMPERATURE (Schlafzimmer Thermostat)
- hue.0.wohnzimmer.on (Wohnzimmer Licht an/aus)
- hue.0.wohnzimmer.brightness (Wohnzimmer Helligkeit 0-100%)
- hue.0.kueche.on (Küche Licht an/aus)

Antworte kurz auf Deutsch.`;

// ── Test Runner ──────────────────────────────────────────────────

async function runTest(testName, userMessage) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🧪 Test: ${testName}`);
    console.log(`💬 User: "${userMessage}"`);
    console.log('─'.repeat(60));

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];
    const allToolCalls = [];

    // Phase 1: Tool Calling with functiongemma
    console.log(`\n🔧 Phase 1: Tool Calling (${TOOL_MODEL})`);
    for (let round = 0; round < 5; round++) {
        const resp = await ollamaChat(TOOL_MODEL, messages, true);
        const msg = resp.message || {};
        const calls = msg.tool_calls || [];

        if (calls.length === 0) {
            console.log(`  → Keine Tool Calls (Text: "${(msg.content || '').slice(0, 80)}")`);
            break;
        }

        messages.push(msg);

        for (const call of calls) {
            const fn = call.function || {};
            const name = fn.name;
            const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {});
            console.log(`  🔨 ${name}(${JSON.stringify(args)})`);
            allToolCalls.push({ name, args });

            const result = executeToolCall(name, args);
            messages.push({ role: 'tool', content: result });
        }
    }

    // Phase 2: Response generation with main model
    console.log(`\n💬 Phase 2: Antwort-Generierung (${MAIN_MODEL})`);
    const actionSummary = allToolCalls.length > 0
        ? allToolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(', ')
        : 'keine Aktionen ausgeführt';

    const responseMessages = [
        { role: 'system', content: `${systemPrompt}\n\n## Ausgeführte Aktionen\n${actionSummary}\n\nAntworte dem Benutzer kurz und natürlich auf Deutsch. Bestätige was du getan hast.` },
        { role: 'user', content: userMessage },
    ];

    const finalResp = await ollamaChat(MAIN_MODEL, responseMessages, false);
    const answer = finalResp.message?.content || '(keine Antwort)';
    console.log(`  🗣️  "${answer}"`);

    console.log(`\n📊 Ergebnis: ${allToolCalls.length} Tool Call(s)`);
    return { toolCalls: allToolCalls, answer };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
    console.log('🏠 AI Assistant — Tool Calling Test');
    console.log(`   Tool Model: ${TOOL_MODEL}`);
    console.log(`   Main Model: ${MAIN_MODEL}`);
    console.log(`   Ollama: ${OLLAMA_URL}`);

    // Check models
    try {
        const tagsResp = await new Promise((resolve, reject) => {
            http.get(`${OLLAMA_URL}/api/tags`, (res) => {
                let d = '';
                res.on('data', (c) => { d += c; });
                res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        const models = tagsResp.models.map((m) => m.name);
        console.log(`   Verfügbare Modelle: ${models.join(', ')}`);
        if (!models.some((m) => m.startsWith(TOOL_MODEL))) {
            console.error(`\n❌ ${TOOL_MODEL} nicht gefunden! Bitte erst: ollama pull ${TOOL_MODEL}`);
            process.exit(1);
        }
        if (!models.some((m) => m.startsWith(MAIN_MODEL))) {
            console.error(`\n❌ ${MAIN_MODEL} nicht gefunden! Bitte erst: ollama pull ${MAIN_MODEL}`);
            process.exit(1);
        }
    } catch (e) {
        console.error(`\n❌ Ollama nicht erreichbar: ${e.message}`);
        process.exit(1);
    }

    try {
        await runTest('Heizung hochdrehen', 'Stell die Heizung im Wohnzimmer auf 22 Grad.');
        await runTest('Licht einschalten', 'Mach das Licht im Wohnzimmer an.');
        await runTest('Status abfragen', 'Wie warm ist es im Schlafzimmer?');
    } catch (e) {
        console.error(`\n❌ Fehler: ${e.message}`);
    }
}

main();
