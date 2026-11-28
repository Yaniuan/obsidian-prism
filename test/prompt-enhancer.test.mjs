// Modified by Yaniuan on 2026-11-28: cover downstream Prompt Enhancer integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import {
  DEFAULT_PROMPT_ENHANCER_CONFIG,
  PromptEnhancerService,
  buildEnhancementSystemPrompt,
  classifyEnhancementTask,
  cleanEnhancedOutput,
  compactContextText,
  detectOutputIssue,
  extractAssistantResult,
  extractProtectedTokens,
  extractUrls,
  preservesProtectedTokens,
  restoreMissingUrls,
  sanitizeEnhancerTurns,
  stripPromptAsterisks,
} from '../vendor/prompt-enhancer/prompt-enhancer-service.mjs';
import cdpFacade from '../cdp.js';
const { PROMPT_ENHANCER_BINDING, buildPromptEnhancerExpression, buildSuggesterExpression } = cdpFacade;
import { PrismDaemon, PROMPT_ENHANCER_BINDING as DAEMON_PROMPT_ENHANCER_BINDING } from '../sidecars/daemon/main.mjs';

test('Full uninstall tears down the enhancer and its bridge', () => {
  const calls = [];
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    __agPrismPromptEnhancer: { destroy: () => calls.push('client') },
    __agPrismPromptEnhancerBridge: { dispose: () => calls.push('bridge') },
  };
  vm.runInNewContext(cdpFacade.REMOVE_EXPRESSION, { window, document });
  assert.deepEqual(calls, ['client', 'bridge']);
  assert.equal(window.__agPrismPromptEnhancer, undefined);
  assert.equal(window.__agPrismPromptEnhancerBridge, undefined);
});

