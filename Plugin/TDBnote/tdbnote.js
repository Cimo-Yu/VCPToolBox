#!/usr/bin/env node

// TDBnote.js
// 冷知识库写入插件（DailyNote 的冷知识版）。
//
// 与 DailyNote 的关系：
//   DailyNote → 热记忆（dailynote/ 下的日记，由 KnowledgeBaseManager 做 SQLite/RAG 索引）
//   TDBnote   → 冷知识（knowledge/ 下的资料条目，由 TDBKnowledgeManager 做 TriviumDB 向量/图谱索引）
//
// 写入路径与 TDBKnowledge.js 共享同一 root（TDB_KNOWLEDGE_ROOT_PATH）：
//   knowledge/<library>/<YYYY-MM-DD-HH_MM_SS>-<title>.<ext>
// 一级子目录名 = TriviumDB library 名；文件落盘后主动调用 tdbKnowledgeManager.upsertFile()
// 触发入库（Embedding + doc/chunk 图谱链接），不阻塞 AI 调用返回。
//
// 与 DailyNote 的三处有意差异：
//   1. library 精确匹配，不做模糊归类——冷知识写错库比新建库危险；
//   2. 新增 list 命令——冷知识库没有对应的 Manager 面板，AI 需要自助定位；
//   3. 文件名以 Title 为语义后缀——TriviumDB 的 document 节点标题取自文件名，
//      文件名即冷知识的向量锚点。

const fs = require('fs').promises;
const path = require('path');

// --- Load environment variables ---
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') }); // Load root config

// --- Configuration ---
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";
const projectBasePath = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');

// 冷知识根目录：优先取注入的 TDBKnowledgeManager 的权威配置，
// 其次 TDB_KNOWLEDGE_ROOT_PATH（相对路径按 VCPToolBox 根解析，与 TDBKnowledge 的意图一致），
// 最后回退 <VCPToolBox>/knowledge。
let knowledgeRootPath = null;
function getKnowledgeRootPath() {
    if (knowledgeRootPath) return knowledgeRootPath;
    if (tdbKnowledgeManager && tdbKnowledgeManager.config && tdbKnowledgeManager.config.rootPath) {
        knowledgeRootPath = tdbKnowledgeManager.config.rootPath;
        return knowledgeRootPath;
    }
    const configured = process.env.TDB_KNOWLEDGE_ROOT_PATH || path.join(projectBasePath, 'knowledge');
    knowledgeRootPath = path.resolve(projectBasePath, configured);
    return knowledgeRootPath;
}

// 冷知识文件扩展名（必须是 TDBKnowledge 可索引扩展之一才会入库）
const CONFIGURED_EXTENSION = (() => {
    const ext = (process.env.TDB_NOTE_EXTENSION || "md").toLowerCase();
    return ext.startsWith('.') ? ext.slice(1) : ext;
})();

// Tag 说明：冷知识条目不使用 Tag 行。
// 检索侧（LightMemo 冷知识库模式 / [[xx知识库]] 占位符）走 TriviumDB 的
// BM25 稀疏召回 + 向量稠密召回 + 图扩散混合检索，不依赖 Tag 体系，
// 与日记系统（DailyNote/TagMemo）的 Tag 驱动检索是两条独立管线。
// Content 中的任何内容（包括末尾疑似 Tag 行）都会作为纯正文原样写入。

// Fuzzy Diff for Update Failures (与 DailyNote 对齐)
const FUZZY_DIFF_ENABLED = (process.env.TDB_NOTE_FUZZY_DIFF || "true").toLowerCase() === "true";
const UPDATE_FAILURE_HINT = "请检查字段或标点符号是否与原文一致；若多次失败，可先使用 TDBnote 的 list 命令查看对应知识库的文件清单，确认目标条目状态后再重试。";

// --- Resident Service State ---
// hybridservice direct 常驻服务：所有 create/update/list 通过同一条进程内队列串行执行，
// 避免多 Agent 并发写入同一 library 时产生文件名竞争。
let tdbKnowledgeManager = null;
let residentQueue = Promise.resolve();
let residentAcceptingRequests = true;
let residentPendingCount = 0;
let residentInitialized = false;

// --- Debug Logging (to stderr) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[TDBnote][Debug] ${message}`, ...args);
    }
}

function getArgumentValue(args, ...candidateNames) {
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    for (const name of candidateNames) {
        if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) {
            return args[name];
        }
    }
    const normalizedNames = candidateNames.map(name => String(name).toLowerCase());
    for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && normalizedNames.includes(key.toLowerCase())) {
            return value;
        }
    }
    return undefined;
}

