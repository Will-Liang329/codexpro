import type { OrcaProcess } from "./executionBackend.js";
import {
  asObject, cleanText, closeCoordinatorTerminal, ORCA_HANDLE, orcaJson, OrcaCliError,
  type CoordinatorCleanupResult, type OrcaCleanupConfig,
} from "./orcaCoordinatorCleanup.js";

// ---------------------------------------------------------------------------
// One-time backlog cleanup of historical, settled coordinator terminals.
//
// Conservative by construction: a coordinator handle is a candidate only when every proof below holds
// for EVERY Run it coordinates; any unknown, unreadable or ambiguous evidence excludes it. Dry-run is
// the default and performs only read-only Orca CLI calls. Apply mode closes exact handles only, one
// `terminal close --terminal <handle> --tab` each, via the same guarded helper as the live path.
// ---------------------------------------------------------------------------

export interface BacklogOptions {
  apply: boolean;
  /** A Run, and the coordinator terminal's last output, must be at least this old. */
  minAgeMs: number;
  /** Batch-size cap on closes in one apply invocation. Not an inventory-completeness condition. */
  maxClose: number;
  /** Hard cap on Runs scanned. Reaching it with Runs remaining makes the inventory incomplete (apply is refused). */
  maxRuns: number;
  /** Terminal titles considered plain coordinator shells. Anything else (agent TUIs, custom titles) is excluded. */
  titles: readonly string[];
  /** The invoking terminal; never touched even if it coordinates a settled Run. */
  callerHandle?: string;
  /**
   * Operator-only, one-time historical policy: accept a matching `worker_done` that is still unread as sufficient
   * evidence. Waives ONLY the `worker_done_unread` exclusion; every other proof stays mandatory. Default false.
   */
  allowUnreadWorkerDone?: boolean;
  now?: () => number;
  cwd?: string;
}

export const DEFAULT_COORDINATOR_TITLES = ["CodexPro coordinator", "zsh", "bash", "sh", "fish"] as const;

export interface BacklogCandidate {
  coordinator_handle: string; run_ids: string[]; title: string | null; last_output_at: number | null;
  /** True when the explicit unread waiver was what admitted this candidate (a matching worker_done had read=0). */
  unread_worker_done_waived?: boolean;
}
export interface BacklogExclusion { coordinator_handle: string; run_ids: string[]; reasons: string[] }
export interface BacklogReport {
  mode: "dry-run" | "apply";
  /** Whether the operator-only unread `worker_done` waiver was supplied for this scan. */
  allow_unread_worker_done: boolean;
  /** True only when Run, worker and terminal inventories were each read to a proven end. Apply requires it. */
  inventory_complete: boolean;
  /** Why the inventory is incomplete, as `<inventory>:<reason>`; empty when complete. */
  inventory_gaps: string[];
  scanned_runs: number;
  coordinator_handles: number;
  candidates: BacklogCandidate[];
  excluded: BacklogExclusion[];
  /** Handles with no live terminal (already closed/exited); informational, never an action. */
  already_gone: string[];
  /** Apply mode only: the exact-handle close outcomes. */
  results?: CoordinatorCleanupResult[];
  warnings: string[];
}

const SETTLED = new Set(["completed", "failed"]);
const PAGE = 100;
const MAX_PAGES = 1000;

interface Page<T> { rows: T[]; next?: string; /** Set when the page itself cannot prove whether more rows exist. */ unproven?: string }
interface Inventory<T> { rows: T[]; complete: boolean; gap?: string }

/**
 * Reads pages until the source proves it has no more rows. Completeness is explicit: any exit other than a
 * proven end (row cap, page limit, empty page with a cursor, repeated cursor, ambiguous page) is `complete: false`.
 */
async function paged<T>(read: (cursor?: string) => Promise<Page<T>>, max: number): Promise<Inventory<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await read(cursor);
    if (batch.unproven) return { rows, complete: false, gap: batch.unproven };
    rows.push(...batch.rows);
    if (rows.length > max) return { rows: rows.slice(0, max), complete: false, gap: "row_cap_reached" };
    if (!batch.next) return { rows, complete: true };
    if (rows.length >= max) return { rows, complete: false, gap: "row_cap_reached" };
    if (batch.rows.length === 0) return { rows, complete: false, gap: "empty_page_with_cursor" };
    if (seen.has(batch.next)) return { rows, complete: false, gap: "cursor_not_advancing" };
    seen.add(batch.next);
    cursor = batch.next;
  }
  return { rows, complete: false, gap: "page_limit_reached" };
}

