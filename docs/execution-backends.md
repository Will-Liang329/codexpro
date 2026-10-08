# Execution backends

- **Orca** is the production execution backend after the successful cutover recorded below.
- **AHR** remains available as the immediate fallback. The code default for an unset backend remains `ahr`; production explicitly configures `orca`.

CodexPro keeps `handoff_to_agent(agent, model, reasoning_effort, plan, workspace_id, title, append)`.
The AHR branch continues writing its existing handoff files. The Orca branch starts a supervised worker without writing `current-plan.md` or triggering the AHR watcher. Orca owns Tasks, Runs, Dispatches, worker lifecycle, and notifications. CodexPro stores no duplicate orchestration state.

## Selection and prerequisites

Set these environment variables on the CodexPro process, then restart only that process:

```sh
CODEXPRO_EXECUTION_BACKEND=orca
CODEXPRO_ORCA_BINARY=orca
CODEXPRO_ORCA_TIMEOUT_MS=60000
```

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

`handoff_to_agent` on the Orca backend returns **launch readiness, not task completion**: `state=ready` means Orca accepted the spec into the worker terminal. `wait_for_handoff` is the supported CodexPro completion bridge for Orca. Orca's `worker_done` message, Task and Dispatch remain the authority; CodexPro stores no orchestration state (no database, daemon, watcher or launchd job) and only reads Orca through its public CLI (`orchestration check`, `worker-show`, `task-list`) with `--json`.

**Input.** Pass the four identity fields from the launch receipt: `orca_run_id`, `orca_task_id`, `orca_dispatch_id` and `orca_coordinator_handle` (receipt `coordinator_handle`). When any `orca_*` field is present, all four are required and the Orca path is used; with none, the unchanged AHR path runs (`.ai-bridge/handoff-run-state.json`, `plan_hash`, `since_iteration`, excerpts). Nothing is inferred from the latest task, active tab, title or timestamps. `max_wait_seconds` (default 20, max 60) bounds one call; `poll_ms` only sets the `next_poll_after_seconds` hint, because the wait is a single bounded `check --wait --timeout-ms`. The call must not run under another Orca terminal's identity (Orca answers `consumer_fenced`); the launchd service has none.

**Completion.** A result is terminal only when a message of type `worker_done` carries the exact expected `taskId` **and** `dispatchId` and an explicit `outcome` of `succeeded` or `failed`. Messages for another Task or Dispatch are ignored (partial matches are reported under `evidence_conflict`). Output: `backend=orca`, `state` (`running`, `blocked`, `completed`, `failed`, `unknown`), `awaited_terminal`, `awaited_completed`, `succeeded`, `runId`, `taskId`, `dispatchId`, `outcome`, `worker_done` (`message_id`, `delivery_id`), bounded redacted `summary`, optional `filesModified` and `reportPath` (dropped if it escapes the workspace), `requested`/`effective` agent, model and effort from `worker-show`, `ack`, `worker` (stage/outcome/liveness only), `cross_check`, `evidence_conflict` and `next_poll_after_seconds` while non-terminal. `question`/`escalation` messages for the Dispatch surface as `blocked` with `pending_messages`. Orca failures, malformed JSON or a Run mismatch yield `state=unknown` with a short `error`; they are never reported as completion.

**Cross-check.** `worker-show` and `task-list` are compared with the message (Task `completed`/`failed`, Dispatch outcome, sender equals the assigned terminal). A mismatch is reported in `cross_check`/`evidence_conflict` and never changes the `worker_done` verdict; the reverse (Task settled but no `worker_done`) is `unknown`, not success. Git and `.ai-bridge` evidence are never consulted for Orca completion. Provider stderr, terminal previews and raw Orca payloads are not surfaced.

