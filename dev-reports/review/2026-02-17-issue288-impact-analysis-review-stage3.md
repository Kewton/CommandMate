# Architecture Review: Issue #288 - Impact Analysis (Stage 3)

## Executive Summary

Issue #288 addresses a bug where the slash command selector reappears during free input mode, preventing users from sending custom commands via Enter key. The proposed fix adds a `isFreeInputMode` boolean state to `MessageInput.tsx` to suppress selector re-display while in free input mode.

This Stage 3 impact analysis review confirms that the change scope is well-contained within `MessageInput.tsx` and its corresponding test file. No breaking changes, no API modifications, and no interface changes are introduced. The design correctly identifies all affected files and provides accurate reasoning for why related files require no modifications.

**Status**: Approved
**Score**: 5/5

---

## Impact Analysis

### Direct Changes

| Category | File | Change Description | Risk |
|----------|------|--------------------|------|
| Direct | `src/components/worktree/MessageInput.tsx` | Add `isFreeInputMode` useState, modify 4 functions (handleFreeInput, handleMessageChange, submitMessage, handleCommandCancel), add guard on mobile command button onClick | Low |
| Direct | `tests/unit/components/worktree/MessageInput.test.tsx` | Add 7 new test cases (TC-1 through TC-7) for free input mode, extend useSlashCommands mock with command groups | Low |

### Indirect Impact Analysis

| Category | File | Impact | Risk |
|----------|------|--------|------|
| Indirect | `src/components/worktree/SlashCommandSelector.tsx` | No change needed. `isOpen=false` maintained by MessageInput during free input mode. L95 handleKeyDown guard and L131 render guard (`return null`) ensure correct behavior. | None |
| Indirect | `src/components/worktree/SlashCommandList.tsx` | No change needed. Child of SlashCommandSelector; not rendered when parent returns null. | None |
| Indirect | `src/components/worktree/WorktreeDetailRefactored.tsx` | No change needed. Renders MessageInput at L1802 (desktop) and L2038 (mobile) with identical props. MessageInputProps unchanged; isFreeInputMode is internal state. | None |
| Indirect | `src/hooks/useSlashCommands.ts` | No change needed. Provides `groups` data only. Unaffected by UI state management changes. | None |
| Indirect | `src/lib/standard-commands.ts` | No change needed. Static command definitions; no UI logic. | None |
| Indirect | `src/components/worktree/InterruptButton.tsx` | No change needed. Independent component within MessageInput; no interaction with isFreeInputMode. | None |
| Indirect | `src/components/worktree/index.ts` | No change needed. Re-exports MessageInput and MessageInputProps; no interface change. | None |
| Test | `tests/unit/components/SlashCommandSelector.test.tsx` | No change needed. Existing tests cover isOpen=false rendering guard. Compatible with Issue #288. | None |
| Test | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | No change needed. Mocks MessageInput as child component. MessageInputProps unchanged. | None |
| Test | `tests/integration/issue-266-acceptance.test.tsx` | No change needed. Mocks MessageInput for mount/unmount tracking only. Internal state changes are transparent. | None |

### Breaking Changes

None. The `MessageInputProps` interface remains unchanged:

```typescript
export interface MessageInputProps {
  worktreeId: string;
  onMessageSent?: (cliToolId: CLIToolType) => void;
  cliToolId?: CLIToolType;
  isSessionRunning?: boolean;
}
```

The `isFreeInputMode` state is entirely internal to the `MessageInput` component.

### API Changes

None. No API routes are modified.

### Database Changes

None.

---

## Detailed Change Path Analysis

### showCommandSelector State Mutation Paths

The following analysis traces all code paths that set `showCommandSelector` within `MessageInput.tsx` and verifies that the `isFreeInputMode` flag correctly guards each path.

| # | Location | Code | Free Input Mode Behavior | Status |
|---|----------|------|--------------------------|--------|
| 1 | `handleCommandSelect` (L124-125) | `setShowCommandSelector(false)` | Not reachable during free input mode (selector not open) | Safe |
| 2 | `handleCommandCancel` (L132-133) | `setShowCommandSelector(false)` | Reachable via Escape key; also resets isFreeInputMode | Guarded |
| 3 | `handleFreeInput` (L142) | `setShowCommandSelector(false)` | Entry point; sets isFreeInputMode=true simultaneously | Safe |
| 4 | `handleMessageChange` (L158-159) | `setShowCommandSelector(true)` | Blocked by isFreeInputMode early return | Guarded |
| 5 | `handleMessageChange` (L161) | `setShowCommandSelector(false)` | Blocked by isFreeInputMode early return | Guarded |
| 6 | Mobile command button (L218) | `setShowCommandSelector(true)` | Guarded by Section 4-6 design: resets isFreeInputMode before showing selector | Guarded |

All 6 paths are properly handled. The design document's path analysis in Section 3 and Section 4-3/4-6 is accurate and complete.

### isFreeInputMode State Mutation Paths

