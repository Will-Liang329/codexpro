# Execution backends

- **Orca** starts supervised workers through its public CLI.
- **AHR** writes local handoff files and remains the default when no backend is configured.

CodexPro keeps `handoff_to_agent(agent, model, reasoning_effort, plan, workspace_id, title, append)`.
The AHR branch continues writing its existing handoff files. The Orca branch starts a supervised worker without writing `current-plan.md` or triggering the AHR watcher. Orca owns Tasks, Runs, Dispatches, worker lifecycle, and notifications. CodexPro stores no duplicate orchestration state.

## Selection and prerequisites

Set these environment variables on the CodexPro process, then restart only that process:

```sh
CODEXPRO_EXECUTION_BACKEND=orca
CODEXPRO_ORCA_BINARY=orca
CODEXPRO_ORCA_TIMEOUT_MS=60000
```

`CODEXPRO_ORCA_CLOSE_COORDINATOR` (default `1`; `0` disables) controls the post-completion close of the exact Run coordinator terminal described in `docs/orca-completion-bridge.md`; it never affects the completion verdict.

`CODEXPRO_ORCA_BINARY` may be an absolute path or a command on the service PATH. No installation path is hardcoded. The timeout is the worker readiness deadline; each subprocess has an additional 10-second transport margin. Missing, interrupted, nonzero, malformed, or non-ready responses are errors; CodexPro never automatically retries or falls back.

The initial default is `ahr`. Invalid backend values fail startup explicitly. `server_config` reports the selected backend, executable, and timeout. Deployment must retain the existing allowed roots, loopback/auth settings, and service environment.

Required public CLI surface was tested with **Orca 1.4.221** on macOS:

```text
status --json
worktree show --worktree path:<canonical-workspace> --json
terminal create --worktree identity:<runtime-identity> --title "CodexPro coordinator" --json
orchestration run-create --objective <title> --from <created-terminal-handle> --json
orchestration worker-start --spec <unchanged-plan> --worktree identity:<runtime-identity> --agent <codex|claude> --model <model> --effort <effort> --run <run-id> --from <created-terminal-handle> --timeout-ms <milliseconds> --json
```

Orca must already be running with a ready local runtime. The exact existing workspace must already be registered with Orca. CodexPro verifies its canonical path and local worktree identity; it does not guess from the active tab, auto-register repos, start Orca, or create worktrees. `terminal create` establishes a legitimate runtime-issued coordinator identity before `run-create`; arbitrary or existing unrelated handles are never adopted.

`plan` is passed verbatim as a single argv value. Agent, model, and effort are checked against both `launch.requested` and `launch.effective`. Effort requires an explicit model. Only `state=ready` is accepted. Failures preserve the Orca receipt, including original IDs, stage, unknown state, residual resources, and recovery instructions. Process stderr is separated and never logged. There is no shell interpolation, credential inspection, internal Orca import, or SQLite access.

## Tests and opt-in smoke

```sh
npm run test:execution-backends
npm run check
```

Register a dedicated disposable Git repository in Orca first. Provider login, update notices, and permission confirmations must be resolved by the operator. The integration script invokes the real MCP `handoff_to_agent` through an isolated CodexPro stdio process; it leaves the production HTTP service untouched.

```sh
orca repo add --path /absolute/disposable/repo --json
CODEXPRO_ORCA_SMOKE=1 npm run smoke:orca -- /absolute/disposable/repo codex gpt-6.1-sol medium
CODEXPRO_ORCA_SMOKE=1 npm run smoke:orca -- /absolute/disposable/repo claude opus medium
```

These plans permit only `.ai-bridge/orca/codex-smoke.txt` and `.ai-bridge/orca/claude-smoke.txt`, respectively. The launch receipt must name the backend, Run/Task/Dispatch IDs, requested/effective model and effort, workspace, and initial ready state. Launch readiness is not task completion: inspect the corresponding Orca `worker_done` and verify exact file bytes (`ORCA_CODEX_FULL_CHAIN_OK` or `ORCA_CLAUDE_FULL_CHAIN_OK`, optional trailing newline) separately. Use Orca's public `orchestration check`, `worker-show`, `worker-read`, and documented settlement/release commands, never resend an ambiguous launch.

## Orca completion bridge (`wait_for_handoff`)

`handoff_to_agent` on the Orca backend returns **launch readiness, not task completion**: `state=ready` means Orca accepted the spec into the worker terminal. `wait_for_handoff` is the supported CodexPro completion bridge for Orca. Only Orca's `worker_done` message is completion authority; Task and Dispatch are supporting cross-check evidence; CodexPro stores no orchestration state (no database, daemon, watcher or launchd job) and talks to Orca only through its public CLI (`orchestration check`, `worker-show`, `task-list`) with `--json`. The AHR path of `wait_for_handoff` is file-read-only; the Orca path runs the CLI and its only expected mutation is the exact mailbox delivery ACK, so the tool advertises `readOnlyHint:false` (`destructiveHint:false`, `openWorldHint:false`, `idempotentHint:false`) and is hidden in the read-only connection-test profile.

