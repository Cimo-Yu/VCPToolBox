'use strict';

const crypto = require('node:crypto');
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
/**
 * 从 canonicalKey 派生稳定的 ASCII diaryId。
 *
 * 真实日记本文件夹几乎都是中文（`Ariadne知识日记本`、`决策官日记本`），
 * 而 diaryId 会进入 URL path 与 registry 主键，必须保持 URL 安全。
 * 因此 id 只承载内部身份，中文一律留在 diaryName / source.folder 里显示。
 * 摘要取 canonicalKey（已小写）以保证同一物理文件夹恒得同一 id。
 */
function derivedDiaryId(canonicalKey) {
    return `diary:${crypto.createHash('sha256').update(canonicalKey).digest('hex').slice(0, 12)}`;
}
/**
 * 从 River 名派生稳定的 ASCII riverId，理由与 derivedDiaryId 相同：
 * 河名几乎都是中文（`美学河`、`日常河`），而 riverId 会进入 URL path
 * （`/rivers/:riverId/observe`）与 registry 主键。
 *
 * 摘要取小写名，因此同名恒得同一 id —— 重复登记同名河是 upsert 而非新建，
 * 与「同一物理文件夹只能有一个 Diary」同构。改名会得到新 id，等同新建河道；
 * 需要保留旧 id 时显式传 riverId。
 */
function derivedRiverId(displayName) {
    return `river:${crypto.createHash('sha256').update(`name:${displayName.toLowerCase()}`).digest('hex').slice(0, 12)}`;
}
function principal(raw = {}) {
    const principalType = String(raw.principalType || 'agent').trim().toLowerCase();
    if (!['agent', 'human', 'service'].includes(principalType)) throw fail('unsupported principalType');
    const principalId = id(raw.principalId || raw.id, 'principalId');
    return { principalId, principalType, displayName: optional(raw.displayName) || principalId, avatarRef: optional(raw.avatarRef), enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
}
function diary(raw = {}) {
    const sourceFolder = folder(raw.source?.folder || raw.folder || raw.diaryName);
    const canonicalKey = `folder:${sourceFolder.toLowerCase()}`;
    // 显式 diaryId 仍受尊重（既有配置与测试依赖它）；缺省时派生 ASCII 摘要而非拼接文件夹名。
    const diaryId = id(raw.diaryId || raw.id || derivedDiaryId(canonicalKey), 'diaryId');
    return { diaryId, diaryName: optional(raw.diaryName) || sourceFolder, ownerPrincipalId: id(raw.ownerPrincipalId, 'ownerPrincipalId'), source: { type: 'folder', folder: sourceFolder, canonicalKey }, enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
}
function river(raw = {}) {
    // 名称是唯一必填项：riverId 与 memoryScope 都是内部身份，缺省时派生。
    const name = optional(raw.name) || optional(raw.riverId) || optional(raw.id);
    if (!name) throw fail('river name is required');
    // 显式 riverId 仍受尊重（既有配置如 aesthetics-river 与测试依赖它）。
    const riverId = id(raw.riverId || raw.id || derivedRiverId(name), 'riverId');
    return { riverId, name, memoryScope: optional(raw.memoryScope) || `river:${riverId}`, diaryIds: [...new Set((Array.isArray(raw.diaryIds) ? raw.diaryIds : []).map(value => id(value, 'diaryId')))], enabled: raw.enabled !== false, metadata: metadata(raw.metadata) };
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
    /**
     * 解析主体在某条 River 内的可读 diary 集合。
     *
     * 两种权限对应两种河道形态，不能共用一套过滤：
     *
     * - `read_own`：自我河。主体只读自己 owner 的 diary。这是原始语义，
     *   `aesthetics-river`（单 owner、90 文件）依赖它，不得改变。
     * - `observe`：共享河。返回该河全部 enabled diary，不论 owner。
     *   公共日常河靠它成立——每个 agent 写自己 owner 的「<名字>的公共日常」
     *   文件夹（绕开「一个物理文件夹只能有一个 owner」的约束），
     *   全部投影到同一条河；若仍按 owner 过滤，各 agent 只会读到自己那份，
     *   河道退化成互不可见的私有域并列，且静默返回空集不报错。
     *
     * 两权限同时持有时取并集，即 observe 的全域。二者皆无仍 fail closed 403。
     * 返回结构保持 { principalId, riverId, diaryNames }，因此 LightMemo 的
     * riverId 候选域链路无需改动。
     */
    resolveAuthorizedDiarySet({ principalId, riverId } = {}) {
        const config = this.load();
        const targetRiver = config.rivers.find(item => item.riverId === riverId && item.enabled !== false);
        if (!targetRiver) throw fail('Unknown or disabled river', 'GRANT_INSUFFICIENT', 403);
        const granted = new Set(config.grants.filter(item => item.enabled !== false && item.principalId === principalId && item.riverId === riverId).flatMap(item => item.permissions));
        const canObserve = granted.has('observe');
        if (!canObserve && !granted.has('read_own')) throw fail('Principal lacks read_own or observe permission', 'GRANT_INSUFFICIENT', 403);
        const inRiver = item => item.enabled !== false && targetRiver.diaryIds.includes(item.diaryId);
        return { principalId, riverId, scope: canObserve ? 'observe' : 'read_own', diaryNames: config.diaries.filter(item => inRiver(item) && (canObserve || item.ownerPrincipalId === principalId)).map(item => item.diaryName) };
    }
    static migrateFromV1(v1 = {}) { const unresolvedDiaries = [...new Set((v1.rivers || []).flatMap(item => Array.isArray(item.diaries) ? item.diaries : []).map(item => String(item || '').trim()).filter(Boolean))]; return { config: { version: 2, principals: [], diaries: [], rivers: (v1.rivers || []).map(item => ({ riverId: id(item.id, 'riverId'), name: optional(item.name) || item.id, memoryScope: optional(item.memoryScope) || `river:${item.id}`, diaryIds: [], enabled: item.enabled !== false, metadata: { migratedFrom: 'v1' } })), grants: [] }, unresolvedDiaries }; }
}
module.exports = { MemoryRiverRegistryV2, DEFAULT_CONFIG, PERMISSIONS };
