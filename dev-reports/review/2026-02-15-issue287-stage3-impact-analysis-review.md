# Architecture Review Report: Issue #287 - Stage 3 Impact Analysis

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #287 - Prompt Response Fallback for Multiple Choice |
| Focus Area | Impact Scope Analysis |
| Stage | 3 (Impact Analysis Review) |
| Status | Conditionally Approved |
| Score | 4/5 |
| Reviewed By | Architecture Review Agent |
| Date | 2026-02-15 |

The design policy for Issue #287 demonstrates a well-structured approach to adding a fallback mechanism for prompt response when `captureSessionOutput()` fails. The impact analysis reveals that the affected file list in the design policy is **mostly complete** but has one significant gap: the existing test file `tests/unit/lib/auto-yes-manager.test.ts` is not listed in the modification targets, despite containing 20+ test cases that directly test the cursor key sending logic being extracted to `buildCursorKeys()`. The overall risk is medium, primarily concentrated in the refactoring of duplicated cursor-key logic across `route.ts` and `auto-yes-manager.ts`.

---

## Detailed Impact Analysis

### 1. Directly Changed Files

| # | File | Change Type | Risk | Verified |
|---|------|------------|------|----------|
| 1 | `src/lib/cursor-key-sender.ts` | NEW | Low | N/A (new file) |
| 2 | `src/lib/prompt-response-utils.ts` | NEW | Low | N/A (new file) |
| 3 | `src/app/api/worktrees/[id]/prompt-response/route.ts` | Modify | Medium | Verified |
| 4 | `src/lib/auto-yes-manager.ts` | Modify | Medium | Verified |
| 5 | `src/components/worktree/WorktreeDetailRefactored.tsx` | Modify | Medium | Verified |
| 6 | `src/hooks/useAutoYes.ts` | Modify | Medium | Verified |

#### File-by-File Impact Assessment

**`route.ts` (Risk: Medium)**

The current file (179 lines) contains the `PromptResponseRequest` interface (L17-20), `captureSessionOutput` fallback path (L86-89), and the cursor-key sending logic (L96-158). The proposed changes will:
- Extend `PromptResponseRequest` with 2 optional fields (backward compatible)
- Extract inline cursor-key logic to `buildCursorKeys()` call
- Add `sendPromptAnswer()` local function
- Introduce `effectivePromptType` / `effectiveDefaultNum` 2-stage evaluation

The `catch` block at L86-89 currently proceeds with `promptCheck === null`, which means the fallback path (L149-158: text send) is always taken when `captureSessionOutput` fails. After the change, the fallback will use `body.promptType` to determine the correct sending method. This is the core bug fix.

**`auto-yes-manager.ts` (Risk: Medium)**

The cursor-key logic at L343-399 is a near-duplicate of `route.ts` L96-158. Both will be replaced by `buildCursorKeys()` calls. In `auto-yes-manager.ts`, the `promptDetection` object is always available when this code path is reached (L321 guards for `!promptDetection.isPrompt`), so the `effectivePromptType` will always come from `promptDetection.promptData?.type` -- never from a request body fallback. This difference from `route.ts` must be clearly documented.

**`WorktreeDetailRefactored.tsx` (Risk: Medium)**

This is a large file (2143 lines). The change targets the `handlePromptRespond` callback (L1126-1148). Key changes:
- Add `promptDataRef` via `useRef` (C-004)
- Add `useEffect` to sync `state.prompt.data` to ref
- Replace inline `JSON.stringify({ answer, cliTool: activeCliTab })` with `buildPromptResponseBody()` call
- Change `cliTool` access from `activeCliTab` to `activeCliTabRef.current` (MF-S2-001)
- Remove `activeCliTab` from `useCallback` dependency array

The existing `activeCliTabRef` pattern (L940-941) is already established in this file for `fetchMessages` and `fetchCurrentOutput`, so the proposed approach is consistent.

**`useAutoYes.ts` (Risk: Medium)**

Small file (96 lines). The change replaces `JSON.stringify({ answer, cliTool })` at L89 with `buildPromptResponseBody(answer, cliTool, promptData)`. The `promptData` parameter is already available as a hook argument (L30, L50). No `useRef` is needed because this is inside a `useEffect`, not a `useCallback`. The dependency array at L93 already includes `promptData`, so no change to dependencies is needed.