// --- Helper Function for Sanitization (与 DailyNote 同源) ---
function sanitizePathComponent(name) {
    if (!name || typeof name !== 'string') {
        return 'Untitled';
    }

    let sanitized = name
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^[._]+|[._]+$/g, '')
        .replace(/_+/g, '_');

    const windowsReserved = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;
    if (windowsReserved.test(sanitized)) {
        sanitized = '_' + sanitized;
    }

    const MAX_FOLDER_NAME_LENGTH = 100;
    if (sanitized.length > MAX_FOLDER_NAME_LENGTH) {
        sanitized = sanitized.substring(0, MAX_FOLDER_NAME_LENGTH).replace(/[._]+$/g, '');
    }

    return sanitized || 'Untitled';
}

// --- 路径安全验证 ---
function isPathWithinBase(targetPath, basePath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(basePath);
    return resolvedTarget === resolvedBase ||
        resolvedTarget.startsWith(resolvedBase + path.sep);
}

// --- Library Resolution ---
// 与 DailyNote 的模糊文件夹归类不同：冷知识库做精确（大小写不敏感 + 去噪）匹配。
// 请求名与既有库完全不匹配时新建库，绝不把条目悄悄写进语义相近的另一个库。
function normalizeLibraryAlias(name) {
    if (!name || typeof name !== 'string') {
        return '';
    }
    return name
        .trim()
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, '')
        .replace(/[._]+$/g, '')
        .trim();
}

