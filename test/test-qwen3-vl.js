'use strict';

const http = require('http');

const OLLAMA_URL = 'http://localhost:11434';
const TOOL_MODEL = 'functiongemma';
const MAIN_MODEL = 'qwen3-vl:4b';

const fakeStates = {
    'hm-rpc.0.wohnzimmer.TEMPERATURE': { val: 21.5, type: 'number', unit: '°C', name: 'Wohnzimmer Temperatur' },
    'hm-rpc.0.wohnzimmer.SET_POINT_TEMPERATURE': { val: 20, type: 'number', unit: '°C', name: 'Wohnzimmer Sollwert', writable: true },
    'hm-rpc.0.schlafzimmer.TEMPERATURE': { val: 18.2, type: 'number', unit: '°C', name: 'Schlafzimmer Temperatur' },
    'hm-rpc.0.schlafzimmer.SET_POINT_TEMPERATURE': { val: 18, type: 'number', unit: '°C', name: 'Schlafzimmer Sollwert', writable: true },
    'hue.0.wohnzimmer.on': { val: false, type: 'boolean', name: 'Wohnzimmer Licht', writable: true },
    'hue.0.wohnzimmer.brightness': { val: 50, type: 'number', unit: '%', name: 'Wohnzimmer Helligkeit', writable: true },
    'hue.0.kueche.on': { val: true, type: 'boolean', name: 'Küche Licht', writable: true },
};

const tools = [
    {
        type: 'function',
        function: {
            name: 'setState',
            description: 'Set an ioBroker state value.',
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
        return JSON.stringify({ success: true, stateId: args.stateId, name: state.name, oldValue: oldVal, newValue: args.value });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
}

function ollamaChat(model, messages, useTools = false) {
    return new Promise((resolve, reject) => {
        const payload = { model, messages, stream: false, options: { num_predict: 256 } };
        // Disable thinking for qwen3-vl (otherwise too slow on CPU)
        if (model.includes('qwen3-vl')) payload.think = false;
        if (useTools) payload.tools = tools;
        const body = JSON.stringify(payload);
        const req = http.request(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 300000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 500)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

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
    console.log(`\n🔧 Phase 1: Tool Selection (${TOOL_MODEL})`);
    const t1Start = Date.now();
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
    const t1End = Date.now();
    console.log(`  ⏱️  Tool Selection: ${((t1End - t1Start) / 1000).toFixed(1)}s`);

    // Phase 2: Response generation with qwen3-vl
    console.log(`\n💬 Phase 2: Antwort-Generierung (${MAIN_MODEL})`);
    const actionSummary = allToolCalls.length > 0
        ? allToolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(', ')
        : 'keine Aktionen ausgeführt';

    const responsePrompt = `${systemPrompt}\n\n## Ausgeführte Aktionen\n${actionSummary}\n\nAntworte dem Benutzer kurz und natürlich auf Deutsch. Bestätige was du getan hast.`;

    console.log(`\n📝 System-Prompt (gekürzt):\n  "${responsePrompt.slice(0, 200)}..."`);

    const t2Start = Date.now();
    const finalResp = await ollamaChat(MAIN_MODEL, [
        { role: 'system', content: responsePrompt },
        { role: 'user', content: userMessage },
    ], false);
    const t2End = Date.now();

    const answer = finalResp.message?.content || '(keine Antwort)';
    const evalCount = finalResp.eval_count || 0;
    const evalDuration = finalResp.eval_duration ? (finalResp.eval_duration / 1e9).toFixed(1) : '?';
    const tokPerSec = (finalResp.eval_count && finalResp.eval_duration) 
        ? (finalResp.eval_count / (finalResp.eval_duration / 1e9)).toFixed(1) 
        : '?';

    console.log(`\n  🗣️  "${answer}"`);
    console.log(`\n  ⏱️  Antwort-Generierung: ${((t2End - t2Start) / 1000).toFixed(1)}s`);
    console.log(`  📊 Tokens: ${evalCount} | Eval: ${evalDuration}s | Speed: ${tokPerSec} tok/s`);
    console.log(`  ⏱️  Gesamt: ${((t2End - t1Start) / 1000).toFixed(1)}s | Tool Calls: ${allToolCalls.length}`);
}

async function main() {
    console.log('🏠 AI Assistant — qwen3-vl:4b Benchmark');
    console.log(`   Tool Model: ${TOOL_MODEL}`);
    console.log(`   Main Model: ${MAIN_MODEL}`);
    console.log(`   Ollama: ${OLLAMA_URL}\n`);

    try {
        await runTest('Status abfragen', 'Wie warm ist es im Schlafzimmer?');
        await runTest('Heizung hochdrehen', 'Stell die Heizung im Wohnzimmer auf 22 Grad.');
        await runTest('Licht einschalten', 'Mach das Licht im Wohnzimmer an und stell die Helligkeit auf 80%.');
    } catch (e) {
        console.error(`\n❌ Fehler: ${e.message}`);
    }
}

main();
