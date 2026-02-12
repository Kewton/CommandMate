[日本語版](../../user-guide/commands-guide.md)

# Commands Guide

A detailed guide to the slash commands available in CommandMate.

---

## Command List

| Command | Description | Priority |
|---------|-------------|----------|
| `/work-plan` | Issue-based work plan creation | High |
| `/create-pr` | Automatic PR creation | High |
| `/progress-report` | Progress report generation | High |
| `/tdd-impl` | TDD implementation | High |

---

## /work-plan

### Overview

A command that creates a detailed work plan on a per-issue basis and formulates implementation task details.

### Usage

```
/work-plan [Issue number or summary]
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| Issue number | Optional | Target GitHub Issue number |

### Output

1. **Issue summary** - Title, size, priority
2. **Task breakdown** - Implementation, test, and documentation tasks
3. **Dependency diagram** - Mermaid-format dependencies
4. **Quality check items** - Required checks list
5. **Deliverables checklist** - Completion criteria

### Output Example

```markdown
## Issue: Add Dark Mode
**Issue number**: #123
**Size**: M
**Priority**: High

### Task Breakdown

#### Implementation Tasks (Phase 1)
- [ ] **Task 1.1**: Theme type definitions
  - Deliverable: `src/types/theme.ts`
```

### Output Location

`dev-reports/issue/{issue_number}/work-plan.md`

### Best Practices

- Always run before starting an Issue
- Review the plan with stakeholders
- Re-run when the plan changes

---

## /create-pr

### Overview

A command that automates Pull Request creation. It auto-generates the title and description from Issue information.

### Usage

```
/create-pr [options]
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| Issue number | Optional | Explicitly specify (auto-detected from branch name if omitted) |
| --draft | Optional | Create as a Draft PR |

### Preconditions

All of the following must be satisfied:

- No uncommitted changes
- All CI checks pass
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm run test:unit`
  - `npm run build`

### Output

1. **PR title** - Conventional Commits format
2. **PR description** - Changes, test results, checklist
3. **Labels** - Inherited from Issue

### Output Example

```markdown
## Summary

Added dark mode feature.

Closes #123

## Changes

### Added
- Theme toggle component
- Dark mode styles

## Test Results

- Unit Tests: 15/15 passed
- ESLint: 0 errors
- TypeScript: 0 errors
```

### Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| Issue number detection failed | Branch name doesn't follow convention | Explicitly specify the Issue number |
| CI check failed | lint/test/build error | Fix the error and re-run |
| Uncommitted changes | Changes not staged | `git add` & `git commit` |

---

## /progress-report

### Overview

A command that aggregates results from each development phase and creates a progress report.

### Usage

```
/progress-report [Issue number]
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| Issue number | Optional | Target GitHub Issue number |

### Output

1. **Summary** - Issue number, status
2. **Phase-by-phase results** - TDD, test results
3. **Quality metrics** - Coverage, static analysis errors
4. **Blockers** - Issues, problems
5. **Next steps** - Recommended actions

### Output Example

```markdown
# Progress Report - Issue #123

## Summary
**Issue**: #123 - Add Dark Mode
**Status**: Success

## Phase Results

### TDD Implementation
- Coverage: 85%
- Tests: 15/15 passed
- Static analysis: 0 errors

## Next Steps
1. Create PR
2. Request review
```

### Best Practices

- Run regularly to visualize progress
- Address blockers early
- Run as a final check upon completion

---

## /tdd-impl

### Overview

A command that implements high-quality code following the Test-Driven Development (TDD) methodology.

### Usage

```
/tdd-impl [feature name]
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| Feature name | Optional | Name of the feature to implement |

### TDD Cycle

```
+---------+
|   Red   | <-- Write a failing test
+----+----+
     |
     v
+---------+
|  Green  | <-- Minimal implementation to pass
+----+----+
     |
     v
+---------+
|Refactor | <-- Improve code
+----+----+
     |
     +--------> Repeat
```

### Output

1. **Implementation** - Created/modified files
2. **Test results** - Pass/fail counts, coverage
3. **Static analysis results** - ESLint, TypeScript error counts
4. **Commits** - Created commits

### Output Example

```
TDD Implementation Complete

## Implementation
- src/lib/theme.ts
- src/components/ThemeToggle.tsx

