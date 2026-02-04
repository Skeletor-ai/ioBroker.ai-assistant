'use strict';

/**
 * Resolves ioBroker enums (rooms, functions) to find states.
 *
 * Key concept: ioBroker enums group states by room and function.
 * - enum.rooms.wohnzimmer → members: [hm-rpc.0.ABC.STATE, deconz.0.Lights.1.on, ...]
 * - enum.functions.licht  → members: [deconz.0.Lights.1.on, hue.0.Light_1.on, ...]
 *
 * Intersection: room "Wohnzimmer" + function "Licht" → only states in both enums
 *
 * This allows natural language commands like:
 * "Schalte das Licht im Wohnzimmer ein" → finds the right state IDs automatically.
 */
class EnumResolver {
    /**
     * @param {object} opts
     * @param {object} opts.log - ioBroker logger
     * @param {object} opts.adapter - ioBroker adapter instance
     */
    constructor({ log, adapter }) {
        this.log = log;
        this.adapter = adapter;

        /** @type {Map<string, {id: string, name: string, members: string[]}>} */
        this.rooms = new Map();
        /** @type {Map<string, {id: string, name: string, members: string[]}>} */
        this.functions = new Map();

        /** Reverse lookup: stateId → [roomNames] */
        this._stateToRooms = new Map();
        /** Reverse lookup: stateId → [functionNames] */
        this._stateToFunctions = new Map();

        /** All known state objects (cached for context building) */
        this._stateObjects = new Map();
    }

    /**
     * Load all enums from ioBroker. Call on adapter start and periodically.
     */
    async load() {
        const startTime = Date.now();

        // Load rooms
        this.rooms.clear();
        this._stateToRooms.clear();
        try {
            const roomObjs = await this.adapter.getForeignObjectsAsync('enum.rooms.*');
            for (const [id, obj] of Object.entries(roomObjs)) {
                if (id === 'enum.rooms') continue; // skip root
                const name = this._getName(obj);
                const members = obj.common?.members || [];
                this.rooms.set(id, { id, name, members });

                // Build reverse lookup
                for (const member of members) {
                    if (!this._stateToRooms.has(member)) this._stateToRooms.set(member, []);
                    this._stateToRooms.get(member).push(name);
                }
            }
        } catch (e) {
            this.log.warn(`Failed to load rooms: ${e.message}`);
        }

        // Load functions
        this.functions.clear();
        this._stateToFunctions.clear();
        try {
            const funcObjs = await this.adapter.getForeignObjectsAsync('enum.functions.*');
            for (const [id, obj] of Object.entries(funcObjs)) {
                if (id === 'enum.functions') continue; // skip root
                const name = this._getName(obj);
                const members = obj.common?.members || [];
                this.functions.set(id, { id, name, members });

                // Build reverse lookup
                for (const member of members) {
                    if (!this._stateToFunctions.has(member)) this._stateToFunctions.set(member, []);
                    this._stateToFunctions.get(member).push(name);
                }
            }
        } catch (e) {
            this.log.warn(`Failed to load functions: ${e.message}`);
        }

        const elapsed = Date.now() - startTime;
        this.log.info(`Enums loaded: ${this.rooms.size} rooms, ${this.functions.size} functions (${elapsed}ms)`);
    }

    /**
     * Find states matching a room and/or function by name.
     * Uses fuzzy matching on enum names.
     *
     * @param {object} opts
     * @param {string} [opts.room] - Room name (e.g. "Wohnzimmer")
     * @param {string} [opts.function] - Function name (e.g. "Licht")
     * @returns {string[]} - Matching state IDs
     */
    findStates({ room, function: func }) {
        let roomMembers = null;
        let funcMembers = null;

        if (room) {
            const match = this._findEnum(this.rooms, room);
            if (match) {
                roomMembers = new Set(match.members);
                this.log.debug(`Room "${room}" → ${match.id} (${match.members.length} members)`);
            } else {
                this.log.debug(`Room "${room}" not found in enums`);
                return [];
            }
        }

        if (func) {
            const match = this._findEnum(this.functions, func);
            if (match) {
                funcMembers = new Set(match.members);
                this.log.debug(`Function "${func}" → ${match.id} (${match.members.length} members)`);
            } else {
                this.log.debug(`Function "${func}" not found in enums`);
                return [];
            }
        }

        // Intersection
        if (roomMembers && funcMembers) {
            return [...roomMembers].filter((id) => funcMembers.has(id));
        }
        if (roomMembers) return [...roomMembers];
        if (funcMembers) return [...funcMembers];
        return [];
    }

