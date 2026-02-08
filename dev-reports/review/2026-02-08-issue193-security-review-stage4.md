# Issue #193 Security Review (Stage 4)

**Date**: 2026-02-08
**Reviewer**: architecture-review-agent
**Design Document**: `dev-reports/design/issue-193-codex-multiple-choice-detection-design-policy.md`
**Focus**: Security (OWASP Top 10 compliance, ReDoS prevention, command injection, input validation)

---

## 1. Executive Summary

The design policy for Issue #193 (Codex CLI multiple choice detection) demonstrates strong baseline security awareness. The document explicitly addresses ReDoS prevention through anchored patterns (S4-001), maintains existing worktreeID validation, and preserves command injection protections. However, the security review identified **2 must-fix** and **4 should-fix** issues, primarily around insufficient input validation on the prompt-response API endpoint and the reduced defense-in-depth when Layer 4 is disabled for Codex auto-yes scenarios.

**Overall Risk Assessment**: Low. The application runs on localhost by default, and the proposed changes are in-memory pattern matching with no new network-facing APIs.

---

## 2. Findings

### DR4-001 [must_fix] Command Injection: Raw user answer sent to tmux without sanitization

**Category**: Command Injection (OWASP A03:2021)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts` (L92)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/respond/route.ts` (L99-101, L149)

**Description**: In `prompt-response/route.ts`, the user-supplied `answer` from the request body is passed directly to `sendKeys(sessionName, answer, false)` without any format validation:

```typescript
// prompt-response/route.ts L89-98
try {
  // Send the answer
  await sendKeys(sessionName, answer, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  await sendKeys(sessionName, '', true);
}
```

While `sendKeys()` in `tmux.ts` (L213) escapes single quotes, it uses `exec()` (shell interpretation) rather than `execFile()`:

```typescript
// tmux.ts L212-217
const escapedKeys = keys.replace(/'/g, "'\\''");
const command = sendEnter
  ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
  : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;
await execAsync(command, { timeout: DEFAULT_TIMEOUT });
```

Additionally, `respond/route.ts` allows arbitrary custom text input for multiple_choice options (L99-101):

```typescript
} else {
  // If answer is not a number, it's custom text input
  // Use it as-is (no validation needed)
  input = answer;
}
```

**Recommendation**: Add input validation in `prompt-response/route.ts` before sending to tmux. Enforce numeric-only for multiple_choice, y/n for yes_no, and add a maximum length limit. Consider migrating `sendKeys()` from `exec()` to `execFile()` to eliminate shell interpretation.

---

### DR4-002 [must_fix] ReDoS Prevention: TBD Codex patterns require automated safety verification

**Category**: ReDoS Prevention (Availability/DoS)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/cli-patterns.ts`

**Description**: The design specifies Codex patterns as TBD placeholders:

```typescript
// Design doc section 5.1
export const CODEX_CHOICE_INDICATOR_PATTERN = /TBD_AFTER_CONFIRMATION/;
export const CODEX_CHOICE_NORMAL_PATTERN = /TBD_AFTER_CONFIRMATION/;
```

Section 6.2 mandates anchoring (S4-001) and states "Test for ReDoS vulnerability checks", but the implementation checklist (section 16, Phase 2) does not include an explicit automated ReDoS verification step. Given that these patterns will be executed on every 2-second polling cycle for every active worktree, a ReDoS vulnerability could degrade the entire server.

The existing patterns are safe -- both `DEFAULT_OPTION_PATTERN` and `NORMAL_OPTION_PATTERN` use anchored, linear-time patterns:

```typescript
// prompt-detector.ts L182-189
const DEFAULT_OPTION_PATTERN = /^\s*\u276F\s*(\d+)\.\s*(.+)$/;  // Safe
const NORMAL_OPTION_PATTERN = /^\s*(\d+)\.\s*(.+)$/;              // Safe
```

**Recommendation**: Add a Phase 2 checklist item: "Run `npx safe-regex` or equivalent tool against CODEX_CHOICE_INDICATOR_PATTERN and CODEX_CHOICE_NORMAL_PATTERN to verify ReDoS safety." Document the specific construction rules in a test comment.

---

### DR4-003 [should_fix] Defense in Depth: requireDefaultIndicator=false reduces auto-yes false-positive defense

**Category**: Defense in Depth (Logic Flaw)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/prompt-detector.ts` (Layer 4)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-manager.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-resolver.ts`

**Description**: The design disables Layer 4b for Codex (`requireDefaultIndicator: false`):

```typescript
// Design doc section 5.2
if (requireDefault && !hasDefaultIndicator) {
  return { isPrompt: false, type: 'none', ... };
}
// If requireDefault is false, skip Layer 4b and proceed with detection
```

With Layer 4b disabled, the remaining defenses are:
- **Layer 1**: `detectThinking()` check in `auto-yes-manager.ts` L284 -- but only works during active thinking
- **Layer 3**: `isConsecutiveFromOne()` -- but Issue #161 noted that false-positive numbered lists ARE consecutive from 1
- **Layer 4a**: `options.length < 2` -- basic minimum count

The auto-yes resolver (`auto-yes-resolver.ts` L25) selects `options[0]` when no default is found, meaning a false positive would send "1" to tmux:

```typescript
// auto-yes-resolver.ts L24-25
const defaultOpt = promptData.options.find(o => o.isDefault);
const target = defaultOpt ?? promptData.options[0];
```

**Recommendation**: Add a Codex-specific validation layer (e.g., require a question line ending with `?` above the options). Document the accepted residual risk in section 14 (Risks and Mitigations).

---

### DR4-004 [should_fix] Information Disclosure: Error messages echo user input

**Category**: Information Disclosure (OWASP A01:2021)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/prompt-detector.ts` (L418)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/respond/route.ts` (L109)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts` (L44)

