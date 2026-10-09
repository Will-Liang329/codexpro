import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForOrca } from '../dist/executionBackend.js';
import { closeCoordinatorTerminal } from '../dist/orcaCoordinatorCleanup.js';
import { DEFAULT_COORDINATOR_TITLES, runBacklogCleanup } from '../dist/orcaCoordinatorBacklog.js';

const workspace = await fs.realpath(os.tmpdir());
const config = { orcaExecutable: 'configured-orca', orcaTimeoutMs: 1000 };
const id = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', coordinatorHandle: 'term-coord' };
const opts = { maxWaitMs: 5000, pollMs: 1000, workspace, closeCoordinator: true };
const ok = (result, exitCode = 0) => ({ exitCode, stdout: JSON.stringify({ ok: true, result }), stderr: 'SECRET_PROVIDER_STDERR' });
const fail = (code, message) => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }), stderr: 'noise' });

// ---------------------------------------------------------------------------------------------
// Live path: waitForOrca(closeCoordinator)
// ---------------------------------------------------------------------------------------------
const done = (over = {}, msg = {}) => ({ id: 'msg-done', run_id: 'run-1', type: 'worker_done', from_handle: 'term-worker', subject: 'Done',
  body: 'Implemented it.', created_at: '2026-10-08T00:00:00Z',
  payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded', ...over }), ...msg });
const noise = (n) => ({ id: `msg-${n}`, run_id: 'run-1', type: 'heartbeat', payload: '{}' });
const shown = (outcome = 'succeeded') => ({
  dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'completed' },
  worker: { state: 'ready', agentTerminalHandle: 'term-worker', startOptions: { launch: {} } },
  projection: { dispatchId: 'ctx-1', outcome, stage: { detail: 'done' }, liveness: { verdict: 'live' }, attention: { requiresAction: false } },
  observation: { agentWait: null } });
const tasks = (status = 'completed') => ({ tasks: [{ id: 'task-1', run_id: 'run-1', status }] });
const delivery = (deliveryId, messages) => ({ runId: 'run-1', deliveryId, messages, count: messages.length, acknowledged: null });
const attributable = { id: 'msg-q', run_id: 'run-1', type: 'question', subject: 'Q', body: 'b', payload: JSON.stringify({ taskId: 'task-1' }) };

function mock({ batches = [], show = shown(), list = tasks(), ackFail = false, history = [], historyFail, runShow, close, noRunShow } = {}) {
  const calls = [];
  let i = 0;
  const process = async (binary, args, cwd, timeout) => {
    calls.push({ binary, args, cwd, timeout });
    const [group, cmd] = args;
    if (group === 'terminal' && cmd === 'close') return typeof close === 'function' ? close(args) : close ?? ok({ closed: true });
    if (cmd === 'run-show') {
      if (noRunShow) throw new Error('Orca process unavailable or interrupted (ENOENT)');
      return runShow ?? ok({ run: { id: 'run-1', coordinator_handle: 'term-coord', consumer_generation: 1 } });
    }
    if (cmd === 'check') {
      if (args.includes('--all')) return historyFail ?? ok({ runId: 'run-1', messages: history, count: history.length });
      if (args.includes('--peek')) return ackFail ? fail(typeof ackFail === 'string' ? ackFail : 'boom', 'ack failed')
        : ok({ runId: 'run-1', messages: [], count: 0, acknowledged: args[args.indexOf('--ack') + 1] });
      const b = batches[i++] ?? { runId: 'run-1', deliveryId: null, messages: [], count: 0, timedOut: true };
      return b.stdout ? b : ok(b);
    }
    if (cmd === 'worker-show') return show.stdout ? show : ok(show);
    if (cmd === 'task-list') return list.stdout ? list : ok(list);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { calls, process };
}
const run = (m, o = opts) => waitForOrca(config, id, o, m.process);
const closes = (m) => m.calls.filter((c) => c.args[0] === 'terminal');
const indexOfCall = (m, pred) => m.calls.findIndex(pred);
const FORBIDDEN = ['worker-start', 'worker-release', 'worker-stop', 'worker-abandon', 'task-update', 'dispatch', 'send', 'reply', '--retry-of', '--all-terminals'];
const noLifecycle = (m) => { for (const c of m.calls) for (const f of FORBIDDEN) assert.ok(!c.args.includes(f), f); };

test('cleanup: closes exactly the Run coordinator after the exact ACK of a succeeded worker_done', async () => {
  const m = mock({ batches: [delivery('d1', [done()])] });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true); assert.equal(r.ack.status, 'acknowledged');
  assert.deepEqual(r.coordinator_cleanup, { status: 'closed', coordinator_handle: 'term-coord' });
  assert.equal(closes(m).length, 1);
  const close = closes(m)[0];
  assert.equal(close.binary, 'configured-orca');
  assert.deepEqual(close.args, ['terminal', 'close', '--terminal', 'term-coord', '--tab', '--json']);
  for (const forbidden of ['--worktree', '--all']) assert.ok(!close.args.includes(forbidden), forbidden);
  const ackAt = indexOfCall(m, (c) => c.args.includes('--peek') && c.args.includes('--ack'));
  assert.ok(ackAt >= 0 && ackAt < indexOfCall(m, (c) => c.args[0] === 'terminal'), 'close only after the final ACK');
  assert.ok(indexOfCall(m, (c) => c.args[1] === 'run-show' && c.args.includes('run-1')) < indexOfCall(m, (c) => c.args[0] === 'terminal'));
  noLifecycle(m);
});

test('cleanup: a failed (terminal) worker_done also closes the coordinator', async () => {
  const m = mock({ batches: [delivery('d1', [done({ outcome: 'failed' })])], show: shown('failed'), list: tasks('failed') });
  const r = await run(m);
  assert.equal(r.state, 'failed'); assert.equal(r.succeeded, false);
  assert.equal(r.coordinator_cleanup.status, 'closed'); assert.equal(closes(m).length, 1);
});

test('cleanup: completion recovered from already-ACKed history closes the coordinator', async () => {
  const m = mock({ history: [noise(1), done()] });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.coordinator_cleanup.status, 'closed'); assert.equal(closes(m).length, 1);
  assert.ok(!m.calls.some((c) => c.args.includes('--ack')), 'history recovery never ACKs');
});

