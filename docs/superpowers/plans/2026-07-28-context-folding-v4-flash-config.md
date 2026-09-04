# ContextFoldingV2 Local Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure ContextFoldingV2 reliably uses the model and prompts declared in its plugin-local `config.env`, including `deepseek-v4-flash`, and remove the malformed system-prompt value that can cause summary validation failures.

**Architecture:** Keep `API_URL` and `API_Key` sourced from the process-level root configuration, but make the `FOLDING_*` settings local to ContextFoldingV2 and deterministic. The plugin will explicitly parse its own `config.env` and apply only the documented folding keys to its instance configuration, avoiding accidental dependence on startup working directory or pre-existing global `process.env` values.

**Tech Stack:** Node.js, dotenv 16.5.0, axios, existing ContextFoldingV2 plugin, Node built-in `assert`.

## Global Constraints

- Modify only `D:\vcp\VCPToolBox\Plugin\ContextFoldingV2` files and plugin-local tests.
- Preserve process-level `API_URL` and `API_Key`; do not copy credentials into the plugin configuration file.
- Plugin-local `FOLDING_*` values take precedence over same-named inherited process environment variables.
- Preserve existing defaults when a folding setting is absent or invalid.
- Keep summary API endpoint, payload fields, validation format, retry behavior, and SQLite state transitions unchanged.
- The corrected system prompt must retain the required output marker `[VCP上下文语义折叠-本层摘要:摘要内容]`.

---

### Task 1: Add deterministic plugin-local folding configuration loading

**Files:**
- Modify: `D:\vcp\VCPToolBox\Plugin\ContextFoldingV2\ContextFoldingV2.js:61-71`
- Create: `D:\vcp\VCPToolBox\Plugin\ContextFoldingV2\test\config-loading.test.js`

**Interfaces:**
- Consumes: `Plugin/ContextFoldingV2/config.env` with optional `FOLDING_SUMMARY_MODEL`, `FOLDING_SUMMARY_SYSTEM_PROMPT`, `FOLDING_SUMMARY_USER_PROMPT`, `FOLDING_MIN_DEPTH`, `FOLDING_MAX_RETRIES`, and `FOLDING_SUMMARY_MAX_CONCURRENT`.
- Produces: `ContextFoldingV2.initialize(config, dependencies)` instance fields `summaryModel`, `summarySystemPrompt`, `summaryUserPrompt`, `minDepth`, `maxRetries`, and `maxConcurrentSummaries` based on plugin-local values.

- [ ] **Step 1: Write a failing configuration-precedence test**

Create `Plugin/ContextFoldingV2/test/config-loading.test.js` with a Node `assert` test that temporarily sets an inherited `process.env.FOLDING_SUMMARY_MODEL` to a distinct value, initializes the plugin using a temporary plugin-local env fixture containing `FOLDING_SUMMARY_MODEL=deepseek-v4-flash`, and asserts that `instance.summaryModel === 'deepseek-v4-flash'`.

```js
const assert = require('assert');

assert.strictEqual(instance.summaryModel, 'deepseek-v4-flash');
```

Stub only the minimum ContextBridge contract required by `initialize`:

```js
const dependencies = {
  contextBridge: {
    version: 'test',
    foldingStore: { getStats: () => ({ available: false }) }
  }
};
```

- [ ] **Step 2: Run the test and verify the current behavior fails**

Run from `D:\vcp\VCPToolBox`:

```bash
node Plugin/ContextFoldingV2/test/config-loading.test.js
```

Expected: FAIL because the current `dotenv.config({ path: envPath })` does not override the inherited `process.env.FOLDING_SUMMARY_MODEL` value.

- [ ] **Step 3: Implement an instance-local configuration reader**

In `ContextFoldingV2.initialize`, replace reliance on mutable global `process.env.FOLDING_*` values with a parsed plugin-local object:

```js
const localEnv = dotenv.config({ path: envPath }).parsed || {};
const getFoldingEnv = (name) => localEnv[name] ?? process.env[name];

this.summaryModel = getFoldingEnv('FOLDING_SUMMARY_MODEL') || 'gemini-3.1-flash-lite-preview';
this.summarySystemPrompt = (getFoldingEnv('FOLDING_SUMMARY_SYSTEM_PROMPT') || '').replace(/\\n/g, '\n');
this.summaryUserPrompt = (getFoldingEnv('FOLDING_SUMMARY_USER_PROMPT') || '').replace(/\\n/g, '\n');
this.minDepth = Math.max(2, parseInt(getFoldingEnv('FOLDING_MIN_DEPTH'), 10) || 3);
this.maxRetries = parseInt(getFoldingEnv('FOLDING_MAX_RETRIES'), 10) || 3;
this.maxConcurrentSummaries = Math.max(1, parseInt(getFoldingEnv('FOLDING_SUMMARY_MAX_CONCURRENT'), 10) || 5);
```

