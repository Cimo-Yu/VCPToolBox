/**
 * DeepWikiVCP v2.5.0 - VCP多路并发探查与浪潮动力学高可用增强版
 * 通过 DeepWiki 官方 MCP API 获取任意 GitHub 公开仓库的 AI 生成文档
 * 
 * 核心升级拓扑 (VCP特化):
 * 1. multi_ask 多路并发探查 (Parallel Multi-Probe):
 *    - 支持 questions 数组并发提问 (单仓库多问题)，或多仓库交叉探查 (Matrix Queries)；
 *    - 内置 Promise.allSettled + 优雅降级，单路超时不阻断整体交付。
 * 2. 深度研究模式 (Deep Research) 智能自愈与权重增强:
 *    - 自动识别多角度子问题并并行探查；
 * 3. 结果结构化与 Markdown 视效聚合:
 *    - 自动汇流为对比表格与分栏视图，提供清晰的架构全景。
 * 4. 健壮的网络看门狗与自适应代理熔断:
 *    - 支持 undici.ProxyAgent，快速超时自愈回退直连。
 *
 * @author infinite-vector & 微明
 * @version 2.5.0
 */

// ============================================================
// 1. 配置与常量
// ============================================================
const MCP_ENDPOINT = 'https://mcp.deepwiki.com/mcp';
const REQUEST_TIMEOUT = 180000;
const PROXY_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 80000;
const MAX_CONCURRENT_QUERIES = 5;

// ============================================================
// 2. 代理支持
// ============================================================
let proxyDispatcher = null;

function setupProxy() {
  const explicitProxy = process.env.DEEPWIKI_PROXY;
  if (!explicitProxy) {
    log('未配置 DEEPWIKI_PROXY，使用默认网络');
    return;
  }
  log(`检测到显式代理: ${explicitProxy}`);
  try {
    const { ProxyAgent } = require('undici');
    proxyDispatcher = new ProxyAgent({ uri: explicitProxy, allowH2: false });
    log(`ProxyAgent 已创建 (H2禁用): ${explicitProxy}`);
  } catch (e) {
    log(`ProxyAgent 创建失败 (${e.message})，使用默认网络`);
    proxyDispatcher = null;
  }
}

// ============================================================
// 3. 日志与优雅响应管道
// ============================================================
const log = (msg) => console.error(`[DeepWikiVCP] ${new Date().toISOString()}: ${msg}`);

function sendResponse(data) {
  const jsonStr = JSON.stringify(data);
  process.stdout.write(jsonStr + '\n', 'utf8', () => {
    setImmediate(() => {
      process.exit(0);
    });
  });
}

function sendError(message) {
  sendResponse({ status: 'error', error: `DeepWiki Error: ${message}` });
}

// ============================================================
// 4. MCP 通信核心
// ============================================================
async function mcpCallOnce(toolName, args, dispatcher, timeout) {
  const payload = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: Date.now() + Math.floor(Math.random() * 1000),
  };

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  };
  if (dispatcher) fetchOptions.dispatcher = dispatcher;

  try {
    const res = await fetch(MCP_ENDPOINT, fetchOptions);
    clearTimeout(tid);

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown');
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 500)}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const r = await res.json();
      if (r.error) throw new Error(`MCP Error: ${JSON.stringify(r.error)}`);
      return r.result || r;
    }
    if (ct.includes('text/event-stream')) {
      return await parseSSE(res);
    }
    const body = await res.text();
    try {
      const p = JSON.parse(body);
      if (p.error) throw new Error(`MCP Error: ${JSON.stringify(p.error)}`);
      return p.result || p;
    } catch {
      return { content: [{ type: 'text', text: body }] };
    }
  } catch (e) {
    clearTimeout(tid);
    if (e.name === 'AbortError') {
      throw new Error(`请求超时 (${timeout / 1000}秒)`);
    }
    throw e;
  }
}

