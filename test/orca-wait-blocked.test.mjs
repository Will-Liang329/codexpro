import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { waitForOrca } from '../dist/executionBackend.js';

// wait_for_handoff state consistency: an Orca Task that Orca itself reports as `blocked` (shown as "Failed" in the IDE) must never be
// reported as `running`. Recorded case: run_54185783d13f / task_696e056b6f69 / ctx_12418ba706ea, where the coordinator terminal had been
// killed and the Dispatch sat at pending / start_unknown / turn_start_unobserved / in_progress.

const workspace = await fs.realpath(os.tmpdir());
const config = { orcaExecutable: 'configured-orca', orcaTimeoutMs: 1000 };
const id = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', coordinatorHandle: 'term-coord' };
const opts = { maxWaitMs: 5000, pollMs: 1000, workspace, confirmDelayMs: 0 };
const ok = (result) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });
const fail = (code, message) => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }), stderr: '' });
const done = (over = {}) => ({ id: 'msg-done', run_id: 'run-1', type: 'worker_done', from_handle: 'term-worker', subject: 'Done', body: 'Implemented it.',
  created_at: '2026-10-08T00:00:00Z', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded', ...over }) });

// The exact never-started shape from the recorded case.
const unstarted = (over = {}) => ({
  dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'pending', ...over.dispatch },
  worker: { state: 'start_unknown', agentTerminalHandle: 'term-worker', startOptions: {} },
  projection: { dispatchId: 'ctx-1', outcome: 'in_progress', stage: { detail: 'turn_start_unobserved' }, liveness: { verdict: 'unverifiable' }, attention: { requiresAction: false } },
  observation: { agentWait: null }, ...over.rest });
const live = () => ({
  dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'dispatched' },
  worker: { state: 'ready', agentTerminalHandle: 'term-worker', startOptions: {} },
  projection: { dispatchId: 'ctx-1', outcome: 'in_progress', stage: { detail: 'input_accepted' }, liveness: { verdict: 'live' }, attention: { requiresAction: false } },
  observation: { agentWait: null } });
const row = (status, over = {}) => ({ tasks: [{ id: 'other', status: 'failed', run_id: 'run-1' }, { id: 'task-1', run_id: 'run-1', status, spec: 'x', ...over }] });

