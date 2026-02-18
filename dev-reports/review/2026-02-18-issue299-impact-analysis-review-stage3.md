# Architecture Review Report: Issue #299 Stage 3 (Impact Analysis)

## Summary

| Item | Detail |
|------|--------|
| Issue | #299 iPad/smartphone layout/fullscreen issues |
| Stage | 3 - Impact Analysis |
| Focus | Impact Scope (影響範囲) |
| Status | Conditionally Approved |
| Score | 4/5 |
| Date | 2026-02-18 |

## Executive Summary

Stage 3 focuses on the impact scope of the proposed changes in the design policy for Issue #299. The design policy proposes changes across three areas: z-index unification, iPad responsive adjustments, and swipe/scroll separation. The impact analysis reveals that the design policy is well-structured with manageable risk, but requires additional detail in several areas, particularly regarding stacking context behavior when Toast components render inside Modal/Portal hierarchies, and the implementation approach for z-index migration (className vs style attribute).

The overall risk is **medium** on the technical side (due to z-index stacking context complexity) and **low** on security and operational fronts (no user input processing changes, no data model changes).

---

## Detailed Findings

### F001 [Must Fix] - Toast stacking context analysis within Modal/Portal hierarchy

**Category**: Impact Scope
**Location**: Design policy section 3.1 (z-index unification / Toast.tsx impact analysis)

**Issue**: The design policy's z-index conflict analysis focuses on the top-level DOM relationship between Toast, Modal, and other z-50 components. However, it does not account for the fact that `ToastContainer` is rendered **inside** `MarkdownEditor.tsx` (line 880), not at the document.body level. When MarkdownEditor is displayed inside a Modal (e.g., `WorktreeDetailRefactored.tsx` line 1875 wraps MarkdownEditor in `<Modal>`), the Toast exists within Modal's stacking context. When MarkdownEditor enters fullscreen via CSS fallback, the editor content (including Toast) is portaled to document.body with z-index 55 (`Z_INDEX.MAXIMIZED_EDITOR`).

The design policy states that changing Toast from z-50 to z-60 ensures `Modal(50) < Toast(60)`, but this ordering only applies within the same stacking context. Since Toast is a child of MarkdownEditor (which may be inside Modal), the effective z-index of Toast relative to external elements is governed by its ancestor's z-index, not its own.

**Actual impact**: In practice, this is not a functional issue because:
1. In normal mode (Modal open with MarkdownEditor inside): Toast(z-60) appears above MarkdownEditor content within the Modal -- correct behavior.
2. In fullscreen fallback mode (Portal to body with z-55): Toast(z-60) appears above the editor within the z-55 stacking context -- correct behavior.
3. Toast never needs to appear above elements outside its ancestor stacking context in this design.

**Suggestion**: Add stacking context analysis to section 3.1 documenting these three scenarios explicitly, confirming that Toast's relative positioning within its parent stacking context is sufficient for all use cases.

---

### F002 [Should Fix] - ContextMenu(z-70) wave effect on other z-50 components

**Category**: Wave Effect
**Location**: Design policy section 3.1 / ContextMenu.tsx (line 228)

**Issue**: Changing ContextMenu from z-50 to Z_INDEX.CONTEXT_MENU(70) creates a new z-index ordering where ContextMenu is now higher than MobilePromptSheet(z-50), SlashCommandSelector(z-50), and AppShell drawer(z-50). Previously, all these components shared z-50 and relied on DOM order for stacking.

The design policy marks ContextMenu change as "recommended" but does not analyze whether ContextMenu and MobilePromptSheet/SlashCommandSelector could coexist on screen.

**Actual risk**: Low. ContextMenu is triggered by right-click/long-press on file tree items, while MobilePromptSheet and SlashCommandSelector are triggered by prompt interactions. These UI elements are mutually exclusive in practice -- users cannot right-click a file while simultaneously interacting with a prompt sheet. Additionally, on mobile where MobilePromptSheet is used, right-click context menus are accessed via long-press, and the prompt sheet would be dismissed before file interaction.

**Suggestion**: Document this mutual exclusivity analysis in the design policy to justify why the z-70 elevation does not cause operational conflicts.

---

### F003 [Should Fix] - Toast/ContextMenu z-index change implementation method undefined

**Category**: Regression Risk
**Location**: Design policy section 3.1 / Phase 1 checklist

**Issue**: The design policy specifies that Modal.tsx should use `style={{ zIndex: Z_INDEX.MODAL }}` (inline style), but does not specify whether Toast.tsx and ContextMenu.tsx should use the same approach or Tailwind utility classes (e.g., `z-[60]`).

Current implementation:
- Toast.tsx (L205): `className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"` -- className-based
- ContextMenu.tsx (L228): `className="fixed z-50 min-w-[160px] ..."` -- className-based
- Modal.tsx (L86): `className="fixed inset-0 z-[9999] overflow-y-auto"` -- className-based, changing to style-based

