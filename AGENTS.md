# AGENTS.md

This document provides repository-level guidance for coding agents (including Codex) working in CommandMate.

## Scope

- Applies to the entire repository.
- This file is the primary entry point for agent behavior in this repo.
- For detailed background and implementation history, refer to `README.md`, `docs/`, and `CLAUDE.md`.

## Project Context

- Project: CommandMate
- Stack: Next.js 14, TypeScript, Tailwind CSS, SQLite (`better-sqlite3`)
- Runtime: Node.js 20+
- Main areas:
  - `src/app`: App Router pages and API routes
  - `src/lib`: core business logic and utilities
  - `src/components`: UI components
  - `tests/unit`, `tests/integration`, `tests/e2e`: test suites

## Working Principles

1. Keep changes issue-focused and minimal.
2. Preserve existing architecture and naming patterns.
3. Prefer small, reviewable commits over large refactors.
4. Do not introduce unrelated cleanups in the same change.
5. If behavior changes, add or update tests in the same PR.

## Coding Rules

- Use strict TypeScript types; avoid `any` unless unavoidable.
- Reuse existing utilities in `src/lib` before adding new helpers.
- Keep API validation explicit and defensive.
- Follow existing React/Next.js patterns in the touched module.
- Keep comments short and meaningful; avoid obvious comments.

## Safety And Boundaries

- Do not perform destructive operations (`git reset --hard`, broad file deletion) unless explicitly requested.
- Do not overwrite user-authored files unexpectedly.
- Treat auth/security-related paths with extra care:
  - `src/lib/auth.ts`
  - `src/middleware.ts`
  - `src/lib/env-sanitizer.ts`
  - `src/lib/ip-restriction.ts`

## Validation Checklist

Before finishing, run relevant checks for changed scope:

```bash
# unit tests
npm run test:unit

# integration tests when API/DB behavior changes
npm run test:integration

# lint when editing TS/React broadly
npm run lint
```

For small fixes, run targeted tests first, then expand only if needed.

## Change Policy For Agent Docs

- Keep `AGENTS.md` concise and execution-oriented.
- Avoid duplicating large sections from `CLAUDE.md`; link or reference instead.
- If guidance conflicts are found:
  1. Prioritize explicit repository files and current code behavior.
  2. Update this file and related docs together in the same PR.

## PR Expectations

- Title format: `feat: ...`, `fix: ...`, `docs: ...`, etc.
- Include:
  - What changed
  - Why it changed
  - How it was validated
  - Any known risks or follow-up tasks
