#!/usr/bin/env node
// One-time backlog cleanup of historical, settled Orca coordinator terminals.
// Dry-run by default (read-only Orca CLI calls). Pass --apply to close the proven-safe candidates,
// one exact `terminal close --terminal <handle> --tab` each. Never uses `--worktree ... --all`.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COORDINATOR_TITLES, runBacklogCleanup } from '../dist/orcaCoordinatorBacklog.js';

const USAGE = `Usage: node scripts/orca-coordinator-cleanup.mjs [--apply] [--min-age-minutes 60] [--max-close 50]
       [--max-runs 1000] [--title <exact terminal title>]... [--json] [--orca-binary orca]

Default is a read-only dry-run. --apply closes only handles proven safe (see docs/orca-completion-bridge.md).
--apply refuses (exit 3, nothing closed) unless the Run, worker and terminal inventories are provably complete;
hitting --max-runs with Runs remaining counts as incomplete. --max-close only caps the batch size.
Titles default to plain shells: ${DEFAULT_COORDINATOR_TITLES.join(', ')}.`;

export function parseArgs(argv) {
  const options = { apply: false, json: false, minAgeMinutes: 60, maxClose: 50, maxRuns: 1000, titles: [], binary: process.env.CODEXPRO_ORCA_BINARY || 'orca' };
  const number = (name, value, min) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`); return argv[++i]; };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--min-age-minutes') options.minAgeMinutes = number(arg, next(), 1);
    else if (arg === '--max-close') options.maxClose = number(arg, next(), 1);
    else if (arg === '--max-runs') options.maxRuns = number(arg, next(), 1);
    else if (arg === '--title') options.titles.push(next());
    else if (arg === '--orca-binary') options.binary = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// Same isolation as launchd-run CodexPro: Orca rejects consumer calls attested as a different terminal
// (consumer_fenced), so the Orca terminal attestation variables are removed from the child environment only.
function cleanEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (!key.startsWith('ORCA_') && key !== 'TERM_PROGRAM' && key !== 'TERM_PROGRAM_VERSION') out[key] = value;
  return out;
}
const cleanProcess = (binary, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  execFile(binary, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: cleanEnv(process.env) },
    (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(new Error(`Orca process unavailable or interrupted (${error.killed ? 'timeout_or_signal' : error.code ?? 'unknown'})`));
      else resolve({ exitCode: error?.code ?? 0, stdout, stderr });
    });
});

function render(report) {
  const lines = [`Orca coordinator backlog cleanup (${report.mode})`,
    `Runs scanned: ${report.scanned_runs}; coordinator handles: ${report.coordinator_handles}; already gone: ${report.already_gone.length}`,
    `Candidates (proven safe): ${report.candidates.length}; excluded: ${report.excluded.length}`];
  if (!report.inventory_complete) lines.push(`  INVENTORY INCOMPLETE (${report.inventory_gaps.join(', ')}): candidates below are NOT proven; --apply will refuse and close nothing.`);
  for (const c of report.candidates) lines.push(`  CANDIDATE ${c.coordinator_handle} runs=${c.run_ids.join(',')} title=${c.title ?? '-'}`);
  const tally = {};
  for (const e of report.excluded) for (const r of e.reasons) tally[r.split(':')[0]] = (tally[r.split(':')[0]] ?? 0) + 1;
  for (const [reason, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) lines.push(`  excluded x${n}: ${reason}`);
  for (const r of report.results ?? []) lines.push(`  ${r.status.toUpperCase()} ${r.coordinator_handle}${r.reason ? ` (${r.reason})` : ''}${r.code ? ` [${r.code}]` : ''}`);
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  if (report.mode === 'dry-run') lines.push('Dry-run only: nothing was closed. Re-run with --apply to close the candidates above.');
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return 0; }
  const callerHandle = process.env.ORCA_TERMINAL_HANDLE || undefined;
  const config = { orcaExecutable: options.binary, orcaTimeoutMs: Number(process.env.CODEXPRO_ORCA_TIMEOUT_MS) || 60000 };
  const report = await runBacklogCleanup(config, {
    apply: options.apply, minAgeMs: options.minAgeMinutes * 60_000, maxClose: options.maxClose, maxRuns: options.maxRuns,
    titles: options.titles.length ? options.titles : DEFAULT_COORDINATOR_TITLES, callerHandle,
  }, cleanProcess);
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
  if (report.mode === 'apply' && !report.inventory_complete) return 3;
  return report.results?.some((r) => r.status === 'failed') ? 2 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`orca-coordinator-cleanup: ${error.message}`); console.error(USAGE); process.exitCode = 1; });
}