This inconsistency means implementers must decide independently which approach to use. The existing test `Toast.test.tsx` line 296-304 checks `fixed`, `bottom-4`, `right-4` classes but not `z-50`, so either approach would pass existing tests.

**Suggestion**: Standardize the approach in the design policy. Recommend `style={{ zIndex: Z_INDEX.TOAST }}` for consistency with Modal.tsx, and note that the `z-50` class must be removed from the className string when switching to inline style.

---

### F004 [Should Fix] - useSwipeGesture test strategy and isInsideScrollableElement visibility

**Category**: Impact Scope
**Location**: Design policy section 3.3 and section 9 (test strategy)

**Issue**: The `useSwipeGesture` hook is used only by `MarkdownEditor.tsx` (confirmed via codebase search). This is correctly identified in the design policy. However:

1. The visibility of `isInsideScrollableElement` (export vs module-private) is not specified.
2. The existing test file (`tests/unit/hooks/useSwipeGesture.test.ts`) contains only initialization and cleanup tests (no DOM event simulation). Testing `isInsideScrollableElement` behavior requires either exporting the function for direct unit testing or constructing DOM elements with `overflow-y: auto/scroll` and `scrollHeight > clientHeight` in jsdom. The design policy's test strategy section mentions "scrollable element swipe suppression test" but does not address the jsdom limitation with `getComputedStyle` and `scrollHeight`.

**Suggestion**: Specify that `isInsideScrollableElement` is a module-private helper (not exported) per SRP. For testing, recommend an integration-style test that creates a scrollable DOM element, attaches the hook's ref, and fires touch events to verify swipe suppression. Note that jsdom's `getComputedStyle` returns empty strings by default, so `element.style.overflowY = 'auto'` must be set directly. Similarly, `scrollHeight` must be mocked via `Object.defineProperty`.

---

### F005 [Should Fix] - iPad layout numerical analysis missing for portrait mode

**Category**: Impact Scope
**Location**: Design policy section 3.2 (iPad responsive adjustments)

**Issue**: The design policy confirms that `useIsMobile` breakpoint (768px) and Tailwind `md:pl-72` (768px) are aligned. For iPad landscape (1024px), the content area is 1024 - 288 = 736px, which is adequate for the two-column layout in `WorktreeDesktopLayout.tsx` (minimum pane width: 20% of 736 = 147px).

However, iPad portrait (768px) is at the exact breakpoint boundary. Since `useIsMobile` returns `false` when `window.innerWidth >= 768`, iPad portrait (768px viewport) triggers the desktop layout with sidebar. Content area = 768 - 288 = 480px. The two-column layout splits this into minimum 96px (20%) and maximum 384px (80%) panes. At 96px, the smaller pane is nearly unusable for displaying history or terminal content.

The design policy states AppShell/WorktreeDesktopLayout changes are "as needed" but lacks this numerical justification.

**Suggestion**: Add concrete calculations to section 3.2 for both iPad orientations. For portrait (480px content), consider whether Phase 3 should adjust `WorktreeDesktopLayout` to use single-column mode when content width is below a threshold (e.g., < 600px), or increase the `minLeftWidth` to prevent extremely narrow panes.

---

### F006 [Nice to Have] - Explicit regression test pass confirmation in Phase 4

**Category**: Regression Risk
**Location**: Design policy section 12 (Phase 4 test checklist)

**Issue**: The existing test suite is confirmed to be unaffected by the proposed changes:
- `Toast.test.tsx`: Does not assert z-index classes directly.
- `AppShell.test.tsx`: Mocks `useIsMobile`; no breakpoint value dependency.
- `useSwipeGesture.test.ts`: Initialization-only tests; `isInsideScrollableElement` addition does not break existing tests.

However, the design policy's Phase 4 checklist does not include an explicit step for running the full existing test suite (`npm run test:unit`) to verify no regressions.

**Suggestion**: Add "Run full test suite (npm run test:unit) and confirm all existing tests pass" as a Phase 4 checklist item.

---

### F007 [Nice to Have] - SearchBar.tsx MOBILE_BREAKPOINT import context note

**Category**: Wave Effect
**Location**: Design policy section 3.2 / SearchBar.tsx

**Issue**: `MOBILE_BREAKPOINT` is currently exported from `useIsMobile.ts` (line 15) but not imported by any other file in the codebase. SearchBar.tsx will be the first consumer outside of `useIsMobile.ts` itself. The change is purely a constant reference unification (768 -> `MOBILE_BREAKPOINT`) with no behavioral change. However, SearchBar.tsx uses `window.innerWidth < 768` in a `useEffect` initial run without resize tracking, while `useIsMobile` tracks resize events. This difference could confuse future maintainers.

**Suggestion**: Add a code comment in the SearchBar.tsx change noting that `MOBILE_BREAKPOINT` is used for initial autofocus determination only, and `useIsMobile` hook is intentionally not used because resize tracking is unnecessary for this use case.

