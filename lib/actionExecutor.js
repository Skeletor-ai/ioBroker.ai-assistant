'use strict';

/**
 * Executes actions proposed by the LLM.
 * Supports two modes:
 *   1. JSON parsing from free-text responses (legacy)
 *   2. Tool calling via structured function calls (optional)
 *
 * Tool calling mode provides: setState, getState
 * Permission checks apply in both modes.
 */
class ActionExecutor {
    /**
     * @param {object} opts
     * @param {object} opts.log
     * @param {object} opts.adapter - ioBroker adapter instance
     * @param {object} opts.templateEngine
     */
    constructor({ log, adapter, templateEngine }) {
        this.log = log;
        this.adapter = adapter;
        this.templateEngine = templateEngine;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Tool Calling Mode
    // ─────────────────────────────────────────────────────────────────

    /**
     * Build OpenAI-format tool definitions for a template.
     * @param {object} template - Active template (for allowed actions)
     * @returns {object[]} - Tool definitions (OpenAI format, converted for other backends by LlmBackend)
     */
    buildToolDefinitions(template) {
        const tools = [];

        // setState — always available when tool calling is enabled
        const stateDescription = template?.allowedActions?.length
            ? `Set an ioBroker state value. Allowed state patterns: ${template.allowedActions.map((a) => a.pattern + (a.label ? ` (${a.label})` : '')).join(', ')}`
            : 'Set an ioBroker state value.';

        tools.push({
            type: 'function',
            function: {
                name: 'setState',
                description: stateDescription,
                parameters: {
                    type: 'object',
                    properties: {
                        stateId: {
                            type: 'string',
                            description: 'Full ioBroker state ID (e.g. hm-rpc.0.ABC123.SET_POINT_TEMPERATURE)',
                        },
                        value: {
                            description: 'Value to set (number, string, or boolean)',
                        },
                    },
                    required: ['stateId', 'value'],
                },
            },
        });

        // getState — read a state value
        tools.push({
            type: 'function',
            function: {
                name: 'getState',
                description: 'Read the current value of an ioBroker state.',
                parameters: {
                    type: 'object',
                    properties: {
                        stateId: {
                            type: 'string',
                            description: 'Full ioBroker state ID to read',
                        },
                    },
                    required: ['stateId'],
                },
            },
        });

        return tools;
    }

    /**
     * Tool executor function for use with LlmBackend.completeWithTools().
     * Returns a bound function that handles tool calls.
     * @param {object} template - Active template (for permission checks)
     * @returns {function} - async (name, args) => result string
     */
    createToolExecutor(template) {
        const executed = [];
        const denied = [];

        const executor = async (name, args) => {
            switch (name) {
                case 'setState':
                    return this._toolSetState(args, template, executed, denied);
                case 'getState':
                    return this._toolGetState(args);
                default:
                    return JSON.stringify({ error: `Unknown tool: ${name}` });
            }
        };

        // Attach result arrays for later retrieval
        executor._executed = executed;
        executor._denied = denied;

        return executor;
    }

    /**
     * Tool handler: setState
     * @private
     */
    async _toolSetState(args, template, executed, denied) {
        const { stateId, value } = args;

        if (!stateId || value === undefined) {
            return JSON.stringify({ error: 'stateId and value are required' });
        }

        // Permission check
        if (!this.templateEngine.isActionAllowed(template, stateId)) {
            this.log.warn(`Tool setState denied (not in whitelist): ${stateId}`);
            denied.push({ stateId, value, reason: 'Not in whitelist' });
            return JSON.stringify({ error: `Action not allowed: ${stateId} is not in the permitted list` });
        }

        try {
            const obj = await this.adapter.getForeignObjectAsync(stateId);
            if (!obj) {
                denied.push({ stateId, value, reason: 'State not found' });
                return JSON.stringify({ error: `State not found: ${stateId}` });
            }

            // Type coercion
            let coercedValue = value;
            const stateType = obj.common?.type;
            if (stateType === 'number') coercedValue = Number(value);
            else if (stateType === 'boolean') coercedValue = Boolean(value);
            else if (stateType === 'string') coercedValue = String(value);

            await this.adapter.setForeignStateAsync(stateId, { val: coercedValue, ack: false });
            this.log.info(`Tool setState: ${stateId} = ${coercedValue}`);

            executed.push({ stateId, value: coercedValue });
            const name = typeof obj.common?.name === 'object'
                ? (obj.common.name.de || obj.common.name.en || stateId)
                : (obj.common?.name || stateId);

            return JSON.stringify({ success: true, stateId, value: coercedValue, name });
        } catch (e) {
            denied.push({ stateId, value, reason: e.message });
            return JSON.stringify({ error: e.message });
        }
    }

    /**
     * Tool handler: getState
     * @private
     */
    async _toolGetState(args) {
        const { stateId } = args;
        if (!stateId) {
            return JSON.stringify({ error: 'stateId is required' });
        }

        try {
            const state = await this.adapter.getForeignStateAsync(stateId);
            const obj = await this.adapter.getForeignObjectAsync(stateId);

            if (!state) {
                return JSON.stringify({ error: `State not found or has no value: ${stateId}` });
            }

            const name = typeof obj?.common?.name === 'object'
                ? (obj.common.name.de || obj.common.name.en || stateId)
                : (obj?.common?.name || stateId);

            return JSON.stringify({
                stateId,
                name,
                value: state.val,
                unit: obj?.common?.unit || '',
                timestamp: state.ts,
                ack: state.ack,
            });
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Legacy Mode: JSON parsing from free-text
    // ─────────────────────────────────────────────────────────────────

    /**
     * Parse and execute actions from LLM response (legacy mode).
     * @param {string} llmResponse - Raw LLM response text
     * @param {object} template - Active template (for permission check)
     * @returns {Promise<{executed: object[], denied: object[], text: string}>}
     */
    async execute(llmResponse, template) {
        const actions = this._parseActions(llmResponse);
        const executed = [];
        const denied = [];
        let textResponse = llmResponse;

        if (actions.length === 0) {
            return { executed, denied, text: textResponse };
        }

        for (const action of actions) {
            if (!action.stateId || action.value === undefined) {
                this.log.debug(`Skipping invalid action: ${JSON.stringify(action)}`);
                continue;
            }

            // Permission check
            if (!this.templateEngine.isActionAllowed(template, action.stateId)) {
                this.log.warn(`Action denied (not in whitelist): ${action.stateId} = ${action.value}`);
                denied.push(action);
                continue;
            }

            // Validate state exists
            try {
                const obj = await this.adapter.getForeignObjectAsync(action.stateId);
                if (!obj) {
                    this.log.warn(`Action target not found: ${action.stateId}`);
                    denied.push({ ...action, reason: 'State not found' });
                    continue;
                }

                // Type coercion based on state type
                let value = action.value;
                const stateType = obj.common?.type;
                if (stateType === 'number') value = Number(value);
                else if (stateType === 'boolean') value = Boolean(value);
                else if (stateType === 'string') value = String(value);

                // Execute
                await this.adapter.setForeignStateAsync(action.stateId, { val: value, ack: false });
                this.log.info(`Action executed: ${action.stateId} = ${value}`);
                executed.push({ ...action, actualValue: value });
            } catch (e) {
                this.log.warn(`Action failed: ${action.stateId}: ${e.message}`);
                denied.push({ ...action, reason: e.message });
            }
        }

        return { executed, denied, text: textResponse };
    }

    /**
     * Parse actions from LLM response text (legacy mode).
     * @param {string} text
     * @returns {object[]}
     * @private
     */
    _parseActions(text) {
        const actions = [];

        // Try to find JSON block in response
        const jsonMatches = text.match(/\{[\s\S]*"actions"[\s\S]*\}/g);
        if (jsonMatches) {
            for (const match of jsonMatches) {
                try {
                    const parsed = JSON.parse(match);
                    if (Array.isArray(parsed.actions)) {
                        actions.push(...parsed.actions);
                    }
                } catch (_) {
                    // Not valid JSON, skip
                }
            }
        }

        // Also try individual action objects
        const singleMatches = text.match(/\{"stateId":\s*"[^"]+",\s*"value":\s*[^}]+\}/g);
        if (singleMatches) {
            for (const match of singleMatches) {
                try {
                    actions.push(JSON.parse(match));
                } catch (_) {}
            }
        }

        return actions;
    }
}

module.exports = ActionExecutor;