async function listLibraryDirs() {
    const rootPath = getKnowledgeRootPath();
    let allDirEntries = [];
    try {
        allDirEntries = await fs.readdir(rootPath, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    return allDirEntries
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(name => isPathWithinBase(path.join(rootPath, name), rootPath));
}

async function resolveLibraryName(requestedName) {
    const rawName = typeof requestedName === 'string' ? requestedName.trim() : '';
    const aliasName = normalizeLibraryAlias(rawName);
    const sanitized = sanitizePathComponent(aliasName || rawName || 'Root');

    const existingDirs = await listLibraryDirs();
    const exact = existingDirs.find(dir => normalizeLibraryAlias(dir) === aliasName);
    if (exact) {
        return { libraryName: exact, matchedExisting: true, requestedName: rawName };
    }

    debugLog(`Library "${rawName}" did not exactly match any existing library; creating new library "${sanitized}".`);
    return { libraryName: sanitized, matchedExisting: false, requestedName: rawName };
}

// --- Indexability (mirror of TDBKnowledge._isIndexable 的客户端校验) ---
function getIndexabilityRules() {
    const cfg = tdbKnowledgeManager && tdbKnowledgeManager.config;
    return {
        extensions: Array.isArray(cfg && cfg.extensions) && cfg.extensions.length > 0
            ? cfg.extensions
            : ['.md', '.txt', '.json', '.html'],
        excludeFolders: Array.isArray(cfg && cfg.excludeFolders) ? cfg.excludeFolders : ['TDBdocs'],
        ignorePrefixes: Array.isArray(cfg && cfg.ignorePrefixes) ? cfg.ignorePrefixes : [],
        ignoreSuffixes: Array.isArray(cfg && cfg.ignoreSuffixes) ? cfg.ignoreSuffixes : []
    };
}

function isIndexableLibraryFile(libraryName, fileName, extension) {
    const rules = getIndexabilityRules();
    const normalizedExt = extension.startsWith('.') ? extension : `.${extension}`;
    if (!rules.extensions.includes(normalizedExt)) return false;
    if (rules.excludeFolders.includes(libraryName)) return false;
    if (rules.ignorePrefixes.some(prefix => libraryName.startsWith(prefix) || fileName.startsWith(prefix))) return false;
    if (rules.ignoreSuffixes.some(suffix => libraryName.endsWith(suffix) || fileName.endsWith(suffix))) return false;
    return true;
}

// --- 后台入库 ---
// 文件落盘后不阻塞返回；Embedding 与图谱写入由 TDBKnowledgeManager 完成。
// watcher 也会捕获 add/change 事件，checksum 去重保证双通道不会重复入库。
function triggerIndexing(filePath) {
    if (!tdbKnowledgeManager) {
        return 'manager-unavailable';
    }
    if (tdbKnowledgeManager.initialized !== true) {
        // 冷知识库未启用（TDB_KNOWLEDGE_ENABLED=false 或 triviumdb 缺失）：
        // 文件仍然安全落盘，待下次启用后的启动全量扫描入库。
        return 'deferred-until-scan';
    }
    Promise.resolve()
        .then(() => tdbKnowledgeManager.upsertFile(filePath))
        .catch(err => {
            console.error(`[TDBnote] Background upsert failed for ${filePath}:`, err.message || err);
        });
    return 'queued';
}

// --- 'create' Command Logic ---
async function handleCreateCommand(args) {
    const library = getArgumentValue(args, 'library', 'Library', 'knowledgeBase', 'KnowledgeBase');
    const maid = args.maid || args.maidName || args.Maid || args.MAID;
    let dateString = args.dateString || args.Date;
    const contentText = args.contentText || args.Content || args.content;
    const title = getArgumentValue(args, 'title', 'Title');
    const fileNameArg = args.fileName || args.FileName;

    if (!dateString) {
        const d = new Date();
        dateString = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
    }

    debugLog(`Processing 'create' for Library: ${library}, Maid: ${maid}, Title: ${title}, Date: ${dateString}`);
    if (!library || !contentText) {
        return { status: "error", error: "Invalid input for create: Missing library or Content. 冷知识必须指定目标知识库（library，即 knowledge/ 下的一级子目录名）。" };
    }
    if (!maid) {
        return { status: "error", error: "Invalid input for create: Missing maid. 请提供 maid 作为知识条目的署名/来源。" };
    }

    try {
        // 冷知识条目不使用 Tag 行：Content 原样作为正文写入
        const processedContent = String(contentText).trimEnd();

        const trimmedMaidName = maid.trim();
        const resolution = await resolveLibraryName(library);
        const libraryName = resolution.libraryName;

        const rootPath = getKnowledgeRootPath();
        const dirPath = path.join(rootPath, libraryName);
        if (!isPathWithinBase(dirPath, rootPath)) {
            console.error(`[TDBnote] Path traversal attempt detected: ${dirPath}`);
            return { status: "error", error: "Security error: Invalid library path detected." };
        }

        // 文件名语义后缀：Title 优先，fileName 兼容（与 DailyNote 的 fileName 参数对齐）
        let semanticSuffix = '';
        const semanticSource = (typeof title === 'string' && title.trim()) ? title.trim()
            : (typeof fileNameArg === 'string' && fileNameArg.trim()) ? fileNameArg.trim() : '';
        if (semanticSource) {
            semanticSuffix = sanitizePathComponent(semanticSource);
        }

        const datePart = dateString.replace(/[.\\\/\s-]/g, '-').replace(/-+/g, '-');
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        const timeStringForFile = `${hours}_${minutes}_${seconds}`;

        const suffixPart = semanticSuffix ? `-${semanticSuffix}` : '';
        const baseFileNameWithoutExt = `${datePart}-${timeStringForFile}${suffixPart}`;
        const fileExtension = `.${CONFIGURED_EXTENSION}`;

        let finalFileName = `${baseFileNameWithoutExt}${fileExtension}`;
        let filePath = path.join(dirPath, finalFileName);
        let counter = 1;

        await fs.mkdir(dirPath, { recursive: true });

        const timeStringForContent = `${hours}:${minutes}`;
        // 冷知识条目格式：来源署名行 + 空行 + 正文（无 Tag 行）。
        const fileContent = `[${datePart} ${timeStringForContent}] - ${trimmedMaidName}\n\n${processedContent}\n`;

        // wx 原子排他创建，避免并发调用抢到同一路径（与 DailyNote 同源）
        const maxFileNameAttempts = 1000;
        while (counter <= maxFileNameAttempts) {
            try {
                await fs.writeFile(filePath, fileContent, { encoding: 'utf-8', flag: 'wx' });
                break;
            } catch (err) {
                if (err.code !== 'EEXIST') {
                    throw err;
                }
                counter++;
                finalFileName = `${baseFileNameWithoutExt}(${counter})${fileExtension}`;
                filePath = path.join(dirPath, finalFileName);
            }
        }

        if (counter > maxFileNameAttempts) {
            throw new Error(`Unable to allocate a unique knowledge file name after ${maxFileNameAttempts} attempts.`);
        }

        const indexable = isIndexableLibraryFile(libraryName, finalFileName, CONFIGURED_EXTENSION);
        let indexStatus;
        if (!indexable) {
            indexStatus = 'not-indexable';
        } else {
            indexStatus = triggerIndexing(filePath);
        }

        debugLog(`Successfully wrote knowledge file (length: ${fileContent.length}), indexStatus: ${indexStatus}`);
        return {
            status: "success",
            result: {
                message: indexStatus === 'queued'
                    ? `${trimmedMaidName} 的冷知识已保存到知识库 "${libraryName}" (${finalFileName})，TriviumDB 入库将在后台完成`
                    : `${trimmedMaidName} 的冷知识已保存到知识库 "${libraryName}" (${finalFileName})；索引状态：${indexStatus}`,
                library: libraryName,
                fileName: finalFileName,
                indexStatus
            }
        };
    } catch (error) {
        console.error("[TDBnote] Error during 'create' command:", error.message);
        return { status: "error", error: error.message || "An unknown error occurred during knowledge creation." };
    }
}

// --- Fuzzy Diff Utilities (与 DailyNote 同源) ---
function normalizeLooseMatchChar(char) {
    switch (char) {
        case '\u201c': case '\u201d': case '\u201e': case '\u201f': case '\uff02':
            return '"';
        case '\u2018': case '\u2019': case '\u201a': case '\u201b': case '\uff07':
            return "'";
        case '\uff08':
            return '(';
        case '\uff09':
            return ')';
        case '\uff0c': case '\u3001':
            return ',';
        case '\uff1a':
            return ':';
        case '\uff1b':
            return ';';
        case '\uff01':
            return '!';
        case '\uff1f':
            return '?';
        case '\u3002': case '\uff0e':
            return '.';
        case '\u2026':
            return '...';
        case '\u2014': case '\u2013':
            return '-';
        default:
            return char.toLowerCase();
    }
}

function shouldRemoveForLooseMatch(char) {
    return /\s/.test(char) || char === '\\';
}

function dehydrate(text) {
    let normalized = '';
    for (const char of text) {
        if (shouldRemoveForLooseMatch(char)) {
            continue;
        }
        normalized += normalizeLooseMatchChar(char);
    }
    return normalized;
}

function mapDehydratedIndexToOriginal(content, dehydratedIndex) {
    let originalIndex = 0;
    let count = 0;
    while (originalIndex < content.length) {
        const char = content[originalIndex];
        if (shouldRemoveForLooseMatch(char)) {
            originalIndex++;
            continue;
        }
        if (count === dehydratedIndex) {
            return originalIndex;
        }
        count += normalizeLooseMatchChar(char).length;
        originalIndex++;
    }
    return originalIndex;
}

function extractSmartProbes(target, maxProbes = 8) {
    const probes = [];
    probes.push(target.substring(0, 12));
    probes.push(target.substring(target.length - 12));
    const structuralMatches = target.match(/[^\u4e00-\u9fa5\n]{3,}/g) || [];
    for (const match of structuralMatches.slice(0, 4)) {
        const idx = target.indexOf(match);
        probes.push(target.substring(idx, idx + 12));
    }
    const step = Math.max(1, Math.floor(target.length / maxProbes));
    for (let i = step; i < target.length - 12; i += step) {
        probes.push(target.substring(i, i + 12));
    }
    return [...new Set(probes)].filter((p) => p.length >= 8).slice(0, maxProbes);
}

function emergencyFallback(content, target) {
    const head = target.substring(0, 15);
    const tail = target.substring(target.length - 15);
    const headIdx = content.indexOf(head);
    const tailIdx = content.indexOf(tail);
    if (headIdx !== -1 || tailIdx !== -1) {
        const anchor = headIdx !== -1 ? headIdx : tailIdx;
        const start = Math.max(0, anchor - 50);
        const end = Math.min(content.length, anchor + Math.min(target.length, 300) + 50);
        return { mode: 'anchor_fallback', segment: content.substring(start, end) };
    }
    const keywords = target.match(/[a-zA-Z0-9#\[\]]{2,}|[\u4e00-\u9fa5]{2,}/g) || [];
    const keywordHits = keywords.filter((kw) => content.includes(kw));
    if (keywordHits.length > 0) {
        const firstHitIdx = content.indexOf(keywordHits[0]);
        const start = Math.max(0, firstHitIdx - 100);
        const end = Math.min(content.length, firstHitIdx + 400);
        return { mode: 'keyword_fallback', matchedKeywords: keywordHits, segment: content.substring(start, end) };
    }
    return null;
}

function probeMatch(content, probes) {
    const positions = [];
    let hitCount = 0;
    for (const probe of probes) {
        const idx = content.indexOf(probe);
        if (idx !== -1) {
            positions.push(idx);
            hitCount++;
        }
    }
    return { positions, hitCount };
}

function extractBestSegment(content, positions, targetLength) {
    if (positions.length === 0) return null;

    const sorted = [...positions].sort((a, b) => a - b);
    let bestStart = sorted[0];
    let bestCount = 0;
    const windowSize = targetLength;

    for (let i = 0; i < sorted.length; i++) {
        let count = 0;
        for (let j = i; j < sorted.length; j++) {
            if (sorted[j] - sorted[i] <= windowSize) {
                count++;
            } else {
                break;
            }
        }
        if (count > bestCount) {
            bestCount = count;
            bestStart = sorted[i];
        }
    }

    const margin = Math.floor(targetLength * 0.1);
    let segStart = Math.max(0, bestStart - margin);
    let segEnd = Math.min(content.length, segStart + targetLength + margin * 2);
    if (segEnd - segStart > targetLength * 1.5) {
        segEnd = segStart + Math.ceil(targetLength * 1.5);
    }
    segEnd = Math.min(segEnd, content.length);

    return { segment: content.substring(segStart, segEnd), startIdx: segStart };
}

function computeLCSIndices(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const lcsA = [];
    const lcsB = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            lcsA.unshift(i - 1);
            lcsB.unshift(j - 1);
            i--;
            j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return { lcsA, lcsB };
}

function generateDiff(oldText, newText, oldLabel, newLabel) {
    const a = oldText.split('\n');
    const b = newText.split('\n');

    const { lcsA, lcsB } = computeLCSIndices(a, b);

    const ops = [];
    let i = 0, j = 0, k = 0;
    while (i < a.length || j < b.length) {
        if (k < lcsA.length && i === lcsA[k] && j === lcsB[k]) {
            ops.push({ type: ' ', line: a[i] });
            i++;
            j++;
            k++;
        } else if (k < lcsA.length && i < lcsA[k]) {
            ops.push({ type: '-', line: a[i] });
            i++;
        } else if (k < lcsB.length && j < lcsB[k]) {
            ops.push({ type: '+', line: b[j] });
            j++;
        } else {
            while (i < a.length) {
                ops.push({ type: '-', line: a[i] });
                i++;
            }
            while (j < b.length) {
                ops.push({ type: '+', line: b[j] });
                j++;
            }
        }
    }

    const hunks = [];
    const context = 3;
    let idx = 0;

    while (idx < ops.length) {
        while (idx < ops.length && ops[idx].type === ' ') idx++;
        if (idx >= ops.length) break;

        const hunkStart = Math.max(0, idx - context);
        let hunkEnd = idx + context + 1;

        while (true) {
            let nextChange = hunkEnd;
            while (nextChange < ops.length && ops[nextChange].type === ' ')
                nextChange++;
            if (nextChange >= ops.length) break;
            if (nextChange - hunkEnd <= context * 2) {
                hunkEnd = nextChange + context + 1;
            } else {
                break;
            }
        }

        hunkEnd = Math.min(ops.length, hunkEnd);

        let aLine = 1, bLine = 1;
        for (let p = 0; p < hunkStart; p++) {
            if (ops[p].type === ' ' || ops[p].type === '-') aLine++;
            if (ops[p].type === ' ' || ops[p].type === '+') bLine++;
        }

        const hunkOps = ops.slice(hunkStart, hunkEnd);
        const aCount = hunkOps.filter((o) => o.type === ' ' || o.type === '-').length;
        const bCount = hunkOps.filter((o) => o.type === ' ' || o.type === '+').length;

        const aRange = aCount === 0 ? `${aLine},0` : `${aLine}${aCount !== 1 ? ',' + aCount : ''}`;
        const bRange = bCount === 0 ? `${bLine},0` : `${bLine}${bCount !== 1 ? ',' + bCount : ''}`;

        hunks.push(`@@ -${aRange} +${bRange} @@\n` + hunkOps.map((o) => o.type + o.line).join('\n'));
        idx = hunkEnd;
    }

    return `--- ${oldLabel}\n+++ ${newLabel}\n` + hunks.join('\n');
}

// --- 'update' Command Logic ---
async function atomicReplaceIfUnchanged(filePath, content, expectedStats) {
    const currentStats = await fs.stat(filePath);
    if (
        !expectedStats ||
        currentStats.size !== expectedStats.size ||
        currentStats.mtimeMs !== expectedStats.mtimeMs
    ) {
        const conflict = new Error(
            `Knowledge file changed concurrently before update commit: ${filePath}. ` +
            'Please read the latest content and retry.'
        );
        conflict.code = 'TDB_NOTE_WRITE_CONFLICT';
        throw conflict;
    }

    const crypto = require('crypto');
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );

    try {
        await fs.writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
        const beforeCommitStats = await fs.stat(filePath);
        if (
            beforeCommitStats.size !== expectedStats.size ||
            beforeCommitStats.mtimeMs !== expectedStats.mtimeMs
        ) {
            const conflict = new Error(
                `Knowledge file changed concurrently during update commit: ${filePath}. ` +
                'Please read the latest content and retry.'
            );
            conflict.code = 'TDB_NOTE_WRITE_CONFLICT';
            throw conflict;
        }
        await fs.rename(tempPath, filePath);
    } catch (error) {
        try {
            await fs.unlink(tempPath);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                console.warn(`[TDBnote] Failed to remove update temp file "${tempPath}": ${cleanupError.message}`);
            }
        }
        throw error;
    }
}

async function handleUpdateCommand(args) {
    debugLog("Processing 'update' command");

    const target = getArgumentValue(args, 'target');
    const replace = getArgumentValue(args, 'replace');
    const library = getArgumentValue(args, 'library', 'Library', 'knowledgeBase', 'KnowledgeBase');

    if (typeof target !== 'string' || typeof replace !== 'string') {
        return {
            status: 'error',
            error: "Invalid arguments for update: 'target' and 'replace' must be strings."
        };
    }

    if (target.length < 15) {
        return {
            status: 'error',
            error: `Security check failed: 'target' must be at least 15 characters long. Provided length: ${target.length}`
        };
    }

    try {
        const rootPath = getKnowledgeRootPath();
        let modificationDone = false;
        let modifiedFilePath = null;

        const probes = FUZZY_DIFF_ENABLED ? extractSmartProbes(target, 5) : [];
        let bestCandidate = null;
        const scannedFiles = [];

        // 搜索顺序：指定 library 精确匹配优先，其后遍历其余全部库
        const allLibraryDirs = await listLibraryDirs();
        const priorityDirs = [];
        const otherDirs = [];

        if (library && typeof library === 'string' && library.trim()) {
            const requestedAlias = normalizeLibraryAlias(library.trim());
            const exact = allLibraryDirs.find(dir => normalizeLibraryAlias(dir) === requestedAlias);
            if (exact) {
                priorityDirs.push(exact);
                debugLog(`Update scoped to library '${exact}' (requested '${library}').`);
            } else {
                debugLog(`Requested library '${library}' not found; searching all libraries.`);
            }
        }
        for (const dir of allLibraryDirs) {
            if (!priorityDirs.includes(dir)) {
                otherDirs.push(dir);
            }
        }

        const rules = getIndexabilityRules();
        const directoriesToScan = [...priorityDirs, ...otherDirs];
        debugLog(`Update search order: ${directoriesToScan.join(' -> ')}`);

        if (directoriesToScan.length === 0) {
            return {
                status: 'error',
                error: `No knowledge libraries found under ${rootPath}`
            };
        }

        for (const libraryName of directoriesToScan) {
            if (modificationDone) break;
            const dirPath = path.join(rootPath, libraryName);
            if (!isPathWithinBase(dirPath, rootPath)) {
                debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                continue;
            }
            try {
                const files = await fs.readdir(dirPath);
                const knowledgeFiles = files
                    .filter(file => {
                        const ext = path.extname(file).toLowerCase();
                        return rules.extensions.includes(ext);
                    })
                    .sort();
                debugLog(`Found ${knowledgeFiles.length} knowledge files in ${libraryName}`);

                for (const file of knowledgeFiles) {
                    if (modificationDone) break;
                    const filePath = path.join(dirPath, file);
                    let content;
                    let readVersion;
                    try {
                        const statsBeforeRead = await fs.stat(filePath);
                        content = await fs.readFile(filePath, 'utf-8');
                        const statsAfterRead = await fs.stat(filePath);
                        if (
                            statsBeforeRead.size !== statsAfterRead.size ||
                            statsBeforeRead.mtimeMs !== statsAfterRead.mtimeMs
                        ) {
                            debugLog(`Skipping concurrently changing knowledge file: ${filePath}`);
                            continue;
                        }
                        readVersion = statsAfterRead;
                    } catch (readErr) {
                        console.error(`[TDBnote] Error reading knowledge file ${filePath}:`, readErr.message);
                        continue;
                    }

                    let index = content.indexOf(target);

                    // Layer 1: Dehydration Match（全角/半角、空白、大小写差异归一）
                    if (index === -1) {
                        const dehydratedContent = dehydrate(content);
                        const dehydratedTarget = dehydrate(target);
                        const dIndex = dehydratedContent.indexOf(dehydratedTarget);
                        if (dIndex !== -1) {
                            index = mapDehydratedIndexToOriginal(content, dIndex);
                            debugLog(`Dehydrated match found in file: ${filePath}`);
                        }
                    }

                    if (index !== -1) {
                        debugLog(`Found target in file: ${filePath}`);
                        const newContent =
                            content.substring(0, index) +
                            replace +
                            content.substring(index + target.length);
                        try {
                            await atomicReplaceIfUnchanged(filePath, newContent, readVersion);
                            modificationDone = true;
                            modifiedFilePath = filePath;
                            break;
                        } catch (writeErr) {
                            if (writeErr.code === 'TDB_NOTE_WRITE_CONFLICT') {
                                return { status: 'error', error: writeErr.message, code: writeErr.code };
                            }
                            console.error(`[TDBnote] Error writing to knowledge file ${filePath}:`, writeErr.message);
                            break;
                        }
                    } else if (FUZZY_DIFF_ENABLED && probes.length > 0) {
                        const { positions, hitCount } = probeMatch(content, probes);
                        if (hitCount > 0 && (!bestCandidate || hitCount > bestCandidate.hitCount)) {
                            const segResult = extractBestSegment(content, positions, target.length);
                            if (segResult) {
                                bestCandidate = { filePath, segment: segResult.segment, hitCount };
                            }
                        }
                    }

                    if (FUZZY_DIFF_ENABLED) {
                        scannedFiles.push({ filePath, content });
                    }
                }
            } catch (dirError) {
                console.error(`[TDBnote] Error reading library directory ${dirPath}:`, dirError.message);
                continue;
            }
        }

        if (modificationDone) {
            const finalFileName = path.basename(modifiedFilePath);
            const libraryName = path.basename(path.dirname(modifiedFilePath));
            const indexStatus = triggerIndexing(modifiedFilePath);
            return {
                status: 'success',
                result: {
                    result: `Successfully edited knowledge file: ${modifiedFilePath}`,
                    message: `已成功更新知识库 "${libraryName}" 中的条目 (${finalFileName})，TriviumDB 重入库将在后台完成`,
                    targetFile: modifiedFilePath,
                    library: libraryName,
                    fileName: finalFileName,
                    indexStatus
                }
            };
        } else {
            const scopeDescription = library ? `library '${library}'` : '';
            const baseErrorMessage = scopeDescription
                ? `Target content not found in any knowledge files for ${scopeDescription}.`
                : 'Target content not found in any knowledge files.';
            const errorMessage = `${baseErrorMessage} ${UPDATE_FAILURE_HINT}`;

            if (FUZZY_DIFF_ENABLED && !bestCandidate) {
                for (const { filePath, content } of scannedFiles) {
                    const fallbackResult = emergencyFallback(content, target);
                    if (fallbackResult) {
                        bestCandidate = {
                            filePath,
                            segment: fallbackResult.segment,
                            hitCount: 0,
                            fallbackMode: fallbackResult.mode,
                            matchedKeywords: fallbackResult.matchedKeywords
                        };
                        break;
                    }
                }
            }

            if (FUZZY_DIFF_ENABLED && bestCandidate) {
                const diff = generateDiff(bestCandidate.segment, target, bestCandidate.filePath, 'target');
                return {
                    status: 'error',
                    error: errorMessage,
                    result: {
                        fuzzyDiff: {
                            candidateFile: bestCandidate.filePath,
                            diff: diff
                        }
                    }
                };
            }

            return { status: 'error', error: errorMessage };
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                status: 'error',
                error: `Knowledge root directory not found at ${getKnowledgeRootPath()}`
            };
        }
        console.error("[TDBnote] Unexpected error during 'update' command:", error);
        return { status: 'error', error: `An unexpected error occurred: ${error.message}` };
    }
}

// --- 'list' Command Logic ---
async function handleListCommand(args) {
    const library = getArgumentValue(args, 'library', 'Library', 'knowledgeBase', 'KnowledgeBase');
    const rootPath = getKnowledgeRootPath();
    const rules = getIndexabilityRules();

    try {
        // 列出所有知识库及其条目数
        if (!library || !library.trim()) {
            const libraryDirs = await listLibraryDirs();
            const libraries = [];
            for (const libraryName of libraryDirs) {
                const dirPath = path.join(rootPath, libraryName);
                if (!isPathWithinBase(dirPath, rootPath)) continue;
                try {
                    const files = await fs.readdir(dirPath);
                    const count = files.filter(file => rules.extensions.includes(path.extname(file).toLowerCase())).length;
                    libraries.push({ library: libraryName, fileCount: count });
                } catch (e) {
                    libraries.push({ library: libraryName, fileCount: -1, error: e.message });
                }
            }
            libraries.sort((a, b) => b.fileCount - a.fileCount);
            return {
                status: 'success',
                result: {
                    root: rootPath,
                    libraryCount: libraries.length,
                    libraries: libraries
                }
            };
        }

        // 列出指定知识库内的条目文件
        const resolution = await resolveLibraryName(library);
        const libraryName = resolution.libraryName;
        const dirPath = path.join(rootPath, libraryName);
        if (!isPathWithinBase(dirPath, rootPath)) {
            return { status: 'error', error: 'Security error: Invalid library path detected.' };
        }

        let files = [];
        try {
            files = await fs.readdir(dirPath);
        } catch (e) {
            if (e.code === 'ENOENT') {
                return { status: 'error', error: `Library '${libraryName}' does not exist under ${rootPath}. 可先使用不带 library 参数的 list 查看全部知识库。` };
            }
            throw e;
        }

        const entries = [];
        for (const file of files.sort()) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.stat(filePath).catch(() => null);
            if (!stats || !stats.isFile()) continue;
            entries.push({
                fileName: file,
                size: stats.size,
                modifiedAt: stats.mtime.toISOString()
            });
        }

        return {
            status: 'success',
            result: {
                root: rootPath,
                library: libraryName,
                matchedExisting: resolution.matchedExisting,
                fileCount: entries.length,
                files: entries
            }
        };
    } catch (error) {
        console.error("[TDBnote] Error during 'list' command:", error.message);
        return { status: 'error', error: error.message || "An unknown error occurred during list." };
    }
}

