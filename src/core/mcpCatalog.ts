import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers, saveMcpServerConfig } from './mcp';

export type McpCatalogConfig = Parameters<typeof saveMcpServerConfig>[2];
export type McpCatalogScope = 'project' | 'user' | 'local';

export interface McpCatalogInput {
  /** Secret input keys are environment-variable names, never token values. */
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  /** Non-secret defaults may contain {cwd}, resolved against the install workspace. */
  default?: string;
}

export interface McpCatalogEntry {
  id: string;
  title: string;
  description: string;
  category: 'development' | 'web' | 'productivity' | 'security' | 'pentest';
  docsUrl: string;
  requirements: string[];
  notes: string;
  risk: 'standard' | 'sensitive' | 'active';
  /** Primary documentation checked on this date; not a live runtime certification. */
  checkedAt: string;
  /** Absent for setup-only guides requiring a native application or manual review. */
  config?: McpCatalogConfig;
  inputs: McpCatalogInput[];
}

const CHECKED_AT = '2026-11-07';
const REFERENCE_NOTE = 'Reference implementation, not a production security guarantee. ';

/**
 * Curated examples, not a popularity ranking or an audited package allowlist.
 * Primary documentation/configuration was checked on checkedAt; packages, remote
 * services, Linux/Parrot installations and authentication were not runtime-tested.
 * Installing a template neither executes a server nor installs its dependencies.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'filesystem',
    title: 'Filesystem',
    description: 'Read, write, and search files inside explicitly allowed directories.',
    category: 'development',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    requirements: ['Node.js 24+ and npx', 'An explicitly authorized local directory'],
    notes: `${REFERENCE_NOTE}Defaults to this workspace, not the whole home directory. Tools can modify files; review permissions before connecting.`,
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{input:DIRECTORY}'] },
    inputs: [{ key: 'DIRECTORY', label: 'Allowed directory', secret: false, required: true, default: '{cwd}' }],
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Keep a persistent local knowledge graph across sessions.',
    category: 'productivity',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    requirements: ['Node.js 24+ and npx', 'A writable storage-file location'],
    notes: `${REFERENCE_NOTE}Memory may contain sensitive data. The default storage file stays under this workspace; do not commit private memory to version control.`,
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: {
      type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
      env: { MEMORY_FILE_PATH: '{input:MEMORY_FILE_PATH}' },
    },
    inputs: [{ key: 'MEMORY_FILE_PATH', label: 'Memory JSONL file', secret: false, required: true, default: '{cwd}/.perplexicode-memory.jsonl' }],
  },
  {
    id: 'sequential-thinking',
    title: 'Sequential Thinking',
    description: 'A structured tool for iterative, multi-step problem solving.',
    category: 'productivity',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    requirements: ['Node.js 24+ and npx'],
    notes: `${REFERENCE_NOTE}Thought logging is disabled in this template. This is a planning aid, not a correctness or verification mechanism.`,
    risk: 'standard',
    checkedAt: CHECKED_AT,
    config: {
      type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      env: { DISABLE_THOUGHT_LOGGING: 'true' },
    },
    inputs: [],
  },
  {
    id: 'fetch',
    title: 'Fetch',
    description: 'Retrieve web content and convert it into text for an assistant.',
    category: 'web',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    requirements: ['Python and uv/uvx', 'Network access to approved destinations'],
    notes: `${REFERENCE_NOTE}Network access is not a sandbox. Restrict destinations and avoid internal services, private URLs, and untrusted prompt instructions in fetched pages.`,
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    inputs: [],
  },
  {
    id: 'git',
    title: 'Git',
    description: 'Inspect and manipulate a local Git repository.',
    category: 'development',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    requirements: ['Python and uv/uvx', 'Git', 'An authorized Git repository'],
    notes: `${REFERENCE_NOTE}The repository argument defaults to this workspace. Git tools can mutate repository state; review tool requests.`,
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '{input:REPOSITORY}'] },
    inputs: [{ key: 'REPOSITORY', label: 'Git repository directory', secret: false, required: true, default: '{cwd}' }],
  },
  {
    id: 'time',
    title: 'Time',
    description: 'Look up the current time and convert between time zones.',
    category: 'productivity',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    requirements: ['Python and uv/uvx'],
    notes: `${REFERENCE_NOTE}Uses the server's local timezone unless configured otherwise; no account token is required.`,
    risk: 'standard',
    checkedAt: CHECKED_AT,
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
    inputs: [],
  },
  {
    id: 'playwright',
    title: 'Playwright',
    description: 'Microsoft browser automation for testing authorized websites.',
    category: 'web',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    requirements: ['Node.js 18+ and npx', 'A browser and required operating-system browser dependencies'],
    notes: 'Starts with a headless, isolated browser profile. Browser actions can send requests and change remote data. Playwright MCP is not a security boundary; no --no-sandbox flag is added.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'] },
    inputs: [],
  },
  {
    id: 'chrome-devtools',
    title: 'Chrome DevTools',
    description: 'Inspect, debug, and profile a Chrome browser through DevTools.',
    category: 'web',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    requirements: ['Node.js LTS and npx', 'Current stable Google Chrome or newer'],
    notes: 'Browser contents and debugging data are exposed to the assistant. Usage statistics and CrUX trace-URL sharing are opted out in this template. Use only a dedicated browser for authorized testing.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: {
      type: 'stdio', command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--no-usage-statistics', '--no-performance-crux'],
    },
    inputs: [],
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Retrieve current library documentation and code examples.',
    category: 'development',
    docsUrl: 'https://context7.com/docs/resources/all-clients',
    requirements: ['A Context7 API key', 'HTTPS access to mcp.context7.com'],
    notes: 'Uses the official remote HTTP endpoint instead of putting a token in process arguments. Supply CONTEXT7_API_KEY through the environment or supported secret storage; documentation queries leave this machine.',
    risk: 'standard',
    checkedAt: CHECKED_AT,
    config: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer ${CONTEXT7_API_KEY}' } },
    inputs: [{ key: 'CONTEXT7_API_KEY', label: 'Context7 API key environment variable', secret: true, required: true }],
  },
  {
    id: 'github',
    title: 'GitHub',
    description: 'The official GitHub remote MCP server for repositories, issues, and pull requests.',
    category: 'development',
    docsUrl: 'https://github.com/github/github-mcp-server',
    requirements: ['A GitHub personal access token with minimal repository permissions', 'HTTPS access to api.githubcopilot.com', 'Any applicable organization access approval'],
    notes: 'Uses the official remote service, not the archived @modelcontextprotocol/server-github npm package. Supply GITHUB_PERSONAL_ACCESS_TOKEN securely. Token permissions determine access and possible write actions.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
    inputs: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub PAT environment variable', secret: true, required: true }],
  },
  {
    id: 'notion',
    title: 'Notion',
    description: 'Read and update Notion workspace content through its maintained hosted MCP service.',
    category: 'productivity',
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    requirements: ['Notion Business or Enterprise for non-interactive MCP tokens', 'A workspace owner must create a Notion MCP token', 'HTTPS access to mcp.notion.com'],
    notes: 'This template requires a Notion MCP token, not an integration token. Other plans require interactive OAuth, which this client does not implement. The old @notionhq/notion-mcp-server is no longer actively maintained; it is intentionally not installed.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer ${NOTION_MCP_TOKEN}' } },
    inputs: [{ key: 'NOTION_MCP_TOKEN', label: 'Notion MCP token environment variable', secret: true, required: true }],
  },
  {
    id: 'linear',
    title: 'Linear',
    description: 'Find and manage Linear issues, projects, and workspace data.',
    category: 'productivity',
    docsUrl: 'https://linear.app/docs/mcp',
    requirements: ['A Linear API key or existing OAuth access token', 'HTTPS access to mcp.linear.app'],
    notes: 'Uses bearer-token authentication, not an automatic OAuth flow. Prefer a minimally scoped read-only API key when possible. This read-write endpoint can modify workspace data if the token allows it.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' } },
    inputs: [{ key: 'LINEAR_API_KEY', label: 'Linear API key/token environment variable', secret: true, required: true }],
  },
  {
    id: 'sentry',
    title: 'Sentry',
    description: 'Investigate Sentry errors, events, and project diagnostics.',
    category: 'development',
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
    requirements: ['Node.js and npx', 'A minimally scoped Sentry user auth token'],
    notes: 'Uses SENTRY_AUTH_TOKEN (the older SENTRY_ACCESS_TOKEN name is deprecated). Optional AI search requires an additional provider/key configured manually; basic setup does not add provider credentials. Review scopes and sensitive event data before connecting.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    config: { type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server@latest'], env: { SENTRY_AUTH_TOKEN: '${SENTRY_AUTH_TOKEN}' } },
    inputs: [{ key: 'SENTRY_AUTH_TOKEN', label: 'Sentry auth token environment variable', secret: true, required: true }],
  },
  {
    id: 'semgrep-security',
    title: 'Semgrep MCP',
    description: 'Local static analysis through the official Semgrep CLI.',
    category: 'security',
    docsUrl: 'https://github.com/semgrep/semgrep/blob/develop/cli/src/semgrep/mcp/README.md',
    requirements: ['Semgrep CLI on PATH', 'An explicitly authorized project'],
    notes: 'Setup guide only: review and install Semgrep, then configure semgrep mcp manually. The former semgrep/mcp repository is archived; do not use the old uvx semgrep-mcp instructions. Review which analysis modes send code to external services.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'snyk-security',
    title: 'Snyk MCP',
    description: 'Dependency and source-code security analysis through the official Snyk CLI.',
    category: 'security',
    docsUrl: 'https://docs.snyk.io/agent-security/agentic-security-with-snyk-studio/getting-started-with-snyk-studio',
    requirements: ['Node.js and npx or an installed Snyk CLI', 'Snyk authorization', 'Permission to submit relevant project data'],
    notes: 'Setup guide only: official stdio example is npx -y snyk@latest mcp -t stdio. First run downloads code; Snyk services may process code or findings. Do not describe this setup as offline.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'burp-suite-mcp',
    title: 'Burp Suite MCP',
    description: 'The official PortSwigger bridge to Burp traffic history and testing tools.',
    category: 'pentest',
    docsUrl: 'https://github.com/PortSwigger/mcp-server',
    requirements: ['Burp Suite', 'The MCP Server extension', 'Java and the installed mcp-proxy-all.jar for stdio'],
    notes: 'Setup guide only: configure the native extension and its local proxy before adding a server. The documented local HTTP endpoint is http://127.0.0.1:9876/mcp. Keep request/history approvals enabled. Test only systems with explicit authorization; never expose this bridge publicly.',
    risk: 'active',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'ghidra-mcp',
    title: 'GhidraMCP (community)',
    description: 'Reverse-engineer authorized binaries in a local Ghidra project.',
    category: 'security',
    docsUrl: 'https://github.com/LaurieWired/GhidraMCP',
    requirements: ['Ghidra 12.1.4 as documented upstream', 'An installed, enabled GhidraMCP extension', 'uv'],
    notes: 'Setup guide only: community project, not an official NSA integration. Review the extension and local bridge before connecting. Tools can change Ghidra names/annotations; back up the project and do not execute an untrusted binary.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'virustotal-mcp',
    title: 'VirusTotal MCP',
    description: 'Official threat-intelligence reports for hashes, URLs, domains, and IP addresses.',
    category: 'security',
    docsUrl: 'https://github.com/VirusTotal/virustotal-mcp',
    requirements: ['Python 3.12+ and uv for local stdio', 'A VTAI account and protected token file'],
    notes: 'Setup guide only: review the official vt-mcp local installation and VTAI_TOKEN_FILE configuration. Remote OAuth is not handled by this client. Do not automatically upload files or submit URLs; standard submissions are not confidential.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'zap-mcp',
    title: 'ZAP MCP Integration',
    description: 'The official ZAP add-on for web testing, traffic review, and scan findings.',
    category: 'pentest',
    docsUrl: 'https://www.zaproxy.org/docs/desktop/addons/mcp-integration/',
    requirements: ['ZAP with the MCP Integration add-on', 'Java 17+ for Linux ZAP', 'A configured security key and trusted TLS certificate'],
    notes: 'Setup guide only: enable Options > MCP Integration in the native application. The documented port is 8282 with HTTPS secure-only by default and Authorization: <security-key>, not Bearer. Keep localhost-only access. Active tests require explicit target authorization; never disable TLS checks to simplify setup.',
    risk: 'active',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'nmap-mcp',
    title: 'Nmap MCP (community)',
    description: 'A community wrapper for authorized network discovery and host/service analysis.',
    category: 'pentest',
    docsUrl: 'https://github.com/creimer808/nmap-mcp',
    requirements: ['Python 3.11+', 'nmap on PATH', 'uv and a reviewed local checkout', 'Explicit target-owner permission'],
    notes: 'Setup guide only: upstream uses uv --directory /path/to/nmap-mcp run nmap-mcp. This launches active network scans despite bounded flags/runtime. No automatic scans, root access, privilege escalation, or production/Parrot certification are provided.',
    risk: 'active',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
  {
    id: 'shodan-mcp',
    title: 'Shodan MCP (community)',
    description: 'A community interface to Shodan host intelligence, DNS, CVEs, and exposure search.',
    category: 'security',
    docsUrl: 'https://github.com/aethrox/shodan-mcp',
    requirements: ['Node.js 20+', 'A Shodan API key and suitable plan', 'A reviewed local checkout and installed npm dependencies'],
    notes: 'Setup guide only: upstream runs node with the absolute path to index.js and SHODAN_API_KEY. Listed tools are lookups/search, not active scanning. Queries leave this machine, may consume paid quota, and may expose sensitive research context. Keep tokens out of shared JSON.',
    risk: 'sensitive',
    checkedAt: CHECKED_AT,
    inputs: [],
  },
];

export function findMcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

function requireCatalogEntry(id: string): McpCatalogEntry {
  const entry = findMcpCatalogEntry(id);
  if (!entry) throw new Error(`Unknown MCP catalog entry '${id}'. See pcode mcp catalog.`);
  return entry;
}

function resolveWorkspace(cwd: string): string {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    throw new Error('MCP catalog installation requires a valid workspace directory.');
  }
  return path.resolve(cwd);
}

/**
 * Build JSON-safe configuration. Secret values never enter the config:
 * callers set the named environment variables (or use editor SecretStorage).
 * The only accepted secret input value is the corresponding literal ${KEY}.
 */