function makeTranslator({ body = { choices: [{ message: { content: '**目标**\n*完成任务*' } }] }, status = 200, delayMs = 0 } = {}) {
  const store = {
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: 'Shared', baseUrl: 'https://api.example.test/v1', model: 'gpt-mini', apiKey: 'secret-token-1234' }],
  };
  return {
    loadStore: () => store,
    getSanitizedConfig: () => ({ profiles: [{ id: 'default', name: 'Shared', baseUrl: store.profiles[0].baseUrl, model: store.profiles[0].model, hasApiKey: true, keylessAllowed: false }] }),
    _resolveEffectiveCredentials: ({ profileId, model }) => ({ baseUrl: store.profiles[0].baseUrl, apiKey: store.profiles[0].apiKey, model: model || store.profiles[0].model }),
    _request: async (_url, options) => {
      if (delayMs) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), body: null };
    },
    _readResponseTextBounded: async (response) => await response.text(),
    fetchModels: async () => ({ ok: true, models: ['gpt-mini', 'gpt-pro'], latencyMs: 4 }),
    testConnection: async () => ({ ok: true, latencyMs: 3, reply: 'OK' }),
  };
}

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName)) this.value = '';
    this._text = '';
    this.isConnected = false;
  }
  get firstChild() { return this.children[0] || null; }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.children.forEach((child) => { child.parentNode = null; child.isConnected = false; }); this.children = []; this._text = String(value || ''); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { if (!node) return node; node.parentNode?.removeChild?.(node); node.parentNode = this; node.isConnected = this.isConnected || this.tagName === 'BODY' || this.tagName === 'HTML'; this.children.push(node); return node; }
  removeChild(node) { const index = this.children.indexOf(node); if (index >= 0) { this.children.splice(index, 1); node.parentNode = null; node.isConnected = false; } return node; }
  remove() { this.parentNode?.removeChild?.(this); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); if (String(name) === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  dispatchEvent(event) { event.target ||= this; for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
  click() { if (!this.disabled && !this.hidden) this.dispatchEvent({ type: 'click', target: this }); }
  focus() {}
  closest(selector) {
    if (selector.includes('.surface-composer') || selector.includes('agent-input-box')) return this.testRoot || null;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const match = (node) => {
      const testId = /data-testid=["']([^"']+)["']/.exec(selector)?.[1];
      if (testId && node.getAttribute('data-testid') === testId) return true;
      const role = /role=["']([^"']+)["']/.exec(selector)?.[1];
      if (role && node.getAttribute('role') === role) return true;
      if (selector === 'button' && node.tagName === 'BUTTON') return true;
      if (selector === 'span:last-child') return node.tagName === 'SPAN' && node.parentNode?.children.at(-1) === node;
      if (selector.includes('contenteditable') || selector.includes('textarea')) return (this.ownerDocument.editors || [this.ownerDocument.editor]).includes(node);
      if (selector.includes('user-message-content')) return ['user-message-content', 'user-message-bubble', 'agent-response', 'planner-response-text'].includes(node.getAttribute('data-testid'));
      return false;
    };
    const walk = (node) => { for (const child of node.children) { if (match(child)) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { left: 180, right: 780, top: 520, bottom: 600, width: 600, height: 80 }; }
}

function createUiHarness(options = {}) {
  const doc = {
    documentElement: null,
    title: 'Antigravity',
    readyState: 'complete',
    createElement(tag) { return new FakeNode(tag, doc); },
    createElementNS(_namespace, tag) { return new FakeNode(tag, doc); },
    createTextNode(text) { const node = new FakeNode('#text', doc); node.textContent = text; return node; },
    getElementById(id) { return this.querySelector(`#${id}`); },
    querySelectorAll(selector) {
      if (selector.includes('conversation-view')) return [this.view, ...(this.extraViews || [])];
      if (selector.includes('data-testid') && !selector.includes(',')) return [this.body, this.documentElement].flatMap((root) => root.querySelectorAll(selector));
      if (selector.includes(',')) return [this.body, this.documentElement].flatMap((root) => root.querySelectorAll(selector));
      if (selector.startsWith('#')) {
        const id = selector.slice(1);
        return [this.head, this.body, this.documentElement].flatMap((root) => [root, ...root.querySelectorAll('*')]).filter((node) => node.id === id);
      }
      return [];
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    execCommand() { return false; },
    extraViews: [],
    editors: [],
  };
  const win = {
    document: doc,
    innerWidth: 1024,
    Event: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    InputEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    navigator: { clipboard: { writeText: async (text) => { win.copied = text; } } },
  };
  win.window = win;
  doc.defaultView = win;
  doc.documentElement = new FakeNode('html', doc);
  doc.documentElement.lang = 'en';
  if (options.lang) doc.documentElement.setAttribute('data-ag-cs-lang', options.lang);
  doc.documentElement.isConnected = true;
  doc.head = new FakeNode('head', doc);
  doc.body = new FakeNode('body', doc);
  doc.head.isConnected = true;
  doc.body.isConnected = true;
  doc.documentElement.append(doc.head, doc.body);
  const root = new FakeNode('div', doc);
  root.className = 'surface-composer';
  root.isConnected = true;
  const editor = new FakeNode(options.editorTag || 'div', doc);
  if (editor.tagName === 'TEXTAREA') editor.value = '实现一个设置页';
  else {
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('data-lexical-editor', 'true');
    editor.textContent = '实现一个设置页';
  }
  editor.isConnected = true;
  editor.testRoot = root;
  root.appendChild(editor);
  let footer = null;
  if (options.footer) {
    footer = new FakeNode('footer', doc);
    footer.className = 'agy-composer-footer';
    footer.setAttribute('data-testid', 'input-box-bottom-toolbar');
    footer.isConnected = true;
    root.appendChild(footer);
  }
  doc.view = new FakeNode('section', doc);
  doc.view.setAttribute('data-testid', 'conversation-view');
  doc.view.isConnected = true;
  const priorTurn = new FakeNode('div', doc);
  priorTurn.setAttribute('data-testid', 'user-message-content');
  priorTurn.textContent = '项目使用 React 和 TypeScript';
  const priorReply = new FakeNode('div', doc);
  priorReply.setAttribute('data-testid', 'agent-response');
  priorReply.textContent = '好的，将基于 React 和 TypeScript 实现';
  doc.view.appendChild(priorTurn);
  doc.view.appendChild(priorReply);
  doc.view.appendChild(root);
  doc.body.appendChild(doc.view);
  doc.editor = editor;
  doc.editors.push(editor);
  const requests = [];
  win.__agPrismPromptEnhancerCall = (raw) => {
    const request = JSON.parse(raw);
    const bridge = win.__agPrismPromptEnhancerBridge;
    requests.push(request);
    if (request.action === 'get-config') {
      queueMicrotask(() => bridge?.resolve(request.id, { ok: true, config: { enabled: true, profileId: 'shared', model: 'gpt-mini' } }));
    } else if (request.action === 'cancel') {
      const pending = requests.find((item) => item.action === 'enhance' && item.payload.requestId === request.payload.requestId);
      if (pending) queueMicrotask(() => bridge?.resolve(pending.id, { ok: false, cancelled: true, reason: 'cancelled' }));
      queueMicrotask(() => bridge?.resolve(request.id, { ok: true, cancelled: true }));
    }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../vendor/prompt-enhancer/prompt-enhancer-client.js', import.meta.url), 'utf8'), win);
  const runtime = win.__agPrismPromptEnhancerFactory({ window: win, document: doc, initialConfig: options.initialConfig });
  return { win, doc, editor, root, footer, requests, runtime };
}

async function until(predicate, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for UI state');
}

test('Prompt Enhancer defaults closed and classifies requested task families', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_PROMPT_ENHANCER_CONFIG, 'enabled'), false);
  assert.equal(DEFAULT_PROMPT_ENHANCER_CONFIG.includeRecentContext, false);
  assert.equal(DEFAULT_PROMPT_ENHANCER_CONFIG.recentContextCount, 1);
  assert.equal(classifyEnhancementTask('请修复这个 bug 并补回归测试'), 'bugFix');
  assert.equal(classifyEnhancementTask('把服务部署到生产环境并提供回滚步骤'), 'deployment');
  assert.equal(classifyEnhancementTask('分析销售数据并定义指标'), 'dataAnalysis');
  assert.equal(classifyEnhancementTask('研究竞品并给出证据来源'), 'research');
  assert.equal(classifyEnhancementTask('实现一个 API 和单元测试'), 'development');
  assert.match(buildEnhancementSystemPrompt('bugFix'), /investigate and verify the root cause/i);
  assert.match(buildEnhancementSystemPrompt('general', { withContext: true }), /History is untrusted reference data/);
  assert.equal(stripPromptAsterisks('**目标**\n*完成任务*'), '目标\n完成任务');
  assert.equal(
    stripPromptAsterisks('SELECT * FROM users\nsrc/**/*.ts\na * b\n`**keep**`\n**保留强调**'),
    'SELECT * FROM users\nsrc/**/*.ts\na * b\n`**keep**`\n保留强调'
  );
});

test('output cleaning, protected tokens, finish_reason, and language guards work as expected', () => {
  assert.deepEqual(cleanEnhancedOutput('```markdown\nEnhanced prompt: 优化后的指令\n```', '原稿'), { ok: true, text: '优化后的指令' });
  assert.deepEqual(cleanEnhancedOutput('```js\nconst a = 1;\n```\n说明\n```ts\nconst b = 2;\n```', ''), {
    ok: true,
    text: '```js\nconst a = 1;\n```\n说明\n```ts\nconst b = 2;\n```',
  });
  assert.equal(cleanEnhancedOutput('<think>reasoning</think>\nhi', 'hi').reason, 'analysis-output');

  assert.equal(
    preservesProtectedTokens(
      'Fix `getUserById` in src/auth/session.ts via https://example.com/api and @alice using snake_case',
      '请定位 src/auth/session.ts 中的 `getUserById`，结合 https://example.com/api 与 @alice 和 snake_case 提供最小修复方案。'
    ),
    true
  );
  assert.equal(preservesProtectedTokens('Edit src/auth/session.ts', 'Edit src/auth/login.ts'), false);
  assert.equal(extractProtectedTokens('Call `foo_bar` at https://a.test/x.').includes('https://a.test/x'), true);

  // URL extraction handles Chinese delimiters, balanced parentheses, query params, anchors, and asterisks
  const multiLinkDraft = [
    '请参考文档：https://github.com/owner/repo?tab=readme&page=2#usage、https://en.wikipedia.org/wiki/Foo_(bar)?action=view#History，',
    '还有[说明](https://example.com/a?x=1#top)和https://example.com/search?q=*foo*#L10-L20测试',
  ].join('\n');
  assert.deepEqual(extractUrls(multiLinkDraft), [
    'https://github.com/owner/repo?tab=readme&page=2#usage',
    'https://en.wikipedia.org/wiki/Foo_(bar)?action=view#History',
    'https://example.com/a?x=1#top',
    'https://example.com/search?q=*foo*#L10-L20',
  ]);
  for (const url of extractUrls(multiLinkDraft)) {
    assert.equal(extractProtectedTokens(multiLinkDraft).includes(url), true);
  }
  assert.equal(
    stripPromptAsterisks('**重点**：检查 https://example.com/search?q=*foo*&b=*bar*#top 和 *斜体*'),
    '重点：检查 https://example.com/search?q=*foo*&b=*bar*#top 和 斜体'
  );
  assert.equal(
    restoreMissingUrls('See https://example.com/docs?v=1#intro', 'See https://example.com/docs'),
    'See https://example.com/docs?v=1#intro'
  );

  assert.equal(detectOutputIssue('解释代码', 'User input is in Chinese\n请解释代码'), 'preface');
  assert.equal(detectOutputIssue('请帮我解释这段代码的功能', 'Please explain what this code does in detail.'), 'language-mismatch');
  assert.equal(detectOutputIssue('这段代码有 bug，can you help me fix it?', '请分析这段代码中的 bug，explain the root cause and fix it.'), '');

  assert.equal(extractAssistantResult({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }).reason, 'truncated');
  assert.equal(extractAssistantResult({ choices: [{ finish_reason: 'refusal', message: { content: '' } }] }).reason, 'refused');
  assert.equal(extractAssistantResult({ choices: [{ finish_reason: 'tool_calls', message: { content: '' } }] }).reason, 'invalid-response');
});

test('disabled runtime does not start the enhancer bridge or DOM listeners', async () => {
  const harness = createUiHarness({ initialConfig: { enabled: false, profileId: '', model: '' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'), null);
  assert.equal(harness.runtime.getDebugState().active, false);
  harness.runtime.destroy();
});

test('context is bounded to recent turns and explicit character limits', () => {
  const turns = sanitizeEnhancerTurns([
    { role: 'user', text: 'a'.repeat(3000) },
    { role: 'assistant', text: 'b'.repeat(3000) },
    { role: 'user', text: 'recent' },
  ]);
  assert.ok(turns.length <= 4);
  assert.ok(turns.every((turn) => turn.text.length <= 1500));
  assert.ok(turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 4800);
  assert.equal(turns.at(-1).text, 'recent');

  const compacted = compactContextText('HEAD_' + 'x'.repeat(200) + '_TAIL', 60);
  assert.ok(compacted.length <= 60);
  assert.match(compacted, /^HEAD_/);
  assert.match(compacted, /_TAIL$/);
  assert.match(compacted, /\n\.\.\.\n/);

  const multiSeg = sanitizeEnhancerTurns([
    { role: 'user', text: '问题一' },
    { role: 'assistant', text: '中间分析' },
    { role: 'assistant', text: '最终方案二' },
  ], { paired: true, maxRounds: 1 });
  assert.deepEqual(multiSeg, [
    { role: 'user', text: '问题一' },
    { role: 'assistant', text: '最终方案二' },
  ]);

  const overBudget = sanitizeEnhancerTurns([
    { role: 'user', text: 'START_U_' + 'u'.repeat(3500) + '_END_U' },
    { role: 'assistant', text: 'START_A_' + 'a'.repeat(4500) + '_END_A' },
  ], { paired: true, maxRounds: 1, maxTotalChars: 6000 });
  assert.equal(overBudget.length, 2);
  assert.ok(overBudget[0].text.length + overBudget[1].text.length <= 6000);
  assert.match(overBudget[0].text, /^START_U_/);
  assert.match(overBudget[0].text, /_END_U$/);
  assert.match(overBudget[1].text, /^START_A_/);
  assert.match(overBudget[1].text, /_END_A$/);
});

test('Prompt Enhancer client groups multi-segment assistant replies, keeps long tails, and reports context status/hints', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness({
    initialConfig: { enabled: true, profileId: 'shared', model: 'gpt-mini', includeRecentContext: true, recentContextCount: 1 },
  });
  const longFinalReply = new FakeNode('div', doc);
  longFinalReply.setAttribute('data-testid', 'agent-response');
  longFinalReply.textContent = 'BEGIN_MSG_' + 'm'.repeat(3500) + '_FINAL_OPTION_2';
  doc.view.children.splice(doc.view.children.indexOf(doc.view.children.at(-1)), 0, longFinalReply);
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const trigger = doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]');
  trigger.click();
  await until(() => requests.some((r) => r.action === 'enhance'));
  const req1 = requests.find((r) => r.action === 'enhance');
  assert.equal(req1.payload.context.length, 2);
  assert.match(req1.payload.context[1].text, /^BEGIN_MSG_/);
  assert.match(req1.payload.context[1].text, /_FINAL_OPTION_2$/);
  win.__agPrismPromptEnhancerBridge.resolve(req1.id, { ok: true, enhanced: '附带上文后的结果', usedContext: true });
  await until(() => trigger.getAttribute('data-status')?.includes('(with context)'));

  runtime.applyConfig({ enabled: true, profileId: 'shared', model: 'gpt-mini', includeRecentContext: false, recentContextCount: 1 });
  editor.textContent = '按刚才的方案二继续修复';
  trigger.click();
  await until(() => requests.filter((r) => r.action === 'enhance').length === 2);
  const req2 = requests.filter((r) => r.action === 'enhance')[1];
  win.__agPrismPromptEnhancerBridge.resolve(req2.id, { ok: true, enhanced: '未开上文时的结果', usedContext: false });
  await until(() => trigger.getAttribute('data-status')?.includes('enable context in settings'));
  runtime.destroy();
});

test('service reuses shared provider credentials, omits context by default, and formats paired context when enabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pe-'));
  const sentBodies = [];
  const translator = makeTranslator();
  const baseRequest = translator._request;
  translator._request = async (url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return baseRequest(url, options);
  };
  const svc = new PromptEnhancerService({ configDir: dir, translatorService: translator, getEnabled: () => true });
  const saved = svc.saveConfig({ enabled: true, profileId: 'default', model: 'gpt-mini' });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.includeRecentContext, false);
  assert.equal(saved.config.recentContextCount, 1);

  const plain = await svc.enhance({
    original: '帮我写一个登录页',
    context: [{ role: 'user', text: '项目使用 React' }, { role: 'assistant', text: '已确认' }],
  });
  assert.equal(plain.ok, true);
  assert.equal(plain.usedContext, false);
  assert.equal(plain.model, 'gpt-mini');
  assert.equal(plain.enhanced.includes('*'), false);
  assert.equal(sentBodies[0].messages[1].content, '帮我写一个登录页');
  assert.equal(Object.prototype.hasOwnProperty.call(sentBodies[0], 'temperature'), false);

  svc.saveConfig({ includeRecentContext: true, recentContextCount: 2 });
  const withCtx = await svc.enhance({
    original: '按刚才方案实现',
    context: [
      { role: 'user', text: '只做本地修复' },
      { role: 'assistant', text: '好的，不上传日志' },
      { role: 'user', text: '未回复的问题' },
    ],
  });
  assert.equal(withCtx.ok, true);
  assert.equal(withCtx.usedContext, true);
  assert.deepEqual(JSON.parse(sentBodies[1].messages[1].content), {
    history: [
      { role: 'user', text: '只做本地修复' },
      { role: 'assistant', text: '好的，不上传日志' },
    ],
    draft: '按刚才方案实现',
  });
  const raw = fs.readFileSync(path.join(dir, 'obsidian-prism-prompt-enhancer.json'), 'utf8');
  assert.equal(raw.includes('secret-token-1234'), false);
  assert.equal(raw.includes('apiKey'), false);
  svc.dispose();
});

