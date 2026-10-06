import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executionBackend, launchOrca, OrcaLaunchError, runOrcaProcess } from '../dist/executionBackend.js';
import { loadConfig } from '../dist/config.js';

const workspace = await fs.realpath(os.tmpdir());
const config = { orcaExecutable: 'configured-orca', orcaTimeoutMs: 1234 };
const input = { workspace, plan: '  Keep\nall whitespace.\n$(touch /tmp/unsafe)\n', agent: 'codex', model: 'opaque-model', reasoningEffort: 'medium', title: 'Smoke' };
const receipt = { runId: 'run-real', taskId: 'task-real', dispatchId: 'ctx-real', state: 'ready', turnStart: 'observed', launch: { requested: { agent: 'codex', model: 'opaque-model', effort: 'medium' }, effective: { agent: 'codex', model: 'opaque-model', effort: 'medium' } } };
function mock(overrides = {}) {
  const calls = [];
  const process = async (binary, args, cwd, timeout) => {
    calls.push({ binary, args, cwd, timeout });
    const stage = args.slice(0, 2).join(' ');
    if (overrides[stage]) return overrides[stage];
    const results = {
      'status --json': { target: { kind: 'local' }, runtime: { reachable: true, state: 'ready' } },
      'worktree show': { worktree: { id: 'repo::exact', path: workspace, identity: { key: 'wt2:local:exact', executionHostId: 'local' } } },
      'terminal create': { terminal: { handle: 'term-runtime-issued', worktreeId: 'repo::exact' } },
      'orchestration run-create': { run: { id: 'run-real' } },
      'orchestration worker-start': receipt,
    };
    assert.ok(results[stage], stage);
    return json(results[stage]);
  };
  return { calls, process };
}
function json(result, exitCode = 0, ok = true) { return { exitCode, stdout: JSON.stringify({ ok, result }), stderr: 'diagnostic noise' }; }
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('backend selection retains AHR default and explicit fallback, rejects typos', () => {
  assert.equal(executionBackend(undefined), 'ahr');
  assert.equal(executionBackend('ahr'), 'ahr');
  assert.equal(executionBackend('orca'), 'orca');
  assert.throws(() => executionBackend('orcaa'));
  const saved = process.env.CODEXPRO_EXECUTION_BACKEND;
  try {
    process.env.CODEXPRO_EXECUTION_BACKEND = 'orca';
    assert.equal(loadConfig([]).executionBackend, 'orca');
    process.env.CODEXPRO_EXECUTION_BACKEND = 'ahr';
    assert.equal(loadConfig([]).executionBackend, 'ahr');
  } finally {
    if (saved === undefined) delete process.env.CODEXPRO_EXECUTION_BACKEND;
    else process.env.CODEXPRO_EXECUTION_BACKEND = saved;
  }
});
test('argv preserves spec verbatim, exact model/effort, IDs and deterministic workspace identity', async () => {
  const m = mock();
  const out = await launchOrca(config, input, m.process);
  const worker = m.calls.at(-1);
  assert.equal(value(worker.args, '--spec'), input.plan);
  assert.equal(value(worker.args, '--agent'), input.agent);
  assert.equal(value(worker.args, '--model'), input.model);
  assert.equal(value(worker.args, '--effort'), 'medium');
  assert.equal(value(worker.args, '--worktree'), 'identity:wt2:local:exact');
  assert.equal(value(worker.args, '--from'), 'term-runtime-issued');
  assert.equal(value(worker.args, '--run'), 'run-real');
  assert.equal(value(worker.args, '--task-title'), 'Smoke');
  assert.equal(out.dispatchId, 'ctx-real');
  assert.equal(out.reasoning_effort, 'medium');
  assert.ok(m.calls.every(c => c.binary === config.orcaExecutable && c.cwd === workspace && c.timeout === 11234));
});
test('Claude opaque model and effort remain unchanged', async () => {
  const r = structuredClone(receipt);
  r.launch.requested = r.launch.effective = { agent: 'claude', model: 'opus', effort: 'high' };
  const m = mock({ 'orchestration worker-start': json(r) });
  const out = await launchOrca(config, { ...input, agent: 'claude', model: 'opus', reasoningEffort: 'high' }, m.process);
  assert.equal(out.model, 'opus');
  assert.equal(out.reasoning_effort, 'high');
});
for (const field of ['agent', 'model', 'effort']) test(`rejects silently changed effective ${field}`, async () => {
  const r = structuredClone(receipt); r.launch.effective[field] = 'provider-default';
  await assert.rejects(launchOrca(config, input, mock({ 'orchestration worker-start': json(r) }).process), new RegExp(`${field} was not preserved`));
});
for (const state of ['outcome_unknown', 'turn_start_unobserved', 'failed']) test(`does not report ${state} as success`, async () => {
  await assert.rejects(launchOrca(config, input, mock({ 'orchestration worker-start': json({ ...receipt, state }, 1) }).process), error => {
    assert.ok(error instanceof OrcaLaunchError);
    assert.equal(error.receipt.orca_receipt.result.state, state);
    assert.equal(error.receipt.orca_receipt.result.dispatchId, 'ctx-real');
    return true;
  });
});
test('exit zero with a non-ready state is also rejected', async () => {
  await assert.rejects(launchOrca(config, input, mock({ 'orchestration worker-start': json({ ...receipt, state: 'outcome_unknown' }) }).process), /outcome_unknown/);
});
test('nonzero cannot turn a ready JSON into success', async () => {
  await assert.rejects(launchOrca(config, input, mock({ 'orchestration worker-start': json(receipt, 7) }).process), /exit 7/);
});
test('malformed JSON and unavailable process propagate without credential output', async () => {
  await assert.rejects(launchOrca(config, input, mock({ 'status --json': { exitCode: 0, stdout: 'not json', stderr: 'secret' } }).process), /malformed JSON/);
  await assert.rejects(launchOrca(config, input, async () => { throw new Error('Unavailable'); }), /Unavailable/);
});
test('workspace mismatch fails before coordinator/run creation', async () => {
  const m = mock({ 'worktree show': json({ worktree: { path: '/wrong', id: 'wrong' } }) });
  await assert.rejects(launchOrca(config, input, m.process), /workspace identity/);
  assert.equal(m.calls.length, 2);
});
test('invalid inputs cannot allocate a Run or silently default effort', async () => {
  for (const change of [{ append: true }, { agent: 'custom' }, { model: undefined }, { plan: ' ' }]) {
    const m = mock();
    await assert.rejects(launchOrca(config, { ...input, ...change }, m.process));
    assert.equal(m.calls.length, 0);
  }
});
test('missing identity and IDs fail closed', async () => {
  await assert.rejects(launchOrca(config, input, mock({ 'orchestration worker-start': json({ ...receipt, dispatchId: undefined }) }).process), /dispatch id/);
});
test('subprocess uses literal argv, isolates stderr and propagates exit/timeout', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-process-test-'));
  try {
    const script = path.join(dir, 'fake.mjs');
    await fs.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("noise"); process.exitCode=7;');
    const out = await runOrcaProcess(process.execPath, [script, '$(touch unsafe)', 'a b'], dir, 1000);
    assert.equal(out.exitCode, 7); assert.equal(out.stderr, 'noise');
    assert.deepEqual(JSON.parse(out.stdout), ['$(touch unsafe)', 'a b']);
    assert.deepEqual(await fs.readdir(dir), ['fake.mjs']);
    await fs.writeFile(script, 'setInterval(()=>{},1000);');
    await assert.rejects(runOrcaProcess(process.execPath, [script], dir, 30), /timeout_or_signal/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
