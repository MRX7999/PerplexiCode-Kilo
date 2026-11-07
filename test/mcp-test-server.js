#!/usr/bin/env node
/*
 * Minimal MCP (Model Context Protocol) stdio server used by test/mcp.test.ts.
 * Speaks JSON-RPC 2.0 over stdin/stdout, newline-delimited by default
 * (MCP_FRAMING=content-length switches to LSP style Content-Length frames).
 *
 * Environment knobs:
 *   MCP_SPAWN_LOG=<file>      append the pid on start (counts how often the client spawned us)
 *   MCP_EXIT_IMMEDIATELY=1    write an error to stderr and exit 3 before answering anything
 *   MCP_NOISY=1               print a non-JSON banner on stdout first (must be ignored by clients)
 *   MCP_ASK_ROOTS=1           send a server → client `roots/list` request after initialize
 *   MCP_HANG_INIT=1           never answer initialize (client timeout test)
 */
const fs = require('fs');
const readline = require('readline');

const framing = process.env.MCP_FRAMING || 'ndjson';
if (process.env.MCP_SPAWN_LOG) {
  fs.appendFileSync(process.env.MCP_SPAWN_LOG, `${process.pid}\n`);
}
if (process.env.MCP_EXIT_IMMEDIATELY) {
  process.stderr.write('fatal: TEST_API_KEY is not set\n');
  process.exit(3);
}
if (process.env.MCP_NOISY) {
  process.stdout.write('test mcp server starting (this line is not JSON)\n');
}

const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'fail', description: 'Always reports a tool error', inputSchema: { type: 'object', properties: { reason: { type: 'string' } } } },
  { name: 'slow', description: 'Answers after 1.5 seconds', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Returns TEST_TOKEN from the server environment', inputSchema: { type: 'object', properties: {} } },
  { name: 'cwd', description: 'Returns the server working directory', inputSchema: { type: 'object', properties: {} } },
  { name: 'roots', description: 'Returns what the client answered to roots/list', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_tool', description: 'Registers a new tool and notifies the client', inputSchema: { type: 'object', properties: {} } },
  { name: 'weird name.v2', description: 'Tool with characters that need sanitising', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'Returns mixed image + text content', inputSchema: { type: 'object', properties: {} } },
];
let rootsSeen = null;
let serverRequestId = 0;

function send(message) {
  const json = JSON.stringify(message);
  if (framing === 'content-length') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });

function handle(message) {
  if (!message || typeof message !== 'object') return;
  // Responses to our own requests (roots/list).
  if (message.method === undefined && (message.result !== undefined || message.error !== undefined)) {
    if (message.result && Array.isArray(message.result.roots)) rootsSeen = message.result.roots;
    else if (message.error) rootsSeen = { error: message.error };
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      if (process.env.MCP_HANG_INIT) return;
      result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: 'pcode-test-mcp', version: '1.2.3' },
      });
      if (process.env.MCP_ASK_ROOTS) {
        serverRequestId += 1;
        send({ jsonrpc: '2.0', id: `srv-${serverRequestId}`, method: 'roots/list' });
        send({ jsonrpc: '2.0', id: `srv-ping`, method: 'ping' });
      }
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools });
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      switch (name) {
        case 'echo':
          if (typeof args.text !== 'string') return result(id, { isError: true, content: [{ type: 'text', text: 'text must be a string' }] });
          return result(id, text(`echo: ${args.text}`));
        case 'add':
          if (typeof args.a !== 'number' || typeof args.b !== 'number') return result(id, { isError: true, content: [{ type: 'text', text: `a and b must be numbers (got ${typeof args.a}, ${typeof args.b})` }] });
          return result(id, text(args.a + args.b));
        case 'fail':
          return result(id, { isError: true, content: [{ type: 'text', text: `boom: ${args.reason || 'no reason'}` }] });
        case 'slow':
          setTimeout(() => result(id, text('finally')), 1500);
          return;
        case 'env':
          return result(id, text(process.env.TEST_TOKEN || ''));
        case 'cwd':
          return result(id, text(process.cwd()));
        case 'roots':
          return result(id, text(JSON.stringify(rootsSeen)));
        case 'add_tool':
          tools.push({ name: 'dynamic', description: 'Added at runtime', inputSchema: { type: 'object', properties: {} } });
          result(id, text('added'));
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          return;
        case 'weird name.v2':
          return result(id, text('weird ok'));
        case 'image':
          return result(id, { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'caption' }, { type: 'resource', resource: { uri: 'test://greeting', text: 'embedded' } }] });
        default:
          return error(id, -32602, `Unknown tool: ${name}`);
      }
    }
    case 'resources/list':
      return result(id, {
        resources: [
          { uri: 'test://greeting', name: 'Greeting', description: 'A friendly greeting', mimeType: 'text/plain' },
          { uri: 'test://blob', name: 'Blob', mimeType: 'application/octet-stream' },
        ],
      });
    case 'resources/read':
      if (params.uri === 'test://greeting') return result(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'hello from resource' }] });
      if (params.uri === 'test://blob') return result(id, { contents: [{ uri: params.uri, mimeType: 'application/octet-stream', blob: 'AAAABBBB' }] });
      return error(id, -32002, `Resource not found: ${params.uri}`);
    case 'prompts/list':
      return result(id, { prompts: [{ name: 'review', description: 'Review a file', arguments: [{ name: 'file', description: 'Path', required: true }] }] });
    case 'prompts/get':
      if (params.name !== 'review') return error(id, -32602, `Unknown prompt: ${params.name}`);
      return result(id, { description: 'Review', messages: [{ role: 'user', content: { type: 'text', text: `Please review ${(params.arguments || {}).file || '?'}` } }] });
    default:
      if (id !== undefined && id !== null) error(id, -32601, `Method not found: ${method}`);
  }
}

// Reader: newline-delimited JSON (the client always writes one JSON object per line).
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(parsed);
});
rl.on('close', () => process.exit(0));
