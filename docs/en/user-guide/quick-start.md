[日本語版](../../user-guide/quick-start.md)

# Quick Start Guide

Get started with a development flow using CommandMate's slash commands and agents for Claude Code.

---

## Prerequisites

CommandMate must be installed and running.

```bash
# Install (first time only)
npm install -g commandmate
commandmate init --defaults

# Start the server
commandmate start --daemon
```

See the [CLI Setup Guide](./cli-setup-guide.md) for details.

---

## 5-Minute Development Flow

### Step 1: Review the Issue

Check Issues on GitHub and decide which one to work on.

```bash
# List issues
gh issue list

# View a specific issue
gh issue view 123
```

### Step 2: Create a Work Plan

Use the `/work-plan` command to create a work plan.

```
/work-plan 123
```

Output includes:
- Task breakdown
- Dependency diagram
- Quality check items
- Deliverables checklist

### Step 3: TDD Implementation

Use the `/tdd-impl` command for test-driven development.

```
/tdd-impl feature-name
```

TDD cycle:
1. **Red**: Write a failing test
2. **Green**: Write minimal implementation to pass
3. **Refactor**: Improve the code

### Step 4: Check Progress

Use the `/progress-report` command to check progress.

```
/progress-report 123
```

### Step 5: Create a PR

Use the `/create-pr` command to automatically create a Pull Request.

```
/create-pr
```

Auto-generated content:
- PR title (Conventional Commits format)
- Change description
- Test results
- Checklist

---

## Commonly Used Commands

| Command | Description | When to Use |
|---------|-------------|-------------|
| `/work-plan` | Create a work plan | When starting an Issue |
| `/tdd-impl` | TDD implementation | When implementing features |
| `/progress-report` | Progress report | For regular reports, completion checks |
| `/create-pr` | Auto-create PR | When implementation is complete |

---

## Development Flow Diagram

```
[Review Issue]
    |
    v
[/work-plan] --> Work Plan Document
    |
    v
[Create Branch]
    |
    v
[/tdd-impl] --> Tests & Implementation
    |
    v
[/progress-report] --> Progress Check
    |
    v
[/create-pr] --> Create PR
    |
    v
[Review & Merge]
```

---

## Quality Check Commands

Run these commands during development to ensure quality:

```bash
# Lint
npm run lint

# Type check
npx tsc --noEmit

# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# Build
npm run build
```

---

## Troubleshooting

### Command Not Found

Check that command files exist in the `.claude/commands/` directory.

```bash
ls -la .claude/commands/
```

### Tests Failing

1. Check the error message
2. Review the related test file
3. Fix the implementation
4. Re-run tests

```bash
npm run test:unit -- --verbose
```

### Cannot Create PR

1. Check for uncommitted changes
2. Verify CI checks pass

```bash
git status
npm run lint && npx tsc --noEmit && npm run test:unit && npm run build
```

---

## Next Steps

- [CLI Setup Guide](./cli-setup-guide.md) - Installation and troubleshooting
- [Commands Guide](./commands-guide.md) - Detailed command usage
- [Agents Guide](./agents-guide.md) - Sub-agent details
- [Workflow Examples](./workflow-examples.md) - Practical usage examples

---

## Related Documentation

- [CLAUDE.md](../../../CLAUDE.md) - Project guidelines
- [README.md](../../../README.md) - Project overview
