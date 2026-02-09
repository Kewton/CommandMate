# Architecture Review: Issue #208 Stage 4 - Security Review

| Item | Detail |
|------|--------|
| **Issue** | #208: Auto-Yes numbered list false positive prevention |
| **Stage** | 4 (Security Review) |
| **Focus** | OWASP Top 10, input validation, injection, ReDoS, information disclosure, Auto-Yes safety |
| **Date** | 2026-02-09 |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |

---

## 1. Executive Summary

Issue #208 proposes strengthening Layer 5 (SEC-001) in `prompt-detector.ts` by adding a `isQuestionLikeLine()` validation function (SEC-001b) to prevent normal numbered lists from being misdetected as multiple-choice prompts when `requireDefaultIndicator: false` is used (Claude Code mode).

From a security perspective, the proposed changes are well-designed and low-risk. The modification is confined to a single file (`src/lib/prompt-detector.ts`) and involves only read-side logic (pattern matching on tmux output), introducing no new attack surface for injection, data corruption, or unauthorized access. The primary security concern is the **safety of the Auto-Yes system** -- specifically, ensuring that false positive prompt detection does not cause unintended tmux key sends.

The design addresses this concern effectively through a multi-layered defense structure. One must-fix item is identified: the design document should explicitly document the safety properties of the values that `resolveAutoAnswer()` sends to tmux.

---

## 2. OWASP Top 10 Compliance Assessment

### 2.1 Assessment Summary

| OWASP Category | Status | Notes |
|----------------|--------|-------|
| A01: Broken Access Control | N/A | No access control changes |
| A02: Cryptographic Failures | N/A | No cryptographic operations |
| A03: Injection | Pass (with notes) | See SEC-S4-001 |
| A04: Insecure Design | Pass | Multi-layer defense well-structured |
| A05: Security Misconfiguration | N/A | No configuration changes |
| A06: Vulnerable Components | N/A | No new dependencies |
| A07: Auth Failures | N/A | No authentication changes |
| A08: Data Integrity Failures | Pass | Detection results are transient, not persisted |
| A09: Logging & Monitoring | Pass (with notes) | Existing SEC-003 log injection mitigation in place |
| A10: SSRF | N/A | No outbound server requests |

### 2.2 Detailed Analysis

**A03: Injection** -- The proposed `isQuestionLikeLine()` function processes tmux output (read-only pattern matching) and does not construct external commands or queries. `QUESTION_KEYWORD_PATTERN` is a compile-time constant, not derived from user input. However, the broader Auto-Yes flow involves `sendKeys()` in `src/lib/tmux.ts` (L207-225) which constructs a shell command using string interpolation:

```typescript
// tmux.ts L215-217
const command = sendEnter
  ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
  : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;
```

While `escapedKeys` performs single-quote escaping, the design document should acknowledge that `resolveAutoAnswer()` constrains output to safe values ('y' or digit strings) as a defense-in-depth measure.

**A04: Insecure Design** -- The five-layer defense architecture (Layer 1: thinking detection, Layer 2: cursor indicator, Layer 3: consecutive numbering, Layer 4: option count, Layer 5: question line validation) demonstrates proper defense-in-depth principles. The addition of SEC-001b strengthens the weakest point (Layer 5) without disrupting the other layers.

---

## 3. Input Validation and Sanitization Review

### 3.1 tmux Output Processing Chain

The data flow for tmux output is:

```
tmux capture-pane -> captureSessionOutput() -> stripAnsi() -> detectPrompt()
                                                                |
                                           detectMultipleChoicePrompt()
                                                                |
                                              isQuestionLikeLine() [new]
```

**Findings:**

1. **stripAnsi() coverage (existing SEC-002)**: The existing `ANSI_PATTERN` in `cli-patterns.ts` has documented limitations (8-bit CSI, DEC private modes). For `isQuestionLikeLine()`, residual control characters would cause `endsWith('?')` and `endsWith(':')` to return `false`, making the function fail safely (returning `false`, which blocks detection). This is a secure default.