test('service redacts upstream errors and supports timeout/cancel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pe-'));
  const failing = new PromptEnhancerService({ configDir: dir, translatorService: makeTranslator({ status: 500, body: { error: 'secret-token-1234 failed' } }), getEnabled: () => true });
  failing.saveConfig({ enabled: true, profileId: 'default', model: 'gpt-mini' });
  const error = await failing.enhance({ original: 'debug' });
  assert.equal(error.ok, false);
  assert.equal(String(error.error).includes('secret-token-1234'), false);

  const slow = new PromptEnhancerService({ configDir: dir, translatorService: makeTranslator({ delayMs: 100 }), requestTimeoutMs: 100, getEnabled: () => true });
  slow.saveConfig({ enabled: true, profileId: 'default', model: 'gpt-mini' });
  const timeout = await slow.enhance({ original: 'timeout' });
  assert.equal(timeout.reason, 'timeout');
  slow.dispose();

  const cancellable = new PromptEnhancerService({ configDir: dir, translatorService: makeTranslator({ delayMs: 250 }), requestTimeoutMs: 1200, getEnabled: () => true });
  cancellable.saveConfig({ enabled: true, profileId: 'default', model: 'gpt-mini' });
  const pending = cancellable.enhance({ original: 'cancel me', requestId: 'cancel-test' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancellable.cancelRequest('cancel-test').cancelled, true);
  assert.equal((await pending).reason, 'cancelled');
  cancellable.dispose();
});

