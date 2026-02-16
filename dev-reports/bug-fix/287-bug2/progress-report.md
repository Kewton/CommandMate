# Progress Report - Issue #287 Bug2

## Overview

| Item | Detail |
|------|--------|
| **Issue** | #287 - Worktree prompt-response cursor-key navigation |
| **Bug ID** | 287-bug2 |
| **Branch** | `feature/287-worktree` |
| **Report Date** | 2026-02-16 |
| **Status** | All phases completed successfully |

**Bug Summary**: `auto-yes-manager.ts` and `route.ts` contained fully duplicated cursor-key sending logic for Claude Code multiple-choice prompts. When Bug1 was fixed in `route.ts` (adding `fallbackPromptType` / `fallbackDefaultOptionNumber`), the same fix was not propagated to `auto-yes-manager.ts` due to DRY principle violation. This caused Auto-Yes mode to potentially fail on Claude Code multiple-choice prompts.

---

## Phase Results

### Phase 1: Investigation
**Status**: Completed

- **Root Cause**: Code duplication (DRY violation) between `auto-yes-manager.ts` (L340-399) and `route.ts` (L114-187). Both files contained independent copies of cursor-key navigation logic (isClaudeMultiChoice judgment, navigation key construction, multi-select/single-select/text send paths). Bug1 fix was applied only to `route.ts`.
- **Severity**: Medium - Auto-Yes mode could fail on Claude Code multiple-choice prompts in edge cases. No data loss risk. Manual recovery possible.
- **Affected Files**: `src/lib/auto-yes-manager.ts`, `src/app/api/worktrees/[id]/prompt-response/route.ts`
- **Duplication Identified**: 6 duplicated logic blocks (isClaudeMultiChoice condition, targetNum/defaultNum/offset calculation, checkbox detection, multi-select key sequence, single-select key sequence, standard text send path)

---

### Phase 2: Action Plan
**Status**: Completed

- **Selected Action**: Extract cursor-key sending logic into a shared function `sendPromptAnswer()` in a new module `src/lib/prompt-answer-sender.ts`
- **Approach**: Create shared module with unified interface accepting `sessionName`, `answer`, `cliToolId`, `promptData`, `fallbackPromptType`, and `fallbackDefaultOptionNumber`. Replace duplicated blocks in both `route.ts` and `auto-yes-manager.ts` with calls to the shared function.
- **Risk Level**: Low

---

### Phase 3: Work Plan
**Status**: Completed

**Deliverables**:
1. `src/lib/prompt-answer-sender.ts` - New shared module
2. `tests/unit/lib/prompt-answer-sender.test.ts` - New test suite
3. `src/app/api/worktrees/[id]/prompt-response/route.ts` - Replaced inline logic with shared function call
4. `src/lib/auto-yes-manager.ts` - Replaced inline logic with shared function call

**Definition of Done** (7 criteria defined):
- Cursor-key logic unified in `sendPromptAnswer()`
- Bug1 fallback continues to work in `route.ts` path
- `auto-yes-manager.ts` correctly calls shared function
- All existing tests pass
- New test cases added for shared function
- ESLint/TypeScript errors = 0
- Build succeeds

---

### Phase 4: TDD Fix
**Status**: Completed

**Test Results**:

| Test Suite | Tests | Passed | Failed |
|-----------|-------|--------|--------|
| `prompt-answer-sender.test.ts` (new) | 16 | 16 | 0 |
| `auto-yes-manager.test.ts` (existing) | 53 | 53 | 0 |
| `prompt-response-verification.test.ts` (existing) | 21 | 21 | 0 |
| **Total** | **90** | **90** | **0** |

**New Test Coverage** (16 tests in `prompt-answer-sender.test.ts`):
- Claude + `multiple_choice` promptData -> cursor keys (sendSpecialKeys)
- Claude + `yes_no` promptData + `fallbackPromptType=multiple_choice` -> cursor keys
- Claude + undefined promptData + `fallbackPromptType=multiple_choice` -> cursor keys
- Claude + undefined promptData + no fallback -> text send (sendKeys)
- Non-claude cliToolId (codex, gemini) -> always text send
- Multi-select checkbox -> Space + navigate to Next + Enter
- Multi-select with Up navigation (target above default)
- Multi-select selecting default (offset=0)
- Single-select default option (offset=0) -> just Enter
- Offset > 0 -> Down keys + Enter
- Offset < 0 -> Up keys + Enter
- yes_no prompt -> text send
- Non-numeric answer for multi-choice -> text send fallback
- promptData priority over fallback (uses promptData default option when both available)

**Quality Checks**:
- TypeScript (`npx tsc --noEmit`): 0 errors
- ESLint (`npm run lint`): 0 warnings/errors

---

### Phase 5: Acceptance Test
**Status**: Passed (All 8 scenarios, all 7 criteria)

