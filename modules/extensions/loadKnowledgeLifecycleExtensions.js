'use strict';

const path = require('node:path');

function resolveModulePath(modulePath, projectRoot) {
    if (!modulePath.startsWith('.')) return modulePath;
    return path.resolve(projectRoot, modulePath);
}

function loadKnowledgeLifecycleExtensions({
    modulePaths = [],
    extensionOptions = {},
    projectRoot = path.resolve(__dirname, '..', '..'),
    logger = console
} = {}) {
    if (!Array.isArray(modulePaths)) return [];

    return modulePaths.flatMap(modulePath => {
        try {
            const resolvedModulePath = resolveModulePath(modulePath, projectRoot);
            const loaded = require(resolvedModulePath);
            if (typeof loaded?.createKnowledgeLifecycleExtension !== 'function') {
                throw new TypeError('Module must export createKnowledgeLifecycleExtension(options)');
            }
            const extension = loaded.createKnowledgeLifecycleExtension(extensionOptions);
            return extension ? [extension] : [];
        } catch (error) {
            logger.warn?.(
                `[KnowledgeLifecycleExtensions] Failed to load ${modulePath}: ${error.message || error}`
            );
            return [];
        }
    });
}

module.exports = { loadKnowledgeLifecycleExtensions, resolveModulePath };