// --- Shared Command Dispatcher ---
async function dispatchCommand(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { status: 'error', error: 'TDBnote request must be a JSON object.' };
    }

    const { command, ...parameters } = args;

    // 鲁棒性兼容：AI 有时会遗漏 command 或拼错，按参数形状推断。
    const rawCommand = typeof command === 'string' ? command.trim().toLowerCase() : command;
    const hasUpdateTargetReplace =
        typeof getArgumentValue(parameters, 'target') === 'string' &&
        typeof getArgumentValue(parameters, 'replace') === 'string';

    let normalizedCommand = rawCommand;
    if (rawCommand !== 'create' && rawCommand !== 'update' && rawCommand !== 'list') {
        if (hasUpdateTargetReplace) {
            normalizedCommand = 'update';
            debugLog(`Command '${command || ''}' is missing or invalid; inferred 'update' from target/replace arguments.`);
        } else if (typeof getArgumentValue(parameters, 'library', 'Library') === 'string' &&
            (parameters.contentText || parameters.Content || parameters.content)) {
            normalizedCommand = 'create';
            debugLog(`Command '${command || ''}' is missing or invalid; inferred 'create' from content arguments.`);
        } else if (typeof getArgumentValue(parameters, 'library', 'Library') === 'string' || Object.keys(parameters).length === 0) {
            normalizedCommand = 'list';
            debugLog(`Command '${command || ''}' is missing or invalid; inferred 'list'.`);
        }
    }

    switch (normalizedCommand) {
        case 'create':
            return handleCreateCommand(parameters);
        case 'update':
            return handleUpdateCommand(parameters);
        case 'list':
            return handleListCommand(parameters);
        default:
            return { status: 'error', error: `Unknown command: '${normalizedCommand}'. Use 'create', 'update' or 'list'.` };
    }
}

