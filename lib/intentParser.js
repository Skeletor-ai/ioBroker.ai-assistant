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
    async parse(text) {
        const lower = text.toLowerCase().trim();

        // Step 1: Detect room and function from enums FIRST
        // Room+Function matching has priority over direct device name
        const room = this._matchRoom(lower);
        const func = this._matchFunction(lower);

        // Step 2: If we have BOTH room AND function, use that path (skip direct device search)
        // This prevents "Büro" in "Ventilator Büro" from hijacking "Licht im Büro"
        if (!room || !func) {
            // Step 2b: Try direct device name search as fallback
            // Only if we DON'T have both room+function
            const directMatch = await this.enumResolver.searchByDeviceName(lower);
            if (directMatch) {
                const action = this._detectAction(lower);
                if (action) {
                    const valueInfo = this._extractValue(lower);
                    const intent = {
                        action: action.type,
                        room: null,
                        function: null,
                        deviceName: directMatch.deviceName,
                        value: valueInfo?.value ?? null,
                        unit: valueInfo?.unit ?? null,
                        confidence: 0.85, // High confidence for unique device match
                        stateIds: [directMatch.stateId],
                    };
                    this.log.debug(`Intent parsed (direct device): ${JSON.stringify(intent)}`);
                    return intent;
                }
            }
        }

        // Need at least one context match
        if (!room && !func) return null;

        // SAFETY: For non-query actions, require BOTH room AND function.
        // Without a function, we'd switch everything in the room — too dangerous.
        // Only queries (read-only) are allowed with just a room.
        const action = this._detectAction(lower);
        if (!action) return null;

        if (action.type !== 'query' && (!room || !func)) {
            this.log.debug(`Intent safety: action=${action.type} needs both room and function (room=${room?.name || 'none'}, func=${func?.name || 'none'}) — falling through to LLM`);
            return null;
        }

        // Step 3: Extract value if applicable
        const valueInfo = this._extractValue(lower);

        // Step 4: Resolve state IDs
        let stateIds = this.enumResolver.findStates({
            room: room?.name,
            function: func?.name,
        });

        if (stateIds.length === 0) return null;

        // Step 5: Filter by device name if user specified one
        // e.g. "Schalte die Stehlampe im Wohnzimmer ein" → only Stehlampe, not all lights
        let deviceName = null;
        if (stateIds.length > 1) {
            const filtered = await this.enumResolver.filterByDeviceName(stateIds, lower);
            stateIds = filtered.stateIds;
            deviceName = filtered.deviceName;
        }

        // Step 6: Calculate confidence
        const confidence = this._calcConfidence(room, func, action, valueInfo);
        // Device name match increases confidence
        if (deviceName) {
            // Bump confidence for specific device targeting
        }

        const intent = {
            action: action.type,
            room: room?.name || null,
            function: func?.name || null,
            deviceName,
            value: valueInfo?.value ?? null,
            unit: valueInfo?.unit ?? null,
            confidence: Math.min(deviceName ? confidence + 0.05 : confidence, 1.0),
            stateIds,
        };

        this.log.debug(`Intent parsed: ${JSON.stringify(intent)}`);
        return intent;
    }

    // ─── Room/Function matching ──────────────────────────────────────

    /**
     * Find matching room from user text.
     * Uses alias groups and word-boundary-aware matching.
     * @param {string} lower - Lowercased input
     * @returns {object|null} - { name, id } or null
     */
    _matchRoom(lower) {
        // Room alias groups for common German room names
        const roomAliases = [
            ['wohnzimmer', 'wohnraum', 'stube', 'living_room', 'living room', 'livingroom'],
            ['schlafzimmer', 'bedroom', 'schlafraum'],
            ['badezimmer', 'bad', 'bathroom', 'bath'],
            ['küche', 'kueche', 'kitchen'],
            ['büro', 'buero', 'arbeitszimmer', 'office'],
            ['kinderzimmer', 'children', 'kids'],
            ['flur', 'diele', 'gang', 'corridor', 'hallway'],
            ['keller', 'basement'],
            ['dachboden', 'dachgeschoss', 'attic'],
            ['garten', 'garden', 'terrasse', 'balkon'],
            ['garage', 'carport'],
            ['esszimmer', 'essbereich', 'dining'],
            ['gästezimmer', 'gäste', 'guest'],
        ];

        // 1. Direct match: enum name or ID suffix in user text
        for (const [, room] of this.enumResolver.rooms) {
            const name = room.name.toLowerCase();
            const suffix = room.id.split('.').pop().toLowerCase();

            if (lower.includes(name) || lower.includes(suffix)) {
                return { name: room.name, id: room.id };
            }
        }

        // 2. Alias-based match
        for (const group of roomAliases) {
            const userHit = group.some((alias) => lower.includes(alias));
            if (!userHit) continue;

            for (const [, room] of this.enumResolver.rooms) {
                const rName = room.name.toLowerCase();
                const rSuffix = room.id.split('.').pop().toLowerCase();
                if (group.some((alias) => rName.includes(alias) || rSuffix.includes(alias))) {
                    this.log.debug(`Room alias match: user text hit group [${group.join(', ')}] → ${room.name} (${room.id})`);
                    return { name: room.name, id: room.id };
                }
            }
        }

        return null;
    }

    /**
     * Find matching function from user text.
     * Uses alias groups for bidirectional matching:
     * "Licht" matches "Beleuchtung" and vice versa.
     * @param {string} lower - Lowercased input
     * @returns {object|null} - { name, id } or null
     */
    _matchFunction(lower) {
        // Alias groups: all terms in a group are equivalent.
        // If user says ANY term and enum name/ID contains ANY term → match.
        const aliasGroups = [
            ['licht', 'lampe', 'lampen', 'beleuchtung', 'leuchte', 'leuchten', 'lighting', 'light'],
            ['heizung', 'thermostat', 'temperatur', 'heizkörper', 'heizen', 'heating'],
            ['rollladen', 'rolladen', 'rollo', 'jalousie', 'jalousien', 'beschattung', 'shutter', 'blind', 'blinds'],
            ['steckdose', 'stecker', 'dose', 'socket', 'outlet'],
            ['fenster', 'fensterkontakt', 'fenstersensor', 'window'],
            ['tür', 'türkontakt', 'türsensor', 'door'],
            ['ventilator', 'lüfter', 'fan'],
            ['musik', 'audio', 'lautsprecher', 'speaker', 'media'],
        ];

        // 1. Direct match: enum name or ID suffix in user text
        for (const [, func] of this.enumResolver.functions) {
            const name = func.name.toLowerCase();
            const suffix = func.id.split('.').pop().toLowerCase();

            if (lower.includes(name) || lower.includes(suffix)) {
                return { name: func.name, id: func.id };
            }
        }

        // 2. Alias-based match: find which alias group the user text hits,
        //    then check if any enum matches any term in that group.
        for (const group of aliasGroups) {
            const userHit = group.some((alias) => lower.includes(alias));
            if (!userHit) continue;

            for (const [, func] of this.enumResolver.functions) {
                const fName = func.name.toLowerCase();
                const fSuffix = func.id.split('.').pop().toLowerCase();
                if (group.some((alias) => fName.includes(alias) || fSuffix.includes(alias))) {
                    this.log.debug(`Function alias match: user text hit group [${group.join(', ')}] → ${func.name} (${func.id})`);
                    return { name: func.name, id: func.id };
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
        // "schalte ... ein/an" pattern (with typo tolerance)
        if (this._hasSwitchVerb(lower) &&
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
        // "schalte ... aus" pattern (with typo tolerance)
        if (this._hasSwitchVerb(lower) && lower.includes(' aus')) {
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

    // ─── Helpers ─────────────────────────────────────────────────────

    /**
     * Check if text contains a "schalten/machen" verb (with typo tolerance).
     * Covers: schalte, schalt, schalten, mach, mache, macht
     * Typos:  schsalte, shcalte, scalte, etc.
     */
    _hasSwitchVerb(lower) {
        // Exact matches first
        if (lower.includes('schalt') || lower.includes('mach')) return true;
        // Common typos for "schalte": extract words and check Levenshtein
        const words = lower.split(/\s+/);
        const targets = ['schalte', 'schalten', 'schalt'];
        for (const word of words) {
            for (const target of targets) {
                if (this._levenshtein(word, target) <= 2) return true;
            }
        }
        return false;
    }

    /**
     * Simple Levenshtein distance for typo tolerance.
     */
    _levenshtein(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                const cost = a[j - 1] === b[i - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost,
                );
            }
        }
        return matrix[b.length][a.length];
    }
}

module.exports = IntentParser;
