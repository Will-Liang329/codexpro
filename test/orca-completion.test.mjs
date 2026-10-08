import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchOrca, waitForOrca } from '../dist/executionBackend.js';

const workspace = await fs.realpath(os.tmpdir());
const config = { orcaExecutable: 'configured-orca', orcaTimeoutMs: 1000 };
const id = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', coordinatorHandle: 'term-coord' };
const opts = { maxWaitMs: 5000, pollMs: 1000, workspace };
// Real report artifacts for filesystem-aware reportPath confinement.
const fixtureDir = await fs.mkdtemp(path.join(workspace, 'orca-report-'));
const fixtureRel = path.relative(workspace, fixtureDir);
await fs.writeFile(path.join(fixtureDir, 'r.md'), 'report');
const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-outside-'));
await fs.writeFile(path.join(outsideDir, 'report.md'), 'secret');
await fs.mkdir(path.join(fixtureDir, 'ws'));
await fs.writeFile(path.join(fixtureDir, 'ws', 'r.md'), 'report');
await fs.symlink(outsideDir, path.join(fixtureDir, 'ws', 'escape'));
await fs.symlink(path.join(fixtureDir, 'missing-target'), path.join(fixtureDir, 'ws', 'broken'));
await fs.symlink(path.join(fixtureDir, 'ws', 'r.md'), path.join(fixtureDir, 'ws', 'inside-link.md'));
process.on('exit', () => { try { fsSync.rmSync(fixtureDir, { recursive: true, force: true }); fsSync.rmSync(outsideDir, { recursive: true, force: true }); } catch {} });
const ok = (result, exitCode = 0) => ({ exitCode, stdout: JSON.stringify({ ok: true, result }), stderr: 'SECRET_PROVIDER_STDERR sk-abcdefghijklmnopqrstuvwxyz123456' });
const fail = (code, message) => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }), stderr: 'noise' });
const done = (over = {}, msg = {}) => ({ id: 'msg-done', run_id: 'run-1', type: 'worker_done', from_handle: 'term-worker', subject: 'Done',
  body: 'Implemented it.', created_at: '2026-10-08T00:00:00Z',
  payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded', ...over }), ...msg });
const noise = (n) => ({ id: `msg-${n}`, run_id: 'run-1', type: 'heartbeat', payload: '{}' });
const shown = (outcome = 'succeeded', extra = {}) => ({
  dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'completed' },
  worker: { state: 'ready', agentTerminalHandle: 'term-worker', startOptions: { launch: {
    requested: { agent: 'codex', model: 'm', effort: 'high' }, effective: { agent: 'codex', model: 'm', effort: 'high' } } } },
  projection: { dispatchId: 'ctx-1', outcome, stage: { detail: 'done' }, liveness: { verdict: 'live' }, attention: { requiresAction: false },
    preview: 'RAW TERMINAL SECRET' },
  observation: { agentWait: null }, terminal: { preview: 'RAW TERMINAL SECRET' }, ...extra });
const tasks = (status = 'completed') => ({ tasks: [{ id: 'other', status: 'failed', run_id: 'run-1' }, { id: 'task-1', run_id: 'run-1', status, spec: 'x' }] });

// batches: array of check results (each consumed in order); extra overrides for other commands
function mock({ batches = [], show = shown(), list = tasks(), ackFail = false, onCheck, history = [], historyFail } = {}) {
  const calls = [];
  let i = 0;
  const process = async (binary, args, cwd, timeout) => {
    calls.push({ binary, args, cwd, timeout });
    const cmd = args[1];
    if (cmd === 'check') {
      onCheck?.(args, calls);
      if (args.includes('--all')) return historyFail ?? ok({ runId: 'run-1', messages: history, count: history.length });
      if (args.includes('--peek')) return ackFail ? fail(typeof ackFail === 'string' ? ackFail : 'boom', 'ack failed') : ok({ runId: 'run-1', messages: [], count: 0, acknowledged: args[args.indexOf('--ack') + 1] });
      const b = batches[i++] ?? { runId: 'run-1', deliveryId: null, messages: [], count: 0, timedOut: true };
      return typeof b === 'function' ? b(args) : b.stdout ? b : ok(b);
    }
    if (cmd === 'worker-show') return show.stdout ? show : ok(show);
    if (cmd === 'task-list') return list.stdout ? list : ok(list);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { calls, process };
}
const delivery = (deliveryId, messages) => ({ runId: 'run-1', deliveryId, messages, count: messages.length, acknowledged: null });
const checks = (m) => m.calls.filter(c => c.args[1] === 'check');
const ackOf = (m) => { const c = checks(m).filter((x) => x.args.includes('--ack')).at(-1).args; return c[c.indexOf('--ack') + 1]; };
const run = (m, o = opts) => waitForOrca(config, id, o, m.process);
const verbs = (m) => m.calls.map(c => c.args[1]);

test('launch receipt identity is exactly what the bridge consumes', async () => {
  const receipt = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', state: 'ready', launch: { requested: { agent: 'codex', model: 'm', effort: 'high' }, effective: { agent: 'codex', model: 'm', effort: 'high' } } };
  const launchProc = async (b, args) => {
    const stage = args.slice(0, 2).join(' ');
    const r = { 'status --json': { target: { kind: 'local' }, runtime: { reachable: true, state: 'ready' } },
      'worktree show': { worktree: { id: 'w', path: workspace, identity: { key: 'k', executionHostId: 'local' } } },
      'terminal create': { terminal: { handle: 'term-coord', worktreeId: 'w' } }, 'orchestration run-create': { run: { id: 'run-1' } },
      'orchestration worker-start': receipt }[stage];
    return ok(r);
  };
  const out = await launchOrca(config, { workspace, plan: 'p', agent: 'codex', model: 'm', reasoningEffort: 'high' }, launchProc);
  const m = mock({ batches: [delivery('d1', [done()])] });
  const result = await waitForOrca(config, { runId: out.runId, taskId: out.taskId, dispatchId: out.dispatchId, coordinatorHandle: out.coordinator_handle }, opts, m.process);
  assert.equal(result.state, 'completed');
  assert.equal(checks(m)[0].args[checks(m)[0].args.indexOf('--terminal') + 1], 'term-coord');
  assert.ok(m.calls.some(c => c.args[1] === 'worker-show' && c.args.includes('ctx-1')));
});

test('timeout with no message is running, never completed', async () => {
  const m = mock({ show: shown('in_progress'), list: tasks('dispatched') });
  const r = await run(m);
  assert.equal(r.state, 'running'); assert.equal(r.awaited_terminal, false); assert.equal(r.succeeded, false);
  assert.equal(r.next_poll_after_seconds, 1); assert.equal(r.cross_check.status, 'pending');
  assert.equal(r.outcome, undefined); assert.equal(r.evidence_conflict, undefined);
  const c = checks(m)[0].args;
  assert.ok(c.includes('--wait') && c.includes('--timeout-ms'));
  assert.equal(c[c.indexOf('--types') + 1], 'worker_done,question,escalation');
});

test('matching successful worker_done completes with optional fields and exact ids', async () => {
  const m = mock({ batches: [delivery('d1', [done({ filesModified: ['a.ts', 'b.ts'], reportPath: path.join(fixtureRel, 'r.md') })])] });
  const r = await run(m);
  assert.deepEqual([r.backend, r.state, r.awaited_terminal, r.awaited_completed, r.succeeded, r.outcome], ['orca', 'completed', true, true, true, 'succeeded']);
  assert.deepEqual([r.runId, r.taskId, r.dispatchId], ['run-1', 'task-1', 'ctx-1']);
  assert.equal(r.summary, 'Implemented it.');
  assert.deepEqual(r.filesModified, ['a.ts', 'b.ts']);
  assert.equal(r.reportPath, path.join(fixtureRel, 'r.md'));
  assert.equal(r.worker_done.message_id, 'msg-done'); assert.equal(r.worker_done.delivery_id, 'd1');
  assert.equal(r.cross_check.status, 'consistent'); assert.equal(r.evidence_conflict, undefined);
  assert.deepEqual(r.effective, { agent: 'codex', model: 'm', effort: 'high' });
  assert.deepEqual(r.requested, r.effective);
});

test('optional fields are absent safely; unsafe reportPath is dropped', async () => {
  let r = await run(mock({ batches: [delivery('d1', [done()])] }));
  assert.ok(!('filesModified' in r) && !('reportPath' in r));
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a\u0000b']) {
    r = await run(mock({ batches: [delivery('d1', [done({ reportPath: bad })])] }));
    assert.ok(!('reportPath' in r)); assert.equal(r.reportPath_rejected, true);
  }
  r = await run(mock({ batches: [delivery('d1', [done({ reportPath: path.join(fixtureDir, 'r.md') })])] }));
  assert.equal(r.reportPath, path.join(fixtureDir, 'r.md'));
});

test('matching failed worker_done is terminal and not succeeded', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done({ outcome: 'failed' })])], show: shown('failed'), list: tasks('failed') }));
  assert.deepEqual([r.state, r.awaited_terminal, r.awaited_completed, r.succeeded, r.outcome], ['failed', true, false, false, 'failed']);
  assert.equal(r.cross_check.status, 'consistent');
});

