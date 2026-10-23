import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { waitForOrca } from '../dist/executionBackend.js';

// Independent RF redacted-local-id (PASS 186/186 on a3e3b333) left one P3 behind: `drained` was a flag captured on the FIRST consuming check, so a
// worker_done that lands afterwards and is recovered from history (first pass, or the blocked-confirmation pass) can still be UNREAD when the
// coordinator terminal is closed. The proof must come from the history snapshot that surfaced the message: its own `read` flag is monotonic and
// travels in the same response, so there is no window between "observed" and "closed". Adjacent P3s: a first-read identity_mismatch reported
// `running`, and a transiently unavailable history read was not disclosed.

const workspace = await fs.realpath(os.tmpdir());
const config = { orcaExecutable: 'configured-orca', orcaTimeoutMs: 1000 };
const id = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', coordinatorHandle: 'term-coord' };
const opts = { maxWaitMs: 5000, pollMs: 1000, workspace, confirmDelayMs: 0, closeCoordinator: true };
const ok = (result) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' });
const fail = (code, message) => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }), stderr: '' });
const done = (over = {}, msg = {}) => ({ id: 'msg-done', run_id: 'run-1', type: 'worker_done', from_handle: 'term-worker', subject: 'Done', body: 'Implemented it.',
  created_at: '2026-10-08T00:00:00Z', read: 1, payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'ctx-1', outcome: 'succeeded', ...over }), ...msg });
const unread = (msg = {}) => done({}, { read: 0, ...msg });
const noRead = () => { const m = done(); delete m.read; return m; };

const settledShow = () => ({
  dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'completed' },
  worker: { state: 'ready', agentTerminalHandle: 'term-worker', startOptions: {} },
  projection: { dispatchId: 'ctx-1', outcome: 'succeeded', stage: { detail: 'done' }, liveness: { verdict: 'live' }, attention: { requiresAction: false } },
  observation: { agentWait: null } });
const blockedShow = () => ({
  dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'pending' },
  worker: { state: 'start_unknown', agentTerminalHandle: 'term-worker', startOptions: {} },
  projection: { dispatchId: 'ctx-1', outcome: 'in_progress', stage: { detail: 'turn_start_unobserved' }, liveness: { verdict: 'unverifiable' }, attention: { requiresAction: false } },
  observation: { agentWait: null } });
const row = (status) => ({ tasks: [{ id: 'task-1', run_id: 'run-1', status }] });
const delivery = (deliveryId, messages) => ({ runId: 'run-1', deliveryId, messages, count: messages.length, acknowledged: null });

// `lists` / `shows` / `histories` are consumed in order; the last entry repeats. An entry may be a raw CliOutput ({stdout}) or an Error to throw.
function mock({ batches = [], lists = [row('completed')], shows = [settledShow()], histories = [[]] } = {}) {
  const calls = []; const counts = { list: 0, show: 0, history: 0, batch: 0 };
  const pick = (arr, key) => arr[Math.min(counts[key]++, arr.length - 1)];
  const reply = (v, wrap) => { if (v instanceof Error) throw v; return v.stdout ? v : ok(wrap(v)); };
  const process = async (binary, args) => {
    calls.push(args);
    const [group, cmd] = args;
    if (group === 'terminal' && cmd === 'close') return ok({ closed: true });
    if (cmd === 'run-show') return ok({ run: { id: 'run-1', coordinator_handle: 'term-coord', consumer_generation: 1 } });
    if (cmd === 'check') {
      if (args.includes('--all')) return reply(pick(histories, 'history'), (h) => ({ runId: 'run-1', messages: h, count: h.length }));
      if (args.includes('--peek')) return ok({ runId: 'run-1', messages: [], count: 0, acknowledged: args[args.indexOf('--ack') + 1] });
      const b = batches[counts.batch++] ?? { runId: 'run-1', deliveryId: null, messages: [], count: 0, timedOut: true };
      return b.stdout ? b : ok(b);
    }
    if (cmd === 'worker-show') return reply(pick(shows, 'show'), (s) => s);
    if (cmd === 'task-list') return reply(pick(lists, 'list'), (l) => l);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { calls, process };
}
const wait = (m, o = opts) => waitForOrca(config, id, o, m.process, undefined, async () => {});
const closes = (m) => m.calls.filter((a) => a[0] === 'terminal');
const acks = (m) => m.calls.filter((a) => a.includes('--ack') && !a.includes('--peek'));

// ---- P3 stale drained flag ----

test('P3 TOCTOU timeline: the mailbox drains empty, the worker_done lands unread before the confirmation read, and the coordinator is NOT closed', async () => {
  // consuming check: empty (drained); history #1: empty; Task blocked -> confirmation; history #2: the worker_done arrives, still read=0.
  const settled = settledShow();
  const m = mock({ lists: [row('blocked'), row('completed')], shows: [blockedShow(), settled], histories: [[], [unread()]] });
  const r = await wait(m);
  assert.equal(r.state, 'completed'); assert.equal(r.succeeded, true); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.coordinator_cleanup.status, 'skipped'); assert.equal(r.coordinator_cleanup.reason, 'worker_done_unread');
  assert.equal(closes(m).length, 0);
  assert.equal(m.calls.filter((a) => a[1] === 'run-show').length, 0, 'no close attempt, so not even the Run binding lookup');
  assert.equal(acks(m).length, 0, 'history recovery never ACKs');
});

