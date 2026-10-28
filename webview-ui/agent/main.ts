import hljs from 'highlight.js/lib/common';
import { Marked, Renderer } from 'marked';
import { BRAND_MARK, icons, modeIcon, providerIcon } from './icons';
import './styles.css';

// -------------------------------------------------------------------------------------------------
// Types mirrored from the extension (kept loose on purpose: the webview is a separate bundle)
// -------------------------------------------------------------------------------------------------

type AskKind = 'tool' | 'command' | 'followup' | 'completion_result' | 'mode_switch' | 'new_task' | 'request_limit' | 'mistake_limit' | 'api_failed' | 'resume_task';

interface DiffLine { type: ' ' | '+' | '-' | '@'; text: string }

interface UiMessage {
  id: string;
  ts: number;
  type: 'user' | 'text' | 'reasoning' | 'tool' | 'command' | 'completion' | 'followup' | 'error' | 'info' | 'checkpoint' | 'subtask' | 'api_req';
  text?: string;
  partial?: boolean;
  tool?: { name: string; path?: string; title: string; content?: string; diff?: DiffLine[]; added?: number; removed?: number; isNewFile?: boolean; mode?: string; reason?: string; outsideWorkspace?: boolean };
  command?: { command: string; cwd?: string; output?: string; exitCode?: number | null; running?: boolean };
  suggestions?: Array<{ text: string; mode?: string }>;
  ask?: { kind: AskKind; resolved: boolean; response?: string; autoApproved?: boolean };
  status?: 'pending' | 'approved' | 'rejected' | 'done' | 'error' | 'running';
  meta?: { model?: string; account?: string; citations?: string[]; promptChars?: number; followUp?: boolean; durationMs?: number };
  checkpoint?: { seq: number; restored?: boolean };
}

interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'completed' }

interface ModelEntry {
  id: string; label: string; description: string; category: string; supportsThinking: boolean;
  requiredPlan: string; isNew: boolean; surfaced: boolean; selectable: boolean; provider: string | null;
}

interface AppState {
  version: string;
  task: null | {
    id: string; parentId?: string; title: string; mode: string; busy: boolean; todos: TodoItem[];
    status: { state: string; askId?: string; askKind?: AskKind; requestCount: number };
    messages?: UiMessage[]; depth: number; parentTitle?: string;
  };
  mode: string;
  modes: Array<{ slug: string; name: string; description: string; icon: string }>;
  models: ModelEntry[];
  selection: { modelId: string; thinking: boolean; webSearch: boolean | null; modelLabel: string; modeWebSearchDefault: boolean };
  settings: any;
  general: { subscriptionPlan: string; rotationStrategy: string; revealEditedFiles: boolean; modelsSnapshot: string };
  accounts: Array<{ id: string; alias: string; status: string; plan: string; email?: string; queriesToday: number; queriesTotal: number; lastUsedAt?: string; quotas: Record<string, string> }>;
  history: Array<{ id: string; ts: number; title: string; workspace: string; mode: string; status: string; requestCount: number }>;
  workspace: string | null;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): any; setState(state: any): void };
const vscode = acquireVsCodeApi();

