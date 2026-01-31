'use strict';

/**
 * Prompt template engine.
 * Templates define: system prompt, context sources (ioBroker states),
 * allowed actions (writable states), and response format.
 *
 * Template structure:
 * {
 *   id: 'heating',
 *   name: 'Heizungssteuerung',
 *   description: 'Heizung per Sprache steuern',
 *   systemPrompt: 'Du steuerst die Heizung. Verfügbare Geräte:\n{context}',
 *   contextSources: [
 *     { pattern: 'alias.0.Heizung.*', role: 'value.temperature', label: 'Raumtemperaturen' },
 *     { pattern: 'daswetter.0.NextHours.*', role: 'value.temperature', label: 'Wettervorhersage' },
 *   ],
 *   allowedActions: [
 *     { pattern: 'hm-rpc.0.*.SET_POINT_TEMPERATURE', label: 'Thermostat-Sollwert' },
 *   ],
 *   responseFormat: 'text',       // 'text' | 'json' | 'action'
 *   triggerWords: ['heizung', 'temperatur', 'warm', 'kalt'],
 *   maxContextStates: 50,
 * }
 */
class TemplateEngine {
    /**
     * @param {object} opts
     * @param {object} opts.log
     * @param {object} opts.adapter - ioBroker adapter instance
     */
    constructor({ log, adapter }) {
        this.log = log;
        this.adapter = adapter;
        /** @type {Map<string, object>} */
        this._templates = new Map();
    }

    /**
     * Load templates from adapter config.
     * @param {object[]} templates
     */
    loadTemplates(templates) {
        this._templates.clear();
        for (const t of templates) {
            if (!t.id) continue;
            this._templates.set(t.id, t);
            this.log.debug(`Template loaded: ${t.id} (${t.name})`);
        }
        this.log.info(`${this._templates.size} prompt template(s) loaded`);
    }

    /**
     * Get all templates.
     * @returns {object[]}
     */
    getTemplates() {
        return [...this._templates.values()];
    }

    /**
     * Match user input to a template based on trigger words.
     * @param {string} userText - Transcribed user input
     * @returns {object|null} - Matched template or null
     */
    matchTemplate(userText) {
        const lower = userText.toLowerCase();

        let bestMatch = null;
        let bestScore = 0;

        for (const template of this._templates.values()) {
            if (!template.triggerWords || template.triggerWords.length === 0) continue;

            let score = 0;
            for (const word of template.triggerWords) {
                if (lower.includes(word.toLowerCase())) score++;
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = template;
            }
        }

        if (bestMatch) {
            this.log.debug(`Matched template "${bestMatch.id}" (score: ${bestScore})`);
        }

        return bestMatch;
    }

    /**
     * Build the full context string for a template by reading ioBroker states.
     * @param {object} template
     * @returns {Promise<string>}
     */
    async buildContext(template) {
        if (!template.contextSources || template.contextSources.length === 0) {
            return '(keine Kontextdaten konfiguriert)';
        }

        const lines = [];
        let stateCount = 0;
        const maxStates = template.maxContextStates || 50;

        for (const source of template.contextSources) {
            if (stateCount >= maxStates) break;

            try {
                // Resolve pattern to actual state IDs
                const stateIds = await this._resolvePattern(source.pattern);

                if (stateIds.length > 0 && source.label) {
                    lines.push(`\n### ${source.label}`);
                }

                for (const stateId of stateIds) {
                    if (stateCount >= maxStates) break;

                    const state = await this.adapter.getForeignStateAsync(stateId);
                    const obj = await this.adapter.getForeignObjectAsync(stateId);
                    const name = obj?.common?.name || stateId;
                    const unit = obj?.common?.unit || '';
                    const val = state ? state.val : 'N/A';

                    const displayName = typeof name === 'object' ? (name.de || name.en || stateId) : name;
                    lines.push(`- ${displayName}: ${val}${unit ? ' ' + unit : ''}`);
                    stateCount++;
                }
            } catch (e) {
                this.log.debug(`Context source ${source.pattern}: ${e.message}`);
            }
        }

        // Add allowed actions info
        if (template.allowedActions && template.allowedActions.length > 0) {
            lines.push('\n### Erlaubte Aktionen');
            lines.push('Du kannst folgende Werte setzen (verwende das JSON-Format {"stateId": "...", "value": ...}):');
            for (const action of template.allowedActions) {
                const stateIds = await this._resolvePattern(action.pattern);
                for (const sid of stateIds.slice(0, 20)) {
                    lines.push(`- ${sid} (${action.label || 'Aktion'})`);
                }
            }
        }

        this.log.debug(`Built context: ${stateCount} states, ${lines.length} lines`);
        return lines.join('\n');
    }

    /**
     * Build the complete system prompt with context injected.
     * @param {object} template
     * @returns {Promise<string>}
     */
    async buildSystemPrompt(template) {
        const context = await this.buildContext(template);
        let prompt = template.systemPrompt || 'Du bist ein Smart-Home-Assistent.';

        // Replace {context} placeholder
        if (prompt.includes('{context}')) {
            prompt = prompt.replace('{context}', context);
        } else {
            prompt += '\n\n## Aktuelle Daten\n' + context;
        }

        return prompt;
    }

    /**
     * Check if a state ID is allowed for writing by a template.
     * @param {object} template
     * @param {string} stateId
     * @returns {boolean}
     */
    isActionAllowed(template, stateId) {
        if (!template.allowedActions) return false;
        return template.allowedActions.some((action) =>
            this._matchPattern(stateId, action.pattern)
        );
    }

    /**
     * Resolve a glob-like pattern to matching state IDs.
     * @param {string} pattern - e.g. 'hm-rpc.0.*.TEMPERATURE'
     * @returns {Promise<string[]>}
     * @private
     */
    async _resolvePattern(pattern) {
        // Convert glob to adapter selector
        // Simple approach: use pattern as prefix if no wildcards
        const parts = pattern.split('*');

        if (parts.length === 1) {
            // No wildcard — exact match
            return [pattern];
        }

        // Use getForeignObjects with pattern
        const prefix = parts[0];
        try {
            const objects = await this.adapter.getForeignObjectsAsync(prefix + '*', 'state');
            const ids = Object.keys(objects).filter((id) => this._matchPattern(id, pattern));
            return ids.sort();
        } catch (e) {
            this.log.debug(`Pattern resolve ${pattern}: ${e.message}`);
            return [];
        }
    }

    /**
     * Match a state ID against a glob pattern.
     * @param {string} id
     * @param {string} pattern
     * @returns {boolean}
     * @private
     */
    _matchPattern(id, pattern) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]*') + '$');
        return regex.test(id);
    }
}

module.exports = TemplateEngine;