// `lists` / `shows` / `histories` are consumed in order; the last entry repeats.
function mock({ lists = [row('dispatched')], shows = [live()], histories = [[]], check, extra } = {}) {
  const calls = []; const counts = { list: 0, show: 0, history: 0 };
  const pick = (arr, key) => arr[Math.min(counts[key]++, arr.length - 1)];
  const process = async (binary, args) => {
    calls.push(args);
    const cmd = args[1];
    if (cmd === 'check') {
      if (args.includes('--all')) { const h = pick(histories, 'history'); return h.stdout ? h : ok({ runId: 'run-1', messages: h, count: h.length }); }
      if (args.includes('--peek')) return ok({ runId: 'run-1', messages: [], count: 0, acknowledged: args[args.indexOf('--ack') + 1] });
      return check ? check(args) : ok({ runId: 'run-1', deliveryId: null, messages: [], count: 0, timedOut: true });
    }
    if (cmd === 'worker-show') { const s = pick(shows, 'show'); return s.stdout ? s : ok(s); }
    if (cmd === 'task-list') { const l = pick(lists, 'list'); return l.stdout ? l : ok(l); }
    if (extra) return extra(args);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { calls, process };
}
const verbs = (m) => m.calls.map((a) => a.slice(0, 2).join(' '));
const wait = (m, o = opts, identity = id) => waitForOrca(config, identity, o, m.process, undefined, async () => {});

test('recorded case: Task blocked + never-started Dispatch converges to blocked, never running or completed', async () => {
  const m = mock({ lists: [row('blocked')], shows: [unstarted()] });
  const r = await wait(m);
  assert.equal(r.state, 'blocked');
  assert.equal(r.blocked_reason, 'task_blocked');
  assert.equal(r.awaited_terminal, false); assert.equal(r.awaited_completed, false); assert.equal(r.succeeded, false);
  assert.equal(r.outcome, undefined);
  assert.equal(r.cross_check.task_status, 'blocked');
  assert.equal(r.cross_check.status, 'blocked');
  // The raw Dispatch evidence stays visible so the caller can see why.
  assert.deepEqual([r.worker.state, r.worker.stage, r.worker.dispatch_status, r.worker.outcome], ['start_unknown', 'turn_start_unobserved', 'pending', 'in_progress']);
  assert.ok(r.next_poll_after_seconds >= 1);
});

test('Task blocked is blocked whatever the worker looks like (live worker waiting on a gate is still blocked, not running)', async () => {
  const r = await wait(mock({ lists: [row('blocked')], shows: [live()] }));
  assert.equal(r.state, 'blocked'); assert.equal(r.blocked_reason, 'task_blocked'); assert.equal(r.succeeded, false);
});

test('legitimate running is preserved and costs no extra reads', async () => {
  const m = mock({ lists: [row('dispatched')], shows: [live()] });
  const r = await wait(m);
  assert.equal(r.state, 'running'); assert.equal(r.blocked_reason, undefined); assert.equal(r.cross_check.status, 'pending');
  assert.deepEqual(verbs(m).filter((v) => v !== 'orchestration check'), ['orchestration worker-show', 'orchestration task-list']);
  // A never-started Dispatch whose Task is still `dispatched` is not claimed blocked: only the Task status is authoritative.
  const starting = await wait(mock({ lists: [row('dispatched')], shows: [unstarted()] }));
  assert.equal(starting.state, 'running');
});

test('transient one-frame blocked is re-read and does not stick', async () => {
  const m = mock({ lists: [row('blocked'), row('dispatched')], shows: [unstarted(), live()] });
  const r = await wait(m);
  assert.equal(r.state, 'running'); assert.equal(r.blocked_reason, undefined);
  assert.equal(r.cross_check.task_status, 'dispatched');
  assert.equal(r.worker.state, 'ready');
});

test('blocked is only reported when the confirmation read agrees; a flip to completed without worker_done is explicit unknown', async () => {
  const m = mock({ lists: [row('blocked'), row('completed')], shows: [unstarted(), unstarted()] });
  const r = await wait(m);
  assert.equal(r.state, 'unknown'); assert.equal(r.succeeded, false); assert.equal(r.awaited_completed, false);
  assert.match(r.evidence_conflict.join(' '), /completed but no matching worker_done/);
});

test('late worker_done in the mailbox beats a blocked reading', async () => {
  // First history pass is empty; the worker_done lands before the confirmation pass, when the Task has also settled.
  const settled = live(); settled.projection.outcome = 'succeeded'; settled.dispatch.status = 'completed';
  const m = mock({ lists: [row('blocked'), row('completed')], shows: [unstarted(), settled], histories: [[], [done()]] });
  const r = await wait(m);
  assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.evidence_conflict, undefined);
  assert.equal(r.blocked_reason, undefined);
});

test('late worker_done already in history wins immediately; a still-blocked Task is reported as a conflict, never silently dropped', async () => {
  const r = await wait(mock({ lists: [row('blocked')], shows: [unstarted()], histories: [[done()]] }));
  assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true);
  assert.match(r.evidence_conflict.join(' '), /Task status is blocked, expected completed/);
});