test('cleanup: repeat wait after the coordinator is gone stays completed and treats a stale close as already_gone', async () => {
  const m = mock({ history: [done()], close: fail('terminal_handle_stale', 'Terminal handle is stale') });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.outcome, 'succeeded'); assert.equal(r.error, undefined);
  assert.equal(r.coordinator_cleanup.status, 'already_gone'); assert.equal(r.coordinator_cleanup.code, 'terminal_handle_stale');
  assert.equal(closes(m).length, 1); noLifecycle(m);
});

test('cleanup: close failures never rewrite the verdict and are not retried', async () => {
  const variants = [['orca error', { close: fail('terminal_busy', 'cannot close') }],
    ['malformed json', { close: { exitCode: 0, stdout: 'not json', stderr: '' } }],
    ['non-ok exit 0', { close: { exitCode: 0, stdout: JSON.stringify({ ok: false }), stderr: '' } }],
    ['process throws', { close: () => { throw new Error('Orca process unavailable or interrupted (timeout_or_signal)'); } }]];
  for (const [label, extra] of variants) {
    const m = mock({ batches: [delivery('d1', [done()])], ...extra });
    const r = await run(m);
    assert.equal(r.state, 'completed', label); assert.equal(r.succeeded, true, label); assert.equal(r.error, undefined, label);
    assert.equal(r.coordinator_cleanup.status, 'failed', label); assert.equal(closes(m).length, 1, label);
    assert.deepEqual(r.ack, { delivery_id: 'd1', status: 'acknowledged' }, label);
    noLifecycle(m);
  }
});

test('cleanup: SECRET provider stderr and close output never leak into the result', async () => {
  const r = await run(mock({ batches: [delivery('d1', [done()])], close: fail('terminal_busy', 'sk-abcdefghijklmnopqrstuvwxyz123456') }));
  assert.ok(!JSON.stringify(r).includes('sk-abcdefghijklmnopqrstuvwxyz123456')); assert.ok(!JSON.stringify(r).includes('SECRET_PROVIDER_STDERR'));
});

test('cleanup: only the handle bound to the Run is ever closed (binding checked via run-show first)', async () => {
  const wrong = mock({ batches: [delivery('d1', [done()])], runShow: ok({ run: { id: 'run-1', coordinator_handle: 'term-someone-else' } }) });
  const r = await run(wrong);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.status, 'skipped'); assert.equal(r.coordinator_cleanup.reason, 'run_binding_mismatch');
  assert.equal(closes(wrong).length, 0);
  for (const extra of [{ runShow: ok({ run: { id: 'other-run', coordinator_handle: 'term-coord' } }) }, { runShow: fail('run_not_found', 'x') }, { noRunShow: true }]) {
    const m = mock({ batches: [delivery('d1', [done()])], ...extra });
    const res = await run(m);
    assert.equal(res.state, 'completed'); assert.equal(res.coordinator_cleanup.status, 'skipped'); assert.equal(closes(m).length, 0);
  }
});

test('cleanup: never closes the worker terminal even if it equals the coordinator handle', async () => {
  const m = mock({ batches: [delivery('d1', [done({}, { from_handle: 'term-coord' })])], show: { ...shown(), worker: { state: 'ready', agentTerminalHandle: 'term-coord' } } });
  const r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.reason, 'handle_is_worker_terminal'); assert.equal(closes(m).length, 0);
});

test('cleanup: disabled or unspecified option sends no close and adds no field', async () => {
  for (const o of [{ ...opts, closeCoordinator: false }, { maxWaitMs: 5000, pollMs: 1000, workspace }]) {
    const m = mock({ batches: [delivery('d1', [done()])] });
    const r = await run(m, o);
    assert.equal(r.state, 'completed'); assert.ok(!('coordinator_cleanup' in r)); assert.equal(closes(m).length, 0);
    assert.ok(!m.calls.some((c) => c.args[1] === 'run-show'));
  }
});

test('no-close: running, blocked and unknown states', async () => {
  // running
  let m = mock({ show: shown('in_progress'), list: tasks('dispatched') });
  let r = await run(m);
  assert.equal(r.state, 'running'); assert.ok(!('coordinator_cleanup' in r)); assert.equal(closes(m).length, 0);
  // blocked (attributable question)
  m = mock({ batches: [delivery('pending', [attributable])], show: shown('in_progress'), list: tasks('dispatched') });
  r = await run(m);
  assert.equal(r.state, 'blocked'); assert.ok(!('coordinator_cleanup' in r)); assert.equal(closes(m).length, 0);
  // unknown: settled Task without a worker_done
  m = mock({ show: shown('succeeded'), list: tasks('completed') });
  r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(closes(m).length, 0); assert.ok(!m.calls.some((c) => c.args[1] === 'run-show'));
  // unknown: malformed history
  m = mock({ historyFail: ok({ runId: 'run-1', messages: { a: 1 } }) });
  r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(closes(m).length, 0);
  // unknown: wrong-run history, malformed consuming rows
  m = mock({ historyFail: ok({ runId: 'other', messages: [] }) });
  assert.equal((await run(m)).state, 'unknown'); assert.equal(closes(m).length, 0);
  m = mock({ batches: [ok({ runId: 'run-1', deliveryId: 'dbad', messages: [noise(1), {}], count: 2 })] });
  assert.equal((await run(m)).state, 'unknown'); assert.equal(closes(m).length, 0);
});

test('no-close: ACK failures keep the verdict but leave the coordinator alone', async () => {
  // final ACK fails
  let m = mock({ batches: [delivery('d1', [done()])], ackFail: true });
  let r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.ack.status, 'failed');
  assert.deepEqual(r.coordinator_cleanup, { status: 'skipped', coordinator_handle: 'term-coord', reason: 'ack_not_confirmed' }); assert.equal(closes(m).length, 0);
  // consumer_fenced on the final ACK
  m = mock({ batches: [delivery('d1', [done()])], ackFail: 'consumer_fenced' });
  r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.reason, 'consumer_fenced'); assert.equal(closes(m).length, 0);
  // invalid ACK receipt (wrong delivery id echoed)
  m = mock({ batches: [delivery('d1', [done()])] });
  const base = m.process;
  const wrongReceipt = async (b, args, cwd, t) => (args.includes('--peek') ? ok({ runId: 'run-1', messages: [], acknowledged: 'someone-else' }) : base(b, args, cwd, t));
  r = await waitForOrca(config, id, opts, wrongReceipt);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.status, 'skipped');
  assert.equal(m.calls.filter((c) => c.args[0] === 'terminal').length, 0);
  // an earlier intermediate ACK failure survives a later successful final ACK: still no close
  m = mock({ batches: [delivery('old', [noise(1)]), ok({ ...delivery('done', [done()]), acknowledged: 'wrong' })] });
  r = await run(m);
  assert.equal(r.state, 'completed'); assert.deepEqual(r.ack, { delivery_id: 'done', status: 'acknowledged' });
  assert.equal(r.coordinator_cleanup.reason, 'ack_failure'); assert.equal(closes(m).length, 0);
});

