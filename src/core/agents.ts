import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODES } from '../agent/modes';
import { parseRule, ruleCoversTool } from './permissions';

/**
 * File based subagents, skills and memory, compatible with Claude Code layouts:
 *
 *   .perplexicode/agents/*.md   .claude/agents/*.md   ~/.perplexicode/agents   ~/.claude/agents
 *   .perplexicode/skills/<name>/SKILL.md   .claude/skills/<name>/SKILL.md   (and the ~ variants)
 *   CLAUDE.md  CLAUDE.local.md  .claude/CLAUDE.md  PERPLEXICODE.md  ~/.claude/CLAUDE.md
 *
 * Agent file:
 *   ---
 *   name: reviewer
 *   description: Reviews diffs for bugs and security issues. Use after edits.
 *   tools: Read, Grep, Bash(git diff:*)
 *   model: claude46sonnet        # optional Perplexity model id
 *   mode: review                 # optional Kilo mode, inferred from tools otherwise
 *   ---
 *   System prompt of the agent...
 */

export interface SubagentDefinition {
  name: string;
  description: string;
  /** Raw tool entries from frontmatter; undefined = inherit all tools. */
  tools?: string[];
  model?: string;
  mode: string;
  prompt: string;
  file: string;
  scope: 'project' | 'user';
}

export interface SkillDefinition {
  name: string;
  description: string;
  file: string;
  scope: 'project' | 'user';
}

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/** Minimal YAML frontmatter reader: `key: value` pairs, quoted values, `[a, b]` and `- item` lists. */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: normalized.trim() };
  }
  const data: Record<string, string> = {};
  let listKey: string | undefined;
  for (const line of match[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      data[listKey] = data[listKey] ? `${data[listKey]}, ${unquote(item[1])}` : unquote(item[1]);
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) {
      continue;
    }
    const value = pair[2].trim();
    listKey = value === '' ? pair[1] : undefined;
    data[pair[1]] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((entry) => unquote(entry.trim())).filter(Boolean).join(', ')
      : unquote(value);
  }
  return { data, body: match[2].trim() };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

/** Splits "Read, Grep, Bash(git diff:*)" while keeping commas inside parentheses. */
export function splitToolList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function inferMode(tools: string[] | undefined, explicit: string | undefined): string {
  if (explicit && MODES.some((mode) => mode.slug === explicit)) {
    return explicit;
  }
  if (!tools) {
    return 'code';
  }
  const canEdit = tools.some((entry) => {
    const rule = parseRule(entry);
    return Boolean(rule && (ruleCoversTool(rule.tool, 'write_to_file') || ruleCoversTool(rule.tool, 'apply_diff')));
  });
  return canEdit ? 'code' : 'review';
}

function agentDirs(cwd: string, home: string): Array<{ dir: string; scope: 'project' | 'user' }> {
  return [
    { dir: path.join(cwd, '.perplexicode', 'agents'), scope: 'project' },
    { dir: path.join(cwd, '.claude', 'agents'), scope: 'project' },
    { dir: path.join(home, '.perplexicode', 'agents'), scope: 'user' },
    { dir: path.join(home, '.claude', 'agents'), scope: 'user' },
  ];
}

export function loadSubagents(cwd: string, home = os.homedir()): SubagentDefinition[] {
  const seen = new Map<string, SubagentDefinition>();
  for (const { dir, scope } of agentDirs(cwd, home)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const agentName = (data.name || name.replace(/\.md$/, '')).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        if (!agentName || seen.has(agentName) || MODES.some((mode) => mode.slug === agentName)) {
          continue; // project definitions shadow user ones; built-in modes cannot be redefined.
        }
        const tools = data.tools ? splitToolList(data.tools) : undefined;
        seen.set(agentName, {
          name: agentName,
          description: data.description || body.split('\n')[0].slice(0, 200),
          tools: tools && tools.length > 0 ? tools : undefined,
          model: data.model && data.model !== 'inherit' ? data.model : undefined,
          mode: inferMode(tools, data.mode),
          prompt: body,
          file,
          scope,
        });
      } catch {
        // Unreadable agent file; skip.
      }
    }
  }
  return [...seen.values()];
}