**Mailbox ACK.** Orca replays a Run's oldest unacknowledged delivery until it is acknowledged. The bridge processes a whole delivery first, then acknowledges that exact `deliveryId` (`check --ack <deliveryId>`), so stale deliveries cannot hide a later `worker_done`, `question` or `escalation`. The final delivery is acknowledged with `--ack <id> --peek`, which marks nothing else read. Because an acknowledged `worker_done` is no longer replayed, a repeated poll on a settled Task recovers it from the read-only `check --all` history (`recovered_from_history`), matching the same exact Task/Dispatch. This ACK is the only mutation; the bridge never starts, retries, stops, releases, restarts or falls back, and each call is bounded (at most 50 deliveries). Release settled workers separately with Orca's own commands.

**Artifacts.** `.ai-bridge` reports (`reportPath`) are optional supporting artifacts for large reviews or audits, not completion authority for Orca; workers need not write them.

## Rollback and limitations

```sh
CODEXPRO_EXECUTION_BACKEND=ahr
```

Restart only CodexPro with that setting, or restore the previous service artifact. No AHR/Router/watch state conversion is required. Existing AHR behavior and handoff schema remain intact.

This first adapter supports registered existing local workspaces, explicit `codex` or `claude`, and one complete spec per launch. `append=true` is rejected before allocating Orca resources. New worktrees, remote execution, status/cancel MCP APIs, automatic cleanup/recovery/retry, Dashboard migration, mobile bridges, and routing policy are out of scope. The coordinator terminal and Run remain Orca-owned; use Orca's resource controls after settlement. Failures after allocation return the known identities and require operator action.

## Historical verification checkpoint — 2026-10-06 (Asia/Taipei)

- Orca runtime: ready/reachable, version 1.4.221.
- Manual public CLI smoke: ready, turn start observed, Codex `gpt-6.1-sol` / `medium`, exact `ORCA_MANUAL_SMOKE_OK` file verified; worker settled and released.
- Adapter tests: 16 passed. Full existing CodexPro smoke suite: passed. AHR handoff/constraint tests: 22 passed.
- MCP Codex smoke: failed at `agent_readiness`, `agent-update-prompt`; no Task input sent.
- MCP Claude smoke: failed at `agent_readiness`, timeout; public worker-read shows Claude's Bypass Permissions confirmation; no Task input sent.
- Both failed receipts retain exact requested/effective model and effort and the Orca-issued IDs. Neither failure was reported as success.
- Production cutover is pending both full-chain smokes. The deployed AHR service has not been changed.

Migration status: AHR is retained as fallback. Orca becomes preferred only after both full-chain smokes pass; this checkpoint is not a completion claim.

Orca identities retained at this checkpoint:

| Attempt | Run | Task | Dispatch |
| --- | --- | --- | --- |
| Manual Codex | run_821ad4a4e39a | task_ec585e646481 | ctx_743afce6b2a1 |
| MCP Codex | run_9f2f618bbbb5 | task_9f340a95593e | ctx_ddeb285443f6 |
| MCP Claude | run_a3cad8983da8 | task_03ea878fafb9 | ctx_784de8987ff5 |

The failed smoke terminals are preserved for the operator to inspect and resolve provider prompts. Only the settled manual smoke worker was released. No live service was restarted.

## Historical blocked cutover follow-up — 2026-10-06 (Asia/Taipei)

The nine original migration files matched the prior working-tree snapshot exactly. No unrelated CodexPro changes appeared. The adapter, MCP schema, requested models/efforts, and production configuration were not redesigned or changed.

The original routing test reproduced its `0 !== 1` failure once in ten runs. It waited only 50 times at 10ms for an asynchronous subprocess and then cleaned up its fixtures while the Run was still pending. An 800ms delayed Router fixture made the failure deterministic. With the same production code allowed to finish, the launch occurred at 1121ms and all routing/model/effort/completion assertions passed. This identifies the observed failure as test synchronization/flakiness; no production race was demonstrated.

The only routing correction is in `agent-handoff-runner/test/routing-integration.test.ts`: observe the fake adapter's actual start event (or reject if the managed Run completes first), keep a bounded test timeout, and cover both immediate and 800ms delayed replies. No production Router code, timeout, policy, watcher, or state format changed. Both mapping cases passed 30 consecutive invocations each (60 case executions, zero failures). The full affected routing suite passed 5/5. AHR fallback handoff/constraint/routing tests passed 27/27 (one additional slow-reply case), and AHR typecheck passed.

