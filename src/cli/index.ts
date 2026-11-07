import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { MODES } from '../agent/modes';
import type { AgentTask, AskResponse, CompletionProvider } from '../agent/task';
import type { AgentSettings, UiMessage } from '../agent/types';
import { COMPUTE_MODES, getComputeModeOption, getModelById, getModelCatalog, getModelLabel, isValidComputeModeInput, normalizeComputeMode, resolveComputeRoute } from '../api/modelCatalog';
import type { ComputeMode } from '../api/types';
import { loadSkills, loadSubagents } from '../core/agents';
import { applyPresetPrompt, installAgentPreset, installSkillPreset, librarySnapshot, loadTaskPresets } from '../core/library';
import { listSessions, perplexicodeHome, sessionsDir } from '../core/journal';
import { loadMcpServers, McpRegistry, McpServerState, McpTransportType, projectDefinesStdioMcpServers, removeMcpServerConfig, saveMcpServerConfig } from '../core/mcp';
import { cliStores, parseCookieInput } from '../core/nodeStores';
import { OpenAICompatibleProvider, openAIOptionsFromEnv } from '../core/openaiProvider';
import { createPerplexityBackend } from '../core/perplexity';
import { CoreSession, RunResult } from '../core/runner';
import { loadSettings, projectDefinesHooks } from '../core/settings';
import { CoreEvent, PERMISSION_MODES, PermissionMode } from '../core/types';
import { VERIFICATION_LABELS } from '../core/verification';
import { browserLogin } from './browserLogin';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '3.3.0';
  }
})();

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

export interface CliOptions {
  command?: string;
  args: string[];
  print: boolean;
  prompt?: string;
  outputFormat: 'text' | 'json' | 'stream-json';
  permissionMode?: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  model?: string;
  thinking: boolean;
  mode: string;
  preset?: string;
  agent?: string;
  global: boolean;
  continue: boolean;
  resume?: string;
  cwd: string;
  provider: 'perplexity' | 'openai';
  web?: boolean;
  trustProject: boolean;
  verbose: boolean;
  journal: boolean;
  alias?: string;
  browser: boolean;
  help: boolean;
  version: boolean;
  /** 3.3: Perplexity compute mode (search | light | standard | high | ultra | research | labs). */
  computeMode?: ComputeMode;
  /** 3.3: extra MCP config files or inline JSON (--mcp-config), Claude Code compatible. */
  mcpConfigs: string[];
  /** 3.3: ignore every MCP server configuration. */
  noMcp: boolean;
  /** 3.3: only use servers from --mcp-config (Claude Code --strict-mcp-config). */
  strictMcpConfig: boolean;
  /** `pcode mcp add` options. */
  mcpTransport?: McpTransportType;
  mcpEnv: string[];
  mcpHeaders: string[];
  mcpScope?: 'user' | 'project' | 'local';
}

const SUBCOMMANDS = new Set(['login', 'logout', 'accounts', 'sessions', 'models', 'agents', 'skills', 'presets', 'mcp', 'doctor', 'help', 'version']);

function splitRules(value: string): string[] {
  // "Bash(npm test:*),Read Edit" → ["Bash(npm test:*)", "Read", "Edit"]; commas/spaces inside (...) are kept.
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ' ') && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    args: [],
    print: false,
    outputFormat: 'text',
    allowedTools: [],
    disallowedTools: [],
    thinking: false,
    mode: 'code',
    global: false,
    continue: false,
    cwd: process.cwd(),
    provider: (process.env.PCODE_PROVIDER as 'perplexity' | 'openai') || 'perplexity',
    trustProject: false,
    verbose: false,
    journal: true,
    browser: false,
    help: false,
    version: false,
    mcpConfigs: [],
    noMcp: false,
    strictMcpConfig: false,
    mcpEnv: [],
    mcpHeaders: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Everything after "--" is positional (pcode mcp add name -- npx -y server --flag).
      positional.push(...argv.slice(i + 1));
      break;
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '-p': case '--print': options.print = true; break;
      case '--output-format': {
        const v = value();
        if (v !== 'text' && v !== 'json' && v !== 'stream-json') throw new Error('--output-format must be text, json or stream-json');
        options.outputFormat = v;
        break;
      }
      case '--permission-mode': {
        const v = value() as PermissionMode;
        if (!PERMISSION_MODES.includes(v)) throw new Error(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')}`);
        options.permissionMode = v;
        break;
      }
      case '--dangerously-skip-permissions': options.permissionMode = 'bypassPermissions'; break;
      case '--allowedTools': case '--allowed-tools': options.allowedTools.push(...splitRules(value())); break;
      case '--disallowedTools': case '--disallowed-tools': options.disallowedTools.push(...splitRules(value())); break;
      case '--max-turns': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw new Error('--max-turns must be an integer >= 0 (0 = unlimited)');
        options.maxTurns = n;
        break;
      }
      case '-m': case '--model': options.model = value(); break;
      case '--thinking': options.thinking = true; break;
      case '--compute': case '--compute-mode': {
        const v = value();
        if (!isValidComputeModeInput(v)) throw new Error(`--compute must be one of ${COMPUTE_MODES.map((m) => m.id).join(', ')}`);
        options.computeMode = normalizeComputeMode(v);
        break;
      }
      case '--mcp-config': options.mcpConfigs.push(value()); break;
      case '--no-mcp': options.noMcp = true; break;
      case '--strict-mcp-config': options.strictMcpConfig = true; break;
      case '-t': case '--transport': {
        const v = value();
        if (v !== 'stdio' && v !== 'http' && v !== 'sse') throw new Error('--transport must be stdio, http or sse');
        options.mcpTransport = v;
        break;
      }
      case '-e': case '--env': options.mcpEnv.push(value()); break;
      case '-H': case '--header': options.mcpHeaders.push(value()); break;
      case '-s': case '--scope': {
        const v = value();
        if (v !== 'user' && v !== 'project' && v !== 'local') throw new Error('--scope must be user, project or local');
        options.mcpScope = v;
        break;
      }
      case '--mode': {
        const v = value();
        if (!MODES.some((m) => m.slug === v)) throw new Error(`--mode must be one of ${MODES.map((m) => m.slug).join(', ')}`);
        options.mode = v;
        break;
      }
      case '--preset': options.preset = value(); break;
      case '--agent': options.agent = value(); break;
      case '-g': case '--global': options.global = true; break;
      case '-c': case '--continue': options.continue = true; break;
      case '-r': case '--resume': {
        const next = inline ?? argv[i + 1];
        if (next !== undefined && !next.startsWith('-') && /^[a-z0-9-]{4,}$/i.test(next)) {
          options.resume = next;
          if (inline === undefined) i++;
        } else {
          options.resume = 'latest';
        }
        break;
      }
      case '--cwd': options.cwd = path.resolve(value()); break;
      case '--provider': {
        const v = value();
        if (v !== 'perplexity' && v !== 'openai') throw new Error('--provider must be perplexity or openai');
        options.provider = v;
        break;
      }
      case '--web': options.web = true; break;
      case '--no-web': options.web = false; break;
      case '--trust-project': options.trustProject = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--no-journal': options.journal = false; break;
      case '--alias': options.alias = value(); break;
      case '--browser': options.browser = true; break;
      case '-h': case '--help': options.help = true; break;
      case '--version': options.version = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option ${arg}. See pcode --help.`);
        positional.push(arg);
    }
  }
  if (positional.length > 0 && SUBCOMMANDS.has(positional[0])) {
    options.command = positional[0];
    options.args = positional.slice(1);
  } else if (positional.length > 0) {
    options.prompt = positional.join(' ');
  }
  return options;
}

const HELP = `pcode ${VERSION} — PerplexiCode headless core (Claude Code style CLI)

