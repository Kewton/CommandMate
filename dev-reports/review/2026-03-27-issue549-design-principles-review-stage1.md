# Architecture Review: Issue #549 - Design Principles (Stage 1)

**Issue**: #549 - Mobile Markdown Viewer Default Tab
**Focus**: Design Principles (SOLID / KISS / YAGNI / DRY)
**Date**: 2026-03-27
**Status**: Approved
**Score**: 4/5

---

## Executive Summary

The design policy for Issue #549 proposes a minimal, well-scoped change to set the default tab to "preview" when opening Markdown files on mobile devices. The approach involves two coordinated changes: a useEffect in MarkdownEditor.tsx and an initialViewMode prop addition in WorktreeDetailRefactored.tsx.

The design demonstrates good adherence to design principles overall. It correctly rejects over-engineered alternatives (mobile-specific localStorage, viewMode='preview') and reuses existing hooks and props. Two areas for improvement were identified: the useEffect-based initialization adds a secondary responsibility to an already large component (SRP concern), and the two-change coordination could be simplified to a single declarative prop (KISS concern). Neither issue is blocking.

---

## Design Principles Checklist

### Single Responsibility Principle (SRP)

**Status**: Pass with note

MarkdownEditor.tsx is already a large component managing editor content, view modes, saving, fullscreen, split ratio, auto-save, swipe gestures, and virtual keyboard. The proposed useEffect adds device-detection-dependent initialization as yet another concern.

The change itself is only 3 lines, so the practical impact is small. However, extracting this into a `useInitialMobileTab(isMobile)` hook would improve testability and keep the component body focused on rendering.

### Open/Closed Principle (OCP)

**Status**: Pass

No existing interfaces or types are modified. The `initialViewMode` prop already exists in `EditorProps`. The new behavior is added through existing extension points (props + useEffect), which is the correct approach.

### Liskov Substitution Principle (LSP)

**Status**: Not applicable

No class hierarchies or substitutable types are involved in this change.

### Interface Segregation Principle (ISP)

**Status**: Pass

The `EditorProps` interface is not modified. `initialViewMode` is already defined as an optional prop. No consumers are forced to provide new required props.

### Dependency Inversion Principle (DIP)

**Status**: Pass

The `useIsMobile` hook provides an abstraction over viewport detection. The MarkdownEditor depends on this abstraction rather than directly querying `window.innerWidth`.

### KISS (Keep It Simple, Stupid)

**Status**: Pass with note

The solution is minimal: 2 files, approximately 5 lines of changes. However, the two changes are tightly coupled in a non-obvious way:

1. `initialViewMode='split'` is required so that `showMobileTabs` evaluates to `true`
2. The useEffect then sets `mobileTab='preview'` within that split view

Without understanding the `showMobileTabs = isMobilePortrait && viewMode === 'split'` condition, one might not realize why `initialViewMode='split'` is necessary. A single `initialMobileTab` prop would make the intent more self-documenting.

### YAGNI (You Aren't Gonna Need It)

**Status**: Pass

The design correctly rejects:
- Mobile-specific localStorage key (labeled as over-engineering)
- Tablet/landscape mode changes (out of scope)
- filePath-dependent tab reset (preserves user choice)

No unnecessary features or abstractions are introduced.

### DRY (Don't Repeat Yourself)

**Status**: Pass

No duplication is introduced. The design reuses the existing `useIsMobile` hook, `initialViewMode` prop, and `MobileTabBar` component.

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | useEffect flash (editor visible before preview) | Low | Low | P3 |
| Technical | Two-change coupling (forgetting one breaks the other) | Low | Low | P3 |
| Operational | None identified | Low | Low | - |
| Security | None - display-only change | Low | Low | - |

---

## Findings

### Should Fix (2 items)

#### SF-001: Extract useEffect into dedicated hook (SRP)

MarkdownEditor.tsx is already a large component with many responsibilities. The useEffect that conditionally sets mobileTab based on isMobile adds a secondary concern. Extracting this into a `useInitialMobileTab(isMobile)` hook would:
- Isolate the initialization logic
- Make it independently unit-testable (without rendering the full MarkdownEditor)
- Keep the component body focused on rendering

#### SF-002: Consider a declarative `initialMobileTab` prop (KISS)

The current design requires understanding the internal relationship between `viewMode`, `showMobileTabs`, and `mobileTab`. Adding an `initialMobileTab?: MobileTab` prop to EditorProps would:
- Eliminate the useEffect entirely (`useState<MobileTab>(initialMobileTab ?? 'editor')`)
- Make the caller's intent explicit
- Remove the theoretical flash concern documented in section 7

The caller would pass `initialMobileTab="preview" initialViewMode="split"`, making both aspects visible at the call site.

### Consider (3 items)

#### C-001: Add comment explaining desktop MarkdownEditor's omitted initialViewMode

The desktop Modal MarkdownEditor at ~line 1597 of WorktreeDetailRefactored.tsx does not pass `initialViewMode`, intentionally relying on localStorage. Adding a brief comment would prevent future maintainers from "fixing" this asymmetry.

#### C-002: Validate filePath change behavior during UAT

The decision not to reset mobileTab on filePath change is well-documented but should be confirmed with real user testing.

#### C-003: Monitor for future mobile-specific initialization growth

If additional mobile-specific initialization logic is needed in the future, consider a strategy pattern or configuration object for view mode initialization rather than adding more useEffects.

---

## Test Strategy Assessment

**Status**: Adequate

The design covers the key scenarios:
- Mobile default preview tab
- PC default unchanged
- localStorage override prevention on mobile
- filePath change tab retention
- initialViewMode prop propagation

**Minor gaps**:
- No test for the flash/flicker edge case (useEffect timing), though this is documented as acceptable due to modal animation overlap
- No integration test verifying the full Modal + MarkdownEditor combination on a mobile viewport

---

## Trade-off Documentation Assessment

The design document thoroughly documents trade-offs in section 3 with a clear table format. Each decision includes the rationale and the trade-off accepted. The rejected alternatives are also well-documented with clear reasons. This is above average for trade-off documentation.

---

## Approval

**Status**: Approved

The design is sound, minimal, and well-documented. The two "should fix" items are suggestions for improvement rather than blocking issues. The design can proceed to implementation as-is, with the suggestions applied at the implementer's discretion.