---

### F008 [Nice to Have] - Header.tsx is unused component in z-50 inventory

**Category**: Impact Scope
**Location**: Design policy section 3.1 (z-50 component inventory)

**Issue**: `Header.tsx` (line 25, `z-50`) is listed in the z-50 hardcoded component inventory but is not imported or used by any component in the codebase (confirmed via grep). It appears to be a legacy/unused component. Its presence in the inventory does not affect the design policy's conclusions but could cause confusion during implementation.

**Suggestion**: Add "(currently unused)" annotation to the Header.tsx entry in the component inventory table.

---

## Impact Scope Analysis

### Direct Changes

| File | Change | Risk | Test Impact |
|------|--------|------|-------------|
| `src/config/z-index.ts` | JSDoc comment update | Low | None |
| `src/components/ui/Modal.tsx` | z-[9999] to Z_INDEX.MODAL(50) | High | No existing Modal tests |
| `src/components/common/Toast.tsx` | z-50 to Z_INDEX.TOAST(60) | Low | Toast.test.tsx unaffected |
| `src/components/worktree/ContextMenu.tsx` | z-50 to Z_INDEX.CONTEXT_MENU(70) | Low | No existing ContextMenu tests |
| `src/hooks/useSwipeGesture.ts` | isInsideScrollableElement addition | Low | useSwipeGesture.test.ts unaffected |
| `src/components/worktree/MarkdownEditor.tsx` | threshold 100 to 150 | Low | No existing threshold tests |
| `src/components/worktree/SearchBar.tsx` | 768 to MOBILE_BREAKPOINT | Low | No existing SearchBar tests |

### Indirect Impact (Not Modified but Affected)

| File | Impact | Risk |
|------|--------|------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Uses Modal (8 instances) -- Modal z-index change affects all | Medium |
| `src/components/worktree/FileViewer.tsx` | Uses Modal -- affected by z-index change | Low |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | Uses Modal -- affected by z-index change | Low |
| `src/components/worktree/MoveDialog.tsx` | Uses Modal -- affected by z-index change | Low |
| `src/components/external-apps/ExternalAppForm.tsx` | Uses Modal -- affected by z-index change | Low |
| `src/components/layout/AppShell.tsx` | Mobile drawer z-50 unchanged, but Modal now same value | Low (DOM order ensures Modal on top) |
| `src/components/mobile/MobilePromptSheet.tsx` | z-50 unchanged, but ContextMenu now z-70 | Low (mutually exclusive UI) |
| `src/components/worktree/SlashCommandSelector.tsx` | z-50 unchanged | Low |

### No Impact (Scope Out)

| File | Reason |
|------|--------|
| `src/components/layout/Header.tsx` | z-50 unchanged, also unused component |
| `src/components/sidebar/SortSelector.tsx` | z-50 unchanged, scope out |
| `src/components/mobile/MobileHeader.tsx` | z-40 unchanged, scope out |
| `src/components/mobile/MobileTabBar.tsx` | z-40 unchanged, scope out |

---

## Risk Assessment

| Risk Type | Level | Details | Mitigation |
|-----------|-------|---------|------------|
| Technical | Medium | Modal z-index reduction from 9999 to 50 changes stacking behavior for 8 consuming components | createPortal DOM order guarantees Modal on top of z-50 peers; body.style.overflow blocks backdrop interaction |
| Regression (Desktop) | Low | z-index changes are transparent to desktop layout; sidebar uses Z_INDEX.SIDEBAR(30) | Existing AppShell.test.tsx confirms desktop layout behavior |
| Regression (Mobile) | Low | Mobile drawer(z-50) and MobileHeader(z-40) unchanged; Modal with new z-50 uses Portal for body-level stacking | Manual testing on mobile devices recommended |
| Regression (Tests) | Low | No existing test directly asserts z-index values | Phase 4 should include full test suite run |
| Security | Low | No user input handling changes; no API changes | N/A |
| Operational | Low | No data model or configuration changes | N/A |

---

## Approval Status

**Conditionally Approved (4/5)**

The design policy demonstrates thorough impact analysis for the z-index unification and responsive adjustments. The must-fix item (F001: Toast stacking context documentation) is a documentation enhancement that does not block implementation but ensures the design rationale is complete. The should-fix items improve implementation clarity and reduce ambiguity for Phase 3 and Phase 4.

### Conditions for Full Approval

1. **F001**: Add stacking context analysis for Toast rendering within Modal/Portal hierarchies
2. **F003**: Specify z-index implementation method (className vs style attribute) for Toast.tsx and ContextMenu.tsx
3. **F005**: Add numerical layout analysis for iPad portrait (768px) content area adequacy

---

*Generated by architecture-review-agent for Issue #299 Stage 3*
*Date: 2026-02-18*