**Description**: `getAnswerInput()` echoes user input in error messages:

```typescript
// prompt-detector.ts L418
throw new Error(`Invalid answer for multiple choice: ${answer}. Expected a number.`);
```

This is returned to the client via `respond/route.ts` L109:

```typescript
return NextResponse.json(
  { error: `Invalid answer: ${errorMessage}` },
  { status: 400 }
);
```

Additionally, `prompt-response/route.ts` L44 includes the worktree ID in the 404 response:

```typescript
{ error: `Worktree '${params.id}' not found` }
```

**Recommendation**: Use fixed error messages consistent with the project's security pattern in `db-repository.ts` (documented in CLAUDE.md). For example: `"Invalid answer format"` instead of echoing the user's input.

---

### DR4-005 [should_fix] Input Validation: prompt-response/route.ts lacks answer format validation

**Category**: Input Validation (OWASP A03:2021)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts`

**Description**: The `prompt-response/route.ts` endpoint performs prompt state re-verification (L72-87) but does not validate the format of the `answer` parameter. Unlike `respond/route.ts` which validates against prompt type, any string passes through:

```typescript
// prompt-response/route.ts L30-36
if (!answer) {  // Only checks existence, not format
  return NextResponse.json(
    { error: 'answer is required' },
    { status: 400 }
  );
}
```

The design document section 6.1 states `getAnswerInput() numeric validation -- no change`, but this only applies to the `respond/route.ts` code path. The `prompt-response/route.ts` path has no format validation.

**Recommendation**: After the prompt re-verification succeeds (L77), use the detected `promptCheck.promptData.type` to validate the answer format using `getAnswerInput()` or equivalent logic. Add a maximum length check (e.g., 1000 characters).

---

### DR4-006 [should_fix] Command Injection: tmux.ts uses exec() instead of execFile()

**Category**: Command Injection (OWASP A03:2021)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/tmux.ts`

**Description**: All tmux operations in `tmux.ts` use `execAsync` (which is `promisify(exec)`) with string interpolation:

```typescript
// tmux.ts L175-177 (createSession)
await execAsync(
  `tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`,
  { timeout: DEFAULT_TIMEOUT }
);

// tmux.ts L215-217 (sendKeys)
const command = sendEnter
  ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
  : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;
await execAsync(command, { timeout: DEFAULT_TIMEOUT });
```

While `sessionName` is validated by `SESSION_NAME_PATTERN` and `escapedKeys` has single-quote escaping, using `exec()` means the entire command string goes through shell interpretation. The project's `git-utils.ts` uses `execFile()` for similar operations (documented in CLAUDE.md), establishing a precedent.

**Recommendation**: This is an existing issue, not introduced by Issue #193. However, since the design changes add Codex as a new auto-yes target (increasing the frequency of `sendKeys` calls), consider migrating to `execFile('tmux', ['send-keys', '-t', sessionName, keys])` as part of the implementation or as a follow-up issue. This would eliminate shell interpretation entirely.

---

### DR4-007 [nice_to_have] Rate Limiting: No throttling on prompt-response API