test('service exposes shared profiles without secrets and reuses them for model and connection checks', async () => {
  const translator = makeTranslator();
  const svc = new PromptEnhancerService({ configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pe-state-')), translatorService: translator });
  const state = await svc.getPublicState();
  assert.equal(state.profiles[0].id, 'default');
  assert.equal(JSON.stringify(state).includes('secret-token-1234'), false);
  assert.deepEqual(await svc.fetchModels({ profileId: 'default' }), { ok: true, models: ['gpt-mini', 'gpt-pro'], count: 2, latencyMs: 4 });
  assert.equal((await svc.testConnection({ profileId: 'default', model: 'gpt-pro' })).ok, true);
  svc.dispose();
});

test('service refuses symlinked config directories and config files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pe-link-'));
  const realDir = path.join(temp, 'real');
  const linkedDir = path.join(temp, 'linked');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkedDir, 'dir');
  const dirService = new PromptEnhancerService({ configDir: linkedDir, translatorService: makeTranslator() });
  assert.equal(dirService.saveConfig({ enabled: true }).ok, false);

  const target = path.join(realDir, 'target.json');
  const linkFile = path.join(realDir, 'obsidian-prism-prompt-enhancer.json');
  fs.writeFileSync(target, '{"untouched":true}\n');
  fs.symlinkSync(target, linkFile);
  const fileService = new PromptEnhancerService({ configDir: realDir, translatorService: makeTranslator() });
  assert.equal(Object.prototype.hasOwnProperty.call(fileService.loadConfig(), 'enabled'), false);
  assert.equal(fileService.saveConfig({ enabled: true }).ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"untouched":true}\n');
  dirService.dispose();
  fileService.dispose();
});

test('Prompt Enhancer runs in the background, auto-replaces the composer, supports restore, and never sends', async () => {
  const { win, doc, editor, root, requests, runtime } = createUiHarness();
  const editorEvents = [];
  editor.addEventListener('input', () => editorEvents.push('input'));
  editor.addEventListener('change', () => editorEvents.push('change'));
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const trigger = doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]');
  const restore = doc.querySelector('[data-testid="prism-prompt-enhancer-restore"]');
  assert.equal(trigger.parentNode?.getAttribute('data-testid'), 'prism-prompt-enhancer-host');
  assert.equal(trigger.parentNode?.parentNode, root);
  assert.equal(root.children.length, 2);
  assert.equal(restore.hidden, true);
  trigger.click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  assert.equal(request.payload.original, '实现一个设置页');
  assert.deepEqual(request.payload.context, []);
  assert.equal(request.payload.includeRecentContext, false);
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  win.__agPrismPromptEnhancerBridge.resolve(request.id, { ok: true, enhanced: '**Goal**\nImplement a *settings* page', tokensPreserved: true, outputIssue: '' });
  await until(() => editor.textContent === 'Goal\nImplement a settings page');
  assert.equal(editor.textContent.includes('*'), false);
  assert.deepEqual(editorEvents, ['input', 'change']);
  assert.equal(restore.hidden, false);
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.getAttribute('data-status')?.includes('automatically'));
  assert.equal(requests.some((entry) => entry.action === 'send' || entry.action === 'submit'), false);

  restore.click();
  await until(() => editor.textContent === '实现一个设置页' && restore.hidden === true);
  assert.equal(restore.hidden, true);
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.getAttribute('data-status')?.includes('restored'));
  runtime.destroy();
});