test('P3 the same race on the first history pass is closed too (message lands between the drained check and the history read)', async () => {
  const m = mock({ histories: [[unread()]] });
  const r = await wait(m);
  assert.equal(r.state, 'completed'); assert.equal(r.worker_done.recovered_from_history, true);
  assert.equal(r.coordinator_cleanup.status, 'skipped'); assert.equal(r.coordinator_cleanup.reason, 'worker_done_unread');
  assert.equal(closes(m).length, 0);
});

test('P3 a recovered worker_done whose read flag is true/1 in the same snapshot still closes (no regression of the P1/P2 happy path)', async () => {
  for (const read of [1, true]) {
    const m = mock({ histories: [[done({}, { read })]] });
    const r = await wait(m);
    assert.equal(r.state, 'completed', String(read)); assert.equal(r.coordinator_cleanup.status, 'closed', String(read)); assert.equal(closes(m).length, 1, String(read));
  }
  // Blocked -> confirmed-by-late-worker_done path with a read row also closes.
  const m = mock({ lists: [row('blocked'), row('completed')], shows: [blockedShow(), settledShow()], histories: [[], [done()]] });
  const r = await wait(m);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.status, 'closed');
});

test('P3 an unprovable read state fails closed: missing / null / non-boolean `read` never authorizes a close', async () => {
  const absent = noRead();
  const odd = [absent, done({}, { read: null }), done({}, { read: '1' }), done({}, { read: 2 })];
  for (const message of odd) {
    const m = mock({ histories: [[message]] });
    const r = await wait(m);
    assert.equal(r.state, 'completed', JSON.stringify(message.read)); // the verdict itself is unchanged
    assert.equal(r.coordinator_cleanup.status, 'skipped', JSON.stringify(message.read));
    assert.equal(r.coordinator_cleanup.reason, 'worker_done_read_unproven', JSON.stringify(message.read));
    assert.equal(closes(m).length, 0);
  }
});

test('P3 every history worker_done for the awaited Dispatch must be read: a read original beside an unread duplicate is not enough', async () => {
  const m = mock({ histories: [[done(), unread({ id: 'msg-dup' })]] });
  const r = await wait(m);
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup.reason, 'worker_done_unread'); assert.equal(closes(m).length, 0);
  // An unread worker_done for a DIFFERENT Dispatch is not attributable evidence and does not block this Dispatch's cleanup.
  const foreign = unread({ id: 'msg-x' }); foreign.payload = JSON.stringify({ taskId: 'task-x', dispatchId: 'ctx-x', outcome: 'succeeded' });
  const m2 = mock({ histories: [[done(), foreign]] });
  const r2 = await wait(m2);
  assert.equal(r2.coordinator_cleanup.status, 'closed');
});

test('P3 the skip is retryable and ACK semantics are untouched: the next wait consumes the same worker_done, ACKs the exact delivery, then closes', async () => {
  const first = mock({ histories: [[unread()]] });
  const a = await wait(first);
  assert.equal(a.coordinator_cleanup.reason, 'worker_done_unread'); assert.equal(acks(first).length, 0);
  // Repeat wait: the unread worker_done is now delivered by the consuming check.
  const second = mock({ batches: [delivery('d1', [done({}, { read: 0 })])] });
  const b = await wait(second);
  assert.equal(b.state, 'completed'); assert.equal(b.worker_done.delivery_id, 'd1'); assert.equal(b.worker_done.recovered_from_history, undefined);
  assert.deepEqual(b.ack, { delivery_id: 'd1', status: 'acknowledged' });
  assert.equal(b.coordinator_cleanup.status, 'closed');
  const peekAcks = second.calls.filter((c) => c.includes('--ack') && c.includes('--peek'));
  assert.equal(peekAcks.length, 1); assert.equal(peekAcks[0][peekAcks[0].indexOf('--ack') + 1], 'd1');
  // Third wait after the close: recovered from now-read history, idempotent, already ACKed.
  const third = mock({ histories: [[done()]] });
  const c = await wait(third);
  assert.equal(c.state, 'completed'); assert.equal(c.worker_done.recovered_from_history, true); assert.equal(acks(third).length, 0);
});

test('P3 closeCoordinator off never reads or closes, and the verdict is identical with or without the unread skip', async () => {
  const off = mock({ histories: [[unread()]] });
  const r = await wait(off, { ...opts, closeCoordinator: false });
  assert.equal(r.state, 'completed'); assert.equal(r.coordinator_cleanup, undefined); assert.equal(closes(off).length, 0);
  const on = await wait(mock({ histories: [[unread()]] }));
  for (const key of ['state', 'succeeded', 'outcome', 'awaited_terminal', 'awaited_completed']) assert.equal(on[key], r[key], key);
});

// ---- P3 first-read identity_mismatch is unknown, not running ----

