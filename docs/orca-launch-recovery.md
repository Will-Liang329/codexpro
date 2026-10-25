# Orca launch receipt recovery

Orca distinguishes prompt acceptance from observed turn start. `worker-start` can
return IDs with `state=outcome_unknown`, `stage=turn_start_unobserved` and exit 1
although its `dispatch_input` was accepted. A later `worker_done` is still valid.
CodexPro previously treated every nonzero launch exit as a launch failure. A lost
stdout, malformed JSON or subprocess timeout produced the same unrecoverable API
boundary even when Orca had already allocated the worker.

## Request identity and storage

`handoff_to_agent` and its `handoff_to_codex` compatibility wrapper accept optional
`request_id` (1–128 characters, `[A-Za-z0-9][A-Za-z0-9_.:-]*`). Omission derives a
stable SHA-256 key from canonical workspace, complete plan, agent, model, effort
and title. Repeating identical input recovers the existing launch; an intentional
new task with identical content requires a new explicit key. Reusing an explicit
key with different input fails closed.

A private identity journal under `~/.local/state/codexpro/launch-requests` contains
only a fingerprint, request UUIDs, causal IDs, stage and bounded diagnostics. It
contains no plan, provider output or credentials. An exclusive file creation
claims each key across MCP processes; checkpoints use fsync and atomic rename.
Claim creation, checkpoint replacement and newly created directory ancestors are
synced before proceeding. Filesystems/platforms that reject directory fsync fail
closed before any new allocation; they are not supported for durable launch.
Claims are never stolen by timeout, PID or age, including after restart. Preserve
this directory: deleting identity records destroys the duplicate fence. Local
filesystem durability is required; copying the service without its journal or
using unrelated state directories is outside this guarantee.

Orca owns the actual lifecycle in its existing mutation receipt database. Run
creation and worker start receive distinct, persisted `--retry-request` UUIDs
before invocation. Orca atomically checks method/payload identity and replays or
joins matching mutations. CodexPro does not create a parallel Task database.
Repeated handoffs perform read-only inspection, never a second worker-start.

## API results

| Situation | Result |
| --- | --- |
| Normal ready receipt | Existing receipt fields and `state=ready`; additive `request_id`, `launch_recovered=false`, `awaited_terminal=false`, `retry_allowed=false` |
| Existing Dispatch proven after launch error | `state=tracked`, `launch_recovered=true`, `launch_state`, full Run/Task/Dispatch/coordinator IDs, `wait_for_handoff` arguments, `completion_authority=worker_done` |
| Ambiguous creation or failed recovery | MCP `isError=true`, `state=unknown`, `recoverable=true`, `retry_allowed=false`, same `request_id` and available IDs; repeat identical handoff to inspect |
| This claimant never invoked worker-start | MCP `isError=true`, `state=not_started`, `retry_allowed=true`; allocation of a deliberately new request is allowed |

Recovery polls Orca's public `request-show` and exact `worker-show`, then verifies
Run/Task/Dispatch, workspace, coordinator Task provenance and requested/effective
agent/model/effort. It uses neither titles nor Git commits to identify a worker.
Completed and failed Dispatches can both return tracking IDs; neither is a
completion verdict. Pass the returned identity into unchanged `wait_for_handoff`
to consume the exact formal `worker_done`.

`request-show: absent` is **not** proof that a launch never happened (receipts can
be pruned). A pending request, unreadable/corrupt journal, lost identity, mismatch
or unavailable Orca remains UNKNOWN. A crash before any recoverable coordinator
identity can leave a request permanently requiring operator investigation; it
never silently allocates another worker. There is no automatic abandon, release,
termination, unkeyed retry or service restart.

## Verification and responsibility

Run `npm run test:execution-backends` or `npm run check`. Fault injection covers
receipt loss, nonzero exit, timeout/late creation, concurrent callers, process
restart, ambiguous absence, malformed/query failures, identity conflicts and
formal completion after recovery. The multi-process fixture persists its fake
Orca receipts across CLI restarts; this is local protocol-contract validation,
not proof of an installed Orca restart or live launch. Live destructive restart
and duplicate-worker probes are intentionally not required by this suite.

CodexPro is responsible for preserving launch identity and distinguishing receipt
failure from worker existence. Orca remains responsible for mutation atomicity,
request receipt persistence and turn-start observation. This fix requires Orca's
public request-show/retry-request protocol and does not modify Orca, agent routing,
model selection, quota, review gates or completion authority.
