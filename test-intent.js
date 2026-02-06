#!/usr/bin/env node
/**
 * Standalone Intent Parser Test Script
 * 
 * Tests the intent parser with mock ioBroker data without needing dev-server.
 * 
 * Usage:
 *   node test-intent.js "schalte den Standventilator ein"
 *   node test-intent.js "Licht im Wohnzimmer aus"
 *   node test-intent.js   # runs all built-in test cases
 */

'use strict';

const IntentParser = require('./lib/intentParser.js');
const EnumResolver = require('./lib/enumResolver.js');

// ─── Mock Data ───────────────────────────────────────────────────────────────

const MOCK_ENUMS = {
    'enum.rooms.wohnzimmer': {
        _id: 'enum.rooms.wohnzimmer',
        common: { name: 'Wohnzimmer', members: ['hue.0.light1', 'hue.0.light2', 'shelly.0.plug1'] }
    },
    'enum.rooms.schlafzimmer': {
        _id: 'enum.rooms.schlafzimmer',
        common: { name: 'Schlafzimmer', members: ['hue.0.light3', 'shelly.0.thermo1'] }
    },
    'enum.rooms.buero': {
        _id: 'enum.rooms.buero',
        common: { name: 'Büro', members: ['hue.0.light4', 'tasmota.0.fan1'] }
    },
    'enum.functions.lighting': {
        _id: 'enum.functions.lighting',
        common: { name: 'Beleuchtung', members: ['hue.0.light1', 'hue.0.light2', 'hue.0.light3', 'hue.0.light4'] }
    },
    'enum.functions.heating': {
        _id: 'enum.functions.heating',
        common: { name: 'Heizung', members: ['shelly.0.thermo1'] }
    },
};

const MOCK_STATES = {
    '0_userdata.0.Standventilator': {
        _id: '0_userdata.0.Standventilator',
        type: 'state',
        common: { name: 'Standventilator', type: 'boolean', role: 'switch', write: true }
    },
    '0_userdata.0.Kaffeemaschine': {
        _id: '0_userdata.0.Kaffeemaschine',
        type: 'state',
        common: { name: 'Kaffeemaschine', type: 'boolean', role: 'switch', write: true }
    },
    'hue.0.light1': {
        _id: 'hue.0.light1',
        type: 'state',
        common: { name: 'Stehlampe', type: 'boolean', role: 'switch.light', write: true }
    },
    'hue.0.light2': {
        _id: 'hue.0.light2',
        type: 'state',
        common: { name: 'Deckenlampe', type: 'boolean', role: 'switch.light', write: true }
    },
    'hue.0.light3': {
        _id: 'hue.0.light3',
        type: 'state',
        common: { name: 'Nachttischlampe', type: 'boolean', role: 'switch.light', write: true }
    },
    'hue.0.light4': {
        _id: 'hue.0.light4',
        type: 'state',
        common: { name: 'Schreibtischlampe', type: 'boolean', role: 'switch.light', write: true }
    },
    'shelly.0.plug1': {
        _id: 'shelly.0.plug1',
        type: 'state',
        common: { name: 'Steckdose TV', type: 'boolean', role: 'switch', write: true }
    },
    'shelly.0.thermo1': {
        _id: 'shelly.0.thermo1',
        type: 'state',
        common: { name: 'Thermostat', type: 'number', role: 'level.temperature', write: true, unit: '°C' }
    },
    'tasmota.0.fan1': {
        _id: 'tasmota.0.fan1',
        type: 'state',
        common: { name: 'Ventilator Büro', type: 'boolean', role: 'switch', write: true }
    },
};

// ─── Mock Adapter ────────────────────────────────────────────────────────────

const mockLog = {
    debug: (...args) => console.log('  [debug]', ...args),
    info: (...args) => console.log('  [info]', ...args),
    warn: (...args) => console.log('  [warn]', ...args),
    error: (...args) => console.log('  [error]', ...args),
};

const mockAdapter = {
    getForeignObjectsAsync: async (pattern, type) => {
        if (type === 'enum') {
            if (pattern.startsWith('enum.rooms')) {
                return Object.fromEntries(
                    Object.entries(MOCK_ENUMS).filter(([k]) => k.startsWith('enum.rooms'))
                );
            }
            if (pattern.startsWith('enum.functions')) {
                return Object.fromEntries(
                    Object.entries(MOCK_ENUMS).filter(([k]) => k.startsWith('enum.functions'))
                );
            }
            return MOCK_ENUMS;
        }
        if (pattern === '0_userdata.0.*') {
            return Object.fromEntries(
                Object.entries(MOCK_STATES).filter(([k]) => k.startsWith('0_userdata.0.'))
            );
        }
        return MOCK_STATES;
    },
    getForeignObjectAsync: async (id) => {
        return MOCK_STATES[id] || null;
    },
    log: mockLog,
};