2. **lines[questionEndIndex]?.trim()**: The optional chaining and trim() provide safe handling of undefined/whitespace-only values. The empty string check (`line.length === 0`) catches the edge case.

3. **No user-controlled input in pattern**: `QUESTION_KEYWORD_PATTERN` is a hardcoded constant. There is no path by which user input could influence the regular expression construction.

### 3.2 Question Line Validation

The `isQuestionLikeLine()` function design is secure:

- **Pattern 1 (`?` / full-width `?` check)**: Simple `endsWith()` call. No regex involved. O(1) operation.
- **Pattern 2 (`:` + keyword check)**: Gated by `endsWith(':')` before applying `QUESTION_KEYWORD_PATTERN`. The regex is only tested against a single trimmed line (typically under 100 characters), limiting computational exposure.

---

## 4. ReDoS (Regular Expression Denial of Service) Analysis

### 4.1 QUESTION_KEYWORD_PATTERN

```typescript
const QUESTION_KEYWORD_PATTERN = /(?:select|choose|pick|which|what|how|where|enter|type|specify|confirm|approve|accept|reject|decide|preference|option)/i;
```

**ReDoS Risk: NONE**

- Structure: Non-capturing group with simple alternation (OR of fixed strings)
- No quantifiers (`*`, `+`, `{n,m}`) that could cause backtracking
- No nested groups or overlapping patterns
- Time complexity: O(n * k) where n is input length and k is the number of alternatives. With n < 100 (single line) and k = 17, this is negligible.

### 4.2 Existing Patterns (Verification)

| Pattern | Location | ReDoS Safe | Annotation |
|---------|----------|-----------|------------|
| `DEFAULT_OPTION_PATTERN` | prompt-detector.ts L208 | Yes | Annotated S4-001 |
| `NORMAL_OPTION_PATTERN` | prompt-detector.ts L215 | Yes | Annotated S4-001 |
| `QUESTION_KEYWORD_PATTERN` | Proposed (design doc 3.3) | Yes | **Not yet annotated** (SEC-S4-002) |
| `TEXT_INPUT_PATTERNS` | prompt-detector.ts L195-201 | Yes | Not annotated but safe (simple patterns) |
| `ANSI_PATTERN` | cli-patterns.ts L197 | Yes | Global flag with non-overlapping alternatives |

**Recommendation (SEC-S4-002)**: Add ReDoS safety annotation to `QUESTION_KEYWORD_PATTERN` for consistency with existing pattern documentation conventions.

---

## 5. Information Disclosure Risk

### 5.1 Error Message Analysis

The proposed changes in `prompt-detector.ts` do not generate new error messages or log sensitive data. The existing patterns are appropriate:

- `getAnswerInput()` uses SEC-003 (fixed error messages without user input reflection) to prevent log injection.
- `auto-yes-manager.ts` L351 logs `worktreeId` but not output content.
- `prompt-response/route.ts` L44 includes `params.id` in error messages (SEC-S4-005, low priority).

### 5.2 Prompt Data Exposure

The `current-output/route.ts` returns `promptData` in its JSON response, which includes `question` text extracted from tmux output. This is existing behavior and appropriate for a local tool. The SEC-001b enhancement does not change what data is returned -- it only changes whether `isPrompt` is true or false.

---

## 6. Auto-Yes Safety Analysis

This is the most critical security dimension for Issue #208.

### 6.1 Threat Model: False Positive Prompt Detection

When Auto-Yes is enabled and a false positive occurs:

1. `detectPrompt()` returns `isPrompt: true` with `type: 'multiple_choice'`
2. `resolveAutoAnswer()` returns `"1"` (first option number)
3. `sendKeys()` sends `"1"` + Enter to tmux session
4. Claude CLI receives `"1\n"` as input during normal output processing

