import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { CodexProConfig } from "./config.js";

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