test('stale / foreign identity never yields a blocked verdict', async () => {
  // Task row from another Run.
  let r = await wait(mock({ lists: [row('blocked', { run_id: 'run-OTHER' })], shows: [unstarted()] }));
  assert.notEqual(r.state, 'blocked'); assert.notEqual(r.state, 'completed'); assert.equal(r.cross_check.status, 'unavailable');
  assert.match(r.cross_check.error, /different Run/);
  // Dispatch from another Run / Task.
  for (const dispatch of [{ runId: 'run-OTHER' }, { taskId: 'task-OTHER' }, { id: 'ctx-OTHER' }]) {
    r = await wait(mock({ lists: [row('blocked')], shows: [unstarted({ dispatch })] }));
    assert.notEqual(r.state, 'blocked', JSON.stringify(dispatch)); assert.equal(r.cross_check.status, 'unavailable');
  }
  // A blocked row that does not state its Run, or a Dispatch that does not state its identity, is unproven: explicit unknown, not running.
  r = await wait(mock({ lists: [{ tasks: [{ id: 'task-1', status: 'blocked' }] }], shows: [unstarted()] }));
  assert.equal(r.state, 'unknown'); assert.equal(r.succeeded, false);
  assert.match(r.evidence_conflict.join(' '), /identity could not be proven/);
  const bare = unstarted(); delete bare.dispatch.runId;
  r = await wait(mock({ lists: [row('blocked')], shows: [bare] }));
  assert.equal(r.state, 'unknown'); assert.match(r.evidence_conflict.join(' '), /identity could not be proven/);
  // The Task is looked up by id inside the awaited Run only.
  r = await wait(mock({ lists: [{ tasks: [{ id: 'task-OTHER', run_id: 'run-1', status: 'blocked' }] }], shows: [unstarted()] }));
  assert.equal(r.state, 'running');
});

test('orphaned coordinator: the mailbox check failing stays explicit unknown, and a blocked verdict never closes the coordinator terminal', async () => {
  const gone = mock({ check: () => fail('terminal_not_found', 'terminal handle is gone') });
  const g = await wait(gone);
  assert.equal(g.state, 'unknown'); assert.equal(g.error.code, 'terminal_not_found'); assert.equal(g.succeeded, false);
  const m = mock({ lists: [row('blocked')], shows: [unstarted()], extra: (args) => { throw new Error(`blocked verdict must not call ${args.join(' ')}`); } });
  const r = await wait(m, { ...opts, closeCoordinator: true });
  assert.equal(r.state, 'blocked'); assert.equal(r.coordinator_cleanup, undefined);
  assert.ok(!verbs(m).some((v) => v === 'terminal close'));
});