**Input.** Pass the four identity fields from the launch receipt: `orca_run_id`, `orca_task_id`, `orca_dispatch_id` and `orca_coordinator_handle` (receipt `coordinator_handle`). When any `orca_*` field is present, all four are required and the Orca path is used; with none, the unchanged AHR path runs (`.ai-bridge/handoff-run-state.json`, `plan_hash`, `since_iteration`, excerpts). Nothing is inferred from the latest task, active tab, title or timestamps. `max_wait_seconds` (default 20, max 60) bounds the consuming wait of one call (the final ACK, cross-check and history reads each have their own `orcaTimeoutMs + 10s` timeout, so it is not a strict whole-call deadline); `poll_ms` only sets the `next_poll_after_seconds` hint, because the wait is a single bounded `check --wait --timeout-ms`. The call must not run under another Orca terminal's identity (Orca answers `consumer_fenced`); the launchd service has none.

**Completion.** A result is terminal only when a message of type `worker_done` carries the exact expected `taskId` **and** `dispatchId` and an explicit `outcome` of `succeeded` or `failed`. Messages for another Task or Dispatch are ignored (partial matches are reported under `evidence_conflict`). Output: `backend=orca`, `state` (`running`, `blocked`, `completed`, `failed`, `unknown`), `awaited_terminal`, `awaited_completed`, `succeeded`, `runId`, `taskId`, `dispatchId`, `outcome`, `worker_done` (`message_id`, `delivery_id`), bounded redacted `summary`, optional `filesModified` and `reportPath` (dropped unless its real path, with symlinks resolved, provably exists inside the real workspace; the file is never read), `requested`/`effective` agent, model and effort from `worker-show`, `ack`, `worker` (stage/outcome/liveness only), `cross_check`, `evidence_conflict` and `next_poll_after_seconds` while non-terminal. A `question`/`escalation` blocks only when its payload carries the awaited `dispatchId` or `taskId` and contradicts neither; generic, unparsable or foreign ones are counted in `ignored_messages`, drained and do not stop scanning for the matching `worker_done`. Attributable ones surface as `blocked` with `pending_messages`. Orca failures, malformed JSON, a non-array/ill-formed `messages` result (every row needs a non-empty string `id` and `type`; never ACKed), a malformed or wrong-Run `check --all` history when no `worker_done` was validated or a Run mismatch yield `state=unknown` with a short `error`; they are never reported as completion.

**Cross-check.** `worker-show` and `task-list` are compared with the message (Task `completed`/`failed`, Dispatch outcome, sender equals the assigned terminal). A mismatch is reported in `cross_check`/`evidence_conflict` and never changes the `worker_done` verdict; the reverse (Task settled but no `worker_done`) is `unknown`, not success. Git and `.ai-bridge` evidence are never consulted for Orca completion. Provider stderr, terminal previews and raw Orca payloads are not surfaced.

**Mailbox ACK.** Orca replays a Run's oldest unacknowledged delivery until it is acknowledged. The bridge processes a whole delivery first, then acknowledges that exact `deliveryId` (`check --ack <deliveryId>`), so stale deliveries cannot hide a later `worker_done`, `question` or `escalation`. The final delivery is acknowledged with `--ack <id> --peek`, which marks nothing else read; its receipt must name this Run and `acknowledged` equal to that exact delivery id, otherwise `ack.status=failed` (untrusted receipt). Intermediate ACKs (`--ack <id>` on the next consuming check) use the same exact rule (null, missing or wrong-type/valued `acknowledged` is a failure). Every failed receipt is kept in `ack_failures` even if a later ACK succeeds; an already validated `worker_done` verdict is kept regardless. Because an acknowledged `worker_done` is no longer replayed, whenever no current `worker_done` matched, the bridge performs a bounded read-only `check --all` history recovery (`recovered_from_history`) for the same exact Run/Task/Dispatch and explicit outcome. `worker-show`, `task-list` and pending messages are cross-check evidence only and never gate it, so a failing `worker-show` or a not-yet-settled Task does not prevent recovery. This ACK is the only mutation; the bridge never starts, retries, stops, releases, restarts or falls back, and each call is bounded (at most 50 deliveries plus one final ACK, one cross-check and one history read). Release settled workers separately with Orca's own commands.

**Artifacts.** `.ai-bridge` reports (`reportPath`) are optional supporting artifacts for large reviews or audits, not completion authority for Orca; workers need not write them.

## Rollback and limitations

```sh
CODEXPRO_EXECUTION_BACKEND=ahr
```

Restart only CodexPro with that setting, or restore the previous service artifact. No AHR/Router/watch state conversion is required. Existing AHR behavior and handoff schema remain intact.

This first adapter supports registered existing local workspaces, explicit `codex` or `claude`, and one complete spec per launch. `append=true` is rejected before allocating Orca resources. New worktrees, remote execution, status/cancel MCP APIs, automatic cleanup/recovery/retry, Dashboard migration, mobile bridges, and routing policy are out of scope. The coordinator terminal and Run remain Orca-owned; use Orca's resource controls after settlement. Failures after allocation return the known identities and require operator action.

## Operator verification

Keep machine-specific deployment records, service plists, absolute workspace
paths and live Run/Task/Dispatch identities outside the public repository and
package. Before a backend switch, retain the previous artifact and configuration;
verify the new artifact with disposable fixtures, then change only the intended
service. Wait for authoritative service absence before bootstrapping its
replacement. Check one listener, health, MCP discovery and the selected backend;
restore the previous configuration if verification fails. Never infer a successful
worker outcome from a startup receipt or Task/Dispatch status alone.
