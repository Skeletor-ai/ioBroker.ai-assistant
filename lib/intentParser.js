'use strict';

/**
 * Fast intent parser for common smart home commands.
 * Extracts room, function, action and value from natural language
 * WITHOUT using an LLM — pure keyword/pattern matching.
 *
 * Handles ~80-90% of typical smart home voice commands in <50ms.
 * Complex queries fall through to the LLM pipeline.
 *
 * Supported intents:
 *   - SET_ON:     "Schalte das Licht im Wohnzimmer ein"
 *   - SET_OFF:    "Mach das Licht im Bad aus"
 *   - SET_VALUE:  "Stelle die Heizung im Büro auf 22 Grad"
 *   - INCREASE:   "Mach das Licht im Flur heller"
 *   - DECREASE:   "Dimme das Licht im Schlafzimmer"
 *   - QUERY:      "Wie warm ist es im Wohnzimmer?"
 */
class IntentParser {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {object} opts.enumResolver - EnumResolver instance
     */
    constructor({ log, enumResolver }) {
        this.log = log;
        this.enumResolver = enumResolver;
    }

    /**
     * Parse user text into a structured intent.
     * @param {string} text - Raw user input
     * @returns {object|null} - Parsed intent or null if not recognized
     *
     * Returns: {
     *   action: 'set_on' | 'set_off' | 'set_value' | 'increase' | 'decrease' | 'query',
     *   room: string|null,         // Matched room name
     *   function: string|null,     // Matched function name
     *   value: number|null,        // Extracted numeric value
     *   unit: string|null,         // 'percent' | 'degree' | null
     *   confidence: number,        // 0-1 confidence score
     *   stateIds: string[],        // Resolved state IDs
     * }
     */
    parse(text) {
        const lower = text.toLowerCase().trim();

        // Step 1: Detect room and function from enums
        const room = this._matchRoom(lower);
        const func = this._matchFunction(lower);

        // Need at least one context match
        if (!room && !func) return null;

        // Step 2: Detect action
        const action = this._detectAction(lower);
        if (!action) return null;

        // Step 3: Extract value if applicable
        const valueInfo = this._extractValue(lower);

        // Step 4: Resolve state IDs
        const stateIds = this.enumResolver.findStates({
            room: room?.name,
            function: func?.name,
        });

        if (stateIds.length === 0) return null;

        // Step 5: Calculate confidence
        const confidence = this._calcConfidence(room, func, action, valueInfo);

        const intent = {
            action: action.type,
            room: room?.name || null,
            function: func?.name || null,
            value: valueInfo?.value ?? null,
            unit: valueInfo?.unit ?? null,
            confidence,
            stateIds,
        };

        this.log.debug(`Intent parsed: ${JSON.stringify(intent)}`);
        return intent;
    }

    // ─── Room/Function matching ──────────────────────────────────────

    /**
     * Find matching room from user text.
     * @param {string} lower - Lowercased input
     * @returns {object|null} - { name, id } or null
     */
    _matchRoom(lower) {
        for (const [, room] of this.enumResolver.rooms) {
            const name = room.name.toLowerCase();
            const suffix = room.id.split('.').pop().toLowerCase();

            if (lower.includes(name) || lower.includes(suffix)) {
                return { name: room.name, id: room.id };
            }
        }
        return null;
    }

    /**
     * Find matching function from user text.
     * @param {string} lower - Lowercased input
     * @returns {object|null} - { name, id } or null
     */
    _matchFunction(lower) {
        for (const [, func] of this.enumResolver.functions) {
            const name = func.name.toLowerCase();
            const suffix = func.id.split('.').pop().toLowerCase();

            if (lower.includes(name) || lower.includes(suffix)) {
                return { name: func.name, id: func.id };
            }
        }
        // Also match common device synonyms
        const synonyms = {
            'licht': ['lampe', 'lampen', 'beleuchtung', 'leuchte', 'leuchten'],
            'heizung': ['thermostat', 'temperatur', 'heizkörper', 'heizen'],
            'rollladen': ['rolladen', 'rollo', 'jalousie', 'jalousien', 'beschattung'],
            'steckdose': ['stecker', 'dose'],
            'fenster': ['fensterkontakt', 'fenstersensor'],
            'tür': ['türkontakt', 'türsensor'],
        };

        for (const [funcName, syns] of Object.entries(synonyms)) {
            if (syns.some((s) => lower.includes(s))) {
                // Find matching function enum
                for (const [, func] of this.enumResolver.functions) {
                    const fLower = func.name.toLowerCase();
                    const fSuffix = func.id.split('.').pop().toLowerCase();
                    if (fLower.includes(funcName) || fSuffix.includes(funcName)) {
                        return { name: func.name, id: func.id };
                    }
                }
            }
        }

        return null;
    }

    // ─── Action detection ────────────────────────────────────────────