test('worker_done without explicit outcome is not completion', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done({ outcome: undefined })])], show: shown('in_progress'), list: tasks('dispatched') }));
  assert.equal(r.awaited_terminal, false); assert.equal(r.state, 'unknown'); assert.ok(r.evidence_conflict.length);
});

for (const [name, over] of [['taskId', { taskId: 'task-other' }], ['dispatchId', { dispatchId: 'ctx-other' }]]) {
  test(`wrong ${name} is never completion for the awaited task`, async () => {
    const r = await run(mock({ batches: [delivery('d1', [done(over)])], show: shown('in_progress'), list: tasks('dispatched') }));
    assert.equal(r.awaited_terminal, false); assert.equal(r.succeeded, false); assert.equal(r.outcome, undefined);
    assert.match(r.evidence_conflict.join(), new RegExp(`only the ${name === 'taskId' ? 'Dispatch' : 'Task'}`));
  });
}
test('completely unrelated worker_done is silently ignored', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done({ taskId: 'x', dispatchId: 'y' })])], show: shown('in_progress'), list: tasks('dispatched') }));
  assert.equal(r.state, 'running'); assert.equal(r.ignored_messages, 1); assert.equal(r.evidence_conflict, undefined);
});

test('stale unrelated deliveries are acked by exact id and do not block the matching worker_done', async () => {
  const m = mock({ batches: [delivery('stale-1', [noise(1)]), delivery('stale-2', [done({ taskId: 'x', dispatchId: 'y' }, { id: 'old' })]), delivery('d3', [noise(2), done()])] });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.delivery_id, 'd3');
  const acks = checks(m).map(c => c.args.includes('--ack') ? c.args[c.args.indexOf('--ack') + 1] : null);
  assert.deepEqual(acks, [null, 'stale-1', 'stale-2', 'd3']);
});

