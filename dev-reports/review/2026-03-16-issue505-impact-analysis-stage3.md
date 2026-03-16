# Issue #505 Impact Analysis Review (Stage 3)

**Date**: 2026-03-16
**Review Type**: Impact Analysis (Stage 3 of Multi-Stage Design Review)
**Design Doc**: `dev-reports/design/issue-505-file-link-navigation-design-policy.md`
**Overall Assessment**: PASS WITH FINDINGS
**Risk Level**: LOW

---

## Executive Summary

The design policy for Issue #505 (File Link Navigation) accurately identifies the core affected files and describes the callback propagation chain, security layers, and state management changes. The impact analysis found 10 items: 5 should-fix findings and 5 nice-to-have findings. No must-fix issues were identified at this stage. The primary gaps are a potentially missing intermediate component (WorktreeDetailSubComponents.tsx) and the need to promote MarpEditorWithSlides onOpenFile forwarding from nice-to-have to should-fix.

---

## Checklist Results

| Check Item | Status | Notes |
|-----------|--------|-------|
| All affected files identified | PARTIAL | WorktreeDetailSubComponents.tsx may be missing (DR3-001) |
| Downstream components checked | PARTIAL | Need to verify WDR -> SubComponents -> FilePanelSplit chain |
| Existing tests impact | PASS | Tests use MAX_FILE_TABS constant dynamically; no breakage |
| Existing functionality regression | PASS | All new props are optional; no behavior changes |
| State management impact | PASS | useReducer extension is additive; localStorage impact minimal |
| API impact | PASS | No backend changes needed |
| Build/bundle impact | PASS | No new dependencies; rehype-sanitize already installed |
| Accessibility impact | PARTIAL | Dropdown keyboard navigation not specified (DR3-007) |
| Browser compatibility | PASS | new URL() widely supported; file:/// normalization is standard |
| Migration/rollback | PASS | RESTORE slice ensures safe truncation |

---

## Findings

### DR3-001 [should_fix] WorktreeDetailSubComponents.tsx Missing from Affected Files

WorktreeDetailSubComponents.tsx is imported by WorktreeDetailRefactored.tsx and receives `onFilePathClick` and `onFileSelect` callbacks (confirmed at WDR lines 1717-1718). If this component serves as an intermediate layer between WDR and FilePanelSplit, it would also need the `onOpenFile` prop for the callback chain to work correctly.

**Action**: Verify whether WorktreeDetailSubComponents.tsx is in the callback path to FilePanelSplit. If yes, add it to Section 9 of the design doc.

### DR3-002 [should_fix] Existing useFileTabs.test.ts - No Breakage Confirmed

The existing test file at `tests/unit/hooks/useFileTabs.test.ts` imports `MAX_FILE_TABS` from the hook and uses it dynamically in test fixtures (e.g., `Array.from({ length: MAX_FILE_TABS })`). Changing the value from 5 to 30 will not break any existing tests. The test fixture at line 51 generates MAX_FILE_TABS tabs to test the limit - this will generate 30 tabs instead of 5, which is functionally correct but larger.

**Action**: Add a note confirming test compatibility. Consider a focused regression test for the specific value 30.

### DR3-003 [should_fix] MarpEditorWithSlides Needs onOpenFile Forwarding

The design doc lists MarpEditorWithSlides onOpenFile as DR2-006 (nice_to_have). However, the actual code at FilePanelContent.tsx lines 396-401 shows MarpEditorWithSlides renders MarkdownEditor in editor mode. Since MarkdownEditor will accept onOpenFile, MarpEditorWithSlides must forward it for link navigation to work in MARP editor mode. This is a functional gap, not merely a nice-to-have.

**Action**: Promote DR2-006 to should_fix. Update MarpEditorWithSlides inline type definition to include `onOpenFile?: (path: string) => void`.

### DR3-004 [nice_to_have] Browser Compatibility Edge Cases for new URL()