### 2. Test Files Requiring Update

| # | File | Change Needed | Listed in Design Policy |
|---|------|--------------|------------------------|
| 1 | `tests/unit/api/prompt-response-verification.test.ts` | Update existing tests + add new | Yes |
| 2 | `tests/unit/lib/auto-yes-manager.test.ts` | Update 20+ cursor-key tests | **NO (MISSING)** |
| 3 | `tests/unit/lib/cursor-key-sender.test.ts` | New file | Yes |
| 4 | `tests/unit/lib/prompt-response-utils.test.ts` | New file | Yes |
| 5 | `tests/integration/worktree-detail-integration.test.tsx` | Add request body verification | Yes |

**Critical Gap: `auto-yes-manager.test.ts`**

The design policy (Section 8) does not list `tests/unit/lib/auto-yes-manager.test.ts` as a file requiring modification. However, this file contains an extensive test suite for the cursor-key sending behavior in `pollAutoYes`:

- **"Issue #193: Claude Code cursor-based navigation in pollAutoYes"** test suite (L707-945):
  - Tests `sendSpecialKeys` is called for Claude `multiple_choice` prompts (L708)
  - Tests `sendKeys` is called for Claude `yes_no` prompts (L749)
  - Tests `sendKeys` is called for non-Claude `multiple_choice` prompts (L787)
  - Tests correct arrow key sequences for offset +2 (Down keys) (L823)
  - Tests correct arrow key sequences for offset -2 (Up keys) (L866)
  - Tests no-movement case when target equals default (L909)

- **Thinking state integration tests** (L475-685):
  - Tests that `sendKeys` is/is not called based on thinking state detection
  - Tests `THINKING_CHECK_LINE_COUNT` matching prompt-detector scan window

These tests directly verify the internal behavior of the cursor-key sending logic that will be extracted to `buildCursorKeys()`. While the external behavior should remain unchanged, the test implementation (which mocks `sendKeys`/`sendSpecialKeys` at the tmux level) may need adjustment if the call patterns change.

### 3. Indirectly Affected Files (Verified No Change Needed)

| # | File | Reason for Verification | Result |
|---|------|------------------------|--------|
| 1 | `src/components/worktree/PromptPanel.tsx` | Uses `onRespond: (answer: string) => Promise<void>` (L46, L55) | Signature unchanged, no impact |
| 2 | `src/components/mobile/MobilePromptSheet.tsx` | Uses `onRespond: (answer: string) => Promise<void>` (L44, L195) | Signature unchanged, no impact |
| 3 | `src/components/worktree/PromptMessage.tsx` | Uses separate `/api/worktrees/:id/respond` API via MessageList.tsx (L549) | Independent code path, no impact |
| 4 | `src/lib/tmux.ts` | `sendKeys()`/`sendSpecialKeys()` functions | Called but not modified, no impact |
| 5 | `src/lib/prompt-detector.ts` | `detectPrompt()` function | Called but not modified, no impact |
| 6 | `src/lib/auto-yes-resolver.ts` | `resolveAutoAnswer()` function | Called but not modified, no impact |
| 7 | `src/types/models.ts` | `PromptData` / `PromptType` types | Not modified (type expansion deferred to C-001) |
| 8 | `src/hooks/useWorktreeUIState.ts` | `showPrompt()`/`clearPrompt()` actions | Not modified, state shape unchanged |
| 9 | `tests/integration/auto-yes-persistence.test.ts` | Auto-yes state persistence tests | Tests state management, not cursor-key logic |

### 4. Confirmed Unaffected Files

The following files import or interact with `auto-yes-manager.ts` but are not affected by the cursor-key extraction:

| File | Reason |
|------|--------|
| `src/lib/session-cleanup.ts` | Calls `stopAutoYesPolling()`, unrelated to cursor-key logic |
| `src/config/auto-yes-config.ts` | Defines duration constants, unrelated |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | Toggle endpoint, unrelated |
| `src/app/api/worktrees/[id]/current-output/route.ts` | Output capture, unrelated |
| `src/lib/status-detector.ts` | Status detection, unrelated |
| `src/lib/version-checker.ts` | Version checking, imports auto-yes for timestamp only |