test('ACK is sent only after the batch was processed and never as a wake-up check', async () => {
  const order = [];
  const m = mock({ batches: [delivery('d1', [done()])], onCheck: (args) => order.push(args.includes('--ack') ? 'ack' : 'read') });
  const r = await run(m);
  assert.deepEqual(order, ['read', 'ack']);
  const ack = checks(m).at(-1).args;
  assert.ok(ack.includes('--peek') && !ack.includes('--wait'));
  assert.equal(ack[ack.indexOf('--ack') + 1], 'd1');
  assert.deepEqual(r.ack, { delivery_id: 'd1', status: 'acknowledged' });
  assert.ok(verbs(m).indexOf('check') < verbs(m).indexOf('worker-show'));
});

test('failed ack is reported but never changes the authoritative result', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done()])], ackFail: true }));
  assert.equal(r.state, 'completed'); assert.equal(r.ack.status, 'failed'); assert.equal(r.ack.delivery_id, 'd1');
});

test('question/escalation surface as blocked and are acked, not completion', async () => {
  const q = { id: 'msg-q', run_id: 'run-1', type: 'question', subject: 'Which?', body: 'A or B? token=abc123abc123abc123abc123', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1' }) };
  const m = mock({ batches: [delivery('dq', [q])], show: shown('in_progress'), list: tasks('dispatched') });
  const r = await run(m);
  assert.equal(r.state, 'blocked'); assert.equal(r.awaited_terminal, false);
  assert.equal(r.pending_messages[0].id, 'msg-q');
  assert.equal(ackOf(m), 'dq');
});

test('malformed, error and unreachable Orca responses fail safely without acking', async () => {
  for (const bad of [{ exitCode: 0, stdout: 'not json <<SECRET_PROVIDER_STDERR>>', stderr: 'x' }, fail('consumer_fenced', 'nope'), ok({ runId: 'other', messages: [], deliveryId: 'z' })]) {
    const m = mock({ batches: [bad] });
    const r = await run(m);
    assert.equal(r.state, 'unknown'); assert.equal(r.awaited_terminal, false); assert.equal(r.succeeded, false);
    assert.ok(r.error.code); assert.ok(!JSON.stringify(r).includes('SECRET_PROVIDER_STDERR'));
    assert.ok(!checks(m).some(c => c.args.includes('--ack')));
  }
  const r = await waitForOrca(config, id, opts, async () => { throw new Error('Orca process unavailable'); });
  assert.equal(r.state, 'unknown'); assert.equal(r.error.code, 'orca_unavailable');
});

test('cross-check mismatch is surfaced and does not override the worker_done', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done()])], show: shown('in_progress'), list: tasks('dispatched') }));
  assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true);
  assert.equal(r.cross_check.status, 'mismatch'); assert.equal(r.cross_check.task_status, 'dispatched');
  assert.ok(r.evidence_conflict.some(c => /Task status/.test(c)) && r.evidence_conflict.some(c => /Dispatch outcome/.test(c)));
  const spoof = await run(mock({ batches: [delivery('d1', [done({}, { from_handle: 'term-intruder' })])] }));
  assert.ok(spoof.evidence_conflict.some(c => /sender/.test(c)));
});