**Category**: Rate Limiting (OWASP A05:2021)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts`

**Description**: The prompt-response endpoint has no rate limiting, unlike the auto-yes path which has MAX_CONCURRENT_POLLERS=50 and error backoff. A rapid-fire client could send many responses in quick succession.

**Recommendation**: Add a simple per-worktree rate limiter (e.g., max 5 requests per second). Consider as a separate improvement issue.

---

### DR4-008 [nice_to_have] Logging: Auto-Yes success log lacks answer details

**Category**: Security Logging (OWASP A09:2021)
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-manager.ts` (L323)

**Description**: The auto-yes success log does not include the answer sent:

```typescript
// auto-yes-manager.ts L323
console.info(`[Auto-Yes Poller] Sent response for worktree: ${worktreeId}`);
```

In contrast, `respond/route.ts` L150 logs the input value. For security auditing, knowing what was auto-responded is valuable.

**Recommendation**: Include the answer value and prompt type in the log: `[Auto-Yes Poller] Sent '${answer}' (${promptData.type}) for worktree: ${worktreeId}`.

---

### DR4-009 [nice_to_have] TEXT_INPUT_PATTERNS lack word boundaries

**Category**: Defense in Depth
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/prompt-detector.ts` (L169-175)

**Description**: Patterns like `/type\s+here/i` and `/custom/i` could match substrings in legitimate option labels (e.g., "Customize settings" would match `/custom/i`), incorrectly marking options as requiring text input and preventing auto-yes from selecting them.

**Recommendation**: Add word boundaries: `/\bcustom\b/i`. This is a pre-existing issue not introduced by Issue #193.

---

### DR4-010 [nice_to_have] ANSI_PATTERN regex uses /g flag at module level

**Category**: Informational
**Affected Files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/cli-patterns.ts` (L167)

**Description**: The ANSI_PATTERN uses `/g` flag at module level. While `String.prototype.replace()` handles lastIndex correctly, this could be a concern if the pattern is ever used with `.test()` or `.exec()`.

**Recommendation**: Informational only. No change needed for current usage.

---

## 3. Security Checklist

| Category | Status | Details |
|----------|--------|---------|
| ReDoS Prevention | Pass with caveat | Existing patterns are safe. TBD patterns need automated verification. |
| Command Injection | Pass with caveat | Session names validated. sendKeys uses exec() with basic escaping. |
| Input Validation | Partial pass | respond/route.ts validates; prompt-response/route.ts does not. |
| Auto-Yes Safety | Pass with caveat | Layer 4 conditionally disabled for Codex; Layers 1/3 remain. |
| Information Disclosure | Partial pass | Some error messages echo user input. |
| OWASP A03 (Injection) | Partial | exec() used for tmux; should be execFile(). |
| OWASP A09 (Logging) | Partial | Auto-yes audit logging lacks answer details. |

---

## 4. OWASP Top 10 Compliance Summary

| OWASP Category | Applicability | Status |
|----------------|---------------|--------|
| A01: Broken Access Control | N/A (localhost app) | N/A |
| A02: Cryptographic Failures | N/A (no crypto in scope) | N/A |
| A03: Injection | Applicable | Partial -- DR4-001, DR4-005, DR4-006 |
| A04: Insecure Design | Applicable | Pass -- pattern parameterization maintains SoC |
| A05: Security Misconfiguration | Low applicability | Pass |
| A06: Vulnerable Components | N/A (no new deps) | N/A |
| A07: Identification/Authentication | N/A (localhost app) | N/A |
| A08: Software/Data Integrity | Low applicability | Pass |
| A09: Logging/Monitoring | Applicable | Partial -- DR4-008 |
| A10: SSRF | N/A (no outbound requests) | N/A |

---

## 5. Risk Assessment

**Overall Risk Level**: Low

**Rationale**: The application runs on localhost by default (CM_BIND=127.0.0.1). The proposed changes are in-memory pattern matching logic with no new network APIs, database changes, or authentication modifications. The primary attack surface (tmux sendKeys) is mitigated by session name validation and single-quote escaping, though migration to execFile() would provide stronger guarantees.

**Residual Risks**:
1. If CM_BIND=0.0.0.0 is configured, unvalidated prompt-response input could be exploited from the network
2. Codex false-positive auto-yes is possible if Codex outputs consecutive numbered lists during non-thinking states
3. TBD Codex regex patterns could introduce ReDoS if not properly constructed during Phase 2

---

## 6. Findings Summary

| Severity | Count |
|----------|-------|
| must_fix | 2 |
| should_fix | 4 |
| nice_to_have | 4 |
| **Total** | **10** |

---

*Generated by architecture-review-agent (Stage 4: Security Review)*
*Date: 2026-02-08*