The `resolveRelativePath` function uses `new URL(href, 'file:///')`. While widely supported, the file:/// protocol handling has subtle cross-browser differences for edge cases (spaces, Unicode, empty paths). The design correctly positions this as a UX check with server-side validation as the security boundary.

**Action**: Add test cases for paths with spaces, Unicode characters, and boundary conditions.

### DR3-005 [should_fix] localStorage Size Impact Confirmed Acceptable

With MAX_FILE_TABS=30, up to 30 paths (~6KB) per worktree may be stored. This is well within localStorage limits (5-10MB typical). The RESTORE action's `paths.slice(0, MAX_FILE_TABS)` ensures backward compatibility if the limit is later reduced.

**Action**: Add a brief confirmation note to Section 7-3 of the design doc.

### DR3-006 [should_fix] FilePanelTabs.test.tsx Mock Needs Update

The existing test at `tests/unit/components/FilePanelTabs.test.tsx` mocks FilePanelContent with a simplified component that only destructures `{ tab }`. After adding onOpenFile to props, the mock should be updated to reflect the new interface, even though the optional nature of the prop means existing tests will not break.

**Action**: Update the mock in the test file to include onOpenFile in its destructured props.

### DR3-007 [nice_to_have] Dropdown Menu Accessibility

The dropdown UI for tabs 6+ does not specify keyboard navigation requirements. For WCAG compliance, the menu should support Arrow keys, Enter, Space, Escape, and proper ARIA roles.

**Action**: Add accessibility requirements to Section 5-3 as a recommended implementation detail.

### DR3-008 [nice_to_have] No New Dependencies - Positive Finding

rehype-sanitize (^6.0.0) is already in package.json. The new link-utils.ts has zero external dependencies. No bundle size increase is expected.

### DR3-009 [should_fix] MarkdownEditor filePath Reuse as currentFilePath

MarkdownEditor already has a `filePath` prop (confirmed at line 110 of MarkdownEditor.tsx via EditorProps). This can be directly passed as `currentFilePath` to MarkdownPreview without adding a new prop. The design doc should explicitly confirm this reuse to avoid confusion.

**Action**: Add a note in the design doc confirming that MarkdownEditor's existing `filePath` prop is reused as `currentFilePath` for MarkdownPreview.

### DR3-010 [nice_to_have] Rollback Safety - Positive Finding

The RESTORE action at line 222 of useFileTabs.ts already slices to MAX_FILE_TABS. This means a rollback from 30 to 5 would safely truncate persisted data. The MOVE_TO_FRONT action would be silently ignored by older code (reducer default case returns current state).

---

## Risk Assessment

| Risk Area | Level | Rationale |
|----------|-------|-----------|
| Overall | LOW | Additive changes with optional props throughout |
| Callback Drilling (7 layers) | MEDIUM | Silent failure if intermediate component is missed |
| MarpEditorWithSlides | MEDIUM | Link navigation in MARP editor mode will not work without forwarding |
| MAX_FILE_TABS change | LOW | Backward compatible via RESTORE slicing |
| localStorage | LOW | ~6KB per worktree at maximum |
| rehype-sanitize schema | LOW | Existing dependency, configuration change only |
| Browser compatibility | LOW | Standard APIs with server-side fallback |

---

## Summary of Recommendations

| Priority | ID | Action |
|----------|-----|--------|
| should_fix | DR3-001 | Verify WorktreeDetailSubComponents.tsx in callback chain |
| should_fix | DR3-003 | Promote MarpEditorWithSlides onOpenFile to should_fix |
| should_fix | DR3-006 | Update FilePanelTabs.test.tsx mock for new props |
| should_fix | DR3-009 | Confirm MarkdownEditor filePath reuse as currentFilePath |
| should_fix | DR3-005 | Confirm localStorage math in design doc |
| nice_to_have | DR3-007 | Add dropdown accessibility requirements |
| nice_to_have | DR3-004 | Add edge case tests for resolveRelativePath |

---

*Generated by architecture-review-agent for Issue #505 Stage 3 (Impact Analysis)*
*Review Date: 2026-03-16*