test('no-close: consumer_fenced before any verdict, and fenced history', async () => {
  let m = mock({ batches: [fail('consumer_fenced', 'fenced')] });
  let r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(r.error.code, 'consumer_fenced'); assert.equal(m.calls.length, 1);
  m = mock({ historyFail: fail('consumer_fenced', 'fenced'), show: shown('in_progress'), list: tasks('dispatched') });
  r = await run(m);
  assert.equal(r.state, 'unknown'); assert.equal(closes(m).length, 0);
});

test('no-close: malformed or conflicting evidence on an otherwise valid verdict', async () => {
  // Task status contradicts the outcome
  let m = mock({ batches: [delivery('d1', [done()])], list: tasks('failed') });
  let r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.cross_check.status, 'mismatch');
  assert.equal(r.coordinator_cleanup.reason, 'evidence_conflict'); assert.equal(closes(m).length, 0);
  // worker_done sender is not the Dispatch assignee
  m = mock({ batches: [delivery('d1', [done({}, { from_handle: 'term-impostor' })])] });
  r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.reason, 'evidence_conflict'); assert.equal(closes(m).length, 0);
  // conflicting duplicate worker_done outcomes
  m = mock({ batches: [delivery('d1', [done(), done({ outcome: 'failed' }, { id: 'msg-2' })])] });
  r = await run(m);
  assert.equal(r.coordinator_cleanup.reason, 'evidence_conflict'); assert.equal(closes(m).length, 0);
  // a worker_done for the awaited Task/Dispatch without an explicit outcome is not completion at all
  m = mock({ batches: [delivery('d1', [done({ outcome: undefined })])], show: shown('in_progress'), list: tasks('dispatched') });
  r = await run(m);
  assert.notEqual(r.state, 'completed'); assert.equal(closes(m).length, 0);
});

test('no-close: unavailable or incomplete identity cross-check fails closed but keeps the verdict', async () => {
  const sources = [['exact ACK', (from) => ({ batches: [delivery('d1', [done({}, { from_handle: from })])] })], ['history recovery', (from) => ({ history: [done({}, { from_handle: from })] })]];
  const identityCases = [
    ['worker-show fails', { show: fail('dispatch_not_found', 'no such dispatch') }, 'cross_check_unavailable', 'unavailable'],
    ['worker-show malformed JSON', { show: { exitCode: 0, stdout: 'not json', stderr: '' } }, 'cross_check_unavailable', 'unavailable'],
    ['worker-show names a different Dispatch', { show: { ...shown(), dispatch: { id: 'ctx-other', taskId: 'task-1', runId: 'run-1' } } }, 'cross_check_unavailable', 'unavailable'],
    ['task-list fails', { list: fail('run_not_found', 'no such run') }, 'cross_check_unavailable', 'unavailable'],
    ['task-list names a different Run', { list: { tasks: [{ id: 'task-1', run_id: 'run-other', status: 'completed' }] } }, 'cross_check_unavailable', 'unavailable'],
    ['task-list lacks the Task', { list: { tasks: [] } }, 'cross_check_unavailable', 'unavailable'],
    ['assignee missing', { show: { ...shown(), worker: { state: 'ready', startOptions: { launch: {} } } } }, 'assignee_unverified', 'consistent'],
    ['assignee not a string', { show: { ...shown(), worker: { state: 'ready', agentTerminalHandle: 42 } } }, 'assignee_unverified', 'consistent'],
    ['assignee malformed (sender matches it)', { show: { ...shown(), worker: { state: 'ready', agentTerminalHandle: '--worktree' } }, from: '--worktree' }, 'assignee_unverified', 'consistent'],
  ];
  for (const [source, base] of sources) {
    for (const [label, { from = 'term-worker', ...extra }, reason, cross] of identityCases) {
      const m = mock({ ...base(from), ...extra });
      const r = await run(m);
      const tag = `${source}: ${label}`;
      assert.equal(r.state, 'completed', tag); assert.equal(r.succeeded, true, tag); assert.equal(r.awaited_terminal, true, tag);
      assert.equal(r.error, undefined, tag); assert.equal(r.cross_check.status, cross, tag);
      assert.deepEqual(r.coordinator_cleanup, { status: 'skipped', coordinator_handle: 'term-coord', reason }, tag);
      assert.equal(closes(m).length, 0, tag);
      assert.ok(!m.calls.some((c) => c.args[1] === 'run-show'), `${tag}: no Run binding call once identity is unproven`);
      noLifecycle(m);
    }
  }
  // a failed verdict is just as authoritative when cleanup is skipped
  const m = mock({ batches: [delivery('d1', [done({ outcome: 'failed' })])], show: fail('dispatch_not_found', 'x') });
  const r = await run(m);
  assert.equal(r.state, 'failed'); assert.equal(r.outcome, 'failed'); assert.equal(r.coordinator_cleanup.reason, 'cross_check_unavailable'); assert.equal(closes(m).length, 0);
});

test('no-close: pending attributable question in the same delivery, or an undrained mailbox during history recovery', async () => {
  let m = mock({ batches: [delivery('d1', [attributable, done()])] });
  let r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.reason, 'pending_question_or_escalation'); assert.equal(closes(m).length, 0);
  // an attributable question that ends the loop early (a later delivery may still be unACKed) while history holds the worker_done
  m = mock({ batches: [delivery('d1', [attributable])], history: [done()] });
  r = await run(m);
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.coordinator_cleanup.reason, 'pending_question_or_escalation'); assert.equal(closes(m).length, 0);
  // the deadline ends the loop right after a delivery: the mailbox was not observed empty, so history recovery cannot prove ACK
  let t = 0;
  m = mock({ batches: [delivery('d1', [noise(1)]), delivery('d2', [done()])], history: [done()] });
  r = await waitForOrca(config, id, { ...opts, maxWaitMs: 1000 }, m.process, () => (t += 600));
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.coordinator_cleanup.reason, 'mailbox_not_drained'); assert.equal(closes(m).length, 0);
});

