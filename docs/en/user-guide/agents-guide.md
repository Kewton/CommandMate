[日本語版](../../user-guide/agents-guide.md)

# Agents Guide

A detailed guide to the sub-agents available in CommandMate.

---

## What are Agents?

Agents are sub-processes that operate as specialists for specific tasks. They are invoked by orchestration commands such as PM Auto-Dev (`/pm-auto-dev`) and PM Bug Fix (`/bug-fix`), receive context files as input, execute processing, and output result files.

---

## Agent List

| Agent | Description | Called From |
|-------|-------------|------------|
| `tdd-impl-agent` | TDD implementation specialist | `/tdd-impl`, `/pm-auto-dev` |
| `progress-report-agent` | Progress report generation | `/progress-report`, `/pm-auto-dev` |
| `investigation-agent` | Bug investigation specialist | `/bug-fix` |
| `acceptance-test-agent` | Acceptance testing | `/acceptance-test`, `/pm-auto-dev` |
| `refactoring-agent` | Refactoring | `/refactoring`, `/pm-auto-dev` |

---

## tdd-impl-agent

### Overview
A specialist agent that implements high-quality code following the TDD (Test-Driven Development) methodology.

### Input
**Context file**: `tdd-context.json`

```json
{
  "issue_number": 166,
  "acceptance_criteria": ["Criterion 1", "Criterion 2"],
  "implementation_tasks": ["Task 1", "Task 2"],
  "target_coverage": 80
}
```

### Output
**Result file**: `tdd-result.json`

```json
{
  "status": "success",
  "coverage": 85.0,
  "unit_tests": {
    "total": 10,
    "passed": 10,
    "failed": 0
  },
  "static_analysis": {
    "eslint_errors": 0,
    "typescript_errors": 0
  },
  "files_changed": ["src/lib/xxx.ts"],
  "commits": ["abc1234: feat(xxx): implement feature"]
}
```

### Completion Criteria
- All tests pass
- Coverage meets or exceeds target
- Zero static analysis errors
- Commits complete

---

## progress-report-agent

### Overview
A specialist agent that aggregates results from each development phase and creates a progress report.

### Input
**Context file**: `progress-context.json`

```json
{
  "issue_number": 166,
  "iteration": 1,
  "phase_results": {
    "tdd": { "status": "success", "coverage": 85.0 },
    "acceptance": { "status": "passed" },
    "refactor": { "status": "success" }
  }
}
```

### Output
**Result file**: `progress-report.md`

A progress report in Markdown format.

### Completion Criteria
- All result files loaded
- Git history reviewed
- Quality metrics aggregated
- Next steps proposed

---

## investigation-agent

### Overview
A specialist agent for understanding the current state of bugs and investigating their causes. It identifies root causes through error log analysis, code investigation, and dependency checking, then presents recommended solutions.

### Input
**Context file**: `investigation-context.json`

```json
{
  "issue_description": "Error description",
  "error_logs": ["Error log 1"],
  "affected_files": ["src/lib/xxx.ts"],
  "reproduction_steps": ["1. xxx", "2. yyy"],
  "environment": {
    "os": "macOS",
    "node_version": "18.x"
  },
  "severity_hint": "high"
}
```

### Output
**Result file**: `investigation-result.json`

```json
{
  "status": "completed",
  "root_cause_analysis": {
    "category": "Code bug",
    "primary_cause": "Unhandled null reference"
  },
  "recommended_actions": [
    {
      "action_id": "1",
      "priority": "high",
      "title": "Solution 1",
      "description": "Solution description"
    }
  ]
}
```

### Completion Criteria
- Root cause identified
- At least one solution proposed
- Priority and risk assessed

---

## acceptance-test-agent

### Overview
A specialist agent that automatically runs acceptance tests based on Issue requirements and verifies that all acceptance criteria are met.

### Input
**Context file**: `acceptance-context.json`

```json
{
  "issue_number": 166,
  "feature_summary": "Feature summary",
  "acceptance_criteria": ["Criterion 1", "Criterion 2"],
  "test_scenarios": ["Scenario 1", "Scenario 2"]
}
```

### Output
**Result file**: `acceptance-result.json`

```json
{
  "status": "passed",
  "test_cases": [
    { "scenario": "Scenario 1", "result": "passed" },
    { "scenario": "Scenario 2", "result": "passed" }
  ],
  "acceptance_criteria_status": [
    { "criterion": "Criterion 1", "verified": true },
    { "criterion": "Criterion 2", "verified": true }
  ]
}
```

### Completion Criteria
- All test scenarios pass
- All acceptance criteria verified
- Evidence collected

---

## refactoring-agent

### Overview
A specialist agent that improves code quality, applies design patterns based on SOLID principles, and resolves technical debt.

### Input
**Context file**: `refactor-context.json`

```json
{
  "issue_number": 166,
  "refactor_targets": ["src/lib/xxx.ts"],
  "quality_metrics": {
    "before_coverage": 75.0
  },
  "improvement_goals": [
    "Increase coverage to 80%+",
    "Remove duplicate code"
  ]
}
```

### Output
**Result file**: `refactor-result.json`

```json
{
  "status": "success",
  "quality_metrics": {
    "before_coverage": 75.0,
    "after_coverage": 82.0
  },
  "refactorings_applied": [
    "Split long functions",
    "Removed duplicate code"
  ],
  "files_changed": ["src/lib/xxx.ts"]
}
```

### Completion Criteria
- All tests pass
- Quality metrics improved
- Zero static analysis errors

---

## How to Call Agents

### Calling from PM Auto-Dev

```
Use tdd-impl-agent to implement Issue #166 with TDD approach.

Context file: dev-reports/issue/166/pm-auto-dev/iteration-1/tdd-context.json
Output file: dev-reports/issue/166/pm-auto-dev/iteration-1/tdd-result.json
```

### Calling from PM Bug Fix

```
Use investigation-agent to investigate the bug.

Context file: dev-reports/bug-fix/20251205_120000/investigation-context.json
Output file: dev-reports/bug-fix/20251205_120000/investigation-result.json
```

---

## File Structure

```
.claude/
├── agents/
│   ├── tdd-impl-agent.md
│   ├── progress-report-agent.md
│   ├── investigation-agent.md
│   ├── acceptance-test-agent.md
│   └── refactoring-agent.md
└── prompts/
    ├── tdd-impl-core.md
    ├── progress-report-core.md
    ├── refactoring-core.md
    └── acceptance-test-core.md

dev-reports/
├── issue/{issue_number}/
│   └── pm-auto-dev/
│       └── iteration-{N}/
│           ├── tdd-context.json
│           ├── tdd-result.json
│           ├── acceptance-context.json
│           ├── acceptance-result.json
│           ├── refactor-context.json
│           ├── refactor-result.json
│           ├── progress-context.json
│           └── progress-report.md
└── bug-fix/{bug_id}/
    ├── investigation-context.json
    ├── investigation-result.json
    └── ...
```

---

## Related Documentation

- [Quick Start Guide](./quick-start.md) - 5-minute development flow
- [Commands Guide](./commands-guide.md) - Command details
- [Workflow Examples](./workflow-examples.md) - Practical usage examples
