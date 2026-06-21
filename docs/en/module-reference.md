[日本語版](../module-reference.md)

# Module Reference

This page is the English entry point for CommandMate's module reference.

> **Note on maintenance — please read first.**
> The detailed, per-module implementation notes (Issue numbers, function
> signatures, constants, security annotations, etc.) are maintained **only in
> the Japanese source**: [`docs/module-reference.md`](../module-reference.md).
>
> That document is an **append-only, living reference** that is updated with
> nearly every Issue. Keeping a fully translated English mirror in sync would
> immediately drift out of date and double the maintenance burden on every
> change, which is exactly why per-entry detail is deliberately kept in a
> single source of truth (the Japanese file). See Issue #929, which explicitly
> allows deprioritizing the full translation of this volume-heavy document as
> long as the reason is documented.
>
> **For the authoritative, up-to-date details, refer to the
> [Japanese module reference](../module-reference.md).** Identifiers in that
> document — file paths, function names, constants, and Issue numbers — are
> language-neutral, so the structure below maps directly onto it.

The sections below summarize **what each module group is responsible for** so
that English-speaking readers can navigate the codebase and locate the relevant
entry in the Japanese reference.

---

## Document Structure

The Japanese reference is organized into three sections:

1. **Core Feature Modules** (`## 主要機能モジュール`) — application and library
   modules under `src/`.
2. **CLI Modules** (`## CLIモジュール`) — the `commandmate` command-line
   interface under `src/cli/` (Issue #96, #136).
3. **Test Helpers** (`## テストヘルパー`) — shared test utilities under
   `tests/helpers/` (Issue #256).

---

## Core Feature Modules (overview by area)

CommandMate's business logic lives mainly under `src/lib/`, organized by
responsibility:

| Area | Path | Responsibility |
|------|------|----------------|
| **Security** | `src/lib/security/` | Token authentication, IP/CIDR restriction, path validation, and environment-variable sanitization. Companion config in `src/config/auth-config.ts` and the Edge-Runtime auth middleware in `src/middleware.ts`. |
| **Database** | `src/lib/db/` | SQLite (better-sqlite3) instance management, DB path resolution, and migrations. |
| **Detection** | `src/lib/detection/` | CLI-tool output pattern definitions, session status detection, and the two-pass prompt detector. |
| **tmux** | `src/lib/tmux/` | tmux session management built on `execFile` (no shell), plus the capture cache (TTL + singleflight). |
| **Session** | `src/lib/session/` | Per-CLI-tool session management (Claude, etc.), health checks, and worktree session-status helpers. |
| **Polling** | `src/lib/polling/` | Response polling / thinking detection, and the Auto-Yes manager (state, stop conditions, resolver). |
| **CLI tools** | `src/lib/cli-tools/` | Strategy-pattern abstraction over each supported agent CLI (Claude, Codex, Gemini, Vibe Local, OpenCode, GitHub Copilot), including type definitions and per-tool implementations. |
| **Git** | `src/lib/git/` | Git operations, worktree management, and repository cloning. |
| **Schedules / CMATE** | `src/lib/cmate-parser.ts`, `src/types/cmate.ts` | Parsing and validation of `CMATE.md` (schedules, etc.). |
| **Version / updates** | `src/lib/version-checker.ts`, `src/hooks/useUpdateCheck.ts` | GitHub release version checks and update-notification UI. |

UI lives under `src/components/` (`common/`, `home/`, `layout/`, `mobile/`,
`providers/`, `review/`, `sidebar/`, `worktree/`, `auth/`), with React hooks in
`src/hooks/`, contexts in `src/contexts/`, App Router routes and API endpoints
under `src/app/`, and shared constants under `src/config/`.

---

## CLI Modules (overview)

The `commandmate` CLI lives under `src/cli/`:

- **Entry point**: `src/cli/index.ts` (commander setup).
- **Commands** (`src/cli/commands/`): `init`, `start`, `stop`, `status`, `ls`,
  `send`, `wait`, `respond`, `capture`, `auto-yes`, `issue`, `docs`.
- **Utilities** (`src/cli/utils/`): preflight dependency checks, environment
  setup, daemon/PID management, port allocation, worktree detection, input
  validation, resource resolution, and a documentation reader.
- **Config** (`src/cli/config/`): dependency definitions, AI-integration
  messages, duration/CLI-tool-id constants.
- **Types** (`src/cli/types/`): shared CLI types (the `ExitCode` enum, option
  types, and API-response types).

See [docs/user-guide/cli-operations-guide.md](./user-guide/cli-operations-guide.md)
and [docs/user-guide/cli-setup-guide.md](./user-guide/cli-setup-guide.md) for
usage-level documentation.

---

## Test Helpers (overview)

Shared test utilities live under `tests/helpers/` — for example,
`tests/helpers/prompt-type-guards.ts` provides shared prompt type-guard
functions (`isMultipleChoicePrompt`, `isYesNoPrompt`) to keep tests DRY.

---

## Keeping this page accurate

When adding or changing modules, update the **Japanese**
[`docs/module-reference.md`](../module-reference.md) entry (the single source of
truth). This English page only needs updating when a whole **area or section**
is added or removed, not for individual per-module changes.