Usage:
  pcode [prompt]                      interactive session (REPL)
  pcode -p "prompt"                   headless: run to completion, print the result
  echo "prompt" | pcode -p            prompt from stdin
  pcode -c [-p "more"]                continue the latest session of this folder
  pcode -r <id> [-p "more"]           resume a session (CLI or VS Code task)

Options:
  -p, --print                 headless mode
  --output-format <f>         text | json | stream-json (headless)
  --permission-mode <m>       default | acceptEdits | plan | bypassPermissions
  --dangerously-skip-permissions   same as --permission-mode bypassPermissions
  --allowedTools <rules>      e.g. "Read,Edit,Bash(npm test:*)"
  --disallowedTools <rules>   e.g. "Bash(git push:*)"
  --max-turns <n>             model requests before stopping; 0 = unlimited
  -m, --model <id>            model id (pcode models); --thinking for the thinking variant
  --compute <mode>            Perplexity compute mode: search (default) | light | standard | high | ultra
                              (Computer / ASI harness) | research | labs — falls back to Search when
                              your plan does not include it
  --mode <slug>               code | architect | ask | debug | orchestrator | review
  --preset <id>               task preset (pcode presets): sets mode, subagent and prompt template
  --agent <name>              run the task as an installed subagent
  --provider <p>              perplexity (your Pro/Max session) | openai (OpenAI-compatible, e.g. Ollama)
  --web / --no-web            force web search on/off
  --cwd <dir>                 workspace folder (default: current)
  --trust-project             run hooks and project MCP servers from project settings in headless mode
  --mcp-config <file|json>    extra MCP servers (Claude Code format), repeatable; --strict-mcp-config uses only them
  --no-mcp                    do not start MCP servers
  --no-journal                do not write ~/.perplexicode/sessions
  -v, --verbose               progress on stderr in headless mode

Commands:
  pcode login [--alias name] [--browser]   add a Perplexity account (cookie from stdin/hidden prompt, PPLX_COOKIE env, or browser)
  pcode logout <alias|id>                  remove an account
  pcode accounts                           list accounts
  pcode sessions                           saved sessions of this folder
  pcode models                             available model ids
  pcode agents | skills                    subagents / skills found for this folder
  pcode agents catalog | skills catalog    built-in presets you can install
  pcode agents add <id...> [-g]            install subagent presets (project; -g = ~/.perplexicode)
  pcode skills add <id...> [-g]            install skill presets
  pcode presets                            task presets (built-in, ~/.perplexicode/presets.json, project)
  pcode mcp list                           MCP servers (Claude Code compatible: ~/.claude.json, .mcp.json, settings)
  pcode mcp add <name> [-s scope] [-t stdio|http|sse] [-e K=V] [-H "Header: v"] -- <command|url> [args]
  pcode mcp remove <name> [-s scope]       delete a server from the config files
  pcode mcp get <name>                     show one server, connect and list its tools
  pcode mcp test [name]                    connect to the servers and report tools/resources
  pcode doctor                             environment and configuration check