/** Proof that one Run is fully settled; returns the reasons it is NOT provably safe (empty = proven). */
async function proveRunSettled(config: OrcaCleanupConfig, process: OrcaProcess, cwd: string, timeout: number,
  run: Record<string, any>, handle: string, workers: Record<string, any>[], allowUnread: boolean, waived: { unread: boolean }): Promise<string[]> {
  const runId = run.id as string;
  const reasons: string[] = [];
  if (run.legacy === 1 || run.legacy === true) return ["legacy_run"];

  let tasks: Record<string, any>[] = [];
  try {
    const listed = await orcaJson(config, process, ["orchestration", "task-list", "--run", runId], cwd, timeout);
    if (!Array.isArray(listed.tasks)) throw new OrcaCliError("tasks missing", "malformed_result");
    tasks = listed.tasks.map(asObject);
  } catch { return ["tasks_unavailable"]; }
  if (tasks.length === 0) return ["no_tasks"];
  for (const task of tasks) {
    if (task.run_id !== undefined && task.run_id !== runId) return ["task_run_mismatch"];
    if (typeof task.id !== "string" || !SETTLED.has(task.status)) reasons.push(`task_not_settled:${cleanText(task.status, 40) ?? "unknown"}`);
  }
  if (workers.length === 0) reasons.push("no_dispatch_evidence");
  const taskIds = new Set(tasks.map((t) => t.id));
  const dispatched = new Set<string>();
  const verdicts = new Map<string, "succeeded" | "failed">();
  for (const w of workers) {
    const outcome = asObject(w.projection).outcome;
    if (!taskIds.has(w.taskId)) { reasons.push("dispatch_task_mismatch"); continue; }
    dispatched.add(w.taskId);
    if (!SETTLED.has(w.dispatchStatus)) reasons.push(`dispatch_not_settled:${cleanText(w.dispatchStatus, 40) ?? "unknown"}`);
    else if (outcome !== (w.dispatchStatus === "completed" ? "succeeded" : "failed")) reasons.push("dispatch_outcome_unproven");
    else if (typeof w.dispatchId === "string") verdicts.set(w.dispatchId, outcome);
    if (w.terminalState === "release_pending" || w.terminalState === "release_unknown") reasons.push("worker_release_unsettled");
  }
  for (const id of taskIds) if (!dispatched.has(id)) { reasons.push("task_without_dispatch"); break; }
  if (reasons.length) return [...new Set(reasons)];

  // Authoritative completion: a read, matching worker_done per dispatch and no question/escalation anywhere.
  let rows: Record<string, any>[];
  try {
    const history = await orcaJson(config, process, ["orchestration", "check", "--terminal", handle, "--all"], cwd, timeout);
    if (history.runId !== runId) return ["history_run_mismatch"];
    if (!Array.isArray(history.messages) || !history.messages.every((m: unknown) => {
      const row = asObject(m); return typeof row.id === "string" && row.id !== "" && typeof row.type === "string" && row.type !== "";
    })) return ["history_malformed"];
    rows = history.messages.map(asObject);
  } catch (error) { return [`history_unavailable:${error instanceof OrcaCliError ? error.code : "orca_unavailable"}`]; }

  if (rows.some((m) => m.type === "question" || m.type === "escalation")) return ["question_or_escalation_present"];
  for (const w of workers) {
    const matching = rows.filter((m) => {
      if (m.type !== "worker_done") return false;
      let payload: Record<string, any> = {};
      try { payload = typeof m.payload === "string" ? asObject(JSON.parse(m.payload)) : asObject(m.payload); } catch { return false; }
      return payload.taskId === w.taskId && payload.dispatchId === w.dispatchId && (payload.outcome === "succeeded" || payload.outcome === "failed");
    });
    if (matching.length === 0) { reasons.push("worker_done_missing"); continue; }
    for (const m of matching) {
      const payload = asObject(typeof m.payload === "string" ? JSON.parse(m.payload) : m.payload);
      if (payload.outcome !== verdicts.get(w.dispatchId)) reasons.push("worker_done_outcome_mismatch");
      if (m.read !== 1 && m.read !== true) { if (allowUnread) waived.unread = true; else reasons.push("worker_done_unread"); }
      if (typeof m.from_handle === "string" && typeof w.agentTerminalHandle === "string" && m.from_handle !== w.agentTerminalHandle) reasons.push("worker_done_sender_mismatch");
    }
  }
  return [...new Set(reasons)];
}