export function buildMcpCatalogConfig(id: string, values: Record<string, string>, cwd: string): McpCatalogConfig {
  const entry = requireCatalogEntry(id);
  if (!entry.config) {
    throw new Error(`${entry.title} requires manual setup. Follow ${entry.docsUrl}`);
  }
  const workspace = resolveWorkspace(cwd);
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('MCP catalog input values must be a key/value object.');
  }
  const prototype = Object.getPrototypeOf(values);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('MCP catalog input values must be a plain key/value object.');
  }
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(values)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error('Unsafe MCP catalog input key.');
    }
    const input = entry.inputs.find((candidate) => candidate.key === key);
    if (!input) throw new Error(`Unknown input '${key}' for MCP catalog entry '${id}'.`);
    if (typeof values[key] !== 'string') throw new Error(`MCP catalog input '${key}' must be a string.`);
    if (input.secret && values[key] !== '${' + key + '}') {
      throw new Error(`Do not pass a raw secret for '${key}'. Set the ${key} environment variable or use secret storage.`);
    }
  }
  for (const input of entry.inputs) {
    if (input.secret) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(input.key)) throw new Error('Invalid secret environment-variable name in catalog.');
      resolved[input.key] = '${' + input.key + '}';
      continue;
    }
    const supplied = Object.prototype.hasOwnProperty.call(values, input.key);
    const value = supplied ? values[input.key] : (input.default || '').replace(/\{cwd\}/g, () => workspace);
    if (input.required && !value.trim()) throw new Error(`Required MCP catalog input '${input.key}' is missing.`);
    // The MCP loader expands ${...}; never let a non-secret input introduce it.
    if (value.includes('\0') || value.includes('${') || value.includes('{input:')) {
      throw new Error(`MCP catalog input '${input.key}' must be literal text without environment/template expressions.`);
    }
    resolved[input.key] = value;
  }
  const substitute = (value: string): string => value.replace(/\{input:([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(resolved, key)) throw new Error(`Unresolved MCP catalog template input '${key}'.`);
    return resolved[key];
  });
  const mapStrings = (value: Record<string, string> | undefined): Record<string, string> | undefined =>
    value ? Object.fromEntries(Object.entries(value).map(([key, text]) => [key, substitute(text)])) : undefined;
  const template = entry.config;
  const result: McpCatalogConfig = { ...template };
  if (template.command !== undefined) result.command = substitute(template.command);
  if (template.args !== undefined) result.args = template.args.map(substitute);
  if (template.env !== undefined) result.env = mapStrings(template.env);
  if (template.headers !== undefined) result.headers = mapStrings(template.headers);
  if (template.url !== undefined) result.url = substitute(template.url);
  if (template.cwd !== undefined) result.cwd = substitute(template.cwd);
  if (entry.risk === 'active') result.disabled = true;
  return result;
}