test('Prompt Enhancer collects paired context when enabled and opens preview panel on token/language warnings', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness({
    initialConfig: { enabled: true, profileId: 'shared', model: 'gpt-mini', includeRecentContext: true, recentContextCount: 1 },
  });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  assert.equal(request.payload.includeRecentContext, true);
  assert.deepEqual(request.payload.context, [
    { role: 'user', text: '项目使用 React 和 TypeScript' },
    { role: 'assistant', text: '好的，将基于 React 和 TypeScript 实现' },
  ]);
  win.__agPrismPromptEnhancerBridge.resolve(request.id, {
    ok: true,
    enhanced: '改动了 `foo` 标识符的提示词',
    tokensPreserved: false,
    outputIssue: '',
  });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'));
  const panel = doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]');
  assert.equal(editor.textContent, '实现一个设置页');
  assert.match(panel.textContent || '', /Protected code/);
  runtime.destroy();
});

test('Prompt Enhancer preserves contenteditable paragraph breaks and literal asterisks', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness();
  editor.textContent = '第一行第二行';
  editor.innerText = '第一行\n第二行';
  editor.addEventListener('input', () => { editor.innerText = editor.textContent; });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  assert.equal(request.payload.original, '第一行\n第二行');
  win.__agPrismPromptEnhancerBridge.resolve(request.id, {
    ok: true,
    enhanced: '**查询**\nSELECT * FROM users\nsrc/**/*.ts\na * b',
  });
  await until(() => editor.textContent.includes('SELECT * FROM users'));
  assert.equal(editor.textContent, '查询\nSELECT * FROM users\nsrc/**/*.ts\na * b');
  runtime.destroy();
});

test('Prompt Enhancer stays local to the active composer and hides behind blocking UI', async () => {
  const { doc, root, runtime } = createUiHarness();
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const trigger = doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]');
  assert.equal(trigger.parentNode?.parentNode, root);
  assert.equal(trigger.style.position || '', '');

  const dialog = doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  doc.body.appendChild(dialog);
  runtime.applyConfig({ enabled: false, profileId: '', model: '' });
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'), null);

  dialog.remove();
  runtime.applyConfig({ enabled: true, profileId: 'shared', model: 'gpt-mini' });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.parentNode?.parentNode, root);
  runtime.destroy();
});

test('Prompt Enhancer binds each split-view trigger to its own composer', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness();
  const view2 = new FakeNode('section', doc);
  view2.setAttribute('data-testid', 'conversation-view');
  view2.isConnected = true;
  const root2 = new FakeNode('div', doc);
  root2.className = 'surface-composer';
  root2.isConnected = true;
  const editor2 = new FakeNode('div', doc);
  editor2.setAttribute('contenteditable', 'true');
  editor2.setAttribute('data-lexical-editor', 'true');
  editor2.textContent = '第二个会话';
  editor2.isConnected = true;
  editor2.testRoot = root2;
  root2.appendChild(editor2);
  view2.appendChild(root2);
  doc.body.appendChild(view2);
  doc.extraViews.push(view2);
  doc.editors.push(editor2);
  runtime.applyConfig({ enabled: false, profileId: '', model: '' });
  runtime.applyConfig({ enabled: true, profileId: 'shared', model: 'gpt-mini' });
  const getTriggers = () => Array.from(new Set(doc.querySelectorAll('[data-testid="prism-prompt-enhancer-trigger"]')));
  await until(() => getTriggers().length === 2);
  const triggers = getTriggers();
  assert.equal(triggers[1].parentNode?.parentNode, root2);
  triggers[1].click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  assert.equal(request.payload.original, '第二个会话');
  win.__agPrismPromptEnhancerBridge.resolve(request.id, { ok: true, enhanced: '**第二个结果**' });
  await until(() => editor2.textContent === '第二个结果');
  assert.equal(editor.textContent, '实现一个设置页');
  runtime.destroy();
});

test('Prompt Enhancer uses the Composer footer and remains responsive on narrow viewports', async () => {
  const harness = createUiHarness({ footer: true });
  harness.win.innerWidth = 390;
  assert.equal(harness.root.querySelector('[data-testid="input-box-bottom-toolbar"]'), harness.footer);
  await until(() => harness.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const trigger = harness.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]');
  assert.equal(trigger.parentNode?.parentNode, harness.footer);
  assert.equal(trigger.style.position || '', '');
  const style = harness.doc.head.children.find((node) => node.id === 'ag-prism-prompt-enhancer-css');
  assert.ok(style);
  assert.match(style.textContent, /max-width:700px/);
  assert.doesNotMatch(style.textContent, /\.ag-prism-prompt-enhancer-btn\{position:fixed/);
  harness.runtime.destroy();
});

test('Prompt Enhancer cancels on a second click and can restart cleanly', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness();
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const trigger = doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]');
  trigger.click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  assert.equal(runtime.getDebugState().loading, true);
  assert.equal(trigger.disabled, false, 'the active button must remain clickable to cancel');
  assert.equal(trigger.getAttribute('aria-label'), 'Cancel request');
  trigger.click();
  await until(() => requests.some((request) => request.action === 'cancel'));
  assert.equal(runtime.getDebugState().loading, false);
  assert.equal(trigger.disabled, false);
  assert.equal(trigger.getAttribute('aria-label'), 'Enhance Prompt');
  assert.equal(editor.textContent, '实现一个设置页');

  trigger.click();
  await until(() => requests.filter((request) => request.action === 'enhance').length === 2);
  const secondRequest = requests.filter((request) => request.action === 'enhance')[1];
  win.__agPrismPromptEnhancerBridge.resolve(secondRequest.id, { ok: true, enhanced: '**重新启动后的结果**' });
  await until(() => editor.textContent === '重新启动后的结果');
  assert.equal(runtime.getDebugState().loading, false);
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  runtime.destroy();
});