Settings: ~/.claude/settings.json, ~/.perplexicode/settings.json, .claude/settings.json,
.perplexicode/settings.json and *.local.json (permissions, hooks, verify, env, computeMode, mcpServers).
MCP: ~/.claude.json, ~/.claude/.mcp.json, ~/.perplexicode/mcp.json, <project>/.mcp.json, .mcp.local.json.
Permission rules for MCP: mcp__<server>__<tool>, mcp__<server>, mcp; for web_fetch: WebFetch(domain:host).
OpenAI-compatible provider: PCODE_OPENAI_BASE_URL, PCODE_OPENAI_API_KEY, PCODE_OPENAI_MODEL.
`;

// ---------------------------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------------------------

const useColor = (stream: NodeJS.WriteStream) => stream.isTTY && !process.env.NO_COLOR;
const paint = (code: string, stream: NodeJS.WriteStream = process.stderr) => (text: string) => (useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const bold = paint('1');

function out(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Reads piped stdin. With `idleMs`, gives up if nothing arrives in that time (a prompt was already
 * given as an argument and stdin is an idle pipe, e.g. in CI or under another agent).
 */
function readAllStdin(idleMs?: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      resolve(data);
    };
    const timer = idleMs !== undefined ? setTimeout(() => { if (!data) finish(); }, idleMs) : undefined;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Hidden input (no echo) for secrets. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stderr.write(question);
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          input.setRawMode?.(false);
          input.pause();
          input.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          input.setRawMode?.(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    input.on('data', onData);
  });
}

// ---------------------------------------------------------------------------------------------
// Session setup
// ---------------------------------------------------------------------------------------------

function agentSettings(options: CliOptions): AgentSettings {
  const unlimited = options.maxTurns === 0;
  return {
    autoApprove: {
      enabled: true,
      read: true,
      readOutsideWorkspace: false,
      write: false,
      execute: false,
      modeSwitch: true,
      subtasks: true,
      todo: true,
      retry: true,
      mcp: false,
      web: false,
    },
    allowedCommands: [],
    deniedCommands: [],
    maxRequests: unlimited ? Number.MAX_SAFE_INTEGER : options.maxTurns ?? (options.print ? 40 : 60),
    maxReadLines: 500,
    commandTimeoutSec: Number(process.env.PCODE_COMMAND_TIMEOUT || 300),
    terminalOutputLines: 300,
    webSearch: 'auto',
    contextStrategy: 'auto',
    maxPromptChars: Number(process.env.PCODE_MAX_PROMPT_CHARS || 60000),
    language: process.env.PCODE_LANGUAGE || 'auto',
    customInstructions: '',
    modeInstructions: {},
    diffEnabled: true,
    includeFileListOnStart: true,
  };
}

function trustedFile(): string {
  return path.join(perplexicodeHome(), 'trusted.json');
}

export function isTrusted(cwd: string): boolean {
  try {
    const list = JSON.parse(fs.readFileSync(trustedFile(), 'utf8'));
    return Array.isArray(list) && list.includes(path.resolve(cwd));
  } catch {
    return false;
  }
}

function trust(cwd: string): void {
  let list: string[] = [];
  try {
    list = JSON.parse(fs.readFileSync(trustedFile(), 'utf8'));
  } catch {
    list = [];
  }
  if (!list.includes(path.resolve(cwd))) list.push(path.resolve(cwd));
  fs.mkdirSync(perplexicodeHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(trustedFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

async function createProvider(options: CliOptions, log: (line: string) => void): Promise<{ provider: CompletionProvider; label: (id: string, thinking: boolean) => string; defaultModel: string; accounts?: number }> {
  if (options.provider === 'openai') {
    const openai = openAIOptionsFromEnv(options.model);
    return { provider: new OpenAICompatibleProvider(openai), label: () => openai.model, defaultModel: openai.model };
  }
  const backend = await createPerplexityBackend({ refreshCapabilities: !options.print || options.verbose, log });
  const accounts = backend.accountManager.getAccounts().length;
  if (accounts === 0) {
    throw new Error('No Perplexity account. Run `pcode login` (or "PerplexiCode: Share Accounts with CLI" in VS Code), or use --provider openai.');
  }
  return { provider: backend.transport, label: (id, thinking) => getModelLabel(id, thinking), defaultModel: 'turbo', accounts };
}

interface SessionBundle {
  session: CoreSession;
  extraAllow: string[];
  modelLabel: (id: string, thinking: boolean) => string;
  mcp?: McpRegistry;
}

/** "GPT-6 Astra · Computer high" style label used by the REPL header and environment details. */
function withComputeLabel(label: (id: string, thinking: boolean) => string, computeMode: () => ComputeMode | undefined) {
  return (id: string, thinking: boolean): string => {
    const mode = computeMode();
    if (!mode || mode === 'search') {
      return label(id, thinking);
    }
    return `${label(id, thinking)} · ${getComputeModeOption(mode).label}`;
  };
}

/** Builds the MCP registry for a run; undefined when MCP is disabled or nothing is configured. */
function createMcpRegistry(options: CliOptions, trusted: boolean, log: (line: string) => void): McpRegistry | undefined {
  if (options.noMcp) {
    return undefined;
  }
  const registry = new McpRegistry({
    cwd: options.cwd,
    trustProject: trusted,
    extraConfigs: options.mcpConfigs,
    strict: options.strictMcpConfig,
    log,
  });
  return registry.hasServers() ? registry : undefined;
}

async function buildSession(options: CliOptions, ui: SessionUi): Promise<SessionBundle> {
  const cwd = options.cwd;
  const hooksDefined = projectDefinesHooks(cwd);
  const mcpDefined = !options.noMcp && !options.strictMcpConfig && projectDefinesStdioMcpServers(cwd);
  let trusted = options.trustProject || isTrusted(cwd);
  if ((hooksDefined || mcpDefined) && !trusted && !options.print && process.stdin.isTTY) {
    const what = [hooksDefined ? 'hooks' : '', mcpDefined ? 'MCP servers (stdio commands)' : ''].filter(Boolean).join(' and ');
    out(yellow(`This project defines ${what} in .claude/, .perplexicode/ or .mcp.json that run shell commands.`));
    const answer = (await ui.question(`Trust this folder and run its ${what}? [y/N] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      trust(cwd);
      trusted = true;
    }
  } else if ((hooksDefined || mcpDefined) && !trusted) {
    out(yellow(`Project ${[hooksDefined ? 'hooks' : '', mcpDefined ? 'MCP stdio servers' : ''].filter(Boolean).join(' and ')} skipped (untrusted folder). Pass --trust-project to run them.`));
  }
  const settings = loadSettings(cwd, { trustProjectHooks: trusted });
  const backend = await createProvider(options, (line) => ui.log(line));
  const modelId = options.model || settings.model || process.env.PCODE_MODEL || backend.defaultModel;
  if (options.provider === 'perplexity' && !getModelById(modelId)) {
    throw new Error(`Unknown model '${modelId}'. Run \`pcode models\`.`);
  }
  const settingsCompute = settings.computeMode || process.env.PCODE_COMPUTE;
  if (!options.computeMode && settingsCompute) {
    if (isValidComputeModeInput(settingsCompute)) {
      options.computeMode = normalizeComputeMode(settingsCompute);
    } else {
      ui.log(`Ignoring unknown computeMode '${settingsCompute}' (settings / PCODE_COMPUTE).`);
    }
  }
  const computeMode = options.provider === 'perplexity' ? options.computeMode : undefined;
  const extraAllow = [...options.allowedTools];
  const mcp = createMcpRegistry(options, trusted, (line) => ui.log(line));
  let sessionRef: CoreSession | undefined;
  const session = new CoreSession({
    cwd,
    provider: backend.provider,
    agentSettings: agentSettings(options),
    selection: { baseModelId: modelId, thinking: options.thinking, webSearch: options.web, computeMode },
    mode: options.mode,
    agent: options.agent,
    permissionMode: options.permissionMode,
    settings,
    extraAllow,
    extraDeny: options.disallowedTools,
    journal: options.journal,
    getModelLabel: withComputeLabel(backend.label, () => sessionRef?.selection.computeMode),
    trustProjectHooks: trusted,
    mcp,
    onAsk: (task, message) => ui.ask(task, message, extraAllow),
    onMessage: (task, message) => ui.message(task, message),
    onEvent: (task, event) => ui.event(task, event),
    log: (line) => ui.log(line),
  });
  sessionRef = session;
  return { session, extraAllow, modelLabel: withComputeLabel(backend.label, () => session.selection.computeMode), mcp };
}

// ---------------------------------------------------------------------------------------------
// UI: headless (policy-driven) and interactive (prompts)
// ---------------------------------------------------------------------------------------------

interface SessionUi {
  ask(task: AgentTask, message: UiMessage, extraAllow: string[]): Promise<AskResponse>;
  message(task: AgentTask, message: UiMessage): void;
  event(task: AgentTask, event: CoreEvent): void;
  log(line: string): void;
  question(text: string): Promise<string>;
}

class Printer {
  private readonly printed = new Map<string, string>();

  constructor(private readonly enabled: () => boolean, private readonly verbose: boolean) {}

  print(task: AgentTask, message: UiMessage): void {
    if (!this.enabled() || message.partial) return;
    const key = `${message.status || ''}|${message.ask?.resolved ?? ''}|${message.text?.length || 0}|${message.command?.exitCode ?? ''}`;
    if (this.printed.get(message.id) === key) return;
    const first = !this.printed.has(message.id);
    this.printed.set(message.id, key);
    const indent = task.parentId ? '  │ ' : '';
    const line = (text: string) => out(text.split('\n').map((l) => indent + l).join('\n'));
    switch (message.type) {
      case 'text':
        if (first && message.text) line(message.text.trim());
        break;
      case 'reasoning':
        if (this.verbose && first && message.text) line(dim(message.text.trim()));
        break;
      case 'tool':
        if (message.status === 'done' || message.status === 'error' || message.status === 'rejected') {
          const mark = message.status === 'done' ? green('●') : message.status === 'rejected' ? yellow('○') : red('●');
          const stat = message.tool?.added !== undefined ? dim(` (+${message.tool.added} -${message.tool.removed ?? 0})`) : '';
          line(`${mark} ${message.tool?.title || message.tool?.name}${stat}${message.status === 'rejected' ? dim(' — rejected') : ''}`);
        }
        break;
      case 'command':
        if (message.command && message.command.exitCode !== undefined && !message.command.running) {
          const code = message.command.exitCode;
          line(`${code === 0 ? green('●') : red('●')} ${bold('$')} ${message.command.command} ${dim(`(exit ${code ?? '?'})`)}`);
          const tail = (message.command.output || '').trimEnd().split('\n').slice(-(this.verbose ? 40 : 8)).join('\n');
          if (tail) line(dim(tail.replace(/^/gm, '  ')));
        }
        break;
      case 'completion':
        if (first && message.text) {
          line(green('✔ Done'));
          line(message.text.trim());
        }
        break;
      case 'error':
        if (first) line(red(`✖ ${message.text || 'error'}`));
        break;
      case 'info':
        if (first && message.text && !message.ask) line(yellow(`ℹ ${message.text}`));
        break;
      case 'subtask':
        if (first) line(cyan(`⤷ ${message.text || 'subtask'}`));
        break;
      case 'api_req':
        if (this.verbose && message.meta?.durationMs) {
          line(dim(`↳ ${message.meta.model || ''}${message.meta.account ? ` · ${message.meta.account}` : ''} · ${(message.meta.durationMs / 1000).toFixed(1)}s`));
        }
        break;
      case 'checkpoint':
        if (this.verbose && first) line(dim(`checkpoint #${message.checkpoint?.seq}`));
        break;
      default:
        break;
    }
  }
}