The current CodexPro source passed `npm run check`: build, all existing smoke scripts, and all 16 Orca adapter tests. Orca remains 1.4.221 with a ready local runtime.

Public `orchestration task-list --run <id> --json` verified exact spec equality with the unchanged MCP smoke script:

| Agent | Task | UTF-8 bytes | Spec SHA-256 |
| --- | --- | --- | --- |
| codex | task_9f340a95593e | 327 | c2cefa435a7502f57a202ab5ee11aec3e5c77a1a5e16d71a9b8b96903a80841e |
| claude | task_03ea878fafb9 | 329 | fece6803ad82c1872ac3eed28db944190f8f6d2bd614a396faf904cba788e66a |

At the readiness recheck, the original Codex terminal still displayed `agent-update-prompt` and the Claude terminal still displayed the Bypass Permissions confirmation. Existing receipts preserve requested/effective `codex / gpt-6.1-sol / medium` and `claude / opus / medium`, but neither proves a completed agent turn. The two full-chain files are absent. No new MCP attempt is authorized by elapsed time or by these failed receipts; rerun only after the operator has cleared the prompts. No prompts were accepted, settings weakened, models changed, or providers substituted.

| Cutover gate | Result |
| --- | --- |
| Codex MCP full-chain | FAIL / blocked pending operator prompt resolution; not rerun |
| Claude MCP full-chain | FAIL / blocked pending operator prompt resolution; not rerun |
| Agent propagation | PASS at launch receipt boundary |
| Model propagation | PASS: requested equals effective in both retained receipts |
| Reasoning-effort propagation | PASS: medium equals medium in both retained receipts |
| Spec preservation | PASS: exact stored Orca Task spec equality |
| Orca readiness | Runtime PASS; both MCP worker readiness gates FAIL |
| Completion evidence | FAIL: no successful worker_done or required smoke files |
| Routing stability | PASS: 30/30 repeated invocations, both timing cases |
| AHR fallback | PASS: 27/27 minimal tests and CodexPro existing smoke |

Repository status: not ready for production cutover. No deployment, service restart, running backend switch, or migration-success commit was performed. All source changes remain uncommitted. Original failed Run/Task/Dispatch IDs and terminals remain available for inspection.

## Final cutover gate — 2026-10-06 (Asia/Taipei)

The operator confirmed the Codex upgrade and accepted Claude's Bypass Permissions prompt. Both smokes were then invoked through the unchanged `scripts/orca-integration-smoke.mjs` against the current CodexPro source build. Each MCP call allocated a completely new coordinator, Run, Task, and Dispatch; none of the previous failed identities were reused. The running production service was not changed.

| Agent | Requested = effective model | Requested = effective effort | New Run | New Task | New Dispatch |
| --- | --- | --- | --- | --- | --- |
| codex | gpt-6.1-sol | medium | run_e54e4236c58a | task_f4dbfa720326 | ctx_e09d49b07bb1 |
| claude | opus | medium | run_89a53750ca9b | task_50edda207543 | ctx_281c2357f9f8 |

Both receipts report `backend=orca`, `state=ready`, `stage=input_accepted`, `turnStart=observed`, and prompt stages `input_accepted, turn_started`. Exact existing workspace identity remained `wt2:local:0d372547-0ddd-4710-a486-081f388ed9d1` at `/private/tmp/codexpro-orca-smoke-20261006`. Requested/effective agent, model, and effort matched exactly. The fresh launches encountered neither of the previous prompts, and final worker observations reported `agentWait=null`.

Public `orchestration task-list` proved that both new stored specs exactly equal the original MCP request, including whitespace. Their SHA-256 hashes are unchanged from the earlier spec verification. Completion was independently observed through matching `worker_done` messages with `outcome=succeeded`, Tasks `completed`, and workers `succeeded`:

| Agent | Completion message | Verified file | File SHA-256 |
| --- | --- | --- | --- |
| codex | msg_36ca58d3a76a | .ai-bridge/orca/codex-smoke.txt | cd8e7084054591ed33769c268b6449c42e760115e39de5244f8705d5e8675a44 |
| claude | msg_3d4e96e1ad9c | .ai-bridge/orca/claude-smoke.txt | 9bd382489e3f86f0443c219f0236f9e8a158741776d5e45ac581e767f7b5c1f8 |

The two file byte sequences exactly equal `ORCA_CODEX_FULL_CHAIN_OK` and `ORCA_CLAUDE_FULL_CHAIN_OK`, respectively, with the allowed trailing newline. The disposable repo contains only those two files and the prior manual smoke file outside `.git`; no source, package, documentation, or Git configuration was modified by either worker. Both settled workers were released through `orchestration worker-release`; Orca reported `released` with captured transcript archives. Historical failed attempts were not reused or changed.

| Final gate | Result |
| --- | --- |
| Codex MCP full-chain | PASS |
| Claude MCP full-chain | PASS |
| Agent propagation | PASS |
| Model propagation | PASS |
| Reasoning-effort propagation | PASS |
| Spec preservation | PASS: exact stored spec equality |
| Orca readiness evidence | PASS: ready and turn start observed |
| Completion evidence | PASS: matching successful worker_done and exact files |
| Routing stability | PASS: normal and 800ms delayed cases each passed 30 consecutive invocations |
| AHR fallback | PASS: 27/27 minimal tests, plus existing CodexPro AHR smoke |

Final regression rerun: CodexPro `npm run check` passed its build, all 13 existing smoke scripts, and all 16 adapter tests. AHR handoff/constraint/routing tests passed 27/27 and AHR typecheck passed. The routing correction remains test-only; the original 500ms polling race is replaced by an actual adapter-start event and a slow-response regression case. No production routing logic changed.

**Repository is ready for a separately authorized production cutover.** This task does not deploy, restart production, or switch the running backend. The original production artifact and AHR default are retained. No remaining blocker exists within the normal full-chain/fallback scope; documented new-worktree/recovery/status/Dashboard limitations remain out of scope. Local commits close only the adapter implementation/documentation and the separate AHR test synchronization correction.

## Production cutover attempt — 2026-10-06 (Asia/Taipei)

**Final state: `ROLLED_BACK_TO_AHR`.** The validated source remains cutover-ready, but this production attempt stopped at the service reload gate. It did not establish an Orca production default.

Both validated commits were pushed normally and remote SHAs verified:

- CodexPro `371bc384321e5b80c9dc6060fb2b611235fa6479` on `codex/unified-worktree-handoff`.
- AHR test-only correction `3d6bad70bf6cc90de2d49a1d12f12d8d87ff6581` on `codex/codexpro-mcp-runbook`.

Previous production environment had no `CODEXPRO_EXECUTION_BACKEND`; the old artifact used AHR. The previous entrypoint was `/Users/will/.local/opt/codexpro-unified-worktree-handoff-9f1c01a/scripts/codexpro.mjs`. Its plist was backed up before mutation.

The new independent artifact `/Users/will/.local/opt/codexpro-orca-371bc38` was checked out at exactly the validated CodexPro commit, installed from locked cached dependencies, and built successfully. The installed LaunchAgent entrypoint now references its `scripts/codexpro.mjs`. All previous roots, auth, tunnel, PATH, and session-TTL settings were preserved.

The backend was set to `orca`, and only `com.will.codexpro.dev` was unloaded/reloaded. The initial `launchctl bootstrap gui/501 ...` returned exit 5. Subsequent read-only launchd forensics established the reload race: bootstrap failed at 19:33:52.191284 with `37: Operation already in progress`, while the old job reached removed only at 19:33:52.194267. No new Orca-configured service process was spawned. The original subprocess stderr was captured but not preserved. The automatic rollback wrote `ahr` but its reload stopped because it tried to boot out an already-unloaded job. An explicit bootstrap of the already-restored AHR plist then succeeded. No architectural correction or repeat Orca cutover was attempted.