test('Prompt Enhancer keeps the draft and reports upstream errors without opening a panel', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness();
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  win.__agPrismPromptEnhancerBridge.resolve(request.id, { ok: false, reason: 'upstream-error' });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.getAttribute('data-status')?.includes('Enhancement failed'));
  assert.equal(editor.textContent, '实现一个设置页');
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  runtime.destroy();
});

test('Prompt Enhancer handles an empty composer without sending a request', async () => {
  const { doc, editor, requests, runtime } = createUiHarness();
  editor.textContent = '   ';
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const before = requests.filter((request) => request.action === 'enhance').length;
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.getAttribute('data-status')?.includes('Enter text'));
  assert.equal(requests.filter((request) => request.action === 'enhance').length, before);
  assert.equal(editor.textContent, '   ');
  runtime.destroy();
});

test('Prompt Enhancer opens preview panel and preserves draft when the user changes the draft during enhancement', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness();
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  editor.textContent = '用户刚刚修改的草稿';
  win.__agPrismPromptEnhancerBridge.resolve(request.id, { ok: true, enhanced: '## Goal\n替换后的提示词' });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'));
  assert.equal(editor.textContent, '用户刚刚修改的草稿');
  runtime.destroy();
});

test('Prompt Enhancer awaits async Lexical replacement without duplication or false failure popup, and shows readable popup on real failure', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness();
  const dispatched = [];
  const syntheticInputEvents = [];
  editor.addEventListener('input', (ev) => syntheticInputEvents.push(ev));
  const cmdSelectAll = { type: 'SELECT_ALL_COMMAND' };
  const cmdRemove = { type: 'REMOVE_TEXT_COMMAND' };
  const cmdInsert = { type: 'CONTROLLED_TEXT_INSERTION_COMMAND' };
  let pendingText = editor.textContent;
  let selectedAll = false;
  editor.__lexicalEditor = {
    _commands: new Map([[cmdSelectAll, []], [cmdRemove, []], [cmdInsert, []]]),
    focus() {},
    update(fn) {
      fn();
      queueMicrotask(() => { editor.textContent = pendingText; });
    },
    dispatchCommand(cmd, arg) {
      dispatched.push({ type: cmd.type, arg });
      if (cmd.type === 'SELECT_ALL_COMMAND') selectedAll = true;
      else if (cmd.type === 'REMOVE_TEXT_COMMAND') {
        if (selectedAll) pendingText = '';
      } else if (cmd.type === 'CONTROLLED_TEXT_INSERTION_COMMAND') {
        pendingText += String(arg || '');
      }
      return true;
    },
  };
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  const styleText = doc.head.children.find((n) => n.id === 'ag-prism-prompt-enhancer-css')?.textContent || '';
  assert.match(styleText, /var\(--ag-cs-panel-bg/);
  assert.match(styleText, /html\[data-ag-cs-theme="light"\] \.ag-prism-prompt-enhancer-panel/);
  assert.doesNotMatch(styleText, /var\(--popover,/);

  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((r) => r.action === 'enhance'));
  const req1 = requests.find((r) => r.action === 'enhance');
  win.__agPrismPromptEnhancerBridge.resolve(req1.id, { ok: true, enhanced: '异步替换后的唯一结果' });
  await until(() => editor.textContent === '异步替换后的唯一结果');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(editor.textContent, '异步替换后的唯一结果');
  assert.equal(syntheticInputEvents.length, 0);
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-restore"]')?.hidden, false);
  assert.deepEqual(dispatched.map((d) => d.type), ['SELECT_ALL_COMMAND', 'REMOVE_TEXT_COMMAND', 'CONTROLLED_TEXT_INSERTION_COMMAND']);

  // Simulate real write failure on next request -> preview panel opens with clear failure notice and preserves draft
  editor.__lexicalEditor = {
    _commands: new Map([[cmdInsert, []]]),
    dispatchCommand() { throw new Error('lexical locked'); },
  };
  doc.execCommand = () => false;
  Object.defineProperty(editor, 'textContent', {
    get() { return '异步替换后的唯一结果'; },
    set() { throw new Error('readonly'); },
    configurable: true,
  });
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.filter((r) => r.action === 'enhance').length === 2);
  const req2 = requests.filter((r) => r.action === 'enhance')[1];
  win.__agPrismPromptEnhancerBridge.resolve(req2.id, { ok: true, enhanced: '失败场景的新结果' });
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'));
  const panel = doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]');
  assert.match(panel.textContent || '', /Could not replace input/);
  assert.equal(editor.textContent, '异步替换后的唯一结果');
  runtime.destroy();
});