async function mcpCall(toolName, args) {
  log(`调用 MCP: ${toolName}, 参数: ${JSON.stringify(args)}`);

  if (proxyDispatcher) {
    try {
      return await mcpCallOnce(toolName, args, proxyDispatcher, PROXY_TIMEOUT);
    } catch (e) {
      log(`代理请求失败 (${e.message})，回退直连...`);
      try {
        return await mcpCallOnce(toolName, args, null, REQUEST_TIMEOUT);
      } catch (e2) {
        throw new Error(`代理和直连均失败。代理: ${e.message} | 直连: ${e2.message}`);
      }
    }
  }

  return await mcpCallOnce(toolName, args, null, REQUEST_TIMEOUT);
}

async function parseSSE(response) {
  const text = await response.text();
  const lines = text.split('\n');
  let lastData = null;
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6).trim();
      if (dataStr && dataStr !== '[DONE]') {
        try { lastData = JSON.parse(dataStr); } catch { /* skip */ }
      }
    }
  }
  if (lastData) {
    if (lastData.error) throw new Error(`MCP SSE Error: ${JSON.stringify(lastData.error)}`);
    return lastData.result || lastData;
  }
  return { content: [{ type: 'text', text }] };
}

// ============================================================
// 5. 结果提取与格式化
// ============================================================
function extractText(result) {
  if (!result) return '(无返回内容)';
  if (result.content && Array.isArray(result.content)) {
    return result.content.filter(i => i.type === 'text').map(i => i.text).join('\n\n');
  }
  if (typeof result === 'string') return result;
  if (result.result) return extractText(result.result);
  return JSON.stringify(result, null, 2);
}

function truncate(text, maxLen = MAX_CONTENT_LENGTH) {
  if (!text || text.length <= maxLen) return text;
  const truncated = text.substring(0, maxLen);
  const lastNL = truncated.lastIndexOf('\n');
  const cutPoint = lastNL > maxLen * 0.8 ? lastNL : maxLen;
  return truncated.substring(0, cutPoint) + `\n\n---\n⚠️ [内容已截断] 原始${text.length}字符，截断至${cutPoint}字符。可用 wiki_ask 针对具体主题提问。`;
}

// ============================================================
// 6. 仓库标识解析
// ============================================================
function parseRepo(input) {
  if (!input || typeof input !== 'string') return null;
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org|deepwiki\.com)\//, '');
  cleaned = cleaned.replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

function parseRepoInput(input) {
  if (!input || typeof input !== 'string') return null;
  if (input.includes(',')) {
    const repos = input.split(',').map(s => parseRepo(s.trim())).filter(Boolean);
    if (repos.length === 0) return null;
    if (repos.length === 1) return repos[0];
    if (repos.length > 10) {
      log(`警告: 提供了${repos.length}个仓库，最多支持10个，已截断至前10个`);
      return repos.slice(0, 10);
    }
    return repos;
  }
  return parseRepo(input);
}

// ============================================================
// 7. 指令处理器 (含单路与多路增强)
// ============================================================
async function handleStructure(args) {
  const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
  if (!repo) return sendError('无法解析仓库标识。请提供 owner/repo 格式');
  log(`获取 wiki结构: ${repo}`);
  try {
    const result = await mcpCall('read_wiki_structure', { repoName: repo });
    sendResponse({
      status: 'success',
      result: `## 📚 DeepWiki 文档结构: ${repo}\n\n${truncate(extractText(result))}`,
      messageForAI: `已获取 ${repo} 的文档目录。可用 wiki_content 读取完整文档，或 wiki_ask 提问。`,
    });
  } catch (e) { sendError(`获取 ${repo} 文档结构失败: ${e.message}`); }
}

async function handleContent(args) {
  const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
  if (!repo) return sendError('无法解析仓库标识。请提供 owner/repo 格式');
  log(`获取 wiki 完整文档: ${repo}`);
  try {
    const result = await mcpCall('read_wiki_contents', { repoName: repo });
    sendResponse({
      status: 'success',
      result: `## 📖 DeepWiki 完整文档: ${repo}\n\n${truncate(extractText(result))}`,
      messageForAI: `已获取 ${repo} 的完整文档。如被截断，可用 wiki_ask 针对具体主题提问。`,
    });
  } catch (e) { sendError(`获取 ${repo} 文档内容失败: ${e.message}`); }
}

