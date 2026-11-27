import * as crypto from 'crypto';
import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { DnsLookupFn, validateSafeFetchUrl } from '../agent/ssrf';
import { parseFrontmatter } from './agents';
import { LibraryPaths, LibraryScope, normalizeName } from './library';

/**
 * 4.1 Auto Skill: find and install Agent Skills (SKILL.md folders) from public sources, the way
 * OpenClaw does it (`openclaw skills install @owner/slug | skills-sh:owner/repo/slug | git:owner/repo@ref`).
 *
 * Sources:
 *   clawhub:owner/slug  @owner/slug         ClawHub registry (https://clawhub.ai, hosted ZIP or GitHub handoff)
 *   skills-sh:owner/repo/slug                skills.sh index (the skill lives in a public GitHub repo)
 *   git:owner/repo[/path][@ref]  github:…    any public GitHub repo; https://github.com/o/r/tree/ref/path works too
 *   https://…/SKILL.md                       a single SKILL.md file
 *   ./path  /abs/path  ~/path                a local folder with SKILL.md
 *
 * Safety: every request goes through the SSRF validator with a pinned DNS answer; size and file
 * count are capped; archive paths are confined to the skill folder; content is scanned for risky
 * patterns before anything is written; scripts are written as files and never executed here. The
 * install is recorded in `<scope>/.perplexicode/skills-lock.json` with the source and SHA-256 so
 * `verify` and `update` can detect local edits and upstream changes. GitHub tokens (GITHUB_TOKEN /
 * GH_TOKEN) are only sent to api.github.com and never logged.
 */

export type SkillSourceKind = 'clawhub' | 'skills-sh' | 'github' | 'url' | 'local';
export type SkillRegistry = 'clawhub' | 'skills-sh';
export const SKILL_REGISTRIES: SkillRegistry[] = ['clawhub', 'skills-sh'];

export interface SkillSourceSpec {
  kind: SkillSourceKind;
  /** Normalized spec stored in the lock file (`clawhub:owner/slug`, `git:owner/repo/path@ref`, …). */
  spec: string;
  owner?: string;
  repo?: string;
  /** Folder inside the repository (github) or skill slug (clawhub, skills-sh). */
  path?: string;
  slug?: string;
  ref?: string;
  url?: string;
  localPath?: string;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function cleanRepoPath(value: string): string {
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) throw new Error(`Invalid path "${value}" in skill source.`);
  return parts.join('/');
}

function parseGithubRest(rest: string, raw: string): SkillSourceSpec {
  let ref: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    ref = rest.slice(at + 1).trim();
    rest = rest.slice(0, at);
  }
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2 || !OWNER_RE.test(parts[0]) || !OWNER_RE.test(parts[1].replace(/\.git$/, ''))) {
    throw new Error(`Expected git:owner/repo[/path][@ref], got "${raw}".`);
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  let sub = cleanRepoPath(parts.slice(2).join('/'));
  if (/(^|\/)SKILL\.md$/i.test(sub)) sub = sub.replace(/\/?SKILL\.md$/i, '');
  if (ref !== undefined && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) throw new Error(`Invalid git ref "${ref}".`);
  return { kind: 'github', owner, repo, path: sub || undefined, ref: ref || undefined, spec: `git:${owner}/${repo}${sub ? `/${sub}` : ''}${ref ? `@${ref}` : ''}` };
}