/** Headless policy: never blocks on a human. */
export function headlessAnswer(message: UiMessage, maxTurns?: number): AskResponse {
  switch (message.ask?.kind) {
    case 'tool':
    case 'command':
      return {
        response: 'no',
        text: 'Not permitted in headless mode by the current permission rules. Allow it with --allowedTools / --permission-mode, or continue without this action.',
      };
    case 'followup':
      return { response: 'message', text: 'No human is available (headless run). Proceed with your best judgment and state the assumption.' };
    case 'request_limit':
      return maxTurns === 0 ? { response: 'yes' } : { response: 'no' };
    case 'mistake_limit':
      return { response: 'no' };
    case 'api_failed':
      return { response: 'no' };
    default:
      return { response: 'yes' };
  }
}

function headlessUi(options: CliOptions): SessionUi {
  const printer = new Printer(() => options.verbose && options.outputFormat !== 'stream-json', options.verbose);
  return {
    ask: async (_task, message) => {
      const answer = headlessAnswer(message, options.maxTurns);
      if (options.verbose && (message.ask?.kind === 'tool' || message.ask?.kind === 'command')) {
        out(yellow(`○ denied (headless): ${message.tool?.title || message.command?.command || message.ask?.kind}`));
      }
      return answer;
    },
    message: (task, message) => printer.print(task, message),
    event: (task, event) => {
      if (options.outputFormat === 'stream-json') {
        process.stdout.write(`${JSON.stringify({ ...event, task_id: task.id, parent_id: task.parentId })}\n`);
      }
    },
    log: (line) => {
      if (options.verbose) out(dim(line));
    },
    question: async () => '',
  };
}

class InteractiveUi implements SessionUi {
  readonly rl: readline.Interface;
  private readonly printer: Printer;
  private queue: Promise<unknown> = Promise.resolve();
  permissionModeRef: { set?: (mode: PermissionMode) => void } = {};

