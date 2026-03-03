# Architecture Review Report - Issue #391 Stage 3 (Impact Analysis)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #391 |
| Stage | 3 - Impact Analysis Review |
| Focus | Impact Scope |
| Status | Conditionally Approved |
| Score | 4/5 |
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 4 |
| Risk Level | Low |

Issue #391 addresses a bug where unchecking an agent checkbox in `AgentSettingsPane` results in automatic re-checking due to polling-driven server value overwrite. The design policy proposes a combined approach: Plan A (isEditing flag guard in `AgentSettingsPane`) and Plan B (value equality check in `WorktreeDetailRefactored`).

This Stage 3 review evaluates the **impact scope** of the proposed changes, analyzing component dependencies, test coverage, state management propagation, performance implications, and uncovered edge cases.

---

## Impact Map

### Direct Impacts (3 files)

| File | Change Type | Description | Risk |
|------|------------|-------------|------|
| `src/components/worktree/AgentSettingsPane.tsx` | Modify | Add `isEditing` state, useEffect guard, handleCheckboxChange modification | Low |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Modify | Add `selectedAgentsRef`, array equality check in fetchWorktree | Low |
| `tests/unit/components/worktree/AgentSettingsPane.test.tsx` | Modify | Existing test updates + T1-T4 new test cases | Low |

### Indirect Impacts (3 areas)

| Area | Impact Type | Description |
|------|------------|-------------|
| `NotesAndLogsPane.tsx` | No code change | Props pass-through only. No interface change required |
| `activeCliTab` sync useEffect (L1116-1122) | Positive improvement | Plan B equality check reduces unnecessary activeCliTab sync triggers |
| CLI tool tab rendering (Desktop L1873, Mobile L2167) | Positive improvement | Reduced unnecessary re-renders from stable selectedAgents reference |

### Unaffected (7 files confirmed)

| File | Reason |
|------|--------|
| `src/app/api/worktrees/[id]/route.ts` | Server-side validation/persistence unchanged. Client-only fix |
| `src/lib/selected-agents-validator.ts` | Validation logic unchanged |
| `src/lib/cli-tools/types.ts` | Type definitions unchanged |
| `src/components/sidebar/BranchListItem.tsx` | Uses cliStatus field, no direct selectedAgents reference |
| `src/types/models.ts` | Worktree type definition unchanged |
| `src/lib/db.ts` | DB schema/queries unchanged |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | Existing mocks unaffected by equality check addition |

---

## Detailed Findings

### S3-001 [Should Fix] - vibeLocalContextWindow sync needs same equality check pattern

**Category**: State Impact
**Location**: Design policy Section 3-2 / WorktreeDetailRefactored fetchWorktree L1039-1045

The design policy describes Plan B's equality check for `selectedAgents`, but `vibeLocalContextWindow` (L1043-1045) and `vibeLocalModel` (L1039-1041) in `fetchWorktree` have the identical unconditional `setState` pattern on every poll. Specifically, `vibeLocalContextWindow` is coupled with a `useEffect` sync in `AgentSettingsPane` (L103-107) that mirrors the `selectedAgents` sync pattern exactly.

While the `contextWindowInput` case is less likely to surface visually (because it uses blur-triggered save rather than checkbox), the architectural inconsistency creates a maintenance trap: future developers may not realize the same fix pattern needs to apply.

**Suggestion**: Either apply equality checks to `vibeLocalModel` and `vibeLocalContextWindow` in the same change, or explicitly note in the design policy's impact scope section (Section 5) that these fields share the same pattern and are intentionally scoped out.

---

### S3-002 [Nice to Have] - Plan B indirect test strategy clarification

**Category**: Test Impact
**Location**: Design policy Section 4-3

Section 4-3 excludes `WorktreeDetailRefactored` unit tests, stating "indirect verification via AgentSettingsPane integration test." However, AgentSettingsPane tests operate via prop rerender, which does not exercise Plan B's fetchWorktree equality check logic at all. The actual Plan B logic (array comparison + setState skip) has no direct or indirect test coverage.

**Suggestion**: Consider one of: (a) Add a Plan B verification test in `WorktreeDetailRefactored.test.tsx`, (b) Extract array comparison to `arraysEqual()` utility function (as mentioned in S1-008) and unit test it separately, or (c) Keep current scope-out decision but document the rationale (low risk, 3 lines of inline logic).

---

### S3-003 [Nice to Have] - Mobile layout path not mentioned in impact scope

**Category**: Component Impact
**Location**: Design policy Section 5

The mobile rendering path (L2219-2249) passes `selectedAgents` to `MobileContent`, which further relays it to `NotesAndLogsPane`. Plan B's equality check benefits mobile rendering by preventing unnecessary `MobileContent` re-renders, but the design policy's impact scope section does not mention mobile at all.

**Suggestion**: Add a note: "Mobile layout: selectedAgents is relayed via MobileContent. Plan B equality check also prevents unnecessary re-renders on mobile. No code change required."

---

### S3-004 [Nice to Have] - memo() wrapper interaction mechanism

**Category**: Performance
**Location**: Design policy Section 7

