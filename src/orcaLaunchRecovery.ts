import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { launchOrca, OrcaLaunchError, runOrcaProcess, type OrcaProcess } from "./executionBackend.js";
import type { CodexProConfig } from "./config.js";

type Input = Parameters<typeof launchOrca>[1] & { requestId?: string };
type Row = Record<string, any>;
const obj = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);

/** Only a small request-to-Orca identity journal; Orca's mutation receipts own lifecycle and idempotency.
 * An exclusive, never-stolen claim fences writers across processes/restarts. Inspection never starts workers.
 */
export async function launchOrcaRecoverable(
  config: Pick<CodexProConfig, "orcaExecutable" | "orcaTimeoutMs">, input: Input,
  process: OrcaProcess = runOrcaProcess, options: { journalDir?: string; recoveryAttempts?: number; recoveryPollMs?: number } = {}
): Promise<Row> {
  // Reject invalid requests before claiming a key or allocating any Orca resources.
  if (input.append || !input.plan.trim() || !["codex", "claude"].includes(input.agent ?? "")
    || (input.reasoningEffort !== undefined && !input.model)
    || (input.requestId !== undefined && !id(input.requestId))) {
    throw new OrcaLaunchError("Invalid Orca launch input", { backend: "orca", state: "not_started", retry_allowed: false });
  }
  const workspace = await fs.realpath(input.workspace);
  const fingerprint = hash(JSON.stringify([workspace, input.plan, input.agent, input.model ?? null,
    input.reasoningEffort ?? null, input.title ?? null]));
  const requestId = input.requestId ?? `launch-${fingerprint}`;
  const dir = options.journalDir ?? path.join(os.homedir(), ".local", "state", "codexpro", "launch-requests");
  const file = path.join(dir, `${hash(JSON.stringify([workspace, requestId]))}.json`);
  let row: Row = { version: 1, request_id: requestId, fingerprint, workspace,
    created_at: new Date().toISOString(), run_request_id: randomUUID(), worker_request_id: randomUUID(), stage: "claimed", worker_attempted: false };
  const unknown = (reason: string): OrcaLaunchError => new OrcaLaunchError(`Orca launch UNKNOWN: ${reason}`, {
    backend: "orca", state: "unknown", request_id: requestId, retry_allowed: false, recoverable: true,
    runId: row.runId, taskId: row.taskId, dispatchId: row.dispatchId, coordinator_handle: row.coordinator_handle,
    diagnostics: row.diagnostics,
    recovery: { action: "handoff_to_agent", request_id: requestId, guidance: "Repeat the identical handoff with this request_id to inspect; do not create a fresh request." }
  });
  const syncDirectory = async (directory: string): Promise<void> => {
    // Fail closed before allocation on filesystems/platforms that cannot provide this durability.
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  };
  // Atomic replace for checkpoints; only the original exclusive claimant writes.
  const save = async (): Promise<void> => {
    row.updated_at = new Date().toISOString();
    const temp = `${file}.${randomUUID()}.tmp`;
    const f = await fs.open(temp, "wx", 0o600);
    try { await f.writeFile(JSON.stringify(row)); await f.sync(); } finally { await f.close(); }
    await fs.rename(temp, file);
    await syncDirectory(dir);
  };
  const read = async (): Promise<Row> => {
    const output = obj(JSON.parse(await fs.readFile(file, "utf8")));
    if (output.version !== 1 || output.fingerprint !== fingerprint || output.request_id !== requestId || output.workspace !== workspace)
      throw unknown("request identity conflict or invalid journal");
    return output;
  };
  const query = async (args: string[]): Promise<Row> => {
    const out = await process(config.orcaExecutable, [...args, "--json"], workspace, config.orcaTimeoutMs + 10000);
    const envelope = obj(JSON.parse(out.stdout));
    if (out.exitCode !== 0 || envelope.ok !== true) throw unknown("authoritative query failed");
    return obj(envelope.result);
  };
  const lookup = async (key: string, method: string): Promise<Row> => {
    const result = await query(["orchestration", "request-show", "--request", key]);
    if (result.requestId !== key || !["completed", "pending", "absent"].includes(result.state)
      || (result.state !== "absent" && result.method !== method)) throw unknown("request receipt identity mismatch");
    return result;
  };
  const recoverOnce = async (): Promise<Row> => {
    try {
      row = await read();
      // Run creation may have landed before its stdout/checkpoint was lost.
      if (!id(row.runId)) {
        const run = await lookup(row.run_request_id, "orchestration.runCreate");
        const runId = obj(obj(run.receipt).run).id;
        if (id(runId)) row.runId = runId;
      }
      const request = await lookup(row.worker_request_id, "orchestration.workerStart");
      const receipt = obj(request.receipt);
      // pending worker-start checkpoints identify an accepted Dispatch without a completed receipt.
      const accepted = obj(receipt.accepted);
      const dispatchId = receipt.dispatchId ?? accepted.dispatchId ?? row.dispatchId;
      if (!id(dispatchId) || !id(row.runId) || !id(row.coordinator_handle)) throw unknown("no provable launch identity yet");
      if ((row.dispatchId && row.dispatchId !== dispatchId) || (receipt.runId && receipt.runId !== row.runId))
        throw unknown("conflicting dispatch receipt");
      const shown = await query(["orchestration", "worker-show", "--dispatch", dispatchId]);
      const dispatch = obj(shown.dispatch), worker = obj(shown.worker);
      const taskId = dispatch.taskId ?? dispatch.task_id;
      // Exact causal binding, not task title, terminal status or Git commit heuristics.
      if (dispatch.id !== dispatchId || dispatch.runId !== row.runId || !id(taskId)
        || worker.dispatchId !== dispatchId || worker.worktreeId !== row.worktree_id
        || (row.taskId && row.taskId !== taskId) || (receipt.taskId && receipt.taskId !== taskId))
        throw unknown("worker identity mismatch");
      const tasks = await query(["orchestration", "task-list", "--run", row.runId]);
      if (!Array.isArray(tasks.tasks) || !tasks.tasks.some((t: Row) => t.id === taskId && t.run_id === row.runId
        && t.created_by_terminal_handle === row.coordinator_handle)) throw unknown("coordinator/task binding mismatch");
      const launch = obj(obj(worker.startOptions).launch);
      for (const [key, value] of [["agent", input.agent], ["model", input.model], ["effort", input.reasoningEffort]]) {
        if (value !== undefined && (obj(launch.requested)[key!] !== value || obj(launch.effective)[key!] !== value))
          throw unknown("launch preferences mismatch");
      }
      return { backend: "orca", workspace, request_id: requestId, state: "tracked", launch_recovered: true,
        launch_state: worker.state ?? "unknown", runId: row.runId, taskId, dispatchId,
        coordinator_handle: row.coordinator_handle, worker_handle: worker.agentTerminalHandle,
        agent: obj(launch.effective).agent, model: obj(launch.effective).model,
        reasoning_effort: obj(launch.effective).effort, awaited_terminal: false, retry_allowed: false,
        completion_authority: "worker_done", wait_for_handoff: { orca_run_id: row.runId, orca_task_id: taskId,
          orca_dispatch_id: dispatchId, orca_coordinator_handle: row.coordinator_handle } };
    } catch (error) {
      if (error instanceof OrcaLaunchError) throw error;
      throw unknown("recovery unavailable or malformed");
    }
  };
  const recover = async (): Promise<Row> => {
    for (let attempt = 0; ; attempt++) {
      try { return await recoverOnce(); }
      catch (error) {
        if (attempt + 1 >= (options.recoveryAttempts ?? 3)) throw error;
        await new Promise(resolve => setTimeout(resolve, options.recoveryPollMs ?? 250));
      }
    }
  };
  try {
    const firstCreated = await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (firstCreated) {
      // Persist newly created ancestors as well as the leaf; a synced claim is useless if its directory disappears.
      const parent = path.dirname(path.resolve(firstCreated));
      for (let current = path.resolve(dir); ; current = path.dirname(current)) {
        await syncDirectory(current);
        if (current === parent) break;
      }
    }
    let claim;
    try { claim = await fs.open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return await recover();
    }
    try { await claim.writeFile(JSON.stringify(row)); await claim.sync(); } finally { await claim.close(); }
    await syncDirectory(dir);
    const tracked: OrcaProcess = async (binary, args, cwd, timeout) => {
      const command = args.slice(0, 2).join(" ");
      const mutation = ["terminal create", "orchestration run-create", "orchestration worker-start"].includes(command);
      if (mutation) {
        row.stage = command;
        if (command === "orchestration worker-start") row.worker_attempted = true;
        await save(); // Durable intent before the subprocess can create side effects.
      }
      const keyed = command === "orchestration run-create" ? row.run_request_id
        : command === "orchestration worker-start" ? row.worker_request_id : undefined;
      const startedAt = Date.now();
      let out;
      try { out = await process(binary, keyed ? [...args, "--retry-request", keyed] : args, cwd, timeout); }
      catch (error) {
        if (mutation) {
          row.diagnostics = { stage: command, elapsed_ms: Date.now() - startedAt, process_interrupted: true };
          await save();
        }
        throw error;
      }
      if (mutation) row.diagnostics = { stage: command, elapsed_ms: Date.now() - startedAt, exit_code: out.exitCode,
        stdout_bytes: Buffer.byteLength(out.stdout), stderr_bytes: Buffer.byteLength(out.stderr),
        stdout_sha256: hash(out.stdout), stderr_sha256: hash(out.stderr), receipt_parsed: false };
      let result: Row;
      try { result = obj(obj(JSON.parse(out.stdout)).result); }
      catch { if (mutation) await save(); return out; }
      if (mutation) row.diagnostics.receipt_parsed = true;
      if (command === "worktree show") row.worktree_id = obj(result.worktree).id;
      if (command === "terminal create") row.coordinator_handle = obj(result.terminal).handle;
      if (command === "orchestration run-create") row.runId = obj(result.run).id;
      if (command === "orchestration worker-start") {
        row.taskId = result.taskId; row.dispatchId = result.dispatchId;
      }
      if (mutation) await save();
      return out;
    };
    try {
      const receipt = await launchOrca(config, { ...input, workspace }, tracked);
      return { ...receipt, request_id: requestId, launch_recovered: false, awaited_terminal: false, retry_allowed: false };
    } catch (error) {
      if (row.worker_attempted) return await recover();
      // No worker-start invocation was issued by this claimant. No automatic reallocation.
      throw new OrcaLaunchError("Orca launch did not reach worker-start", {
        backend: "orca", state: "not_started", request_id: requestId, retry_allowed: true, stage: row.stage,
        coordinator_handle: row.coordinator_handle, runId: row.runId
      });
    }
  } catch (error) {
    if (error instanceof OrcaLaunchError) throw error;
    throw unknown("request journal unavailable");
  }
}