Final production `CODEXPRO_EXECUTION_BACKEND=ahr`. The adapter code remains deployed, as required by rollback; only selection was restored. Health returned HTTP 200, listener PID changed from 81300 to 73411, and the real connected production MCP `server_config` returned `executionBackend=ahr` and all 16 expected registered tools. `open_current_workspace` also succeeded after reconnect. Existing AHR minimal handoff/constraint/routing tests passed 27/27.

Orca remained PID 83235, version 1.4.221, ready/reachable; it was not restarted. Router, Dashboard, Cloudflare, root plans, and legacy state were not changed. The isolated production smoke repository was prepared, but neither production MCP handoff was sent: no new production Run/Task/Dispatch IDs or duplicate executions were created.

The prior successful source/stdio smoke IDs above are pre-cutover evidence only and must not be represented as production smoke results. Production Codex and Claude smokes are both `NOT_RUN` because the reload gate failed.

Audit and exact prior/current configurations are preserved at `/Users/will/will-liang329/agent-handoff-runner/.ai-bridge/orca-cutover-20261006/` (`previous-codexpro.plist`, `rollback-ahr.plist`, `cutover-record.json`). The minimal backend rollback value is explicitly `ahr`; no adapter removal or legacy-state conversion is needed. The cutover window is closed in AHR production mode.


## Production cutover retry — 2026-10-06 (Asia/Taipei)

**Final state: `ORCA_PRODUCTION_DEFAULT`.** Both fresh production MCP full-chain smokes passed. Production explicitly selects `CODEXPRO_EXECUTION_BACKEND=orca`; immediate fallback remains `ahr`. This record supersedes the failed attempt above without deleting its evidence.

The only new operational code is `scripts/reload-codexpro-launchagent.py`, scoped to the existing `gui/<uid>/com.will.codexpro.dev` LaunchAgent and the validated deployment entrypoint. The existing ad-hoc cutover script had no reviewed settle pattern to reuse. The helper replaces its immediate bootout→bootstrap sequence with:

1. Inspect the existing job and boot out only if it exists.
2. Poll `launchctl print` every 100ms, up to 30 seconds, for an explicit `Could not find service "com.will.codexpro.dev"` response.
3. Bootstrap only after that authoritative absence response. Unexpected print errors and absence timeout stop without bootstrap.
4. Wait for launchd `state=running` and its new PID, then HTTP 200/`ok:true`.
5. Verify one listener and that its parent is the new launchd service PID.

The helper changes only the existing backend environment variable, preserves the plist mode and all other settings, and records before/after plists plus each command's timestamps, exit code, stdout and stderr. Each invocation requires a new evidence directory. Six focused regression tests passed, including delayed removal, absence timeout, unrelated print failure, absent-job rollback, bootout failure, and bootstrap failure without retry. No fixed sleep is used as a readiness gate.

### AHR reload stability and Orca reload

Every row below has a recorded authoritative absence response before bootstrap, bootstrap exit 0, one process tree/listener, health HTTP 200, fresh production HTTP MCP initialize/discovery, and a successful connected production MCP `server_config` reporting 16 tools.

| Backend / attempt | Absence confirmed (UTC+08) | Bootstrap invoked (UTC+08) | Service PID | HTTP listener PID | Result |
| --- | --- | --- | --- | --- | --- |
| AHR 1 | 20:03:11.249887 | 20:03:11.250288 | 87317 | 87319 | PASS |
| AHR 2 | 20:03:42.601439 | 20:03:42.601871 | 89393 | 89409 | PASS |
| AHR 3 | 20:04:03.657843 | 20:04:03.658243 | 90814 | 90845 | PASS |
| Orca | 20:04:44.859500 | 20:04:44.859984 | 93530 | 93550 | PASS |

Only CodexPro was reloaded. Its deployed adapter artifact remains `/Users/will/.local/opt/codexpro-orca-371bc38` at validated commit `371bc384321e5b80c9dc6060fb2b611235fa6479`. Neither adapter code nor its deployment entrypoint changed during this retry. Orca stayed PID 83235, version 1.4.221, ready/reachable. No Orca restart, Router change, Dashboard migration, schema change, or legacy-state removal occurred.