test('P3 identity_mismatch on the first read is explicit unknown, never running (foreign Dispatch / Run / Task)', async () => {
  const foreign = (dispatch) => { const s = blockedShow(); Object.assign(s.dispatch, dispatch); return s; };
  for (const dispatch of [{ runId: 'run-OTHER' }, { taskId: 'task-OTHER' }, { id: 'ctx-OTHER' }]) {
    const r = await wait(mock({ lists: [row('dispatched')], shows: [foreign(dispatch)] }));
    assert.equal(r.state, 'unknown', JSON.stringify(dispatch)); assert.equal(r.succeeded, false); assert.equal(r.awaited_terminal, false);
    assert.equal(r.cross_check.status, 'unavailable'); assert.match(r.cross_check.error, /different Run\/Task\/Dispatch/);
    assert.match(r.evidence_conflict.join(' '), /identity/i);
  }
  // Task row of another Run.
  const t = await wait(mock({ lists: [{ tasks: [{ id: 'task-1', run_id: 'run-OTHER', status: 'dispatched' }] }], shows: [blockedShow()] }));
  assert.equal(t.state, 'unknown'); assert.match(t.evidence_conflict.join(' '), /identity/i);
});

test('P3 an ordinary cross-check outage (not an identity contradiction) is unchanged: still running with cross_check unavailable', async () => {
  const r = await wait(mock({ lists: [row('dispatched')], shows: [fail('orca_error', 'boom')] }));
  assert.equal(r.state, 'running'); assert.equal(r.cross_check.status, 'unavailable'); assert.equal(r.evidence_conflict, undefined);
});

test('P3 a foreign-identity cross-check does not downgrade a proven worker_done verdict, but cleanup is skipped', async () => {
  const bad = blockedShow(); bad.dispatch.runId = 'run-OTHER';
  const m = mock({ batches: [delivery('d1', [done({}, { read: 0 })])], shows: [bad] });
  const r = await wait(m);
  assert.equal(r.state, 'completed'); assert.equal(r.cross_check.status, 'unavailable');
  assert.equal(r.coordinator_cleanup.status, 'skipped'); assert.equal(closes(m).length, 0);
});

// ---- P3 transient history unavailability is disclosed ----

test('P3 a transiently unavailable history read is disclosed (history_check=unavailable) instead of silently reading as an empty mailbox', async () => {
  const cases = [fail('orca_error', 'boom'), new Error('Orca process unavailable or interrupted (timeout_or_signal)')];
  for (const failing of cases) {
    const r = await wait(mock({ lists: [row('dispatched')], shows: [{ ...blockedShow(), dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'dispatched' } }], histories: [failing] }));
    assert.equal(r.state, 'running'); assert.equal(r.succeeded, false);
    assert.equal(r.history_check, 'unavailable'); assert.ok(r.history_unavailable.code); assert.equal(typeof r.history_unavailable.message, 'string');
    assert.equal(r.error, undefined, 'schema-error channel is reserved for explicit unknown evidence');
  }
});

test('P3 history disclosure is about the LAST history read: a later clean read clears it; a schema error remains explicit unknown', async () => {
  const cleared = await wait(mock({ lists: [row('blocked'), row('blocked')], shows: [blockedShow()], histories: [fail('orca_error', 'boom'), []] }));
  assert.equal(cleared.state, 'blocked'); assert.equal(cleared.history_check, undefined); assert.equal(cleared.history_unavailable, undefined);
  const stillBad = await wait(mock({ lists: [row('blocked'), row('blocked')], shows: [blockedShow()], histories: [[], fail('orca_error', 'boom')] }));
  assert.equal(stillBad.state, 'blocked'); assert.equal(stillBad.history_check, 'unavailable');
  const schema = await wait(mock({ lists: [row('dispatched')], shows: [blockedShow()], histories: [ok({ runId: 'run-OTHER', messages: [], count: 0 })] }));
  assert.equal(schema.state, 'unknown'); assert.equal(schema.history_check, 'failed'); assert.equal(schema.history_unavailable, undefined);
});

test('P3 a healthy history is not annotated and costs no extra reads', async () => {
  const m = mock({ lists: [row('dispatched')], shows: [{ ...blockedShow(), dispatch: { id: 'ctx-1', taskId: 'task-1', runId: 'run-1', status: 'dispatched' } }] });
  const r = await wait(m);
  assert.equal(r.state, 'running'); assert.equal(r.history_check, undefined); assert.equal(r.history_unavailable, undefined);
  assert.equal(m.calls.filter((a) => a[1] === 'check' && a.includes('--all')).length, 1);
});

test('the new paths issue only read-only Orca verbs besides the single exact-handle close', async () => {
  const m = mock({ histories: [[done()]] });
  await wait(m);
  const allowed = new Set(['orchestration check', 'orchestration worker-show', 'orchestration task-list', 'orchestration run-show', 'terminal close']);
  assert.ok(m.calls.every((a) => allowed.has(a.slice(0, 2).join(' '))));
  assert.equal(closes(m).length, 1); assert.deepEqual(closes(m)[0], ['terminal', 'close', '--terminal', 'term-coord', '--tab', '--json']);
});