## Test Results
- Total: 10 tests
- Passed: 10
- Coverage: 85%

## Static Analysis
- ESLint: 0 errors
- TypeScript: 0 errors

## Commits
- abc1234: feat(theme): add dark mode toggle
```

### Completion Criteria

- All tests pass
- Coverage 80% or above
- Zero static analysis errors
- Commits complete

---

## Command File Locations

```
.claude/
├── commands/
│   ├── work-plan.md
│   ├── create-pr.md
│   ├── progress-report.md
│   └── tdd-impl.md
├── agents/
│   ├── tdd-impl-agent.md
│   └── progress-report-agent.md
└── prompts/
    ├── tdd-impl-core.md
    └── progress-report-core.md
```

---

## Best Practices

### 1. Command Execution Order

```
/work-plan -> /tdd-impl -> /progress-report -> /create-pr
```

### 2. Thorough Quality Checks

Verify before running commands:

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 3. Commit Message Convention

Use Conventional Commits format:

```
feat(scope): add new feature
fix(scope): fix bug
docs(scope): update documentation
test(scope): add tests
refactor(scope): refactor code
```

---

## CLI Tool Standard Slash Commands

CommandMate supports Claude Code and Codex CLI. Each CLI tool has its own slash commands, and CommandMate automatically filters the available commands based on the selected CLI tool.

### Claude Code Commands (16 types)

Standard commands displayed when the Claude tab is selected.

| Command | Description | Category |
|---------|-------------|----------|
| `/clear` | Clear conversation history and start fresh | Session |
| `/compact` | Compress context to save capacity | Session |
| `/resume` | Continue a previous conversation | Session |
| `/rewind` | Reset conversation or code to a previous state | Session |
| `/config` | Open settings interface | Settings |
| `/model` | Switch the AI model | Settings |
| `/permissions` | View/update tool access permissions | Settings |
| `/status` | Display current status information | Monitoring |
| `/context` | Display context usage as a color grid | Monitoring |
| `/cost` | Display token usage and cost statistics | Monitoring |
| `/review` | Code review current changes | Git |
| `/pr-comments` | Display pull request comments | Git |
| `/help` | List available slash commands | Utility |
| `/doctor` | Check for installation issues | Utility |
| `/export` | Export conversation to file or clipboard | Utility |
| `/todos` | List current TODO entries | Utility |

### Codex CLI Commands (10 types)

Dedicated commands displayed when the Codex tab is selected.

| Command | Description | Category |
|---------|-------------|----------|
| `/new` | Start a new conversation | Session |
| `/undo` | Undo the last change | Session |
| `/logout` | Log out from the current account | Session |
| `/quit` | Exit Codex CLI | Session |
| `/approvals` | Manage approval policies | Settings |
| `/diff` | Show change diff | Git |
| `/mention` | Manage @mentions | Utility |
| `/mcp` | Manage MCP server connections | Utility |
| `/init` | Initialize a project | Utility |
| `/feedback` | Send feedback | Utility |

### How to Use Commands

1. Type `/` in the message input field to see available commands
2. Only commands for the selected CLI tool (Claude / Codex) are displayed
3. Select a command or type it directly and send

---

## Skills List

Skills are Claude Code extensions that automate specific workflows.

| Skill | Description | Arguments |
|-------|-------------|-----------|
| `/release` | Release automation | `patch` / `minor` / `major` / version number |
| `/rebuild` | Server restart | None |

### /release

#### Overview

Releases a new version. Automates the following:

- Version update in package.json / package-lock.json
- CHANGELOG.md update
- Git tag creation and push
- GitHub Releases creation

#### Usage

```
/release patch      # Patch version bump (0.1.0 -> 0.1.1)
/release minor      # Minor version bump (0.1.0 -> 0.2.0)
/release major      # Major version bump (0.1.0 -> 1.0.0)
/release 1.0.0      # Direct version specification
```

#### Preconditions

- Must be on the main branch
- No uncommitted changes
- Synced with remote

#### Details

See the [Release Guide](../../release-guide.md) for details.

---

## Related Documentation

- [Quick Start Guide](./quick-start.md) - 5-minute development flow
- [Release Guide](../../release-guide.md) - Release procedures and skill details
- [CLAUDE.md](../../../CLAUDE.md) - Project guidelines
