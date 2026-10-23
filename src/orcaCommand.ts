import path from "node:path";

// Windows cannot execute a Node shebang. Explicit .mjs adapters use the current
// Node executable on every platform; native Orca executables stay unchanged.
export function orcaCommand(binary: string, args: string[], cwd: string): [string, string[]] {
  return path.extname(binary).toLowerCase() === ".mjs"
    ? [process.execPath, [path.resolve(cwd, binary), ...args]]
    : [binary, args];
}
