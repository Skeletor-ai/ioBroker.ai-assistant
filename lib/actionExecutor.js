'use strict';

/**
 * Executes actions proposed by the LLM.
 * Parses LLM response for setState commands and validates
 * them against the template's allowed actions whitelist.
 *
 * Expected LLM response format for actions:
 * ```json
 * {"actions": [{"stateId": "hm-rpc.0.ABC.SET_POINT_TEMPERATURE", "value": 22}]}
 * ```
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

    /**
     * Parse and execute actions from LLM response.
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
     * Parse actions from LLM response text.
     * Looks for JSON blocks with actions array.
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