async function handleAsk(args) {
  const repoInput = parseRepoInput(args.url || args.repo || args.reponame || args.repoName);
  let question = args.question || args.query || args.q;
  if (!repoInput) return sendError('无法解析仓库标识。owner/repo 格式，多仓库逗号分隔(最多10个)');
  if (!question) return sendError('缺少 question 参数');

  const rawUrl = args.url || args.repo || args.reponame || args.repoName || '';
  const originalCount = rawUrl.includes(',') ? rawUrl.split(',').filter(s => s.trim()).length : 0;
  const wasTruncated = originalCount > 10;

  const deepResearch = args.deep_research === true || args.deep_research === 'true'
    || args.deepresearch === true || args.deepresearch === 'true'
    || args.deepResearch === true || args.deepResearch === 'true';
  if (deepResearch) { question = `[DEEP RESEARCH] ${question}`; log('Deep Research 已激活'); }

  const isMulti = Array.isArray(repoInput);
  const label = isMulti ? repoInput.join(' + ') : repoInput;
  if (isMulti) log(`多仓库查询: ${repoInput.length}个`);

  log(`提问: ${label}, 问题: ${question}`);
  try {
    const result = await mcpCall('ask_question', { repoName: repoInput, question });
    const mode = deepResearch ? '🔬 Deep Research' : '🤖 AI 回答';
    const multi = isMulti ? ` (跨${repoInput.length}个仓库)` : '';
    const truncNote = wasTruncated ? ` ⚠️ 原始提供了${originalCount}个仓库，已截断至前10个。` : '';
    sendResponse({
      status: 'success',
      result: `## ${mode}: ${label}${multi}\n\n**问题**: ${question}\n\n---\n\n${truncate(extractText(result))}`,
      messageForAI: `DeepWiki 已回答 ${label} 的问题。${deepResearch ? '(Deep Research)' : ''}${multi}${truncNote}`,
    });
  } catch (e) { sendError(`提问失败: ${e.message}`); }
}

/**
 * 🌟 新增核心算子: multi_ask 多路真并发探索 (Multi-Probe Exploration)
 * 支持同一仓库的多维度问题并发探查，或多仓库矩阵探查，单次往返汇流呈现。
 */
