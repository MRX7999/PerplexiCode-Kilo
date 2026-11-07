import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface McpSecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Bind credentials to one exact configuration, not every server that references the same env var. */
export function mcpCredentialKey(file: string, name: string, spec: unknown, variable: string): string {
  const hash = createHash('sha256').update(JSON.stringify([path.resolve(file), name, spec])).digest('hex');
  return `perplexicode.mcp.v1.${hash}.${variable}`;
}

export function readMcpCredentialSpec(file: string, name: string): unknown | undefined {
  try {
    const root = JSON.parse(fs.readFileSync(file, 'utf8'));
    return root?.mcpServers?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Only stores opaque references in SecretStorage. JSON configs keep ${ENV_VAR} placeholders.
 * Changing a server's command, URL, args or other config invalidates its stored credential binding.
 */
export class McpCredentialCache {
  private readonly values = new Map<string, NodeJS.ProcessEnv>();

  constructor(private readonly store: McpSecretStore) {}

  private cacheKey(file: string, name: string): string {
    return JSON.stringify([path.resolve(file), name]);
  }

  private manifestKey(file: string, name: string): string {
    return `perplexicode.mcp.bindings.${createHash('sha256').update(this.cacheKey(file, name)).digest('hex')}`;
  }

  private async storedKeys(file: string, name: string): Promise<string[]> {
    const raw = await this.store.get(this.manifestKey(file, name));
    if (!raw) return [];
    const keys: unknown = JSON.parse(raw);
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string' && key.startsWith('perplexicode.mcp.v1.'))) {
      throw new Error('Invalid MCP credential binding manifest.');
    }
    return keys;
  }

  private readonly specs = new Map<string, string>();

  async restore(file: string, name: string, variables: string[]): Promise<void> {
    const key = this.cacheKey(file, name);
    this.values.delete(key);
    this.specs.delete(key);
    const spec = readMcpCredentialSpec(file, name);
    if (!spec) return;
    const env: NodeJS.ProcessEnv = {};
    for (const variable of variables) {
      const value = await this.store.get(mcpCredentialKey(file, name, spec, variable));
      if (value) env[variable] = value;
    }
    this.values.set(key, env);
    this.specs.set(key, JSON.stringify(spec));
  }

  async save(file: string, name: string, secrets: Record<string, string>): Promise<void> {
    const spec = readMcpCredentialSpec(file, name);
    if (!spec) throw new Error('Cannot save MCP credentials without a saved server configuration.');
    const entries = Object.entries(secrets);
    for (const [variable] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error('Invalid credential variable name.');
    }
    const manifest = this.manifestKey(file, name);
    const previousManifest = await this.store.get(manifest);
    const keys = await this.storedKeys(file, name);
    const previousValues = new Map<string, string | undefined>();
    for (const key of keys) previousValues.set(key, await this.store.get(key));
    const newKeys = new Set<string>();
    for (const [variable] of entries) {
      const key = mcpCredentialKey(file, name, spec, variable);
      newKeys.add(key);
      previousValues.set(key, await this.store.get(key));
    }
    try {
      // Persist the list first so partial writes remain removable even after an interrupted save.
      const allKeys = [...new Set([...keys, ...previousValues.keys()])];
      if (allKeys.length) await this.store.store(manifest, JSON.stringify(allKeys));
      for (const key of keys) {
        if (!newKeys.has(key)) await this.store.delete(key);
      }
      for (const [variable, value] of entries) {
        await this.store.store(mcpCredentialKey(file, name, spec, variable), value);
      }
      if (newKeys.size) await this.store.store(manifest, JSON.stringify([...newKeys]));
      else await this.store.delete(manifest);
    } catch {
      for (const [key, value] of previousValues) {
        if (value === undefined) await this.store.delete(key);
        else await this.store.store(key, value);
      }
      if (previousManifest === undefined) await this.store.delete(manifest);
      else await this.store.store(manifest, previousManifest);
      throw new Error('Could not save MCP credentials securely.');
    }
    await this.restore(file, name, Object.keys(secrets));
  }

  env(file: string, name: string, spec: unknown = readMcpCredentialSpec(file, name)): NodeJS.ProcessEnv {
    const key = this.cacheKey(file, name);
    // The loader passes its exact parsed snapshot, not a second on-disk read that could race.
    if (!spec || this.specs.get(key) !== JSON.stringify(spec)) return {};
    return { ...this.values.get(key) };
  }

  async remove(file: string, name: string, variables: string[]): Promise<void> {
    this.values.delete(this.cacheKey(file, name));
    this.specs.delete(this.cacheKey(file, name));
    const spec = readMcpCredentialSpec(file, name);
    const keys = new Set(await this.storedKeys(file, name));
    if (spec) {
      for (const variable of variables) {
        keys.add(mcpCredentialKey(file, name, spec, variable));
      }
    }
    for (const key of keys) await this.store.delete(key);
    await this.store.delete(this.manifestKey(file, name));
  }
}