test('settled Orca Task without a worker_done is unknown, not completed', async () => {
  const r = await run(mock({ list: tasks('completed') }));
  assert.equal(r.state, 'unknown'); assert.equal(r.succeeded, false); assert.match(r.evidence_conflict[0], /no matching worker_done/);
});

test('already-acked worker_done is recovered idempotently from read-only history, without acking again', async () => {
  const m = mock({ history: [noise(1), done({ filesModified: ['a'] })] });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.worker_done.delivery_id, undefined); assert.deepEqual(r.filesModified, ['a']);
  assert.ok(!checks(m).some(c => c.args.includes('--ack')));
  const wrong = await run(mock({ history: [done({ dispatchId: 'zzz' })] }));
  assert.equal(wrong.state, 'unknown'); assert.equal(wrong.succeeded, false);
});

test('unavailable cross-check does not block authoritative completion', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done()])], show: fail('dispatch_not_found', 'gone') }));
  assert.equal(r.state, 'completed'); assert.equal(r.cross_check.status, 'unavailable');
});

test('output never contains provider stderr, raw terminal preview, secrets or foreign task data', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done({ filesModified: ['k=sk-abcdefghijklmnopqrstuvwxyz123456'] }, { body: 'done sk-abcdefghijklmnopqrstuvwxyz123456' })])] }));
  const text = JSON.stringify(r);
  for (const leak of ['SECRET_PROVIDER_STDERR', 'RAW TERMINAL SECRET', 'sk-abcdefghijklmnopqrstuvwxyz123456', 'other']) assert.ok(!text.includes(leak), leak);
});

test('read-only: only check/worker-show/task-list run, no retry, release, restart or duplicate execution', async () => {
  const m = mock({ batches: [delivery('d1', [done({ outcome: 'failed' })])], show: shown('failed'), list: tasks('failed') });
  await run(m);
  assert.deepEqual([...new Set(verbs(m))].sort(), ['check', 'task-list', 'worker-show']);
  for (const c of m.calls) {
    assert.equal(c.binary, 'configured-orca'); assert.ok(c.args.includes('--json'));
    for (const forbidden of ['worker-start', 'worker-release', 'worker-stop', 'worker-abandon', 'task-update', 'dispatch', 'send', 'reply', '--retry-of']) assert.ok(!c.args.includes(forbidden), forbidden);
  }
  assert.equal(checks(m).length, 2);
});

test('bounded: stops after the deadline and caps batch iterations', async () => {
  let t = 0;
  const m = mock({ batches: Array.from({ length: 10 }, () => delivery('dX', [noise(1)])), show: shown('in_progress'), list: tasks('dispatched') });
  const r = await waitForOrca(config, id, { ...opts, maxWaitMs: 1000 }, m.process, () => (t += 400));
  assert.equal(r.state, 'running');
  assert.ok(checks(m).length <= 4);
  const endless = mock({ batches: Array.from({ length: 80 }, (_, n) => delivery(`d${n}`, [noise(1)])), show: shown('in_progress'), list: tasks('dispatched') });
  const r2 = await run(endless);
  assert.equal(r2.state, 'running'); assert.ok(checks(endless).length <= 52);
});

