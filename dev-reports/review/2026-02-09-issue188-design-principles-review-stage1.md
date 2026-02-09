# Architecture Review: Issue #188 - Design Principles (Stage 1)

**Date**: 2026-02-09
**Issue**: #188 - thinking indicator false detection (spinner stuck after response completion)
**Focus Area**: Design Principles (SOLID, KISS, YAGNI, DRY)
**Reviewer**: Architecture Review Agent
**Status**: Approved
**Score**: 4/5

---

## Executive Summary

The design policy for Issue #188 demonstrates strong adherence to design principles. The core approach -- consolidating inline thinking/prompt detection logic from `current-output/route.ts` into the existing `detectSessionStatus()` common function -- is a textbook DRY/SRP improvement that aligns with the established pattern from Issue #180.

The design makes several well-reasoned decisions:
1. Adopting DR-002 alternative (caller-side promptData retrieval) to preserve SRP
2. Separating thinking and prompt detection windows (5-line vs 15-line) for targeted precision
3. Not modifying `auto-yes-manager.ts` to respect Issue #191 design integrity (YAGNI)
4. Deferring `claude-poller.ts` deprecation to a future Issue (YAGNI)

Two should-fix items and three consideration items were identified, all of low severity.

---

## Detailed Findings

### SOLID Principles Evaluation

#### SRP (Single Responsibility Principle) -- PASS (4/5)

**Strengths:**
- `status-detector.ts` maintains its single responsibility of session status detection. The DR-002 alternative correctly avoids adding `promptData` to `StatusDetectionResult`, which would have mixed status detection with prompt data serialization concerns.
- The elimination of inline thinking/prompt logic from `current-output/route.ts` improves SRP by delegating detection responsibility to the dedicated module.
- `prompt-detector.ts` remains CLI-tool-independent per Issue #161 principles.

**Observation (SF-001):**
The DR-002 alternative design requires `current-output/route.ts` to call `detectPrompt()` separately after `detectSessionStatus()` to obtain `promptData`. Since `detectSessionStatus()` already calls `detectPrompt()` internally, this results in dual execution of prompt detection on the same input. While the design document acknowledges this trade-off and correctly prioritizes SRP over computation cost, the dual execution introduces a subtle semantic coupling: `current-output/route.ts` must understand that `detectSessionStatus()` already validated thinking state before deciding whether to run `detectPrompt()`.

**Current code (`current-output/route.ts`, lines 79-94):**
```typescript
// Inline thinking detection + conditional prompt detection
const thinking = detectThinkingState(cliToolId, lastSection);
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPrompt(cleanOutput, promptOptions);
```

**Proposed code:**
```typescript
const statusResult = detectSessionStatus(output, cliToolId);
const thinking = statusResult.status === 'running' && statusResult.reason === 'thinking_indicator';
let promptDetection = { isPrompt: false, cleanContent: cleanOutput };
if (!thinking) {
  promptDetection = detectPrompt(cleanOutput, promptOptions);
}
```

The proposed code correctly uses `statusResult` to guard the second `detectPrompt()` call, preventing detection during thinking. This preserves the Issue #161 Layer 1 defense.

#### OCP (Open/Closed Principle) -- PASS (4/5)

**Strengths:**
- Window sizes are extracted as named constants (`THINKING_CHECK_LINE_COUNT`, `STATUS_CHECK_LINE_COUNT`), enabling future adjustment without modifying detection logic.
- The priority order within `detectSessionStatus()` (prompt > thinking > input prompt > time heuristic > default) is a well-structured chain that can accommodate new detection stages.

**No issues identified.**

#### LSP (Liskov Substitution Principle) -- PASS (5/5)

No inheritance hierarchies are involved in this change. The `CLIToolType` type union and switch-case pattern used throughout follows established codebase conventions. Not applicable in a meaningful way for this Issue.

#### ISP (Interface Segregation Principle) -- PASS (5/5)