`AgentSettingsPane` is wrapped with `React.memo()` (L65). Plan B's equality check ensures React state identity is preserved when values haven't changed, which allows `memo()` shallow comparison to correctly skip re-renders. Without Plan B, each polling cycle creates a new array reference via `setSelectedAgents()`, defeating `memo()`. This interaction mechanism is not documented in the performance design section.

**Suggestion**: Add to performance section: "Plan B preserves React state reference identity, enabling memo() on AgentSettingsPane/NotesAndLogsPane to correctly skip re-renders."

---

### S3-005 [Should Fix] - Sub-tab switching as isEditing reset path

**Category**: State Impact
**Location**: Design policy Section 3-1 [S1-007]

When a user unchecks an agent (isEditing=true) and then switches to the "Notes" or "Logs" sub-tab within `NotesAndLogsPane`, the `AgentSettingsPane` component is unmounted. Upon returning to the "Agent" sub-tab, it re-mounts with `isEditing = false` (useState initial value), and `checkedIds` is initialized from the `selectedAgents` prop.

S1-007 lists "page reload / re-mount" as recovery paths, but does not mention sub-tab switching within `NotesAndLogsPane`, which is a natural and common user action. This implicit recovery path significantly reduces the practical impact of the known limitation.

**Suggestion**: Expand S1-007 to include: "In addition to page reload/re-mount, switching to Notes/Logs sub-tabs within NotesAndLogsPane also triggers AgentSettingsPane unmount/re-mount, resetting isEditing. This makes the practical impact of isEditing=true persistence lower than initially assessed."

---

### S3-006 [Nice to Have] - Multi-tab/multi-window scenario documentation

**Category**: State Impact
**Location**: Design policy Section 3-1 [S1-007]

When the same worktree is open in multiple browser tabs, Tab A changing `selectedAgents` will be picked up by Tab B's polling. Plan B's equality check in Tab B correctly detects the value difference and updates. However, if Tab B is in isEditing=true state when Tab A's change is polled, the change is suppressed (Plan A guard). This multi-tab behavior falls under S1-007's known limitation but is not explicitly mentioned.

**Suggestion**: Add to S1-007: "In multi-tab/multi-window scenarios, changes made in other tabs are similarly suppressed during isEditing=true state."

---

## Risk Assessment

| Risk Type | Content | Severity | Probability | Priority |
|-----------|---------|----------|-------------|----------|
| Technical | Plan A/B interaction correctness | Low | Low | P3 |
| State Management | isEditing reset via sub-tab switch | Low | Medium | P2 |
| Performance | Unnecessary re-render reduction | Positive | N/A | N/A |
| Test Coverage | Plan B logic untested | Low | Low | P3 |
| Multi-tab | isEditing suppression across tabs | Low | Low | P3 |

---

## Component Dependency Analysis

```
WorktreeDetailRefactored (state owner)
  |
  |-- [Plan B] fetchWorktree: selectedAgentsRef equality check
  |       |
  |       +-- setSelectedAgents() (skipped when equal)
  |              |
  |              +-- triggers useEffect [selectedAgents, activeCliTab]
  |              |       |
  |              |       +-- activeCliTab sync (L1116-1122)
  |              |
  |              +-- re-render children:
  |                    |
  |                    +-- [Desktop] CLI tool tab switcher (L1873)
  |                    +-- [Mobile] CLI tool tab switcher (L2167)
  |                    +-- [Desktop] NotesAndLogsPane (L1977)
  |                    +-- [Mobile] MobileContent -> NotesAndLogsPane (L2240)
  |
  +-- NotesAndLogsPane (props relay, memo)
        |
        +-- AgentSettingsPane (memo)
              |
              +-- [Plan A] isEditing state
              +-- [Plan A] useEffect guard: if (!isEditing) setCheckedIds(...)
              +-- handleCheckboxChange: setIsEditing(true/false)
```

---

## Improvement Recommendations

### Must Fix (0 items)

No must-fix items identified. The design is sound and the impact scope is well-contained.

### Should Fix (2 items)

1. **S3-001**: Document or apply equality check pattern to vibeLocalContextWindow/vibeLocalModel in fetchWorktree for architectural consistency.
2. **S3-005**: Expand S1-007 known limitation to include sub-tab switching as an isEditing reset path, which reduces the practical impact assessment.

### Consider (4 items)

1. **S3-002**: Clarify test strategy for Plan B logic (currently untested).
2. **S3-003**: Note mobile layout path in impact scope section.
3. **S3-004**: Document memo() interaction mechanism in performance section.
4. **S3-006**: Document multi-tab/multi-window scenario in S1-007.

---

## Conclusion

The proposed design has a well-contained impact scope limited to 3 files with no interface changes. The combination of Plan A (isEditing guard) and Plan B (equality check) provides effective defense-in-depth against the polling-driven re-check bug. The indirect benefits (reduced re-renders, preserved memo() effectiveness) are positive side effects.

The should-fix items are documentation-level improvements that do not affect implementation correctness. The design is approved to proceed to Stage 4 (Security Review).

---

*Reviewed: 2026-03-02*
*Reviewer: Architecture Review Agent (Claude Opus 4.6)*
*Stage: 3 of 4 - Impact Analysis Review*
