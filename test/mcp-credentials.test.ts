import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers } from '../src/core/mcp';
import { McpCredentialCache } from '../src/core/mcpCredentials';

async function main(): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-credentials-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-credentials-home-'));
  const file = path.join(cwd, '.mcp.json');
  const secrets = new Map<string, string>();
  const store = {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); },
  };
  let count = 0;
  try {
    const spec = {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
      other: { type: 'http', url: 'https://example.com/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
    };
    const write = () => fs.writeFileSync(file, JSON.stringify({ mcpServers: spec }));
    write();
    const cache = new McpCredentialCache(store);
    await cache.save(file, 'github', { GITHUB_TOKEN: 'private-test-token' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('private-test-token'));
    assert.ok(![...secrets.keys()].some((key) => key.includes('private-test-token')));
    count++;
    const servers = loadMcpServers(cwd, { home, env: {}, serverEnv: (name, _scope, file, raw) => cache.env(file, name, raw) });
    assert.strictEqual(servers.find((server) => server.name === 'github')?.headers?.Authorization, 'Bearer private-test-token');
    assert.strictEqual(servers.find((server) => server.name === 'other')?.headers?.Authorization, 'Bearer ');
    count++;
    const restored = new McpCredentialCache(store);
    await restored.restore(file, 'github', ['GITHUB_TOKEN']);
    assert.strictEqual(restored.env(file, 'github').GITHUB_TOKEN, 'private-test-token');
    assert.deepStrictEqual(restored.env(path.join(home, '.mcp.json'), 'github'), {});
    count++;
    const safeUrl = spec.github.url;
    spec.github.url = 'https://attacker.invalid/mcp';
    write();
    const racing = loadMcpServers(cwd, {
      home, env: {},
      serverEnv: (name, _scope, source, raw) => {
        // Restore the safe file between loader read and credential lookup.
        spec.github.url = safeUrl;
        write();
        return restored.env(source, name, raw);
      },
    });
    assert.strictEqual(racing.find((server) => server.name === 'github')?.url, 'https://attacker.invalid/mcp');
    assert.strictEqual(racing.find((server) => server.name === 'github')?.headers?.Authorization, 'Bearer ');
    count++;
    spec.github.url = 'https://example.com/changed';
    write();
    assert.deepStrictEqual(cache.env(file, 'github'), {});
    await restored.restore(file, 'github', ['GITHUB_TOKEN']);
    assert.strictEqual(restored.env(file, 'github').GITHUB_TOKEN, undefined);
    count++;
    // Removal must revoke the old binding even when the config has been edited.
    await restored.remove(file, 'github', ['GITHUB_TOKEN']);
    assert.strictEqual(secrets.size, 0);
    spec.github.url = 'https://api.githubcopilot.com/mcp/';
    write();
    await restored.restore(file, 'github', ['GITHUB_TOKEN']);
    assert.strictEqual(restored.env(file, 'github').GITHUB_TOKEN, undefined);
    await restored.save(file, 'github', { GITHUB_TOKEN: 'new-private-token' });
    await restored.remove(file, 'github', ['GITHUB_TOKEN']);
    assert.strictEqual(secrets.size, 0);
    assert.deepStrictEqual(restored.env(file, 'github'), {});
    count++;
    let calls = 0;
    const failing = new McpCredentialCache({
      ...store,
      store: async (key: string, value: string) => {
        calls++;
        if (calls === 3) throw new Error('storage failure');
        await store.store(key, value);
      },
    });
    await assert.rejects(failing.save(file, 'github', { TOKEN_A: 'a', TOKEN_B: 'b' }), /securely/);
    assert.strictEqual(secrets.size, 0, 'partial token writes and manifest must roll back');
    assert.deepStrictEqual(failing.env(file, 'github'), {});
    count++;
    await restored.save(file, 'github', { GITHUB_TOKEN: 'old-token' });
    // Reinstalling after a manual JSON deletion with blank token input means environment-only.
    await restored.save(file, 'github', {});
    await restored.restore(file, 'github', ['GITHUB_TOKEN']);
    assert.strictEqual(secrets.size, 0);
    assert.strictEqual(restored.env(file, 'github').GITHUB_TOKEN, undefined);
    count++;
    const deleteFailure = new McpCredentialCache({
      ...store,
      delete: async () => { throw new Error('delete unavailable'); },
    });
    await deleteFailure.save(file, 'github', { GITHUB_TOKEN: 'temporary-token' });
    await assert.rejects(deleteFailure.remove(file, 'github', ['GITHUB_TOKEN']), /delete unavailable/);
    assert.deepStrictEqual(deleteFailure.env(file, 'github'), {});
    await restored.remove(file, 'github', ['GITHUB_TOKEN']);
    count++;
    fs.writeFileSync(file, 'not json');
    await restored.restore(file, 'github', ['GITHUB_TOKEN']);
    assert.deepStrictEqual(restored.env(file, 'github'), {});
    await assert.rejects(restored.save(file, 'github', { TOKEN: 'test' }), /saved server configuration/);
    count++;
    console.log(`mcp-credentials: ${count}/${count} passed`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
