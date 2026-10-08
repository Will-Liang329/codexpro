import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { redactSensitiveText } from "./redact.js";

export type ExecutionBackend = "ahr" | "orca";

export function executionBackend(value: string | undefined): ExecutionBackend {
  if (value === undefined) return "ahr";
  if (value === "ahr" || value === "orca") return value;
  throw new Error("CODEXPRO_EXECUTION_BACKEND must be ahr or orca");
}

export interface CliOutput { exitCode: number; stdout: string; stderr: string }
export type OrcaProcess = (binary: string, args: string[], cwd: string, timeoutMs: number) => Promise<CliOutput>;

export const runOrcaProcess: OrcaProcess = (binary, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  execFile(binary, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
    (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        // Never include argv, provider output, or environment in diagnostics.
        reject(new Error(`Orca process unavailable or interrupted (${error.killed ? "timeout_or_signal" : error.code ?? "unknown"})`));
      } else resolve({ exitCode: error?.code as number ?? 0, stdout, stderr });
    });
});

export class OrcaLaunchError extends Error {
  constructor(message: string, public readonly receipt: Record<string, unknown>) { super(message); }
}

function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Orca receipt missing ${label}`);
  return value;
}

export async function launchOrca(config: Pick<CodexProConfig, "orcaExecutable" | "orcaTimeoutMs">,
  input: { workspace: string; plan: string; agent?: string; model?: string; reasoningEffort?: string; title?: string; append?: boolean },
  process: OrcaProcess = runOrcaProcess): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = { backend: "orca", workspace: input.workspace,
    agent: input.agent, model: input.model, reasoning_effort: input.reasoningEffort };
  let stage = "validate_input";
  try {
    if (input.append) throw new Error("Orca handoff does not support append; submit one complete spec");
    if (!input.plan.trim()) throw new Error("plan must not be empty");
    if (input.agent !== "codex" && input.agent !== "claude") throw new Error("Orca backend supports explicit agent=codex or claude");
    if (input.reasoningEffort !== undefined && !input.model) throw new Error("Orca reasoning_effort requires an explicit model");
    const workspace = await fs.realpath(input.workspace);
    context.workspace = workspace;
    const call = async (nextStage: string, args: string[], acceptNonReady = false): Promise<Record<string, any>> => {
      stage = nextStage;
      const output = await process(config.orcaExecutable, [...args, "--json"], workspace, config.orcaTimeoutMs + 10000);
      let json: Record<string, any>;
      try { json = object(JSON.parse(output.stdout)); }
      catch { throw new Error(`Orca ${stage} returned malformed JSON (exit ${output.exitCode})`); }
      const result = object(json.result);
      if (acceptNonReady) {
        context.orca_receipt = json;
        for (const key of ["runId", "taskId", "dispatchId", "state", "failedStage", "turnStart"]) {
          if (result[key] !== undefined) context[key] = result[key];
        }
      }
      if (output.exitCode !== 0 || json.ok !== true) {
        throw new OrcaLaunchError(`Orca ${stage} failed (exit ${output.exitCode})`,
          { ...context, stage, exit_code: output.exitCode, orca_receipt: json });
      }
      return result;
    };
    const status = await call("status", ["status"]);
    if (object(status.runtime).reachable !== true || object(status.runtime).state !== "ready" || object(status.target).kind !== "local") {
      throw new Error("Orca local runtime is not ready");
    }
    const found = object((await call("workspace", ["worktree", "show", "--worktree", `path:${workspace}`])).worktree);
    if (found.path !== workspace || found.isArchived === true || object(found.identity).executionHostId !== "local") {
      throw new Error("Orca workspace identity does not match the authorized local workspace");
    }
    const selector = `identity:${requiredId(object(found.identity).key, "worktree identity")}`;
    context.worktree_id = requiredId(found.id, "worktree id");
    context.worktree_identity = object(found.identity).key;
    const terminal = object((await call("coordinator", ["terminal", "create", "--worktree", selector,
      "--title", "CodexPro coordinator"])).terminal);
    const handle = requiredId(terminal.handle, "coordinator handle");
    context.coordinator_handle = handle;
    if (terminal.worktreeId !== found.id) throw new Error("Orca coordinator workspace mismatch");
    const run = object((await call("run", ["orchestration", "run-create", "--objective", input.title || "CodexPro handoff", "--from", handle])).run);
    const runId = requiredId(run.id, "run id");
    context.runId = runId;
    const args = ["orchestration", "worker-start", "--spec", input.plan, "--worktree", selector,
      "--agent", input.agent, "--run", runId, "--from", handle, "--timeout-ms", String(config.orcaTimeoutMs)];
    if (input.title) args.push("--task-title", input.title);
    if (input.model !== undefined) args.push("--model", input.model);
    if (input.reasoningEffort !== undefined) args.push("--effort", input.reasoningEffort);
    const receipt = await call("worker_start", args, true);
    context.orca_receipt = receipt;
    if (receipt.runId !== runId) throw new Error("Orca worker receipt Run mismatch");
    requiredId(receipt.taskId, "task id");
    requiredId(receipt.dispatchId, "dispatch id");
    if (receipt.state !== "ready") throw new Error(`Orca worker is ${String(receipt.state ?? "unknown")}`);
    const requested = object(object(receipt.launch).requested);
    const effective = object(object(receipt.launch).effective);
    for (const [key, value] of [["agent", input.agent], ["model", input.model], ["effort", input.reasoningEffort]] as const) {
      if (value !== undefined && (requested[key] !== value || effective[key] !== value)) {
        throw new Error(`Orca launch ${key} was not preserved`);
      }
    }
    return { ...context, ...receipt, backend: "orca", workspace, agent: effective.agent,
      model: effective.model, reasoning_effort: effective.effort };
  } catch (error) {
    if (error instanceof OrcaLaunchError) throw error;
    throw new OrcaLaunchError(error instanceof Error ? error.message : "Orca launch failed", { ...context, stage });
  }
}

// ---------------------------------------------------------------------------
// Orca completion bridge (read-mostly): observes the exact Run/Task/Dispatch
// returned by launchOrca through Orca's public CLI. Orca owns lifecycle state;
// nothing here is persisted, and the only mutation is the mailbox ACK that
// Orca's documented consumer protocol requires.
// ---------------------------------------------------------------------------

export interface OrcaWaitIdentity { runId: string; taskId: string; dispatchId: string; coordinatorHandle: string }
export interface OrcaWaitOptions { maxWaitMs: number; pollMs: number; workspace?: string }

const WAIT_TYPES = ["worker_done", "question", "escalation"];
const MAX_BATCHES = 50;
const TEXT_MAX = 4000;
const LIST_MAX = 100;
const HISTORY_MAX = 2000;

function clip(value: unknown, max = TEXT_MAX): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const text = redactSensitiveText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function parsePayload(value: unknown): Record<string, any> | undefined {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined; }
    catch { return undefined; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

// Filesystem-aware confinement: both paths are resolved through symlinks and the report must
// exist inside the real workspace. Anything unprovable (missing, broken link, error) is dropped.
// The file is never opened or read.
async function safeReportPath(value: unknown, workspace?: string): Promise<string | undefined> {
  if (typeof value !== "string" || !value || value.length > 500 || /[\u0000-\u001f]/.test(value)) return undefined;
  if (!workspace || value.split(/[\\/]/).includes("..")) return undefined;
  try {
    const realWorkspace = await fs.realpath(workspace);
    const real = await fs.realpath(path.isAbsolute(value) ? value : path.join(realWorkspace, value));
    const relative = path.relative(realWorkspace, real);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  } catch { return undefined; }
  return redactSensitiveText(value);
}

class OrcaCallError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

export async function waitForOrca(config: Pick<CodexProConfig, "orcaExecutable" | "orcaTimeoutMs">,
  identity: OrcaWaitIdentity, options: OrcaWaitOptions, process: OrcaProcess = runOrcaProcess,
  now: () => number = Date.now): Promise<Record<string, unknown>> {
  const { runId, taskId, dispatchId, coordinatorHandle } = identity;
  const deadline = now() + options.maxWaitMs;
  const nextPoll = Math.max(1, Math.ceil(options.pollMs / 1000));
  const base: Record<string, unknown> = { backend: "orca", runId, taskId, dispatchId };
  const cwd = options.workspace ?? "/";

  const call = async (args: string[], timeoutMs: number): Promise<Record<string, any>> => {
    const output = await process(config.orcaExecutable, [...args, "--json"], cwd, timeoutMs);
    let json: Record<string, any>;
    try { json = object(JSON.parse(output.stdout)); }
    catch { throw new OrcaCallError(`Orca ${args[1]} returned malformed JSON (exit ${output.exitCode})`, "malformed_json"); }
    if (output.exitCode !== 0 || json.ok !== true) {
      const error = object(json.error);
      throw new OrcaCallError(`Orca ${args[1]} failed (exit ${output.exitCode})${clip(error.message, 300) ? `: ${clip(error.message, 300)}` : ""}`,
        clip(error.code, 80) ?? "orca_error");
    }
    return object(json.result);
  };
  const quick = (args: string[]) => call(args, config.orcaTimeoutMs + 10000);
  // Public check results must carry an array of object messages; anything else is malformed and never processed or ACKed.
  const messageList = (result: Record<string, any>): any[] => {
    if (!Array.isArray(result.messages) || result.messages.some((m: unknown) => m === null || typeof m !== "object" || Array.isArray(m))) {
      throw new OrcaCallError("Orca check returned a malformed messages result", "malformed_result");
    }
    return result.messages;
  };

  let ackPending: string | undefined;
  let lastAcked: string | undefined;
  let ackProblem: string | undefined;
  const conflicts: string[] = [];
  const pending: Record<string, unknown>[] = [];
  let ignored = 0;
  let matched: { message: Record<string, any>; payload: Record<string, any>; deliveryId?: string; recovered?: boolean } | undefined;
  let blocked: Record<string, unknown> | undefined;

  const consider = (raw: unknown, deliveryId: string | undefined): void => {
    const message = object(raw);
    const payload = parsePayload(message.payload);
    if ((typeof message.run_id === "string" && message.run_id !== runId) || !payload && message.type === "worker_done") { ignored++; return; }
    if (message.type === "worker_done" && payload) {
      const taskOk = payload.taskId === taskId, dispatchOk = payload.dispatchId === dispatchId;
      if (taskOk && dispatchOk) {
        if (payload.outcome !== "succeeded" && payload.outcome !== "failed") {
          conflicts.push(`worker_done ${clip(message.id, 80) ?? ""} for the awaited Task/Dispatch lacks an explicit succeeded|failed outcome`);
        } else if (matched && object(matched.payload).outcome !== payload.outcome) {
          conflicts.push("multiple worker_done messages for the awaited Dispatch disagree on outcome");
        } else if (!matched) matched = { message, payload, deliveryId };
      } else if (taskOk || dispatchOk) {
        conflicts.push(`worker_done ${clip(message.id, 80) ?? ""} matches only the ${taskOk ? "Task" : "Dispatch"}; ignored`);
      } else ignored++;
    } else if (message.type === "question" || message.type === "escalation") {
      // Only a message provably attributed to the awaited Task/Dispatch may block; generic or foreign ones are drained.
      const dispatchOk = payload?.dispatchId === dispatchId, taskOk = payload?.taskId === taskId;
      const contradicts = (payload?.dispatchId !== undefined && !dispatchOk) || (payload?.taskId !== undefined && !taskOk);
      if (!(dispatchOk || taskOk) || contradicts) { ignored++; return; }
      const entry = { id: clip(message.id, 80), type: message.type, subject: clip(message.subject, 300), body: clip(message.body, 2000) };
      pending.push(entry); blocked ??= entry;
    } else ignored++;
  };

  const failure = (error: unknown) => {
    const code = error instanceof OrcaCallError ? error.code : "orca_unavailable";
    return { ...base, state: "unknown", awaited_terminal: false, awaited_completed: false, succeeded: false,
      error: { code, message: clip(error instanceof Error ? error.message : "Orca check failed", 500) },
      ...(ackPending ? { ack: { delivery_id: ackPending, status: "not_sent" } }
        : lastAcked ? { ack: ackProblem ? { delivery_id: lastAcked, status: "failed", error: ackProblem } : { delivery_id: lastAcked, status: "acknowledged" } } : {}),
      next_poll_after_seconds: nextPoll };
  };

  try {
    for (let batch = 0; batch < MAX_BATCHES && !matched; batch++) {
      const remaining = Math.max(0, deadline - now());
      const args = ["orchestration", "check", "--terminal", coordinatorHandle, "--types", WAIT_TYPES.join(",")];
      if (ackPending) args.push("--ack", ackPending);
      if (remaining > 0) args.push("--wait", "--timeout-ms", String(remaining));
      const sentAck = ackPending;
      const result = await call(args, remaining + config.orcaTimeoutMs + 10000);
      if (result.runId !== runId) throw new OrcaCallError("Orca check returned a different Run than the launch receipt", "run_mismatch");
      if (sentAck) {
        lastAcked = sentAck; ackPending = undefined;
        if (typeof result.acknowledged === "string" && result.acknowledged !== sentAck) {
          ackProblem = "Orca ACK receipt named a different delivery than the one acknowledged";
        }
      }
      const messages = messageList(result);
      if (result.deliveryId !== undefined && result.deliveryId !== null && (typeof result.deliveryId !== "string" || !result.deliveryId)) {
        throw new OrcaCallError("Orca check returned a malformed delivery id", "malformed_result");
      }
      const deliveryId = typeof result.deliveryId === "string" && result.deliveryId ? result.deliveryId : undefined;
      if (messages.length === 0) {
        if (result.timedOut === true || result.cancelled === true || remaining === 0 || !deliveryId) break;
        ackPending = deliveryId; continue;
      }
      if (!deliveryId) throw new OrcaCallError("Orca delivery has no delivery id; refusing to process unacknowledgeable batch", "missing_delivery_id");
      for (const raw of messages) consider(raw, deliveryId);
      ackPending = deliveryId; // acknowledged only after the whole batch was processed
      if (matched || blocked || now() >= deadline) break;
    }
  } catch (error) { return failure(error); }

  // Mailbox ACK for the final processed batch (Orca consumer protocol); never before processing.
  let ack: Record<string, unknown> | undefined;
  if (ackPending) {
    try {
      const receipt = await quick(["orchestration", "check", "--terminal", coordinatorHandle, "--ack", ackPending, "--peek"]);
      if (receipt.runId !== runId || receipt.acknowledged !== ackPending) {
        ack = { delivery_id: ackPending, status: "failed", error: "Orca ACK receipt did not confirm the exact delivery for this Run" };
      } else ack = { delivery_id: ackPending, status: "acknowledged" };
    } catch (error) {
      ack = { delivery_id: ackPending, status: "failed", error: clip(error instanceof Error ? error.message : "ack failed", 300) };
    }
  } else if (lastAcked) {
    ack = ackProblem ? { delivery_id: lastAcked, status: "failed", error: ackProblem } : { delivery_id: lastAcked, status: "acknowledged" };
  }

  // Read-only cross-check against the public Task / Dispatch surface.
  let worker: Record<string, unknown> | undefined;
  let launch: Record<string, any> = {};
  let taskStatus: string | undefined;
  let assignee: string | undefined;
  let waiting = false;
  let attention = false;
  let crossError: string | undefined;
  try {
    const shown = await quick(["orchestration", "worker-show", "--dispatch", dispatchId]);
    const projection = object(shown.projection), dispatch = object(shown.dispatch), w = object(shown.worker);
    if (projection.dispatchId !== undefined && projection.dispatchId !== dispatchId || dispatch.id !== undefined && dispatch.id !== dispatchId
      || dispatch.taskId !== undefined && dispatch.taskId !== taskId || dispatch.runId !== undefined && dispatch.runId !== runId) {
      throw new OrcaCallError("worker-show returned a different Run/Task/Dispatch than expected", "identity_mismatch");
    }
    launch = object(object(w.startOptions).launch);
    assignee = typeof w.agentTerminalHandle === "string" ? w.agentTerminalHandle : undefined;
    waiting = object(shown.observation).agentWait != null;
    attention = object(projection.attention).requiresAction === true;
    worker = { state: clip(w.state, 80), stage: clip(object(projection.stage).detail, 80), dispatch_status: clip(dispatch.status, 80),
      outcome: clip(projection.outcome, 80), liveness: clip(object(projection.liveness).verdict, 80),
      ...(waiting ? { waiting_for_human: true } : {}) };
    const listed = await quick(["orchestration", "task-list", "--run", runId]);
    const task = (Array.isArray(listed.tasks) ? listed.tasks : []).map(object).find((t) => t.id === taskId);
    if (task) {
      if (task.run_id !== undefined && task.run_id !== runId) throw new OrcaCallError("task-list returned a different Run", "identity_mismatch");
      taskStatus = clip(task.status, 40);
    }
  } catch (error) { crossError = clip(error instanceof Error ? error.message : "cross-check failed", 300); }

  // A prior poll may already have consumed and acked the worker_done. `check --all` is a
  // documented read-only history view (no read marking, no ack), so recover the exact message.
  // Task/Dispatch/pending state above is evidence only and never gates this recovery.
  if (!matched) {
    try {
      const history = await quick(["orchestration", "check", "--terminal", coordinatorHandle, "--all"]);
      if (history.runId === runId) {
        for (const raw of messageList(history).slice(0, HISTORY_MAX)) {
          if (object(raw).type === "worker_done") consider(raw, undefined);
        }
        if (matched) matched = { ...(matched as object), recovered: true } as typeof matched;
      }
    } catch { /* history is best-effort; absence keeps the non-authoritative unknown state */ }
  }

  const requested = object(launch.requested), effective = object(launch.effective);
  const launchInfo = {
    ...(requested.agent !== undefined ? { requested: { agent: clip(requested.agent, 80), model: clip(requested.model, 120), effort: clip(requested.effort, 40) } } : {}),
    ...(effective.agent !== undefined ? { effective: { agent: clip(effective.agent, 80), model: clip(effective.model, 120), effort: clip(effective.effort, 40) } } : {}),
  };
  const common = { ...base, ...launchInfo, ...(worker ? { worker } : {}), ...(ack ? { ack } : {}), ...(ignored ? { ignored_messages: ignored } : {}) };

  if (matched) {
    const outcome = matched.payload.outcome as "succeeded" | "failed";
    const expectedStatus = outcome === "succeeded" ? "completed" : "failed";
    const sender = typeof matched.message.from_handle === "string" ? matched.message.from_handle : undefined;
    if (assignee && sender && sender !== assignee) conflicts.push("worker_done sender does not match the Dispatch assignee terminal");
    if (taskStatus && taskStatus !== expectedStatus) conflicts.push(`Orca Task status is ${taskStatus}, expected ${expectedStatus} for outcome ${outcome}`);
    const workerOutcome = object(worker).outcome;
    if (typeof workerOutcome === "string" && workerOutcome !== outcome) conflicts.push(`Orca Dispatch outcome is ${workerOutcome}, expected ${outcome}`);
    const crossStatus = crossError ? "unavailable" : taskStatus === undefined ? "unavailable" : conflicts.length ? "mismatch" : "consistent";
    const files = Array.isArray(matched.payload.filesModified)
      ? matched.payload.filesModified.filter((f: unknown) => typeof f === "string").slice(0, LIST_MAX).map((f: string) => clip(f, 500)).filter(Boolean) : undefined;
    const reportPath = await safeReportPath(matched.payload.reportPath, options.workspace);
    return { ...common, state: outcome === "succeeded" ? "completed" : "failed", awaited_terminal: true,
      awaited_completed: outcome === "succeeded", succeeded: outcome === "succeeded", outcome,
      worker_done: { message_id: clip(matched.message.id, 80), ...(matched.deliveryId ? { delivery_id: matched.deliveryId } : {}), ...(matched.recovered ? { recovered_from_history: true } : {}), created_at: clip(matched.message.created_at, 40) },
      summary: clip(matched.message.body) ?? clip(matched.payload.summary),
      ...(files ? { filesModified: files } : {}),
      ...(reportPath ? { reportPath } : matched.payload.reportPath !== undefined ? { reportPath_rejected: true } : {}),
      cross_check: { status: crossStatus, ...(taskStatus ? { task_status: taskStatus } : {}), ...(crossError ? { error: crossError } : {}) },
      ...(conflicts.length ? { evidence_conflict: [...new Set(conflicts)] } : {}) };
  }

  const settled = taskStatus === "completed" || taskStatus === "failed";
  if (settled) conflicts.push(`Orca Task is ${taskStatus} but no matching worker_done was observed (it may have been consumed earlier); outcome is not authoritative`);
  const state = settled || conflicts.length ? "unknown" : blocked || waiting || attention ? "blocked" : "running";
  return { ...common, state, awaited_terminal: false, awaited_completed: false, succeeded: false,
    cross_check: { status: crossError ? "unavailable" : "pending", ...(taskStatus ? { task_status: taskStatus } : {}), ...(crossError ? { error: crossError } : {}) },
    ...(pending.length ? { pending_messages: pending.slice(0, 10) } : {}),
    ...(conflicts.length ? { evidence_conflict: [...new Set(conflicts)] } : {}),
    next_poll_after_seconds: nextPoll };
}