/** Inspect raw names too, so malformed/disabled definitions cannot be overwritten. */
function existingDefinition(cwd: string, home: string, id: string): string | undefined {
  const configured = loadMcpServers(cwd, { home, env: {} }).find((server) => server.name === id);
  if (configured) return configured.sourceFile;
  const claudeFile = path.join(home, '.claude.json');
  const files = [
    claudeFile,
    ...['.claude/.mcp.json', '.claude/mcp.json', '.perplexicode/mcp.json', '.claude/settings.json', '.perplexicode/settings.json'].map((file) => path.join(home, file)),
    ...['.mcp.json', '.claude/.mcp.json', '.claude/mcp.json', '.perplexicode/mcp.json', '.claude/settings.json', '.perplexicode/settings.json', '.mcp.local.json', '.claude/settings.local.json', '.perplexicode/settings.local.json'].map((file) => path.join(cwd, file)),
  ];
  const hasName = (map: unknown): boolean => Boolean(map && typeof map === 'object' && !Array.isArray(map)
    && Object.keys(map).some((name) => name.trim() === id));
  for (const file of files) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (hasName(raw.mcpServers)) return file;
    if (file === claudeFile) {
      const projects = raw.projects as Record<string, { mcpServers?: unknown }> | undefined;
      if (projects && hasName(projects[cwd]?.mcpServers)) return file;
    } else if (/^(?:\.mcp(?:\.local)?|mcp)\.json$/i.test(path.basename(file)) && hasName(raw)) {
      return file;
    }
  }
  return undefined;
}