    /**
     * Build a context string with state values for given state IDs.
     * Reads current values and formats them for LLM consumption.
     *
     * @param {string[]} stateIds
     * @param {object} [opts]
     * @param {number} [opts.maxStates=30]
     * @returns {Promise<string>}
     */
    async buildStateContext(stateIds, opts = {}) {
        const maxStates = opts.maxStates || 30;
        const lines = [];

        for (const stateId of stateIds.slice(0, maxStates)) {
            try {
                const state = await this.adapter.getForeignStateAsync(stateId);
                const obj = await this.adapter.getForeignObjectAsync(stateId);
                if (!obj) continue;

                const name = this._getName(obj);
                const unit = obj.common?.unit || '';
                const val = state ? state.val : 'N/A';
                const type = obj.common?.type || 'unknown';
                const writable = obj.common?.write !== false;
                const role = obj.common?.role || '';

                // Include room/function info
                const rooms = this._stateToRooms.get(stateId) || [];
                const funcs = this._stateToFunctions.get(stateId) || [];

                lines.push(
                    `- **${name}** (ID: \`${stateId}\`)` +
                    `\n  Wert: ${val}${unit ? ' ' + unit : ''}` +
                    ` | Typ: ${type}` +
                    (writable ? ' | schreibbar' : ' | nur lesen') +
                    (role ? ` | Rolle: ${role}` : '') +
                    (rooms.length ? ` | Raum: ${rooms.join(', ')}` : '') +
                    (funcs.length ? ` | Funktion: ${funcs.join(', ')}` : ''),
                );
            } catch (e) {
                this.log.debug(`Failed to read state ${stateId}: ${e.message}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get a summary of all available rooms and functions (for the system prompt).
     * @returns {string}
     */
    getSummary() {
        const lines = [];

        if (this.rooms.size > 0) {
            lines.push('### Verfügbare Räume');
            for (const [, room] of this.rooms) {
                lines.push(`- ${room.name} (${room.members.length} Geräte)`);
            }
        }

        if (this.functions.size > 0) {
            lines.push('\n### Verfügbare Funktionen');
            for (const [, func] of this.functions) {
                lines.push(`- ${func.name} (${func.members.length} Geräte)`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get all writable state IDs from given states (for allowedActions).
     * @param {string[]} stateIds
     * @returns {Promise<string[]>}
     */
    async getWritableStates(stateIds) {
        const writable = [];
        for (const id of stateIds) {
            try {
                const obj = await this.adapter.getForeignObjectAsync(id);
                if (obj && obj.common?.write !== false) {
                    writable.push(id);
                }
            } catch (_) {}
        }
        return writable;
    }

    // ─── Private ─────────────────────────────────────────────────────

    /**
     * Fuzzy match an enum by name.
     * Tries: exact match → lowercase match → includes match → ID suffix match.
     * @param {Map} enumMap
     * @param {string} searchName
     * @returns {object|null}
     */
    _findEnum(enumMap, searchName) {
        const search = searchName.toLowerCase().trim();

        // 1. Exact name match
        for (const [, entry] of enumMap) {
            if (entry.name.toLowerCase() === search) return entry;
        }

        // 2. Name includes search term
        for (const [, entry] of enumMap) {
            if (entry.name.toLowerCase().includes(search)) return entry;
        }

        // 3. Search term includes name
        for (const [, entry] of enumMap) {
            if (search.includes(entry.name.toLowerCase())) return entry;
        }

        // 4. ID suffix match (e.g. "wohnzimmer" matches "enum.rooms.wohnzimmer")
        for (const [id, entry] of enumMap) {
            const suffix = id.split('.').pop().toLowerCase();
            if (suffix === search || suffix.includes(search) || search.includes(suffix)) {
                return entry;
            }
        }

        return null;
    }

    /**
     * Get display name from ioBroker object (handles multilingual names).
     * @param {object} obj
     * @returns {string}
     */
    _getName(obj) {
        const name = obj?.common?.name;
        if (!name) return obj?._id || 'Unbekannt';
        if (typeof name === 'string') return name;
        return name.de || name.en || Object.values(name)[0] || obj._id;
    }
}

module.exports = EnumResolver;
