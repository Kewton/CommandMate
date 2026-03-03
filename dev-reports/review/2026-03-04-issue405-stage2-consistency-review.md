# Architecture Review Report: Issue #405 Stage 2 (Consistency Review)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #405 - perf: tmux capture optimization |
| Stage | 2 - Consistency Review |
| Focus | Design document vs. code consistency |
| Status | Conditionally Approved |
| Score | 4/5 |
| Must Fix | 2 items |
| Should Fix | 7 items |
| Nice to Have | 3 items |

The design policy document for Issue #405 is of high quality overall, with strong alignment between the proposed design and the existing codebase. The core design decisions (interface-preserving cache integration, globalThis pattern, listSessions batch optimization, B-plan cache invalidation) are all well-grounded in the actual implementation. Two must-fix items were identified: the missing `sliceOutput()` function definition and the `@internal` export semantics of `isSessionHealthy()`.

---

## Review Scope

### Design Document
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/dev-reports/design/issue-405-tmux-capture-optimization-design-policy.md`

### Reviewed Implementation Files
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/cli-session.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/tmux.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/claude-session.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/session-cleanup.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/auto-yes-manager.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/prompt-answer-sender.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/assistant-response-saver.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/cli-tools/types.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/cli-tools/base.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/[id]/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/[id]/current-output/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/[id]/prompt-response/route.ts`

---

## Detailed Findings

### Must Fix (2 items)

#### DC2-001: sliceOutput() function definition is missing from the design document

**Category**: Design-Code Consistency
**Affected Section**: 3.1.1 Interface Design

The design document uses `sliceOutput()` in three locations:
- Section 3.1.5: `getOrFetchCapture()` (lines 193, 202)
- Section 3.4.3: `captureSessionOutputFresh()` (line 401)

However, this function is never formally defined in the interface design (section 3.1.1). The exported function list in section 3.1.1 includes `getCachedCapture()`, `setCachedCapture()`, `invalidateCache()`, `clearAllCache()`, and `resetCacheForTesting()` but omits `sliceOutput()`.

The Issue body describes the A-plan slice logic conceptually (`output.split('\n').slice(-requestedLines).join('\n')`), but the design document should include the formal interface:

```typescript
/** Slice cached output to requested line count */
export function sliceOutput(fullOutput: string, requestedLines: number): string;
```

**Recommendation**: Add `sliceOutput()` to section 3.1.1 with full signature, JSDoc, and edge case behavior (requestedLines >= capturedLines returns unmodified output).

---

#### DC2-002: isSessionHealthy() is @internal export but design calls it from route.ts

**Category**: Design-Code Consistency
**Affected Section**: 3.3 isRunning() optimization (listSessions batch)

The DR1-005 design (section 3.3) specifies that `route.ts` should directly import and call `isSessionHealthy()` from `@/lib/claude-session`:

```typescript
import { isSessionHealthy } from '@/lib/claude-session';
// ...
if (isRunning && cliToolId === 'claude') {
    const healthResult = await isSessionHealthy(sessionName);
```

However, `isSessionHealthy()` in `claude-session.ts` (line 281-282) is annotated as:
```typescript
/** @internal Exported for testing purposes only. */
export async function isSessionHealthy(sessionName: string): Promise<HealthCheckResult>
```

Using an `@internal` export from production code contradicts its documented intent. The design must address this by either:
- (a) Removing the `@internal` annotation and documenting it as a production API
- (b) Keeping it internal and instead having `ClaudeTool.isRunning()` accept an optional session-name-set parameter

**Recommendation**: Explicitly document the design decision in section 3.3.

---

### Should Fix (7 items)

#### DC2-003: Missing logging strategy for cache-integrated captureSessionOutput()

**Category**: Design-Code Consistency
**Affected Section**: 3.2

The current `captureSessionOutput()` (`cli-session.ts` lines 43-71) uses `logger.withContext()` to emit debug logs at four points: start, sessionNotFound, success, and failed. The design document's replacement code in section 3.2 omits all logging. Cache-aware logging (cache hit/miss, singleflight hit) should be specified to maintain observability.

**Recommendation**: Add logging strategy to section 3.2 specifying at minimum: cache hit log, cache miss log, and singleflight deduplication log.

---

#### DC2-004: Error handling backward compatibility in cache-integrated captureSessionOutput()

**Category**: Design-Code Consistency
**Affected Section**: 3.2

