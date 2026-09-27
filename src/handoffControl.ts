import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, isSubpath, type Workspace } from "./guard.js";

export interface HandoffControl {
  repository: Workspace;
  execution: Workspace;
  planRef: string | null;
  planPath: string;
  metadata: { version: 1; repositoryPath: string; worktreePath: string; gitCommonDir: string } | null;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function identity(root: string): Promise<{ common: string; entries: string[] }> {
  if (await fs.realpath(git(root, "rev-parse", "--show-toplevel")) !== root) {
    throw new CodexProError("Selected workspace must be a Git worktree root.");
  }
  const common = await fs.realpath(path.resolve(root,
    git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")));
  const entries = git(root, "worktree", "list", "--porcelain", "-z").split("\0")
    .filter(value => value.startsWith("worktree ")).map(value => value.slice(9));
  if (!entries.includes(root)) throw new CodexProError("Selected worktree is no longer linked to its Git repository.");
  return { common, entries };
}

export async function resolveHandoffControl(config: CodexProConfig, execution: Workspace): Promise<HandoffControl> {
  const local = { repository: execution, execution, planRef: null,
    planPath: `${config.contextDir}/current-plan.md`, metadata: null };
  try { git(execution.root, "rev-parse", "--show-toplevel"); }
  catch { return local; } // Existing generic handoffs also support non-Git directories.
  if (config.contextDir !== ".ai-bridge") {
    throw new CodexProError("AHR Git handoffs require CODEXPRO_CONTEXT_DIR=.ai-bridge.");
  }
  const selected = await identity(execution.root);
  const registryFile = path.join(process.env.AHR_CONFIG_HOME || path.join(os.homedir(), ".config/agent-handoff-runner"), "workspaces.json");
  let raw: string;
  try { raw = await fs.readFile(registryFile, "utf8"); }
  catch { throw new CodexProError("Git repository is not enrolled. Run ahr workspace add for its main worktree."); }
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new CodexProError("AHR workspace registry exceeds its size limit.");
  let document: unknown;
  try { document = JSON.parse(raw); }
  catch { throw new CodexProError("AHR workspace registry is malformed."); }
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      (document as Record<string, unknown>).version !== 1 ||
      !Array.isArray((document as Record<string, unknown>).workspaces)) {
    throw new CodexProError("AHR workspace registry is malformed.");
  }
  const matches: string[] = [];
  for (const entry of (document as { workspaces: unknown[] }).workspaces) {
    if (!entry || typeof entry !== "object" || typeof (entry as { path?: unknown }).path !== "string") continue;
    const candidate = (entry as { path: string }).path;
    try {
      if (candidate !== await fs.realpath(candidate) ||
          await fs.realpath(git(candidate, "rev-parse", "--show-toplevel")) !== candidate) continue;
      const other = await identity(candidate);
      if (other.common === selected.common && selected.entries.includes(candidate)) matches.push(candidate);
    } catch { /* An unavailable entry cannot authorize a handoff. */ }
  }
  if (matches.length !== 1) {
    throw new CodexProError(matches.length ? "Multiple enrolled roots identify this Git repository." :
      "Git repository is not enrolled. Run ahr workspace add for its main worktree.");
  }
  const repositoryPath = matches[0]!;
  if (!config.allowedRoots.some(root => isSubpath(repositoryPath, root))) {
    throw new CodexProError(`Enrolled repository control root is outside CodexPro allowed roots: ${repositoryPath}`);
  }
  if (repositoryPath === execution.root) return local;
  const key = createHash("sha256").update(JSON.stringify([selected.common, execution.root])).digest("hex");
  return {
    repository: { ...execution, root: repositoryPath }, execution, planRef: key,
    planPath: `${config.contextDir}/worktrees/${key}/current-plan.md`,
    metadata: { version: 1, repositoryPath, worktreePath: execution.root, gitCommonDir: selected.common }
  };
}