/** Parses a source string typed by the user, the agent or stored in the lock file. */
export function parseSkillSource(input: string, cwd?: string, home = os.homedir()): SkillSourceSpec {
  const raw = (input || '').trim();
  if (!raw) throw new Error('Skill source is empty.');
  let match: RegExpMatchArray | null;

  if ((match = raw.match(/^(?:clawhub:)@?([^/\s]+)\/([^/\s]+)$/i)) || (match = raw.match(/^@([^/\s]+)\/([^/\s]+)$/))) {
    const [, owner, slug] = match;
    if (!OWNER_RE.test(owner) || !SLUG_RE.test(slug)) throw new Error(`Invalid ClawHub reference "${raw}".`);
    return { kind: 'clawhub', owner, slug, spec: `clawhub:${owner}/${slug}` };
  }
  if ((match = raw.match(/^clawhub:([^/\s]+)$/i))) {
    if (!SLUG_RE.test(match[1])) throw new Error(`Invalid ClawHub slug "${raw}".`);
    return { kind: 'clawhub', slug: match[1], spec: `clawhub:${match[1]}` };
  }
  if ((match = raw.match(/^https?:\/\/(?:www\.)?clawhub\.ai\/([^/\s]+)\/skills\/([^/\s?#]+)/i))) {
    return parseSkillSource(`clawhub:${match[1]}/${match[2]}`, cwd, home);
  }
  if ((match = raw.match(/^skills-sh:([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/i)) || (match = raw.match(/^https?:\/\/(?:www\.)?skills\.sh\/([^/\s]+)\/([^/\s]+)\/([^/\s?#]+)/i))) {
    const [, owner, repo, slug] = match;
    if (!OWNER_RE.test(owner) || !OWNER_RE.test(repo) || !SLUG_RE.test(slug)) throw new Error(`Invalid skills.sh reference "${raw}".`);
    return { kind: 'skills-sh', owner, repo, slug, spec: `skills-sh:${owner}/${repo}/${slug}` };
  }
  if ((match = raw.match(/^(?:git|github):(.+)$/i))) {
    return parseGithubRest(match[1].replace(/^https?:\/\/github\.com\//i, ''), raw);
  }
  if ((match = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s]+)(\/[^\s#?]*)?)?\/?$/i))) {
    const [, owner, repo, ref, sub] = match;
    return parseGithubRest(`${owner}/${repo}${sub || ''}${ref ? `@${ref}` : ''}`, raw);
  }
  if (/^https?:\/\//i.test(raw)) {
    if (!/\.md(?:[?#].*)?$/i.test(raw)) throw new Error('A URL source must point to a SKILL.md file (or use git:owner/repo/path for a folder).');
    return { kind: 'url', url: raw, spec: raw };
  }
  if (/^(?:file:|\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(raw) || raw === '.' || raw === '..') {
    let local = raw.replace(/^file:(\/\/)?/i, '');
    if (local.startsWith('~')) local = path.join(home, local.slice(1));
    const resolved = path.resolve(cwd || process.cwd(), local);
    const folder = /SKILL\.md$/i.test(resolved) ? path.dirname(resolved) : resolved;
    return { kind: 'local', localPath: folder, spec: folder };
  }
  throw new Error(`Unknown skill source "${raw}". Use clawhub:owner/slug, skills-sh:owner/repo/slug, git:owner/repo[/path][@ref], an https://…/SKILL.md URL or a local folder. Search first with "skills search <query>".`);
}

// ---------------------------------------------------------------------------------------------
// HTTP: SSRF-safe GET with pinned DNS, redirect re-validation and a byte cap
// ---------------------------------------------------------------------------------------------

export interface SkillHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
  /** Final URL after redirects. */
  url: string;
}

export type SkillHttpFetch = (url: string, options?: { accept?: string; maxBytes?: number }) => Promise<SkillHttpResponse>;

export interface SafeSkillFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  lookup?: DnsLookupFn;
  /** Unit tests: dial this socket address after the URL passed validation (same hook as web_fetch). */
  _testSocketAddress?: string;
  env?: NodeJS.ProcessEnv;
}

const USER_AGENT = 'PerplexiCode-Kilo/4.1 (+https://github.com/MRX7999/PerplexiCode-Kilo)';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Request headers; a GitHub token (env only, never argv) is sent to https://api.github.com and nowhere else. */
export function skillRequestHeaders(url: URL, env: NodeJS.ProcessEnv | Record<string, string | undefined>, accept: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: accept };
  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  if (token && url.protocol === 'https:' && url.hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function createSafeSkillFetch(options: SafeSkillFetchOptions = {}): SkillHttpFetch {
  const env = options.env || process.env;
  return async (rawUrl, request = {}) => {
    const maxBytes = request.maxBytes || DEFAULT_MAX_BYTES;
    let current = rawUrl;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (options.signal?.aborted) throw new Error('Aborted');
      const { url, pinned } = await validateSafeFetchUrl(current, options.lookup);
      const dialAddress = options._testSocketAddress || pinned.address;
      const dialFamily: 4 | 6 = options._testSocketAddress ? 4 : pinned.family;
      const headers = skillRequestHeaders(url, env, request.accept || '*/*');
      const result = await new Promise<{ status: number; location?: string; contentType: string; body: Buffer }>((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const lookup = (_host: string, opts: unknown, cb?: unknown) => {
          const callback = (typeof opts === 'function' ? opts : cb) as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
          if (opts && typeof opts === 'object' && (opts as dns.LookupOptions).all) callback(null, [{ address: dialAddress, family: dialFamily }]);
          else callback(null, dialAddress, dialFamily);
        };
        const req = client.request({
          method: 'GET',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          servername: url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
          lookup: lookup as never,
          headers,
          timeout: options.timeoutMs || 20_000,
        }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new Error(`Response from ${url.hostname} is larger than ${Math.round(maxBytes / 1024)} KB.`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({
            status: res.statusCode || 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
            contentType: String(res.headers['content-type'] || '').toLowerCase(),
            body: Buffer.concat(chunks),
          }));
          res.on('error', reject);
        });
        options.signal?.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`Request to ${url.hostname} timed out`)));
        req.end();
      });
      if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
        current = new URL(result.location, current).toString();
        continue;
      }
      return { status: result.status, contentType: result.contentType, body: result.body, url: current };
    }
    throw new Error(`Too many redirects for ${rawUrl}`);
  };
}

async function getOk(fetcher: SkillHttpFetch, url: string, what: string, accept?: string, maxBytes?: number): Promise<SkillHttpResponse> {
  const res = await fetcher(url, { accept, maxBytes });
  if (res.status === 403 && /api\.github\.com/.test(url)) throw new Error(`GitHub API refused the request (rate limit?). Set GITHUB_TOKEN in the environment and retry. (${what})`);
  if (res.status === 404) throw new Error(`${what} not found (HTTP 404).`);
  if (res.status < 200 || res.status >= 300) {
    const detail = res.contentType.includes('text') || res.contentType.includes('json') ? `: ${res.body.toString('utf8').slice(0, 200)}` : '';
    throw new Error(`${what}: HTTP ${res.status}${detail}`);
  }
  return res;
}

async function getJson<T>(fetcher: SkillHttpFetch, url: string, what: string): Promise<T> {
  const res = await getOk(fetcher, url, what, 'application/json');
  try {
    return JSON.parse(res.body.toString('utf8')) as T;
  } catch {
    throw new Error(`${what}: invalid JSON response.`);
  }
}

// ---------------------------------------------------------------------------------------------
// ZIP reader (stored + deflate), confined paths
// ---------------------------------------------------------------------------------------------

export interface SkillFile {
  /** POSIX path relative to the skill folder. */
  path: string;
  content: Buffer;
}

const LIMITS = { maxFiles: 200, maxTotalBytes: 8 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 };

/** Normalizes an archive/repo path; returns undefined for anything that could escape the folder. */
export function safeRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) return undefined;
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined;
  return parts.join('/');
}

export function readZip(buffer: Buffer): SkillFile[] {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count > LIMITS.maxFiles * 2) throw new Error(`Archive has too many entries (${count}).`);
  const files: SkillFile[] = [];
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const rel = safeRelativePath(name);
    if (!rel) throw new Error(`Archive entry "${name}" points outside the skill folder.`);
    if (size > LIMITS.maxFileBytes) continue;
    total += size;
    if (total > LIMITS.maxTotalBytes) throw new Error('Archive is larger than 8 MB unpacked.');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt ZIP local header.');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = zlib.inflateRawSync(data, { maxOutputLength: LIMITS.maxFileBytes + 1 });
    else throw new Error(`Unsupported ZIP compression method ${method} for "${name}".`);
    if (content.length !== size) throw new Error(`ZIP entry "${name}" has an unexpected size.`);
    files.push({ path: rel, content });
  }
  if (files.length > LIMITS.maxFiles) throw new Error(`Skill has too many files (${files.length}, limit ${LIMITS.maxFiles}).`);
  // Archives that wrap everything in one top-level folder: strip it so SKILL.md is at the root.
  if (!files.some((file) => file.path === 'SKILL.md')) {
    const tops = new Set(files.map((file) => file.path.split('/')[0]));
    if (tops.size === 1 && files.every((file) => file.path.includes('/'))) {
      const top = [...tops][0];
      return files.map((file) => ({ path: file.path.slice(top.length + 1), content: file.content }));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Resolving a source into files
// ---------------------------------------------------------------------------------------------

export interface ResolvedSkill {
  name: string;
  description: string;
  files: SkillFile[];
  /** Normalized source spec. */
  source: string;
  /** Pinned location (commit URL, archive URL or file path) for the lock file. */
  resolved: string;
  /** SHA-256 over all files (stable order). */
  sha256: string;
  /** Registry flags such as ClawHub "suspicious". */
  registryWarnings: string[];
}

export interface ResolveOptions {
  fetch?: SkillHttpFetch;
  cwd?: string;
  home?: string;
  /** Override for tests: API bases. */
  bases?: Partial<SkillApiBases>;
}

export interface SkillApiBases {
  clawhub: string;
  skillsSh: string;
  githubApi: string;
  githubRaw: string;
}

export const DEFAULT_SKILL_API_BASES: SkillApiBases = {
  clawhub: 'https://clawhub.ai',
  skillsSh: 'https://skills.sh',
  githubApi: 'https://api.github.com',
  githubRaw: 'https://raw.githubusercontent.com',
};

export function hashSkillFiles(files: SkillFile[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update('\0').update(crypto.createHash('sha256').update(file.content).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}

function finalize(files: SkillFile[], source: string, resolved: string, fallbackName: string, registryWarnings: string[] = []): ResolvedSkill {
  const skillFile = files.find((file) => file.path === 'SKILL.md') || files.find((file) => file.path.toLowerCase() === 'skill.md');
  if (!skillFile) throw new Error(`No SKILL.md found at ${resolved}.`);
  if (skillFile.path !== 'SKILL.md') skillFile.path = 'SKILL.md';
  const { data } = parseFrontmatter(skillFile.content.toString('utf8'));
  const name = normalizeName(data.name || '') || normalizeName(fallbackName);
  if (!name) throw new Error('SKILL.md has no valid "name" in its frontmatter.');
  const description = (data.description || '').trim();
  if (!description) throw new Error(`SKILL.md of "${name}" has no "description" in its frontmatter; the agent needs it to know when to load the skill.`);
  return { name, description, files, source, resolved, sha256: hashSkillFiles(files), registryWarnings };
}

interface GithubTreeEntry { path: string; type: string; size?: number }

async function resolveGithub(spec: { owner: string; repo: string; path?: string; ref?: string; slug?: string }, source: string, fetcher: SkillHttpFetch, bases: SkillApiBases): Promise<ResolvedSkill> {
  const repoId = `${spec.owner}/${spec.repo}`;
  const ref = spec.ref || 'HEAD';
  let commit = ref;
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    const res = await getOk(fetcher, `${bases.githubApi}/repos/${repoId}/commits/${encodeURIComponent(ref)}`, `GitHub repository ${repoId}@${ref}`, 'application/vnd.github.sha');
    commit = res.body.toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      try { commit = String((JSON.parse(commit) as { sha?: string }).sha || ''); } catch { commit = ''; }
    }
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Could not resolve ${repoId}@${ref} to a commit.`);
  }
  const tree = await getJson<{ tree?: GithubTreeEntry[]; truncated?: boolean }>(fetcher, `${bases.githubApi}/repos/${repoId}/git/trees/${commit}?recursive=1`, `File list of ${repoId}`);
  const blobs = (tree.tree || []).filter((entry) => entry.type === 'blob');
  const skillDirs = blobs.filter((entry) => /(^|\/)SKILL\.md$/.test(entry.path)).map((entry) => path.posix.dirname(entry.path)).map((dir) => (dir === '.' ? '' : dir));
  const raw = (file: string) => `${bases.githubRaw}/${repoId}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;

  let dir: string | undefined;
  if (spec.path !== undefined) {
    dir = spec.path;
    if (!skillDirs.includes(dir)) {
      const nested = skillDirs.filter((candidate) => candidate.startsWith(`${dir}/`));
      if (nested.length === 1) dir = nested[0];
      else throw new Error(`No SKILL.md in ${repoId}/${spec.path}${nested.length ? `. Skills below it: ${nested.slice(0, 10).join(', ')}` : ''}.`);
    }
  } else if (spec.slug) {
    const byFolder = skillDirs.filter((candidate) => path.posix.basename(candidate) === spec.slug);
    if (byFolder.length >= 1) {
      dir = byFolder.sort((a, b) => a.length - b.length)[0];
    } else {
      for (const candidate of skillDirs.slice(0, 40)) {
        const res = await getOk(fetcher, raw(candidate ? `${candidate}/SKILL.md` : 'SKILL.md'), `SKILL.md in ${repoId}`, 'text/plain');
        if (normalizeName(parseFrontmatter(res.body.toString('utf8')).data.name || '') === normalizeName(spec.slug)) { dir = candidate; break; }
      }
    }
    if (dir === undefined) throw new Error(`Skill "${spec.slug}" not found in ${repoId}.`);
  } else if (skillDirs.includes('')) {
    dir = '';
  } else if (skillDirs.length === 1) {
    dir = skillDirs[0];
  } else if (skillDirs.length === 0) {
    throw new Error(`${repoId} has no SKILL.md.`);
  } else {
    throw new Error(`${repoId} has ${skillDirs.length} skills; pick one with git:${repoId}/<path>. For example: ${skillDirs.slice(0, 8).map((candidate) => `git:${repoId}/${candidate}`).join(', ')}`);
  }

  const prefix = dir ? `${dir}/` : '';
  // Files of this skill only: stop at nested skill folders.
  const nestedSkillDirs = skillDirs.filter((candidate) => candidate !== dir && (dir === '' || candidate.startsWith(prefix)));
  const own = blobs.filter((entry) => entry.path.startsWith(prefix) && !nestedSkillDirs.some((nested) => entry.path.startsWith(`${nested}/`)));
  if (own.length > LIMITS.maxFiles) throw new Error(`Skill folder has too many files (${own.length}, limit ${LIMITS.maxFiles}).`);
  const wanted = own
    .filter((entry) => (entry.size || 0) <= LIMITS.maxFileBytes)
    .map((entry) => ({ entry, rel: safeRelativePath(entry.path.slice(prefix.length)) }))
    .filter((item): item is { entry: GithubTreeEntry; rel: string } => Boolean(item.rel));
  if (wanted.reduce((sum, item) => sum + (item.entry.size || 0), 0) > LIMITS.maxTotalBytes) throw new Error('Skill is larger than 8 MB.');
  const files: SkillFile[] = new Array(wanted.length);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const index = next++;
      const { entry, rel } = wanted[index];
      const res = await getOk(fetcher, raw(entry.path), `${repoId}/${entry.path}`, '*/*', LIMITS.maxFileBytes);
      files[index] = { path: rel, content: res.body };
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));
  return finalize(files, source, `https://github.com/${repoId}/tree/${commit}${dir ? `/${dir}` : ''}`, spec.slug || path.posix.basename(dir || spec.repo));
}

async function resolveClawhub(spec: SkillSourceSpec, fetcher: SkillHttpFetch, bases: SkillApiBases): Promise<ResolvedSkill> {
  const query = `slug=${encodeURIComponent(spec.slug!)}${spec.owner ? `&ownerHandle=${encodeURIComponent(spec.owner)}` : ''}`;
  const warnings: string[] = [];
  let canonical = spec.owner ? `${bases.clawhub}/${spec.owner}/skills/${spec.slug}` : `${bases.clawhub}/skills/${spec.slug}`;
  try {
    const meta = await getJson<Record<string, any>>(fetcher, `${bases.clawhub}/api/v1/skills/${encodeURIComponent(spec.slug!)}${spec.owner ? `?ownerHandle=${encodeURIComponent(spec.owner)}` : ''}`, `ClawHub skill ${spec.spec}`);
    const skill = meta.skill || meta;
    if (skill?.isSuspicious || meta?.moderation?.isSuspicious) warnings.push('ClawHub marks this skill as suspicious.');
    const owner = meta.owner?.handle || skill?.ownerHandle;
    if (owner) canonical = `${bases.clawhub}/${owner}/skills/${spec.slug}`;
  } catch {
    // Metadata is informational; the download below is authoritative.
  }
  const res = await fetcher(`${bases.clawhub}/api/v1/download?${query}`, { accept: 'application/zip, application/json', maxBytes: LIMITS.maxTotalBytes });
  if (res.status === 409) throw new Error(`${res.body.toString('utf8').slice(0, 200)} Use clawhub:<owner>/${spec.slug}.`);
  if (res.status === 404) throw new Error(`ClawHub skill ${spec.spec} not found.`);
  if (res.status === 410) throw new Error(`ClawHub skill ${spec.spec} was removed.`);
  if (res.status < 200 || res.status >= 300) throw new Error(`ClawHub download of ${spec.spec}: HTTP ${res.status} ${res.body.toString('utf8').slice(0, 160)}`);
  if (res.contentType.includes('json')) {
    const handoff = JSON.parse(res.body.toString('utf8')) as Record<string, any>;
    if (handoff.sourceRef !== 'public-github') throw new Error(`ClawHub returned an unknown handoff for ${spec.spec}.`);
    const repo = typeof handoff.repo === 'string' ? handoff.repo : `${handoff.repo?.owner}/${handoff.repo?.name || handoff.repo?.repo}`;
    const [owner, name] = repo.replace(/^https?:\/\/github\.com\//, '').split('/');
    const resolved = await resolveGithub({ owner, repo: name, path: handoff.path ? cleanRepoPath(String(handoff.path)) : undefined, ref: handoff.commit }, spec.spec, fetcher, bases);
    resolved.registryWarnings.push(...warnings);
    return resolved;
  }
  const files = readZip(res.body);
  return finalize(files, spec.spec, canonical, spec.slug!, warnings);
}

function readLocalFolder(folder: string): SkillFile[] {
  const files: SkillFile[] = [];
  let total = 0;
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(abs, relPath); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(abs).size;
      if (size > LIMITS.maxFileBytes) continue;
      total += size;
      if (files.length >= LIMITS.maxFiles || total > LIMITS.maxTotalBytes) throw new Error('Local skill folder is too large (200 files / 8 MB).');
      files.push({ path: relPath, content: fs.readFileSync(abs) });
    }
  };
  walk(folder, '');
  return files;
}

export async function resolveSkillSource(input: string | SkillSourceSpec, options: ResolveOptions = {}): Promise<ResolvedSkill> {
  const spec = typeof input === 'string' ? parseSkillSource(input, options.cwd, options.home) : input;
  const fetcher = options.fetch || createSafeSkillFetch();
  const bases = { ...DEFAULT_SKILL_API_BASES, ...(options.bases || {}) };
  switch (spec.kind) {
    case 'clawhub':
      return resolveClawhub(spec, fetcher, bases);
    case 'skills-sh':
      return resolveGithub({ owner: spec.owner!, repo: spec.repo!, slug: spec.slug }, spec.spec, fetcher, bases);
    case 'github':
      return resolveGithub({ owner: spec.owner!, repo: spec.repo!, path: spec.path, ref: spec.ref }, spec.spec, fetcher, bases);
    case 'url': {
      const res = await getOk(fetcher, spec.url!, spec.url!, 'text/markdown, text/plain', LIMITS.maxFileBytes);
      const fallback = path.posix.basename(path.posix.dirname(new URL(spec.url!).pathname)) || 'skill';
      return finalize([{ path: 'SKILL.md', content: res.body }], spec.spec, spec.url!, fallback);
    }
    case 'local': {
      const folder = spec.localPath!;
      if (!fs.existsSync(path.join(folder, 'SKILL.md'))) throw new Error(`No SKILL.md in ${folder}.`);
      return finalize(readLocalFolder(folder), spec.spec, folder, path.basename(folder));
    }
    default:
      throw new Error('Unsupported skill source.');
  }
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export interface SkillSearchResult {
  registry: SkillRegistry;
  name: string;
  /** Source spec to pass to install. */
  install: string;
  description?: string;
  owner?: string;
  installs?: number;
  suspicious?: boolean;
  url: string;
}

export interface SkillSearchResponse {
  results: SkillSearchResult[];
  errors: Array<{ registry: SkillRegistry; message: string }>;
}

export async function searchSkills(query: string, options: { fetch?: SkillHttpFetch; registries?: SkillRegistry[]; limit?: number; bases?: Partial<SkillApiBases> } = {}): Promise<SkillSearchResponse> {
  const q = query.trim();
  if (q.length < 2) throw new Error('Search query must have at least 2 characters.');
  const fetcher = options.fetch || createSafeSkillFetch();
  const bases = { ...DEFAULT_SKILL_API_BASES, ...(options.bases || {}) };
  const limit = Math.max(1, Math.min(options.limit || 10, 50));
  const registries = (options.registries && options.registries.length ? options.registries : SKILL_REGISTRIES).filter((entry) => SKILL_REGISTRIES.includes(entry));
  const errors: SkillSearchResponse['errors'] = [];
  const lists = await Promise.all(registries.map(async (registry): Promise<SkillSearchResult[]> => {
    try {
      if (registry === 'clawhub') {
        const data = await getJson<{ results?: Array<Record<string, any>> }>(fetcher, `${bases.clawhub}/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`, 'ClawHub search');
        return (data.results || []).map((item): SkillSearchResult | undefined => {
          const slug = String(item.slug || '');
          const owner = String(item.ownerHandle || item.owner?.handle || '');
          if (!slug) return undefined;
          const ref = item.install?.reference ? String(item.install.reference) : '';
          const install = item.install?.kind === 'skills-sh' && ref.startsWith('skills-sh:') ? ref : owner ? `clawhub:${owner}/${slug}` : `clawhub:${slug}`;
          const canonical = item.canonicalUrl ? new URL(String(item.canonicalUrl), bases.clawhub).toString() : `${bases.clawhub}/${owner}/skills/${slug}`;
          return {
            registry,
            name: slug,
            install,
            description: String(item.summary || item.native?.skill?.summary || '').slice(0, 300) || undefined,
            owner: owner || undefined,
            installs: typeof item.downloads === 'number' ? item.downloads : undefined,
            suspicious: Boolean(item.native?.skill?.isSuspicious),
            url: item.install?.sourceUrl || canonical,
          };
        }).filter((entry): entry is SkillSearchResult => Boolean(entry));
      }
      const data = await getJson<{ skills?: Array<Record<string, any>> }>(fetcher, `${bases.skillsSh}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, 'skills.sh search');
      return (data.skills || []).map((item): SkillSearchResult | undefined => {
        const repo = String(item.source || '');
        const skillId = String(item.skillId || item.name || '');
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !skillId) return undefined;
        return {
          registry,
          name: String(item.name || skillId),
          install: `skills-sh:${repo}/${skillId}`,
          owner: repo.split('/')[0],
          installs: typeof item.installs === 'number' ? item.installs : undefined,
          url: `${bases.skillsSh}/${repo}/${skillId}`,
        };
      }).filter((entry): entry is SkillSearchResult => Boolean(entry));
    } catch (error) {
      errors.push({ registry, message: (error as Error).message });
      return [];
    }
  }));
  // Interleave registries, drop duplicates (ClawHub also lists skills.sh entries).
  const seen = new Set<string>();
  const results: SkillSearchResult[] = [];
  for (let i = 0; results.length < limit && lists.some((list) => i < list.length); i += 1) {
    for (const list of lists) {
      const item = list[i];
      if (!item || seen.has(item.install.toLowerCase())) continue;
      seen.add(item.install.toLowerCase());
      results.push(item);
      if (results.length >= limit) break;
    }
  }
  return { results, errors };
}

// ---------------------------------------------------------------------------------------------
// Content scan
// ---------------------------------------------------------------------------------------------

export type SkillFindingSeverity = 'high' | 'medium' | 'info';

export interface SkillFinding {
  severity: SkillFindingSeverity;
  rule: string;
  file: string;
  line?: number;
  excerpt?: string;
}

export interface SkillScanReport {
  verdict: 'clean' | 'review' | 'blocked';
  findings: SkillFinding[];
}

const SCAN_RULES: Array<{ severity: SkillFindingSeverity; rule: string; re: RegExp }> = [
  { severity: 'high', rule: 'download piped into a shell', re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i },
  { severity: 'high', rule: 'PowerShell download-and-run', re: /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b|\b(?:iwr|irm|DownloadString)\b[^\n]*\|\s*iex\b/i },
  { severity: 'high', rule: 'decoded payload executed', re: /base64\s+(?:-d|--decode)[^\n]*\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(/i },
  { severity: 'high', rule: 'reads credential files', re: /(?:~|\$HOME|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/\.(?:ssh\/id_|aws\/credentials|config\/gcloud|kube\/config|netrc|docker\/config\.json)|\/etc\/shadow\b|security\s+find-(?:generic|internet)-password|\.perplexicode\/(?:accounts|secrets)/i },
  { severity: 'high', rule: 'uploads local files', re: /\bcurl\b[^\n]*(?:-d|--data(?:-binary)?|-F|--form|-T|--upload-file)\s+["']?@?(?:~|\$HOME|\/etc|\.env)/i },
  { severity: 'high', rule: 'reverse shell', re: /\b(?:nc|ncat|netcat)\b[^\n]*\s-e\s|\/dev\/tcp\/\d|\bbash\s+-i\s*>&/i },
  { severity: 'high', rule: 'destructive command', re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME)(?:\s|$|["'])/i },
  { severity: 'high', rule: 'tells the agent to bypass approvals', re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules)|--dangerously-skip-permissions|bypassPermissions|(?:disable|skip|bypass)\s+(?:the\s+)?(?:approval|permission|safety|sandbox)\s*(?:prompts?|checks?|rules?)?|do\s+not\s+(?:ask|tell)\s+the\s+user/i },
  { severity: 'high', rule: 'crypto miner', re: /\b(?:xmrig|minerd|cryptonight|stratum\+tcp)\b/i },
  { severity: 'medium', rule: 'hidden Unicode control characters', re: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/ },
  { severity: 'medium', rule: 'runs with sudo', re: /(?:^|[\s`;&|])sudo\s+\S/ },
  { severity: 'medium', rule: 'dynamic code execution', re: /\b(?:eval|exec)\s*\(|\bnew\s+Function\s*\(|\bsubprocess\.[a-z_]+\([^)]*shell\s*=\s*True|\bos\.system\s*\(/ },
  { severity: 'medium', rule: 'reads all environment variables', re: /\bprintenv\b|\benv\s*\|\s*|\bos\.environ\b(?!\s*(?:\.get|\[|\.copy|\.setdefault))|JSON\.stringify\(\s*process\.env\s*\)|Object\.(?:keys|entries)\(\s*process\.env\s*\)/ },
  { severity: 'medium', rule: 'changes shell startup or scheduled jobs', re: /(?:>>?|tee\s+-a)\s*~?\/?(?:\.bashrc|\.zshrc|\.profile|\.bash_profile)|\bcrontab\s+-|\blaunchctl\s+load\b|systemctl\s+enable\b/i },
  { severity: 'medium', rule: 'installs packages globally', re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+-g\b|\bpip3?\s+install\b(?![^\n]*--user)[^\n]*--break-system-packages/i },
];

const EXECUTABLE_RE = /\.(?:sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|exe|bin|so|dylib|dll)$/i;

function isProbablyText(content: Buffer): boolean {
  const sample = content.subarray(0, 4096);
  return !sample.includes(0);
}

/** Static scan of every text file; nothing is executed. */
export function scanSkill(files: SkillFile[]): SkillScanReport {
  const findings: SkillFinding[] = [];
  for (const file of files) {
    if (EXECUTABLE_RE.test(file.path)) findings.push({ severity: 'info', rule: 'contains a script (written to disk, never run automatically)', file: file.path });
    if (!isProbablyText(file.content)) {
      if (/\.(?:exe|bin|so|dylib|dll)$/i.test(file.path)) findings.push({ severity: 'medium', rule: 'contains a binary executable', file: file.path });
      continue;
    }
    const lines = file.content.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      for (const rule of SCAN_RULES) {
        if (rule.re.test(line)) findings.push({ severity: rule.severity, rule: rule.rule, file: file.path, line: index + 1, excerpt: line.trim().slice(0, 160) });
      }
    });
  }
  const verdict = findings.some((entry) => entry.severity === 'high') ? 'blocked' : findings.some((entry) => entry.severity === 'medium') ? 'review' : 'clean';
  return { verdict, findings: findings.slice(0, 50) };
}

/** scanSkill plus registry flags: a skill the registry marks as suspicious is never "clean". */
export function scanResolvedSkill(skill: Pick<ResolvedSkill, 'files' | 'registryWarnings'>): SkillScanReport {
  const report = scanSkill(skill.files);
  if (report.verdict === 'clean' && skill.registryWarnings.length) report.verdict = 'review';
  return report;
}

export function formatScanReport(report: SkillScanReport, registryWarnings: string[] = []): string {
  const head = report.verdict === 'clean' ? 'Scan: clean' : report.verdict === 'review' ? 'Scan: review the findings below' : 'Scan: BLOCKED (high-risk patterns)';
  const lines = [head, ...registryWarnings.map((warning) => `- [registry] ${warning}`)];
  for (const finding of report.findings) {
    lines.push(`- [${finding.severity}] ${finding.rule}: ${finding.file}${finding.line ? `:${finding.line}` : ''}${finding.excerpt ? ` — ${finding.excerpt}` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Install, lock file, verify, update
// ---------------------------------------------------------------------------------------------

export interface SkillLockEntry {
  source: string;
  resolved: string;
  sha256: string;
  files: number;
  verdict: SkillScanReport['verdict'];
  installedAt: string;
}

export interface SkillLockFile {
  version: 1;
  skills: Record<string, SkillLockEntry>;
}

function scopeBase(scope: LibraryScope, paths: LibraryPaths): string {
  if (scope === 'project') {
    if (!paths.cwd) throw new Error('Open a folder to install into the project, or install globally.');
    return path.join(paths.cwd, '.perplexicode');
  }
  return path.join(paths.home || os.homedir(), '.perplexicode');
}

export function skillLockPath(scope: LibraryScope, paths: LibraryPaths): string {
  return path.join(scopeBase(scope, paths), 'skills-lock.json');
}

export function readSkillLock(scope: LibraryScope, paths: LibraryPaths): SkillLockFile {
  try {
    const data = JSON.parse(fs.readFileSync(skillLockPath(scope, paths), 'utf8')) as SkillLockFile;
    if (data && typeof data.skills === 'object') return { version: 1, skills: data.skills };
  } catch {
    // No lock yet.
  }
  return { version: 1, skills: {} };
}

function writeSkillLock(scope: LibraryScope, paths: LibraryPaths, lock: SkillLockFile): void {
  const file = skillLockPath(scope, paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted: SkillLockFile = { version: 1, skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) };
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export interface InstallSkillOptions {
  scope: LibraryScope;
  paths: LibraryPaths;
  /** Install under another folder name. */
  as?: string;
  overwrite?: boolean;
  /** Install even when the scan verdict is "blocked" (explicit user decision only). */
  allowRisky?: boolean;
  scan?: SkillScanReport;
}

export interface InstalledSkill {
  name: string;
  dir: string;
  file: string;
  scope: LibraryScope;
  replaced: boolean;
  scan: SkillScanReport;
}

export function installResolvedSkill(skill: ResolvedSkill, options: InstallSkillOptions): InstalledSkill {
  const name = options.as ? normalizeName(options.as) : skill.name;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid skill name "${options.as || skill.name}".`);
  const scan = options.scan || scanSkill(skill.files);
  if (scan.verdict === 'blocked' && !options.allowRisky) {
    throw Object.assign(new Error(`Skill "${name}" was not installed: the scan found high-risk patterns.\n${formatScanReport(scan, skill.registryWarnings)}`), { code: 'ESKILLBLOCKED', scan });
  }
  const skillsDir = path.join(scopeBase(options.scope, options.paths), 'skills');
  const dir = path.join(skillsDir, name);
  const exists = fs.existsSync(dir);
  if (exists && !options.overwrite) throw Object.assign(new Error(`${dir} already exists`), { code: 'EEXIST', file: dir });
  fs.mkdirSync(skillsDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(skillsDir, `.${name}.tmp-`));
  try {
    for (const file of skill.files) {
      const rel = safeRelativePath(file.path);
      if (!rel) throw new Error(`Refusing to write "${file.path}" outside the skill folder.`);
      const target = path.join(staging, ...rel.split('/'));
      if (!target.startsWith(staging + path.sep)) throw new Error(`Refusing to write "${file.path}" outside the skill folder.`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, { mode: 0o644 });
    }
    if (exists) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const lock = readSkillLock(options.scope, options.paths);
  lock.skills[name] = { source: skill.source, resolved: skill.resolved, sha256: skill.sha256, files: skill.files.length, verdict: scan.verdict, installedAt: new Date().toISOString() };
  writeSkillLock(options.scope, options.paths, lock);
  return { name, dir, file: path.join(dir, 'SKILL.md'), scope: options.scope, replaced: exists, scan };
}

/** Removes a skill folder that was installed from a source and its lock entry. */
export function removeInstalledSkill(name: string, scope: LibraryScope, paths: LibraryPaths): string {
  const clean = normalizeName(name);
  if (!clean || clean !== name.trim().toLowerCase()) throw new Error(`Invalid skill name "${name}".`);
  const dir = path.join(scopeBase(scope, paths), 'skills', clean);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`Skill "${clean}" is not installed in ${scope === 'project' ? 'the project' : '~/.perplexicode'}.`);
  fs.rmSync(dir, { recursive: true, force: true });
  const lock = readSkillLock(scope, paths);
  if (lock.skills[clean]) {
    delete lock.skills[clean];
    writeSkillLock(scope, paths, lock);
  }
  return dir;
}

export interface SkillVerifyResult {
  name: string;
  scope: LibraryScope;
  source: string;
  status: 'ok' | 'modified' | 'missing';
}

export function verifyInstalledSkills(paths: LibraryPaths, scopes: LibraryScope[] = ['project', 'user']): SkillVerifyResult[] {
  const out: SkillVerifyResult[] = [];
  for (const scope of scopes) {
    if (scope === 'project' && !paths.cwd) continue;
    const lock = readSkillLock(scope, paths);
    for (const [name, entry] of Object.entries(lock.skills)) {
      const dir = path.join(scopeBase(scope, paths), 'skills', name);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) { out.push({ name, scope, source: entry.source, status: 'missing' }); continue; }
      let status: SkillVerifyResult['status'];
      try {
        status = hashSkillFiles(readLocalFolder(dir)) === entry.sha256 ? 'ok' : 'modified';
      } catch {
        status = 'modified';
      }
      out.push({ name, scope, source: entry.source, status });
    }
  }
  return out;
}

export interface SkillUpdateCheck {
  name: string;
  scope: LibraryScope;
  source: string;
  status: 'up-to-date' | 'update-available' | 'error';
  skill?: ResolvedSkill;
  scan?: SkillScanReport;
  error?: string;
}

/** Re-resolves every locked skill (or the named ones) and reports which changed upstream. Writes nothing. */
export async function checkSkillUpdates(paths: LibraryPaths, options: { names?: string[]; scopes?: LibraryScope[]; fetch?: SkillHttpFetch; bases?: Partial<SkillApiBases> } = {}): Promise<SkillUpdateCheck[]> {
  const out: SkillUpdateCheck[] = [];
  for (const scope of options.scopes || ['project', 'user']) {
    if (scope === 'project' && !paths.cwd) continue;
    const lock = readSkillLock(scope, paths);
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (options.names && options.names.length && !options.names.includes(name)) continue;
      try {
        const skill = await resolveSkillSource(entry.source, { fetch: options.fetch, bases: options.bases, cwd: paths.cwd, home: paths.home });
        const changed = skill.sha256 !== entry.sha256;
        out.push({ name, scope, source: entry.source, status: changed ? 'update-available' : 'up-to-date', skill: changed ? skill : undefined, scan: changed ? scanResolvedSkill(skill) : undefined });
      } catch (error) {
        out.push({ name, scope, source: entry.source, status: 'error', error: (error as Error).message });
      }
    }
  }
  return out;
}

/** Lock entries of both scopes keyed by `<scope>:<name>`, for the library UI. */
export function installedSkillOrigins(paths: LibraryPaths): Record<string, SkillLockEntry & { scope: LibraryScope }> {
  const out: Record<string, SkillLockEntry & { scope: LibraryScope }> = {};
  for (const scope of ['project', 'user'] as LibraryScope[]) {
    if (scope === 'project' && !paths.cwd) continue;
    for (const [name, entry] of Object.entries(readSkillLock(scope, paths).skills)) out[`${scope}:${name}`] = { ...entry, scope };
  }
  return out;
}

/** One-paragraph summary used in approval prompts and CLI output. */
export function describeResolvedSkill(skill: ResolvedSkill, scan: SkillScanReport): string {
  return [
    `Skill: ${skill.name} — ${skill.description.length > 300 ? `${skill.description.slice(0, 297)}…` : skill.description}`,
    `Source: ${skill.source}`,
    `Pinned: ${skill.resolved}`,
    `Files: ${skill.files.length} (${skill.files.slice(0, 12).map((file) => file.path).join(', ')}${skill.files.length > 12 ? ', …' : ''})`,
    `SHA-256: ${skill.sha256}`,
    formatScanReport(scan, skill.registryWarnings),
  ].join('\n');
}
