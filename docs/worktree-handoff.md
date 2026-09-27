# Git worktree handoffs

`handoff_to_agent` and `handoff_to_codex` use the selected workspace as the
execution worktree. For a Git repository enrolled in AHR's global
`workspaces.json`, the tools identify the enrolled control root through Git's
common directory and authoritative worktree list. They do not infer a parent
directory or scan `.claude/worktrees`.

The main enrolled worktree keeps the existing
`.ai-bridge/current-plan.md` handoff. A linked worktree writes its plan and
`target.json` under the enrolled root:

```text
<enrolled-repository>/.ai-bridge/worktrees/<sha256-key>/
  current-plan.md
  target.json
```

The key is SHA-256 of the canonical Git common directory and canonical target
path. Metadata records the enrolled repository, exact target, and Git common
directory. The tool returns `control_root`, `target_root`, and `plan_ref` in
addition to existing output fields. Status, diff, execution log, and AHR run
state remain in the selected execution worktree. No agent is launched by the
handoff tool. Router is the trigger owner.

An unenrolled Git repository fails with an instruction to enroll its main
worktree. If the enrolled control root is outside CodexPro `allowedRoots`, the
handoff fails; it never adds an allowed root or registry entry automatically.
Removing a linked worktree makes its slot stale. Old worktree-local plans are
left unchanged and are not transferred or replayed. Multiple linked targets
can have independent pending plans under one enrolled repository.

Append keeps the existing routing preamble authoritative. Supplied agent, model,
or reasoning effort must match it; omitted fields inherit it. The appended
section contains only plan content. A rendered control plan is limited to
64 KiB of UTF-8 bytes. Handoff plans and linked target metadata are written
through same-directory temporary files and atomic renames, with metadata
published before a new linked plan.

Concurrent appends to one slot are serialized within a CodexPro server process.
Deployments must route writes for a slot through one server process; separate
CodexPro processes do not share this in-memory lock.
