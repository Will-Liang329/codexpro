import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.CODEXPRO_ORCA_SMOKE !== '1') throw new Error('Opt in with CODEXPRO_ORCA_SMOKE=1');
const [workspaceArg, agent, model, effort = 'medium'] = process.argv.slice(2);
assert.ok(workspaceArg && ['codex', 'claude'].includes(agent) && model, 'Usage: <registered-disposable-workspace> <codex|claude> <model> [effort]');
const workspace = await fs.realpath(workspaceArg);
const root = fileURLToPath(new URL('../', import.meta.url));
const marker = `ORCA_${agent.toUpperCase()}_FULL_CHAIN_OK`;
const plan = `Integration smoke only.

Create or replace only:
.ai-bridge/orca/${agent}-smoke.txt

Final textual content must be exactly:
${marker}

A trailing newline is acceptable.

Do not modify source code, documentation, package files,
Git configuration, or any other file.

Verify the final file content before completing.
`;
const client = new Client({ name: 'codexpro-orca-smoke', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/stdio.js'), '--root', workspace],
  env: { ...process.env, CODEXPRO_EXECUTION_BACKEND: 'orca', CODEXPRO_BASH_MODE: 'off', CODEXPRO_WRITE_MODE: 'handoff', CODEXPRO_EXPOSE_ABSOLUTE_PATHS: '1' }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const out = await client.callTool({ name: 'handoff_to_agent', arguments: { agent, model, reasoning_effort: effort, title: `CodexPro ${agent} smoke`, plan } }, undefined, { timeout: 180000 });
  const receipt = out.structuredContent;
  console.log(JSON.stringify({ isError: out.isError ?? false, receipt }, null, 2));
  assert.ok(!out.isError, JSON.stringify(out.content));
  assert.equal(receipt.backend, 'orca'); assert.equal(receipt.state, 'ready');
  assert.equal(receipt.agent, agent); assert.equal(receipt.model, model); assert.equal(receipt.reasoning_effort, effort);
  assert.equal(receipt.workspace, workspace);
  assert.ok(receipt.runId && receipt.taskId && receipt.dispatchId);
  try { await fs.access(path.join(workspace, '.ai-bridge/current-plan.md')); throw new Error('Orca smoke unexpectedly wrote current-plan.md'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Launch readiness is not completion. Verify worker_done and file bytes separately through Orca.
} finally { await client.close(); }
