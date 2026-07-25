'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({ version: 2, principals: [], diaries: [], rivers: [], grants: [] });
const PERMISSIONS = new Set(['read_own', 'observe', 'contribute', 'steward', 'admin']);
const clone = value => JSON.parse(JSON.stringify(value));

function fail(message, code = 'MEMORY_RIVER_REGISTRY_INVALID', statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}
function id(value, field) {
    const normalized = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw fail(`${field} contains invalid characters`);
    return normalized;
}
function optional(value) { const normalized = String(value || '').trim(); return normalized || undefined; }
function folder(value) {
    const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    if (!normalized || normalized.startsWith('/') || normalized.includes('..')) throw fail('diary source folder must be a relative path');
    return normalized;
}
function metadata(value) { return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}; }
function principal(raw = {}) {
    const principalType = String(raw.principalType || 'agent').trim().toLowerCase();
    if (!['agent', 'human', 'service'].includes(principalType)) throw fail('unsupported principalType');
    const principalId = id(raw.principalId || raw.id, 'principalId');
    return { principalId, principalType, displayName: optional(raw.displayName) || principalId, avatarRef: optional(raw.avatarRef), enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
}
function diary(raw = {}) {
    const sourceFolder = folder(raw.source?.folder || raw.folder || raw.diaryName);
    return { diaryId: id(raw.diaryId || raw.id || `diary:${sourceFolder}`, 'diaryId'), diaryName: optional(raw.diaryName) || sourceFolder, ownerPrincipalId: id(raw.ownerPrincipalId, 'ownerPrincipalId'), source: { type: 'folder', folder: sourceFolder, canonicalKey: `folder:${sourceFolder.toLowerCase()}` }, enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
}
function river(raw = {}) {
    const riverId = id(raw.riverId || raw.id, 'riverId');
    return { riverId, name: optional(raw.name) || riverId, memoryScope: optional(raw.memoryScope) || `river:${riverId}`, diaryIds: [...new Set((Array.isArray(raw.diaryIds) ? raw.diaryIds : []).map(value => id(value, 'diaryId')))], enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
}
function grant(raw = {}) {
    const principalId = id(raw.principalId, 'principalId');
    const riverId = id(raw.riverId, 'riverId');
    const permissions = [...new Set((Array.isArray(raw.permissions) ? raw.permissions : ['read_own']).map(value => String(value || '').trim()).filter(Boolean))];
    if (permissions.some(value => !PERMISSIONS.has(value))) throw fail('unsupported grant permission');
    return { grantId: id(raw.grantId || raw.id || `grant:${principalId}:${riverId}`, 'grantId'), principalId, riverId, permissions, enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
}

class MemoryRiverRegistryV2 {
    constructor({ configPath, createDefaultConfig = false } = {}) {
        this.configPath = configPath || path.join(__dirname, 'config', 'memory-rivers.v2.json');
        this.createDefaultConfig = createDefaultConfig;
    }
    validate(raw = {}) {
        if (Number(raw.version || 2) !== 2) throw fail('Registry requires version 2', 'MEMORY_RIVER_REGISTRY_VERSION');
        const config = { version: 2, principals: (raw.principals || []).map(principal), diaries: (raw.diaries || []).map(diary), rivers: (raw.rivers || []).map(river), grants: (raw.grants || []).map(grant) };
        const unique = (items, getKey, name) => { const values = new Set(); for (const item of items) { const value = getKey(item); if (values.has(value)) throw fail(`Duplicate ${name}: ${value}`); values.add(value); } return values; };
        const principalIds = unique(config.principals, item => item.principalId, 'principalId');
        const diaryIds = unique(config.diaries, item => item.diaryId, 'diaryId');
        const sourceKeys = new Set();
        for (const item of config.diaries) {
            if (sourceKeys.has(item.source.canonicalKey)) throw fail(`Diary physical source already owned: ${item.source.folder}`);
            sourceKeys.add(item.source.canonicalKey);
        }
        for (const item of config.diaries) if (!principalIds.has(item.ownerPrincipalId)) throw fail(`Unknown diary owner: ${item.ownerPrincipalId}`);
        const riverIds = unique(config.rivers, item => item.riverId, 'riverId');
        unique(config.rivers, item => item.memoryScope, 'memoryScope');
        for (const item of config.rivers) if (item.diaryIds.some(diaryId => !diaryIds.has(diaryId))) throw fail(`River ${item.riverId} references an unknown diary`);
        unique(config.grants, item => item.grantId, 'grantId');
        for (const item of config.grants) if (!principalIds.has(item.principalId) || !riverIds.has(item.riverId)) throw fail('Grant references an unknown principal or river');
        return config;
    }
    load() { if (!fs.existsSync(this.configPath)) { if (this.createDefaultConfig) this.save(DEFAULT_CONFIG); return clone(DEFAULT_CONFIG); } return this.validate(JSON.parse(fs.readFileSync(this.configPath, 'utf8'))); }
    save(raw) { const config = this.validate(raw); fs.mkdirSync(path.dirname(this.configPath), { recursive: true }); const temporary = `${this.configPath}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8'); fs.renameSync(temporary, this.configPath); return clone(config); }
    _upsert(collection, key, value) { const config = this.load(); const index = config[collection].findIndex(item => item[key] === value[key]); if (index >= 0) config[collection][index] = value; else config[collection].push(value); return this.save(config)[collection].find(item => item[key] === value[key]); }
    listPrincipals({ includeDisabled = false } = {}) { return this.load().principals.filter(item => includeDisabled || item.enabled !== false); }
    listDiaries({ includeDisabled = false } = {}) { return this.load().diaries.filter(item => includeDisabled || item.enabled !== false); }
    listRivers({ includeDisabled = false } = {}) { return this.load().rivers.filter(item => includeDisabled || item.enabled !== false); }
    listGrants({ includeDisabled = false } = {}) { return this.load().grants.filter(item => includeDisabled || item.enabled !== false); }
    upsertPrincipal(raw) { return this._upsert('principals', 'principalId', principal(raw)); }
    upsertDiary(raw) { return this._upsert('diaries', 'diaryId', diary(raw)); }
    upsertRiver(raw) { return this._upsert('rivers', 'riverId', river(raw)); }
    upsertGrant(raw) { return this._upsert('grants', 'grantId', grant(raw)); }
    findRiversForDiary(name) { const target = String(name || '').trim().toLowerCase(); const source = this.listDiaries().find(item => item.diaryName.toLowerCase() === target || item.source.folder.toLowerCase() === target); if (!source) return []; return this.listRivers().filter(item => item.diaryIds.includes(source.diaryId)).map(item => ({ riverId: item.riverId, memoryScope: item.memoryScope })); }
    resolveAuthorizedDiarySet({ principalId, riverId } = {}) { const config = this.load(); const targetRiver = config.rivers.find(item => item.riverId === riverId && item.enabled !== false); if (!targetRiver) throw fail('Unknown or disabled river', 'GRANT_INSUFFICIENT', 403); const authorized = config.grants.some(item => item.enabled !== false && item.principalId === principalId && item.riverId === riverId && item.permissions.includes('read_own')); if (!authorized) throw fail('Principal lacks read_own permission', 'GRANT_INSUFFICIENT', 403); return { principalId, riverId, diaryNames: config.diaries.filter(item => item.enabled !== false && item.ownerPrincipalId === principalId && targetRiver.diaryIds.includes(item.diaryId)).map(item => item.diaryName) }; }
    static migrateFromV1(v1 = {}) { const unresolvedDiaries = [...new Set((v1.rivers || []).flatMap(item => Array.isArray(item.diaries) ? item.diaries : []).map(item => String(item || '').trim()).filter(Boolean))]; return { config: { version: 2, principals: [], diaries: [], rivers: (v1.rivers || []).map(item => ({ riverId: id(item.id, 'riverId'), name: optional(item.name) || item.id, memoryScope: optional(item.memoryScope) || `river:${item.id}`, diaryIds: [], enabled: item.enabled !== false, metadata: { migratedFrom: 'v1' } })), grants: [] }, unresolvedDiaries }; }
}
module.exports = { MemoryRiverRegistryV2, DEFAULT_CONFIG, PERMISSIONS };