---

## Risk Assessment

| Risk Type | Level | Description | Mitigation |
|-----------|-------|-------------|------------|
| Technical: Test breakage | Medium | 20+ existing tests in auto-yes-manager.test.ts verify cursor-key logic being extracted | List file in modification targets, update tests to work with new abstraction |
| Technical: useCallback dependency change | Medium | Removing `activeCliTab` from handlePromptRespond's dependency array while other handlers retain it | Add code comments explaining the inconsistency rationale |
| Technical: Dual cursor-key code paths during development | Low | During implementation, if route.ts and auto-yes-manager.ts are updated at different times, behavior may diverge | Follow Phase 1 (shared helper first) then Phase 2 (consumers) order |
| Security: promptType field injection | Low | Malicious client could send arbitrary promptType | promptCheck takes priority; only used when promptCheck is null; validated as union type |
| Security: defaultOptionNumber manipulation | Low | Malicious client could send wrong defaultOptionNumber | Only affects cursor offset; promptCheck takes priority; ?? 1 safe default |
| Operational: Backward compatibility | Low | Existing clients without promptType field | All new fields are optional; behavior unchanged when absent |
| Operational: Deployment | Low | No database migration, no configuration changes | Standard Next.js deployment |

### Risk Matrix

```
         High |           |           |           |
              |           |           |           |
Impact   Med  |           | MF-S3-001 |           |
              |           |           |           |
         Low  |           | SF-S3-001 |           |
              |           | SF-S3-002 |           |
              +-----------+-----------+-----------+
                  Low        Medium       High
                          Probability
```

---

## Improvement Recommendations

### Must Fix (1 item)

#### MF-S3-001: Add `auto-yes-manager.test.ts` to Modification Target List

**Priority**: P1

The design policy Section 8 ("Modification File List") is missing `tests/unit/lib/auto-yes-manager.test.ts`. This file contains the test suite "Issue #193: Claude Code cursor-based navigation in pollAutoYes" with the following test cases that will be directly impacted:

| Test Case | Line | Current Assertion | Impact |
|-----------|------|-------------------|--------|
| sendSpecialKeys for Claude multiple_choice | L708 | `sendSpecialKeys` called with `['Enter']` | `buildCursorKeys()` now determines keys |
| sendKeys for Claude yes_no | L749 | `sendKeys` called with `'y'` | Unchanged, but verify |
| sendKeys for non-Claude multiple_choice | L787 | `sendKeys` called | Unchanged, but verify |
| Offset +2 (Down keys) | L823 | `sendSpecialKeys` with `['Down','Down','Enter']` | `buildCursorKeys()` now determines keys |
| Offset -2 (Up keys) | L866 | `sendSpecialKeys` with `['Up','Up','Enter']` | `buildCursorKeys()` now determines keys |
| Offset 0 (Enter only) | L909 | `sendSpecialKeys` with `['Enter']` | `buildCursorKeys()` now determines keys |

**Action**: Add the following entry to Section 8 Required Modifications:

```
| 11 | tests/unit/lib/auto-yes-manager.test.ts | pollAutoYes cursor-key test suite update (Issue #193 tests) | Low | MF-001 |
```

### Should Fix (3 items)

#### SF-S3-001: Document ref vs direct state access pattern inconsistency

**Priority**: P2

After the change, `handlePromptRespond` will use `activeCliTabRef.current` (D-11) while `handleAutoYesToggle` (L1182-1197) will continue using `activeCliTab` directly in its dependency array. This inconsistency should be documented.

**Action**: Add a comment near `handleAutoYesToggle` explaining:
```typescript
// Note: handleAutoYesToggle intentionally uses activeCliTab directly
// (not activeCliTabRef.current) because its dependency on activeCliTab
// is intentional -- the toggle targets a specific CLI tool tab.
// See Issue #287 D-11 for handlePromptRespond's ref-based approach.
```

#### SF-S3-002: Strengthen integration test baseline for request body verification

**Priority**: P2

The existing integration test at `tests/integration/worktree-detail-integration.test.tsx` (L365-428, "Prompt Response" test suite) only verifies that `mockFetch` was called with a URL containing `/prompt-response`. It does not inspect the request body. When adding new test cases for `promptType`/`defaultOptionNumber`, the baseline should also be strengthened.

