# OpenCode V2 headless runs (Issue #2974)

stdout captured from `opencode2 run --standalone --format json …` on
OpenCode V2 2.0.18 (`opencode v2.0.18`), 2026-09-29, in a throwaway git
repository with `HOME` and every `XDG_*` pointed at a temporary directory.
The provider was a local Ollama declared in the repository's `opencode.json`
(`ollama/qwen3.5:9b`, `ollama/qwen3:8b`). stdin was `/dev/null`.

| file | flags / config | exit | stderr |
|------|----------------|------|--------|
| `run-text.ndjson` | (none) | 0 | empty |
| `run-tool-use.ndjson` | `-m ollama/qwen3:8b --title t-2974` | 0 | empty |
| `run-ask-rejected.ndjson` | `permission: { edit: ask, … }`, no `--auto` | 1 | `run-ask-rejected.stderr.txt` |
| `run-agent-not-found.ndjson` | `--agent nosuchagent` | 1 | empty |
| `run-model-unavailable.ndjson` | `-m ollama/nonexistent-model` | 1 | empty |

Notes:

- The stream is v1's shape (`step_start` / `tool_use` / `step_finish` / `text`,
  every part carrying `messageID`), so `extractOpencodeFinalText` reads it.
- The `error` frame is not v1's: `error: { type, message }` instead of
  `error: { name, data: { message } }`.
- With the same `ask` config and `--auto`, the write was approved and the run
  exited 0.
