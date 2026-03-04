# Architecture Review: Issue #410 Stage 2 - Consistency Review

## Executive Summary

| Item | Value |
|------|-------|
| **Issue** | #410: xterm.js/highlight.js dynamic import |
| **Stage** | 2 - Consistency Review |
| **Date** | 2026-03-03 |
| **Status** | Approved |
| **Score** | 4/5 |

The design policy document for Issue #410 demonstrates strong consistency between its documented file paths, line numbers, code examples, and the actual codebase. All major references to source files, line numbers, export types, and existing patterns were verified and found to be accurate. One should-fix item and three nice-to-have items were identified, none of which affect the correctness of the proposed implementation approach.

---

## Review Scope

### Verification Targets

| Category | Items Verified |
|----------|---------------|
| File paths | 7 source files referenced in design doc |
| Line numbers | 8 specific line number references |
| Export types | 4 component export patterns |
| Existing patterns | 2 prior dynamic import implementations |
| Test impact | 2 test files for change impact assessment |

---

## Detailed Findings

### S2-001 [Should Fix] Scope Exclusion Rationale for MessageList.tsx Is Inaccurate

**Location**: Section 1: Scope Exclusion

**Issue**: The design document states `src/components/worktree/MessageList.tsx: barrel export via only, expected to be excluded by tree-shaking`. Investigation reveals that MessageList is exported through the barrel file (`src/components/worktree/index.ts` at line 12), but no component in the codebase actually imports it (neither directly nor via the barrel export). The only reference is in `src/hooks/useInfiniteMessages.ts` in a JSDoc comment.

The phrase "barrel export via only" implies the component is actively used somewhere through the barrel, which is misleading. MessageList.tsx does import `rehype-highlight` at line 18, but since the component itself is not imported anywhere, tree-shaking will exclude it regardless.

**Suggested Fix**: Revise to: "barrel export (index.ts) exists but the component is not currently imported by any other component. Expected to be excluded from the bundle by tree-shaking."

---

### S2-002 [Nice to Have] Import Count Approximation in S1-002 Note

**Location**: Section 5-2: [S1-002] Import Addition Note

**Issue**: The note states "WorktreeDetailRefactored.tsx already has approximately 60 import statements (L19-L60)". Actual count shows approximately 47 import statements spanning lines L19-L65. The approximation of "60" is somewhat overstated, and the line range "L19-L60" does not cover the last import (`parseCmateContent` at L65).

**Suggested Fix**: Update to "approximately 47 import statements (L19-L65)" or use a rounder approximation like "approximately 50 import statements".

---

### S2-003 [Nice to Have] Test Mock Pattern Code Example Slightly Differs from Actual Test

**Location**: Section 4: D3 Test Mock Pattern

**Issue**: The design doc references `tests/unit/components/MermaidCodeBlock.test.tsx L24-35` and provides a simplified mock example. The actual test code at those lines has more explicit TypeScript type annotations on the loader parameter (`Promise<{ MermaidDiagram: React.ComponentType<{ code: string }> }>`). The design doc labels this as a "reference pattern for future use," so this is not a functional concern, but precision could be improved.

**Suggested Fix**: Either add a note "simplified example; actual test code includes stricter type annotations" or update the code example to match the actual implementation.

---

### S2-004 [Nice to Have] Post-Change Dependency Graph Omits Line Numbers

**Location**: Section 2: Component Dependency Graph (Post-Change)

**Issue**: The pre-change mermaid diagram includes line number references (e.g., "static import L9", "static import L9-12", "static import L34-35"), but the post-change diagram only uses generic "static import" labels without line numbers. Since Terminal.tsx and MarkdownEditor.tsx are not modified, their internal imports remain at the same line numbers, and including them in the post-change graph would improve consistency.

**Suggested Fix**: Add line numbers to the post-change graph arrows for Terminal.tsx and MarkdownEditor.tsx internal imports.

---

## Consistency Verification Matrix

### File Path Verification

| Design Doc Reference | Actual File | Status |
|---------------------|-------------|--------|
| `src/app/worktrees/[id]/terminal/page.tsx` | Exists | Verified |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Exists | Verified |
| `src/components/worktree/MermaidCodeBlock.tsx` | Exists | Verified |
| `src/app/login/page.tsx` | Exists | Verified |
| `src/components/Terminal.tsx` | Exists | Verified |
| `src/components/worktree/MarkdownEditor.tsx` | Exists | Verified |
| `src/components/worktree/MessageList.tsx` | Exists | Verified |

### Line Number Verification