// --- Resident Service Lifecycle (与 DailyNote 同构) ---
function enqueueResidentRequest(args, context = {}) {
    if (!residentAcceptingRequests) {
        return Promise.resolve({
            status: 'error',
            error: 'TDBnote service is shutting down and no longer accepts new requests.'
        });
    }

    residentPendingCount++;
    const requestLabel = `TDBnote:${args?.command || 'inferred'}:${Date.now()}:${residentPendingCount}`;

    const execute = async () => {
        if (context.signal?.aborted) {
            return { status: 'error', error: 'TDBnote request was aborted before execution.' };
        }
        return dispatchCommand(args);
    };

    const requestPromise = residentQueue.then(execute);
    residentQueue = requestPromise.catch(error => {
        console.error('[TDBnote] Resident queue task failed:', error);
    }).finally(() => {
        residentPendingCount = Math.max(0, residentPendingCount - 1);
    });

    return requestPromise;
}

function initialize(config = {}, dependencies = {}) {
    tdbKnowledgeManager =
        dependencies.tdbKnowledgeManager ||
        tdbKnowledgeManager;
    residentAcceptingRequests = true;
    residentInitialized = true;
    knowledgeRootPath = null; // 让首次调用重新解析（注入的 manager 可能在 initialize 之后才就绪）
    console.log(
        `[TDBnote] ✅ Resident service initialized. Root: ${getKnowledgeRootPath()}, ` +
        `TDB coordinator: ${tdbKnowledgeManager ? 'connected' : 'unavailable (files will still be written; indexing deferred)'}`
    );
}