The current implementation wraps `capturePane()` errors in a formatted message: `'Failed to capture {cliTool.name} output: {errorMessage}'`. The design's `fetchFn` callback (section 3.2, line 241) has no try-catch, meaning errors propagate with their original `capturePane()` error message format (`'Failed to capture pane: ...'`), breaking backward compatibility.

**Recommendation**: Add try-catch in the fetchFn or document that error message format will change, updating any dependent error handling.

---

#### DC2-005: HealthCheck frequency change not analyzed in route.ts optimization

**Category**: Design-Code Consistency
**Affected Section**: 3.3

The design replaces `cliTool.isRunning()` with `sessionNames.has()` + conditional `isSessionHealthy()`. Currently, `ClaudeTool.isRunning()` calls `isClaudeRunning()` which calls both `hasSession()` AND `isSessionHealthy()` unconditionally. After the change, `isSessionHealthy()` is only called when the session exists in the `listSessions()` result. While the behavior is functionally equivalent, the design should document this explicitly to confirm no edge cases are missed.

**Recommendation**: Add a note confirming that the HealthCheck frequency change (always -> only when session exists) produces identical results.

---

#### DC2-006: File change list (section 11) missing captureSessionOutputFresh() for cli-session.ts

**Category**: Design-CLAUDE.md Consistency
**Affected Section**: 11. File Change List

Section 11 lists `cli-session.ts` with change content "captureSessionOutput() cache integration" but does not mention the new `captureSessionOutputFresh()` function from DR1-008 (section 3.4.3). This function is a significant addition that should be reflected.

**Recommendation**: Update section 11 entry to: `captureSessionOutput() cache integration + captureSessionOutputFresh() new function`.

---

#### DC2-007: Issue acceptance criterion "skip non-running CLI tools" lacks design coverage

**Category**: Traceability
**Affected Section**: 3.3

Issue #405 has an acceptance criterion: "non-running CLI tools should have unnecessary tmux operations skipped." The design covers `listSessions()` batch optimization (reducing N tmux calls to 1), but does not explicitly design the "DB active CLI tool pre-filtering" mentioned in the Issue's implementation tasks. The design should clarify whether `listSessions()` alone satisfies this criterion (because `sessionNames.has()` returns false for non-running tools, naturally skipping `captureSessionOutput()`).

**Recommendation**: Add explicit note that `listSessions()` + `sessionNames.has()` inherently skips capture for non-running tools, satisfying the acceptance criterion.

---

#### DC2-008: prompt-response/route.ts duplicate session check with captureSessionOutputFresh()

**Category**: Design-Code Consistency
**Affected Section**: 3.4.3

The current `prompt-response/route.ts` (line 79) calls `cliTool.isRunning()` before `captureSessionOutput()` (line 96). The design's `captureSessionOutputFresh()` (section 3.4.3) also calls `hasSession()` internally. This creates a double session-existence check that the design does not acknowledge or justify.

**Recommendation**: Document that the `isRunning()` check serves a different purpose (returning 400 error for non-running sessions) than `captureSessionOutputFresh()`'s internal `hasSession()` (throwing error for capture), or consider removing the redundant check.

---

#### DC2-009: Phase numbering ambiguity for captureSessionOutputFresh() tasks

**Category**: Checklist Consistency
**Affected Section**: 10. Implementation Order

Section 14 checklist assigns DR1-008 (captureSessionOutputFresh) to "Phase 2 implementation," but the `prompt-response/route.ts` call-site change could logically belong to Phase 4 (cache invalidation, which also modifies route files). The dependency between these changes is not explicit in section 10's Phase 2 task list.

**Recommendation**: Add explicit sub-tasks to Phase 2 in section 10: "2-3: Add captureSessionOutputFresh() to cli-session.ts" and "2-4: Update prompt-response/route.ts to use captureSessionOutputFresh()".

---

### Nice to Have (3 items)

#### DC2-010: getCachedCapture() side effect (lazy eviction) not documented in interface

**Category**: Design-Code Consistency
**Affected Section**: 3.1.1

The eviction strategy (section 7.3) states that `getCachedCapture()` deletes expired entries on access. This side effect is not mentioned in the function's interface definition (section 3.1.1). While acceptable for an internal cache module, documenting the lazy eviction behavior in JSDoc would improve clarity.

---

