'use strict';

const crypto = require('node:crypto');

const EVENT_TYPES = new Set([
    'knowledge.written',
    'knowledge.deleted',
    'knowledge.moved',
    'knowledge.archived',
    'knowledge.replaced'
]);

function normalizeOptionalString(value) {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value).trim();
    return normalized || undefined;
}

function normalizeKnowledgeLifecycleEvent(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Knowledge lifecycle event must be an object');
    }
    if (!EVENT_TYPES.has(input.type)) {
        throw new TypeError(`Unsupported knowledge lifecycle event type: ${input.type}`);
    }

    const source = input.source && typeof input.source === 'object' && !Array.isArray(input.source)
        ? input.source
        : {};
    const filePath = normalizeOptionalString(source.filePath);
    if (!filePath) throw new TypeError('Knowledge lifecycle event source.filePath is required');

    const content = input.content && typeof input.content === 'object' && !Array.isArray(input.content)
        ? input.content
        : {};

    return Object.freeze({
        version: 1,
        eventId: normalizeOptionalString(input.eventId) || crypto.randomUUID(),
        type: input.type,
        occurredAt: normalizeOptionalString(input.occurredAt) || new Date().toISOString(),
        source: Object.freeze({
            filePath,
            diaryName: normalizeOptionalString(source.diaryName),
            agentId: normalizeOptionalString(source.agentId),
            checksum: normalizeOptionalString(source.checksum),
            revision: normalizeOptionalString(source.revision)
        }),
        content: Object.freeze({
            text: input.type === 'knowledge.written' ? String(content.text || '') : undefined,
            metadata: content.metadata && typeof content.metadata === 'object' && !Array.isArray(content.metadata)
                ? Object.freeze({ ...content.metadata })
                : Object.freeze({})
        })
    });
}

class KnowledgeLifecycleExtensionHost {
    constructor({ extensions = [], logger = console } = {}) {
        this.extensions = extensions.filter(Boolean);
        this.logger = logger;
    }

    async initialize(context = {}) {
        await this._invoke('initialize', context);
    }

    async publish(input) {
        const event = normalizeKnowledgeLifecycleEvent(input);
        await this._invoke('handleKnowledgeLifecycleEvent', event);
        return event;
    }

    async shutdown() {
        await this._invoke('shutdown');
    }

    async _invoke(method, argument) {
        await Promise.all(this.extensions.map(async extension => {
            if (typeof extension[method] !== 'function') return;
            try {
                await extension[method](argument);
            } catch (error) {
                this.logger.warn?.(
                    `[KnowledgeLifecycleExtensionHost] ${method} failed for extension: ${error.message || error}`
                );
            }
        }));
    }
}

module.exports = {
    EVENT_TYPES,
    KnowledgeLifecycleExtensionHost,
    normalizeKnowledgeLifecycleEvent
};
