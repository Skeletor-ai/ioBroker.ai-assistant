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
            const roomObjs = await this.adapter.getForeignObjectsAsync('enum.rooms.*', 'enum');
            this.log.debug(`getForeignObjects enum.rooms.* returned ${Object.keys(roomObjs).length} objects: ${Object.keys(roomObjs).join(', ')}`);
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
            const funcObjs = await this.adapter.getForeignObjectsAsync('enum.functions.*', 'enum');
            this.log.debug(`getForeignObjects enum.functions.* returned ${Object.keys(funcObjs).length} objects: ${Object.keys(funcObjs).join(', ')}`);
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

        // Intersection with parent-match support:
        // If room has "deconz.0.Groups.23" (device level) and function has
        // "deconz.0.Groups.23.on" (state level), they should match.
        // A member matches if it equals OR is a child/parent of the other.
        if (roomMembers && funcMembers) {
            const result = [];
            for (const rId of roomMembers) {
                if (funcMembers.has(rId)) {
                    // Exact match
                    result.push(rId);
                } else {
                    // Check if any funcMember is a child of this roomMember
                    for (const fId of funcMembers) {
                        if (fId.startsWith(rId + '.')) {
                            result.push(fId);
                        }
                    }
                }
            }
            // Also check reverse: funcMember is parent of roomMember
            for (const fId of funcMembers) {
                for (const rId of roomMembers) {
                    if (rId.startsWith(fId + '.') && !result.includes(rId)) {
                        result.push(rId);
                    }
                }
            }
            return result;
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

    // ─── Direct device name search ──────────────────────────────────

    /**
     * Search for states by device/object name in user text.
     * Searches all known states (from enums + 0_userdata.*) for matching names.
     * Returns matches only if exactly ONE state matches (unambiguous).
     *
     * @param {string} userText - User input text
     * @returns {Promise<{stateId: string, deviceName: string}|null>}
     */
    async searchByDeviceName(userText) {
        const lower = userText.toLowerCase();
        const matches = [];

        // Collect all candidate states: enum members + 0_userdata.*
        const candidateIds = new Set();

        // From enums
        for (const [, room] of this.rooms) {
            for (const id of room.members) candidateIds.add(id);
        }
        for (const [, func] of this.functions) {
            for (const id of func.members) candidateIds.add(id);
        }

        // Also check 0_userdata.* for manually created states
        try {
            const userStates = await this.adapter.getForeignObjectsAsync('0_userdata.0.*', 'state');
            for (const id of Object.keys(userStates)) {
                candidateIds.add(id);
            }
        } catch (e) {
            this.log.debug(`Failed to load 0_userdata states: ${e.message}`);
        }

        // Search each candidate for name match
        for (const stateId of candidateIds) {
            const names = new Set();
            await this._collectHierarchyNames(stateId, names);

            // Check if any significant name appears in user text
            for (const name of names) {
                if (name.length < 4) continue; // Skip short names to avoid false positives
                if (lower.includes(name)) {
                    matches.push({ stateId, deviceName: name, nameLength: name.length });
                    break; // One match per state is enough
                }
            }
        }

        // Only return if exactly ONE state matches (unambiguous)
        if (matches.length === 1) {
            this.log.debug(`Direct device name match: "${matches[0].deviceName}" → ${matches[0].stateId}`);
            return { stateId: matches[0].stateId, deviceName: matches[0].deviceName };
        }

        if (matches.length > 1) {
            // Multiple matches — try to find the best one (longest name match = most specific)
            matches.sort((a, b) => b.nameLength - a.nameLength);
            const best = matches[0];
            const secondBest = matches[1];

            // If best match is significantly longer, use it
            if (best.nameLength > secondBest.nameLength + 2) {
                this.log.debug(`Direct device name match (best of ${matches.length}): "${best.deviceName}" → ${best.stateId}`);
                return { stateId: best.stateId, deviceName: best.deviceName };
            }

            this.log.debug(`Ambiguous device name matches (${matches.length}): ${matches.map(m => m.deviceName).join(', ')}`);
        }

        return null;
    }

    // ─── Device name filtering ───────────────────────────────────────

    /**
     * Filter state IDs by matching device/channel names against user text.
     * Only filters when a discriminating name is found (matches some but not all states).
     * This narrows "Licht im Wohnzimmer" to "Stehlampe" when user specifies a device.
     *
     * @param {string[]} stateIds - Candidate state IDs from room+function intersection
     * @param {string} userText - Lowercased user input
     * @returns {Promise<{stateIds: string[], deviceName: string|null}>}
     */
    async filterByDeviceName(stateIds, userText) {
        if (stateIds.length <= 1) return { stateIds, deviceName: null };

        const lower = userText.toLowerCase();

        // Collect significant names for each state (from object hierarchy)
        const stateNameSets = new Map();
        const allNames = new Set();

        for (const stateId of stateIds) {
            const names = new Set();
            await this._collectHierarchyNames(stateId, names);
            stateNameSets.set(stateId, names);
            for (const n of names) allNames.add(n);
        }

        // For each name that appears in user text, track which states own it
        const nameToOwners = new Map();

        for (const name of allNames) {
            if (name.length < 3) continue;
            if (!lower.includes(name)) continue;

            const owners = [];
            for (const [stateId, names] of stateNameSets) {
                if (names.has(name)) owners.push(stateId);
            }
            nameToOwners.set(name, owners);
        }

        // Find the most discriminating name: matches SOME but not ALL states.
        // Prefer longer names (more specific) over shorter ones.
        let bestName = null;
        let bestOwners = null;

        for (const [name, owners] of nameToOwners) {
            if (owners.length === 0 || owners.length === stateIds.length) continue;
            if (!bestOwners ||
                name.length > bestName.length ||
                (name.length === bestName.length && owners.length < bestOwners.length)) {
                bestName = name;
                bestOwners = owners;
            }
        }

        if (bestOwners) {
            this.log.debug(`Device name filter: "${bestName}" → ${bestOwners.length}/${stateIds.length} states`);
            return { stateIds: bestOwners, deviceName: bestName };
        }

        return { stateIds, deviceName: null };
    }

    /**
     * Collect significant names from state + parent channel + parent device objects.
     * Adds lowercased full names and significant sub-words to the set.
     * @param {string} stateId
     * @param {Set<string>} names - Output set
     * @private
     */
    async _collectHierarchyNames(stateId, names) {
        const genericWords = new Set([
            'state', 'status', 'value', 'wert', 'set', 'get', 'on', 'off',
            'level', 'switch', 'sensor', 'true', 'false', 'brightness',
            'reachable', 'battery', 'alive', 'connected', 'working',
        ]);

        const addName = (fullName) => {
            if (!fullName || fullName.length < 2) return;
            const low = fullName.toLowerCase();
            if (!genericWords.has(low)) names.add(low);
            // Also add significant individual words
            for (const word of low.split(/[\s_\-\.]+/)) {
                if (word.length >= 3 && !genericWords.has(word)) {
                    names.add(word);
                }
            }
        };

        // State object itself
        try {
            const obj = await this.adapter.getForeignObjectAsync(stateId);
            if (obj) addName(this._getName(obj));
        } catch (_) { /* ignore */ }

        // Parent channel (e.g., deconz.0.Lights.Stehlampe from .../Stehlampe.on)
        const parts = stateId.split('.');
        if (parts.length > 2) {
            const channelId = parts.slice(0, -1).join('.');
            try {
                const obj = await this.adapter.getForeignObjectAsync(channelId);
                if (obj) addName(this._getName(obj));
            } catch (_) { /* ignore */ }
            // ID segment often contains the device name
            const seg = parts[parts.length - 2];
            if (seg && seg.length >= 3 && !genericWords.has(seg.toLowerCase())) {
                names.add(seg.toLowerCase());
            }
        }

        // Parent device (one more level up)
        if (parts.length > 3) {
            const deviceId = parts.slice(0, -2).join('.');
            try {
                const obj = await this.adapter.getForeignObjectAsync(deviceId);
                if (obj) addName(this._getName(obj));
            } catch (_) { /* ignore */ }
        }
    }

    // ─── Private ─────────────────────────────────────────────────────

    /**
     * Fuzzy match an enum by name.
     * Tries: exact match → includes match → ID suffix → alias groups.
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

        // 5. Alias groups — bidirectional matching
        const aliasGroups = [
            // Functions
            ['licht', 'lampe', 'lampen', 'beleuchtung', 'leuchte', 'leuchten', 'lighting', 'light'],
            ['heizung', 'thermostat', 'temperatur', 'heizkörper', 'heizen', 'heating'],
            ['rollladen', 'rolladen', 'rollo', 'jalousie', 'jalousien', 'beschattung', 'shutter', 'blind', 'blinds'],
            ['steckdose', 'stecker', 'dose', 'socket', 'outlet'],
            ['fenster', 'fensterkontakt', 'fenstersensor', 'window'],
            ['tür', 'türkontakt', 'türsensor', 'door'],
            ['ventilator', 'lüfter', 'fan'],
            // Rooms
            ['wohnzimmer', 'wohnraum', 'stube', 'living_room', 'livingroom'],
            ['schlafzimmer', 'bedroom', 'schlafraum'],
            ['badezimmer', 'bad', 'bathroom'],
            ['küche', 'kueche', 'kitchen'],
            ['büro', 'buero', 'arbeitszimmer', 'office'],
            ['kinderzimmer', 'children', 'kids'],
            ['flur', 'diele', 'gang', 'corridor', 'hallway'],
            ['esszimmer', 'essbereich', 'dining'],
        ];

        // Find which group the search term belongs to
        for (const group of aliasGroups) {
            if (!group.some((alias) => alias.includes(search) || search.includes(alias))) continue;
            // Search matches this group — now check if any enum name/ID matches
            for (const [id, entry] of enumMap) {
                const eName = entry.name.toLowerCase();
                const eSuffix = id.split('.').pop().toLowerCase();
                if (group.some((alias) => eName.includes(alias) || alias.includes(eName) ||
                                          eSuffix.includes(alias) || alias.includes(eSuffix))) {
                    this.log.debug(`Alias match: "${search}" → ${entry.name} via group [${group.join(', ')}]`);
                    return entry;
                }
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