Do not change reads of `process.env.API_URL`, `process.env.API_Key`, or `process.env.PROJECT_BASE_PATH`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node Plugin/ContextFoldingV2/test/config-loading.test.js
```

Expected: PASS; the local `deepseek-v4-flash` value wins over the inherited test value.

- [ ] **Step 5: Run syntax validation**

Run:

```bash
node --check Plugin/ContextFoldingV2/ContextFoldingV2.js
```

Expected: exit code 0.

- [ ] **Step 6: Commit the task**

This directory is not currently a Git worktree. If it becomes one before implementation, commit only these files:

```bash
git add Plugin/ContextFoldingV2/ContextFoldingV2.js Plugin/ContextFoldingV2/test/config-loading.test.js
git commit -m "fix: load local context folding config deterministically"
```

### Task 2: Correct the plugin-local system-prompt value

**Files:**
- Modify: `D:\vcp\VCPToolBox\Plugin\ContextFoldingV2\config.env:9`
- Test: `D:\vcp\VCPToolBox\Plugin\ContextFoldingV2\test\config-loading.test.js`

**Interfaces:**
- Consumes: `FOLDING_SUMMARY_SYSTEM_PROMPT` as one dotenv `KEY=value` entry using literal `\n` escapes.
- Produces: `summarySystemPrompt` beginning with `上下文压缩器。` and containing the required VCP fold marker instruction exactly once.

- [ ] **Step 1: Add a failing system-prompt parsing assertion**

Extend `Plugin/ContextFoldingV2/test/config-loading.test.js`:

```js
assert.ok(instance.summarySystemPrompt.startsWith('上下文压缩器。'));
assert.ok(instance.summarySystemPrompt.includes('[VCP上下文语义折叠-本层摘要:摘要内容]'));
assert.ok(!instance.summarySystemPrompt.startsWith('FOLDING_SUMMARY_SYSTEM_PROMPT='));
```

- [ ] **Step 2: Run the test and verify it fails against the malformed value**

Run:

```bash
node Plugin/ContextFoldingV2/test/config-loading.test.js
```

Expected: FAIL on the final assertion because the current parsed value starts with `FOLDING_SUMMARY_SYSTEM_PROMPT=`.

- [ ] **Step 3: Correct only the duplicate assignment prefix**

In `Plugin/ContextFoldingV2/config.env`, change line 9 from:

```env
FOLDING_SUMMARY_SYSTEM_PROMPT=FOLDING_SUMMARY_SYSTEM_PROMPT=上下文压缩器。输出单行格式：[VCP上下文语义折叠-本层摘要:摘要内容]\n规则：\n1.提取：核心动作、关键实体(人名/文件名/工具名/技术概念)、结论与决策、工具调用结果\n2.剥离：寒暄问候、表情符号、语气词、修辞装饰、排版格式、冗余解释\n3.摘要≤100字。
```

to:

```env
FOLDING_SUMMARY_SYSTEM_PROMPT=上下文压缩器。输出单行格式：[VCP上下文语义折叠-本层摘要:摘要内容]\n规则：\n1.提取：核心动作、关键实体(人名/文件名/工具名/技术概念)、结论与决策、工具调用结果\n2.剥离：寒暄问候、表情符号、语气词、修辞装饰、排版格式、冗余解释\n3.摘要≤100字。
```

Do not alter `FOLDING_SUMMARY_MODEL=deepseek-v4-flash`, the user prompt, depth, retries, or concurrency values.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node Plugin/ContextFoldingV2/test/config-loading.test.js
```

Expected: PASS; the parsed system prompt begins directly with `上下文压缩器。` and preserves the required marker.

- [ ] **Step 5: Commit the task**

If Git is available in the implementation directory, commit only these files:

```bash
git add Plugin/ContextFoldingV2/config.env Plugin/ContextFoldingV2/test/config-loading.test.js
git commit -m "fix: correct context folding summary prompt"
```

### Task 3: Verify the repaired live initialization and fold lifecycle

**Files:**
- Modify: none
- Inspect: `D:\vcp\VCPToolBox\DebugLog\ServerLog.txt`
- Inspect: `D:\vcp\VCPToolBox\Plugin\RAGDiaryPlugin\folding_store.db`

**Interfaces:**
- Consumes: restarted Toolbox process and a conversation with the ContextFoldingV2 system marker, at least three eligible historical assistant messages, and a semantically unrelated latest user request.
- Produces: initialization log showing `模型: deepseek-v4-flash`; a FoldingStore state transition from `none` to `pending` to `ready`; and a subsequent request whose old assistant block is replaced by a VCP fold summary.

- [ ] **Step 1: Restart Toolbox from its root directory**

Run from `D:\vcp\VCPToolBox` so root API credentials load from its root `config.env`:

```bash
npm start
```

Expected initialization log contains:

```text
[ContextFoldingV2] 初始化完成 (模型: deepseek-v4-flash,
```

- [ ] **Step 2: Trigger one eligible asynchronous summary**

Use a conversation whose final system message includes `[[ContextFoldingV2]]`, has at least three prior assistant replies, and then submit a user message unrelated to one older assistant reply.

Expected current request remains unmodified while ContextFoldingV2 writes a background task to FoldingStore and logs either successful completion or a precise API/validation failure.

- [ ] **Step 3: Inspect server output for the summary request result**

Look in `DebugLog/ServerLog.txt` for one of:

```text
[ContextFoldingV2] ✅ 摘要生成成功:
[ContextFoldingV2] 摘要API错误:
[ContextFoldingV2] 摘要请求失败:
[ContextFoldingV2] 验证失败[结构]:
```

Expected for a successful repair: `✅ 摘要生成成功` and no accompanying summary API or validation failure for the same hash.

- [ ] **Step 4: Send a second request and verify replacement**

After the success log, send one more user request. Inspect the post-preprocessor payload/log and confirm the eligible old assistant content is replaced by:

```text
[VCP上下文语义折叠-本层摘要:...]
```

Expected: the record is `ready`, and the second request—not the first trigger request—uses the folded representation.

- [ ] **Step 5: Document any remaining external failure exactly**

If a request still fails, preserve the exact `摘要API错误` HTTP status/body fragment or `验证失败` log line before changing code. Treat a non-200 model error as a gateway/model-ID issue; treat a structure-validation error as a prompt/model-output issue.
