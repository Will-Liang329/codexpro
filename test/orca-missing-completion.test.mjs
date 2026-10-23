import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForOrca } from '../dist/executionBackend.js';

const config = { orcaExecutable: 'fixture-orca', orcaTimeoutMs: 100 };
const id = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', coordinatorHandle: 'term-coord' };
const opts = { maxWaitMs: 0, pollMs: 1000, closeCoordinator: true, confirmDelayMs: 0 };
const ok = result => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ ok: true, result }) });
const error = code => ({ exitCode: 1, stderr: '', stdout: JSON.stringify({ ok: false, error: { code, message: code } }) });
const live = () => ({ dispatch: { id: id.dispatchId, runId: id.runId, taskId: id.taskId, status: 'dispatched' },
  worker: { dispatchId: id.dispatchId, state: 'ready', stage: 'input_accepted', agentTerminalHandle: 'term-worker' },
  projection: { dispatchId: id.dispatchId, runId: id.runId, taskId: id.taskId, outcome: 'in_progress',
    stage: { detail: 'input_accepted' }, liveness: { verdict: 'live' }, attention: { requiresAction: false } } });
// Whitelisted lifecycle shape from real operator-close cases redacted-local-id / redacted-local-id.
const exited = () => ({ ...live(), dispatch: { ...live().dispatch, status: 'failed', terminationReason: 'operator_close' },
  worker: { ...live().worker, state: 'failed', stage: 'process_exited' },
  projection: { ...live().projection, outcome: 'failed', stage: { detail: 'process_exited' },
    liveness: { verdict: 'exited', source: 'execution_host' }, attention: { requiresAction: true } } });
const done = (outcome = 'succeeded', extra = {}, msgId = 'msg-done') => ({ id: msgId, run_id: id.runId, type: 'worker_done',
  from_handle: 'term-worker', body: 'Worker report', payload: JSON.stringify({ taskId: id.taskId, dispatchId: id.dispatchId, outcome, ...extra }) });
const rejected = (outcome = 'succeeded', marker = { code: 'dispatch_inactive' }) => done(outcome,
  { _orcaLifecycleRejection: marker, filesModified: ['must-not-surface'], summary: 'must-not-surface' }, 'msg-rejected');