**Impact**: The string "1" followed by Enter is sent to the active CLI session. If the CLI is in normal output mode (not awaiting input), the "1" is typically ignored or causes a benign error. However, if the CLI happens to be at an input prompt that was not detected by the standard prompt patterns, the "1" could be interpreted as valid input.

### 6.2 Defense-in-Depth Coverage

The current multi-layer defense against false positive Auto-Yes responses:

| Layer | Defense | Addresses |
|-------|---------|-----------|
| Layer 1 | Thinking detection (50-line window) | Prevents detection during active processing |
| Layer 2 | Pass 1 cursor check (when requireDefault=true) | N/A for Claude Code |
| Layer 3 | Consecutive numbering validation | Rejects scattered/non-sequential lists |
| Layer 4 | Minimum 2 options check | Rejects single-item lists |
| Layer 5 SEC-001a | Question line existence check | Rejects lists without preceding text |
| **Layer 5 SEC-001b** | **Question line content validation (NEW)** | **Rejects lists preceded by non-question text** |
| External | Auto-Yes 1-hour expiry timeout | Limits exposure window |
| External | Duplicate prevention (client + server) | Prevents repeated sends for same prompt |

The addition of SEC-001b closes the specific vulnerability identified in Issue #208 (numbered lists preceded by non-question headers like "Recommendations:" or "Steps:").

### 6.3 Remaining Risk After Fix

After SEC-001b is applied, a false positive can only occur if ALL of the following conditions are simultaneously true:

1. `requireDefaultIndicator: false` (Claude Code mode)
2. Not in thinking state (Layer 1 bypass)
3. Consecutive numbering starting from 1 (Layer 3 pass)
4. At least 2 items (Layer 4 pass)
5. A preceding text line exists (SEC-001a pass)
6. That preceding line ends with `?` or contains a QUESTION_KEYWORD and ends with `:` (SEC-001b pass)

This is a very narrow window. The remaining residual risk is primarily scenario SEC-S4-006 (a CLI tool output that coincidentally matches a question-like pattern before a numbered list), which is assessed as extremely low probability.

### 6.4 resolveAutoAnswer() Output Safety

`resolveAutoAnswer()` in `src/lib/auto-yes-resolver.ts` returns only:

- `'y'` for yes/no prompts
- `target.number.toString()` for multiple choice (integer string)
- `null` for unresolvable prompts (suppresses send)

These values are intrinsically safe for tmux `send-keys` injection:
- No shell metacharacters
- No tmux control sequences (C-*, M-*)
- No quote characters

**This safety property should be documented in the design policy** (SEC-S4-001).

---

## 7. Risk Assessment

| Risk Category | Level | Rationale |
|---------------|-------|-----------|
| Technical | Low | Single-file change, well-defined function boundary, no architectural impact |
| Security | Low | Read-only pattern matching, no new attack surface, safe default (false -> block) |
| Operational | Low | No runtime behavior change for correctly detected prompts, backward compatible |

---

## 8. Findings Detail

### 8.1 Must Fix (1 item)

#### SEC-S4-001: Explicit documentation of Auto-Yes output value safety

**Category**: Command injection / Defense in depth
**Severity**: Medium
**Location**: Design policy document, Section 7 (Security Design)

**Problem**: The design document's security section (Section 7) focuses on False Positive / False Negative classification but does not explicitly document the safety properties of the values that Auto-Yes sends to tmux. While `resolveAutoAnswer()` only returns safe values ('y' or digit strings), this safety invariant is not documented as a security guarantee.

**Recommendation**: Add a subsection to Section 7 (e.g., "7.4 Auto-Yes Output Value Safety") that:
1. Documents that `resolveAutoAnswer()` output is constrained to `'y'` or `\d+` strings
2. Notes that these values contain no shell metacharacters or tmux control sequences
3. References `auto-yes-resolver.ts` as the single point of output value generation
4. States that any future extension to `resolveAutoAnswer()` must maintain this invariant

### 8.2 Should Fix (3 items)