**Strengths:**
- `StatusDetectionResult` interface maintains exactly the fields needed by callers:
  - `worktrees/route.ts` uses `status` and `hasActivePrompt`
  - `current-output/route.ts` uses `status`, `reason`, and `hasActivePrompt`
- The decision NOT to add `promptData` to `StatusDetectionResult` (DR-002 alternative) is an excellent ISP application. Adding it would force `worktrees/route.ts` to receive data it never uses.

**Current interface (`status-detector.ts`, lines 31-44):**
```typescript
export interface StatusDetectionResult {
  status: SessionStatus;
  confidence: StatusConfidence;
  reason: string;
  hasActivePrompt: boolean;
}
```

This interface is lean and purpose-focused. No bloat.

#### DIP (Dependency Inversion Principle) -- PASS (4/5)

**Strengths:**
- The migration from `current-output/route.ts` directly importing `detectThinking` (concrete detection function) to using `detectSessionStatus()` (abstracted status detection) aligns with DIP. The route handler now depends on a higher-level abstraction rather than low-level pattern matching.
- Dependency direction: `route.ts` -> `status-detector.ts` -> `cli-patterns.ts` + `prompt-detector.ts`. This forms a clean layered architecture where presentation depends on business logic, which depends on shared patterns.

---

### KISS Principle -- PASS (4/5)

**Strengths:**
- The root fix is elegantly simple: shrink the thinking detection window from 15 lines to 5 lines, preventing completed thinking summaries in scrollback from being falsely detected.
- Reusing `detectSessionStatus()` simplifies `current-output/route.ts` by removing inline detection logic.
- The priority order (prompt > thinking > input > heuristic > default) is clear and easy to follow.

**Observation:**
The coexistence of different window sizes (5, 15, 20, 50 lines) across the codebase adds cognitive load. However, the design document provides clear rationale for each size, and the alternative (a single unified size) would compromise either accuracy or safety. This is appropriate complexity.

---

### YAGNI Principle -- PASS (5/5)