**Action**: When implementing Section 11 test cases 1-2 for the integration test, also add body verification to the existing test case ("handles yes/no prompt response") to establish a complete baseline:
```typescript
const body = JSON.parse(promptResponseCall[1]?.body);
expect(body.answer).toBe('yes');
expect(body.cliTool).toBeDefined();
```

#### SF-S3-003: Document auto-yes-manager.ts's non-fallback path in buildCursorKeys() call

**Priority**: P3

In `auto-yes-manager.ts`, the `promptDetection` object is always available when cursor-key logic executes (guarded by L321). Unlike `route.ts`, there is no fallback from `body.promptType` -- the `effectivePromptType` always derives from `promptDetection.promptData?.type`.

**Action**: When calling `buildCursorKeys()` in `auto-yes-manager.ts`, add a comment:
```typescript
// Note: In auto-yes-manager, promptDetection is always available
// (guarded by L321 isPrompt check). effectivePromptType always comes
// from promptDetection.promptData?.type -- no request body fallback.
```

### Consider (3 items)

#### C-S3-001: useAutoYes promptData dependency re-execution

The `useEffect` in `useAutoYes.ts` has `promptData` in its dependency array. Since `promptData` reference may change on each polling cycle, the effect may re-execute frequently. However, the early return guard `if (!isPromptWaiting)` at L59 prevents execution in most cases. No action needed.

#### C-S3-002: Bundle size impact of new utility files

`cursor-key-sender.ts` is server-only (used by `route.ts` and `auto-yes-manager.ts`). `prompt-response-utils.ts` is client-side but minimal. No meaningful bundle size impact.

#### C-S3-003: PromptMessage.tsx independence confirmed

`PromptMessage.tsx` uses a separate API endpoint (`/api/worktrees/:id/respond`) via `MessageList.tsx`. It is fully independent from the `prompt-response` API being modified. No change needed.

---

## Completeness Assessment of Affected File List

| Category | Design Policy | Review Finding | Gap |
|----------|--------------|----------------|-----|
| Direct modifications (source) | 6 files | 6 files | None |
| Direct modifications (tests) | 4 files | 5 files | **auto-yes-manager.test.ts missing** |
| Unchanged files (verified) | 6 files | 9 files | 3 additional files verified |
| New files | 4 files | 4 files | None |

---

## Migration / Compatibility Assessment

| Concern | Assessment |
|---------|-----------|
| API backward compatibility | Fully maintained. New fields are optional. Old clients send `{ answer, cliTool }` and behavior is unchanged. |
| Database migration | Not required. No schema changes. |
| Configuration changes | Not required. No new environment variables. |
| Deployment procedure | Standard Next.js build and deploy. No special steps. |
| Rollback risk | Low. If rolled back, behavior reverts to pre-fix state (text send on captureSessionOutput failure). |

---

## Test Coverage Assessment

| Area | Current Coverage | Post-Change Coverage | Gap |
|------|-----------------|---------------------|-----|
| route.ts prompt re-verification | 5 test cases | 12 test cases (+7 from Section 11) | Adequate |
| route.ts captureSessionOutput failure | 1 test case (text send) | 5+ test cases (with promptType variants) | Good improvement |
| auto-yes-manager cursor-key logic | 6+ test cases | Need update for buildCursorKeys() | **Requires attention** |
| buildCursorKeys() pure function | N/A (new) | 6 test cases planned | Adequate |
| buildPromptResponseBody() pure function | N/A (new) | 4 test cases planned | Adequate |
| Integration: request body content | 0 test cases (body not verified) | 2 test cases planned | Good improvement |
| useAutoYes request body | 0 test cases | Not explicitly planned | **Consider adding** |

---

## Approval Status

**Conditionally Approved** -- The design policy is sound and the impact analysis is nearly complete. The one must-fix item (MF-S3-001: adding `auto-yes-manager.test.ts` to the modification target list) must be addressed before implementation begins to prevent test failures during development. The three should-fix items are recommended for implementation quality but are not blocking.

---

*Generated by Architecture Review Agent for Issue #287 Stage 3 (Impact Analysis)*
*Review date: 2026-02-15*