#### SEC-S4-002: ReDoS safety annotation for QUESTION_KEYWORD_PATTERN

**Category**: ReDoS documentation
**Severity**: Low

Add `// ReDoS safe (S4-002): alternation-only, no nested quantifiers` annotation to `QUESTION_KEYWORD_PATTERN` for consistency with existing pattern conventions (DEFAULT_OPTION_PATTERN has `S4-001` annotation).

#### SEC-S4-003: Multi-layer defense overview in security section

**Category**: False positive safety documentation
**Severity**: Medium

Add a defense-in-depth summary table to Section 7 that enumerates all layers (Layer 1-5 + external safeguards) and their coverage. This helps reviewers and future developers understand the complete safety picture at a glance.

#### SEC-S4-004: Input robustness documentation for isQuestionLikeLine()

**Category**: Input validation
**Severity**: Low

Document in the `isQuestionLikeLine()` JSDoc that the function handles residual control characters safely (non-matching inputs return `false`, which is the secure default).

### 8.3 Consider (2 items)

#### SEC-S4-005: Error message information disclosure

**Category**: Information disclosure
**Severity**: Low (current threat model: local tool)

`prompt-response/route.ts` includes `params.id` in error responses. No action required for current local-only deployment.

#### SEC-S4-006: Crafted CLI output bypass scenario

**Category**: Defense in depth
**Severity**: Informational

Theoretical bypass via crafted CLI output matching question-like patterns. No action required under current trust model (local execution with trusted CLI tools).

---

## 9. Comparison with Previous Review Stages

| Stage | Focus | Score | Status | Key Findings |
|-------|-------|-------|--------|--------------|
| Stage 1 | Design Principles | 5/5 | Approved | SF-001 (keyword classification), SF-002 (full-width question mark DRY) |
| Stage 2 | Consistency | 4/5 | Conditionally Approved | IC-002 (insertion point), IC-004 (word boundary tradeoff) |
| Stage 3 | Impact Analysis | 5/5 | Approved | IA-002 (optional integration test) |
| **Stage 4** | **Security** | **4/5** | **Conditionally Approved** | **SEC-S4-001 (output value safety documentation)** |

---

## 10. Conclusion

The security posture of the proposed changes is strong. The design correctly identifies the root cause (Layer 5 weakness when `requireDefaultIndicator: false`) and applies a targeted, minimal-surface-area fix. The `isQuestionLikeLine()` function is ReDoS-safe, injection-safe, and fails securely (false negatives block detection rather than allowing false positives).

The single must-fix item (SEC-S4-001) is a documentation requirement rather than a code change. The design should explicitly document the safety invariant of `resolveAutoAnswer()` output values as part of the overall security design narrative.

**Verdict**: Conditionally Approved -- proceed with implementation after documenting SEC-S4-001 in the design policy.

---

## 11. Reviewed Files

| File | Purpose in Review |
|------|-------------------|
| `dev-reports/design/issue-208-auto-yes-numbered-list-false-positive-design-policy.md` | Primary review target |
| `src/lib/prompt-detector.ts` | Modification target -- regex safety, defense layers |
| `src/lib/auto-yes-manager.ts` | Auto-Yes polling flow, tmux send path |
| `src/lib/auto-yes-resolver.ts` | Output value safety analysis |
| `src/lib/cli-patterns.ts` | stripAnsi() coverage, buildDetectPromptOptions() |
| `src/lib/status-detector.ts` | Indirect caller, defense layer coordination |
| `src/lib/response-poller.ts` | Indirect caller, thinking detection |
| `src/lib/tmux.ts` | sendKeys() command injection surface |
| `src/hooks/useAutoYes.ts` | Client-side Auto-Yes flow, duplicate prevention |
| `src/app/api/worktrees/[id]/current-output/route.ts` | API response with promptData |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | Prompt response send path |
| `tests/unit/prompt-detector.test.ts` | Existing SEC-001 test coverage |
