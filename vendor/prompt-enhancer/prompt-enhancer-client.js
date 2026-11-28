// Modified by Yaniuan on 2026-11-28: add the downstream Prompt Enhancer module.
// Obsidian Prism - Channel 17 Prompt Enhancer client runtime.
// The module is inert until the user enables it in Beta settings.
(function (root) {
  'use strict';
  const G = root || (typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : null);
  if (!G) return;

  const BINDING_NAME = '__agPrismPromptEnhancerCall';
  const STYLE_ID = 'ag-prism-prompt-enhancer-css';
  const BUTTON_TESTID = 'prism-prompt-enhancer-trigger';
  const RESTORE_TESTID = 'prism-prompt-enhancer-restore';
  const BUTTON_HOST_TESTID = 'prism-prompt-enhancer-host';
  const PANEL_TESTID = 'prism-prompt-enhancer-panel';
  const DEFAULT_TIMEOUT = 65000;
  const MAX_REQUEST_CHARS = 10000;

  const CSS = [
    '.ag-prism-prompt-enhancer-host{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0;max-width:100%;flex:0 0 auto;pointer-events:auto;}',
    '.ag-prism-prompt-enhancer-host[data-fallback="1"]{position:absolute;right:8px;bottom:8px;z-index:3;}',
    '.ag-prism-prompt-enhancer-btn{position:static;z-index:auto;display:inline-flex;align-items:center;gap:6px;min-height:30px;max-width:100%;margin:0;padding:0 10px;border:1px solid var(--ag-cs-border-1,rgba(128,128,145,.3));border-radius:7px;background:var(--secondary,rgba(128,128,145,.1));color:var(--foreground,inherit);font:inherit;font-size:12px;cursor:pointer;transition:background-color .14s ease,border-color .14s ease,opacity .14s ease;white-space:nowrap;}',
    '.ag-prism-prompt-enhancer-btn:hover{background:var(--ag-cs-pill-bg,rgba(128,128,145,.2));border-color:var(--ag-cs-border-2,rgba(128,128,145,.5));}',
    '.ag-prism-prompt-enhancer-btn:disabled{opacity:.56;cursor:wait;}',
    '.ag-prism-prompt-enhancer-icon{width:15px;height:15px;flex:none;}',
    '.ag-prism-prompt-enhancer-panel{position:fixed;z-index:2147483000;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;gap:10px;width:min(680px,calc(100vw - 28px));max-height:min(680px,calc(100vh - 28px));padding:14px;border:1px solid var(--ag-cs-border-2,var(--ag-cs-border-1,rgba(128,128,145,.38)));border-radius:10px;background:var(--ag-cs-panel-bg,var(--background,#18181c));color:var(--foreground,#f5f5f5);box-shadow:var(--_gs,0 16px 42px rgba(0,0,0,.32));}',
    'html[data-ag-cs-theme="light"] .ag-prism-prompt-enhancer-panel,body.light .ag-prism-prompt-enhancer-panel{background:var(--ag-cs-panel-bg,#fff);color:var(--foreground,#0f172a);}',
    '.ag-prism-prompt-enhancer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600;color:var(--foreground,inherit);}',
    '.ag-prism-prompt-enhancer-tabs,.ag-prism-prompt-enhancer-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
    '.ag-prism-prompt-enhancer-tab,.ag-prism-prompt-enhancer-action{border:1px solid var(--ag-cs-border-1,rgba(128,128,145,.28));border-radius:6px;padding:5px 9px;background:var(--ag-cs-pill-bg,transparent);color:var(--foreground,inherit);font:inherit;font-size:12px;cursor:pointer;}',
    '.ag-prism-prompt-enhancer-tab[data-active="1"],.ag-prism-prompt-enhancer-action[data-primary="1"]{background:var(--primary,#2563eb);color:var(--primary-foreground,#fff);border-color:transparent;}',
    '.ag-prism-prompt-enhancer-close{border:0;background:transparent;color:var(--foreground,inherit);opacity:.8;font-size:18px;line-height:1;cursor:pointer;}',
    '.ag-prism-prompt-enhancer-body,.ag-prism-prompt-enhancer-editor{padding:11px;border:1px solid var(--ag-cs-border-1,rgba(128,128,145,.28));border-radius:6px;background:var(--ag-cs-pill-bg,var(--secondary,rgba(128,128,145,.12)));color:var(--foreground,inherit);font:inherit;font-size:13px;line-height:1.55;}',
    '.ag-prism-prompt-enhancer-body{min-height:150px;max-height:410px;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
    '.ag-prism-prompt-enhancer-editor{width:100%;min-height:180px;resize:vertical;box-sizing:border-box;}',
    '.ag-prism-prompt-enhancer-status{min-height:18px;color:var(--foreground,inherit);opacity:.88;font-size:12px;font-weight:500;}',
    '@media(max-width:700px){.ag-prism-prompt-enhancer-btn{min-height:28px;padding:0 8px;font-size:11px;}.ag-prism-prompt-enhancer-host[data-fallback="1"]{right:6px;bottom:6px;}}',
  ].join('\n');

  const FALLBACK_TEXT = {
    en: { button: 'Enhance Prompt', title: 'Prompt Enhancer', close: 'Close', original: 'Original', result: 'Enhanced', copy: 'Copy', edit: 'Edit result', retry: 'Enhance again', replace: 'Replace input', cancel: 'Cancel request', restore: 'Restore', restored: 'Original draft restored', working: 'Enhancing prompt…', done: 'Review before replacing', copied: 'Copied', copyFailed: 'Copy failed', editHint: 'Edit the enhanced prompt', replaced: 'Prompt replaced automatically', contextAttached: ' (with context)', contextUnavailable: ' (no context)', contextHint: ' (tip: enable context in settings)', replaceFailed: 'Could not replace input; copy manually', replaceUnverified: 'Replacement attempted but unverified; check input before pasting.', replaceConflict: 'Input changed; draft preserved. Review or copy manually.', emptyResult: 'The enhanced result is empty. Nothing replaced.', emptyInput: 'Enter text to enhance.', targetMissing: 'The original input is unavailable. Nothing replaced.', cancelled: 'Request cancelled. Original kept.', failed: 'Enhancement failed. Original kept. Retry: ', tooLong: 'Exceeds 10,000 char limit', tokensChanged: 'Protected code, paths, URLs, or identifiers changed. Original kept.', languagePrefaceIssue: 'Model returned meta note. Original kept.', languageMismatchIssue: 'Output language differs from draft. Original kept.', truncated: 'Truncated by token limit; shorten input.', refused: 'Model refused request.', analysisOutput: 'Model returned analysis tags; switch models.' },
  };

  function strings(doc) {
    const i18n = G.__agPrismPromptEnhancerI18n;
    const lang = String(doc?.documentElement?.getAttribute?.('data-ag-cs-lang') || doc?.documentElement?.lang || 'en');
    if (typeof i18n?.getClientText === 'function') return i18n.getClientText(lang);
    return FALLBACK_TEXT.en;
  }

  function createBridge(win) {
    let seq = 0, disposed = false;
    const pending = new Map();
    const settle = (id, val) => {
      const e = pending.get(Number(id));
      if (!e) return false;
      pending.delete(Number(id));
      clearTimeout(e.timer);
      e.resolve(val);
      return true;
    };
    const callCancelable = (action, payload = {}, timeoutMs = DEFAULT_TIMEOUT) => {
      if (disposed) return { id: 0, promise: Promise.resolve({ ok: false, reason: 'bridge-disposed' }), cancel: () => false };
      const binding = win?.[BINDING_NAME] || G[BINDING_NAME];
      if (typeof binding !== 'function') return { id: 0, promise: Promise.resolve({ ok: false, reason: 'bridge-offline' }), cancel: () => false };
      const id = ++seq;
      const promise = new Promise((res) => {
        const timer = setTimeout(() => { pending.delete(id); res({ ok: false, reason: 'rpc-timeout' }); }, timeoutMs);
        pending.set(id, { resolve: res, timer });
        try { binding(JSON.stringify({ id, action, payload })); }
        catch (err) { clearTimeout(timer); pending.delete(id); res({ ok: false, reason: 'rpc-throw', error: String(err?.message || err) }); }
      });
      return { id, promise, cancel: (v = { ok: false, cancelled: true, reason: 'cancelled' }) => settle(id, v) };
    };
    return {
      call: (a, p = {}, t = DEFAULT_TIMEOUT) => callCancelable(a, p, t).promise,
      callCancelable,
      resolve: settle,
      dispose() {
        disposed = true;
        for (const e of pending.values()) { clearTimeout(e.timer); e.resolve({ ok: false, reason: 'bridge-disposed' }); }
        pending.clear();
      },
    };
  }

  function textOf(node) {
    return String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const EXCLUDED_PANE_SEL = [
    '[data-side-panel-focus-scope="true"]',
    '[data-testid="side-question-panel"]',
    '[data-testid="subagent-tab-conversation"]',
  ].join(', ');

  const BLOCKING_BASE = [
    '#ag-prism-periodic-picker-root[data-open="1"]',
    '[data-testid="model-selector-panel"]', '.ag-omni-menu', '.ag-cs-ctx-menu',
    '.ag-prism-sidebar-modal', '[role="dialog"]', '#ag-cs-settings-sec',
    '[data-testid="slash-command-menu"]', '[data-testid="interaction-takeover-card"]',
  ];
  const BLOCKING_UI_SEL = [...BLOCKING_BASE, '[id^="typeahead-item-"][role="option"]', 'html[data-ag-pp-open="1"]', 'html[data-ag-cs-model-menu]'].join(', ');
  const BLOCKING_CONTAINER_SEL = BLOCKING_BASE.join(', ');

  function isVisibleNode(node) {
    if (!node || node.hidden === true || node.isConnected === false) return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (typeof node.closest === 'function' && node.closest('[hidden], .hidden, [inert]')) return false;
    if (typeof node.checkVisibility === 'function') {
      try { if (!node.checkVisibility()) return false; } catch {}
    }
    return true;
  }

  function isExcludedPaneNode(node) {
    return Boolean(node && typeof node.closest === 'function' && node.closest(EXCLUDED_PANE_SEL));
  }

  function isBlockingNode(node) {
    return Boolean(node && typeof node.closest === 'function' && node.closest(BLOCKING_CONTAINER_SEL));
  }

  function hasVisibleBlockingUi(doc) {
    const nodes = Array.from(doc?.querySelectorAll?.(BLOCKING_UI_SEL) || []);
    return nodes.some(isVisibleNode);
  }

  const COMPOSER_EDITOR_SEL = '.surface-composer [data-lexical-editor="true"], .surface-composer [contenteditable="true"], .surface-composer-card [data-lexical-editor="true"], .surface-composer-card [contenteditable="true"], .agy-composer [contenteditable="true"], [data-testid="agent-input-box"] [contenteditable="true"], [data-testid="composer-editor"], .surface-composer textarea, .surface-composer-card textarea';

  function getComposerCandidates(doc) {
    if (!doc || hasVisibleBlockingUi(doc)) return [];
    const views = Array.from(doc.querySelectorAll?.('[data-testid="conversation-view"]') || []);
    const scopes = views.length > 0
      ? views.filter((node) => isVisibleNode(node) && !isExcludedPaneNode(node) && !isBlockingNode(node))
      : [doc.body || doc.documentElement];
    const seen = new Set();
    const candidates = [];
    for (const view of scopes) {
      const editors = Array.from(view?.querySelectorAll?.(COMPOSER_EDITOR_SEL) || [])
        .filter((node) => isVisibleNode(node) && !isExcludedPaneNode(node) && !isBlockingNode(node));
      for (const editor of editors) {
        const root = editor?.closest?.('.surface-composer, .surface-composer-card, .agy-composer, [data-testid="agent-input-box"], [data-testid="composer-editor"]') || null;
        if (!root || seen.has(root) || isExcludedPaneNode(root) || isBlockingNode(root)) continue;
        seen.add(root);
        const owner = view?.closest?.('[data-cascade-id]') || editor?.closest?.('[data-cascade-id]');
        candidates.push({ view, root, editor, cascadeId: String(owner?.getAttribute?.('data-cascade-id') || 'default-main') });
      }
    }
    return candidates;
  }

  function getActiveComposer(doc) {
    return getComposerCandidates(doc)[0] || { view: null, root: null, editor: null, cascadeId: '' };
  }

  function findComposerFooter(root, editor) {
    if (!root?.querySelector) return null;
    const sels = ['.agy-composer-footer', '[data-testid="input-box-bottom-toolbar"]', '.composer-footer', '[data-testid="composer-footer"]', '[data-testid="agent-input-footer"]', '[data-composer-footer]', '[data-testid="agent-input-box-footer"]'];
    const footer = sels.map((s) => root.querySelector(s)).find(Boolean) || Array.from(root.children || []).find((n) => /(?:^|\s)(?:agy-)?composer-footer(?:\s|$)/.test(String(n?.className || '')) || ['input-box-bottom-toolbar', 'composer-footer', 'agent-input-footer', 'agent-input-box-footer'].includes(String(n?.getAttribute?.('data-testid') || '')) || n?.hasAttribute?.('data-composer-footer')) || null;
    return !footer || footer === editor || !isVisibleNode(footer) || footer.closest?.('[hidden],[inert]') ? null : footer;
  }

  function readEditor(editor) {
    if (!editor) return '';
    if (typeof editor.value === 'string') return editor.value;
    if (typeof editor.innerText === 'string') return editor.innerText.replace(/\u00a0/g, ' ');
    return String(editor.textContent || '').replace(/\u00a0/g, '');
  }

  function normalizeEditorText(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  }

  function sameEditorText(left, right) {
    return normalizeEditorText(left).replace(/\s+$/g, '') === normalizeEditorText(right).replace(/\s+$/g, '');
  }

  function sanitizeEnhancedText(value) {
    const p = [];
    const text = String(value ?? '')
      .replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s<>"'`\u3000-\u303F\uFF00-\uFFEF\u4E00-\u9FFF]+|\*{1,2}\/[^\s]+/g, (m) => `\u0000${p.push(m) - 1}\u0000`)
      .replace(/(^|[^\w*])\*\*(\S(?:[^*\n]*?\S)?)\*\*(?=$|[^\w*])/g, '$1$2')
      .replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[^\w*])/g, '$1$2');
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => p[Number(i)] || '');
  }

  function dispatchEditorEvent(doc, editor, type, init = {}) {
    try {
      const EventCtor = type === 'input'
        ? (doc.defaultView?.InputEvent || doc.defaultView?.Event || Event)
        : (doc.defaultView?.Event || Event);
      editor.dispatchEvent?.(new EventCtor(type, { bubbles: true, ...init }));
    } catch {}
  }

  async function waitEditorSync(doc, editor, expected) {
    if (sameEditorText(readEditor(editor), expected)) return true;
    await Promise.resolve();
    if (sameEditorText(readEditor(editor), expected)) return true;
    const raf = doc?.defaultView?.requestAnimationFrame;
    const waitTick = () => new Promise((r) => (typeof raf === 'function' ? raf(r) : setTimeout(r, 16)));
    for (let i = 0; i < 2; i++) {
      await waitTick();
      if (sameEditorText(readEditor(editor), expected)) return true;
    }
    return false;
  }

  async function finishWrite(doc, editor, text, opts = {}) {
    if (opts.emitEvents !== false) {
      dispatchEditorEvent(doc, editor, 'input', { inputType: 'insertReplacementText', data: text });
      dispatchEditorEvent(doc, editor, 'change');
    }
    const matched = opts.asyncWait ? await waitEditorSync(doc, editor, text) : sameEditorText(readEditor(editor), text);
    const actual = readEditor(editor);
    return matched ? { status: 'applied', actual } : { status: 'unverified', actual };
  }

  async function writeEditor(doc, editor, value) {
    if (!editor || editor.isConnected === false) return { status: 'blocked', reason: 'target-missing' };
    const text = String(value ?? '');
    if (!text.trim()) return { status: 'empty' };
    if (sameEditorText(readEditor(editor), text)) return { status: 'applied', actual: readEditor(editor) };
    let attempted = false;
    try { editor.focus?.({ preventScroll: true }); } catch { try { editor.focus?.(); } catch {} }
    if (typeof editor.value === 'string') {
      try {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
        if (setter) setter.call(editor, text); else editor.value = text;
        attempted = true;
      } catch { try { editor.value = text; attempted = true; } catch {} }
      try { editor.selectionStart = editor.selectionEnd = text.length; } catch {}
      if (attempted) return finishWrite(doc, editor, text);
      const actual = readEditor(editor);
      return sameEditorText(actual, text) ? { status: 'applied', actual } : { status: 'failed', actual };
    }
    try {
      const lexical = editor.__lexicalEditor;
      if (lexical?._commands && typeof lexical.dispatchCommand === 'function') {
        try { lexical.focus?.(); } catch {}
        let selectAll, removeCmd, insertCmd;
        for (const cmd of lexical._commands.keys()) {
          if (cmd?.type === 'SELECT_ALL_COMMAND') selectAll = cmd;
          else if (cmd?.type === 'REMOVE_TEXT_COMMAND') removeCmd = cmd;
          else if (cmd?.type === 'CONTROLLED_TEXT_INSERTION_COMMAND') insertCmd = cmd;
        }
        if (insertCmd) {
          const r = doc.createRange?.(), sel = doc.defaultView?.getSelection?.();
          if (r && sel) { r.selectNodeContents(editor); sel.removeAllRanges?.(); sel.addRange?.(r); }
          const run = () => {
            if (selectAll) lexical.dispatchCommand(selectAll, undefined);
            if (removeCmd) lexical.dispatchCommand(removeCmd, undefined);
            lexical.dispatchCommand(insertCmd, text);
          };
          if (typeof lexical.update === 'function') lexical.update(run, { discrete: true });
          else run();
          attempted = true;
          return finishWrite(doc, editor, text, { emitEvents: false, asyncWait: true });
        }
      }
    } catch {}
    try {
      const r = doc.createRange?.(), sel = doc.defaultView?.getSelection?.();
      if (r && sel) { r.selectNodeContents(editor); sel.removeAllRanges?.(); sel.addRange?.(r); }
      doc.execCommand?.('selectAll', false);
      if (doc.execCommand?.('insertText', false, text)) { attempted = true; return finishWrite(doc, editor, text, { emitEvents: false, asyncWait: true }); }
    } catch {}
    try { editor.textContent = text; attempted = true; return finishWrite(doc, editor, text); } catch {}
    return { status: attempted ? 'unverified' : 'failed' };
  }

  const CONTEXT_EXCLUDE_SEL = '[data-message-type="reasoning"],[data-testid*="reasoning"],[data-testid*="tool"],[hidden],[inert]';
  const CONTEXT_STREAM_SEL = '[aria-busy="true"],[data-is-streaming="true"],[data-streaming="true"],[data-message-status="in_progress"],[data-status="streaming"]';
  const trimContext = (s, max = 3000) => s.length <= max ? s : `${s.slice(0, 1100)}\n...\n${s.slice(-(max - 1105))}`;
  const hasBackRef = (s) => /(?:按刚才|方案[一二三四1-4]|继续(?:修复|排查|实现|处理|改)|这个(?:问题|错误|bug|方案|改动)|\b(?:continue|above|previous|that fix|option\s*[1-4])\b)/i.test(String(s || ''));

  function extractContext(view, maxRounds = 1) {
    if (!view) return [];
    const nodes = Array.from(view.querySelectorAll?.('[data-testid="user-message-content"], [data-testid="user-message-bubble"], [data-testid="agent-response"], [data-testid="planner-response-text"]') || []);
    const rounds = [];
    let uBuf = [], aLast = '';
    const flush = () => { if (uBuf.length && aLast) rounds.push({ u: uBuf.join('\n'), a: aLast }); uBuf = []; aLast = ''; };
    for (const node of nodes.slice(-24)) {
      if (node.closest?.(CONTEXT_EXCLUDE_SEL) || node.matches?.(CONTEXT_STREAM_SEL) || node.querySelector?.(CONTEXT_STREAM_SEL)) continue;
      const txt = textOf(node);
      if (!txt) continue;
      const isUser = Boolean(node.closest?.('[data-testid="user-message"], [data-message-role="user"], [data-role="user"]')) || /user-message/i.test(String(node.getAttribute?.('data-testid') || ''));
      if (isUser) { if (aLast) flush(); uBuf.push(txt); }
      else if (uBuf.length) aLast = txt;
    }
    flush();
    const limit = [1, 2, 3, 4].includes(Number(maxRounds)) ? Number(maxRounds) : 1;
    return rounds.slice(-limit).flatMap((r) => [{ role: 'user', text: trimContext(r.u) }, { role: 'assistant', text: trimContext(r.a) }]);
  }

  function injectStyle(doc) {
    if (doc.getElementById?.(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head?.appendChild(style);
  }

  function createRestoreButton(doc, labels) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ag-prism-prompt-enhancer-btn';
    btn.setAttribute('data-testid', RESTORE_TESTID);
    btn.setAttribute('aria-label', labels.restore);
    btn.textContent = labels.restore;
    btn.hidden = true;
    return btn;
  }

  function createButton(doc, labels) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ag-prism-prompt-enhancer-btn';
    button.setAttribute('data-testid', BUTTON_TESTID);
    button.setAttribute('aria-label', labels.button);
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'ag-prism-prompt-enhancer-icon lucide lucide-sparkles');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.8');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    for (const d of ['m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z', 'm19 14 1.1 3.1L23 18l-2.9 1L19 22l-1-3-3-1 3-1 1-3Z', 'm5 2 .8 2.2L8 5l-2.2.8L5 8l-.8-2.2L2 5l2.2-.8L5 2Z']) {
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      icon.appendChild(path);
    }
    const label = doc.createElement('span');
    label.textContent = labels.button;
    button.__agPrismPromptEnhancerLabel = label;
    button.append(icon, label);
    return button;
  }

  function createPanel(doc, state, labels) {
    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const panel = mk('section', 'ag-prism-prompt-enhancer-panel');
    panel.setAttribute('data-testid', PANEL_TESTID);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', labels.title);
    const head = mk('div', 'ag-prism-prompt-enhancer-head');
    const close = mk('button', 'ag-prism-prompt-enhancer-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', labels.close);
    head.append(mk('span', '', labels.title), close);
    const tabs = mk('div', 'ag-prism-prompt-enhancer-tabs');
    const body = mk('div', 'ag-prism-prompt-enhancer-body');
    const editor = mk('textarea', 'ag-prism-prompt-enhancer-editor');
    editor.hidden = true;
    const status = mk('div', 'ag-prism-prompt-enhancer-status');
    const actions = mk('div', 'ag-prism-prompt-enhancer-actions');
    const makeAction = (label, primary = false) => {
      const btn = mk('button', 'ag-prism-prompt-enhancer-action', label);
      btn.type = 'button';
      if (primary) btn.setAttribute('data-primary', '1');
      return btn;
    };
    const copy = makeAction(labels.copy), edit = makeAction(labels.edit), retry = makeAction(labels.retry);
    const replace = makeAction(labels.replace, true), cancel = makeAction(labels.cancel);
    cancel.hidden = true;
    actions.append(copy, edit, retry, replace, cancel);
    panel.append(head, tabs, body, editor, status, actions);
    doc.body?.appendChild(panel);

    const setTab = (name) => {
      while (tabs.firstChild) tabs.firstChild.remove();
      for (const [label, value] of [[labels.original, 'original'], [labels.result, 'enhanced']]) {
        const button = mk('button', 'ag-prism-prompt-enhancer-tab', label);
        button.type = 'button';
        button.setAttribute('data-active', name === value ? '1' : '0');
        if (value === 'enhanced') button.disabled = !state.enhanced;
        button.addEventListener('click', () => setTab(value));
        tabs.appendChild(button);
      }
      body.textContent = name === 'original' ? state.original : state.enhanced;
      body.hidden = false;
      editor.hidden = true;
      state.tab = name;
    };
    close.addEventListener('click', () => { state.cancel?.(); panel.remove(); });
    copy.addEventListener('click', async () => {
      const value = !editor.hidden ? editor.value : state.tab === 'original' ? state.original : state.enhanced;
      try { await doc.defaultView?.navigator?.clipboard?.writeText?.(value); status.textContent = labels.copied; } catch { status.textContent = labels.copyFailed; }
    });
    edit.addEventListener('click', () => {
      editor.value = state.enhanced; body.hidden = true; editor.hidden = false; editor.focus?.(); status.textContent = labels.editHint;
    });
    let replacing = false;
    replace.addEventListener('click', async () => {
      if (replacing) return;
      replacing = true;
      try {
        const value = editor.hidden ? state.enhanced : editor.value;
        const result = (await state.replace?.(value)) || { status: 'failed' };
        if (result.status === 'applied') {
          status.textContent = labels.replaced;
          panel.remove();
          state.onApplied?.(value);
        } else if (result.status === 'empty') status.textContent = labels.emptyResult;
        else if (result.reason === 'target-missing') status.textContent = labels.targetMissing;
        else if (result.reason === 'target-changed') status.textContent = labels.replaceConflict;
        else if (result.status === 'unverified') status.textContent = labels.replaceUnverified;
        else status.textContent = labels.replaceFailed;
      } finally { replacing = false; }
    });
    retry.addEventListener('click', () => state.retry?.());
    cancel.addEventListener('click', () => state.cancel?.());
    setTab('original');
    return { panel, body, editor, status, cancel, setTab };
  }

  function createRuntime(env = {}) {
    const win = env.window || G;
    const doc = env.document || win?.document;
    if (!doc) return null;
    const bridge = createBridge(win);
    try { win.__agPrismPromptEnhancerBridge = bridge; G.__agPrismPromptEnhancerBridge = bridge; } catch {}
    const resolvePromptEnhancer = (id, value) => bridge.resolve(id, value);
    try { win.__agPrismPromptEnhancerResolve = resolvePromptEnhancer; G.__agPrismPromptEnhancerResolve = resolvePromptEnhancer; } catch {}
    let destroyed = false, active = false, loading = false, observer = null;
    let config = { enabled: false, includeRecentContext: false, recentContextCount: 1 };
    let panelState = null, panelView = null, reqId = '', reqCancel = null, reqBtn = null, msgTimer = null;
    const entries = new Map();
    const labels = strings(doc);
    const updateButton = (busy, activeBtn = null) => {
      for (const entry of entries.values()) {
        const btn = entry.button;
        if (!btn) continue;
        const isActive = Boolean(busy && activeBtn && btn === activeBtn);
        btn.disabled = Boolean(busy && !isActive);
        btn.setAttribute('aria-busy', isActive ? 'true' : 'false');
        btn.setAttribute('aria-label', isActive ? labels.cancel : labels.button);
        if (isActive) btn.setAttribute('title', labels.cancel);
        else btn.removeAttribute?.('title');
        if (btn.__agPrismPromptEnhancerLabel) btn.__agPrismPromptEnhancerLabel.textContent = isActive ? labels.cancel : labels.button;
        if (entry.restoreBtn) entry.restoreBtn.disabled = Boolean(busy);
      }
    };
    const showButtonMessage = (message, target = null) => {
      clearTimeout(msgTimer);
      updateButton(false);
      const btn = target?.button || entries.get(target?.root)?.button || doc.querySelector?.(`[data-testid="${BUTTON_TESTID}"]`);
      if (!btn) return;
      btn.setAttribute('aria-label', message);
      btn.setAttribute('title', message);
      btn.setAttribute('data-status', message);
      if (btn.__agPrismPromptEnhancerLabel) btn.__agPrismPromptEnhancerLabel.textContent = labels.button;
      msgTimer = setTimeout(() => {
        if (!loading) { btn.removeAttribute?.('data-status'); btn.removeAttribute?.('title'); updateButton(false); }
      }, 2200);
    };
    const bindEditorInput = (entry) => {
      if (!entry?.editor || entry.boundEditor === entry.editor) return;
      entry.boundEditor = entry.editor;
      entry.editor.addEventListener?.('input', () => {
        if (entry.writing || !entry.lastUndo) return;
        entry.lastUndo = null;
        if (entry.restoreBtn) entry.restoreBtn.hidden = true;
      });
    };
    const restoreDraft = async (entry) => {
      if (!entry?.lastUndo || !entry.editor || entry.editor.isConnected === false || loading) return;
      if (!sameEditorText(readEditor(entry.editor), entry.lastUndo.enhanced)) {
        entry.lastUndo = null;
        if (entry.restoreBtn) entry.restoreBtn.hidden = true;
        showButtonMessage(labels.replaceConflict, entry);
        return;
      }
      entry.writing = true;
      let res;
      try { res = await writeEditor(doc, entry.editor, entry.lastUndo.original); } finally { entry.writing = false; }
      if (res?.status === 'applied') {
        entry.lastUndo = null;
        if (entry.restoreBtn) entry.restoreBtn.hidden = true;
        showButtonMessage(labels.restored, entry);
      } else showButtonMessage(res?.status === 'unverified' ? labels.replaceUnverified : labels.replaceFailed, entry);
    };
    const showPreviewPanel = (reqState, message) => {
      panelView?.panel?.remove?.();
      const owner = entries.get(reqState.root);
      reqState.retry = () => { panelView?.panel?.remove?.(); panelView = null; triggerEnhancement(reqState); };
      reqState.cancel = () => { panelView = null; };
      reqState.onApplied = (applied) => {
        panelView = null;
        if (owner) { owner.lastUndo = { original: reqState.editorSnapshot, enhanced: applied }; if (owner.restoreBtn) owner.restoreBtn.hidden = false; }
        showButtonMessage(labels.replaced, reqState);
      };
      panelView = createPanel(doc, reqState, labels);
      panelView.setTab('enhanced');
      panelView.status.textContent = message;
    };
    const cancelActiveRequest = (removePanel = false) => {
      const id = reqId, cancelRpc = reqCancel;
      reqId = ''; reqCancel = null; reqBtn = null; loading = false;
      clearTimeout(msgTimer); msgTimer = null;
      updateButton(false);
      if (panelView) {
        panelView.cancel.hidden = true;
        panelView.status.textContent = labels.cancelled;
        panelState?.setTab?.('original');
        if (removePanel) { panelView.panel.remove(); panelView = null; }
      }
      panelState = null;
      cancelRpc?.({ ok: false, cancelled: true, reason: 'cancelled' });
      if (id) void bridge.call('cancel', { requestId: id }, 5000);
    };
    const removeMountedEntry = (entry) => {
      if (!entry) return;
      entry.host?.remove?.();
      if (entry.root && entry.rootPosition !== null && entry.root.style) entry.root.style.position = entry.rootPosition;
      if (entry.root) entries.delete(entry.root);
    };
    const removeMountedButton = () => {
      for (const entry of entries.values()) removeMountedEntry(entry);
      doc.querySelectorAll?.(`[data-testid="${BUTTON_TESTID}"]`)?.forEach?.((node) => {
        if (!node.closest?.(`[data-testid="${BUTTON_HOST_TESTID}"]`)) node.remove?.();
      });
    };
    const mount = () => {
      if (destroyed || !config.enabled) return;
      const candidates = getComposerCandidates(doc);
      if (candidates.length === 0) { removeMountedButton(); return; }
      injectStyle(doc);
      const activeRoots = new Set(candidates.map((c) => c.root));
      for (const [root, entry] of entries.entries()) if (!activeRoots.has(root)) removeMountedEntry(entry);
      for (const c of candidates) {
        const footer = findComposerFooter(c.root, c.editor), parent = footer || c.root;
        let entry = entries.get(c.root);
        if (!entry || entry.host?.parentNode !== parent) {
          if (entry) removeMountedEntry(entry);
          let rootPosition = null;
          if (!footer && c.root.style) {
            rootPosition = c.root.style.position || '';
            const pos = doc.defaultView?.getComputedStyle?.(c.root)?.position;
            if (!pos || pos === 'static') c.root.style.position = 'relative';
          }
          const host = doc.createElement('div');
          host.className = 'ag-prism-prompt-enhancer-host';
          host.setAttribute('data-testid', BUTTON_HOST_TESTID);
          if (!footer) host.setAttribute('data-fallback', '1');
          const button = createButton(doc, labels), restoreBtn = createRestoreButton(doc, labels);
          entry = { ...c, footer, parent, host, button, restoreBtn, rootPosition, lastUndo: null, writing: false, boundEditor: null };
          button.addEventListener('click', () => triggerEnhancement(entry));
          restoreBtn.addEventListener('click', () => restoreDraft(entry));
          host.append(button, restoreBtn);
          parent.appendChild(host);
          entries.set(c.root, entry);
        } else {
          entry.view = c.view; entry.editor = c.editor; entry.cascadeId = c.cascadeId; entry.footer = footer; entry.parent = parent;
          if (footer) entry.host.removeAttribute?.('data-fallback');
        }
        bindEditorInput(entry);
        entry.button.hidden = false;
        if (entry.restoreBtn) entry.restoreBtn.hidden = !entry.lastUndo;
        if (footer && entry.host.parentNode !== footer) footer.prepend?.(entry.host);
      }
    };
    const triggerEnhancement = async (target = null) => {
      if (destroyed || !config.enabled) return;
      if (loading) { if (target?.button && target.button === reqBtn) cancelActiveRequest(true); return; }
      const snap = target?.root && target?.editor?.isConnected !== false ? target : getActiveComposer(doc);
      if (!snap.editor) return;
      const editorSnapshot = readEditor(snap.editor), original = editorSnapshot.trim();
      if (!original) { showButtonMessage(labels.emptyInput, snap); return; }
      loading = true;
      const entry = entries.get(snap.root) || null;
      const button = target?.button || entry?.button || null;
      if (entry) { entry.lastUndo = null; if (entry.restoreBtn) entry.restoreBtn.hidden = true; }
      reqBtn = button;
      updateButton(true, button);
      const id = `pe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      reqId = id;
      const context = config.includeRecentContext ? extractContext(snap.view, config.recentContextCount) : [];
      panelState = { original, editorSnapshot, enhanced: '', editor: snap.editor, root: snap.root, cascadeId: snap.cascadeId, button };
      const rep = panelState;
      panelState.replace = async (value) => {
        if (!rep.editor || rep.editor.isConnected === false) return { status: 'blocked', reason: 'target-missing' };
        if (rep.root !== panelState?.root && rep !== panelState) return { status: 'blocked', reason: 'target-changed' };
        const currentText = readEditor(rep.editor);
        if (sameEditorText(currentText, value)) return { status: 'applied', actual: currentText };
        if (!sameEditorText(currentText, rep.editorSnapshot)) return { status: 'blocked', reason: 'target-changed' };
        const owner = entries.get(rep.root);
        if (owner) owner.writing = true;
        try { return await writeEditor(doc, rep.editor, value); } finally { if (owner) owner.writing = false; }
      };
      if (original.length > MAX_REQUEST_CHARS) {
        loading = false; reqId = ''; reqBtn = null; updateButton(false); showButtonMessage(labels.tooLong, snap); return;
      }
      const reqState = panelState;
      let msg = '';
      try {
        const request = bridge.callCancelable('enhance', {
          original, context, includeRecentContext: config.includeRecentContext, recentContextCount: config.recentContextCount, profileId: config.profileId, model: config.model, requestId: id,
        }, DEFAULT_TIMEOUT);
        reqCancel = request.cancel;
        const result = await request.promise;
        if (destroyed || !config.enabled || reqId !== id || panelState !== reqState) return;
        const enhanced = sanitizeEnhancedText(result?.enhanced).trim();
        if (result?.ok && enhanced.trim()) {
          reqState.enhanced = enhanced;
          const issueMsg = result.outputIssue === 'preface' ? labels.languagePrefaceIssue
            : result.outputIssue === 'language-mismatch' ? labels.languageMismatchIssue
            : result.tokensPreserved === false ? labels.tokensChanged : '';
          if (issueMsg) { showPreviewPanel(reqState, issueMsg); return; }
          const replacement = await reqState.replace(enhanced);
          if (replacement.status === 'applied') {
            if (entry) { entry.lastUndo = { original: editorSnapshot, enhanced }; if (entry.restoreBtn) entry.restoreBtn.hidden = false; }
            const suffix = config.includeRecentContext ? (result.usedContext ? labels.contextAttached : labels.contextUnavailable) : (hasBackRef(original) ? labels.contextHint : '');
            msg = labels.replaced + suffix;
          } else if (replacement.reason === 'target-missing') msg = labels.targetMissing;
          else if (replacement.reason === 'target-changed') showPreviewPanel(reqState, labels.replaceConflict);
          else if (replacement.status === 'empty') msg = labels.emptyResult;
          else if (replacement.status === 'unverified') showPreviewPanel(reqState, labels.replaceUnverified);
          else showPreviewPanel(reqState, labels.replaceFailed);
        } else if (result?.ok) {
          reqState.enhanced = ''; msg = labels.emptyResult;
        } else {
          msg = result?.reason === 'truncated' ? labels.truncated
            : result?.reason === 'refused' ? labels.refused
            : result?.reason === 'analysis-output' ? labels.analysisOutput : labels.failed;
        }
      } catch {
        if (panelState === reqState) msg = labels.failed;
      } finally {
        if (reqId === id) {
          reqId = ''; reqCancel = null; reqBtn = null; loading = false;
          if (msg) showButtonMessage(msg, reqState); else updateButton(false);
        }
      }
    };
    const activate = () => {
      if (active || destroyed || !config.enabled) return;
      active = true;
      injectStyle(doc);
      mount();
      win.addEventListener?.('resize', mount, { passive: true });
      win.addEventListener?.('scroll', mount, { passive: true, capture: true });
      observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => mount()) : null;
      observer?.observe?.(doc.body || doc.documentElement, { childList: true, subtree: true });
    };
    const deactivate = () => {
      active = false;
      clearTimeout(msgTimer); msgTimer = null;
      observer?.disconnect?.(); observer = null;
      win.removeEventListener?.('resize', mount);
      win.removeEventListener?.('scroll', mount, true);
      cancelActiveRequest(true);
      doc.querySelectorAll?.(`[data-testid="${BUTTON_TESTID}"], [data-testid="${PANEL_TESTID}"]`)?.forEach?.((node) => node.remove());
      removeMountedButton();
      panelView = null; panelState = null;
      doc.getElementById?.(STYLE_ID)?.remove?.();
    };
    const applyConfig = (next = {}) => {
      const enabled = next && Object.prototype.hasOwnProperty.call(next, 'enabled')
        ? Boolean(next.enabled)
        : next?.promptEnhancer === 'on';
      const count = Number(next.recentContextCount);
      config = {
        enabled,
        profileId: String(next.profileId || ''),
        model: String(next.model || ''),
        includeRecentContext: Boolean(next.includeRecentContext),
        recentContextCount: [1, 2, 3, 4].includes(count) ? count : 1,
      };
      if (config.enabled) activate(); else deactivate();
    };
    const refresh = async () => {
      const result = await bridge.call('get-config', {}, 8000);
      if (result?.ok) applyConfig(result.config);
      return result;
    };
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      deactivate();
      bridge.dispose();
      try { delete win.__agPrismPromptEnhancerBridge; delete G.__agPrismPromptEnhancerBridge; delete win.__agPrismPromptEnhancerResolve; delete G.__agPrismPromptEnhancerResolve; } catch {}
    };
    if (env.initialConfig && typeof env.initialConfig === 'object') applyConfig(env.initialConfig);
    else void refresh();
    return { applyConfig, refresh, triggerEnhancement, getDebugState: () => ({ destroyed, active, loading, enabled: config.enabled }), destroy };
  }

  G.__agPrismPromptEnhancerFactory = createRuntime;
  if (typeof window !== 'undefined' && window) window.__agPrismPromptEnhancerFactory = createRuntime;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