    /**
     * Detect the action/intent from user text.
     * @param {string} lower - Lowercased input
     * @returns {object|null} - { type, keyword }
     */
    _detectAction(lower) {
        // Order matters: check specific patterns first

        // SET_VALUE — "auf X", "stelle auf", "setze auf"
        if (this._hasValuePattern(lower)) {
            return { type: 'set_value', keyword: 'set_value' };
        }

        // INCREASE
        const increaseWords = [
            'heller', 'wärmer', 'höher', 'mehr', 'lauter', 'rauf',
            'aufdrehen', 'hochdrehen', 'erhöhe', 'erhöhen',
        ];
        for (const word of increaseWords) {
            if (lower.includes(word)) return { type: 'increase', keyword: word };
        }

        // DECREASE
        const decreaseWords = [
            'dunkler', 'kälter', 'niedriger', 'weniger', 'leiser', 'runter',
            'zudrehen', 'herunterdrehen', 'reduziere', 'reduzieren', 'dimme', 'dimmen',
        ];
        for (const word of decreaseWords) {
            if (lower.includes(word)) return { type: 'decrease', keyword: word };
        }

        // SET_ON
        const onWords = [
            'einschalten', 'anschalten', 'anmachen', 'aufmachen', 'aktivieren',
            'starten', 'öffne', 'öffnen',
        ];
        // Two-word patterns (word at end or followed by space/punctuation)
        const onEndWords = [' ein', ' an'];
        for (const word of onWords) {
            if (lower.includes(word)) return { type: 'set_on', keyword: word };
        }
        for (const word of onEndWords) {
            if (lower.endsWith(word.trim()) || lower.includes(word + ' ') || lower.includes(word + '.') || lower.includes(word + '!')) {
                return { type: 'set_on', keyword: word.trim() };
            }
        }
        // "mach ... an/ein" pattern
        if (lower.includes('mach') && (lower.endsWith('an') || lower.endsWith('ein'))) {
            return { type: 'set_on', keyword: 'mach...an' };
        }
        // "schalte ... ein" pattern
        if ((lower.includes('schalt') || lower.includes('mach')) &&
            (lower.includes(' ein') || lower.includes(' an'))) {
            return { type: 'set_on', keyword: 'schalte...ein' };
        }

        // SET_OFF
        const offWords = [
            'ausschalten', 'abschalten', 'ausmachen', 'zumachen', 'deaktivieren',
            'stoppen', 'schließe', 'schließen',
        ];
        const offEndWords = [' aus'];
        for (const word of offWords) {
            if (lower.includes(word)) return { type: 'set_off', keyword: word };
        }
        for (const word of offEndWords) {
            if (lower.endsWith(word.trim()) || lower.includes(word + ' ') || lower.includes(word + '.') || lower.includes(word + '!')) {
                return { type: 'set_off', keyword: word.trim() };
            }
        }
        // "schalte ... aus" pattern
        if ((lower.includes('schalt') || lower.includes('mach')) &&
            lower.includes(' aus')) {
            return { type: 'set_off', keyword: 'schalte...aus' };
        }

        // QUERY
        const queryPatterns = [
            'wie warm', 'wie kalt', 'wie hell', 'wie dunkel', 'wie hoch', 'wie viel',
            'wieviel', 'welche temperatur', 'was ist', 'wie ist', 'zeig', 'status',
            'ist das', 'ist die', 'ist der', 'sind die',
        ];
        for (const pattern of queryPatterns) {
            if (lower.includes(pattern)) return { type: 'query', keyword: pattern };
        }
        // Question mark indicates query
        if (lower.includes('?')) return { type: 'query', keyword: '?' };

        return null;
    }

    // ─── Value extraction ────────────────────────────────────────────

    /**
     * Check if text contains a value-setting pattern.
     */
    _hasValuePattern(lower) {
        return /(?:auf|setze|stelle|stell)\s.*?\d/.test(lower) ||
               /\d+\s*(?:prozent|grad|%|°)/.test(lower);
    }

    /**
     * Extract numeric value and unit from text.
     * @param {string} lower
     * @returns {object|null} - { value, unit }
     */
    _extractValue(lower) {
        // "auf 50 Prozent" / "auf 50%"
        let match = lower.match(/(\d+(?:[.,]\d+)?)\s*(?:prozent|%)/);
        if (match) return { value: parseFloat(match[1].replace(',', '.')), unit: 'percent' };

        // "auf 22 Grad" / "auf 22°"
        match = lower.match(/(\d+(?:[.,]\d+)?)\s*(?:grad|°)/);
        if (match) return { value: parseFloat(match[1].replace(',', '.')), unit: 'degree' };

        // "auf X" (plain number after "auf/setze/stelle")
        match = lower.match(/(?:auf|setze|stelle|stell)\s+(?:\w+\s+)*?(\d+(?:[.,]\d+)?)/);
        if (match) {
            const val = parseFloat(match[1].replace(',', '.'));
            // Guess unit based on value range
            if (val <= 100 && val > 30) return { value: val, unit: 'percent' };
            if (val >= 5 && val <= 30) return { value: val, unit: 'degree' };
            return { value: val, unit: null };
        }

        // Standalone number
        match = lower.match(/\b(\d+(?:[.,]\d+)?)\b/);
        if (match) {
            return { value: parseFloat(match[1].replace(',', '.')), unit: null };
        }

        return null;
    }

    // ─── Confidence ──────────────────────────────────────────────────

    /**
     * Calculate confidence score for parsed intent.
     */
    _calcConfidence(room, func, action, valueInfo) {
        let score = 0.3; // Base for any match

        if (room) score += 0.2;
        if (func) score += 0.2;
        if (action) score += 0.2;
        if (valueInfo && action?.type === 'set_value') score += 0.1;
        if (room && func) score += 0.1; // Both matched = higher confidence

        return Math.min(score, 1.0);
    }
}

module.exports = IntentParser;