// ─── Test Cases ──────────────────────────────────────────────────────────────

const TEST_CASES = [
    // Direct device name (new feature!)
    { input: 'schalte den Standventilator ein', expect: { action: 'set_on', deviceName: 'standventilator' } },
    { input: 'Kaffeemaschine aus', expect: { action: 'set_off', deviceName: 'kaffeemaschine' } },
    
    // Room + Function
    { input: 'Licht im Wohnzimmer ein', expect: { action: 'set_on', room: 'Wohnzimmer', function: 'Beleuchtung' } },
    { input: 'mach das Licht im Schlafzimmer aus', expect: { action: 'set_off', room: 'Schlafzimmer', function: 'Beleuchtung' } },
    { input: 'Schalte die Beleuchtung im Büro an', expect: { action: 'set_on', room: 'Büro', function: 'Beleuchtung' } },
    
    // With value
    { input: 'Heizung im Schlafzimmer auf 22 Grad', expect: { action: 'set_value', value: 22, unit: 'degree' } },
    { input: 'Licht im Wohnzimmer auf 50 Prozent', expect: { action: 'set_value', value: 50, unit: 'percent' } },
    
    // Increase/Decrease
    { input: 'mach das Licht im Wohnzimmer heller', expect: { action: 'increase' } },
    { input: 'dimme das Licht im Schlafzimmer', expect: { action: 'decrease' } },
    
    // Query
    { input: 'Wie warm ist es im Schlafzimmer?', expect: { action: 'query' } },
    
    // Should return null (LLM fallback)
    { input: 'schalte das Licht ein', expect: null, reason: 'no room specified' },
    { input: 'was ist der Sinn des Lebens?', expect: null, reason: 'not a smart home command' },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function runTests() {
    console.log('\n🧪 Intent Parser Test Suite\n');
    console.log('═'.repeat(60));
    
    const enumResolver = new EnumResolver({ adapter: mockAdapter, log: mockLog });
    await enumResolver.load();
    
    const parser = new IntentParser({ log: mockLog, enumResolver });
    
    let passed = 0;
    let failed = 0;
    
    for (const tc of TEST_CASES) {
        console.log(`\n📝 "${tc.input}"`);
        
        const result = await parser.parse(tc.input);
        
        if (tc.expect === null) {
            if (result === null) {
                console.log(`   ✅ PASS — returned null (${tc.reason})`);
                passed++;
            } else {
                console.log(`   ❌ FAIL — expected null, got:`, JSON.stringify(result));
                failed++;
            }
        } else {
            if (result === null) {
                console.log(`   ❌ FAIL — got null, expected:`, JSON.stringify(tc.expect));
                failed++;
            } else {
                let ok = true;
                const mismatches = [];
                
                for (const [key, val] of Object.entries(tc.expect)) {
                    if (result[key] !== val) {
                        ok = false;
                        mismatches.push(`${key}: got "${result[key]}", expected "${val}"`);
                    }
                }
                
                if (ok) {
                    console.log(`   ✅ PASS — action=${result.action}, stateIds=[${result.stateIds.join(', ')}]`);
                    passed++;
                } else {
                    console.log(`   ❌ FAIL —`, mismatches.join(', '));
                    console.log(`      Result:`, JSON.stringify(result, null, 2));
                    failed++;
                }
            }
        }
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
    
    return failed === 0;
}

async function testSingle(input) {
    console.log(`\n🧪 Testing: "${input}"\n`);
    
    const enumResolver = new EnumResolver({ adapter: mockAdapter, log: mockLog });
    await enumResolver.load();
    
    const parser = new IntentParser({ log: mockLog, enumResolver });
    const result = await parser.parse(input);
    
    console.log('\n📋 Result:');
    if (result === null) {
        console.log('   null (→ LLM fallback)');
    } else {
        console.log(JSON.stringify(result, null, 2));
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

(async () => {
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        await testSingle(args.join(' '));
    } else {
        const success = await runTests();
        process.exit(success ? 0 : 1);
    }
})();