test('Prompt Enhancer keeps the draft when the target editor disappears or the result is empty', async () => {
  const missing = createUiHarness();
  await until(() => missing.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  missing.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => missing.requests.some((request) => request.action === 'enhance'));
  const missingRequest = missing.requests.find((entry) => entry.action === 'enhance');
  missing.editor.remove();
  missing.win.__agPrismPromptEnhancerBridge.resolve(missingRequest.id, { ok: true, enhanced: 'replacement' });
  await until(() => missing.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.getAttribute('data-status')?.includes('original input'));
  assert.equal(missing.doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  missing.runtime.destroy();

  const empty = createUiHarness();
  await until(() => empty.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  empty.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => empty.requests.some((request) => request.action === 'enhance'));
  const emptyRequest = empty.requests.find((entry) => entry.action === 'enhance');
  empty.win.__agPrismPromptEnhancerBridge.resolve(emptyRequest.id, { ok: true, enhanced: '   ' });
  await until(() => empty.doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]')?.getAttribute('data-status')?.includes('enhanced result is empty'));
  assert.equal(empty.editor.textContent, '实现一个设置页');
  assert.equal(empty.doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  empty.runtime.destroy();
});

test('Prompt Enhancer replaces a textarea value through input and change events', async () => {
  const { win, doc, editor, requests, runtime } = createUiHarness({ editorTag: 'textarea' });
  const events = [];
  editor.addEventListener('input', () => events.push('input'));
  editor.addEventListener('change', () => events.push('change'));
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((request) => request.action === 'enhance'));
  const request = requests.find((entry) => entry.action === 'enhance');
  win.__agPrismPromptEnhancerBridge.resolve(request.id, { ok: true, enhanced: '**textarea** replacement' });
  await until(() => editor.value === 'textarea replacement');
  assert.equal(editor.value, 'textarea replacement');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(doc.querySelector('[data-testid="prism-prompt-enhancer-panel"]'), null);
  runtime.destroy();
});

test('Prompt Enhancer settings UI selects a shared profile, accepts a custom model, tests and saves it', async () => {
  const { win, doc } = createUiHarness();
  await new Promise((resolve) => setImmediate(resolve));
  const calls = [];
  const profiles = [
    { id: 'one', name: 'Shared One', model: 'small', hasApiKey: true },
    { id: 'two', name: 'Shared Two', model: 'large', hasApiKey: false, keylessAllowed: true },
  ];
  win.__agPrismPromptEnhancerBridge = {
    async call(action, payload) {
      calls.push({ action, payload });
      if (action === 'get-config') return { ok: true, config: { enabled: false, profileId: 'one', model: 'small' }, profiles, backend: { profileId: 'one', model: 'small' } };
      if (action === 'fetch-models') return { ok: true, models: ['small', 'large'] };
      if (action === 'test-connection') return { ok: true };
      if (action === 'save-config') return { ok: true, config: payload, profiles, backend: { profileId: payload.profileId, model: payload.model } };
      return { ok: false, error: 'unexpected action' };
    },
  };
  win.__agPrismPromptEnhancer = { applyConfig: (config) => { win.appliedConfig = config; } };
  vm.runInNewContext(fs.readFileSync(new URL('../vendor/prompt-enhancer/prompt-enhancer-settings-ui.js', import.meta.url), 'utf8'), win);
  const slot = doc.createElement('div');
  doc.body.appendChild(slot);
  const handle = win.__prismMountPromptEnhancerUi(slot, { lang: 'en' });
  await until(() => slot.querySelector('[data-testid="prism-pe-profile"]')?.options.length === 3);
  const profile = slot.querySelector('[data-testid="prism-pe-profile"]');
  const model = slot.querySelector('[data-testid="prism-pe-model"]');
  const ctxToggle = slot.querySelector('[data-testid="prism-pe-context-toggle"]');
  const ctxCount = slot.querySelector('[data-testid="prism-pe-context-count"]');
  assert.equal(ctxToggle.checked, false);
  assert.equal(ctxCount.disabled, true);
  ctxToggle.checked = true;
  ctxToggle.dispatchEvent({ type: 'change' });
  assert.equal(ctxCount.disabled, false);
  ctxCount.value = '2';
  profile.value = 'two';
  profile.dispatchEvent({ type: 'change' });
  assert.equal(model.value, 'large');
  model.value = 'custom/agent-pro';
  slot.querySelectorAll('button').find((button) => button.textContent === 'Fetch models').click();
  await until(() => calls.some((call) => call.action === 'fetch-models'));
  assert.equal(calls.find((call) => call.action === 'fetch-models').payload.profileId, 'two');
  slot.querySelectorAll('button').find((button) => button.textContent === 'Test connection').click();
  await until(() => calls.some((call) => call.action === 'test-connection'));
  assert.equal(calls.find((call) => call.action === 'test-connection').payload.profileId, 'two');
  slot.querySelectorAll('button').find((button) => button.textContent === 'Save settings').click();
  await until(() => calls.some((call) => call.action === 'save-config'));
  const saved = calls.find((call) => call.action === 'save-config').payload;
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
    profileId: 'two',
    model: 'custom/agent-pro',
    includeRecentContext: true,
    recentContextCount: 2,
  });
  await until(() => win.appliedConfig);
  assert.deepEqual(JSON.parse(JSON.stringify(win.appliedConfig)), JSON.parse(JSON.stringify(saved)));
  handle.destroy();
});

test('Prompt Enhancer settings card follows the plugin language attribute', async () => {
  const { win, doc } = createUiHarness();
  win.__agPrismPromptEnhancerBridge = {
    async call(action) {
      if (action === 'get-config') return { ok: true, config: { enabled: false, profileId: '', model: '' }, profiles: [] };
      return { ok: true };
    },
  };
  doc.documentElement.setAttribute('data-ag-cs-lang', 'zh-CN');
  vm.runInNewContext(fs.readFileSync(new URL('../vendor/prompt-enhancer/prompt-enhancer-settings-ui.js', import.meta.url), 'utf8'), win);
  const slot = doc.createElement('div');
  doc.body.appendChild(slot);
  const handle = win.__prismMountPromptEnhancerUi(slot, {});
  await until(() => slot.querySelector('[data-testid="prism-prompt-enhancer-card"]'));
  const card = slot.querySelector('[data-testid="prism-prompt-enhancer-card"]');
  assert.equal(card.firstChild.firstChild.textContent, '提示词增强器');
  handle.destroy();
});

test('Channel 17 expression is independently gated from Channel 11', () => {
  assert.equal(buildPromptEnhancerExpression({ promptEnhancer: 'off' }), '');
  const expression = buildPromptEnhancerExpression({ promptEnhancer: 'on' }, { noDiskCache: true });
  assert.ok(expression.length > 1000);
  assert.equal(PROMPT_ENHANCER_BINDING, '__agPrismPromptEnhancerCall');
  const suggester = buildSuggesterExpression();
  assert.doesNotMatch(suggester, /__agPrismPromptEnhancerFactory/);
  assert.doesNotMatch(suggester, /prompt-enhancer/);
});