export function loadSkills(cwd: string, home = os.homedir()): SkillDefinition[] {
  const seen = new Map<string, SkillDefinition>();
  const roots: Array<{ dir: string; scope: 'project' | 'user' }> = [
    { dir: path.join(cwd, '.perplexicode', 'skills'), scope: 'project' },
    { dir: path.join(cwd, '.claude', 'skills'), scope: 'project' },
    { dir: path.join(home, '.perplexicode', 'skills'), scope: 'user' },
    { dir: path.join(home, '.claude', 'skills'), scope: 'user' },
  ];
  for (const { dir, scope } of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name, 'SKILL.md');
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const name = (data.name || entry.name).trim();
        if (seen.has(name)) continue;
        seen.set(name, { name, description: data.description || body.split('\n')[0].slice(0, 200), file, scope });
      } catch {
        // No SKILL.md in this folder.
      }
    }
  }
  return [...seen.values()];
}

export const MEMORY_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'PERPLEXICODE.md', '.perplexicode/PERPLEXICODE.md'];

export function loadMemory(cwd: string, home = os.homedir()): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const candidates = [path.join(home, '.claude', 'CLAUDE.md'), path.join(home, '.perplexicode', 'PERPLEXICODE.md'), ...MEMORY_FILES.map((file) => path.join(cwd, file))];
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 200_000) continue;
      const text = expandImports(fs.readFileSync(file, 'utf8'), path.dirname(file), home, 0).trim();
      if (text) out.push({ file, text });
    } catch {
      // Missing memory file.
    }
  }
  return out;
}

/** CLAUDE.md "@path/to/file" imports, max depth 4 like Claude Code (5 hops). */
function expandImports(text: string, baseDir: string, home: string, depth: number): string {
  if (depth >= 4) return text;
  return text.replace(/^@(\S+)\s*$/gm, (line, ref: string) => {
    const target = ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.resolve(baseDir, ref);
    try {
      return expandImports(fs.readFileSync(target, 'utf8'), path.dirname(target), home, depth + 1);
    } catch {
      return line;
    }
  });
}

/** System prompt section describing memory, subagents and skills. */
export function formatSessionContext(cwd: string, options: { home?: string; includeAgents?: boolean } = {}): string {
  const home = options.home || os.homedir();
  const sections: string[] = [];
  for (const memory of loadMemory(cwd, home)) {
    sections.push(`# Project memory from ${displayPath(cwd, memory.file, home)}:\n${memory.text}`);
  }
  if (options.includeAgents !== false) {
    const agents = loadSubagents(cwd, home);
    if (agents.length > 0) {
      sections.push([
        '# Subagents',
        'Specialised agents you can delegate to with new_task. Put the agent name in <mode> (instead of a mode slug) and a self-contained brief in <message>. Each runs in its own context and returns a summary.',
        ...agents.map((agent) => `- ${agent.name}: ${agent.description}${agent.tools ? ` (tools: ${agent.tools.join(', ')})` : ''}`),
      ].join('\n'));
    }
  }
  const skills = loadSkills(cwd, home);
  if (skills.length > 0) {
    sections.push([
      '# Skills',
      'Skills are instruction packs. When a task matches a skill, first read its SKILL.md with read_file and follow it; read referenced files only when needed.',
      ...skills.map((skill) => `- ${skill.name}: ${skill.description} -> ${displayPath(cwd, skill.file, home)}`),
    ].join('\n'));
  }
  return sections.join('\n\n');
}

function displayPath(cwd: string, file: string, home: string): string {
  const rel = path.relative(cwd, file);
  if (!rel.startsWith('..')) return rel.split(path.sep).join('/');
  return file.startsWith(home) ? `~/${path.relative(home, file).split(path.sep).join('/')}` : file;
}