**Strengths -- this is the strongest principle adherence in the design:**
- Only the problematic code paths are modified. `auto-yes-manager.ts` (Issue #191 design) is explicitly left unchanged.
- `prompt-detector.ts` and `cli-patterns.ts` require no changes.
- P2 items (`claude-poller.ts` deprecation) are correctly deferred to a future Issue.
- The design explicitly rejects "Alternative C: unify all window sizes" as unnecessary generalization.
- The DR-002 alternative avoids adding `promptData` to `StatusDetectionResult` since only one caller needs it.

---

### DRY Principle -- PASS (4/5)

**Strengths:**
- DR-001 (`detectSessionStatus()` consolidation) directly eliminates the duplicated priority logic between `current-output/route.ts` and `status-detector.ts`.
- This mirrors the successful pattern from Issue #180 where `worktrees/route.ts` was similarly consolidated.
- `buildDetectPromptOptions()` continues to centralize CLI-tool-specific options (MF-001).

**Should-Fix Items:**

**SF-001: detectPrompt() dual execution**
As described above, the detection logic runs twice: once inside `detectSessionStatus()` and once explicitly in `current-output/route.ts` for `promptData` retrieval. This is a controlled DRY violation with documented justification (SRP preservation), but it should be noted as a technical debt marker.

**SF-002: THINKING_CHECK_LINE_COUNT naming collision**
The design introduces `THINKING_CHECK_LINE_COUNT = 5` in `status-detector.ts`, but `auto-yes-manager.ts` already exports `THINKING_CHECK_LINE_COUNT = 50`. While these are in separate modules and have different values, the identical name could cause confusion during maintenance. Recommending distinct names:
- `status-detector.ts`: `THINKING_WINDOW_LINES = 5` or `STATUS_THINKING_CHECK_LINES = 5`
- `auto-yes-manager.ts`: `THINKING_CHECK_LINE_COUNT = 50` (unchanged, established in Issue #191)

---

### Design Pattern Appropriateness

**Adopted Patterns:**

| Pattern | Usage | Appropriateness |
|---------|-------|-----------------|
| Facade (detectSessionStatus) | Encapsulates thinking + prompt + input detection | Excellent. Single entry point with clear contract. |
| Strategy (via cliToolId dispatch) | CLI-tool-specific patterns in cli-patterns.ts | Appropriate. Switch-case is sufficient for 3 tools. |
| Guard Clause (priority chain) | Early return for each detection stage | Clean and readable. Avoids nested if-else. |

**No anti-patterns detected.**

---

## Risk Assessment

| Risk Type | Level | Description | Mitigation |
|-----------|-------|-------------|------------|
| Technical | Low | Thinking detection window reduction (15 -> 5 lines) could theoretically miss an active thinking indicator that spans many lines. In practice, thinking indicators appear in the most recent 1-2 lines. | Test boundary conditions (thinking indicator at exactly line 5). Design includes this test case. |
| Technical | Low | detectPrompt() dual execution adds minor computational overhead. | Overhead is negligible (string pattern matching on 15 lines). Monitored by existing 2-second polling interval. |
| Security | Low | All existing security measures (Issue #161 Layer 1/3, Issue #193 SEC-001, Issue #191 SF-001) are explicitly maintained. No new attack surface introduced. | Enumerated in design section 5.1 with maintenance plan. |
| Operational | Low | No changes to polling intervals, API contracts, or database schema. Backward-compatible modification. | Integration tests (section 6.1) verify end-to-end behavior. |

---

## Improvement Recommendations

### Should Fix (2 items)

**SF-001: detectPrompt() dual execution**
- **Principle**: SRP / DRY
- **Severity**: Low
- **Current**: `detectSessionStatus()` runs `detectPrompt()` internally; `current-output/route.ts` runs it again for `promptData`.
- **Recommendation**: Accept as documented trade-off. If performance monitoring later shows this is significant, consider caching the detection result or extending `StatusDetectionResult` with an optional `promptDetectionResult` field behind a flag parameter.

**SF-002: THINKING_CHECK_LINE_COUNT naming collision**
- **Principle**: DRY / KISS
- **Severity**: Low
- **Current**: Both `status-detector.ts` and `auto-yes-manager.ts` define constants named `THINKING_CHECK_LINE_COUNT` with values 5 and 50 respectively.
- **Recommendation**: Rename the `status-detector.ts` constant to differentiate it (e.g., `THINKING_WINDOW_LINES`).

### Consider (3 items)

**C-001: response-poller.ts inline magic number 5**
- DR-004 proposes `responseLines.slice(-5)` without defining a named constant. Consider adding `const THINKING_TAIL_CHECK_LINES = 5` for clarity.

**C-002: Empty-line-heavy buffer test scenario**
- The switch from non-empty-line filtering to all-line windowing changes effective coverage when buffers contain many blank lines. Adding a test case with blank-line-padded output would strengthen confidence.

**C-003: Future caller proliferation**
- If additional API routes need `StatusDetectionResult`-to-JSON mapping, consider extracting a shared mapper function. Current 2-caller count does not justify this (YAGNI).

---

## Approval Status

**APPROVED**

The design demonstrates strong adherence to SOLID, KISS, YAGNI, and DRY principles. The DRY consolidation via `detectSessionStatus()` is the correct approach, consistent with Issue #180 precedent. The YAGNI discipline (not modifying `auto-yes-manager.ts`, deferring `claude-poller.ts` deprecation) is exemplary. The two should-fix items are low severity and do not block implementation.

The design document is thorough in documenting trade-offs, alternative analyses, and cross-Issue integrity (Issues #161, #180, #191, #193). The test design covers the critical scenarios including boundary conditions and regression cases.

---

*Generated by Architecture Review Agent for Issue #188 (Stage 1: Design Principles)*