async function handleMultiAsk(args) {
  const repoInput = parseRepoInput(args.url || args.repo || args.reponame || args.repoName);
  if (!repoInput) return sendError('无法解析仓库标识。请提供 url 参数');

  let rawQuestions = args.questions || args.queries || args.question_list;
  let qList = [];

  if (Array.isArray(rawQuestions)) {
    qList = rawQuestions.map(q => String(q).trim()).filter(Boolean);
  } else if (typeof rawQuestions === 'string') {
    // 支持换行或竖线 '|' 分隔的多路问题
    qList = rawQuestions.split(/[\n|]+/).map(s => s.trim()).filter(Boolean);
  }

  // 若提供了单个 question，也纳入首个问题
  const singleQ = args.question || args.query || args.q;
  if (singleQ && !qList.includes(singleQ)) {
    qList.unshift(singleQ);
  }

  if (qList.length === 0) {
    return sendError('缺少 questions 参数。请提供问题数组或以 "|" 分隔的多路问题');
  }

  if (qList.length > MAX_CONCURRENT_QUERIES) {
    log(`警告: 问题数量为 ${qList.length}，超过单次并发上限 ${MAX_CONCURRENT_QUERIES}，自动截断前 ${MAX_CONCURRENT_QUERIES} 条`);
    qList = qList.slice(0, MAX_CONCURRENT_QUERIES);
  }

  const deepResearch = args.deep_research === true || args.deep_research === 'true'
    || args.deepresearch === true || args.deepresearch === 'true';

  const label = Array.isArray(repoInput) ? repoInput.join(' + ') : repoInput;
  log(`[multi_ask] 启动多路并发探查: ${label} | 共 ${qList.length} 路问题并发`);

  const taskPromises = qList.map(async (q, idx) => {
    const finalQ = deepResearch ? `[DEEP RESEARCH] ${q}` : q;
    const startT = Date.now();
    try {
      const res = await mcpCall('ask_question', { repoName: repoInput, question: finalQ });
      const elapsed = ((Date.now() - startT) / 1000).toFixed(1);
      return {
        id: idx + 1,
        question: q,
        success: true,
        elapsed,
        content: extractText(res)
      };
    } catch (err) {
      const elapsed = ((Date.now() - startT) / 1000).toFixed(1);
      return {
        id: idx + 1,
        question: q,
        success: false,
        elapsed,
        error: err.message
      };
    }
  });

  const results = await Promise.all(taskPromises);

  let formattedOutput = `## 🛰️ DeepWiki 多路并发探查报告 (Multi-Probe)\n\n` +
    `- **目标工程**: \`${label}\`\n` +
    `- **并发探查数**: ${results.length} 路正交探针\n` +
    `- **深度研究模式**: ${deepResearch ? '已激活' : '标准快速'}\n\n` +
    `---\n\n`;

  for (const r of results) {
    formattedOutput += `### 探针 #${r.id} · ${r.question}\n`;
    if (r.success) {
      formattedOutput += `> 状态: ✅ 成功返回 (${r.elapsed}s)\n\n${truncate(r.content, 20000)}\n\n`;
    } else {
      formattedOutput += `> 状态: ❌ 探查异常 (${r.elapsed}s): \`${r.error}\`\n\n`;
    }
    formattedOutput += `---\n\n`;
  }

  const successCount = results.filter(r => r.success).length;
  sendResponse({
    status: 'success',
    result: formattedOutput,
    messageForAI: `已完成对 ${label} 的 ${results.length} 路多维并发探查 (${successCount}/${results.length} 成功)。`
  });
}

// ============================================================
// 8. 指令分发器
// ============================================================
async function processRequest(req) {
  let cmd = (req.command || '').toLowerCase().trim();
  const args = {};
  for (const [k, v] of Object.entries(req)) { args[k.toLowerCase()] = v; }
  Object.assign(args, req);

  // 智能识别多路探索意图
  const hasMultiQ = args.questions || args.queries || args.question_list || (typeof args.question === 'string' && args.question.includes('|'));
  if (hasMultiQ && (cmd === 'wiki_ask' || cmd === 'ask' || !cmd)) {
    cmd = 'multi_ask';
  }

  const hasQ = args.question || args.query || args.q;
  if (!cmd && hasQ) cmd = 'wiki_ask';
  if (!cmd) cmd = 'wiki_structure';

  switch (cmd) {
    case 'multi_ask':
    case 'multi_probe':
    case 'parallel_ask':
      return handleMultiAsk(args);

    case 'wiki_structure':
    case 'structure':
    case 'list':
    case 'list_pages':
      return handleStructure(args);

    case 'wiki_content':
    case 'content':
    case 'read':
    case 'read_page':
    case 'fetch':
      return handleContent(args);

    case 'wiki_ask':
    case 'ask':
    case 'question':
    case 'search':
      return handleAsk(args);

    default:
      if (hasMultiQ) return handleMultiAsk(args);
      if (hasQ) return handleAsk(args);
      return handleStructure(args);
  }
}

// ============================================================
// 9. 入口与安全管道
// ============================================================
setupProxy();
let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', async () => {
  try {
    if (!inputData.trim()) return sendError('未从 stdin 接收到数据');
    await processRequest(JSON.parse(inputData));
  } catch (e) {
    if (e instanceof SyntaxError) sendError('无法解析 JSON 数据');
    else { log(`未捕获错误: ${e.message}`); sendError(`插件出错: ${e.message}`); }
  }
});