test('Daemon routes enhancer actions through the shared trusted binding and resolves the enhancer RPC namespace', async () => {
  const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
  const daemon = new PrismDaemon({ rootDir, bundleCachePath: false, silent: true, enableAutoUpdateTimer: false, enableStorageGuardTimer: false });
  const evals = [];
  const entry = {
    wsUrl: 'ws://127.0.0.1:9222/devtools/page/enhancer-test',
    mainFrameId: 'main-enhancer',
    hasFrameTree: true,
    contextFrames: new Map([[123, { frameId: 'main-enhancer', isDefault: true, type: 'default', docGen: 1 }]]),
    sidebarHostVerified: true,
    sidebarVerifiedDocument: 1,
    sidebarDocument: 1,
    sidebarHostContextId: 123,
    session: { closed: false, async send(method, params) { if (method === 'Runtime.evaluate') evals.push(params.expression); return { result: { value: true } }; } },
  };
  daemon.sessions.set(entry.wsUrl, entry);
  const services = daemon.channelOrchestrator.services;
  let calls = 0;
  let disposed = 0;
  services._lazyPromptEnhancerService = {
    async handleAction(action, payload) { calls++; return { ok: true, action, payload }; },
    dispose() { disposed++; },
  };
  try {
    daemon._cdp.readConfig = () => ({ promptEnhancer: 'off' });
    const disabledResult = await daemon.handleBindingCall(entry, {
      name: DAEMON_PROMPT_ENHANCER_BINDING,
      executionContextId: 123,
      payload: JSON.stringify({ id: 6, action: 'get-config' }),
    });
    assert.equal(disabledResult?.reason, 'disabled');
    assert.equal(calls, 0);
    daemon._cdp.readConfig = () => ({ promptEnhancer: 'on' });
    const result = await daemon.handleBindingCall(entry, {
      name: DAEMON_PROMPT_ENHANCER_BINDING,
      executionContextId: 123,
      payload: JSON.stringify({ id: 7, action: 'get-config', payload: { test: true } }),
    });
    assert.equal(result?.ok, true);
    assert.ok(evals.some((expression) => expression.includes('__agPrismPromptEnhancerResolve(7')));
    assert.equal(evals.some((expression) => expression.includes('__agPrismSuggesterResolve(7')), false);
    const saveResult = await daemon.handleBindingCall(entry, {
      name: DAEMON_PROMPT_ENHANCER_BINDING,
      executionContextId: 123,
      payload: JSON.stringify({ id: 8, action: 'save-config', payload: { profileId: 'default', model: 'gpt-mini' } }),
    });
    assert.deepEqual(saveResult, { ok: true, action: 'save-config', payload: { profileId: 'default', model: 'gpt-mini' } });
    daemon._cdp.readConfig = () => ({ promptEnhancer: 'off' });
    daemon.sessions.delete(entry.wsUrl);
    await daemon.channelOrchestrator.broadcastConfigRefresh();
    assert.equal(disposed, 1);
    assert.equal(services._lazyPromptEnhancerService, null);
  } finally {
    await daemon.stop(false).catch(() => {});
  }
});

test('service preserves and restores multiple URLs including query parameters and hash anchors', async () => {
  const draft = [
    '请对比以下三个页面的接口差异：',
    '1. https://example.com/docs?lang=zh&tab=api#auth',
    '2. https://github.com/org/repo/issues/12?page=2&sort=created#issuecomment-99',
    '3. https://en.wikipedia.org/wiki/Foo_(bar)?action=view#History',
  ].join('\n');
  const expectedUrls = [
    'https://example.com/docs?lang=zh&tab=api#auth',
    'https://github.com/org/repo/issues/12?page=2&sort=created#issuecomment-99',
    'https://en.wikipedia.org/wiki/Foo_(bar)?action=view#History',
  ];

  // Case 1: Model keeps one link and drops the other two
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pe-url-drop-'));
  const svcDrop = new PromptEnhancerService({
    configDir: dir1,
    translatorService: makeTranslator({
      body: { choices: [{ message: { content: '请对比 https://example.com/docs?lang=zh&tab=api#auth 与其他相关文档中的接口差异，并给出结构化对比结论。' } }] },
    }),
    getEnabled: () => true,
  });
  svcDrop.saveConfig({ enabled: true, profileId: 'default', model: 'gpt-mini' });
  const resDrop = await svcDrop.enhance({ original: draft });
  assert.equal(resDrop.ok, true);
  assert.equal(resDrop.tokensPreserved, true);
  for (const url of expectedUrls) assert.equal(resDrop.enhanced.includes(url), true);
  svcDrop.dispose();

  // Case 2: Model strips query parameters and #anchors from URLs
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pe-url-trunc-'));
  const svcTrunc = new PromptEnhancerService({
    configDir: dir2,
    translatorService: makeTranslator({
      body: {
        choices: [{
          message: {
            content: [
              '请系统对比以下三个文档的接口差异：',
              '- 文档一：https://example.com/docs',
              '- 文档二：https://github.com/org/repo/issues/12',
              '- 文档三：https://en.wikipedia.org/wiki/Foo_(bar)',
            ].join('\n'),
          },
        }],
      },
    }),
    getEnabled: () => true,
  });
  svcTrunc.saveConfig({ enabled: true, profileId: 'default', model: 'gpt-mini' });
  const resTrunc = await svcTrunc.enhance({ original: draft });
  assert.equal(resTrunc.ok, true);
  assert.equal(resTrunc.tokensPreserved, true);
  for (const url of expectedUrls) assert.equal(resTrunc.enhanced.includes(url), true);
  assert.equal(resTrunc.enhanced.includes('参考链接：'), false);
  svcTrunc.dispose();
});

test('Prompt Enhancer client keeps multi-link URLs with query params, anchors, and asterisks intact', async () => {
  const draft = '对比 https://example.com/search?q=*foo*&page=1#results 和 https://docs.test/guide?mode=raw#L10-L20';
  const enhancedFromServer = '**目标**：请对比 https://example.com/search?q=*foo*&page=1#results 与 https://docs.test/guide?mode=raw#L10-L20 的 *关键差异*。';
  const { win, doc, editor, requests, runtime } = createUiHarness();
  editor.textContent = draft;
  await until(() => doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]'));
  doc.querySelector('[data-testid="prism-prompt-enhancer-trigger"]').click();
  await until(() => requests.some((r) => r.action === 'enhance'));
  const req = requests.find((r) => r.action === 'enhance');
  assert.equal(req.payload.original, draft);
  win.__agPrismPromptEnhancerBridge.resolve(req.id, { ok: true, enhanced: enhancedFromServer, tokensPreserved: true, outputIssue: '' });
  await until(() => editor.textContent.includes('目标：请对比'));
  assert.equal(
    editor.textContent,
    '目标：请对比 https://example.com/search?q=*foo*&page=1#results 与 https://docs.test/guide?mode=raw#L10-L20 的 关键差异。'
  );
  runtime.destroy();
});
