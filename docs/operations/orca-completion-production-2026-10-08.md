# Orca completion bridge production record — 2026-10-08

Outcome: **DEPLOYED**.

This record captures the production state after the CodexPro Orca completion bridge, dependency remediation and production cutover were completed.

## Exact production identity

- Production source candidate: `020b519dcc5ee954f7e72d7b6f48f7a66aff8a6e`.
- Production artifact: `~/.local/opt/codexpro-orca-completion-020b519`.
- Previous rollback artifact retained: `~/.local/opt/codexpro-orca-371bc38`.
- Service: `com.will.codexpro.dev`.
- Backend: `orca`.
- Endpoint: `127.0.0.1:8787`.
- MCP registered tools after cutover: 16.
- Production version: CodexPro `0.30.2`.

Repository note: the exact production candidate was local and had not yet been pushed when this documentation branch was created. This operations record therefore identifies the deployed SHA explicitly; the documentation branch's own commit SHA is not the deployed runtime SHA.

## Final review and release gates

Completion bridge formal RF passed with P0/P1/P2 = 0/0/0. The final completion suite passed 39/39 tests, execution backend suite 55/55, and 87/87 independent RF probes.

Security remediation updated:

- `@modelcontextprotocol/sdk`: locked `1.30.0` -> `1.31.0`;
- `proxy-addr`: `2.0.7` -> `2.0.8`;
- Express remained `5.2.1`.

Both full and production-only dependency audits reported 0 vulnerabilities. `npm ci`, `npm run check`, release guard, release pack, package smoke, stress and `git diff --check` all passed on the exact candidate snapshot before deployment.

## Cutover

The cutover was scoped to `com.will.codexpro.dev` only.

The new immutable artifact was built from the exact candidate, validated, moved into place and made read-only. The live plist was backed up and the prepared replacement was checked with `plutil -lint`. The only intended plist content change was `ProgramArguments[1]`, replacing the old artifact entrypoint with the new completion-bridge artifact entrypoint.

The service was booted out, launchd absence and port 8787 release were confirmed, the plist was atomically swapped, and the service was bootstrapped again. `/healthz` returned HTTP 200 on the first poll cycle. Observed bootout-to-healthy downtime was approximately 1.21 seconds.

Old service PID was 93530 (listener child 93550). New service PID was 18877 (listener child 18887) and remained stable with one run and no restart loop at verification time.

## Post-cutover verification

Post-cutover verification confirmed:

- exactly one listener on `127.0.0.1:8787`;
- `/healthz` HTTP 200;
- `bashMode=off`, `writeMode=handoff`, `toolMode=standard`, authentication disabled as before;
- MCP initialize succeeded and `tools/list` returned 16 tools;
- `server_config` reported `executionBackend=orca`;
- `wait_for_handoff` exposes the four Orca identity fields and correctly advertises `readOnlyHint=false` because the Orca path ACKs mailbox deliveries;
- service stderr remained empty and startup was clean;
- adjacent cloudflared, Dashboard, Router, capacity collector, Orca application and other service states were not changed by this cutover.

## Completion smoke

The post-cutover completion smoke did **not** consume a live Orca coordinator mailbox. Instead, a throwaway CodexPro instance used the same runtime flags with a separate home and a recording Orca shim.

Synthetic identities were:

```text
run_SMOKE
task_SMOKE
ctx_SMOKE
```

The delivery contained a foreign `worker_done`, a heartbeat and the exact matching `worker_done`. The bridge returned `state=completed`, `succeeded=true`, `outcome=succeeded`, ignored the two unrelated messages and ACKed only the exact synthetic delivery. The shim observed one consuming check, one final exact ACK with `--peek`, one worker-show and one task-list; there were no worker-release or unrelated lifecycle calls.

This verifies the deployed code path while avoiding accidental ACK of an unrelated real mailbox delivery.

## Completion contract now in production

- `handoff_to_agent` readiness is not task completion.
- Exact `worker_done` for the expected Task + Dispatch with explicit `succeeded|failed` is the sole completion authority.
- Task/Dispatch state is supporting evidence only.
- Generic or foreign questions/escalations do not block the awaited completion.
- Attributable questions/escalations can return `blocked` with `pending_messages`.
- Whole-delivery schema is validated before ACK.
- ACK receipts must confirm the exact Run and delivery ID; failures are retained as evidence.
- ACKed `worker_done` can be recovered from bounded read-only history for the exact identities.
- `consumer_fenced` before authoritative completion returns `unknown/error` and is never bypassed or silently downgraded to running/blocked.
- A validated worker_done verdict remains authoritative if a later supporting final ACK fails or is fenced.
- `reportPath` is optional supporting evidence, symlink-confined to the workspace and never read as completion authority.
- Mailbox ACK is not worker/terminal release.
- Terminal retention/reuse/release/GC remains outside the completion bridge and is deferred to Router/session-affinity/lifecycle policy.

## Rollback

No rollback was required during this deployment.

The previous immutable artifact remains available. Manual rollback should boot out only `com.will.codexpro.dev`, wait for authoritative absence, atomically restore the backed-up plist pointing to `codexpro-orca-371bc38`, bootstrap the service and verify one listener, `/healthz` 200, MCP initialize/discovery and expected backend state.

AHR also remains the backend fallback. A backend-only fallback can restore `CODEXPRO_EXECUTION_BACKEND=ahr` through the reviewed settle-safe reload path.

Do not use the older immediate bootout/bootstrap sequence that previously hit a launchd removal race.
