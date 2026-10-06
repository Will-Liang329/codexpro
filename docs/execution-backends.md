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

## Operator verification

Keep machine-specific deployment records, service plists, absolute workspace
paths and live Run/Task/Dispatch identities outside the public repository and
package. Before a backend switch, retain the previous artifact and configuration;
verify the new artifact with disposable fixtures, then change only the intended
service. Wait for authoritative service absence before bootstrapping its
replacement. Check one listener, health, MCP discovery and the selected backend;
restore the previous configuration if verification fails. Never infer a successful
worker outcome from a startup receipt or Task/Dispatch status alone.