// ---------------------------------------------------------------------------------------------
// closeCoordinatorTerminal helper
// ---------------------------------------------------------------------------------------------
test('closeCoordinatorTerminal: refuses malformed handles/Run ids and option-looking values without calling Orca', async () => {
  let called = 0;
  const p = async () => { called++; return ok({}); };
  for (const [runId, coordinatorHandle] of [['run-1', '--all'], ['run-1', ''], ['run-1', 'a b'], ['-x', 'term-1'], ['run-1', 'term-1; rm -rf /']]) {
    const r = await closeCoordinatorTerminal(config, { runId, coordinatorHandle }, p);
    assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'invalid_identity');
  }
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------------------------
// Backlog cleanup
// ---------------------------------------------------------------------------------------------
const NOW = Date.parse('2026-10-09T06:00:00Z');
const OLD = '2026-10-08T01:00:00Z';
const settledRun = (n, over = {}) => {
  const run = `run_${n}`, handle = `term_c${n}`, task = `task_${n}`, dispatch = `ctx_${n}`, worker = `term_w${n}`;
  return {
    run: { id: run, coordinator_handle: handle, consumer_generation: 1, legacy: 0, created_at: OLD, updated_at: OLD, ...over.run },
    tasks: over.tasks ?? [{ id: task, run_id: run, status: 'completed' }],
    workers: over.workers ?? [{ dispatchId: dispatch, taskId: task, runId: run, workerState: 'succeeded', dispatchStatus: 'completed',
      agentTerminalHandle: worker, terminalState: 'released', projection: { outcome: 'succeeded' } }],
    history: over.history ?? [{ id: `m_${n}`, run_id: run, type: 'worker_done', from_handle: worker, read: 1,
      payload: JSON.stringify({ taskId: task, dispatchId: dispatch, outcome: 'succeeded' }) }],
    historyFail: over.historyFail,
    terminal: over.terminal === undefined ? { handle, title: 'zsh', orphaned: false, connected: true, lastOutputAt: Date.parse(OLD) } : over.terminal,
  };
};

function orcaWorld(entries, { truncated = false, pageSize = 100, failOn, closeResult, runPage, workerPage, terminalExtra } = {}) {
  const calls = [];
  const process = async (binary, args, cwd, timeout) => {
    calls.push({ binary, args, cwd, timeout });
    const [group, cmd] = args;
    if (failOn?.(args)) return fail('orca_error', 'boom');
    const arg = (flag) => args[args.indexOf(flag) + 1];
    if (cmd === 'run-list') {
      const start = args.includes('--cursor') ? Number(arg('--cursor')) : 0;
      const rows = entries.map((e) => e.run).slice(start, start + pageSize);
      const page = { runs: rows, nextCursor: start + pageSize < entries.length ? String(start + pageSize) : null };
      return ok(runPage ? runPage(page, start) : page);
    }
    if (cmd === 'worker-list') {
      const all = entries.flatMap((e) => e.workers);
      const start = args.includes('--cursor') ? Number(arg('--cursor')) : 0;
      const page = { workers: all.slice(start, start + pageSize), page: { hasMore: start + pageSize < all.length, nextCursor: String(start + pageSize), total: all.length } };
      return ok(workerPage ? workerPage(page, start) : page);
    }
    if (group === 'terminal' && cmd === 'list') {
      const listed = entries.map((e) => e.terminal).filter(Boolean);
      return ok({ terminals: listed, totalCount: listed.length, truncated, ...terminalExtra });
    }
    if (cmd === 'task-list') { const e = entries.find((x) => x.run.id === arg('--run')); return ok({ runId: arg('--run'), tasks: e?.tasks ?? [] }); }
    if (cmd === 'check') {
      const e = entries.find((x) => x.run.coordinator_handle === arg('--terminal'));
      if (!args.includes('--all') || args.includes('--ack') || args.includes('--wait')) throw new Error(`backlog must only read history: ${args.join(' ')}`);
      return e?.historyFail ?? ok({ runId: e?.run.id, messages: e?.history ?? [], count: (e?.history ?? []).length });
    }
    if (cmd === 'run-show') { const e = entries.find((x) => x.run.id === arg('--id')); return e ? ok({ run: e.run }) : fail('run_not_found', 'x'); }
    if (group === 'terminal' && cmd === 'close') return closeResult?.(args) ?? ok({ closed: true });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { calls, process };
}
const base = { apply: false, minAgeMs: 60 * 60_000, maxClose: 50, maxRuns: 1000, titles: DEFAULT_COORDINATOR_TITLES, now: () => NOW };
const backlog = (world, over = {}) => runBacklogCleanup(config, { ...base, ...over }, world.process);
const READ_ONLY = new Set(['run-list', 'worker-list', 'list', 'task-list', 'check']);
const excludedReasons = (report, handle) => report.excluded.find((e) => e.coordinator_handle === handle)?.reasons;

test('backlog: dry-run lists a proven-safe settled coordinator and performs read-only calls only', async () => {
  const world = orcaWorld([settledRun(1), settledRun(2, { run: { }, tasks: [{ id: 'task_2', run_id: 'run_2', status: 'failed' }],
    workers: [{ dispatchId: 'ctx_2', taskId: 'task_2', runId: 'run_2', dispatchStatus: 'failed', agentTerminalHandle: 'term_w2', terminalState: 'reclaimable', projection: { outcome: 'failed' } }],
    history: [{ id: 'm2', run_id: 'run_2', type: 'worker_done', from_handle: 'term_w2', read: 1, payload: JSON.stringify({ taskId: 'task_2', dispatchId: 'ctx_2', outcome: 'failed' }) }] })]);
  const report = await backlog(world);
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.candidates.map((c) => c.coordinator_handle).sort(), ['term_c1', 'term_c2']);
  assert.equal(report.excluded.length, 0); assert.equal(report.results, undefined);
  for (const c of world.calls) assert.ok(READ_ONLY.has(c.args[1]), c.args.join(' '));
  assert.ok(!world.calls.some((c) => c.args[1] === 'close' || c.args.includes('--ack') || c.args.includes('--wait')));
});

test('backlog: apply closes only the proven candidates, each by exact handle with --tab', async () => {
  const world = orcaWorld([settledRun(1), settledRun(2, { tasks: [{ id: 'task_2', run_id: 'run_2', status: 'dispatched' }] })]);
  const report = await backlog(world, { apply: true });
  assert.equal(report.mode, 'apply');
  assert.deepEqual(report.results.map((r) => [r.coordinator_handle, r.status]), [['term_c1', 'closed']]);
  const closeCalls = world.calls.filter((c) => c.args[0] === 'terminal' && c.args[1] === 'close');
  assert.deepEqual(closeCalls.map((c) => c.args), [['terminal', 'close', '--terminal', 'term_c1', '--tab', '--json']]);
  assert.ok(!world.calls.some((c) => c.args.includes('--all') && c.args.includes('close')));
  assert.ok(!world.calls.some((c) => c.args.includes('--worktree')));
});

test('backlog: stale handles on apply are already_gone and apply reports other failures without retry', async () => {
  const entries = [settledRun(1), settledRun(2)];
  const world = orcaWorld(entries, { closeResult: (args) => (args.includes('term_c1') ? fail('terminal_handle_stale', 'gone') : fail('terminal_busy', 'no')) });
  const report = await backlog(world, { apply: true });
  assert.deepEqual(report.results.map((r) => r.status), ['already_gone', 'failed']);
  assert.equal(world.calls.filter((c) => c.args[1] === 'close').length, 2);
});

test('backlog: excludes active, running, blocked and unknown Runs', async () => {
  const world = orcaWorld([
    settledRun(1, { tasks: [{ id: 'task_1', run_id: 'run_1', status: 'in_progress' }] }),
    settledRun(2, { tasks: [{ id: 'task_2', run_id: 'run_2', status: 'blocked' }] }),
    settledRun(3, { workers: [{ dispatchId: 'ctx_3', taskId: 'task_3', runId: 'run_3', dispatchStatus: 'dispatched', agentTerminalHandle: 'term_w3', terminalState: 'active', projection: { outcome: 'in_progress' } }] }),
    settledRun(4, { tasks: [] }),
    settledRun(5, { workers: [] }),
    settledRun(6, { tasks: [{ id: 'task_6', run_id: 'run_6', status: 'completed' }, { id: 'task_6b', run_id: 'run_6', status: 'completed' }] }),
    settledRun(7, { run: { legacy: 1 } }),
    settledRun(8, { workers: [{ dispatchId: 'ctx_8', taskId: 'task_8', runId: 'run_8', dispatchStatus: 'completed', agentTerminalHandle: 'term_w8', terminalState: 'released', projection: { outcome: 'weird' } }] }),
    settledRun(9, { workers: [{ dispatchId: 'ctx_9', taskId: 'task_9', runId: 'run_9', dispatchStatus: 'completed', agentTerminalHandle: 'term_w9', terminalState: 'release_pending', projection: { outcome: 'succeeded' } }] }),
  ]);
  const report = await backlog(world, { apply: true });
  assert.deepEqual(report.candidates, []); assert.deepEqual(report.results, []);
  assert.equal(excludedReasons(report, 'term_c1')[0], 'task_not_settled:in_progress');
  assert.equal(excludedReasons(report, 'term_c2')[0], 'task_not_settled:blocked');
  assert.ok(excludedReasons(report, 'term_c3').some((r) => r.startsWith('dispatch_not_settled')));
  assert.deepEqual(excludedReasons(report, 'term_c4'), ['no_tasks']);
  assert.ok(excludedReasons(report, 'term_c5').includes('no_dispatch_evidence'));
  assert.ok(excludedReasons(report, 'term_c6').includes('task_without_dispatch'));
  assert.deepEqual(excludedReasons(report, 'term_c7'), ['legacy_run']);
  assert.ok(excludedReasons(report, 'term_c8').includes('dispatch_outcome_unproven'));
  assert.ok(excludedReasons(report, 'term_c9').includes('worker_release_unsettled'));
  assert.ok(!world.calls.some((c) => c.args[1] === 'close'));
});

test('backlog: excludes worker terminals, the caller terminal, non-shell and untitled terminals, and recent activity', async () => {
  const world = orcaWorld([
    settledRun(1, { terminal: { handle: 'term_c1', title: 'zsh', connected: true, lastOutputAt: Date.parse(OLD) } }),
    settledRun(2, { run: { coordinator_handle: 'term_w1' }, terminal: { handle: 'term_w1', title: 'zsh', connected: true, lastOutputAt: Date.parse(OLD) } }), // coordinator that is also a worker handle of run_1
    settledRun(3),
    settledRun(4, { terminal: { handle: 'term_c4', title: '✳ Claude Code session', connected: true, lastOutputAt: Date.parse(OLD) } }),
    settledRun(5, { terminal: { handle: 'term_c5', title: null, connected: true, lastOutputAt: Date.parse(OLD) } }),
    settledRun(6, { terminal: { handle: 'term_c6', title: 'zsh', connected: true, lastOutputAt: NOW - 60_000 } }),
    settledRun(7, { run: { updated_at: '2026-10-09T05:59:00Z' } }),
  ]);
  const report = await backlog(world, { callerHandle: 'term_c3', apply: true });
  assert.deepEqual(report.candidates.map((c) => c.coordinator_handle), ['term_c1']);
  assert.ok(excludedReasons(report, 'term_w1').includes('worker_terminal'));
  assert.ok(excludedReasons(report, 'term_c3').includes('caller_terminal'));
  assert.ok(excludedReasons(report, 'term_c4')[0].startsWith('title_not_coordinator_shell'));
  assert.ok(excludedReasons(report, 'term_c5')[0].startsWith('title_not_coordinator_shell'));
  assert.ok(excludedReasons(report, 'term_c6').includes('recent_terminal_output'));
  assert.ok(excludedReasons(report, 'term_c7').includes('recent_run'));
  assert.deepEqual(report.results.map((r) => r.coordinator_handle), ['term_c1']);
  // per-Run history is only read for handles that passed the cheap gates
  assert.deepEqual(world.calls.filter((c) => c.args[1] === 'check').map((c) => c.args[c.args.indexOf('--terminal') + 1]), ['term_c1']);
});

test('backlog: excludes unresolved question/escalation and unsafe or missing worker_done evidence', async () => {
  const wd = (n, over = {}, row = {}) => ({ id: `m${n}`, run_id: `run_${n}`, type: 'worker_done', from_handle: `term_w${n}`, read: 1,
    payload: JSON.stringify({ taskId: `task_${n}`, dispatchId: `ctx_${n}`, outcome: 'succeeded', ...over }), ...row });
  const world = orcaWorld([
    settledRun(1, { history: [wd(1), { id: 'q', run_id: 'run_1', type: 'question', payload: '{}' }] }),
    settledRun(2, { history: [wd(2), { id: 'e', run_id: 'run_2', type: 'escalation', payload: '{}' }] }),
    settledRun(3, { history: [] }),
    settledRun(4, { history: [wd(4, { dispatchId: 'ctx_other' })] }),
    settledRun(5, { history: [wd(5, { outcome: 'failed' })] }),
    settledRun(6, { history: [wd(6, {}, { read: 0 })] }),
    settledRun(7, { history: [wd(7, {}, { from_handle: 'term_impostor' })] }),
    settledRun(8, { historyFail: fail('consumer_fenced', 'fenced') }),
    settledRun(9, { historyFail: ok({ runId: 'run_9', messages: [{}] }) }),
    settledRun(10, { historyFail: ok({ runId: 'other-run', messages: [] }) }),
    settledRun(11, { historyFail: ok({ runId: 'run_11', messages: 'nope' }) }),
    settledRun(12, { history: [{ id: 'm12', run_id: 'run_12', type: 'worker_done', from_handle: 'term_w12', read: 1, payload: 'not-json' }] }),
  ]);
  const report = await backlog(world, { apply: true });
  assert.deepEqual(report.candidates, []);
  assert.deepEqual(excludedReasons(report, 'term_c1'), ['question_or_escalation_present']);
  assert.deepEqual(excludedReasons(report, 'term_c2'), ['question_or_escalation_present']);
  assert.deepEqual(excludedReasons(report, 'term_c3'), ['worker_done_missing']);
  assert.deepEqual(excludedReasons(report, 'term_c4'), ['worker_done_missing']);
  assert.deepEqual(excludedReasons(report, 'term_c5'), ['worker_done_outcome_mismatch']);
  assert.deepEqual(excludedReasons(report, 'term_c6'), ['worker_done_unread']);
  assert.deepEqual(excludedReasons(report, 'term_c7'), ['worker_done_sender_mismatch']);
  assert.deepEqual(excludedReasons(report, 'term_c8'), ['history_unavailable:consumer_fenced']);
  assert.deepEqual(excludedReasons(report, 'term_c9'), ['history_malformed']);
  assert.deepEqual(excludedReasons(report, 'term_c10'), ['history_run_mismatch']);
  assert.deepEqual(excludedReasons(report, 'term_c11'), ['history_malformed']);
  assert.deepEqual(excludedReasons(report, 'term_c12'), ['worker_done_missing']);
  assert.ok(!world.calls.some((c) => c.args[1] === 'close'));
});

test('backlog: a handle coordinating several Runs needs every Run proven settled', async () => {
  const a = settledRun(1);
  const b = settledRun(2, { run: { coordinator_handle: 'term_c1' }, tasks: [{ id: 'task_2', run_id: 'run_2', status: 'dispatched' }] });
  const report = await backlog(orcaWorld([a, b]), {});
  assert.deepEqual(report.candidates, []); assert.deepEqual(report.excluded[0].run_ids, ['run_1', 'run_2']);
  assert.ok(excludedReasons(report, 'term_c1').includes('task_not_settled:dispatched'));
});

test('backlog: missing/orphaned terminals are reported as already gone, never closed', async () => {
  const world = orcaWorld([settledRun(1, { terminal: null }), settledRun(2, { terminal: { handle: 'term_c2', title: 'zsh', orphaned: true, connected: false } })]);
  const report = await backlog(world, { apply: true });
  assert.deepEqual(report.already_gone.sort(), ['term_c1', 'term_c2']); assert.deepEqual(report.candidates, []);
  assert.ok(!world.calls.some((c) => c.args[1] === 'close'));
});

test('backlog: truncated terminal inventory refuses apply and never calls a handle gone', async () => {
  const world = orcaWorld([settledRun(1), settledRun(2, { terminal: null })], { truncated: true });
  const report = await backlog(world, { apply: true });
  assert.ok(report.warnings.some((w) => /truncated/.test(w)) && report.warnings.some((w) => /apply refused/.test(w)));
  assert.equal(report.inventory_complete, false);
  assert.deepEqual(report.already_gone, []); assert.deepEqual(report.results, []);
  assert.ok(!world.calls.some((c) => c.args[1] === 'close'));
});

test('backlog: inventory failures abort the scan before any close', async () => {
  for (const cmd of ['run-list', 'worker-list', 'list']) {
    const world = orcaWorld([settledRun(1)], { failOn: (args) => args[1] === cmd });
    await assert.rejects(backlog(world, { apply: true }), /Orca .* failed/);
    assert.ok(!world.calls.some((c) => c.args[1] === 'close'), cmd);
  }
});

test('backlog: pagination covers every Run/worker page, and --max-close and --max-runs bound the work', async () => {
  const entries = [1, 2, 3, 4, 5].map((n) => settledRun(n));
  let report = await backlog(orcaWorld(entries, { pageSize: 2 }), {});
  assert.equal(report.scanned_runs, 5); assert.equal(report.candidates.length, 5);
  const world = orcaWorld(entries, { pageSize: 2 });
  report = await backlog(world, { apply: true, maxClose: 2 });
  assert.equal(report.results.length, 2); assert.ok(report.warnings.some((w) => /max-close/.test(w)));
  assert.equal(world.calls.filter((c) => c.args[1] === 'close').length, 2);
  report = await backlog(orcaWorld(entries, { pageSize: 2 }), { maxRuns: 3 });
  assert.equal(report.scanned_runs, 3); assert.ok(report.warnings.some((w) => /max-runs/.test(w)));
  assert.equal(report.inventory_complete, false); assert.deepEqual(report.inventory_gaps, ['runs:row_cap_reached']);
  // --max-close is a batch cap, not an inventory failure.
  report = await backlog(orcaWorld(entries, { pageSize: 2 }), { apply: true, maxClose: 2 });
  assert.equal(report.inventory_complete, true); assert.deepEqual(report.inventory_gaps, []);
});

const closeCount = (world) => world.calls.filter((c) => c.args[0] === 'terminal' && c.args[1] === 'close').length;

test('backlog: --apply refuses to close anything when --max-runs cuts off remaining Runs', async () => {
  const entries = [1, 2, 3, 4, 5].map((n) => settledRun(n));
  for (const pageSize of [2, 100]) {
    const world = orcaWorld(entries, { pageSize });
    const report = await backlog(world, { apply: true, maxRuns: 3 });
    assert.equal(report.scanned_runs, 3); assert.equal(report.inventory_complete, false);
    assert.deepEqual(report.inventory_gaps, ['runs:row_cap_reached']);
    assert.deepEqual(report.results, []);
    assert.ok(report.warnings.some((w) => /apply refused/.test(w)));
    assert.equal(closeCount(world), 0, `pageSize ${pageSize}`);
    assert.equal(report.candidates.length, 3, 'candidates are still reported for operator review');
  }
  // Dry-run stays useful: same report, flagged incomplete, no results.
  const dry = await backlog(orcaWorld(entries), { maxRuns: 3 });
  assert.equal(dry.mode, 'dry-run'); assert.equal(dry.inventory_complete, false); assert.equal(dry.candidates.length, 3); assert.equal(dry.results, undefined);
  // A cap exactly equal to the Run count proves the end and is complete.
  const exact = orcaWorld(entries, { pageSize: 5 });
  const full = await backlog(exact, { apply: true, maxRuns: 5 });
  assert.equal(full.inventory_complete, true); assert.equal(closeCount(exact), 5);
  const exactPaged = orcaWorld(entries, { pageSize: 2 });
  assert.equal((await backlog(exactPaged, { apply: true, maxRuns: 6 })).inventory_complete, true);
  assert.equal(closeCount(exactPaged), 5);
});

test('backlog: --apply refuses when Run or worker pagination cannot prove completeness', async () => {
  const entries = [1, 2, 3].map((n) => settledRun(n));
  const cases = [
    ['runs:malformed_cursor', { runPage: (p) => ({ ...p, nextCursor: 42 }) }],
    ['runs:malformed_cursor', { runPage: (p) => ({ ...p, nextCursor: '' }) }],
    ['runs:empty_page_with_cursor', { runPage: (p, start) => (start > 0 ? { runs: [], nextCursor: '99' } : p), pageSize: 2 }],
    ['runs:cursor_not_advancing', { runPage: (p) => ({ ...p, nextCursor: '0' }), pageSize: 2 }],
    ['runs:page_limit_reached', { runPage: (p, start) => ({ runs: [{ ...p.runs[0], id: `x${start}`, coordinator_handle: null }], nextCursor: String(start + 1) }) }, { maxRuns: 100000 }],
    ['workers:has_more_without_cursor', { workerPage: (p) => ({ ...p, page: { hasMore: true } }) }],
    ['workers:page_end_unproven', { workerPage: (p) => ({ workers: p.workers }) }],
    ['workers:page_end_unproven', { workerPage: (p) => ({ ...p, page: { nextCursor: 'x' } }) }],
    ['workers:empty_page_with_cursor', { workerPage: (p, start) => (start > 0 ? { workers: [], page: { hasMore: true, nextCursor: '77' } } : p), pageSize: 2 }],
    ['workers:cursor_not_advancing', { workerPage: (p) => ({ ...p, page: { hasMore: true, nextCursor: '0' } }), pageSize: 2 }],
    ['workers:page_limit_reached', { workerPage: (p, start) => ({ workers: [{ ...p.workers[0], agentTerminalHandle: `term_x${start}` }], page: { hasMore: true, nextCursor: String(start + 1) } }) }],
  ];
  for (const [gapCode, extra, over = {}] of cases) {
    const world = orcaWorld(entries, extra);
    const report = await backlog(world, { apply: true, ...over });
    assert.equal(report.inventory_complete, false, gapCode); assert.ok(report.inventory_gaps.includes(gapCode), `${gapCode}: ${report.inventory_gaps}`);
    assert.deepEqual(report.results, [], gapCode); assert.ok(report.warnings.some((w) => /apply refused/.test(w)), gapCode);
    assert.equal(closeCount(world), 0, gapCode);
    const dry = await backlog(orcaWorld(entries, extra), over);
    assert.equal(dry.inventory_complete, false, gapCode); assert.equal(dry.results, undefined, gapCode);
  }
});

test('backlog: --apply refuses when terminal inventory cannot be proven complete', async () => {
  const entries = [1, 2].map((n) => settledRun(n));
  const cases = [['terminals:truncated', { truncated: true }],
    ['terminals:truncation_unproven', { terminalExtra: { truncated: undefined } }],
    ['terminals:truncation_unproven', { terminalExtra: { truncated: 'no' } }],
    ['terminals:total_exceeds_listed', { terminalExtra: { totalCount: 9 } }]];
  for (const [gapCode, extra] of cases) {
    const world = orcaWorld(entries, extra);
    const report = await backlog(world, { apply: true });
    assert.deepEqual(report.inventory_gaps, [gapCode]); assert.deepEqual(report.results, []);
    assert.equal(closeCount(world), 0, gapCode);
  }
});

test('backlog: several incomplete inventories are all reported and still close nothing', async () => {
  const entries = [1, 2, 3].map((n) => settledRun(n));
  const world = orcaWorld(entries, { truncated: true, workerPage: (p) => ({ ...p, page: { hasMore: true } }), pageSize: 2 });
  const report = await backlog(world, { apply: true, maxRuns: 2 });
  assert.deepEqual(report.inventory_gaps, ['runs:row_cap_reached', 'workers:has_more_without_cursor', 'terminals:truncated']);
  assert.equal(closeCount(world), 0);
});

test('backlog: Runs without a usable coordinator handle are ignored, option-looking handles never reach close', async () => {
  const bad = settledRun(1, { run: { coordinator_handle: '--all' } });
  const world = orcaWorld([bad, settledRun(2, { run: { coordinator_handle: null } })]);
  const report = await backlog(world, { apply: true });
  assert.deepEqual(report.candidates, []); assert.ok(report.warnings.some((w) => /2 Run\(s\)/.test(w)));
  assert.ok(!world.calls.some((c) => c.args[1] === 'close'));
});

// ---------------------------------------------------------------------------------------------
// Script entry point (no live Orca: a fake binary)
// ---------------------------------------------------------------------------------------------
const execFileAsync = promisify(execFile);
test('script: dry-run is the default and strips Orca attestation env; --apply is explicit and exact-handle', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-backlog-script-'));
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'fake-orca.mjs');
  const world = settledRun(1);
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const leaked = Object.keys(process.env).filter((k) => k.startsWith('ORCA_') || k.startsWith('TERM_PROGRAM'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a: a.slice(0, 2).join(' '), full: a, leaked }) + '\\n');
const out = (r) => process.stdout.write(JSON.stringify({ ok: true, result: r }));
const w = ${JSON.stringify(world)};
if (a[1] === 'run-list') out({ runs: [w.run], nextCursor: null });
else if (a[1] === 'worker-list') out({ workers: w.workers, page: { hasMore: false } });
else if (a[0] === 'terminal' && a[1] === 'list') out({ terminals: [{ ...w.terminal, lastOutputAt: 1 }], truncated: process.env.FAKE_TRUNCATED === '1' });
else if (a[1] === 'task-list') out({ tasks: w.tasks });
else if (a[1] === 'check') out({ runId: w.run.id, messages: w.history });
else if (a[1] === 'run-show') out({ run: w.run });
else if (a[0] === 'terminal' && a[1] === 'close') out({ closed: true });
else { process.stdout.write('{"ok":false,"error":{"code":"unexpected"}}'); process.exit(1); }
`);
  await fs.chmod(fake, 0o755);
  const script = path.resolve('scripts/orca-coordinator-cleanup.mjs');
  const env = { ...process.env, ORCA_TERMINAL_HANDLE: 'term_caller', ORCA_PANE_KEY: 'p', TERM_PROGRAM: 'Orca' };
  try {
    const dry = await execFileAsync(process.execPath, [script, '--orca-binary', fake, '--json', '--min-age-minutes', '5'], { env });
    const report = JSON.parse(dry.stdout);
    assert.equal(report.mode, 'dry-run'); assert.deepEqual(report.candidates.map((c) => c.coordinator_handle), ['term_c1']);
    let calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.length > 0 && calls.every((c) => c.leaked.length === 0), 'attestation env must be stripped');
    assert.ok(!calls.some((c) => c.a === 'terminal close'));
    const human = await execFileAsync(process.execPath, [script, '--orca-binary', fake, '--min-age-minutes', '5'], { env });
    assert.match(human.stdout, /Dry-run only: nothing was closed/); assert.match(human.stdout, /CANDIDATE term_c1/);
    await fs.rm(log);
    const applied = await execFileAsync(process.execPath, [script, '--orca-binary', fake, '--json', '--apply', '--min-age-minutes', '5'], { env });
    assert.deepEqual(JSON.parse(applied.stdout).results.map((r) => r.status), ['closed']);
    calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.filter((c) => c.a === 'terminal close').map((c) => c.full), [['terminal', 'close', '--terminal', 'term_c1', '--tab', '--json']]);
    // Incomplete inventory: dry-run reports it (exit 0), --apply exits 3 and closes nothing.
    await fs.rm(log);
    const incompleteEnv = { ...env, FAKE_TRUNCATED: '1' };
    const incompleteDry = await execFileAsync(process.execPath, [script, '--orca-binary', fake, '--min-age-minutes', '5'], { env: incompleteEnv });
    assert.match(incompleteDry.stdout, /INVENTORY INCOMPLETE \(terminals:truncated\)/);
    await assert.rejects(execFileAsync(process.execPath, [script, '--orca-binary', fake, '--json', '--apply', '--min-age-minutes', '5'], { env: incompleteEnv }), (error) => {
      const refused = JSON.parse(error.stdout);
      return error.code === 3 && refused.inventory_complete === false && refused.results.length === 0;
    });
    calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(!calls.some((c) => c.a === 'terminal close'), 'refused apply must not close');
    await assert.rejects(execFileAsync(process.execPath, [script, '--orca-binary', fake, '--bogus'], { env }), (error) => error.code === 1 && /Unknown argument/.test(error.stderr));
    await assert.rejects(execFileAsync(process.execPath, [script, '--orca-binary', fake, '--max-close', '0'], { env }), (error) => error.code === 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// MCP: production default closes the coordinator; the env switch disables it
// ---------------------------------------------------------------------------------------------
async function mcpWait(extraEnv) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-wait-cleanup-'));
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'fake-orca.mjs');
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');
const out = (r) => process.stdout.write(JSON.stringify({ ok: true, result: r }));
if (a[1] === 'check') out(a.includes('--peek') ? { runId: 'run-1', messages: [], acknowledged: a[a.indexOf('--ack') + 1] } : { runId: 'run-1', deliveryId: 'd1', messages: [{ id: 'm1', run_id: 'run-1', type: 'worker_done', from_handle: 'w', body: 'ok', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded' }) }] });
else if (a[1] === 'worker-show') out({ dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1' }, worker: { agentTerminalHandle: 'w' }, projection: { outcome: 'succeeded' } });
else if (a[1] === 'task-list') out({ tasks: [{ id: 'task-1', run_id: 'run-1', status: 'completed' }] });
else if (a[1] === 'run-show') out({ run: { id: 'run-1', coordinator_handle: 'term-coord' } });
else if (a[0] === 'terminal' && a[1] === 'close') out({ closed: true });
else { process.stdout.write('{"ok":false,"error":{"code":"unexpected"}}'); process.exit(1); }
`);
  await fs.chmod(fake, 0o755);
  const client = new Client({ name: 'orca-cleanup-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/stdio.js'), '--root', dir],
    env: { ...process.env, CODEXPRO_EXECUTION_BACKEND: 'orca', CODEXPRO_ORCA_BINARY: fake, CODEXPRO_BASH_MODE: 'off', ...extraEnv }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'wait_for_handoff', arguments: { orca_run_id: 'run-1', orca_task_id: 'task-1', orca_dispatch_id: 'ctx-1', orca_coordinator_handle: 'term-coord', max_wait_seconds: 1 } });
    return { result, calls: (await fs.readFile(log, 'utf8')).trim().split('\n') };
  } finally { await client.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
}

test('MCP wait_for_handoff: coordinator cleanup is on by default and CODEXPRO_ORCA_CLOSE_COORDINATOR=0 turns it off', async () => {
  const on = await mcpWait({});
  assert.equal(on.result.structuredContent.state, 'completed');
  assert.deepEqual(on.result.structuredContent.coordinator_cleanup, { status: 'closed', coordinator_handle: 'term-coord' });
  assert.deepEqual(on.calls.filter((c) => c.startsWith('terminal ')), ['terminal close --terminal term-coord --tab --json']);
  const off = await mcpWait({ CODEXPRO_ORCA_CLOSE_COORDINATOR: '0' });
  assert.equal(off.result.structuredContent.state, 'completed'); assert.equal(off.result.structuredContent.coordinator_cleanup, undefined);
  assert.ok(!off.calls.some((c) => c.startsWith('terminal ')));
});