test('MCP wait_for_handoff: Orca identity routes to Orca; validation rejects partial identity; AHR path untouched', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-wait-mcp-'));
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'fake-orca.mjs');
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, a.slice(0,2).join(' ') + '\\n');
const out = (r) => process.stdout.write(JSON.stringify({ ok: true, result: r }));
process.stderr.write('SECRET_PROVIDER_STDERR');
if (a[1] === 'check') out(a.includes('--peek') ? { runId: 'run-1', messages: [], count: 0, acknowledged: a[a.indexOf('--ack') + 1] } : { runId: 'run-1', deliveryId: 'd1', count: 1, messages: [{ id: 'm1', run_id: 'run-1', type: 'worker_done', from_handle: 'w', body: 'ok', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' }) }] });
else if (a[1] === 'worker-show') out({ dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1' }, worker: { agentTerminalHandle: 'w' }, projection: { outcome: 'succeeded' } });
else out({ tasks: [{ id: 'task-1', run_id: 'run-1', status: 'completed' }] });
`);
  await fs.chmod(fake, 0o755);
  const client = new Client({ name: 'orca-wait-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/stdio.js'), '--root', dir],
    env: { ...process.env, CODEXPRO_EXECUTION_BACKEND: 'orca', CODEXPRO_ORCA_BINARY: fake, CODEXPRO_BASH_MODE: 'off' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const partial = await client.callTool({ name: 'wait_for_handoff', arguments: { orca_run_id: 'run-1', max_wait_seconds: 1 } });
    assert.equal(partial.isError, true);
    assert.deepEqual(partial.structuredContent.invalid_fields.sort(), ['coordinatorHandle', 'dispatchId', 'taskId']);
    await assert.rejects(fs.access(log));
    const done = await client.callTool({ name: 'wait_for_handoff', arguments: { orca_run_id: 'run-1', orca_task_id: 'task-1', orca_dispatch_id: 'ctx-1', orca_coordinator_handle: 'term-coord', max_wait_seconds: 1 } });
    assert.ok(!done.isError, JSON.stringify(done));
    assert.equal(done.structuredContent.backend, 'orca'); assert.equal(done.structuredContent.state, 'completed');
    assert.equal(done.structuredContent.succeeded, true);
    assert.ok(!JSON.stringify(done).includes('SECRET_PROVIDER_STDERR'));
    assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), ['orchestration check', 'orchestration check', 'orchestration worker-show', 'orchestration task-list']);
    assert.equal(done.structuredContent.ack.status, 'acknowledged');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'wait_for_handoff');
    assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false); assert.equal(tool.annotations.idempotentHint, false);
    assert.doesNotMatch(tool.description, /Read-only|never starts processes/);
    const ahr = await client.callTool({ name: 'wait_for_handoff', arguments: { max_wait_seconds: 1 } });
    assert.equal(ahr.structuredContent.backend, undefined); assert.equal(ahr.structuredContent.state, 'unknown');
    assert.match(ahr.structuredContent.state_file, /handoff-run-state\.json$/);
  } finally { await client.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
});

const generic = (over = {}) => ({ id: 'msg-gq', run_id: 'run-1', type: 'question', from_handle: 'term-other', subject: 'Other?', body: 'unrelated', payload: '{}', ...over });

test('P2-2: generic/stale question before the matching worker_done is drained and completion is reached', async () => {
  for (const payload of ['{}', 'not json', JSON.stringify({ taskId: 'task-other', dispatchId: 'ctx-other' }), JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-other' })]) {
    for (const type of ['question', 'escalation']) {
      const m = mock({ batches: [delivery('d1', [generic({ type, payload })]), delivery('d2', [done()])] });
      const r = await run(m);
      assert.equal(r.state, 'completed', `${type} ${payload}`); assert.equal(r.worker_done.delivery_id, 'd2');
      assert.equal(r.pending_messages, undefined);
      const acks = checks(m).filter((c) => c.args.includes('--ack')).map((c) => c.args[c.args.indexOf('--ack') + 1]);
      assert.deepEqual(acks, ['d1', 'd2']);
    }
  }
});

test('P2-2: attributable question/escalation (payload Task or Dispatch) stays blocked and exact-ACKed', async () => {
  for (const payload of [{ taskId: 'task-1', dispatchId: 'ctx-1' }, { dispatchId: 'ctx-1' }, { taskId: 'task-1' }]) {
    for (const type of ['question', 'escalation']) {
      const m = mock({ batches: [delivery('dq', [generic({ type, payload: JSON.stringify(payload) }), ]), delivery('dz', [done()])], show: shown('in_progress'), list: tasks('dispatched') });
      const r = await run(m);
      assert.equal(r.state, 'blocked'); assert.equal(r.pending_messages[0].type, type); assert.equal(ackOf(m), 'dq');
      assert.equal(checks(m).filter((c) => !c.args.includes('--all') && !c.args.includes('--peek')).length, 1);
    }
  }
});

test('P2-3: ACKed worker_done is recovered when worker-show is unavailable', async () => {
  const m = mock({ history: [done()], show: fail('dispatch_not_found', 'gone') });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.cross_check.status, 'unavailable'); assert.ok(checks(m).some((c) => c.args.includes('--all')));
  assert.ok(!checks(m).some((c) => c.args.includes('--ack')));
});

test('P2-3: ACKed worker_done is recovered while Task projection is non-terminal, or with task-list failing', async () => {
  let r = await run(mock({ history: [done()], show: shown('in_progress'), list: tasks('dispatched') }));
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.cross_check.task_status, 'dispatched'); assert.ok(r.evidence_conflict.some((c) => /Task status is dispatched/.test(c)));
  r = await run(mock({ history: [done()], list: fail('x', 'down') }));
  assert.equal(r.state, 'completed');
  r = await run(mock({ history: [done({ outcome: 'failed' })], show: fail('x', 'down'), list: tasks('dispatched') }));
  assert.equal(r.state, 'failed'); assert.equal(r.succeeded, false);
});

test('P2-3: recovery needs exact Task/Dispatch/outcome even with an unrelated pending message', async () => {
  const q = generic({ payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1' }) });
  let r = await run(mock({ batches: [delivery('dq', [q])], history: [done()], show: shown('in_progress'), list: tasks('dispatched') }));
  assert.equal(r.state, 'completed');
  r = await run(mock({ history: [done({ dispatchId: 'zzz' }), done({ outcome: 'maybe' })], show: fail('x', 'down') }));
  assert.notEqual(r.state, 'completed'); assert.equal(r.succeeded, false);
});

test('P2-4: reportPath is confined by real path (symlink escape, broken link, missing file rejected)', async () => {
  const ws = path.join(fixtureDir, 'ws');
  const narrow = { ...opts, workspace: ws };
  for (const bad of ['escape/report.md', path.join(ws, 'escape', 'report.md'), 'broken', 'missing.md', path.join(outsideDir, 'report.md'), '.']) {
    const r = await run(mock({ batches: [delivery('d1', [done({ reportPath: bad })])] }), narrow);
    assert.equal(r.state, 'completed', bad); assert.ok(!('reportPath' in r), bad); assert.equal(r.reportPath_rejected, true, bad);
  }
  for (const good of ['inside-link.md', 'r.md', path.join(ws, 'r.md')]) {
    const r = await run(mock({ batches: [delivery('d1', [done({ reportPath: good })])] }), narrow);
    assert.equal(r.reportPath, good);
  }
  const none = await run(mock({ batches: [delivery('d1', [done({ reportPath: 'r.md' })])] }), { ...opts, workspace: undefined });
  assert.equal(none.state, 'completed'); assert.equal(none.reportPath_rejected, true);
});

test('P2-5: malformed messages shape fails safely and is never ACKed', async () => {
  for (const messages of [{ wrong: 'shape' }, 'x', null, undefined, [null], ['str']]) {
    const m = mock({ batches: [ok({ runId: 'run-1', deliveryId: 'dbad', messages, count: 1 })] });
    const r = await run(m);
    assert.equal(r.state, 'unknown'); assert.equal(r.error.code, 'malformed_result'); assert.equal(r.succeeded, false);
    assert.ok(!checks(m).some((c) => c.args.includes('--ack')), JSON.stringify(messages));
    assert.ok(!r.ack);
  }
  const m = mock({ batches: [delivery('d1', [noise(1)]), ok({ runId: 'run-1', deliveryId: 'd2', messages: 'bad', acknowledged: 'd1' })] });
  const r = await run(m);
  assert.equal(r.state, 'unknown'); assert.deepEqual(r.ack, { delivery_id: 'd1', status: 'acknowledged' });
  assert.ok(!checks(m).some((c) => c.args.includes('--ack') && c.args.includes('d2')));
});

test('P2-5: invalid final ACK receipt is not reported acknowledged but keeps the worker_done verdict', async () => {
  for (const receipt of [{ runId: 'other-run', messages: [], acknowledged: 'd1' }, { runId: 'run-1', messages: [], acknowledged: null },
    { runId: 'run-1', messages: [], acknowledged: 'other-delivery' }, { runId: 'run-1', messages: [], count: 0 }]) {
    const m = mock({ batches: [delivery('d1', [done()])], onCheck: undefined });
    const base = m.process;
    const r = await waitForOrca(config, id, opts, async (b, args, cwd, t) => (args.includes('--peek') ? ok(receipt) : base(b, args, cwd, t)));
    assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true);
    assert.equal(r.ack.status, 'failed'); assert.equal(r.ack.delivery_id, 'd1'); assert.match(r.ack.error, /did not confirm/);
    assert.ok(!JSON.stringify(r).includes('SECRET_PROVIDER_STDERR'));
  }
  const good = await run(mock({ batches: [delivery('d1', [done()])] }));
  assert.equal(good.ack.status, 'acknowledged');
});

test('P2-5: mismatched ACK receipt on a follow-up check is not reported acknowledged', async () => {
  const m = mock({ batches: [delivery('d1', [noise(1)]), ok({ runId: 'run-1', deliveryId: null, messages: [], count: 0, acknowledged: 'zzz', timedOut: true })] });
  const r = await run(m);
  assert.equal(r.ack.status, 'failed'); assert.equal(r.ack.delivery_id, 'd1');
});

// ---- RF2 P2-5 remainder ----
const acked = (extra = {}) => (args) => ok({ runId: 'run-1', deliveryId: null, messages: [], count: 0, timedOut: true, acknowledged: args[args.indexOf('--ack') + 1], ...extra });
const withReceipt = (receipt, rest = {}) => ({ runId: 'run-1', deliveryId: null, messages: [], count: 0, timedOut: true, ...receipt, ...rest });

test('RF2: intermediate ACK receipt uses the strict exact-delivery rule', async () => {
  const cases = [['null', { acknowledged: null }], ['absent', {}], ['number', { acknowledged: 42 }], ['wrong string', { acknowledged: 'wrong' }]];
  for (const [label, receipt] of cases) {
    const r = await run(mock({ list: tasks('running'), show: shown(undefined), batches: [delivery('old', [noise(1)]), withReceipt(receipt)] }));
    assert.equal(r.state, 'running', label);
    assert.equal(r.ack.status, 'failed', label); assert.equal(r.ack.delivery_id, 'old', label);
    assert.equal(r.ack_failures.length, 1, label); assert.equal(r.ack_failures[0].delivery_id, 'old', label);
  }
  const good = await run(mock({ list: tasks('running'), show: shown(undefined), batches: [delivery('old', [noise(1)]), acked()] }));
  assert.deepEqual(good.ack, { delivery_id: 'old', status: 'acknowledged' }); assert.ok(!good.ack_failures);
});

test('RF2: earlier ACK failure survives a later successful final ACK and the worker_done verdict is unchanged', async () => {
  const m = mock({ list: tasks('running'), show: shown(undefined), batches: [delivery('old', [noise(1)]), ok({ ...delivery('done', [done()]), acknowledged: 'wrong' })] });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true); assert.equal(r.outcome, 'succeeded');
  assert.deepEqual(r.ack, { delivery_id: 'done', status: 'acknowledged' });
  assert.deepEqual(r.ack_failures.map((f) => f.delivery_id), ['old']);
  // failed final ACK too: both preserved, verdict still authoritative
  const m2 = mock({ list: tasks('running'), show: shown(undefined), batches: [delivery('old', [noise(1)]), ok({ ...delivery('done', [done()]), acknowledged: null })], ackFail: true });
  const r2 = await run(m2);
  assert.equal(r2.state, 'completed'); assert.equal(r2.ack.status, 'failed'); assert.equal(r2.ack_failures[0].delivery_id, 'old');
});

test('RF2: malformed history fails safely when no worker_done was validated', async () => {
  const cases = [['wrong run', { runId: 'other', messages: [], count: 0 }], ['messages object', { runId: 'run-1', messages: { a: 1 } }],
    ['null row', { runId: 'run-1', messages: [null] }], ['empty row', { runId: 'run-1', messages: [{}] }],
    ['invalid row', { runId: 'run-1', messages: [{ id: 5, type: 'worker_done' }] }]];
  for (const [label, result] of cases) {
    const m = mock({ list: tasks('running'), show: shown(undefined), batches: [] });
    const r = await waitForOrca(config, id, opts, async (b, args, cwd, t) => (args.includes('--all') ? ok(result) : m.process(b, args, cwd, t)));
    assert.equal(r.state, 'unknown', label); assert.equal(r.succeeded, false, label);
    assert.ok(['run_mismatch', 'malformed_result'].includes(r.error.code), label); assert.equal(r.history_check, 'failed', label);
  }
  // normal empty history and unavailable history stay running
  assert.equal((await run(mock({ list: tasks('running'), show: shown(undefined) }))).state, 'running');
  const m = mock({ list: tasks('running'), show: shown(undefined) });
  const unavailable = await waitForOrca(config, id, opts, async (b, args, cwd, t) => (args.includes('--all') ? fail('boom', 'x') : m.process(b, args, cwd, t)));
  assert.equal(unavailable.state, 'running');
  // a validated worker_done is not overridden by a malformed history (history is never read)
  const done1 = await run(mock({ list: tasks('running'), show: shown(undefined), batches: [delivery('d1', [done()])], history: { wrong: 1 } }));
  assert.equal(done1.state, 'completed');
});

test('RF2: malformed consuming rows are rejected before any ACK', async () => {
  for (const row of [{}, { id: 'x' }, { type: 'worker_done' }, { id: '', type: 'heartbeat' }, { id: 'x', type: 7 }, { id: 3, type: 'heartbeat' }]) {
    const m = mock({ list: tasks('running'), show: shown(undefined), batches: [ok({ runId: 'run-1', deliveryId: 'dbad', messages: [noise(1), row], count: 2 })] });
    const r = await run(m);
    assert.equal(r.state, 'unknown', JSON.stringify(row)); assert.equal(r.error.code, 'malformed_result');
    assert.ok(!checks(m).some((c) => c.args.includes('--ack')), JSON.stringify(row));
  }
});

const FORBIDDEN = ['worker-start', 'worker-release', 'worker-stop', 'worker-abandon', 'task-update', 'dispatch', 'send', 'reply', '--retry-of'];
const noMutation = (m) => { for (const c of m.calls) for (const f of FORBIDDEN) assert.ok(!c.args.includes(f), f); };
const attributable = { id: 'msg-q', run_id: 'run-1', type: 'question', subject: 'Q', body: 'b', payload: JSON.stringify({ taskId: 'task-1' }) };

test('RF3 P2-6 A: consuming check consumer_fenced stays unknown with no ACK, history or fallback', async () => {
  const m = mock({ batches: [fail('consumer_fenced', 'fenced')] });
  const r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(r.error.code, 'consumer_fenced');
  assert.deepEqual(verbs(m), ['check']); noMutation(m);
});

test('RF3 P2-6 B: history consumer_fenced with no worker_done is unknown/error, not running', async () => {
  const m = mock({ show: { stdout: 'x', exitCode: 1 }, historyFail: fail('consumer_fenced', 'synthetic failure') });
  const r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(r.error.code, 'consumer_fenced'); assert.equal(r.history_check, 'failed');
  assert.equal(r.succeeded, false); assert.equal(r.awaited_terminal, false); noMutation(m);
  // ordinary history unavailability stays best-effort
  const plain = await run(mock({ historyFail: fail('orca_error', 'down'), show: shown('in_progress'), list: tasks('dispatched') }));
  assert.equal(plain.state, 'running');
});

test('RF3 P2-6 C: final ACK consumer_fenced with only a blocker is unknown/error and keeps ACK evidence', async () => {
  const m = mock({ batches: [delivery('pending', [attributable])], ackFail: 'consumer_fenced', show: shown('in_progress'), list: tasks('dispatched') });
  const r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(r.error.code, 'consumer_fenced'); assert.equal(r.succeeded, false);
  assert.equal(r.ack.status, 'failed'); assert.equal(r.ack.code, 'consumer_fenced'); assert.equal(r.pending_messages[0].id, 'msg-q');
  assert.ok(!verbs(m).includes('worker-show') && !m.calls.some((c) => c.args.includes('--all'))); noMutation(m);
  // earlier ACK failures are kept
  const m2 = mock({ batches: [ok({ ...delivery('old', [noise(1)]), acknowledged: null }), delivery('pending', [attributable])], ackFail: 'consumer_fenced' });
  const r2 = await run(m2);
  assert.equal(r2.error.code, 'consumer_fenced');
});

test('RF3 P2-6 D/E: validated worker_done stays authoritative over a final ACK consumer_fenced', async () => {
  for (const outcome of ['succeeded', 'failed']) {
    const m = mock({ batches: [delivery('d1', [done({ outcome })])], ackFail: 'consumer_fenced', show: shown(outcome), list: tasks(outcome === 'succeeded' ? 'completed' : 'failed') });
    const r = await run(m);
    assert.equal(r.state, outcome === 'succeeded' ? 'completed' : 'failed'); assert.equal(r.outcome, outcome);
    assert.equal(r.ack.status, 'failed'); assert.equal(r.ack.code, 'consumer_fenced'); assert.equal(r.error, undefined);
    noMutation(m);
  }
});
