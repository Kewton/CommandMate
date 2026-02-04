# Architecture Review Report - Issue #152

**Issue**: #152 - First message not sent
**Review Stage**: Stage 3 - Impact Analysis
**Reviewer**: architecture-review-agent
**Date**: 2026-02-04
**Status**: Conditional Approval

---

## Executive Summary

The design policy for Issue #152 proposes well-structured changes to fix the session initialization timing bug. The impact analysis reveals that while the core changes are well-documented, several important impact considerations are missing:

1. **Breaking Change**: `startClaudeSession()` will throw errors on timeout (previously silent)
2. **Test Coverage Gap**: Integration tests mock the affected functions, preventing verification of timing fix
3. **Missing Impact Files**: Several files using `claude-session.ts` are not listed in impact scope

---

## Impact Analysis

### Direct Changes

| File | Change Type | Impact Level | Description |
|------|-------------|--------------|-------------|
| `src/lib/claude-session.ts` | Modify | **High** | Core fix: timeout error, prompt verification, new waitForPrompt() |
| `src/app/api/worktrees/[id]/send/route.ts` | Modify | Medium | Error handling strengthening |

### Indirect Impact

| File | Impact Level | Reason |
|------|--------------|--------|
| `src/lib/cli-tools/claude.ts` | Low | Wraps claude-session.ts - inherits error behavior |
| `src/lib/claude-poller.ts` | None | Uses different functions (captureClaudeOutput, isClaudeRunning) |
| `src/app/api/hooks/claude-done/route.ts` | None | Uses captureClaudeOutput only |
| `src/components/worktree/MessageInput.tsx` | Low | May display new timeout errors |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Low | Errors handled by MessageInput |

### Test Files Affected

| File | Impact | Notes |
|------|--------|-------|
| `tests/integration/api-send-cli-tool.test.ts` | Needs Review | Mocks `startClaudeSession` and `sendMessageToClaude` - cannot test timing |
| `tests/integration/api-prompt-handling.test.ts` | Needs Review | Mocks claude-session module |
| `tests/unit/cli-tools/claude.test.ts` | None | Tests properties only |
| `src/lib/__tests__/cli-patterns.test.ts` | Optional | Could add tests for session context |

---

## Must Fix (Required Before Implementation)

### IMP-001: Breaking Change Not Documented

**Category**: Breaking Change

**Problem**: The design adds a new thrown Error on timeout in `startClaudeSession()`. This is a breaking change that affects all callers.

**Affected Callers**:
- `src/lib/cli-tools/claude.ts` (line 56 - startSession())
- `src/lib/claude-session.ts` (line 373 - restartClaudeSession())
- `src/app/api/worktrees/[id]/send/route.ts` (line 100 - via ClaudeTool)

**Recommendation**: Add "Breaking Changes" section to design policy documenting:
1. `startClaudeSession()` now throws on timeout (previously silent)
2. List all callers that need error handling review
3. Specify expected error message format for API consistency

---

### IMP-002: Test Coverage Gap

**Category**: Test Coverage

**Problem**: The existing integration test (`tests/integration/api-send-cli-tool.test.ts`) mocks the affected functions:

```typescript
// lines 14-19
vi.mock('@/lib/claude-session', () => ({
  startClaudeSession: vi.fn(),
  isClaudeRunning: vi.fn(() => Promise.resolve(false)),
  sendMessageToClaude: vi.fn(),
  ...
}));
```

This means the actual timing/race condition being fixed **cannot be tested** with current infrastructure.

**Recommendation**: Add note to design policy:
1. Acknowledge that integration tests use mocks and cannot verify timing fix
2. Consider adding E2E test or manual verification procedure
3. Document expected behavior when timeout occurs

---

## Should Fix (Recommended Before Implementation)

### IMP-003: Missing Affected File - claude-poller.ts

`src/lib/claude-poller.ts` imports from claude-session.ts (line 6):
```typescript
import { captureClaudeOutput, isClaudeRunning } from './claude-session';
```

**Recommendation**: Add to "Indirect Impact" section with note: "No changes required - uses different functions"

### IMP-004: Missing Affected File - claude-done/route.ts

`src/app/api/hooks/claude-done/route.ts` imports `captureClaudeOutput` (line 9).

**Recommendation**: Add to "Impact None" section for completeness.

### IMP-005: Missing Test File - api-prompt-handling.test.ts

`tests/integration/api-prompt-handling.test.ts` mocks claude-session module (lines 48-51). If `waitForPrompt` is exported, the mock may need updating.

**Recommendation**: List in test strategy section.

### IMP-006: Error Response Format Not Specified

The design mentions error handling but does not specify:
- HTTP status code for timeout (500?)
- Error message format
- Whether to distinguish timeout from other errors

**Recommendation**: Clarify in design policy.

### IMP-007: Rollback Scenario

The rollback plan does not address sessions started under new behavior.

**Recommendation**: Add note: "No state cleanup required for rollback - new error throwing does not persist state."

---

## Nice to Have (Optional Improvements)

### IMP-008: CLI Tools Consistency

Explicitly state why Codex/Gemini don't need similar changes:
- Codex: Uses fixed delay (3000ms) - no prompt detection needed
- Gemini: Non-interactive - no session initialization

### IMP-009: MessageInput Clarification

MessageInput.tsx already has error handling (lines 35, 78, 206-209). Design says "if needed" which is vague.

**Recommendation**: Clarify: "MessageInput.tsx already handles errors. No additional changes needed."

### IMP-010: Pattern Tests

Consider adding tests to `cli-patterns.test.ts` that verify `CLAUDE_PROMPT_PATTERN` behavior in session initialization context.

---

## Rollback Analysis

| Aspect | Assessment |
|--------|------------|
| Complexity | Low |
| Database Migrations | None |
| Configuration Changes | None |
| Data Impact | None |

**Rollback Steps**:
1. git revert changes to `src/lib/claude-session.ts`
2. git revert changes to `src/app/api/worktrees/[id]/send/route.ts` (if any)

**Risk**: Sessions started during deployment may have experienced timeout errors - users would need to retry.

---

## Design Policy Checklist Additions

| Category | Item |
|----------|------|
| Documentation | Add "Breaking Changes" section for startClaudeSession() timeout |
| Documentation | Add claude-poller.ts and claude-done/route.ts to impact scope |
| Testing | Add note about integration test mocking limitations |
| Testing | Consider E2E test for timing verification |
| API | Confirm HTTP 500 + error format for timeout errors |

---

## Conclusion

The design policy is **conditionally approved** pending:

1. **Required**: Document the breaking change (startClaudeSession throws on timeout)
2. **Required**: Address test coverage gap for timing verification
3. **Recommended**: Complete the impact scope documentation

The core design is sound and addresses the root cause of the bug effectively. The suggested improvements will ensure better documentation for maintainability and clearer testing strategy.

---

*Generated by architecture-review-agent*
