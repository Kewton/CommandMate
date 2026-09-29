# OpenCode V2 headless runs: which directory is the project (Issue #2979)

`opencode2 run --standalone --format json --auto -- "<create file X>"` on
OpenCode V2 2.0.18, 2026-09-29. A throwaway git repository `main`, a
`git worktree` of it `wt`, and a second plain repository `other`, each with the
same `opencode.json` (a local Ollama provider, `ollama/qwen3:8b`). `HOME` and
every `XDG_*` pointed at a temporary directory, `env -i` otherwise, stdin
`/dev/null`. "cwd" is the process's working directory; "PWD" is the
environment variable.

| cwd | PWD | exit | file written in |
|-----|-----|------|-----------------|
| main | main | 0 | main |
| wt | wt | 0 | wt |
| wt | main | 0 | **main** |
| wt | (unset) | 0 | wt |
| main | wt | 0 | **wt** |
| other | main | 0 | **main** |
| main | other | 0 | **other** |
| wt | other | 0 | **other** |

`opencode.json` read (edit/bash `ask` placed in `wt` only, no `--auto`):

| cwd | PWD | exit | result |
|-----|-----|------|--------|
| wt | main | 0 | written in main; the `ask` rule never applied |
| wt | wt | 1 | `permission requested: edit (…); auto-rejecting` |

So the project is `PWD` when it is set, and the cwd only when it is not, for a
plain repository and a worktree alike (the git common dir plays no part).
`execFile`'s `cwd` does not rewrite `PWD`, so the scheduled child inherited the
server's. `opencode2 run --help` has no `--dir` (v1 has one).
