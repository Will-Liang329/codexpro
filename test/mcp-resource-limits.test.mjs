import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createCodexProServer } from '../dist/server.js';

const ELEMENT_LIMIT = 1024;
const errorText = (result) => result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

async function withClient(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-input-limit-'));
  const config = { ...loadConfig(['--root', root, '--allow-root', root]),
    writeMode: 'workspace', toolMode: 'full', bashMode: 'off', toolCards: false };
  const server = createCodexProServer(config);
  const client = new Client({ name: 'input-limit-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client, root);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function assertLimited(result) {
  assert.equal(result.isError, true, errorText(result));
  assert.match(errorText(result), /maximum of 1024 elements/);
}

test('tool input element boundary is enforced before schema stripping', async () => {
  await withClient(async (client) => {
    const flat = Object.fromEntries(Array.from({ length: ELEMENT_LIMIT }, (_, i) => [`key${i}`, i]));
    const accepted = await client.callTool({ name: 'server_config', arguments: flat });
    assert.ok(!accepted.isError, errorText(accepted));
    assertLimited(await client.callTool({ name: 'server_config', arguments: { ...flat, overflow: 1 } }));
    const healthy = await client.callTool({ name: 'server_config', arguments: {} });
    assert.ok(!healthy.isError, errorText(healthy));
  });
});

test('wide arrays, nested records and deep arguments cannot reach a write handler', async () => {
  await withClient(async (client, root) => {
    let deep = null;
    for (let i = 0; i < 10000; i += 1) deep = { next: deep };
    const wide = Object.fromEntries(Array.from({ length: ELEMENT_LIMIT }, (_, i) => [`key${i}`, i]));
    for (const payload of [Array(ELEMENT_LIMIT).fill('x'), wide, deep]) {
      const result = await client.callTool({ name: 'codexpro', arguments: {
        action: 'write', args: { path: 'blocked.txt', content: 'must not be written', payload }
      } });
      assertLimited(result);
      await assert.rejects(fs.access(path.join(root, 'blocked.txt')), { code: 'ENOENT' });
    }
    const valid = await client.callTool({ name: 'codexpro', arguments: {
      action: 'write', args: { path: 'valid.txt', content: 'valid wrapped call' }
    } });
    assert.ok(!valid.isError, errorText(valid));
    assert.equal(await fs.readFile(path.join(root, 'valid.txt'), 'utf8'), 'valid wrapped call');
  });
});

test('documented maximum export selection and wrapped filters remain valid', async () => {
  await withClient(async (client, root) => {
    const selected = Array.from({ length: 80 }, (_, i) => `input-${i}.txt`);
    await Promise.all(selected.map((file) => fs.writeFile(path.join(root, file), 'fixture\n')));
    const result = await client.callTool({ name: 'codexpro', arguments: {
      action: 'export_pro_context', args: { selected_paths: selected,
        extra_globs: selected, max_files: 80, include_important_files: false,
        include_changed_files: false, include_diff: false, include_ai_bridge: false }
    } });
    assert.ok(!result.isError, errorText(result));
    assert.equal(result.structuredContent.files_included.length, 80);
  });
});

async function withHttpClient(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-input-limit-'));
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ['dist/http.js', '--root', root, '--allow-root', root,
    '--host', '127.0.0.1', '--port', String(port), '--no-auth', '--write', 'workspace',
    '--tool-mode', 'full', '--bash', 'off'], {
    env: { ...process.env, CODEXPRO_HOME: path.join(root, 'profile'), CODEXPRO_TUNNEL_MODE: '0', CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1',
      CODEXPRO_HTTP_TOKEN: '', CODEBASE_BRIDGE_HTTP_TOKEN: '',
      CODEXPRO_MAX_READ_BYTES: '180000', CODEXPRO_MAX_WRITE_BYTES: '1000000' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: 'http-input-limit-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`HTTP startup timeout: ${stderr}`)), 15000);
      const onData = () => {
        if (stderr.includes('HTTP MCP listening')) {
          clearTimeout(timer);
          child.stderr.off('data', onData);
          resolve();
        }
      };
      child.stderr.on('data', onData);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`HTTP startup failed: ${stderr}`)); });
    });
    await client.connect(transport);
    const post = (body, extra = {}) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId,
        'mcp-protocol-version': '2025-03-26', ...extra.headers }, body, ...extra
    });
    await run({ client, root, post });
  } finally {
    await client.close().catch(() => {});
    child.kill('SIGTERM');
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function rpcResult(response) {
  assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  const message = JSON.parse(data ? data.slice(6) : text);
  assert.ok(!message.error, JSON.stringify(message));
  return message.result;
}

test('HTTP rejects wide and deeply nested tool input before handler side effects', { timeout: 30000 }, async () => {
  await withHttpClient(async ({ client, root, post }) => {
    const prefix = '{"jsonrpc":"2.0","id":70,"method":"tools/call","params":{"name":"codexpro","arguments":{"action":"write","args":{"path":"blocked.txt","content":"blocked","payload":';
    const deep = '{"next":'.repeat(10000) + 'null' + '}'.repeat(10000);
    const wideArray = JSON.stringify(Array(ELEMENT_LIMIT).fill('x'));
    const wideRecord = JSON.stringify(Object.fromEntries(Array.from({ length: ELEMENT_LIMIT }, (_, i) => [`k${i}`, i])));
    for (const payload of [deep, wideArray, wideRecord]) {
      assertLimited(await rpcResult(await post(prefix + payload + '}}}}')));
      await assert.rejects(fs.access(path.join(root, 'blocked.txt')), { code: 'ENOENT' });
    }
    const valid = await client.callTool({ name: 'write', arguments: { path: 'valid.txt', content: 'HTTP still works' } });
    assert.ok(!valid.isError, errorText(valid));
    assert.equal(await fs.readFile(path.join(root, 'valid.txt'), 'utf8'), 'HTTP still works');
  });
});
