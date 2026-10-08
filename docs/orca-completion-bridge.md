# Orca completion bridge

Status: **production** as of 2026-10-08 (Asia/Taipei).

Production CodexPro explicitly uses `CODEXPRO_EXECUTION_BACKEND=orca`. AHR remains available as the immediate fallback. The production cutover deployed the exact local candidate `020b519dcc5ee954f7e72d7b6f48f7a66aff8a6e` as the immutable artifact `~/.local/opt/codexpro-orca-completion-020b519` and kept the previous artifact `~/.local/opt/codexpro-orca-371bc38` for rollback.

> Important repository note: this documentation branch was created from the last pushed implementation branch head (`371bc384321e5b80c9dc6060fb2b611235fa6479`). The production candidate commits through `020b519...` were still local when this documentation branch was created. Do not treat the documentation-branch HEAD as the deployed artifact SHA.

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

Retained terminals are not a completion-bridge defect.

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
