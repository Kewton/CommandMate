# Architecture Review: Issue #321 - Stage 1 Design Principles Review

## Review Metadata

| Item | Value |
|------|-------|
| Issue | #321 - メモのコピー機能 |
| Stage | 1 - 通常レビュー（設計原則） |
| Focus | SOLID / KISS / YAGNI / DRY / Component Design / Testing |
| Status | **Approved** |
| Score | **4 / 5** |
| Date | 2026-02-20 |

---

## Executive Summary

The design policy for Issue #321 demonstrates strong adherence to design principles. The approach of containing all changes within `MemoCard.tsx`, reusing the existing `copyToClipboard()` utility, and following the established FileViewer copy pattern reflects a disciplined, well-scoped design. No must-fix items were identified. One should-fix item (setTimeout cleanup) is recommended to prevent a minor React warning edge case. Four nice-to-have items are documented for future consideration.

---

## Design Principles Checklist

### SOLID Principles

| Principle | Status | Assessment |
|-----------|--------|------------|
| **SRP** (Single Responsibility) | PASS | Copy functionality is fully encapsulated within MemoCard. No responsibility leaks to MemoPane or WorktreeDetailRefactored. MemoCardProps remains unchanged. |
| **OCP** (Open/Closed) | PASS | MemoCard is extended with new behavior (copy) without modifying its external interface (props). Parent components require zero changes. |
| **LSP** (Liskov Substitution) | N/A | No inheritance hierarchy involved. |
| **ISP** (Interface Segregation) | PASS | MemoCardProps is not inflated with copy-related props. The design explicitly avoids adding onCopy, showCopyButton, or similar props. |
| **DIP** (Dependency Inversion) | PASS | MemoCard depends on the `copyToClipboard()` abstraction from `clipboard-utils.ts`, not on the raw Clipboard API directly. |

### KISS Principle

| Status | Assessment |
|--------|------------|
| PASS | The design reuses the proven FileViewer copy pattern verbatim. No new architectural patterns, abstractions, or state management approaches are introduced. The implementation requires approximately 15-20 lines of new code. |

### YAGNI Principle

| Status | Assessment |
|--------|------------|
| PASS | The design explicitly documents and rejects: (1) Toast notification system, (2) keyboard shortcuts, (3) title+content combined copy, (4) icon method unification. Each rejection includes a clear rationale. |

### DRY Principle

| Status | Assessment |
|--------|------------|
| PASS (with note) | `copyToClipboard()` is reused from `clipboard-utils.ts`. However, the useState/handleCopy/setTimeout boilerplate pattern is duplicated across FileViewer, MarkdownEditor, and now MemoCard. See finding S1-001. |

---

## Detailed Findings

### S1-001 [nice_to_have] - Copy/Check toggle pattern duplicated across 3+ components

**Category**: DRY

**Description**: The `useState(copied)` + `handleCopy` + `setTimeout(2000)` pattern is already present in:
- `src/components/worktree/FileViewer.tsx` (L53-75)
- `src/components/worktree/MarkdownEditor.tsx` (L127, L321-329)

Adding a third instance in MemoCard creates a recognizable pattern of duplication in the state management layer (as distinct from the `copyToClipboard()` utility itself, which is correctly shared).

**Suggestion**: Consider extracting a `useCopyToClipboard()` custom hook in a future Issue:

```typescript
// src/hooks/useCopyToClipboard.ts (future Issue)
export function useCopyToClipboard(text: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await copyToClipboard(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch { /* silent */ }
  }, [text]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { copied, handleCopy };
}
```

This is **not a blocker** for Issue #321. The design correctly follows the established pattern, and extracting the hook now would violate YAGNI within this Issue's scope.

---

### S1-002 [should_fix] - setTimeout without cleanup on component unmount

**Category**: Component Design

**Description**: The design's `handleCopy` implementation uses `setTimeout(() => setCopied(false), 2000)` without storing the timer ID for cleanup. If `MemoCard` is unmounted within the 2-second feedback window (e.g., user copies content then immediately clicks the delete button), `setCopied(false)` will be called on an unmounted component.

While this is a pre-existing pattern in FileViewer (L71) and MarkdownEditor (L325), **MemoCard is more susceptible** because:
1. The delete button is in the same header row as the copy button
2. There is no confirmation dialog for deletion
3. The user flow "copy then delete" is a plausible real-world scenario

**Affected code** (from design policy, Section 4):

```typescript
const handleCopy = useCallback(async () => {
  if (!content) return;
  try {
    await copyToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);  // <-- no cleanup reference
  } catch {
    // silent
  }
}, [content]);
```

**Suggestion**: Add timer cleanup with minimal code:

```typescript
const timerRef = useRef<ReturnType<typeof setTimeout>>();

const handleCopy = useCallback(async () => {
  if (!content) return;
  try {
    await copyToClipboard(content);
    setCopied(true);
    clearTimeout(timerRef.current);  // Clear any existing timer
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  } catch {
    // silent
  }
}, [content]);

// Cleanup on unmount
useEffect(() => {
  return () => clearTimeout(timerRef.current);
}, []);
```

This is approximately 3 additional lines and eliminates both the unmount warning and the rapid double-click timer conflict.

---

### S1-003 [nice_to_have] - Icon method inconsistency within MemoCard

**Category**: Component Design

**Description**: The copy button will use `lucide-react` icons (Copy/Check), while the existing delete button uses an inline SVG path (L158-171 of MemoCard.tsx). This creates a visual inconsistency within the same component header row where two different icon rendering methods coexist.

**Assessment**: The design document (Section 11) explicitly acknowledges this trade-off and correctly defers icon unification to a separate Issue. This is the right decision for scope management.

**Suggestion**: No action needed for Issue #321. If desired, file a follow-up Issue to standardize icon methods across MemoCard (either all lucide-react or all inline SVG).

---

### S1-004 [nice_to_have] - Missing test case for rapid double-click

**Category**: Testing

**Description**: The 5 proposed test cases cover the core scenarios comprehensively. However, there is no test for rapid consecutive clicks on the copy button. If the user clicks copy twice quickly:
1. First click: `setCopied(true)`, timer starts
2. Second click: `setCopied(true)`, new timer starts
3. First timer fires: `setCopied(false)` -- Check icon disappears prematurely

This edge case is related to S1-002 (timer cleanup).

**Suggestion**: Add a test case (#6) for rapid double-click behavior:

```typescript
it('should reset timer on rapid double click', async () => {
  vi.useFakeTimers();
  render(<MemoCard {...defaultProps} />);
  const copyButton = screen.getByRole('button', { name: /copy memo content/i });

  await userEvent.click(copyButton);  // First click
  vi.advanceTimersByTime(1000);       // 1s passes
  await userEvent.click(copyButton);  // Second click
  vi.advanceTimersByTime(1500);       // 1.5s from second click

  // Check icon should still be visible (2s from second click not yet elapsed)
  expect(screen.getByTestId('copy-check-icon')).toBeInTheDocument();

  vi.advanceTimersByTime(500);        // 2s from second click elapsed
  expect(screen.queryByTestId('copy-check-icon')).not.toBeInTheDocument();

  vi.useRealTimers();
});
```

---

### S1-005 [nice_to_have] - Missing test case for unmount during feedback window

**Category**: Testing

**Description**: No test verifies behavior when MemoCard is unmounted while the Check icon is displayed. Given the proximity of copy and delete buttons in MemoCard's header, the "copy then delete" flow is a realistic user scenario.

**Suggestion**: Add a test that triggers copy, then unmounts the component, and verifies no warnings are emitted:

```typescript
it('should clean up timer on unmount', async () => {
  vi.useFakeTimers();
  const { unmount } = render(<MemoCard {...defaultProps} />);
  const copyButton = screen.getByRole('button', { name: /copy memo content/i });

  await userEvent.click(copyButton);
  unmount();  // Unmount before 2s timer fires

  // Advancing timers should not cause state update warning
  vi.advanceTimersByTime(2000);

  vi.useRealTimers();
});
```

---

## Risk Assessment

| Risk Type | Level | Description | Mitigation |
|-----------|-------|-------------|------------|
| Technical | Low | Changes are confined to a single component with no API/DB impact | MemoCardProps unchanged; zero integration risk |
| Security | Low | Uses existing `copyToClipboard()` with ANSI stripping; clipboard write only | No new attack surface introduced |
| Operational | Low | No infrastructure, configuration, or deployment changes | Pure UI feature addition |

---

## Component Impact Analysis

| Component | Impact | Details |
|-----------|--------|---------|
| `MemoCard.tsx` | Direct (modified) | New imports, useState, handleCopy callback, JSX button element |
| `MemoCard.test.tsx` | Direct (modified) | New mock, 5 new test cases |
| `MemoPane.tsx` | None | No prop changes propagated |
| `WorktreeDetailRefactored.tsx` | None | No prop changes propagated |
| `clipboard-utils.ts` | None | Reused as-is |
| `CLAUDE.md` | Documentation only | Module description update |

---

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| Must Fix | 0 | -- |
| Should Fix | 1 | S1-002 |
| Nice to Have | 4 | S1-001, S1-003, S1-004, S1-005 |
| **Total** | **5** | |

---

## Approval

**Status: Approved**

The design is well-structured, follows established project patterns, and demonstrates strong adherence to SOLID, KISS, YAGNI, and DRY principles. The single should-fix item (S1-002: timer cleanup) is a minor improvement that can be incorporated during implementation without affecting the overall design direction. The design is ready to proceed to Stage 2 review.

---

*Generated by architecture-review-agent for Issue #321 Stage 1*
*Date: 2026-02-20*