| # | Location | Operation | Trigger | Purpose |
|---|----------|-----------|---------|---------|
| 1 | `handleFreeInput` | `setIsFreeInputMode(true)` | User clicks "Enter custom command..." | Enter free input mode |
| 2 | `submitMessage` | `setIsFreeInputMode(false)` | Successful message send | Reset after submission |
| 3 | `handleMessageChange` (empty) | `setIsFreeInputMode(false)` | User deletes all text | Reset when input cleared |
| 4 | `handleCommandCancel` | `setIsFreeInputMode(false)` | Escape key pressed | Cancel free input mode |
| 5 | Mobile command button | `setIsFreeInputMode(false)` | User taps command button | Reset before showing selector |

The lifecycle is clean: one entry point (path 1), four exit points (paths 2-5) covering all user actions that should end free input mode.

---

## WorktreeDetailRefactored Dual-Rendering Verification

`WorktreeDetailRefactored.tsx` renders `MessageInput` in two locations:

1. **Desktop layout** (L1802-1807): Inside a `flex-shrink-0` div with border styling
2. **Mobile layout** (L2038-2043): Inside a fixed-position div above the tab bar

Both instances receive identical props:

```typescript
<MessageInput
  worktreeId={worktreeId}
  onMessageSent={handleMessageSent}
  cliToolId={activeCliTab}
  isSessionRunning={state.terminal.isActive}
/>
```

Since `isFreeInputMode` is a component-level `useState`, each instance maintains independent state. Only one layout is rendered at a time (conditional rendering based on `isMobile`), so there is no state synchronization concern. This is correct behavior.

---

## Test Impact Assessment

### Existing Test Compatibility

| Test File | Risk | Analysis |
|-----------|------|----------|
| `MessageInput.test.tsx` (existing 8 tests) | Low | Existing tests mock `useSlashCommands` with `groups: []`, which means no commands are available and the selector logic is never triggered. The existing tests cover: Enter submit, Shift+Enter newline, mobile Enter behavior, IME composition, accessibility, and basic rendering. None of these test the selector/free-input interaction, so they remain unaffected. |
| `SlashCommandSelector.test.tsx` (existing 10 tests) | None | Tests SlashCommandSelector in isolation with controlled `isOpen` prop. No dependency on MessageInput internal state. |
| `WorktreeDetailRefactored.test.tsx` | None | Mocks child components. MessageInput props unchanged. |
| `issue-266-acceptance.test.tsx` | None | Mocks MessageInput entirely. Tracks mount/unmount only. |

### New Test Requirements

The 7 new test cases (TC-1 through TC-7) require the `useSlashCommands` mock to return non-empty `groups` so that the `SlashCommandSelector` renders and the free-input button is available. This mock override should be scoped to the new `describe` block to avoid affecting existing tests.

---

## Risk Assessment

| Risk Category | Level | Rationale |
|---------------|-------|-----------|
| Technical | Low | Single boolean state addition. No complex state interactions. All state mutation paths analyzed and verified. |
| Security | Low | UI state management only. No user input processing changes. Existing sanitization (`message.trim()`) and API call (`worktreeApi.sendMessage`) paths unchanged. |
| Operational | Low | No configuration, deployment, or runtime behavior changes. No database or API modifications. |

---

## Improvement Recommendations

### Must Fix (0 items)

None. The impact scope is accurately defined in the design document and all affected/unaffected files are correctly identified.

### Should Fix (0 items)

None. The analysis found no gaps or inaccuracies in the impact assessment.

### Consider (3 items)

| ID | Title | Principle | Detail |
|----|-------|-----------|--------|
| C-001 | Existing test mock modification strategy | Test Quality | New test cases require `useSlashCommands` mock with command groups. Ensure mock overrides are scoped to avoid leaking into existing test suites. Use `vi.mocked(useSlashCommands).mockReturnValue(...)` within the new describe block or use nested mock setup. |
| C-002 | Dual MessageInput rendering awareness | Maintainability | WorktreeDetailRefactored renders MessageInput at L1802 (desktop) and L2038 (mobile). While only one is active at a time, future developers should be aware that isFreeInputMode is independent per instance. No action required, but worth documenting in a code comment if the dual-rendering pattern is not immediately obvious. |
| C-003 | e2e test coverage for free input mode | Test Quality | No e2e tests exist for slash command or free input mode workflows. While the unit test coverage for Issue #288 is comprehensive, adding e2e coverage for the full flow (open selector, click free input, type command, press Enter) would provide additional confidence. Outside the scope of this issue. |

---

## Conclusion

The design document's impact analysis is accurate and complete. The change scope is well-contained within `MessageInput.tsx` and its test file. All indirect dependencies have been verified to require no modifications. The `MessageInputProps` interface remains unchanged, ensuring zero risk of breaking changes to parent components or re-export modules. The dual-rendering of MessageInput in WorktreeDetailRefactored is compatible with the internal state approach.

**Approval Status**: Approved without conditions.

---

*Generated by architecture-review-agent for Issue #288, Stage 3 (Impact Analysis)*
*Date: 2026-02-17*
