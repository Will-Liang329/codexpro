# Execution backends

- **Orca** is the preferred new backend after both full-chain smoke tests pass.
- **AHR** is the legacy fallback during migration and remains the default until verification is complete.

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