export async function runBacklogCleanup(config: OrcaCleanupConfig, options: BacklogOptions, process: OrcaProcess): Promise<BacklogReport> {
  const now = options.now ?? Date.now;
  const cwd = options.cwd ?? "/";
  const timeout = Math.min(config.orcaTimeoutMs, 30000) + 10000;
  const warnings: string[] = [];
  const read = (args: string[]) => orcaJson(config, process, args, cwd, timeout);

  // Inventory. Any read failure aborts the scan. A read that succeeds but cannot prove it reached the end of
  // its source marks the inventory incomplete: dry-run reports it, apply refuses (no terminal is closed).
  const gaps: string[] = [];
  const gap = (inventory: string, reason: string | undefined, message: string) => {
    if (reason === undefined) return;
    gaps.push(`${inventory}:${reason}`);
    warnings.push(message);
  };

  const runInventory = await paged(async (cursor) => {
    const result = await read(["orchestration", "run-list", "--limit", String(PAGE), ...(cursor ? ["--cursor", cursor] : [])]);
    if (!Array.isArray(result.runs)) throw new OrcaCliError("Orca run-list returned a malformed result", "malformed_result");
    const rows = result.runs.map(asObject);
    if (result.nextCursor === undefined || result.nextCursor === null) return { rows };
    if (typeof result.nextCursor === "string" && result.nextCursor !== "") return { rows, next: result.nextCursor };
    return { rows, unproven: "malformed_cursor" };
  }, options.maxRuns);
  const runs = runInventory.rows;
  gap("runs", runInventory.gap, runInventory.gap === "row_cap_reached"
    ? `run scan stopped at --max-runs=${options.maxRuns} with Runs remaining; older Runs were not evaluated, so the Run inventory is incomplete`
    : `Run inventory incomplete (${runInventory.gap}); older Runs may not have been evaluated`);

  const workerInventory = await paged(async (cursor) => {
    const result = await read(["orchestration", "worker-list", "--limit", String(PAGE), ...(cursor ? ["--cursor", cursor] : [])]);
    if (!Array.isArray(result.workers)) throw new OrcaCliError("Orca worker-list returned a malformed result", "malformed_result");
    const rows = result.workers.map(asObject);
    const page = asObject(result.page);
    if (page.hasMore === false) return { rows };
    if (page.hasMore === true && typeof page.nextCursor === "string" && page.nextCursor !== "") return { rows, next: page.nextCursor };
    return { rows, unproven: page.hasMore === true ? "has_more_without_cursor" : "page_end_unproven" };
  }, Number.MAX_SAFE_INTEGER);
  const workers = workerInventory.rows;
  gap("workers", workerInventory.gap, `worker inventory incomplete (${workerInventory.gap}); worker terminals and Dispatch evidence may be missing`);
  const workerHandles = new Set<string>();
  const workersByRun = new Map<string, Record<string, any>[]>();
  for (const w of workers) {
    if (typeof w.agentTerminalHandle === "string") workerHandles.add(w.agentTerminalHandle);
    if (typeof w.runId === "string") workersByRun.set(w.runId, [...(workersByRun.get(w.runId) ?? []), w]);
  }

  const listing = await read(["terminal", "list", "--limit", "5000"]);
  if (!Array.isArray(listing.terminals)) throw new OrcaCliError("Orca terminal list returned a malformed result", "malformed_result");
  const terminals = new Map<string, Record<string, any>>();
  for (const t of listing.terminals.map(asObject)) if (typeof t.handle === "string") terminals.set(t.handle, t);
  const terminalGap = listing.truncated === true ? "truncated"
    : listing.truncated !== false ? "truncation_unproven"
      : typeof listing.totalCount === "number" && listing.totalCount > listing.terminals.length ? "total_exceeds_listed" : undefined;
  gap("terminals", terminalGap, `terminal list incomplete (${terminalGap}); handles missing from it cannot be called already gone`);
  const truncated = terminalGap !== undefined;

  // Group Runs by coordinator handle: a handle shared by several Runs is evaluated against all of them.
  const groups = new Map<string, Record<string, any>[]>();
  let invalidRuns = 0;
  for (const run of runs) {
    if (typeof run.id !== "string" || typeof run.coordinator_handle !== "string" || !ORCA_HANDLE.test(run.coordinator_handle)) { invalidRuns++; continue; }
    groups.set(run.coordinator_handle, [...(groups.get(run.coordinator_handle) ?? []), run]);
  }
  if (invalidRuns) warnings.push(`${invalidRuns} Run(s) without a usable coordinator_handle were ignored`);

  const candidates: BacklogCandidate[] = [];
  const excluded: BacklogExclusion[] = [];
  const alreadyGone: string[] = [];
  for (const [handle, group] of groups) {
    const runIds = group.map((r) => r.id as string);
    const terminal = terminals.get(handle);
    const reasons: string[] = [];
    if (handle === options.callerHandle) reasons.push("caller_terminal");
    if (workerHandles.has(handle)) reasons.push("worker_terminal");
    if (!terminal || terminal.orphaned === true || terminal.connected === false) {
      if (reasons.length === 0) { if (truncated) reasons.push("terminal_listing_truncated"); else { alreadyGone.push(handle); continue; } }
    } else {
      const title = typeof terminal.title === "string" ? terminal.title : null;
      if (title === null || !options.titles.includes(title)) reasons.push(`title_not_coordinator_shell:${cleanText(title ?? "(none)", 60)}`);
      const idle = typeof terminal.lastOutputAt === "number" ? now() - terminal.lastOutputAt : Infinity;
      if (idle < options.minAgeMs) reasons.push("recent_terminal_output");
    }
    for (const run of group) {
      const updated = Date.parse(String(run.updated_at ?? "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(run.updated_at)) ? "" : "Z"));
      if (!Number.isFinite(updated)) reasons.push("run_age_unknown");
      else if (now() - updated < options.minAgeMs) reasons.push("recent_run");
    }
    // The expensive per-Run proofs (task/history reads) only run for handles that already pass the cheap gates.
    const waived = { unread: false };
    if (reasons.length === 0) {
      for (const run of group) reasons.push(...await proveRunSettled(config, process, cwd, timeout, run, handle,
        workersByRun.get(run.id as string) ?? [], options.allowUnreadWorkerDone === true, waived));
    }
    if (reasons.length) { excluded.push({ coordinator_handle: handle, run_ids: runIds, reasons: [...new Set(reasons)] }); continue; }
    candidates.push({ coordinator_handle: handle, run_ids: runIds, title: typeof terminal?.title === "string" ? terminal.title : null,
      last_output_at: typeof terminal?.lastOutputAt === "number" ? terminal.lastOutputAt : null,
      ...(waived.unread ? { unread_worker_done_waived: true } : {}) });
  }

  const report: BacklogReport = { mode: options.apply ? "apply" : "dry-run", allow_unread_worker_done: options.allowUnreadWorkerDone === true, inventory_complete: gaps.length === 0, inventory_gaps: gaps, scanned_runs: runs.length, coordinator_handles: groups.size,
    candidates, excluded, already_gone: alreadyGone, warnings };
  if (!options.apply) return report;
  if (gaps.length) { warnings.push(`apply refused: incomplete inventory (${gaps.join(", ")}); nothing was closed`); report.results = []; return report; }

  report.results = [];
  for (const candidate of candidates) {
    if (report.results.length >= options.maxClose) { warnings.push(`apply stopped at --max-close=${options.maxClose}; re-run to continue`); break; }
    report.results.push(await closeCoordinatorTerminal(config,
      { runId: candidate.run_ids[0], coordinatorHandle: candidate.coordinator_handle, workerHandles: [...workerHandles] }, process, cwd));
  }
  return report;
}