| Scenario | Result |
|----------|--------|
| prompt-answer-sender.test.ts 16 tests pass | Passed |
| auto-yes-manager.test.ts 53 tests pass (existing behavior preserved) | Passed |
| prompt-response-verification.test.ts 21 tests pass (existing behavior preserved) | Passed |
| TypeScript type check 0 errors | Passed |
| ESLint 0 errors/warnings | Passed |
| Build (`npm run build`) succeeds | Passed |
| route.ts uses sendPromptAnswer, no direct cursor-key logic | Passed |
| auto-yes-manager.ts uses sendPromptAnswer, no direct cursor-key logic | Passed |

**Acceptance Criteria Verification** (7/7 verified):
- [x] `route.ts` and `auto-yes-manager.ts` cursor-key sending logic unified in `sendPromptAnswer()`
- [x] `route.ts` bodyPromptType fallback (Bug1 fix) continues to work
- [x] `auto-yes-manager.ts` correctly calls `sendPromptAnswer()`
- [x] Existing tests all pass
- [x] New test cases added for shared function
- [x] ESLint/TypeScript errors = 0
- [x] Build succeeds

---

## Quality Metrics Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| New tests added | 16 | - | OK |
| Existing tests verified | 74 | 74 pass | OK |
| Total tests passed | 90 | 90 | OK |
| Total tests failed | 0 | 0 | OK |
| TypeScript errors | 0 | 0 | OK |
| ESLint errors | 0 | 0 | OK |
| Build | Success | Success | OK |

**Code Change Statistics**:
- `route.ts`: -86 lines (removed duplicated logic), +4 lines (shared function call) = net -82 lines
- `auto-yes-manager.ts`: -56 lines (removed duplicated logic), +6 lines (shared function call) = net -50 lines
- `prompt-answer-sender.ts`: +108 lines (new shared module)
- `prompt-answer-sender.test.ts`: +414 lines (new test suite)
- **Net production code reduction**: ~24 lines removed (153 lines removed from duplication, 108 lines added to shared module, plus import adjustments)

---

## Key Changes

### New File: `src/lib/prompt-answer-sender.ts`

Shared module containing:
- `sendPromptAnswer(params)` - Unified function that determines whether to use cursor-key navigation or text-based input, then sends keys via tmux
- `buildNavigationKeys(offset)` - Helper to build Up/Down key arrays (moved from `route.ts`)
- `CHECKBOX_OPTION_PATTERN` - Regex constant for checkbox detection (moved from `route.ts`)
- `SendPromptAnswerParams` interface - Type-safe parameter definition with optional fallback fields

Decision logic:
1. `cliToolId === 'claude'` AND (`promptData.type === 'multiple_choice'` OR `fallbackPromptType === 'multiple_choice'`) AND answer is numeric -> cursor-key navigation
2. Otherwise -> standard text send (sendKeys + Enter)

### Modified File: `src/app/api/worktrees/[id]/prompt-response/route.ts`

- Removed inline `buildNavigationKeys()`, `CHECKBOX_OPTION_PATTERN`, and ~70 lines of cursor-key logic
- Replaced with single `sendPromptAnswer()` call passing `bodyPromptType` and `bodyDefaultOptionNumber` as fallback parameters
- Bug1 fallback behavior preserved through the shared function's `fallbackPromptType` parameter

### Modified File: `src/lib/auto-yes-manager.ts`

- Removed ~55 lines of inline cursor-key logic (for loops, key construction, multi-select detection)
- Replaced with single `sendPromptAnswer()` call
- Now benefits from the same fallback logic as `route.ts` through the shared function

---

## Blockers

None. All phases completed successfully with no outstanding issues.

---

## Next Steps

1. **Commit changes** - Stage the 4 changed/new files and create a commit with the bug fix and reports
2. **PR preparation** - Bug1 and Bug2 fixes are both complete on `feature/287-worktree`. Consider creating or updating the PR for review
3. **Code review focus areas**:
   - Verify `sendPromptAnswer()` interface covers all edge cases
   - Confirm the fallback priority (promptData > fallbackPromptType > text send) is correct
   - Review test coverage for the shared module
4. **Future considerations**:
   - If additional CLI tools require cursor-key navigation in the future, `sendPromptAnswer()` can be extended by adding tool-specific conditions
   - The `CHECKBOX_OPTION_PATTERN` regex and multi-select logic are now centralized, making future checkbox format changes single-point edits

---

## Notes

- This bug fix resolves a DRY principle violation that was the root cause of Bug2
- The shared function approach ensures that any future fixes to cursor-key navigation logic are automatically applied to both the API route (manual prompt response) and the Auto-Yes poller (automatic prompt response) paths
- All 90 tests pass across the three relevant test suites, confirming no regression
- The net effect is a reduction in production code lines while increasing test coverage

**Bug #287-bug2 fix is complete and ready for commit.**
