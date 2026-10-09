# Orca completion bridge

Status: **production** as of 2026-10-08 (Asia/Taipei).

Production CodexPro explicitly uses `CODEXPRO_EXECUTION_BACKEND=orca`. AHR remains available as the immediate fallback. The production cutover deployed exact candidate `020b519dcc5ee954f7e72d7b6f48f7a66aff8a6e` as immutable artifact `~/.local/opt/codexpro-orca-completion-020b519` and kept `~/.local/opt/codexpro-orca-371bc38` for rollback.

## What changed

`handoff_to_agent` still launches work and returns launch readiness. On Orca, `state=ready` means the Task/Dispatch was accepted into the agent worker; it is **not** completion.

`wait_for_handoff` now supports Orca completion using exact launch identities. The bridge uses only Orca public CLI surfaces and does not create a parallel lifecycle database, daemon, watcher, or completion store.

Completion authority is intentionally narrow:

- only an Orca `worker_done` message with the exact expected `taskId` and `dispatchId`, plus explicit `outcome=succeeded|failed`, is authoritative completion;
- Task and Dispatch state are supporting cross-check evidence only;
- Git state, `.ai-bridge` artifacts, titles, timestamps, latest-task inference, terminal previews, and provider stderr are never completion authority;
- mailbox ACK is not worker/terminal release.

The bridge can return `running`, `blocked`, `completed`, `failed`, or `unknown`.

## Launch and wait workflow

### 1. Launch normally

Use `handoff_to_agent` with the requested agent, model, reasoning effort, plan, workspace and title.

Example conceptual request:

```text
agent = claude
model = claude-sonnet-5-5
reasoning_effort = medium
plan = <exact implementation contract>
```

A successful Orca launch receipt includes at least:

```text
runId
taskId
dispatchId
coordinator_handle
state = ready
stage = input_accepted
turnStart = observed
```

Keep those four identities. Do not replace them with a newer Task, active tab, title match, or guessed coordinator.

### 2. Wait using the exact identities

Call `wait_for_handoff` with all four Orca fields:

```text
orca_run_id = <runId>
orca_task_id = <taskId>
orca_dispatch_id = <dispatchId>
orca_coordinator_handle = <coordinator_handle>
max_wait_seconds = 20   # optional, max 60
poll_ms = 1000          # optional; controls the next-poll hint
```

When any `orca_*` identity is present, all four are required. If none are supplied, the unchanged AHR `wait_for_handoff` path is used.

`max_wait_seconds` bounds the consuming Orca wait in that call. Final ACK, cross-check and history reads each have their own bounded Orca process timeout, so it is not a strict whole-call deadline.

### 3. Interpret the result

- `state=completed`, `awaited_terminal=true`, `succeeded=true`: matching authoritative `worker_done` with `outcome=succeeded`.
- `state=failed`, `awaited_terminal=true`, `succeeded=false`: matching authoritative `worker_done` with `outcome=failed`.
- `state=blocked`: an attributable `question` or `escalation` for the awaited Task/Dispatch is pending.
- `state=running`: no authoritative completion yet; poll again using the same four identities.
- `state=unknown`: identity/schema/history/fencing evidence is unsafe or contradictory; do not infer success from Task/Dispatch state and do not silently fall back.

Generic, unparsable or foreign questions/escalations do not block scanning for the matching `worker_done`; they are reported as ignored evidence.

## Mailbox ACK behavior

Orca replays the oldest unacknowledged delivery. The bridge processes an entire delivery first and only then ACKs that exact `deliveryId`.

The final processed delivery is ACKed with `--ack <id> --peek`, so the ACK does not consume a later batch. The receipt must confirm the same Run and exact `acknowledged` delivery ID. Null, missing, wrong-type or wrong-value confirmations are retained as ACK failures.

Earlier ACK failures remain in `ack_failures` even if a later ACK succeeds.

If an authoritative `worker_done` was already validated, a later supporting ACK failure does not overwrite the completion verdict.

If no current matching `worker_done` is present, the bridge can perform a bounded read-only `check --all` history recovery for the same exact Run/Task/Dispatch. Task/Dispatch state and pending messages do not gate that recovery.

## `consumer_fenced`

The coordinator identity is ownership-sensitive. Do not run a wait under another Orca terminal's identity.

When `consumer_fenced` occurs before any authoritative `worker_done` is validated, the bridge returns `state=unknown` with `error.code=consumer_fenced`; it does not bypass the fence, switch identities, retry lifecycle actions, or fall back to AHR.

When an exact authoritative `worker_done` was already validated, a later final-ACK fence remains supporting ACK evidence and does not rewrite a completed/failed result.

## Safety and lifecycle boundaries