| Design Doc Claim | Actual Content | Status |
|-----------------|----------------|--------|
| `terminal/page.tsx` L9: `import { TerminalComponent }` | L9: `import { TerminalComponent } from '@/components/Terminal';` | Match |
| `WorktreeDetailRefactored.tsx` L39: `import { MarkdownEditor }` | L39: `import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';` | Match |
| `WorktreeDetailRefactored.tsx` L2070-2076: MarkdownEditor usage (desktop) | L2070-2076: `<MarkdownEditor>` with all specified props | Match |
| `WorktreeDetailRefactored.tsx` L2309-2314: MarkdownEditor usage (mobile) | L2309-2315: `<MarkdownEditor>` with all specified props | Match (off by 1 on end line) |
| `MermaidCodeBlock.tsx` L20-34: dynamic import pattern | L20-34: `const MermaidDiagram = dynamic(...)` | Match |
| `login/page.tsx` L23-26: QrCodeGenerator dynamic import | L23-26: `const QrCodeGenerator = dynamic(...)` | Match |
| `Terminal.tsx` L9-12: xterm.js imports | L9-12: `import { Terminal }`, `FitAddon`, `WebLinksAddon`, `xterm.css` | Match |
| `MarkdownEditor.tsx` L34-35: rehype-highlight + CSS | L34: `import rehypeHighlight`, L35: `import 'highlight.js/...'` | Match |

### Export Type Verification

| Component | Design Doc Claim | Actual Export | Status |
|-----------|-----------------|---------------|--------|
| TerminalComponent | named export (requires `.then()`) | `export function TerminalComponent` (L20) | Match |
| MarkdownEditor | named export (requires `.then()`) | `export function MarkdownEditor` (L110) | Match |
| MermaidDiagram | named export (existing `.then()` pattern) | `export function MermaidDiagram` | Match |
| QrCodeGenerator | named export (existing `.then()` pattern) | `export function QrCodeGenerator` (L53) | Match |

### Existing Pattern Verification

| Pattern | Design Doc Reference | Actual Implementation | Status |
|---------|---------------------|----------------------|--------|
| MermaidCodeBlock.tsx dynamic import | `ssr: false`, `.then()`, `Loader2` spinner | Lines 20-34: identical pattern structure | Match |
| login/page.tsx dynamic import | `ssr: false`, `.then()`, no loading option | Lines 23-26: identical pattern structure | Match |

### Test Impact Verification

| Test File | Design Doc Claim | Actual State | Status |
|-----------|-----------------|--------------|--------|
| `MarkdownEditor.test.tsx` | Direct import, no impact | L16: `import { MarkdownEditor } from '@/components/worktree/MarkdownEditor'` - direct import confirmed | Match |
| `WorktreeDetailRefactored.test.tsx` | No MarkdownEditor reference | Grep confirms zero references to MarkdownEditor | Match |

### Internal Consistency

| Section | Claim | Cross-Reference | Status |
|---------|-------|-----------------|--------|
| S1-002 "no existing lucide-react import" | WorktreeDetailRefactored.tsx | Grep confirms zero lucide-react imports | Consistent |
| Section 9 "Terminal.tsx unchanged" | Section 5-1 design | import path `@/components/Terminal` matches actual file location | Consistent |
| Section 10 acceptance criteria | Section 7 performance design | 50KB reduction threshold aligns with rehype-highlight ~100KB+ estimate | Consistent |
| Section 8 "named export `.then()` pattern has project precedent" | Section 4 D1 | MermaidCodeBlock.tsx and login/page.tsx both use identical pattern | Consistent |

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | Design-to-implementation gap | Low | Low | P3 |
| Security | N/A - no security-relevant changes | N/A | N/A | N/A |
| Operational | Line number drift over time | Low | Medium | P3 |

---

## Improvement Recommendations

### Should Fix (1 item)

1. **S2-001**: Correct the MessageList.tsx scope exclusion rationale to reflect that the component is not actively imported anywhere, rather than implying it is used via barrel export.

### Nice to Have (3 items)

1. **S2-002**: Adjust the import count approximation and line range in the S1-002 note.
2. **S2-003**: Add precision note to the D3 test mock code example.
3. **S2-004**: Add line numbers to the post-change mermaid dependency graph for unchanged internal imports.

---

## Approval Status

**Status**: Approved

The design policy document demonstrates strong consistency with the actual codebase. All critical references (file paths, line numbers, export types, existing patterns, test impact) have been verified and match. The single should-fix item is a documentation accuracy improvement that does not affect the technical correctness of the proposed changes. The design is ready for implementation.

---

*Generated by architecture-review-agent for Issue #410 Stage 2*
*Review date: 2026-03-03*