#### DC2-011: clearAllCache() placement in session-cleanup.ts needs specificity

**Category**: Design-Code Consistency
**Affected Section**: 11. File Change List

The current `session-cleanup.ts` has `cleanupWorktreeSessions()` and `cleanupMultipleWorktrees()` but no dedicated graceful shutdown hook. The design should specify whether `clearAllCache()` is added to `cleanupMultipleWorktrees()` or a new function.

---

#### DC2-012: sliceOutput() test cases for varying line counts not in test strategy

**Category**: Checklist Consistency
**Affected Section**: 8. Test Strategy

The different callers request 100, 200, 5000, and 10000 lines. The test strategy (section 8) should include explicit test cases for `sliceOutput()` at each of these request sizes to ensure cache-to-caller slicing works correctly across all use cases.

---

## Consistency Verification Table

| Design Item | Design Document | Actual Implementation | Alignment |
|-------------|----------------|----------------------|-----------|
| captureSessionOutput() signature | `(worktreeId, cliToolId, lines=1000): Promise<string>` | `cli-session.ts` L38-42: identical | OK |
| Error message format | `${cliTool.name} session ${sessionName} does not exist` | `cli-session.ts` L54: identical | OK |
| listSessions() return type | `TmuxSession[]` with `.name` property | `tmux.ts` L19-23, L89: `TmuxSession { name, windows, attached }` | OK |
| HealthCheckResult interface | `{ healthy: boolean; reason?: string }` | `claude-session.ts` L284-287: identical | OK |
| ClaudeTool.isRunning() behavior | `hasSession() + isSessionHealthy()` | `claude.ts` L40-42 via `isClaudeRunning()`: confirmed | OK |
| Other tools isRunning() | `hasSession()` only | codex/gemini/vibe-local/opencode: confirmed | OK |
| capturePane options | `{ startLine: -CACHE_MAX_CAPTURE_LINES }` | `tmux.ts` L37-40: `CapturePaneOptions { startLine?, endLine? }` | OK |
| globalThis pattern | `globalThis.__tmuxCaptureCache` | Existing patterns: `auto-yes-manager`, `schedule-manager`, `version-checker` | OK |
| sendKeys/sendSpecialKeys signatures | Used in invalidation design | `tmux.ts` L210-227, L257-282: confirmed | OK |
| CLI_TOOL_IDS | 5 tools: claude, codex, gemini, vibe-local, opencode | `types.ts` L10: confirmed | OK |
| ICLITool.isRunning() | Interface unchanged | `types.ts` L42: confirmed | OK |
| SESSION_OUTPUT_BUFFER_SIZE | 10000 (matches CACHE_MAX_CAPTURE_LINES) | `assistant-response-saver.ts` L119: `10000` | OK |
| File change list completeness | 18 files listed | Verified against codebase: all identified targets present | OK (see DC2-006) |

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | sliceOutput() implementation ambiguity | Medium | Medium | P2 |
| Technical | @internal export usage in production | Low | High | P2 |
| Technical | Error message backward compatibility | Low | Medium | P3 |
| Operational | Cache invalidation completeness (B-plan) | Medium | Low | P3 |

---

## Stage 1 Findings Verification

All Stage 1 (design principles review) findings that required design document updates have been verified:

| Stage 1 ID | Status | Verification |
|------------|--------|-------------|
| DR1-001 | Reflected | Section 3.1.5 contains future separation note |
| DR1-002 | Reflected | Section 3.4 contains C-plan lightweight wrapper evaluation note |
| DR1-004 | Reflected | Section 3.2 contains DI migration note |
| DR1-005 | Reflected | Section 3.3 contains ClaudeTool HealthCheck integration design |
| DR1-008 | Reflected | Section 3.4.3 contains captureSessionOutputFresh() design |
| DR1-011 | Reflected | Section 3.5 contains hasSession() cost justification |

---

## Conclusion

The design policy document demonstrates strong consistency with the existing codebase. The `captureSessionOutput()` interface-preserving approach is well validated against the actual implementation, and the `listSessions()`/`TmuxSession` types match exactly. The two must-fix items (sliceOutput definition and @internal export semantics) are straightforward to address and do not require fundamental design changes. The seven should-fix items are refinements that will improve implementation clarity and traceability.

---

*Generated by architecture-review-agent for Issue #405*
*Date: 2026-03-04*
*Stage: 2 - Consistency Review*