function mock({ shown = exited(), status = 'blocked', history = [], batches = [], historyError, ackError } = {}) {
  const calls = []; let index = 0; let closed = false;
  const process = async (_binary, args) => {
    calls.push(args);
    if (args[1] === 'worker-show') return ok(shown);
    if (args[1] === 'task-list') return ok({ tasks: [{ id: id.taskId, run_id: id.runId, status }] });
    if (args[1] === 'run-show') return ok({ run: { id: id.runId, coordinator_handle: id.coordinatorHandle } });
    if (args[0] === 'terminal' && args[1] === 'close') {
      if (closed) return error('terminal_handle_stale');
      closed = true; return ok({});
    }
    if (args[1] === 'check') {
      if (args.includes('--all')) return historyError ? error(historyError) : ok({ runId: id.runId, messages: history });
      const ack = args.includes('--ack') ? args[args.indexOf('--ack') + 1] : undefined;
      if (ack && ackError) return error(ackError);
      if (args.includes('--peek')) return ok({ runId: id.runId, acknowledged: ack, messages: [] });
      const messages = batches[index++] ?? [];
      return ok({ runId: id.runId, acknowledged: ack, deliveryId: messages.length ? 'delivery-1' : null, messages, timedOut: !messages.length });
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { calls, process };
}
const wait = m => waitForOrca(config, id, opts, m.process, () => 0, async () => {});
const noAuthority = r => {
  assert.equal(r.state, 'unknown'); assert.equal(r.succeeded, false);
  assert.equal(r.awaited_terminal, false); assert.equal(r.awaited_completed, false);
  for (const field of ['worker_done', 'outcome', 'filesModified', 'reportPath', 'summary', 'coordinator_cleanup', 'git_artifact']) assert.equal(r[field], undefined, field);
};
const noClose = m => assert.equal(m.calls.filter(a => a[0] === 'terminal').length, 0);

for (const status of ['blocked', 'ready', 'failed', 'dispatched', 'completed']) {
  test(`observed failed/process_exited with Task ${status} and no worker_done is explicitly UNVERIFIED`, async () => {
    const m = mock({ status }); const r = await wait(m); noAuthority(r); noClose(m);
    assert.equal(r.error.code, 'missing_worker_done'); assert.match(r.error.message, /UNVERIFIED/);
    assert.equal(r.completion_verification, 'unverified'); assert.equal(r.missing_completion, true);
    assert.equal(r.worker.state, 'failed'); assert.equal(r.worker.stage, 'process_exited');
  });
}

test('a live/start_unknown Task blocked and a normal wait timeout remain non-terminal', async () => {
  const shown = live(); shown.worker.state = 'start_unknown'; shown.worker.stage = 'turn_start_unobserved';
  for (const status of ['blocked', 'dispatched']) {
    const m = mock({ shown, status }); const r = await wait(m);
    assert.equal(r.state, status === 'blocked' ? 'blocked' : 'running');
    assert.equal(r.missing_completion, undefined); assert.equal(r.error, undefined); noClose(m);
  }
});

for (const status of ['failed', 'completed']) {
  test(`settled Task ${status} alone never substitutes for missing worker_done`, async () => {
    const m = mock({ shown: live(), status }); const r = await wait(m); noAuthority(r);
    assert.equal(r.error, undefined); assert.equal(r.missing_completion, undefined);
    assert.equal(r.completion_verification, undefined);
    assert.match(r.evidence_conflict.join(' '), /no matching worker_done/); noClose(m);
  });
}

test('history outage discloses unobserved completion while preserving observed failure', async () => {
  const m = mock({ historyError: 'timeout' }); const r = await wait(m); noAuthority(r);
  assert.equal(r.error.code, 'missing_worker_done'); assert.equal(r.history_check, 'unavailable'); noClose(m);
});

for (const outcome of ['succeeded', 'failed']) {
  for (const source of ['delivery', 'history']) {
    test(`synthetic lifecycle-rejected ${outcome} from ${source} never grants authority`, async () => {
      const m = mock({ shown: live(), status: 'dispatched', ...(source === 'delivery' ? { batches: [[rejected(outcome)]] } : { history: [rejected(outcome)] }) });
      const r = await wait(m); noAuthority(r); noClose(m);
      assert.equal(r.error.code, 'worker_done_rejected');
      assert.deepEqual(r.rejected_worker_done, [{ message_id: 'msg-rejected' }]);
      if (source === 'delivery') assert.equal(r.ack.status, 'acknowledged');
    });
  }
}

test('presence of even a malformed/null/false rejection marker fails closed', async () => {
  for (const marker of [null, false, 'dispatch_inactive', {}]) {
    const m = mock({ history: [rejected('succeeded', marker)] }); const r = await wait(m);
    noAuthority(r); assert.equal(r.error.code, 'worker_done_rejected'); noClose(m);
  }
});

test('a legitimate worker rejection report with explicit failed outcome remains authoritative', async () => {
  const m = mock({ status: 'failed', batches: [[done('failed', { reason: 'rejected', code: 'request_rejected' })]] });
  const r = await wait(m);
  assert.equal(r.state, 'failed'); assert.equal(r.awaited_terminal, true); assert.equal(r.outcome, 'failed');
  assert.equal(r.worker_done.message_id, 'msg-done'); assert.equal(r.ack.status, 'acknowledged');
  assert.equal(r.error, undefined); assert.equal(r.coordinator_cleanup.status, 'closed');
});

test('rejected rows cannot hide a later legitimate worker_done or block its exact ACK', async () => {
  for (const source of ['same-delivery', 'next-delivery', 'history']) {
    const shown = live(); shown.projection.outcome = 'succeeded'; shown.dispatch.status = 'completed';
    const m = mock({ shown, status: 'completed', ...(source === 'history' ? { history: [rejected('failed'), done()] }
      : { batches: source === 'same-delivery' ? [[rejected('failed'), done()]] : [[rejected('failed')], [done()]] }) });
    const r = await waitForOrca(config, id, { ...opts, maxWaitMs: 1000 }, m.process, () => 0, async () => {});
    assert.equal(r.state, 'completed'); assert.equal(r.worker_done.message_id, 'msg-done');
    assert.equal(r.error, undefined); assert.equal(r.evidence_conflict, undefined);
    if (source !== 'history') assert.equal(r.ack.status, 'acknowledged');
  }
});

test('valid worker_done remains authoritative over failed process evidence and ACK fencing', async () => {
  for (const outcome of ['succeeded', 'failed']) {
    const m = mock({ status: 'failed', batches: [[done(outcome)]], ackError: 'consumer_fenced' });
    const r = await wait(m);
    assert.equal(r.awaited_terminal, true); assert.equal(r.outcome, outcome);
    assert.equal(r.state, outcome === 'succeeded' ? 'completed' : 'failed');
    assert.equal(r.missing_completion, undefined); assert.equal(r.error, undefined);
    assert.equal(r.ack.status, 'failed'); noClose(m);
  }
});

test('public history without read recovers verdict but cannot close; later exact ACK is idempotent', async () => {
  const message = done('failed'); assert.equal('read' in message, false);
  const first = mock({ status: 'failed', history: [message] });
  let r = await wait(first);
  assert.equal(r.state, 'failed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.coordinator_cleanup.reason, 'worker_done_read_unproven'); noClose(first);
  // Retry of the same public delivery/ACK receipt remains authoritative; a second exact close is already_gone.
  const next = mock({ status: 'failed', batches: [[message], [message]] });
  r = await wait(next); assert.equal(r.coordinator_cleanup.status, 'closed');
  r = await wait(next); assert.equal(r.state, 'failed'); assert.equal(r.ack.delivery_id, 'delivery-1');
  assert.equal(r.coordinator_cleanup.status, 'already_gone');
  assert.equal(next.calls.filter(a => a.includes('--ack')).length, 2);
});

test('wrong projection/worker identity never produces a supported missing-completion classification', async () => {
  for (const [section, key] of [['projection', 'runId'], ['projection', 'taskId'], ['worker', 'dispatchId']]) {
    const shown = exited(); shown[section][key] = 'foreign';
    const m = mock({ shown, status: 'dispatched' }); const r = await wait(m); noAuthority(r); noClose(m);
    assert.equal(r.missing_completion, undefined); assert.match(r.evidence_conflict.join(' '), /identity/);
  }
});


test('live worker with agent_prompt_stalled dispatch failure remains pending without missing completion', async () => {
  for (const status of ['dispatched', 'blocked']) {
    const shown = live();
    shown.dispatch.status = 'failed';
    shown.dispatch.lastFailure = 'agent_prompt_stalled';
    shown.worker.state = 'failed';
    shown.projection.attention.requiresAction = true;
    const m = mock({ shown, status }); const r = await wait(m);
    assert.equal(r.state, 'blocked');
    assert.equal(r.worker.liveness, 'live');
    assert.equal(r.worker.dispatch_status, 'failed');
    assert.equal(r.missing_completion, undefined);
    assert.equal(r.completion_verification, undefined);
    assert.equal(r.error, undefined);
    assert.equal(r.awaited_terminal, false); assert.equal(r.succeeded, false); noClose(m);
  }
});


test('failed statuses without positive exit evidence never imply missing completion', async () => {
  for (const verdict of [undefined, 'unverifiable', 'live']) {
    const shown = live();
    shown.dispatch.status = 'failed'; shown.dispatch.lastFailure = 'agent_prompt_stalled';
    shown.worker.state = 'failed'; shown.projection.liveness = verdict ? { verdict } : {};
    const m = mock({ shown, status: 'dispatched' }); const r = await wait(m);
    assert.equal(r.state, 'running'); assert.equal(r.error, undefined);
    assert.equal(r.missing_completion, undefined); assert.equal(r.awaited_terminal, false); noClose(m);
  }
});

test('positive exit evidence without failed statuses still reports unverified missing completion', async () => {
  for (const evidence of ['stage', 'liveness']) {
    const shown = live();
    if (evidence === 'stage') {
      shown.projection.stage.detail = 'process_exited'; shown.projection.liveness = {};
    } else shown.projection.liveness.verdict = 'exited';
    const m = mock({ shown, status: 'dispatched' }); const r = await wait(m);
    noAuthority(r); noClose(m); assert.equal(r.error.code, 'missing_worker_done');
    assert.equal(r.missing_completion, true); assert.equal(r.completion_verification, 'unverified');
  }
});

test('explicit live liveness prevents a stale process_exited stage from claiming missing completion', async () => {
  const shown = exited(); shown.projection.liveness.verdict = 'live';
  const m = mock({ shown, status: 'dispatched' }); const r = await wait(m);
  assert.equal(r.state, 'blocked'); assert.equal(r.error, undefined);
  assert.equal(r.missing_completion, undefined); assert.equal(r.awaited_terminal, false); noClose(m);
});

test('a genuine late worker_done remains authoritative after a live failed dispatch poll', async () => {
  for (const outcome of ['succeeded', 'failed']) {
    const shown = live(); shown.dispatch.status = 'failed'; shown.dispatch.lastFailure = 'agent_prompt_stalled';
    const pending = mock({ shown, status: 'blocked' }); const first = await wait(pending);
    assert.equal(first.state, 'blocked'); assert.equal(first.missing_completion, undefined); noClose(pending);
    shown.dispatch.status = outcome === 'succeeded' ? 'completed' : 'failed';
    shown.projection.outcome = outcome;
    const late = mock({ shown, status: shown.dispatch.status, batches: [[done(outcome)]] });
    const r = await wait(late);
    assert.equal(r.state, outcome === 'succeeded' ? 'completed' : 'failed');
    assert.equal(r.awaited_terminal, true); assert.equal(r.outcome, outcome);
    assert.equal(r.worker_done.message_id, 'msg-done'); assert.equal(r.error, undefined);
    assert.equal(r.ack.status, 'acknowledged'); assert.equal(r.ack.delivery_id, 'delivery-1');
    assert.equal(r.coordinator_cleanup.status, 'closed');
  }
});

test('a late accepted report arriving during rejection ACK wins through history without premature cleanup', async () => {
  const shown = live(); shown.dispatch.status = 'failed'; shown.dispatch.lastFailure = 'agent_prompt_stalled';
  const history = [rejected()];
  const m = mock({ shown, status: 'blocked', history, batches: [[rejected()]] });
  const process = async (binary, args) => {
    const response = await m.process(binary, args);
    if (args.includes('--ack')) history.push(done());
    return response;
  };
  const r = await waitForOrca(config, id, opts, process, () => 0, async () => {});
  assert.equal(r.state, 'completed'); assert.equal(r.outcome, 'succeeded');
  assert.equal(r.worker_done.message_id, 'msg-done'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.error, undefined); assert.equal(r.missing_completion, undefined);
  assert.deepEqual(r.rejected_worker_done, [{ message_id: 'msg-rejected' }]);
  assert.equal(r.ack.status, 'acknowledged'); assert.equal(r.ack.delivery_id, 'delivery-1');
  assert.equal(m.calls.filter(a => a.includes('--ack')).length, 1); noClose(m);
});