### Fresh production MCP full-chain evidence

Both handoffs were sent once through the connected production MCP, explicitly targeting the isolated existing repository `/Users/will/will-liang329/agent-handoff-runner/.ai-bridge/orca-production-smoke-20261006`. Its workspace identity is `wt2:local:cf2b8dcf-78cd-4225-9836-072db05a49c7`. No old Run/Task/Dispatch was reused. Codex completed and released before the Claude launch.

| Agent | Requested = effective model / effort | Run | Task | Dispatch | Successful worker_done |
| --- | --- | --- | --- | --- | --- |
| codex | gpt-6.1-sol / medium | run_cb122e6052f5 | task_f310f32e920b | ctx_373d6ab8664a | msg_66f77e702b5b |
| claude | opus / medium | run_5b96f088c438 | task_cedf1f041e35 | ctx_bce65843ed71 | msg_d3b698e91289 |

Both receipts report `backend=orca`, `ready`, `input_accepted`, `turnStart=observed`, requested/effective agent/model/effort equality, and `mutation.replayed=false`. Public Task inspection proves the stored specs exactly equal the corresponding MCP requests, including whitespace. Each new Run has one Task, one worker/Dispatch, and one successful matching worker_done; no duplicate execution was observed. Both Tasks completed, both workers settled `succeeded`, and `agentWait=null`. Both owned agent terminals were released with transcript archives captured. No interactive startup prompt blocked either launch.

| Agent | Exact isolated artifact (trailing newline allowed) | Spec SHA-256 | File SHA-256 |
| --- | --- | --- | --- |
| codex | `.ai-bridge/orca/production-codex-retry-smoke.txt`: `ORCA_CODEX_PRODUCTION_OK` | e56ae06b65bec76c71e678941ac11c2c37b562ea6883fad58dc457d0927314c0 | c1fde2103c31457b81fca2aa57f220c5ade9ed172a480e355e2eb0411a54e2da |
| claude | `.ai-bridge/orca/production-claude-retry-smoke.txt`: `ORCA_CLAUDE_PRODUCTION_OK` | 01b76b8ebf9ce411399c31f38be61396ab0795a23dbc5aca6d077c044d9cf847 | 8a6c7426e77cc8a3b8cc5b14fe4a4116fb396c1eba324c203749968d170a9018 |

The isolated repository contains only these two smoke files outside `.git`; root production plans and legacy state were not touched. Final post-smoke verification again confirmed backend Orca, the same running service PID 93530, exactly one listener PID 93550, HTTP 200, MCP reconnect/discovery and 16 registered tools. The AHR fallback handoff-contract, handoff-constraints and routing-integration tests passed 27/27. No repeated 60-run routing campaign or adapter redevelopment was performed.

### Immediate rollback

The exact backend value before this retry was `ahr`; the new value is `orca`. AHR code remains in the deployed artifact, and its backend reload was validated three times. No rollback was required in this successful retry.

Run the corrected helper with a fresh evidence directory:

```sh
python3 /Users/will/will-liang329/codexpro/scripts/reload-codexpro-launchagent.py \
  --backend ahr \
  --evidence-dir /absolute/new/rollback-evidence-directory
```

Then verify production MCP reconnect/discovery and run the existing isolated AHR minimal smoke. Do not use the preserved historical `switch-backend.py`, which contains the proven race. An absent service is supported by the corrected helper without a second failing bootout. The helper never bypasses an unproven absence gate or silently changes provider/model/effort.

Detailed per-command evidence, complete requests/receipts, public Orca observations, rollback setting and final gate summary are preserved under `/Users/will/will-liang329/agent-handoff-runner/.ai-bridge/orca-retry-20261006/`. Historical failed-cutover evidence remains under `.ai-bridge/orca-cutover-20261006/`. Migration stops here with Orca production default and AHR retained as fallback.