function validateInstallTarget(file: string): void {
  if (!fs.existsSync(file)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Refusing to replace unreadable or invalid MCP JSON at ${file}. Repair it first.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`MCP configuration at ${file} must be a JSON object. Repair it first.`);
  }
  const root = raw as Record<string, unknown>;
  if ('mcpServers' in root && (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers))) {
    throw new Error(`Invalid mcpServers object at ${file}. Repair it first.`);
  }
  if (/^(?:\.mcp(?:\.local)?|mcp)\.json$/i.test(path.basename(file))
    && !('mcpServers' in root) && Object.entries(root).some(([key, value]) =>
    key !== '$schema' && value && typeof value === 'object' && !Array.isArray(value)
    && ('command' in value || 'url' in value))) {
    throw new Error(`MCP configuration at ${file} uses a bare server map. Wrap existing servers in "mcpServers" before installing a catalog entry.`);
  }
}

/** Save a template without spawning, downloading, connecting, or granting permissions. */
export function installMcpCatalogEntry(
  id: string,
  scope: McpCatalogScope,
  options: { cwd: string; home?: string; values?: Record<string, string> }
): string {
  if (!['project', 'user', 'local'].includes(scope)) throw new Error('MCP catalog scope must be project, user, or local.');
  const config = buildMcpCatalogConfig(id, options.values || {}, options.cwd);
  const cwd = resolveWorkspace(options.cwd);
  const home = path.resolve(options.home || os.homedir());
  const existing = existingDefinition(cwd, home, id);
  if (existing) throw new Error(`MCP server '${id}' already exists in ${existing}. Remove or rename it explicitly before installing; no configuration was changed.`);
  const target = scope === 'user' ? path.join(home, '.perplexicode', 'mcp.json')
    : scope === 'local' ? path.join(cwd, '.perplexicode', 'settings.local.json')
      : path.join(cwd, '.mcp.json');
  validateInstallTarget(target);
  return saveMcpServerConfig(cwd, id, config, scope, home);
}