// -------------------------------------------------------------------------------------------------
// Markdown
// -------------------------------------------------------------------------------------------------

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderer = new Renderer();
renderer.html = (html: string) => escapeHtml(html);
renderer.code = (code: string, info: string | undefined) => {
  const lang = (info || '').trim().split(/\s+/)[0];
  if (lang === 'mermaid') {
    return `<div class="code-block mermaid-block"><div class="code-toolbar"><span>mermaid</span><button class="icon-btn" data-copy="${escapeHtml(code)}" title="Copy">${icons.copy}</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
  }
  let highlighted: string;
  try {
    highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value;
  } catch {
    highlighted = escapeHtml(code);
  }
  return `<div class="code-block"><div class="code-toolbar"><span>${escapeHtml(lang || 'text')}</span><span class="spacer"></span><button class="icon-btn" data-insert="${escapeHtml(code)}" title="Insert at cursor">${icons.insert}</button><button class="icon-btn" data-copy="${escapeHtml(code)}" title="Copy">${icons.copy}</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
};
renderer.link = (href: string, title: string | null | undefined, text: string) => {
  const safe = /^(https?:|mailto:)/i.test(href || '') ? href : '#';
  return `<a href="${escapeHtml(safe)}" data-url="${escapeHtml(safe)}" title="${escapeHtml(title || href || '')}">${text}</a>`;
};
renderer.image = (href: string, _title: string | null, text: string) => `<a data-url="${escapeHtml(href || '')}" href="#">${escapeHtml(text || href || 'image')}</a>`;

const marked = new Marked({ renderer, gfm: true, breaks: true });

function md(text: string | undefined): string {
  if (!text) {
    return '';
  }
  try {
    const html = marked.parse(text, { async: false }) as string;
    // Turn inline `path/to/file.ts:12` code spans into clickable file links.
    return html.replace(/<code>([\w./@-]+\.[a-zA-Z0-9]{1,8})(?::(\d+))?<\/code>/g, (_m, file: string, line?: string) =>
      `<code class="file-link" data-file="${escapeHtml(file)}"${line ? ` data-line="${line}"` : ''}>${escapeHtml(file)}${line ? `:${line}` : ''}</code>`);
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

// -------------------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------------------

let state: AppState | undefined;
let messages: UiMessage[] = [];
let currentTaskId: string | undefined;
let view: 'chat' | 'history' | 'settings' = 'chat';
let settingsTab = 'accounts';
let historyQuery = '';
let modelMenuOpen = false;
let modeMenuOpen = false;
let showMoreModels = false;
let autoApproveOpen = false;
let todosOpen = true;
let titleExpanded = false;
let stickToBottom = true;
let mentionState: { start: number; query: string; items: Array<{ label: string; value: string; kind: string }>; index: number } | undefined;
let slashState: { items: Array<{ label: string; value: string; description: string }>; index: number } | undefined;
let enhancing = false;
const expanded = new Set<string>();
const collapsed = new Set<string>();

const saved = vscode.getState() as { draft?: string } | undefined;
let draft = saved?.draft || '';

const root = document.getElementById('root')!;
root.innerHTML = `
  <div class="app">
    <div id="view-chat" class="view chat-view">
      <div id="task-header"></div>
      <div id="messages" class="messages"></div>
      <div id="welcome" class="welcome"></div>
      <div id="bottom" class="bottom">
        <div id="ask-bar" class="ask-bar"></div>
        <div id="auto-approve" class="auto-approve"></div>
        <div class="composer" id="composer">
          <div id="popup" class="popup hidden"></div>
          <textarea id="input" rows="3" placeholder="Type your task here… (@ to add context, / for commands, Shift+Enter for new line)"></textarea>
          <div class="composer-bar">
            <div class="selector-wrap">
              <button id="mode-btn" class="pill"></button>
              <div id="mode-menu" class="menu hidden"></div>
            </div>
            <div class="selector-wrap grow">
              <button id="model-btn" class="pill model-pill"></button>
              <div id="model-menu" class="menu model-menu hidden"></div>
            </div>
            <button id="web-btn" class="icon-btn toggle" title="Web search"></button>
            <button id="enhance-btn" class="icon-btn" title="Enhance prompt">${icons.sparkle}</button>
            <button id="send-btn" class="icon-btn send" title="Send (Enter)">${icons.send}</button>
          </div>
        </div>
      </div>
    </div>
    <div id="view-history" class="view hidden"></div>
    <div id="view-settings" class="view hidden"></div>
  </div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLTextAreaElement>('input');
const messagesEl = $('messages');
input.value = draft;

const messageElements = new Map<string, HTMLElement>();

// -------------------------------------------------------------------------------------------------
// Messaging
// -------------------------------------------------------------------------------------------------

function post(message: Record<string, unknown>): void {
  vscode.postMessage(message);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      applyState(message as AppState & { includeMessages: boolean });
      break;
    case 'messageUpdated':
      if (message.taskId === currentTaskId) {
        upsertMessage(message.message);
      }
      break;
    case 'messageRemoved':
      if (message.taskId === currentTaskId) {
        messages = messages.filter((entry) => entry.id !== message.id);
        messageElements.get(message.id)?.remove();
        messageElements.delete(message.id);
      }
      break;
    case 'mentionResults':
      if (mentionState && mentionState.query === message.query) {
        mentionState.items = message.results;
        mentionState.index = 0;
        renderPopup();
      }
      break;
    case 'enhancedPrompt':
      enhancing = false;
      if (message.error) {
        showToast(`Enhance failed: ${message.error}`);
      } else if (message.text) {
        input.value = message.text;
        saveDraft();
        autoResize();
      }
      renderComposer();
      break;
    case 'addToInput':
      input.value = `${input.value ? `${input.value}\n` : ''}${message.text}\n`;
      saveDraft();
      autoResize();
      input.focus();
      break;
    case 'view':
      setView(message.view);
      break;
    case 'focusInput':
      input.focus();
      break;
    default:
      break;
  }
});

function applyState(next: AppState & { includeMessages: boolean }): void {
  const previousTaskId = currentTaskId;
  state = next;
  const taskId = next.task?.id;
  if (taskId !== previousTaskId || next.includeMessages) {
    currentTaskId = taskId;
    if (next.task?.messages) {
      messages = next.task.messages.slice();
    } else if (!taskId) {
      messages = [];
    }
    renderAllMessages();
  }
  renderTaskHeader();
  renderWelcome();
  renderAskBar();
  renderAutoApprove();
  renderComposer();
  if (view === 'history') {
    renderHistory();
  }
  if (view === 'settings') {
    renderSettings();
  }
}

// -------------------------------------------------------------------------------------------------
// Messages rendering
// -------------------------------------------------------------------------------------------------

function upsertMessage(message: UiMessage): void {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index >= 0) {
    messages[index] = message;
  } else {
    messages.push(message);
  }
  renderMessage(message);
  renderAskBar();
  renderWelcome();
  scrollToBottom();
}

function renderAllMessages(): void {
  messagesEl.innerHTML = '';
  messageElements.clear();
  messages.forEach((message) => renderMessage(message));
  stickToBottom = true;
  scrollToBottom(true);
}

function renderMessage(message: UiMessage): void {
  let element = messageElements.get(message.id);
  const html = messageHtml(message);
  if (!html) {
    element?.remove();
    messageElements.delete(message.id);
    return;
  }
  if (!element) {
    element = document.createElement('div');
    element.dataset.id = message.id;
    messagesEl.appendChild(element);
    messageElements.set(message.id, element);
  }
  element.className = `row row-${message.type}${message.partial ? ' partial' : ''}${message.status ? ` status-${message.status}` : ''}`;
  element.innerHTML = html;
}

function statusIcon(message: UiMessage): string {
  switch (message.status) {
    case 'pending': return `<span class="status pending" title="Waiting for approval">${icons.dot}</span>`;
    case 'running': return `<span class="status running">${icons.spinner}</span>`;
    case 'done': return `<span class="status done" title="Done">${icons.check}</span>`;
    case 'approved': return message.ask?.autoApproved ? '<span class="status auto" title="Auto-approved">auto</span>' : `<span class="status done">${icons.check}</span>`;
    case 'rejected': return `<span class="status rejected" title="Rejected">${icons.x}</span>`;
    case 'error': return `<span class="status error" title="Error">${icons.warning}</span>`;
    default: return '';
  }
}

function toolIcon(name: string): string {
  if (name === 'read_file') return icons.file;
  if (name === 'list_files' || name === 'list_code_definition_names') return icons.folder;
  if (name === 'search_files') return icons.search;
  if (name === 'write_to_file' || name === 'insert_content') return icons.edit;
  if (name === 'apply_diff') return icons.diff;
  if (name === 'update_todo_list') return icons.todo;
  if (name === 'switch_mode') return modeIcon(stateModeIcon(''));
  if (name === 'new_task') return icons.subtask;
  return icons.code;
}

function stateModeIcon(slug: string): string {
  return state?.modes.find((mode) => mode.slug === slug)?.icon || 'code';
}

function messageHtml(message: UiMessage): string {
  switch (message.type) {
    case 'user':
      return `<div class="user-bubble">${renderUserText(message.text || '')}</div>`;
    case 'text':
      if (!message.text?.trim()) return '';
      return `<div class="assistant markdown">${md(message.text)}${citationsHtml(message.meta?.citations)}</div>`;
    case 'reasoning': {
      const open = message.partial || expanded.has(message.id);
      return `<div class="reasoning ${open ? 'open' : ''}" data-toggle="${message.id}">
        <div class="reasoning-head">${icons.brain}<span>${message.partial ? 'Thinking…' : 'Thought'}</span>${open ? icons.chevronDown : icons.chevronRight}</div>
        ${open ? `<div class="reasoning-body markdown">${md(message.text)}</div>` : ''}
      </div>`;
    }
    case 'api_req': {
      const meta = message.meta || {};
      const detail = [
        meta.account ? escapeHtml(meta.account) : '',
        meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '',
        meta.promptChars ? `${formatNumber(meta.promptChars)} chars` : '',
        meta.followUp ? 'thread' : '',
      ].filter(Boolean).join(' · ');
      return `<div class="api-req">${message.partial ? icons.spinner : message.status === 'error' ? `<span class="error-text">${icons.warning}</span>` : icons.api}
        <span class="api-title">${message.partial ? 'API Request…' : message.status === 'error' ? 'API Request Failed' : 'API Request'}</span>
        <span class="api-model">${escapeHtml(message.text || '')}</span><span class="muted">${detail}</span></div>`;
    }
    case 'tool':
      return toolHtml(message);
    case 'command':
      return commandHtml(message);
    case 'completion':
      return `<div class="completion">
        <div class="completion-head">${icons.completion}<span>Task Completed</span></div>
        <div class="markdown">${md(message.text)}</div>
        ${message.command ? `<div class="completion-cmd"><code>${escapeHtml(message.command.command)}</code><button class="btn secondary small" data-run="${escapeHtml(message.command.command)}">${icons.terminal} Run</button></div>` : ''}
      </div>`;
    case 'followup': {
      const answered = message.ask?.resolved;
      return `<div class="followup">
        <div class="followup-head">${icons.question}<span>PerplexiCode has a question</span></div>
        <div class="markdown">${md(message.text)}</div>
        ${(message.suggestions || []).length > 0 ? `<div class="suggestions">${(message.suggestions || []).map((suggestion) =>
          `<button class="suggestion" ${answered ? 'disabled' : ''} data-suggest="${escapeHtml(suggestion.text)}" data-ask="${message.id}">${escapeHtml(suggestion.text)}${suggestion.mode ? `<span class="mode-chip">${escapeHtml(suggestion.mode)}</span>` : ''}</button>`).join('')}</div>` : ''}
      </div>`;
    }
    case 'error':
      return `<div class="notice error">${icons.warning}<div class="markdown">${md(message.text)}</div></div>`;
    case 'info':
      return `<div class="notice info">${icons.info}<div>${escapeHtml(message.text || '')}</div></div>`;
    case 'checkpoint':
      return `<div class="checkpoint ${message.checkpoint?.restored ? 'restored' : ''}">
        <span class="line"></span>${icons.checkpoint}<span>Checkpoint #${message.checkpoint?.seq}</span>
        <span class="muted path" data-file="${escapeHtml(message.text || '')}">${escapeHtml(message.text || '')}</span>
        ${message.checkpoint?.restored ? '<span class="muted">restored</span>' : `<button class="btn ghost small" data-restore="${message.checkpoint?.seq}" title="Revert all file changes made after this point">${icons.restore} Restore</button>`}
        <span class="line"></span></div>`;
    case 'subtask':
      return `<div class="tool-card subtask">
        <div class="tool-head">${icons.subtask}<span class="tool-title">Subtask in ${escapeHtml(message.tool?.title || '')} mode</span>${statusIcon(message)}</div>
        <div class="tool-body markdown">${md(message.text)}</div>
        ${message.tool?.content ? `<div class="subtask-result"><div class="label">Result</div><div class="markdown">${md(message.tool.content)}</div></div>` : ''}
      </div>`;
    default:
      return '';
  }
}

function renderUserText(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/(^|\s)(@\/[^\s]+|@problems|@git-changes|@selection)/g, '$1<span class="mention">$2</span>')
    .replace(/\n/g, '<br>');
}

function citationsHtml(citations?: string[]): string {
  if (!citations || citations.length === 0) return '';
  return `<div class="citations">${citations.slice(0, 8).map((url, index) => {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
    return `<a href="#" data-url="${escapeHtml(url)}" title="${escapeHtml(url)}">${index + 1}. ${escapeHtml(host)}</a>`;
  }).join('')}</div>`;
}

function toolHtml(message: UiMessage): string {
  const tool = message.tool!;
  const isEdit = Boolean(tool.diff);
  const open = message.status === 'pending' ? !collapsed.has(message.id) : expanded.has(message.id);
  const pathHtml = tool.path ? `<span class="tool-path" data-file="${escapeHtml(tool.path)}">${escapeHtml(tool.path)}</span>` : '';
  const stats = isEdit ? `<span class="diff-stats"><span class="add">+${tool.added || 0}</span> <span class="del">-${tool.removed || 0}</span></span>` : '';
  const verb = toolVerb(tool, message);
  let body = '';
  if (open) {
    if (tool.diff) {
      body = `<div class="diff">${tool.diff.map((line) =>
        `<div class="diff-line ${line.type === '+' ? 'add' : line.type === '-' ? 'del' : line.type === '@' ? 'hunk' : ''}"><span class="sign">${line.type === ' ' ? '' : escapeHtml(line.type === '@' ? '' : line.type)}</span><span>${escapeHtml(line.text) || ' '}</span></div>`).join('')}</div>`;
    } else if (tool.name === 'update_todo_list' && tool.content) {
      body = `<div class="todo-inline">${tool.content.split('\n').map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>`;
    } else if (tool.content) {
      body = `<pre class="tool-output">${escapeHtml(tool.content)}</pre>`;
    } else if (tool.reason) {
      body = `<div class="tool-body">${escapeHtml(tool.reason)}</div>`;
    }
  }
  const canExpand = Boolean(tool.diff || tool.content || tool.reason);
  return `<div class="tool-card ${isEdit ? 'edit' : ''}">
    <div class="tool-head" ${canExpand ? `data-toggle-tool="${message.id}"` : ''}>
      ${toolIcon(tool.name)}<span class="tool-title">${escapeHtml(verb)}</span>${pathHtml}${stats}
      ${tool.outsideWorkspace ? '<span class="badge warn">outside workspace</span>' : ''}
      <span class="spacer"></span>${statusIcon(message)}${canExpand ? (open ? icons.chevronDown : icons.chevronRight) : ''}
    </div>
    ${body}
  </div>`;
}

function toolVerb(tool: NonNullable<UiMessage['tool']>, message: UiMessage): string {
  const pending = message.status === 'pending';
  switch (tool.name) {
    case 'read_file': return pending ? 'PerplexiCode wants to read' : 'Read';
    case 'list_files': return pending ? 'PerplexiCode wants to list files in' : 'Listed';
    case 'search_files': return `${pending ? 'Wants to search' : 'Searched'} /${tool.title.match(/\/(.*)\//)?.[1] || ''}/ in`;
    case 'list_code_definition_names': return pending ? 'Wants to list definitions in' : 'Definitions in';
    case 'write_to_file': return tool.isNewFile ? (pending ? 'PerplexiCode wants to create' : 'Created') : (pending ? 'PerplexiCode wants to rewrite' : 'Rewrote');
    case 'apply_diff': return message.status === 'error' ? 'Edit failed' : pending ? 'PerplexiCode wants to edit' : 'Edited';
    case 'insert_content': return pending ? 'PerplexiCode wants to insert into' : 'Inserted into';
    case 'switch_mode': return tool.title + (tool.mode ? '' : '');
    case 'new_task': return tool.title;
    default: return tool.title;
  }
}

function commandHtml(message: UiMessage): string {
  const command = message.command!;
  const open = command.running || message.status === 'pending' || expanded.has(message.id) || (command.exitCode !== undefined && command.exitCode !== 0 && !collapsed.has(message.id));
  return `<div class="tool-card command">
    <div class="tool-head" data-toggle-tool="${message.id}">${icons.terminal}<span class="tool-title">${message.status === 'pending' ? 'PerplexiCode wants to run' : 'Command'}</span>
      ${command.cwd ? `<span class="muted">in ${escapeHtml(command.cwd)}</span>` : ''}<span class="spacer"></span>
      ${command.exitCode !== undefined && command.exitCode !== null && !command.running ? `<span class="exit ${command.exitCode === 0 ? 'ok' : 'fail'}">exit ${command.exitCode}</span>` : ''}
      ${statusIcon(message)}${command.output ? (open ? icons.chevronDown : icons.chevronRight) : ''}</div>
    <pre class="command-line"><code>$ ${escapeHtml(command.command)}</code></pre>
    ${open && command.output ? `<pre class="tool-output terminal">${escapeHtml(command.output)}</pre>` : ''}
  </div>`;
}

function scrollToBottom(force = false): void {
  if (!force && !stickToBottom) return;
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

messagesEl.addEventListener('scroll', () => {
  stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
});

// -------------------------------------------------------------------------------------------------
// Task header, todos, welcome
// -------------------------------------------------------------------------------------------------

function renderTaskHeader(): void {
  const el = $('task-header');
  const task = state?.task;
  if (!task) {
    el.innerHTML = '';
    el.className = '';
    return;
  }
  el.className = 'task-header';
  const todos = task.todos || [];
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress');
  const modeName = state!.modes.find((mode) => mode.slug === task.mode)?.name || task.mode;
  el.innerHTML = `
    ${task.depth > 0 ? `<div class="subtask-banner">${icons.subtask}<span>Subtask of: ${escapeHtml(task.parentTitle || 'parent task')}</span></div>` : ''}
    <div class="task-title-row">
      <button class="task-title ${titleExpanded ? 'expanded' : ''}" id="task-title-toggle"><span class="task-label">Task:</span> ${escapeHtml(task.title || 'New task')}</button>
      <button class="icon-btn" id="task-export" title="Export task as Markdown">${icons.export}</button>
      <button class="icon-btn" id="task-close" title="Close task (start new)">${icons.x}</button>
    </div>
    <div class="task-meta">
      <span class="chip">${modeIcon(stateModeIcon(task.mode))}${escapeHtml(modeName)}</span>
      <span class="chip">${task.status.requestCount} requests</span>
      <span class="chip state-${task.status.state}">${escapeHtml(stateLabel(task.status.state, task.busy))}</span>
    </div>
    ${todos.length > 0 ? `
      <div class="todos ${todosOpen ? 'open' : ''}">
        <button class="todos-head" id="todos-toggle">${icons.todo}<span>${current ? escapeHtml(current.text) : `Todo list`}</span><span class="spacer"></span><span class="muted">${done}/${todos.length}</span>${todosOpen ? icons.chevronDown : icons.chevronRight}</button>
        <div class="progress"><div style="width:${todos.length ? Math.round((done / todos.length) * 100) : 0}%"></div></div>
        ${todosOpen ? `<ul class="todo-list">${todos.map((todo) => `<li class="todo ${todo.status}"><span class="box">${todo.status === 'completed' ? icons.check : todo.status === 'in_progress' ? icons.dot : ''}</span>${escapeHtml(todo.text)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}`;
}

function stateLabel(stateName: string, busy: boolean): string {
  if (busy && stateName === 'running') return 'Running';
  switch (stateName) {
    case 'waiting': return 'Waiting for you';
    case 'completed': return 'Completed';
    case 'aborted': return 'Stopped';
    case 'error': return 'Error';
    case 'running': return 'Running';
    default: return 'Ready';
  }
}

function renderWelcome(): void {
  const el = $('welcome');
  if (!state || state.task || messages.length > 0) {
    el.innerHTML = '';
    el.classList.add('hidden');
    messagesEl.classList.remove('hidden');
    return;
  }
  messagesEl.classList.add('hidden');
  el.classList.remove('hidden');
  const recent = state.history.slice(0, 3);
  const noAccounts = state.accounts.length === 0;
  el.innerHTML = `
    <div class="hero">
      <div class="logo">${BRAND_MARK}</div>
      <h2>PerplexiCode Kilo</h2>
      <p class="muted">Kilo-style coding agent powered by your Perplexity subscription. Plan, write and debug code with ${state.models.filter((model) => model.surfaced).length} Perplexity models.</p>
      ${noAccounts ? `<div class="notice warn">${icons.key}<div>No Perplexity account connected.<br><button class="btn primary small" data-action="addAccount">Add account</button></div></div>` : ''}
      ${!state.workspace ? `<div class="notice info">${icons.folder}<div>Open a folder to let the agent read and edit files.</div></div>` : ''}
    </div>
    <div class="tips">
      ${state.modes.map((mode) => `<button class="tip ${state!.mode === mode.slug ? 'active' : ''}" data-mode="${mode.slug}">${modeIcon(mode.icon)}<div><b>${escapeHtml(mode.name)}</b><span>${escapeHtml(mode.description)}</span></div></button>`).join('')}
    </div>
    ${recent.length > 0 ? `<div class="recent"><div class="section-title">Recent tasks<button class="link" data-action="history">View all</button></div>${recent.map(historyItemHtml).join('')}</div>` : ''}`;
}

// -------------------------------------------------------------------------------------------------
// Ask bar (approve / reject buttons) and auto-approve
// -------------------------------------------------------------------------------------------------

function pendingAsk(): UiMessage | undefined {
  const askId = state?.task?.status.askId;
  if (askId) {
    const byId = messages.find((message) => message.id === askId);
    if (byId && byId.ask && !byId.ask.resolved) return byId;
  }
  return [...messages].reverse().find((message) => message.ask && !message.ask.resolved);
}

function renderAskBar(): void {
  const el = $('ask-bar');
  const task = state?.task;
  const ask = pendingAsk();
  let buttons = '';
  if (ask?.ask) {
    const kind = ask.ask.kind;
    const isEdit = Boolean(ask.tool?.diff);
    const labels: Record<string, [string, string | null]> = {
      tool: isEdit ? ['Save', 'Reject'] : ['Approve', 'Reject'],
      command: ['Run Command', 'Reject'],
      followup: ['', null],
      completion_result: ['Start New Task', null],
      mode_switch: ['Approve', 'Reject'],
      new_task: ['Approve', 'Reject'],
      request_limit: ['Continue', 'Stop'],
      mistake_limit: ['Proceed Anyways', 'Start New Task'],
      api_failed: ['Retry', 'Start New Task'],
      resume_task: ['Resume Task', null],
    };
    const [primary, secondary] = labels[kind] || ['Approve', 'Reject'];
    buttons = `${primary ? `<button class="btn primary" data-ask-primary="${ask.id}" data-kind="${kind}">${primary}</button>` : ''}${secondary ? `<button class="btn secondary" data-ask-secondary="${ask.id}" data-kind="${kind}">${secondary}</button>` : ''}`;
  } else if (task?.busy) {
    buttons = `<button class="btn secondary" data-action="abort">${icons.stop} Cancel</button>`;
  } else if (task && (task.status.state === 'aborted' || task.status.state === 'error')) {
    buttons = '<button class="btn secondary" data-action="resume">Resume Task</button><button class="btn ghost" data-action="clearTask">Start New Task</button>';
  } else if (task && task.status.state === 'completed') {
    buttons = '<button class="btn primary" data-action="clearTask">Start New Task</button>';
  }
  el.innerHTML = buttons;
  el.classList.toggle('hidden', !buttons);
}

const AUTO_APPROVE_ITEMS: Array<[string, string, string]> = [
  ['read', 'Read', 'Read files and directories in the workspace'],
  ['write', 'Edit', 'Create and edit files without asking'],
  ['execute', 'Commands', 'Run allowed terminal commands (see Settings)'],
  ['modeSwitch', 'Modes', 'Switch modes'],
  ['subtasks', 'Subtasks', 'Create and complete subtasks'],
  ['retry', 'Retry', 'Retry failed requests automatically'],
  ['readOutsideWorkspace', 'Outside reads', 'Read files outside the workspace'],
];

function renderAutoApprove(): void {
  const el = $('auto-approve');
  if (!state) return;
  const auto = state.settings.autoApprove;
  const enabledNames = AUTO_APPROVE_ITEMS.filter(([key]) => auto[key]).map(([, label]) => label);
  el.innerHTML = `
    <div class="aa-head">
      <label class="switch small" title="Enable auto-approve"><input type="checkbox" data-setting="autoApprove.enabled" ${auto.enabled ? 'checked' : ''}><span></span></label>
      <button class="aa-toggle" id="aa-toggle"><span>Auto-approve:</span> <span class="muted">${auto.enabled ? (enabledNames.join(', ') || 'None') : 'Off'}</span>${autoApproveOpen ? icons.chevronDown : icons.chevronRight}</button>
    </div>
    ${autoApproveOpen ? `<div class="aa-body">${AUTO_APPROVE_ITEMS.map(([key, label, description]) => `
      <label class="aa-item" title="${escapeHtml(description)}"><input type="checkbox" data-setting="autoApprove.${key}" ${auto[key] ? 'checked' : ''}> ${escapeHtml(label)}</label>`).join('')}
      <div class="aa-note muted">Allowed commands: ${state.settings.allowedCommands.length ? state.settings.allowedCommands.map((command: string) => `<code>${escapeHtml(command)}</code>`).join(' ') : 'none'} · <button class="link" data-action="settings-commands">edit</button></div>
    </div>` : ''}`;
}

// -------------------------------------------------------------------------------------------------
// Composer: mode selector, model picker, web toggle, send
// -------------------------------------------------------------------------------------------------

function renderComposer(): void {
  if (!state) return;
  const mode = state.modes.find((entry) => entry.slug === state!.mode) || state.modes[0];
  $('mode-btn').innerHTML = `${modeIcon(mode.icon)}<span>${escapeHtml(mode.name)}</span>${icons.chevronDown}`;
  const model = state.models.find((entry) => entry.id === state!.selection.modelId);
  $('model-btn').innerHTML = `${providerIcon(model?.provider, state.selection.modelId)}<span class="ellipsis">${escapeHtml(state.selection.modelLabel)}</span>${model?.requiredPlan === 'max' ? '<span class="badge max">Max</span>' : ''}${icons.chevronDown}`;
  const webOn = state.selection.webSearch === null ? state.selection.modeWebSearchDefault && state.settings.webSearch !== 'never' || state.settings.webSearch === 'always' : state.selection.webSearch;
  const webBtn = $('web-btn');
  webBtn.innerHTML = icons.globe + (state.selection.webSearch === null ? '<span class="auto-dot"></span>' : '');
  webBtn.classList.toggle('on', Boolean(webOn));
  webBtn.title = `Web search: ${state.selection.webSearch === null ? `auto (${webOn ? 'on' : 'off'} for this mode)` : webOn ? 'on' : 'off'} — click to change`;
  const enhanceBtn = $('enhance-btn');
  enhanceBtn.innerHTML = enhancing ? icons.spinner : icons.sparkle;
  const task = state.task;
  const busy = Boolean(task?.busy && task.status.state !== 'waiting');
  const sendBtn = $('send-btn');
  sendBtn.innerHTML = busy ? icons.stop : icons.send;
  sendBtn.title = busy ? 'Stop' : 'Send (Enter)';
  sendBtn.classList.toggle('stop', busy);
  input.placeholder = task
    ? (pendingAsk()?.ask?.kind === 'followup' ? 'Type your answer…' : busy ? 'PerplexiCode is working…' : 'Type a message… (@ to add context)')
    : 'Type your task here… (@ to add context, / for commands, Shift+Enter for new line)';
  renderModeMenu();
  renderModelMenu();
}

function renderModeMenu(): void {
  const menu = $('mode-menu');
  menu.classList.toggle('hidden', !modeMenuOpen);
  if (!modeMenuOpen || !state) return;
  menu.innerHTML = state.modes.map((mode) => `
    <button class="menu-item ${mode.slug === state!.mode ? 'selected' : ''}" data-mode="${mode.slug}">
      ${modeIcon(mode.icon)}<div class="menu-text"><b>${escapeHtml(mode.name)}</b><span>${escapeHtml(mode.description)}</span></div>
      ${mode.slug === state!.mode ? `<span class="check">${icons.check}</span>` : ''}
    </button>`).join('') + '<div class="menu-foot muted">⌘. next mode · ⌘⇧. previous</div>';
}

function renderModelMenu(): void {
  const menu = $('model-menu');
  menu.classList.toggle('hidden', !modelMenuOpen);
  if (!modelMenuOpen || !state) return;
  const selected = state.selection.modelId;
  const surfaced = state.models.filter((model) => model.surfaced);
  const more = state.models.filter((model) => !model.surfaced);
  const item = (model: ModelEntry) => {
    const isSelected = model.id === selected;
    return `
      <button class="menu-item model-item ${isSelected ? 'selected' : ''} ${model.selectable ? '' : 'locked'}" data-model="${model.id}" title="${escapeHtml(model.description)}">
        ${providerIcon(model.provider, model.id)}<span class="model-name">${escapeHtml(model.label)}</span>
        ${model.isNew ? '<span class="badge new">New</span>' : ''}${model.requiredPlan === 'max' ? '<span class="badge max">Max</span>' : ''}
        ${model.selectable ? '' : '<span class="badge lock" title="Not available on your plan">locked</span>'}
        <span class="spacer"></span>${isSelected ? `<span class="check">${icons.check}</span>` : ''}
      </button>
      ${isSelected && model.supportsThinking ? `
        <label class="menu-item thinking-row"><span>Thinking</span><span class="spacer"></span>
          <span class="switch"><input type="checkbox" id="thinking-toggle" ${state!.selection.thinking ? 'checked' : ''}><span></span></span></label>` : ''}`;
  };
  menu.innerHTML = `${surfaced.map(item).join('')}
    ${more.length > 0 ? `<button class="menu-item more-toggle" id="more-models">${icons.more}<span>More models</span><span class="spacer"></span><span class="muted">${more.length}</span>${showMoreModels ? icons.chevronDown : icons.chevronRight}</button>
    ${showMoreModels ? `<div class="more-models">${more.map(item).join('')}</div>` : ''}` : ''}
    <div class="menu-foot muted">Model list snapshot ${escapeHtml(state.general.modelsSnapshot)} · <button class="link" data-action="refreshAccounts">refresh</button></div>`;
}

function cycleWebSearch(): void {
  if (!state) return;
  const current = state.selection.webSearch;
  const next = current === null ? true : current === true ? false : null;
  post({ type: 'setWebSearch', value: next });
  showToast(`Web search: ${next === null ? 'auto' : next ? 'on' : 'off'}`);
}

function send(): void {
  if (!state) return;
  const text = input.value.trim();
  const task = state.task;
  const busy = Boolean(task?.busy && task.status.state !== 'waiting');
  if (busy) {
    post({ type: 'abort' });
    return;
  }
  if (!text) return;
  if (text.startsWith('/') && handleSlash(text)) {
    return;
  }
  post({ type: 'sendMessage', text });
  input.value = '';
  saveDraft();
  autoResize();
  stickToBottom = true;
}

const SLASH_COMMANDS = () => [
  ...(state?.modes || []).map((mode) => ({ label: `/${mode.slug}`, value: `mode:${mode.slug}`, description: `Switch to ${mode.name} mode` })),
  { label: '/newtask', value: 'newtask', description: 'Start a new task with the following text' },
  { label: '/history', value: 'history', description: 'Open task history' },
  { label: '/settings', value: 'settings', description: 'Open settings' },
  { label: '/web', value: 'web', description: 'Toggle web search (auto → on → off)' },
];

function handleSlash(text: string): boolean {
  const [command, ...rest] = text.split(/\s+/);
  const restText = text.slice(command.length).trim();
  const entry = SLASH_COMMANDS().find((item) => item.label === command);
  if (!entry) return false;
  applySlash(entry.value, restText);
  void rest;
  return true;
}

function applySlash(value: string, restText = ''): void {
  if (value.startsWith('mode:')) {
    post({ type: 'setMode', mode: value.slice(5) });
    input.value = restText;
  } else if (value === 'newtask') {
    post({ type: 'clearTask' });
    if (restText) {
      setTimeout(() => post({ type: 'sendMessage', text: restText }), 50);
    }
    input.value = '';
  } else if (value === 'history') {
    setView('history');
    input.value = '';
  } else if (value === 'settings') {
    setView('settings');
    input.value = '';
  } else if (value === 'web') {
    cycleWebSearch();
    input.value = restText;
  }
  saveDraft();
  autoResize();
}

// -------------------------------------------------------------------------------------------------
// @ mentions and / popup
// -------------------------------------------------------------------------------------------------

function updatePopups(): void {
  const value = input.value;
  const caret = input.selectionStart || 0;
  const before = value.slice(0, caret);
  const slashMatch = /^\/(\w*)$/.exec(before);
  if (slashMatch) {
    const query = slashMatch[1].toLowerCase();
    slashState = { items: SLASH_COMMANDS().filter((item) => item.label.slice(1).startsWith(query)), index: 0 };
    mentionState = undefined;
    renderPopup();
    return;
  }
  slashState = undefined;
  const mentionMatch = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mentionMatch) {
    const query = mentionMatch[2].replace(/^\//, '');
    const start = caret - mentionMatch[2].length - 1;
    if (!mentionState || mentionState.query !== query) {
      mentionState = { start, query, items: mentionState?.items || [], index: 0 };
      post({ type: 'searchMentions', query });
    }
    renderPopup();
    return;
  }
  mentionState = undefined;
  renderPopup();
}

function renderPopup(): void {
  const popup = $('popup');
  if (slashState && slashState.items.length > 0) {
    popup.innerHTML = slashState.items.map((item, index) => `<button class="popup-item ${index === slashState!.index ? 'active' : ''}" data-slash="${item.value}">${icons.slash}<b>${escapeHtml(item.label)}</b><span class="muted">${escapeHtml(item.description)}</span></button>`).join('');
    popup.classList.remove('hidden');
    return;
  }
  if (mentionState && mentionState.items.length > 0) {
    popup.innerHTML = mentionState.items.map((item, index) => `<button class="popup-item ${index === mentionState!.index ? 'active' : ''}" data-mention="${escapeHtml(item.value)}">${item.kind === 'file' ? icons.file : icons.at}<span class="ellipsis">${escapeHtml(item.label)}</span></button>`).join('');
    popup.classList.remove('hidden');
    return;
  }
  popup.classList.add('hidden');
  popup.innerHTML = '';
}

function insertMention(value: string): void {
  if (!mentionState) return;
  const caret = input.selectionStart || 0;
  const before = input.value.slice(0, mentionState.start);
  const after = input.value.slice(caret);
  input.value = `${before}${value} ${after}`;
  const position = before.length + value.length + 1;
  input.setSelectionRange(position, position);
  mentionState = undefined;
  renderPopup();
  saveDraft();
  input.focus();
}

// -------------------------------------------------------------------------------------------------
// History view
// -------------------------------------------------------------------------------------------------

function historyItemHtml(item: AppState['history'][number]): string {
  const date = new Date(item.ts);
  const mode = state?.modes.find((entry) => entry.slug === item.mode);
  return `<div class="history-item" data-open-task="${item.id}">
    <div class="history-top"><span class="muted">${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="spacer"></span><span class="chip">${modeIcon(mode?.icon || 'code')}${escapeHtml(mode?.name || item.mode)}</span>
      <button class="icon-btn" data-export-task="${item.id}" title="Export">${icons.export}</button>
      <button class="icon-btn" data-delete-task="${item.id}" title="Delete">${icons.trash}</button></div>
    <div class="history-title">${escapeHtml(item.title)}</div>
    <div class="muted small">${escapeHtml(item.workspace.split(/[\\/]/).pop() || '')} · ${item.requestCount} requests · ${escapeHtml(item.status)}</div>
  </div>`;
}

function renderHistory(): void {
  const el = $('view-history');
  const items = (state?.history || []).filter((item) => !historyQuery || item.title.toLowerCase().includes(historyQuery.toLowerCase()));
  el.innerHTML = `
    <div class="view-header"><button class="icon-btn" data-action="chat">${icons.chevronLeft}</button><h3>History</h3><span class="spacer"></span>
      <button class="btn ghost small" data-action="clearHistory">${icons.trash} Clear</button><button class="btn primary small" data-action="chat">Done</button></div>
    <div class="view-body">
      <input class="search" id="history-search" placeholder="Search history…" value="${escapeHtml(historyQuery)}">
      ${items.length === 0 ? '<div class="empty muted">No tasks yet.</div>' : items.map(historyItemHtml).join('')}
    </div>`;
}

// -------------------------------------------------------------------------------------------------
// Settings view
// -------------------------------------------------------------------------------------------------

const SETTINGS_TABS: Array<[string, string, string]> = [
  ['accounts', 'Accounts', icons.account],
  ['models', 'Models', icons.sparkle],
  ['autoApprove', 'Auto-Approve', icons.check],
  ['commands', 'Terminal', icons.terminal],
  ['context', 'Context', icons.file],
  ['prompts', 'Prompts', icons.edit],
  ['about', 'About', icons.info],
];

function renderSettings(): void {
  const el = $('view-settings');
  if (!state) return;
  const s = state.settings;
  const field = (key: string, label: string, description: string, control: string) =>
    `<div class="field"><div class="field-label"><b>${escapeHtml(label)}</b><span class="muted">${escapeHtml(description)}</span></div>${control}</div>`;
  const checkbox = (key: string, value: boolean) => `<label class="switch"><input type="checkbox" data-setting="${key}" ${value ? 'checked' : ''}><span></span></label>`;
  const number = (key: string, value: number, min: number, max: number) => `<input type="number" class="num" data-setting-number="${key}" value="${value}" min="${min}" max="${max}">`;
  const select = (key: string, value: string, options: Array<[string, string]>) => `<select data-setting-select="${key}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>`;

  let body = '';
  switch (settingsTab) {
    case 'accounts':
      body = `
        <div class="section-title">Perplexity accounts<span class="spacer"></span><button class="btn ghost small" data-action="refreshAccounts">${icons.refresh} Refresh</button><button class="btn primary small" data-action="addAccount">${icons.plus} Add</button></div>
        <p class="muted small">Sessions are stored in the editor's secure storage. Accounts from PerplexiCode 1.x are migrated automatically.</p>
        ${state.accounts.length === 0 ? '<div class="empty muted">No accounts yet.</div>' : state.accounts.map((account) => `
          <div class="account-card status-${account.status}">
            <div class="account-top">${icons.account}<b>${escapeHtml(account.alias)}</b><span class="badge ${account.plan === 'max' ? 'max' : ''}">${escapeHtml(account.plan)}</span><span class="badge state">${escapeHtml(account.status.replace('_', ' '))}</span><span class="spacer"></span>
              <button class="icon-btn" data-toggle-account="${account.id}" title="${account.status === 'disabled' ? 'Enable' : 'Disable'}">${account.status === 'disabled' ? icons.check : icons.x}</button>
              <button class="icon-btn" data-remove-account="${account.id}" title="Remove">${icons.trash}</button></div>
            ${account.email ? `<div class="muted small">${escapeHtml(account.email)}</div>` : ''}
            <div class="quota-grid">
              <span>Pro searches</span><b>${escapeHtml(account.quotas.pro)}</b>
              <span>Research</span><b>${escapeHtml(account.quotas.research)}</b>
              <span>Labs</span><b>${escapeHtml(account.quotas.labs)}</b>
              <span>Today / total</span><b>${account.queriesToday} / ${account.queriesTotal}</b>
            </div>
          </div>`).join('')}
        <button class="btn ghost small" data-action="manageAccounts">${icons.gear} Manage (refresh session, re-login)…</button>
        ${field('', 'Rotation strategy', 'How requests are distributed across accounts', `<select data-rotation>${[['round-robin', 'Round robin'], ['least-used', 'Least used'], ['failover-only', 'Failover only']].map(([v, l]) => `<option value="${v}" ${state!.general.rotationStrategy === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}`;
      break;
    case 'models':
      body = `
        ${field('root.subscriptionPlan', 'Subscription plan', 'Auto-detect from the account, or force Max to unlock Max-only models when detection fails', select('root.subscriptionPlan', state.general.subscriptionPlan, [['auto', 'Auto-detect'], ['pro', 'Pro'], ['max', 'Max']]))}
        ${field('webSearch', 'Web search', 'Auto: on for Ask/Architect, off for coding modes. The globe button overrides it per session.', select('webSearch', s.webSearch, [['auto', 'Auto (per mode)'], ['always', 'Always'], ['never', 'Never']]))}
        <div class="section-title">Available models (${state.models.length})</div>
        <div class="model-table">${state.models.map((model) => `<div class="model-row ${model.selectable ? '' : 'locked'}">${providerIcon(model.provider, model.id)}<span>${escapeHtml(model.label)}</span>${model.requiredPlan === 'max' ? '<span class="badge max">Max</span>' : ''}${model.supportsThinking ? '<span class="badge">Thinking</span>' : ''}<span class="spacer"></span><code class="muted">${escapeHtml(model.id)}</code></div>`).join('')}</div>`;
      break;
    case 'autoApprove':
      body = `
        ${field('autoApprove.enabled', 'Enable auto-approve', 'Master switch for every rule below', checkbox('autoApprove.enabled', s.autoApprove.enabled))}
        ${AUTO_APPROVE_ITEMS.map(([key, label, description]) => field(`autoApprove.${key}`, label, description, checkbox(`autoApprove.${key}`, s.autoApprove[key]))).join('')}
        ${field('maxRequestsPerTask', 'Max requests', 'Ask before continuing after this many consecutive requests', number('maxRequestsPerTask', s.maxRequests, 1, 500))}`;
      break;
    case 'commands':
      body = `
        ${field('autoApprove.execute', 'Auto-approve commands', 'Run commands matching the allowed list without asking', checkbox('autoApprove.execute', s.autoApprove.execute))}
        <div class="field column"><div class="field-label"><b>Allowed command prefixes</b><span class="muted">One per line, for example "npm test" or "git status". "*" allows everything.</span></div>
          <textarea class="setting-text" data-setting-list="allowedCommands" rows="5">${escapeHtml(s.allowedCommands.join('\n'))}</textarea></div>
        <div class="field column"><div class="field-label"><b>Denied command prefixes</b><span class="muted">Always ask for these, even if allowed.</span></div>
          <textarea class="setting-text" data-setting-list="deniedCommands" rows="3">${escapeHtml(s.deniedCommands.join('\n'))}</textarea></div>
        ${field('commandTimeoutSeconds', 'Command timeout (s)', '0 disables the timeout', number('commandTimeoutSeconds', s.commandTimeoutSec, 0, 3600))}
        ${field('terminalOutputLineLimit', 'Output line limit', 'Lines of command output sent to the model', number('terminalOutputLineLimit', s.terminalOutputLines, 20, 5000))}`;
      break;
    case 'context':
      body = `
        ${field('contextStrategy', 'Context strategy', 'Auto: resend the full task while it fits, then continue the Perplexity thread. Full: always resend. Thread: always use follow-ups.', select('contextStrategy', s.contextStrategy, [['auto', 'Auto'], ['full', 'Always full prompt'], ['thread', 'Perplexity thread follow-ups']]))}
        ${field('maxPromptChars', 'Max prompt size (chars)', 'Older messages are dropped from the middle when the prompt is larger', number('maxPromptChars', s.maxPromptChars, 8000, 400000))}
        ${field('maxReadFileLines', 'Max lines per file read', 'Larger files are truncated; the model can read ranges', number('maxReadFileLines', s.maxReadLines, 50, 20000))}
        ${field('includeFileListOnStart', 'Include file list', 'Send the workspace file list with the first message', checkbox('includeFileListOnStart', s.includeFileListOnStart))}
        ${field('diffEnabled', 'Diff edits', 'Let the model use apply_diff (targeted SEARCH/REPLACE edits)', checkbox('diffEnabled', s.diffEnabled))}
        ${field('revealEditedFiles', 'Reveal edited files', 'Open files in the editor when the agent changes them', checkbox('revealEditedFiles', state.general.revealEditedFiles))}`;
      break;
    case 'prompts':
      body = `
        ${field('language', 'Language', 'Language for replies (auto = same as your message)', `<input class="text" data-setting-text="language" value="${escapeHtml(s.language)}">`)}
        <div class="field column"><div class="field-label"><b>Custom instructions for all modes</b><span class="muted">Also read from AGENTS.md, .kilocode/rules/, .perplexicode/rules/, .roo/rules/ and .clinerules in the workspace.</span></div>
          <textarea class="setting-text" data-setting-text="customInstructions" rows="5">${escapeHtml(s.customInstructions)}</textarea></div>
        ${state.modes.map((mode) => `<div class="field column"><div class="field-label"><b>${escapeHtml(mode.name)} mode instructions</b></div>
          <textarea class="setting-text" data-mode-instructions="${mode.slug}" rows="3">${escapeHtml(s.modeInstructions[mode.slug] || '')}</textarea></div>`).join('')}`;
      break;
    default:
      body = `
        <div class="about"><div class="logo">${BRAND_MARK}</div><h3>PerplexiCode Kilo ${escapeHtml(state.version)}</h3>
        <p class="muted">Kilo Code-style agent for Perplexity. Fork of yuki-20/PerplexiCode.</p>
        <p class="muted small">Model snapshot: ${escapeHtml(state.general.modelsSnapshot)} · ${state.models.length} models</p>
        <button class="btn ghost small" data-action="openSettingsJson">${icons.gear} Open all settings</button></div>`;
  }
  el.innerHTML = `
    <div class="view-header"><button class="icon-btn" data-action="chat">${icons.chevronLeft}</button><h3>Settings</h3><span class="spacer"></span><button class="btn primary small" data-action="chat">Done</button></div>
    <div class="settings-layout">
      <nav class="settings-tabs">${SETTINGS_TABS.map(([id, label, icon]) => `<button class="tab ${settingsTab === id ? 'active' : ''}" data-tab="${id}">${icon}<span>${label}</span></button>`).join('')}</nav>
      <div class="settings-body">${body}</div>
    </div>`;
}

function setView(next: 'chat' | 'history' | 'settings'): void {
  view = next;
  $('view-chat').classList.toggle('hidden', view !== 'chat');
  $('view-history').classList.toggle('hidden', view !== 'history');
  $('view-settings').classList.toggle('hidden', view !== 'settings');
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'chat') input.focus();
}

// -------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest('[data-action],[data-mode],[data-model],[data-toggle],[data-toggle-tool],[data-copy],[data-insert],[data-url],[data-file],[data-restore],[data-suggest],[data-ask-primary],[data-ask-secondary],[data-open-task],[data-delete-task],[data-export-task],[data-tab],[data-slash],[data-mention],[data-remove-account],[data-toggle-account],[data-run],#more-models,#mode-btn,#model-btn,#web-btn,#enhance-btn,#send-btn,#task-title-toggle,#task-export,#task-close,#todos-toggle,#aa-toggle') as HTMLElement | null;

  if (!target.closest('#model-menu') && !target.closest('#model-btn') && modelMenuOpen) {
    modelMenuOpen = false;
    renderModelMenu();
  }
  if (!target.closest('#mode-menu') && !target.closest('#mode-btn') && modeMenuOpen) {
    modeMenuOpen = false;
    renderModeMenu();
  }
  if (!el) return;
  const data = el.dataset;

  if (el.id === 'mode-btn') { modeMenuOpen = !modeMenuOpen; modelMenuOpen = false; renderComposer(); return; }
  if (el.id === 'model-btn') { modelMenuOpen = !modelMenuOpen; modeMenuOpen = false; renderComposer(); return; }
  if (el.id === 'more-models') { showMoreModels = !showMoreModels; renderModelMenu(); return; }
  if (el.id === 'web-btn') { cycleWebSearch(); return; }
  if (el.id === 'enhance-btn') {
    if (!input.value.trim() || enhancing) return;
    enhancing = true;
    renderComposer();
    post({ type: 'enhancePrompt', text: input.value });
    return;
  }
  if (el.id === 'send-btn') { send(); return; }
  if (el.id === 'task-title-toggle') { titleExpanded = !titleExpanded; renderTaskHeader(); return; }
  if (el.id === 'task-export') { post({ type: 'exportTask', id: state?.task?.id }); return; }
  if (el.id === 'task-close') { post({ type: 'clearTask' }); return; }
  if (el.id === 'todos-toggle') { todosOpen = !todosOpen; renderTaskHeader(); return; }
  if (el.id === 'aa-toggle') { autoApproveOpen = !autoApproveOpen; renderAutoApprove(); return; }

  if (data.mode && !el.closest('.suggestions')) {
    post({ type: 'setMode', mode: data.mode });
    modeMenuOpen = false;
    renderModeMenu();
    return;
  }
  if (data.model) {
    const model = state?.models.find((entry) => entry.id === data.model);
    if (model && !model.selectable) {
      showToast(`${model.label} is not available on your current plan. Set Settings → Models → Subscription plan to Max if your account is Max.`);
    }
    post({ type: 'setModel', modelId: data.model, thinking: model?.supportsThinking ? state?.selection.thinking : false });
    return;
  }
  if (data.toggle) {
    expanded.has(data.toggle) ? expanded.delete(data.toggle) : expanded.add(data.toggle);
    const message = messages.find((entry) => entry.id === data.toggle);
    if (message) renderMessage(message);
    return;
  }
  if (data.toggleTool) {
    const id = data.toggleTool;
    const message = messages.find((entry) => entry.id === id);
    if (!message) return;
    const isOpen = message.status === 'pending' ? !collapsed.has(id) : (expanded.has(id) || (message.command && message.command.exitCode !== 0 && message.command.exitCode !== undefined && !collapsed.has(id)));
    if (isOpen) { expanded.delete(id); collapsed.add(id); } else { collapsed.delete(id); expanded.add(id); }
    renderMessage(message);
    return;
  }
  if (data.copy !== undefined) { post({ type: 'copy', text: data.copy }); showToast('Copied'); return; }
  if (data.insert !== undefined) { post({ type: 'insertCode', text: data.insert }); return; }
  if (data.url) { event.preventDefault(); post({ type: 'openUrl', url: data.url }); return; }
  if (data.file) { post({ type: 'openFile', path: data.file, line: data.line ? Number(data.line) : undefined }); return; }
  if (data.restore) { post({ type: 'restoreCheckpoint', seq: Number(data.restore) }); return; }
  if (data.run) { post({ type: 'runCompletionCommand', command: data.run }); return; }
  if (data.suggest !== undefined && data.ask) {
    post({ type: 'askResponse', askId: data.ask, response: 'message', text: data.suggest });
    return;
  }
  if (data.askPrimary || data.askSecondary) {
    const askId = data.askPrimary || data.askSecondary!;
    const kind = data.kind;
    const text = input.value.trim();
    const isPrimary = Boolean(data.askPrimary);
    if (kind === 'completion_result') {
      post({ type: 'askResponse', askId, response: 'yes' });
      post({ type: 'clearTask' });
    } else if ((kind === 'mistake_limit' || kind === 'api_failed') && !isPrimary) {
      post({ type: 'askResponse', askId, response: 'no' });
      post({ type: 'clearTask' });
    } else {
      post({ type: 'askResponse', askId, response: isPrimary ? 'yes' : 'no', text: text || undefined });
    }
    if (text && kind !== 'completion_result') {
      input.value = '';
      saveDraft();
      autoResize();
    }
    return;
  }
  if (data.openTask && !target.closest('[data-delete-task],[data-export-task]')) { post({ type: 'openTask', id: data.openTask }); setView('chat'); return; }
  if (data.deleteTask) { post({ type: 'deleteTask', id: data.deleteTask }); return; }
  if (data.exportTask) { post({ type: 'exportTask', id: data.exportTask }); return; }
  if (data.tab) { settingsTab = data.tab; renderSettings(); return; }
  if (data.slash) { applySlash(data.slash, ''); slashState = undefined; renderPopup(); input.focus(); return; }
  if (data.mention) { insertMention(data.mention); return; }
  if (data.removeAccount) { post({ type: 'removeAccount', id: data.removeAccount }); return; }
  if (data.toggleAccount) { post({ type: 'toggleAccount', id: data.toggleAccount }); return; }

  switch (data.action) {
    case 'addAccount': post({ type: 'addAccount' }); break;
    case 'manageAccounts': post({ type: 'manageAccounts' }); break;
    case 'refreshAccounts': post({ type: 'refreshAccounts' }); showToast('Refreshing models and quotas…'); break;
    case 'history': setView('history'); break;
    case 'chat': setView('chat'); break;
    case 'settings-commands': settingsTab = 'commands'; setView('settings'); break;
    case 'clearHistory': post({ type: 'clearHistory' }); break;
    case 'abort': post({ type: 'abort' }); break;
    case 'clearTask': post({ type: 'clearTask' }); break;
    case 'resume': post({ type: 'sendMessage', text: input.value.trim() || 'Continue the task from where you left off.' }); input.value = ''; saveDraft(); break;
    case 'openSettingsJson': post({ type: 'openSettingsJson' }); break;
    default: break;
  }
});

document.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (target.id === 'thinking-toggle') {
    post({ type: 'setThinking', value: (target as HTMLInputElement).checked });
    return;
  }
  const data = target.dataset;
  if (data.setting) {
    post({ type: 'updateSetting', key: data.setting, value: (target as HTMLInputElement).checked });
  } else if (data.settingNumber) {
    post({ type: 'updateSetting', key: data.settingNumber, value: Number(target.value) });
  } else if (data.settingSelect) {
    post({ type: 'updateSetting', key: data.settingSelect, value: target.value });
  } else if (data.settingText) {
    post({ type: 'updateSetting', key: data.settingText, value: target.value });
  } else if (data.settingList) {
    post({ type: 'updateSetting', key: data.settingList, value: target.value.split('\n').map((line) => line.trim()).filter(Boolean) });
  } else if (data.modeInstructions) {
    post({ type: 'updateSetting', key: 'modeInstructions', value: { ...(state?.settings.modeInstructions || {}), [data.modeInstructions]: target.value } });
  } else if (target.matches('[data-rotation]')) {
    post({ type: 'setRotation', strategy: target.value });
  }
});

document.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'history-search') {
    historyQuery = target.value;
    const caret = target.selectionStart;
    renderHistory();
    const search = $<HTMLInputElement>('history-search');
    search.focus();
    if (caret !== null) search.setSelectionRange(caret, caret);
  }
});

input.addEventListener('input', () => {
  saveDraft();
  autoResize();
  updatePopups();
});
input.addEventListener('click', updatePopups);

input.addEventListener('keydown', (event) => {
  const popupItems = slashState?.items.length ? slashState : mentionState?.items.length ? mentionState : undefined;
  if (popupItems) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const length = popupItems.items.length;
      popupItems.index = (popupItems.index + (event.key === 'ArrowDown' ? 1 : -1) + length) % length;
      renderPopup();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      if (slashState?.items.length) {
        const entry = slashState.items[slashState.index];
        const rest = input.value.replace(/^\/\w*/, '').trim();
        slashState = undefined;
        applySlash(entry.value, rest);
        renderPopup();
      } else if (mentionState?.items.length) {
        insertMention(mentionState.items[mentionState.index].value);
      }
      return;
    }
    if (event.key === 'Escape') {
      slashState = undefined;
      mentionState = undefined;
      renderPopup();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === '.') {
    event.preventDefault();
    if (!state) return;
    const index = state.modes.findIndex((mode) => mode.slug === state!.mode);
    const next = state.modes[(index + (event.shiftKey ? -1 : 1) + state.modes.length) % state.modes.length];
    post({ type: 'setMode', mode: next.slug });
    showToast(`${next.name} mode`);
  }
  if (event.key === 'Escape' && (modelMenuOpen || modeMenuOpen)) {
    modelMenuOpen = false;
    modeMenuOpen = false;
    renderComposer();
  }
});

function autoResize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(240, Math.max(64, input.scrollHeight))}px`;
}

function saveDraft(): void {
  draft = input.value;
  vscode.setState({ draft });
}

let toastTimer: number | undefined;
function showToast(text: string): void {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast!.classList.remove('show'), 2600);
}

function formatNumber(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

autoResize();
post({ type: 'ready' });
