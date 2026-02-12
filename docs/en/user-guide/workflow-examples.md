[日本語版](../../user-guide/workflow-examples.md)

# Workflow Examples

Practical workflow examples using CommandMate's commands and agents.

---

## 1. New Feature Development Flow

A standard workflow for developing a new Issue.

### Step 1: Review the Issue

```bash
# List issues
gh issue list

# View the target issue
gh issue view 123
```

### Step 2: Create a Work Plan

```
/work-plan 123
```

**Output example**:
```markdown
## Issue: Add Dark Mode
**Issue number**: #123
**Size**: M
**Priority**: High

### Task Breakdown
- [ ] Task 1.1: Theme type definitions
- [ ] Task 1.2: Create theme context
- [ ] Task 1.3: Implement UI components
- [ ] Task 2.1: Unit tests
...
```

### Step 3: Automated Development

```
/pm-auto-dev 123
```

**Execution**:
1. TDD implementation (test creation -> implementation -> refactoring)
2. Acceptance testing
3. Code quality improvement
4. Progress report creation

### Step 4: Create PR

```
/create-pr
```

**Output example**:
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
- Coverage: 85%
```

---

## 2. Bug Fix Flow

A workflow for fixing issues when bugs are discovered.

### Step 1: Bug Report

A bug is discovered by a user or yourself.

### Step 2: Automated Investigation & Fix

```
/bug-fix API error occurring
```

**Execution phases**:

**Phase 1: Bug Investigation**
- Error log analysis
- Root cause identification

```markdown
## Investigation Summary

**Root cause**: Timeout setting too short
**Impact scope**: All users
**Severity**: high
```

**Phase 2: Solution Proposals**
```markdown
## Solutions (by priority)

1. [High] Change timeout setting (30 min)
2. [Medium] Add retry logic (1 hour)

Which solution would you like to implement?
```

**Phase 3-6: Fix, Test & Report**
- TDD fix implementation
- Acceptance testing
- Progress report

### Step 3: Create PR

```
/create-pr
```

---

## 3. Refactoring Flow

A workflow for improving code quality.

### Step 1: Identify Targets

```
/refactoring src/lib/utils.ts
```

### Step 2: Analysis & Execution

**Output example**:
```
Refactoring Complete

## Refactoring Applied
- Split long functions
- Removed duplicate code
- Improved naming

## Quality Metrics Improvement
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Coverage | 75.0% | 85.0% | +10.0% |
| ESLint errors | 5 | 0 | -5 |
```

### Step 3: Verify Tests

```bash
npm run test:unit
npm run lint
npx tsc --noEmit
```

---

## 4. Emergency Response Flow

A workflow for emergency response when production issues occur.

### Step 1: Assess the Situation

```bash
# Check recent logs
tail -100 logs/error.log

# Check environment variables
cat .env.production
```

### Step 2: Emergency Fix

```
/bug-fix API error occurring in production
```

**Setting severity to critical**:
- Prioritize implementing Solution 1
- Run tests
- Prepare for immediate deployment

### Step 3: Create hotfix Branch

```bash
git checkout -b hotfix/critical-api-fix
```

### Step 4: Create PR (emergency merge)

```
/create-pr
```

---

## 5. Fully Automated Development Flow

A flow where you just specify an Issue number and development runs to completion automatically.

### Execution

```
/pm-auto-dev 166
```

### Auto-execution Details

```
Phase 1: Issue information gathered
  - Issue #166: Add new feature
  - Acceptance criteria: 3 items
  - Implementation tasks: 5 items

Phase 2: TDD Implementation (Iteration 1/3)
  - Launching tdd-impl-agent...
  - Coverage: 85%
  - Tests: 15/15 passed

Phase 3: Acceptance Testing
  - Launching acceptance-test-agent...
  - Test scenarios: 3/3 passed

Phase 4: Refactoring
  - Launching refactoring-agent...
  - Coverage: 85% -> 88%

Phase 5: Progress Report
  - Launching progress-report-agent...
  - Report created

Issue #166 development complete!
```

### After Completion

```
/create-pr
```

---

## 6. Standalone TDD Execution Flow

A flow for running just TDD implementation.

### Execution

```
/tdd-impl new API endpoint
```

### TDD Cycle

**Red Phase**:
```typescript
// tests/unit/api.test.ts
it('should return data', async () => {
  const result = await fetchData()
  expect(result).toBeDefined()
})
```

**Green Phase**:
```typescript
// src/lib/api.ts
export async function fetchData() {
  return { data: 'test' }
}
```

**Refactor Phase**:
- Improve code
- Re-run tests

### Result

```
TDD Implementation Complete

## Test Results
- Total: 5 tests
- Passed: 5
- Coverage: 90%

## Static Analysis
- ESLint: 0 errors
- TypeScript: 0 errors
```

---

## Best Practices for Command Usage

### 1. Start with a Plan

```
/work-plan -> /pm-auto-dev -> /create-pr
```

### 2. Regular Progress Checks

```
/progress-report 123
```

### 3. Thorough Quality Checks

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 4. Commit Message Convention

```
feat(scope): add new feature
fix(scope): fix bug
refactor(scope): refactor code
test(scope): add tests
docs(scope): update documentation
```

---

## Related Documentation

- [Quick Start Guide](./quick-start.md) - 5-minute development flow
- [Commands Guide](./commands-guide.md) - Command details
- [Agents Guide](./agents-guide.md) - Agent details