test('a pending question/escalation keeps its own blocked evidence alongside the Task status', async () => {
  const escalation = { id: 'msg-e', run_id: 'run-1', type: 'escalation', subject: 'Blocked: need input', body: 'b', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1' }) };
  const r = await wait(mock({ lists: [row('blocked')], shows: [live()],
    check: () => ok({ runId: 'run-1', deliveryId: 'd1', count: 1, messages: [escalation] }) }));
  assert.equal(r.state, 'blocked'); assert.equal(r.pending_messages.length, 1);
});

test('confirmation read failing leaves explicit unknown evidence, not a stuck running', async () => {
  const m = mock({ lists: [row('blocked'), fail('orca_error', 'boom')], shows: [unstarted()] });
  const r = await wait(m);
  assert.notEqual(r.state, 'running'); assert.notEqual(r.state, 'completed'); assert.equal(r.succeeded, false);
});

// ---- Successor regressions (independent RF task_0481b07ee6a8: P1 blocked is not terminal, P2 first-pass history error survives the confirm read) ----

test('P1 recorded timeline: a Task reported blocked is non-terminal; the same Dispatch later delivers its succeeded worker_done and is completed', async () => {
  // t1: Orca says blocked (pending / start_unknown / turn_start_unobserved) although the worker is alive; t2: that worker's worker_done arrives.
  const t1 = await wait(mock({ lists: [row('blocked')], shows: [unstarted()] }));
  assert.equal(t1.state, 'blocked'); assert.equal(t1.blocked_reason, 'task_blocked');
  assert.equal(t1.awaited_terminal, false); assert.equal(t1.awaited_completed, false); assert.equal(t1.succeeded, false);
  assert.equal(t1.blocked_non_terminal, true);
  // The guidance must never claim the Dispatch is dead or will not complete, and must not advise a blind retry.
  assert.match(t1.blocked_guidance, /NOT terminal/);
  assert.match(t1.blocked_guidance, /worker_done may still arrive/);
  assert.match(t1.blocked_guidance, /exited/);
  assert.doesNotMatch(t1.blocked_guidance, /will not (complete|produce)|never produces|not running/i);
  const settled = live(); settled.dispatch.status = 'completed'; settled.projection.outcome = 'succeeded';
  const t2 = await wait(mock({ lists: [row('completed')], shows: [settled], histories: [[done()]] }));
  assert.equal(t2.state, 'completed'); assert.equal(t2.succeeded, true); assert.equal(t2.awaited_terminal, true);
  assert.equal(t2.blocked_non_terminal, undefined); assert.equal(t2.blocked_guidance, undefined);
  assert.equal(t2.cross_check.status, 'consistent');
});

test('P1 a blocked Task row with a live heartbeat-bearing worker never advertises retry, and nothing but worker_done makes it terminal', async () => {
  const r = await wait(mock({ lists: [row('blocked')], shows: [live()] }));
  assert.equal(r.state, 'blocked'); assert.equal(r.blocked_non_terminal, true);
  assert.equal(r.worker.liveness, 'live'); assert.equal(r.outcome, undefined); assert.equal(r.worker_done, undefined);
  assert.doesNotMatch(r.blocked_guidance, /inspect the dispatch before retrying/i);
});

test('P2 a schema-violating first history read is never erased by the confirmation read (explicit unknown, as on the running path)', async () => {
  const bad = ok({ runId: 'run-OTHER', messages: [], count: 0 }); // history run_mismatch
  const m = mock({ lists: [row('blocked')], shows: [unstarted()], histories: [bad, []] });
  const r = await wait(m);
  assert.equal(r.state, 'unknown'); assert.equal(r.history_check, 'failed'); assert.equal(r.error.code, 'run_mismatch'); assert.equal(r.succeeded, false);
  assert.equal(r.blocked_reason, undefined);
  // No point confirming a verdict that cannot be issued: the confirmation reads are skipped.
  assert.equal(m.calls.filter((a) => a[1] === 'worker-show').length, 1);
  assert.equal(m.calls.filter((a) => a[1] === 'check' && a.includes('--all')).length, 1);
  // The running path was already unknown; both paths now agree.
  const running = await wait(mock({ lists: [row('dispatched')], shows: [unstarted()], histories: [bad, []] }));
  assert.equal(running.state, 'unknown'); assert.equal(running.history_check, 'failed');
});

test('P2 a malformed or fenced history on the confirmation read alone is also unknown, never blocked', async () => {
  for (const second of [ok({ runId: 'run-OTHER', messages: [], count: 0 }), ok({ runId: 'run-1', messages: [{ id: '', type: 'worker_done' }], count: 1 }),
    fail('consumer_fenced', 'fenced')]) {
    const r = await wait(mock({ lists: [row('blocked')], shows: [unstarted()], histories: [[], second] }));
    assert.equal(r.state, 'unknown', JSON.stringify(second)); assert.equal(r.history_check, 'failed'); assert.equal(r.blocked_reason, undefined);
  }
});

test('P2 both readings must prove the same Run/Task/Dispatch: any identity break between the first and the confirmation read is unknown', async () => {
  const cases = [
    ['task row vanished', { lists: [row('blocked'), { tasks: [{ id: 'other', status: 'failed', run_id: 'run-1' }] }], shows: [unstarted()] }],
    ['task row lost its run_id', { lists: [row('blocked'), { tasks: [{ id: 'task-1', status: 'blocked' }] }], shows: [unstarted()] }],
    ['dispatch lost its runId', { lists: [row('blocked')], shows: [unstarted(), (() => { const s = unstarted(); delete s.dispatch.runId; return s; })()] }],
    ['dispatch foreign on re-read', { lists: [row('blocked')], shows: [unstarted(), unstarted({ dispatch: { runId: 'run-OTHER' } })] }],
    ['assignee changed', { lists: [row('blocked')], shows: [unstarted(), (() => { const s = unstarted(); s.worker.agentTerminalHandle = 'term-other'; return s; })()] }],
  ];
  for (const [name, setup] of cases) {
    const r = await wait(mock(setup));
    assert.equal(r.state, 'unknown', name); assert.equal(r.succeeded, false, name); assert.equal(r.blocked_reason, undefined, name);
    assert.ok(Array.isArray(r.evidence_conflict) && r.evidence_conflict.length > 0 || r.cross_check.status === 'unavailable', name);
  }
});

test('P2 an unproven first reading is not confirmed or trusted, and costs no confirmation reads', async () => {
  const m = mock({ lists: [{ tasks: [{ id: 'task-1', status: 'blocked' }] }], shows: [unstarted()] });
  const r = await wait(m);
  assert.equal(r.state, 'unknown'); assert.match(r.evidence_conflict.join(' '), /identity could not be proven/);
  assert.equal(m.calls.filter((a) => a[1] === 'worker-show').length, 1);
});

test('P3 a history row ignored on the first pass is not counted again by the confirmation pass', async () => {
  const foreign = { ...done(), id: 'msg-foreign', payload: JSON.stringify({ taskId: 'task-x', dispatchId: 'ctx-x', outcome: 'succeeded' }) };
  const blockedPath = await wait(mock({ lists: [row('blocked')], shows: [unstarted()], histories: [[foreign]] }));
  const runningPath = await wait(mock({ lists: [row('dispatched')], shows: [live()], histories: [[foreign]] }));
  assert.equal(runningPath.ignored_messages, 1); assert.equal(blockedPath.ignored_messages, 1);
  assert.equal(blockedPath.state, 'blocked');
});

test('false terminal: a blocked reading flipping to completed/failed without worker_done is unknown, and a failed Task is never read as the worker outcome', async () => {
  for (const status of ['completed', 'failed']) {
    const r = await wait(mock({ lists: [row('blocked'), row(status)], shows: [unstarted()] }));
    assert.equal(r.state, 'unknown', status); assert.equal(r.awaited_terminal, false, status); assert.equal(r.succeeded, false, status); assert.equal(r.outcome, undefined, status);
  }
});

test('stale worker/coordinator: a worker_done from another Run, another Task or a non-assignee terminal never completes or blocks the awaited Dispatch', async () => {
  const foreignRun = { ...done(), id: 'msg-run', run_id: 'run-OTHER' };
  const r1 = await wait(mock({ lists: [row('blocked')], shows: [unstarted()], histories: [[foreignRun]] }));
  assert.equal(r1.state, 'blocked'); assert.equal(r1.worker_done, undefined); assert.equal(r1.succeeded, false);
  const otherTask = { ...done({ taskId: 'task-OTHER' }), id: 'msg-t' };
  const r2 = await wait(mock({ lists: [row('blocked')], shows: [unstarted()], histories: [[otherTask]] }));
  assert.equal(r2.state, 'unknown'); assert.match(r2.evidence_conflict.join(' '), /matches only the Dispatch/);
  // A matching worker_done from a terminal that is not the Dispatch assignee wins the verdict only with an explicit conflict (cleanup is skipped).
  const impostor = { ...done(), id: 'msg-imp', from_handle: 'term-impostor' };
  const r3 = await wait(mock({ lists: [row('blocked')], shows: [unstarted()], histories: [[impostor]] }), { ...opts, closeCoordinator: true });
  assert.equal(r3.state, 'completed'); assert.match(r3.evidence_conflict.join(' '), /sender does not match the Dispatch assignee/);
  assert.equal(r3.coordinator_cleanup.status, 'skipped'); assert.equal(r3.coordinator_cleanup.reason, 'evidence_conflict');
});

test('the blocked path never retries, stops or restarts anything: only read-only Orca verbs are issued', async () => {
  const m = mock({ lists: [row('blocked')], shows: [unstarted()] });
  await wait(m, { ...opts, closeCoordinator: true });
  const allowed = new Set(['orchestration check', 'orchestration worker-show', 'orchestration task-list']);
  assert.ok(verbs(m).every((v) => allowed.has(v)), verbs(m).join(', '));
  assert.ok(m.calls.every((a) => !a.includes('--ack') || a.includes('--peek') || a[1] === 'check'));
});