function setDependencies(dependencies = {}) {
    tdbKnowledgeManager =
        dependencies.tdbKnowledgeManager ||
        tdbKnowledgeManager;
    knowledgeRootPath = null;
    if (tdbKnowledgeManager) {
        console.log('[TDBnote] 🔗 TDBKnowledgeManager coordinator connected.');
    }
}

async function processToolCall(args, context = {}) {
    if (!residentInitialized) {
        return {
            status: 'error',
            error: 'TDBnote resident service has not been initialized.'
        };
    }
    return enqueueResidentRequest(args, context);
}

async function shutdown() {
    residentAcceptingRequests = false;
    await residentQueue;
    tdbKnowledgeManager = null;
    residentInitialized = false;
    console.log('[TDBnote] Resident service shutdown complete.');
}

// --- Legacy CLI/stdin Execution (调试与独立测试用) ---
async function main() {
    let inputData = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('readable', () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
            inputData += chunk;
        }
    });

    process.stdin.on('end', async () => {
        debugLog('Received stdin data:', inputData);
        let result;
        try {
            if (!inputData) {
                throw new Error("No input data received via stdin.");
            }
            result = await dispatchCommand(JSON.parse(inputData));
        } catch (error) {
            console.error("[TDBnote] Error processing request:", error.message);
            result = { status: "error", error: error.message || "An unknown error occurred." };
        }

        process.stdout.write(JSON.stringify(result));
        process.exit(result.status === "success" ? 0 : 1);
    });

    process.stdin.on('error', (err) => {
        console.error("[TDBnote] Stdin error:", err);
        process.stdout.write(JSON.stringify({ status: "error", error: "Error reading input." }));
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    initialize,
    setDependencies,
    processToolCall,
    shutdown,
    dispatchCommand,
    handleCreateCommand,
    handleUpdateCommand,
    handleListCommand
};