`wait_for_handoff` on Orca is deliberately not read-only because it ACKs the exact mailbox delivery. Its MCP annotations therefore use `readOnlyHint=false`, while destructive/open-world remain false and idempotent is false.

The completion bridge never performs worker start/retry/release/restart/fallback as part of waiting. Orca owns Run/Task/Dispatch/worker lifecycle. Terminal/session retention, reuse, release, TTL/caps/LRU and future session-affinity policy remain separate Router/lifecycle concerns.

Retained worker terminals are not a completion-bridge defect. Settled **coordinator** terminals are handled by the cleanup below.

## Coordinator terminal cleanup

Orca binds the mailbox, consumer generation and fence to the Run (`run.coordinator_handle`), not to terminal liveness. `.ai-bridge/orca-coordinator-lifecycle-experiment.md` showed that after a matching `worker_done` is consumed and exactly ACKed, closing the coordinator terminal still lets a repeat `wait_for_handoff` return `completed` through history recovery. `launchOrca` creates one coordinator terminal per handoff, so without cleanup every finished handoff leaves a shell behind.

`wait_for_handoff` therefore closes the coordinator after the verdict is fixed (`CODEXPRO_ORCA_CLOSE_COORDINATOR`, default on, `0` disables):

- the result reports it as `coordinator_cleanup` = `{status, coordinator_handle, reason?, code?, message?}` with `status` one of `closed`, `already_gone`, `skipped`, `failed`;
- the close is `orchestration run-show --id <run>` (the handle must still be the Run's `coordinator_handle`), then `terminal close --terminal <exact handle> --tab`. Never `--worktree ... --all`, never a worker terminal (also refused if the handle equals the Dispatch assignee). Identity fails closed: cleanup needs a successful `worker-show` + `task-list` cross-check (`cross_check.status=consistent`) that establishes a well-formed Dispatch assignee terminal; otherwise it is skipped with `cross_check_unavailable` or `assignee_unverified`, and the verdict stays authoritative;
- it runs only for `state=completed|failed` with `awaited_terminal=true`, and only when either the matching delivery was exactly ACKed, or the verdict was recovered from history after a consuming check observed an empty mailbox (so history can only hold ACKed rows);
- it is skipped (`status=skipped`, with `reason`) on `evidence_conflict`, `cross_check_unavailable`, `assignee_unverified`, any ACK failure or unconfirmed ACK, `consumer_fenced`, an attributable pending question/escalation, an undrained mailbox during history recovery, or an unverifiable Run binding. `running`, `blocked` and `unknown` results never reach cleanup and have no `coordinator_cleanup` field;
- `terminal_handle_stale` is `already_gone` (the desired end state), so a repeat wait after the close is harmless;
- a failed or skipped close never rewrites a valid verdict and never triggers worker start/retry/release/fallback. The close is attempted once per call, with no retry.

Runtime semantics to be aware of: this adds one more mutation to `wait_for_handoff` (a best-effort terminal close), and the coordinator terminal can no longer be used interactively after a terminal verdict. The retained `orca_coordinator_handle` remains valid for repeat waits.

### One-time backlog cleanup

Historical coordinators from before this change can be closed with an operator script. It is **dry-run by default**:

```sh
npm run build
npm run orca:cleanup-coordinators                       # dry-run: read-only Orca calls, lists candidates and exclusions
npm run orca:cleanup-coordinators -- --json             # machine-readable report
npm run orca:cleanup-coordinators -- --apply            # closes the proven candidates, one exact handle at a time
```

Options: `--min-age-minutes` (default 60, applies to both the Run and the terminal's last output), `--max-close` (default 50, apply batch size), `--max-runs` (default 1000; hitting it with Runs remaining makes `--apply` refuse), `--title <exact title>` (repeatable; default plain shells `CodexPro coordinator`, `zsh`, `bash`, `sh`, `fish`), `--allow-unread-worker-done` (see below), `--orca-binary`.

A coordinator handle is a candidate only when **every** Run it coordinates is proven settled from Orca state, and the terminal itself is a live, idle, plain-shell coordinator. Everything else is excluded with a reason:

- Run: not legacy; has Tasks, all `completed|failed`; every Task has a Dispatch; every Dispatch is `completed|failed` with a matching `succeeded|failed` outcome and no pending worker release; every Dispatch has a matching, `read` (unless `--allow-unread-worker-done`), correctly-attributed `worker_done` with the same outcome in the coordinator's history (`check --terminal <handle> --all`, read-only); no `question`/`escalation` anywhere in that history; history is the same Run and well-formed.
- Terminal: present in `terminal list` and connected (missing/orphaned handles are reported as `already_gone`, never acted on); not the invoking terminal (`ORCA_TERMINAL_HANDLE`); not a worker terminal of any Dispatch; title is a plain shell (agent TUIs and untitled terminals are excluded); last output older than `--min-age-minutes`.
- Any failed inventory read (`run-list`, `worker-list`, `terminal list`) aborts the scan. Apply re-verifies each handle against `run-show` and closes it by exact handle with `--tab`, treating `terminal_handle_stale` as already gone.

**Historical unread `worker_done` (`--allow-unread-worker-done`, operator-only, off by default).** By default a `worker_done` that is still unread excludes the handle (`worker_done_unread`). A real supervised lifecycle experiment showed that a settled worker's unread `worker_done` (`read=0`) survives an exact coordinator close before the first consume: the deployed bridge, given the original four identities, still returns authoritative `completed`, exactly ACKs the delivery, and a repeat wait recovers from history. For the one-time historical backlog an operator may therefore pass this flag to waive **only** the `worker_done_unread` exclusion. Every other proof stays mandatory (settled Tasks/Dispatches with matching outcomes, a matching `worker_done` by identity/outcome/sender, no question/escalation, complete inventories, non-worker coordinator handle, exact Run binding, age/title/caller gates, exact-handle close). Candidates admitted this way carry `unread_worker_done_waived: true`, and the report carries `allow_unread_worker_done`. The flag exists only in this script; live `wait_for_handoff` cleanup eligibility is unchanged.

**Inventory completeness (fail-closed).** The report carries `inventory_complete` and `inventory_gaps` (`<inventory>:<reason>`). Each inventory is complete only when its source proves the end of the data; otherwise the gap is reported in dry-run (the text output prints `INVENTORY INCOMPLETE`, and listed candidates are then not proven) and `--apply` refuses: zero `terminal close` calls, `results: []`, an `apply refused` warning, and exit code 3.

| Inventory | Incomplete when |
| --- | --- |
| `runs` | `row_cap_reached` (`--max-runs` hit with Runs remaining; a cap exactly equal to the Run count is complete), `malformed_cursor`, `empty_page_with_cursor`, `cursor_not_advancing`, `page_limit_reached` (1000 pages) |
| `workers` | `has_more_without_cursor`, `page_end_unproven` (`page.hasMore` missing or not boolean), `empty_page_with_cursor`, `cursor_not_advancing`, `page_limit_reached` |
| `terminals` | `truncated`, `truncation_unproven` (`truncated` is not exactly `false`), `total_exceeds_listed` |

`--max-close` is only a batch-size cap (`apply stopped at --max-close`, re-run to continue) and is not an inventory failure. To clear a `runs:row_cap_reached` gap, raise `--max-runs` above the number of Runs.

The script runs Orca CLI calls with the `ORCA_*`/`TERM_PROGRAM*` terminal-attestation variables removed from the child environment (as the launchd-run service does), because Orca otherwise rejects consumer reads attested as another terminal (`consumer_fenced`). An individual ACK is not observable in history, so the backlog uses the `worker_done` message's `read` flag as its proxy; per the lifecycle experiment a closed coordinator can still consume and ACK later, so a missed ACK cannot be made worse by the close.

## Optional report artifacts

A worker may provide a `reportPath`, but it is supporting evidence only. The path must resolve inside the workspace after symlink resolution; unsafe, missing or unprovable paths are dropped. The completion bridge does not read the report file to decide completion.

## Production verification

The production candidate passed the following before cutover:

- formal completion-bridge review: P0/P1/P2 = 0/0/0;
- completion tests: 39/39;
- execution-backend tests: 55/55;
- independent RF probes: 87/87;
- `npm run check`, release guard/pack, package smoke and stress;
- dependency audits: 0 vulnerabilities, including production-only audit;
- dependency remediation to `@modelcontextprotocol/sdk@1.31.0` and `proxy-addr@2.0.8` (Express remained 5.2.1).

Production cutover changed only the `com.will.codexpro.dev` entrypoint to the immutable new artifact. Observed endpoint downtime was about 1.21 seconds. Post-cutover verification confirmed one listener on `127.0.0.1:8787`, `/healthz` HTTP 200, Orca backend, MCP initialize/discovery and 16 registered tools. Adjacent Orca, Router, Dashboard, cloudflared and AHR-related services were not restarted or reconfigured.

The completion path was also validated with an isolated synthetic Orca shim so the smoke could exercise exact Run/Task/Dispatch matching and exact mailbox ACK without consuming unrelated live Orca mailbox deliveries.

## Rollback

Immediate backend fallback remains:

```sh
CODEXPRO_EXECUTION_BACKEND=ahr
```

For the production artifact rollback, restore the preserved `com.will.codexpro.dev` plist entrypoint to `~/.local/opt/codexpro-orca-371bc38/scripts/codexpro.mjs`, then use the settle-safe launchd sequence and verify a single listener plus `/healthz` and MCP discovery.

Do not use the historical reload sequence that bootstraps before launchd has authoritatively removed the previous job.
