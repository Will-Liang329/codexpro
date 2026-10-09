import type { CodexProConfig } from "./config.js";
import type { OrcaProcess } from "./executionBackend.js";
import { redactSensitiveText } from "./redact.js";

// ---------------------------------------------------------------------------
// Orca coordinator-terminal cleanup (supporting lifecycle work only).
//
// Orca binds the mailbox, consumer generation and fence to the Run, not to terminal liveness
// (see .ai-bridge/orca-coordinator-lifecycle-experiment.md), so a settled coordinator terminal can be
// closed without losing repeat wait_for_handoff (history recovery). The close is always:
//   - addressed to the exact Run `coordinator_handle` (`terminal close --terminal <handle> --tab`),
//     never `--worktree ... --all`, never a worker terminal;
//   - best-effort: nothing here throws and no outcome can change a completion verdict.
// ---------------------------------------------------------------------------

export type OrcaCleanupConfig = Pick<CodexProConfig, "orcaExecutable" | "orcaTimeoutMs">;

export class OrcaCliError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

// Same shape the MCP layer accepts for Orca identities; a leading "-" can never be parsed as an option.
export const ORCA_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function asObject(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function cleanText(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const text = redactSensitiveText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/** Runs one public Orca CLI command with `--json` and returns `result`; throws OrcaCliError otherwise. */
export async function orcaJson(config: OrcaCleanupConfig, process: OrcaProcess, args: string[], cwd: string,
  timeoutMs: number): Promise<Record<string, any>> {
  const output = await process(config.orcaExecutable, [...args, "--json"], cwd, timeoutMs);
  let json: Record<string, any>;
  try { json = asObject(JSON.parse(output.stdout)); }
  catch { throw new OrcaCliError(`Orca ${args[0]} ${args[1]} returned malformed JSON (exit ${output.exitCode})`, "malformed_json"); }
  if (output.exitCode !== 0 || json.ok !== true) {
    const error = asObject(json.error);
    throw new OrcaCliError(`Orca ${args[0]} ${args[1]} failed (exit ${output.exitCode})${cleanText(error.message) ? `: ${cleanText(error.message)}` : ""}`,
      cleanText(error.code, 80) ?? "orca_error");
  }
  return asObject(json.result);
}

export interface CoordinatorCloseInput {
  runId: string;
  coordinatorHandle: string;
  /** Known worker terminal handles; the coordinator handle must never be one of them. */
  workerHandles?: readonly string[];
}

export interface CoordinatorCleanupResult {
  /** closed: Orca closed the exact coordinator; already_gone: handle was already stale/closed;
   *  skipped: a safety precondition failed and nothing was sent; failed: Orca refused or was unavailable. */
  status: "closed" | "already_gone" | "skipped" | "failed";
  coordinator_handle: string;
  reason?: string;
  code?: string;
  message?: string;
}

/**
 * Closes exactly one coordinator terminal. Never throws. Verifies through Orca's public `run-show` that the
 * handle is still the Run's `coordinator_handle` before any close is sent.
 */
export async function closeCoordinatorTerminal(config: OrcaCleanupConfig, input: CoordinatorCloseInput,
  process: OrcaProcess, cwd = "/"): Promise<CoordinatorCleanupResult> {
  const handle = input.coordinatorHandle;
  const result = (status: CoordinatorCleanupResult["status"], extra: Partial<CoordinatorCleanupResult> = {}): CoordinatorCleanupResult =>
    ({ status, coordinator_handle: handle, ...extra });
  if (!ORCA_HANDLE.test(handle ?? "") || !ORCA_HANDLE.test(input.runId ?? "")) return result("skipped", { reason: "invalid_identity" });
  if (input.workerHandles?.includes(handle)) return result("skipped", { reason: "handle_is_worker_terminal" });
  const timeout = Math.min(config.orcaTimeoutMs, 15000) + 10000;
  try {
    const run = asObject((await orcaJson(config, process, ["orchestration", "run-show", "--id", input.runId], cwd, timeout)).run);
    if (run.id !== input.runId || run.coordinator_handle !== handle) return result("skipped", { reason: "run_binding_mismatch" });
  } catch (error) {
    return result("skipped", { reason: "run_unverifiable", code: error instanceof OrcaCliError ? error.code : "orca_unavailable" });
  }
  try {
    await orcaJson(config, process, ["terminal", "close", "--terminal", handle, "--tab"], cwd, timeout);
    return result("closed");
  } catch (error) {
    const code = error instanceof OrcaCliError ? error.code : "orca_unavailable";
    // A stale handle means the terminal is already gone: the desired end state, not a failure.
    if (code === "terminal_handle_stale") return result("already_gone", { code });
    return result("failed", { code, message: cleanText(error instanceof Error ? error.message : "close failed") });
  }
}