  constructor(verbose: boolean) {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true, historySize: 200 });
    this.printer = new Printer(() => true, verbose);
  }

  question(text: string): Promise<string> {
    const next = this.queue.then(() => new Promise<string>((resolve) => this.rl.question(text, resolve)));
    this.queue = next.catch(() => undefined);
    return next;
  }

  log(line: string): void {
    out(dim(line));
  }

  message(task: AgentTask, message: UiMessage): void {
    this.printer.print(task, message);
  }

  event(): void {
    return;
  }

  async ask(task: AgentTask, message: UiMessage, extraAllow: string[]): Promise<AskResponse> {
    const kind = message.ask?.kind;
    if (kind === 'tool') {
      const tool = message.tool;
      out(`${yellow('?')} ${bold(tool?.title || tool?.name || 'tool')}${tool?.reason ? dim(` — ${tool.reason}`) : ''}`);
      if (tool?.diff?.length) {
        for (const d of tool.diff.slice(0, 80)) {
          const text = `${d.type === '@' ? '' : d.type}${d.text}`;
          out(d.type === '+' ? green(text) : d.type === '-' ? red(text) : d.type === '@' ? cyan(text) : dim(text));
        }
        if (tool.diff.length > 80) out(dim(`… ${tool.diff.length - 80} more lines`));
      } else if (tool?.content && tool.isNewFile) {
        out(dim(tool.content.split('\n').slice(0, 30).join('\n')));
      }
      if (tool?.name === 'use_mcp_tool' || tool?.name === 'access_mcp_resource' || tool?.name === 'list_mcp_resources') {
        if (tool.content) out(dim(tool.content.split('\n').slice(0, 30).join('\n')));
        const rule = tool.server ? `mcp__${tool.server.replace(/[^a-zA-Z0-9_-]+/g, '_')}` : 'mcp';
        const answer = (await this.question(`  Allow? ${dim(`[y]es / [n]o / [a]lways this MCP server (${rule}) / or type feedback`)} `)).trim();
        return this.decide(answer, () => extraAllow.push(rule));
      }
      if (tool?.name === 'web_fetch' && tool.url) {
        let host = '';
        try { host = new URL(tool.url).hostname; } catch { host = ''; }
        const answer = (await this.question(`  Allow? ${dim(`[y]es / [n]o${host ? ` / [a]lways ${host}` : ''} / or type feedback`)} `)).trim();
        return this.decide(answer, () => { if (host) extraAllow.push(`WebFetch(domain:${host})`); });
      }
      const answer = (await this.question(`  Allow? ${dim('[y]es / [n]o / [a]lways edits this session / or type feedback')} `)).trim();
      return this.decide(answer, () => this.permissionModeRef.set?.('acceptEdits'));
    }
    if (kind === 'command') {
      const command = message.command?.command || '';
      out(`${yellow('?')} ${bold('$')} ${command}${message.command?.cwd ? dim(`  (in ${message.command.cwd})`) : ''}`);
      const prefix = command.trim().split(/\s+/).slice(0, 2).join(' ');
      const answer = (await this.question(`  Run? ${dim(`[y]es / [n]o / [a]lways "${prefix} …" / or type feedback`)} `)).trim();
      return this.decide(answer, () => extraAllow.push(`Bash(${prefix}:*)`));
    }
    if (kind === 'followup') {
      out(`${cyan('?')} ${message.text || ''}`);
      (message.suggestions || []).forEach((s, i) => out(dim(`  ${i + 1}. ${s.text}`)));
      const answer = (await this.question('  > ')).trim();
      const index = Number(answer);
      if (Number.isInteger(index) && message.suggestions?.[index - 1]) {
        return { response: 'message', text: message.suggestions[index - 1].text };
      }
      return { response: 'message', text: answer || 'Proceed with your best judgment.' };
    }
    if (kind === 'completion_result') {
      return { response: 'yes' };
    }
    if (kind === 'request_limit' || kind === 'mistake_limit' || kind === 'api_failed' || kind === 'resume_task') {
      out(`${yellow('?')} ${message.text || kind}`);
      const answer = (await this.question(`  Continue? ${dim('[Y/n] or type guidance')} `)).trim();
      if (!answer || /^y(es)?$/i.test(answer)) return { response: 'yes' };
      if (/^n(o)?$/i.test(answer)) return { response: 'no' };
      return { response: 'message', text: answer };
    }
    return { response: 'yes' };
  }

  private decide(answer: string, always: () => void): AskResponse {
    if (!answer || /^y(es)?$/i.test(answer)) return { response: 'yes' };
    if (/^n(o)?$/i.test(answer)) return { response: 'no' };
    if (/^a(lways)?$/i.test(answer)) {
      always();
      return { response: 'yes' };
    }
    return { response: 'message', text: answer };
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function resultText(result: RunResult): string {
  return (result.result ?? result.lastText ?? '').trim();
}

function exitCodeFor(result: RunResult): number {
  if (result.status === 'error' || result.status === 'aborted') return 1;
  if (result.verification.status === 'failed') return 2;
  return 0;
}

async function runHeadless(options: CliOptions): Promise<number> {
  let prompt = options.prompt;
  const piped = await readAllStdin(prompt || options.continue || options.resume ? 250 : undefined);
  if (piped.trim()) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  if (!prompt && !options.continue && !options.resume) {
    out('pcode -p needs a prompt (argument or stdin).');
    return 64;
  }
  const ui = headlessUi(options);
  const { session, mcp } = await buildSession(options, ui);
  const started = Date.now();
  let aborted = false;
  process.on('SIGINT', () => {
    aborted = true;
    session.abort();
  });
  let result: RunResult;
  try {
    result = options.resume || options.continue
      ? await session.resume(options.resume || 'latest', prompt)
      : await session.run(prompt!);
  } finally {
    await mcp?.closeAll().catch(() => undefined);
  }
  const payload = {
    type: 'result',
    subtype: aborted ? 'aborted' : result.status === 'error' ? 'error' : result.result !== undefined ? 'success' : 'stopped',
    session_id: result.taskId,
    result: resultText(result),
    status: result.status,
    num_turns: result.requests,
    duration_ms: Date.now() - started,
    verification: { status: result.verification.status, detail: result.verification.detail, edited_files: result.verification.editedFiles },
    permission_mode: session.permissionMode,
    journal: result.journal,
  };
  if (options.outputFormat === 'text') {
    process.stdout.write(`${payload.result}\n`);
    if (options.verbose) out(dim(`[${VERIFICATION_LABELS[result.verification.status]}] ${result.verification.detail} · session ${result.taskId}`));
  } else {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  return aborted ? 130 : exitCodeFor(result);
}

const SLASH_HELP = `/help              this help
/mode [slug]       show or switch agent mode (${MODES.map((m) => m.slug).join(', ')})
/permissions [m]   show or switch permission mode (${PERMISSION_MODES.join(', ')})
/model [id]        show or switch model
/compute [mode]    show or switch Perplexity compute mode (${COMPUTE_MODES.map((m) => m.id).join(', ')})
/mcp [reconnect [name]]  MCP servers, their tools and resources
/compact [focus]   summarise the conversation to save context
/clear             start a new session
/agents  /skills   list subagents / skills
/status            session, model, verification
/todos             current todo list
/resume [id]       resume a saved session (default: latest)
/exit              quit (Ctrl+C aborts a running task)`;

async function runInteractive(options: CliOptions): Promise<number> {
  const ui = new InteractiveUi(options.verbose);
  let bundle = await buildSession(options, ui);
  ui.permissionModeRef.set = (mode) => {
    bundle.session.permissionMode = mode;
    out(dim(`permission mode → ${mode}`));
  };
  const header = () => {
    const s = bundle.session;
    out(`${bold('PerplexiCode')} ${dim(VERSION)} · ${cyan(bundle.modelLabel(s.selection.baseModelId, s.selection.thinking))} · mode ${options.mode} · permissions ${s.permissionMode}`);
    const mcpStates = bundle.mcp?.getStates() || [];
    out(dim(`${options.cwd} · /help for commands${mcpStates.length > 0 ? ` · MCP servers: ${mcpStates.map((state) => state.config.name).join(', ')}` : ''}`));
  };
  header();
  let running: Promise<RunResult> | undefined;
  ui.rl.on('SIGINT', () => {
    if (running) {
      bundle.session.abort();
      out(yellow('\naborted'));
    } else {
      ui.rl.close();
    }
  });
  const exec = async (fn: () => Promise<RunResult>) => {
    running = fn();
    try {
      const result = await running;
      const v = result.verification;
      if (v.status !== 'no_changes') {
        const color = v.status === 'verified' ? green : v.status === 'failed' ? red : yellow;
        out(color(`[${VERIFICATION_LABELS[v.status]}] ${v.detail}`));
      }
    } catch (error) {
      out(red(`✖ ${(error as Error).message}`));
    } finally {
      running = undefined;
    }
  };
  if (options.resume || options.continue) {
    await exec(() => bundle.session.resume(options.resume || 'latest', options.prompt));
  } else if (options.prompt) {
    await exec(() => bundle.session.run(options.prompt!));
  }
  for (;;) {
    let line: string;
    try {
      line = (await ui.question(`${cyan('›')} `)).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      const s = bundle.session;
      switch (cmd) {
        case 'exit': case 'quit': ui.rl.close(); await bundle.mcp?.closeAll().catch(() => undefined); return 0;
        case 'help': out(SLASH_HELP); break;
        case 'compute':
          if (!arg) {
            const current = getComputeModeOption(s.selection.computeMode);
            out(`compute mode: ${current.id} — ${current.label}`);
            for (const m of COMPUTE_MODES) out(dim(`  ${m.id.padEnd(17)} ${m.label.padEnd(26)} ${m.description}`));
          } else if (options.provider !== 'perplexity') {
            out(red('compute modes apply to the Perplexity provider only'));
          } else if (!isValidComputeModeInput(arg)) {
            out(red(`unknown compute mode ${arg} (${COMPUTE_MODES.map((m) => m.id).join(', ')})`));
          } else {
            const next = normalizeComputeMode(arg);
            s.selection = { ...s.selection, computeMode: next };
            const route = resolveComputeRoute(s.selection.baseModelId, s.selection.thinking, next);
            out(dim(`compute → ${next} (${getComputeModeOption(next).label}; model ${route.modelId}, requires ${route.requiredPlan} plan)`));
          }
          break;
        case 'mcp': {
          if (!bundle.mcp) {
            out(dim(options.noMcp ? 'MCP disabled (--no-mcp)' : 'no MCP servers configured (pcode mcp add <name> -- <command>)'));
            break;
          }
          if (rest[0] === 'reconnect') {
            const target = rest[1];
            out(dim(target ? `reconnecting ${target}…` : 'reconnecting all MCP servers…'));
            if (target) await bundle.mcp.connectServer(target).catch((error: Error) => out(red(error.message)));
            else await bundle.mcp.connectAll();
          } else {
            await bundle.mcp.ensureConnected();
          }
          for (const line of formatMcpStates(bundle.mcp.getStates(), true)) out(line);
          break;
        }
        case 'mode':
          if (!arg) out(`mode: ${s.root?.mode || options.mode}`);
          else if (!MODES.some((m) => m.slug === arg)) out(red(`unknown mode ${arg}`));
          else {
            options.mode = arg;
            s.root?.setMode(arg);
            out(dim(`mode → ${arg}`));
          }
          break;
        case 'permissions':
          if (!arg) out(`permission mode: ${s.permissionMode}\nallow: ${[...s.settings.permissions.allow, ...bundle.extraAllow].join(', ') || '-'}\ndeny: ${s.settings.permissions.deny.join(', ') || '-'}`);
          else if (!PERMISSION_MODES.includes(arg as PermissionMode)) out(red(`unknown permission mode ${arg}`));
          else ui.permissionModeRef.set?.(arg as PermissionMode);
          break;
        case 'model':
          if (!arg) out(`model: ${s.selection.baseModelId}${s.selection.thinking ? ' (thinking)' : ''}`);
          else if (options.provider === 'perplexity' && !getModelById(arg)) out(red(`unknown model ${arg} (see pcode models)`));
          else {
            s.selection = { ...s.selection, baseModelId: arg };
            out(dim(`model → ${arg}`));
          }
          break;
        case 'compact':
          try {
            const r = await s.compact(arg || undefined);
            out(dim(`compacted ${r.before} → ${r.after} messages`));
          } catch (error) {
            out(red((error as Error).message));
          }
          break;
        case 'clear':
          await bundle.mcp?.closeAll().catch(() => undefined);
          bundle = await buildSession(options, ui);
          out(dim('new session'));
          break;
        case 'agents':
          for (const a of s.subagents) out(`${bold(a.name)} ${dim(`[${a.scope}, ${a.mode}${a.model ? `, ${a.model}` : ''}]`)} ${a.description}`);
          if (s.subagents.length === 0) out(dim('no subagents (.perplexicode/agents/*.md or .claude/agents/*.md)'));
          break;
        case 'skills': {
          const skills = loadSkills(options.cwd);
          for (const k of skills) out(`${bold(k.name)} ${dim(`[${k.scope}]`)} ${k.description}`);
          if (skills.length === 0) out(dim('no skills (.perplexicode/skills/<name>/SKILL.md or .claude/skills)'));
          break;
        }
        case 'status': {
          const v = s.verification();
          out(`session ${s.root?.id || '-'} · ${s.root?.status.state || 'new'} · ${s.root?.status.requestCount || 0} requests`);
          out(`model ${s.selection.baseModelId} · compute ${s.selection.computeMode || 'search'} · mode ${s.root?.mode || options.mode} · permissions ${s.permissionMode}`);
          if (bundle.mcp) out(`mcp: ${bundle.mcp.getStates().map((state) => `${state.config.name} (${state.status}${state.status === 'connected' ? `, ${state.tools.length} tools` : ''})`).join(', ')}`);
          out(`verification: ${VERIFICATION_LABELS[v.status]} — ${v.detail}`);
          if (s.root) out(dim(`journal: ${s.journalPath(s.root.id) || 'off'}`));
          break;
        }
        case 'todos':
          for (const t of s.root?.todos || []) out(`${t.status === 'completed' ? green('[x]') : t.status === 'in_progress' ? yellow('[-]') : '[ ]'} ${t.text}`);
          if (!s.root?.todos.length) out(dim('no todos'));
          break;
        case 'resume':
          await bundle.mcp?.closeAll().catch(() => undefined);
          bundle = await buildSession(options, ui);
          await exec(() => bundle.session.resume(arg || 'latest'));
          break;
        default:
          out(red(`unknown command /${cmd} — /help`));
      }
      continue;
    }
    await exec(() => bundle.session.run(line));
  }
  await bundle.mcp?.closeAll().catch(() => undefined);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// pcode mcp
// ---------------------------------------------------------------------------------------------

function formatMcpStates(states: McpServerState[], verbose: boolean): string[] {
  const lines: string[] = [];
  if (states.length === 0) {
    lines.push(dim('No MCP servers configured. Add one with `pcode mcp add <name> -- <command>` or a .mcp.json file.'));
    return lines;
  }
  for (const state of states) {
    const mark = state.status === 'connected' ? green('●') : state.status === 'error' ? red('●') : state.status === 'untrusted' ? yellow('○') : dim('○');
    const target = state.config.type === 'stdio' ? `${state.config.command || ''} ${(state.config.args || []).join(' ')}`.trim() : state.config.url || '';
    const summary = state.status === 'connected'
      ? `${state.tools.length} tools, ${state.resources.length} resources${state.prompts.length ? `, ${state.prompts.length} prompts` : ''}${state.serverInfo?.name ? ` · ${state.serverInfo.name}${state.serverInfo.version ? ` ${state.serverInfo.version}` : ''}` : ''}`
      : state.status === 'disconnected' ? 'not connected yet' : state.error || state.status;
    lines.push(`${mark} ${bold(state.config.name)} ${dim(`[${state.config.type}, ${state.config.scope}]`)} ${dim(target)}`);
    lines.push(`    ${summary}`);
    if (verbose && state.status === 'connected') {
      for (const tool of state.tools) {
        lines.push(dim(`    - ${tool.qualifiedName}${tool.description ? `: ${tool.description.split('\n')[0].slice(0, 100)}` : ''}`));
      }
      for (const resource of state.resources.slice(0, 20)) {
        lines.push(dim(`    · ${resource.uri} (${resource.name})`));
      }
    }
  }
  return lines;
}

function parseKeyValues(items: string[], separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items) {
    const index = item.indexOf(separator);
    if (index <= 0) throw new Error(`Expected KEY${separator}VALUE, got '${item}'.`);
    result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

async function cmdMcp(options: CliOptions): Promise<number> {
  const sub = options.args[0] || 'list';
  const trusted = options.trustProject || isTrusted(options.cwd);
  const makeRegistry = () => new McpRegistry({ cwd: options.cwd, trustProject: trusted, extraConfigs: options.mcpConfigs, strict: options.strictMcpConfig, log: (line) => { if (options.verbose) out(dim(line)); } });

  switch (sub) {
    case 'list':
    case 'ls': {
      const servers = loadMcpServers(options.cwd, { extraConfigs: options.mcpConfigs, strict: options.strictMcpConfig });
      if (servers.length === 0) {
        out(dim('No MCP servers configured. Add one with `pcode mcp add <name> -- <command>` or a .mcp.json file.'));
        return 0;
      }
      for (const server of servers) {
        const target = server.type === 'stdio' ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim() : server.url || '';
        process.stdout.write(`${server.name}\t${server.type}\t${server.scope}\t${server.disabled ? 'disabled' : (!trusted && server.type === 'stdio' && server.scope !== 'user' && server.scope !== 'cli') ? 'untrusted' : 'enabled'}\t${target}\t${server.sourceFile}\n`);
      }
      return 0;
    }
    case 'add': {
      const name = options.args[1];
      const rest = options.args.slice(2);
      if (!name || rest.length === 0) {
        out('usage: pcode mcp add <name> [-s user|project|local] [-t stdio|http|sse] [-e KEY=VALUE] [-H "Header: value"] -- <command|url> [args...]');
        return 64;
      }
      const isUrl = /^https?:\/\//i.test(rest[0]);
      const type: McpTransportType = options.mcpTransport || (isUrl ? 'http' : 'stdio');
      if ((type === 'http' || type === 'sse') && !isUrl) {
        out(red(`${type} transport needs an http(s) URL.`));
        return 64;
      }
      if (type === 'stdio' && isUrl) {
        out(red('stdio transport needs a command, not a URL (use -t http for remote servers).'));
        return 64;
      }
      const scope = options.mcpScope || (options.global ? 'user' : 'project');
      try {
        const file = saveMcpServerConfig(options.cwd, name, {
          type,
          command: type === 'stdio' ? rest[0] : undefined,
          args: type === 'stdio' ? rest.slice(1) : undefined,
          env: options.mcpEnv.length > 0 ? parseKeyValues(options.mcpEnv, '=') : undefined,
          url: type !== 'stdio' ? rest[0] : undefined,
          headers: options.mcpHeaders.length > 0 ? parseKeyValues(options.mcpHeaders, ':') : undefined,
        }, scope);
        out(`${green('✔')} ${name} (${type}, ${scope}) → ${file}`);
        if (scope !== 'user' && type === 'stdio' && !trusted) {
          out(dim('Project stdio servers start only in trusted folders (answer the trust prompt or pass --trust-project).'));
        }
        return 0;
      } catch (error) {
        out(red((error as Error).message));
        return 1;
      }
    }
    case 'remove':
    case 'rm': {
      const name = options.args[1];
      if (!name) {
        out('usage: pcode mcp remove <name> [-s user|project|local]');
        return 64;
      }
      const result = removeMcpServerConfig(options.cwd, name, options.mcpScope);
      if (!result.removed) {
        out(yellow(`No MCP server '${name}' found in the ${options.mcpScope || 'project, local or user'} configuration.`));
        return 1;
      }
      for (const file of result.files) out(`${green('✔')} removed ${name} from ${file}`);
      return 0;
    }
    case 'get':
    case 'test': {
      const name = options.args[1];
      const registry = makeRegistry();
      if (name && !registry.getStates().some((state) => state.config.name === name)) {
        out(red(`Unknown MCP server '${name}'. Configured: ${registry.getStates().map((state) => state.config.name).join(', ') || 'none'}.`));
        return 1;
      }
      try {
        if (name) await registry.connectServer(name);
        else await registry.connectAll();
        const states = registry.getStates().filter((state) => !name || state.config.name === name);
        for (const line of formatMcpStates(states, true)) out(line);
        const failed = states.filter((state) => state.status === 'error').length;
        return failed > 0 ? 1 : 0;
      } finally {
        await registry.closeAll().catch(() => undefined);
      }
    }
    default:
      out(red(`unknown mcp command '${sub}' (list, add, remove, get, test)`));
      return 64;
  }
}

async function cmdLogin(options: CliOptions): Promise<number> {
  const { state, secrets } = cliStores();
  const { AccountManager } = await import('../storage/accountManager');
  const manager = new AccountManager(state as never, secrets as never);
  await manager.initialize();
  let parsed: ReturnType<typeof parseCookieInput>;
  if (options.browser) {
    const result = await browserLogin((line) => out(line));
    if (!result) {
      out(red('Login was not completed.'));
      return 1;
    }
    parsed = result;
  } else {
    let input = process.env.PPLX_COOKIE || '';
    if (!input) {
      input = process.stdin.isTTY
        ? await promptHidden('Paste the Cookie header from perplexity.ai (DevTools → Network → any request → Cookie), input hidden:\n> ')
        : await readAllStdin();
    }
    parsed = parseCookieInput(input);
  }
  if (!parsed) {
    out(red('No __Secure-next-auth.session-token found in the input.'));
    return 1;
  }
  const alias = options.alias || options.args[0] || `Account ${manager.getAccounts().length + 1}`;
  const added = await manager.addAccount(alias, parsed.sessionToken, parsed.csrfToken === 'auto' ? '' : parsed.csrfToken, { fullCookies: parsed.fullCookies });
  if (!added.success) {
    out(red(added.error || 'Could not add the account.'));
    return 1;
  }
  out(green(`Added ${alias}. Stored in ${path.join(perplexicodeHome(), 'credentials.json')} (mode 0600).`));
  return 0;
}

async function cmdLogout(options: CliOptions): Promise<number> {
  const { state, secrets } = cliStores();
  const { AccountManager } = await import('../storage/accountManager');
  const manager = new AccountManager(state as never, secrets as never);
  await manager.initialize();
  const ref = options.args[0];
  const account = manager.getAccounts().find((a) => a.id === ref || a.alias === ref);
  if (!account) {
    out(red(`Account '${ref ?? ''}' not found.`));
    return 1;
  }
  await manager.removeAccount(account.id);
  out(`Removed ${account.alias}.`);
  return 0;
}

async function cmdAccounts(): Promise<number> {
  const { state, secrets } = cliStores();
  const { AccountManager } = await import('../storage/accountManager');
  const manager = new AccountManager(state as never, secrets as never);
  await manager.initialize();
  const accounts = manager.getAccounts();
  if (accounts.length === 0) out(dim('No accounts. Run `pcode login`.'));
  for (const a of accounts) {
    out(`${bold(a.alias)} ${dim(a.id)} · ${a.status} · plan ${a.capabilities?.plan || '?'} · ${a.queriesTotalLifetime} queries`);
  }
  return 0;
}

function cmdSessions(options: CliOptions): number {
  const sessions = listSessions({ workspace: options.cwd });
  if (sessions.length === 0) out(dim(`No saved sessions for ${options.cwd}.`));
  for (const s of sessions.slice(0, 30)) {
    process.stdout.write(`${s.id}  ${new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${s.status.padEnd(9)} ${s.mode.padEnd(12)} ${s.title}\n`);
  }
  return 0;
}

function cmdModels(): number {
  const catalog = getModelCatalog();
  for (const m of catalog.filter((x) => x.selectable !== false && x.surfaced !== false)) {
    process.stdout.write(`${m.id.padEnd(26)} ${m.label.padEnd(30)} ${m.requiredPlan}${m.supportsThinking ? ' · --thinking' : ''}\n`);
  }
  process.stdout.write(`\nCompute modes (--compute <mode>):\n`);
  for (const mode of COMPUTE_MODES) {
    process.stdout.write(`${mode.id.padEnd(26)} ${mode.label.padEnd(30)} ${mode.requiredPlan}${mode.defaultModelId ? ` · ${mode.defaultModelId}` : ''}\n`);
  }
  return 0;
}

function cmdLibraryAdd(kind: 'agent' | 'skill', options: CliOptions): number {
  const ids = options.args.slice(1);
  if (ids.length === 0) {
    out(`usage: pcode ${kind}s add <id...> [-g]. See pcode ${kind}s catalog.`);
    return 64;
  }
  const scope = options.global ? 'user' : 'project';
  let failed = 0;
  for (const id of ids) {
    try {
      const result = kind === 'agent' ? installAgentPreset(id, scope, { cwd: options.cwd }) : installSkillPreset(id, scope, { cwd: options.cwd });
      out(`${green('✔')} ${id} → ${result.file}`);
    } catch (error) {
      failed++;
      out(`${(error as NodeJS.ErrnoException).code === 'EEXIST' ? yellow('!') : red('✖')} ${id}: ${(error as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

function cmdCatalog(kind: 'agent' | 'skill', options: CliOptions): number {
  const snapshot = librarySnapshot({ cwd: options.cwd });
  const rows = kind === 'agent' ? snapshot.agentPresets : snapshot.skillPresets;
  for (const row of rows) {
    process.stdout.write(`${row.id}\t${row.installed || '-'}\t${row.description}\n`);
  }
  return 0;
}

function cmdPresets(options: CliOptions): number {
  for (const preset of loadTaskPresets({ cwd: options.cwd })) {
    process.stdout.write(`${preset.id}\t${preset.mode}\t${preset.agent ? `@${preset.agent}` : '-'}\t${preset.source}\t${preset.title}\n`);
  }
  return 0;
}

/** Applies --preset: mode, subagent and prompt template (installing missing presets is explicit). */
function applyPresetOption(options: CliOptions): void {
  if (!options.preset) return;
  const preset = loadTaskPresets({ cwd: options.cwd }).find((entry) => entry.id === options.preset);
  if (!preset) throw new Error(`Unknown preset '${options.preset}'. Run \`pcode presets\`.`);
  options.mode = preset.mode;
  options.agent = options.agent || preset.agent;
  if (!options.continue && !options.resume) {
    options.prompt = applyPresetPrompt(preset, options.prompt || '');
  }
  const installed = new Set(loadSubagents(options.cwd).map((agent) => agent.name));
  const missing = [...(preset.requires?.agents || []), ...(preset.agent ? [preset.agent] : [])].filter((name, index, list) => list.indexOf(name) === index && !installed.has(name));
  if (missing.length > 0) {
    out(dim(`preset '${preset.id}' works best with: ${missing.join(', ')} (pcode agents add ${missing.join(' ')})`));
  }
}

function cmdAgents(options: CliOptions): number {
  if (options.args[0] === 'add') return cmdLibraryAdd('agent', options);
  if (options.args[0] === 'catalog') return cmdCatalog('agent', options);
  const agents = loadSubagents(options.cwd);
  if (agents.length === 0) out(dim('No subagents. Add .perplexicode/agents/<name>.md or .claude/agents/<name>.md.'));
  for (const a of agents) process.stdout.write(`${a.name}\t${a.scope}\t${a.mode}\t${a.tools ? a.tools.join(',') : '*'}\t${a.description}\n`);
  return 0;
}

function cmdSkills(options: CliOptions): number {
  if (options.args[0] === 'add') return cmdLibraryAdd('skill', options);
  if (options.args[0] === 'catalog') return cmdCatalog('skill', options);
  const skills = loadSkills(options.cwd);
  if (skills.length === 0) out(dim('No skills. Add .perplexicode/skills/<name>/SKILL.md or .claude/skills/<name>/SKILL.md.'));
  for (const k of skills) process.stdout.write(`${k.name}\t${k.scope}\t${k.description}\n`);
  return 0;
}

async function cmdDoctor(options: CliOptions): Promise<number> {
  const ok = (cond: boolean, text: string) => out(`${cond ? green('✔') : yellow('!')} ${text}`);
  const has = (bin: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
  ok(Number(process.versions.node.split('.')[0]) >= 18, `node ${process.versions.node}`);
  ok(true, `cwd ${options.cwd}`);
  ok(has('rg'), `ripgrep ${has('rg') ? 'found' : 'not found (search_files falls back to a slower scan)'}`);
  ok(has('git'), `git ${has('git') ? 'found' : 'not found'}`);
  const { state, secrets } = cliStores();
  const { AccountManager } = await import('../storage/accountManager');
  const manager = new AccountManager(state as never, secrets as never);
  await manager.initialize();
  ok(manager.getAccounts().length > 0, `Perplexity accounts: ${manager.getAccounts().length}`);
  ok(true, `OpenAI-compatible: ${openAIOptionsFromEnv().baseUrl} (${openAIOptionsFromEnv().model})`);
  const trusted = isTrusted(options.cwd);
  const settings = loadSettings(options.cwd, { trustProjectHooks: trusted });
  ok(true, `permission mode: ${settings.permissions.defaultMode} · allow ${settings.permissions.allow.length} · ask ${settings.permissions.ask.length} · deny ${settings.permissions.deny.length} · protectSecrets ${settings.permissions.protectSecrets}`);
  for (const source of settings.sources) out(dim(`    ${source.scope.padEnd(7)} ${source.file} (rules ${source.rules}, hooks ${source.hooks})`));
  ok(!projectDefinesHooks(options.cwd) || trusted, `project hooks: ${projectDefinesHooks(options.cwd) ? (trusted ? 'trusted' : 'defined but untrusted') : 'none'}`);
  ok(true, `verify command: ${settings.verify.command || 'none'}`);
  ok(true, `compute mode: ${settings.computeMode || process.env.PCODE_COMPUTE || 'search'}`);
  const mcpServers = loadMcpServers(options.cwd, { extraConfigs: options.mcpConfigs });
  const untrustedMcp = mcpServers.filter((server) => !server.disabled && server.type === 'stdio' && (server.scope === 'project' || server.scope === 'local') && !trusted);
  ok(untrustedMcp.length === 0, `MCP servers: ${mcpServers.length}${mcpServers.length ? ` (${mcpServers.map((server) => `${server.name}:${server.type}`).join(', ')})` : ''}${untrustedMcp.length ? ` · ${untrustedMcp.length} project stdio server(s) skipped until trusted` : ''}`);
  for (const server of mcpServers) out(dim(`    ${server.scope.padEnd(7)} ${server.name} ← ${server.sourceFile}`));
  ok(true, `subagents: ${loadSubagents(options.cwd).length} · skills: ${loadSkills(options.cwd).length}`);
  ok(true, `sessions: ${sessionsDir()} (${listSessions({ workspace: options.cwd }).length} for this folder)`);
  ok(os.platform() !== 'win32' || has('sh'), `shell: ${process.platform === 'win32' ? 'cmd/PowerShell (hooks need sh)' : '/bin/sh'}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(red((error as Error).message));
    return 64;
  }
  if (options.help || options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version || options.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!fs.existsSync(options.cwd)) {
    out(red(`--cwd ${options.cwd} does not exist`));
    return 64;
  }
  try {
    switch (options.command) {
      case 'login': return await cmdLogin(options);
      case 'logout': return await cmdLogout(options);
      case 'accounts': return await cmdAccounts();
      case 'sessions': return cmdSessions(options);
      case 'models': return cmdModels();
      case 'agents': return cmdAgents(options);
      case 'presets': return cmdPresets(options);
      case 'skills': return cmdSkills(options);
      case 'mcp': return await cmdMcp(options);
      case 'doctor': return await cmdDoctor(options);
      default:
        applyPresetOption(options);
        if (options.print || !process.stdin.isTTY || !process.stderr.isTTY) {
          options.print = true;
          return await runHeadless(options);
        }
        return await runInteractive(options);
    }
  } catch (error) {
    if (options.outputFormat !== 'text' && options.print) {
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error', result: (error as Error).message })}\n`);
    } else {
      out(red(`✖ ${(error as Error).message}`));
    }
    return 1;
  }
}
