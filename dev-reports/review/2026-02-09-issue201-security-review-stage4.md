# Issue #201: Security Architecture Review (Stage 4)

## Executive Summary

**Issue**: #201 - Trust dialog auto-response for Claude CLI v2.x
**Focus**: Security (OWASP Top 10 compliance, input validation, security boundaries, attack vectors)
**Status**: approved
**Score**: 5/5
**Date**: 2026-02-09

This security review evaluates the design for automatically responding to Claude CLI's "Quick safety check" trust dialog during session initialization. The proposed change adds a regex pattern constant (`CLAUDE_TRUST_DIALOG_PATTERN`) and a conditional Enter-key send within the existing `startClaudeSession()` polling loop. The review found no security vulnerabilities, no input validation gaps, and no attack surface expansion of concern. The design follows established security patterns in the codebase.

---

## Review Scope

### Files Reviewed

| File | Role in Change |
|------|---------------|
| `src/lib/cli-patterns.ts` | Pattern constant definition (CLAUDE_TRUST_DIALOG_PATTERN to be added) |
| `src/lib/claude-session.ts` | Polling loop modification (dialog detection + Enter send) |
| `src/lib/tmux.ts` | sendKeys() implementation (command construction and escaping) |
| `src/lib/cli-tools/validation.ts` | Session name validation (SESSION_NAME_PATTERN) |
| `src/lib/cli-tools/claude.ts` | ClaudeTool.startSession() call chain |
| `src/lib/auto-yes-manager.ts` | Auto-Yes polling lifecycle (interaction analysis) |
| `src/lib/auto-yes-resolver.ts` | Auto-Yes answer resolution (interaction analysis) |
| `src/lib/prompt-detector.ts` | Prompt detection logic (interaction analysis) |
| `src/app/api/worktrees/[id]/send/route.ts` | API route entry point (call chain analysis) |
| `src/lib/__tests__/cli-patterns.test.ts` | Test coverage for pattern constants |

### Design Document

`dev-reports/design/issue-201-trust-dialog-auto-response-design-policy.md`

### Previous Review Results

- Stage 1 (Design Principles): approved, score 5/5
- Stage 2 (Consistency): approved, score 5/5
- Stage 3 (Impact Analysis): approved, score 5/5

---

## OWASP Top 10 Checklist

### A01:2021 - Broken Access Control

**Status**: Not Applicable

The change operates within `startClaudeSession()`, which is called through the existing authenticated API route chain (`POST /api/worktrees/:id/send` -> `ClaudeTool.startSession()` -> `startClaudeSession()`). No new access control paths are introduced. The trust dialog auto-response is internal to session initialization and does not create new access surfaces.

### A02:2021 - Cryptographic Failures

**Status**: Not Applicable

No cryptographic operations are involved. No secrets, tokens, or encrypted data are processed.

### A03:2021 - Injection

**Status**: Pass

This is the most relevant OWASP category for this change due to the tmux command execution. Analysis:

1. **sendKeys() call**: The design specifies `await sendKeys(sessionName, '', true)` to send Enter. The `keys` parameter is an empty string -- no user-controlled content is injected into the tmux command.

2. **sessionName validation**: The `sessionName` is constructed via `getSessionName(worktreeId)` which produces `'mcbd-claude-' + worktreeId`. The `worktreeId` is validated upstream by `SESSION_NAME_PATTERN` (`/^[a-zA-Z0-9_-]+$/`) in `src/lib/cli-tools/validation.ts`, preventing shell metacharacter injection.

3. **tmux command construction**: In `tmux.ts` L215-217, the command is built as:
   ```
   tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m
   ```
   With `keys=''`, the escaped keys portion is empty. The `sessionName` is double-quoted, preventing word splitting. Single quotes in keys are properly escaped via `keys.replace(/'/g, "'\\''")`.

4. **No new user input paths**: The `CLAUDE_TRUST_DIALOG_PATTERN` is a compile-time constant. The Enter response is a hardcoded empty string. No external input reaches the tmux command layer through this change.

**Verdict**: No injection vulnerability.

### A04:2021 - Insecure Design

**Status**: Pass

The auto-trust design decision is justified:

- **User intent**: When a user selects a worktree in CommandMate's UI and sends a message, they have explicitly chosen to work in that workspace. The trust dialog is redundant in this context.
- **Minimal action**: Only an Enter keypress is sent (accepting the default "Yes, I trust this folder" selection). No commands, paths, or configuration changes are made.
- **One-time guard**: The `trustDialogHandled` flag prevents repeated sends within the same initialization cycle.
- **Scope limitation**: The auto-response is confined to `startClaudeSession()` initialization. It does not affect message sending (`sendMessageToClaude()`), prompt responses, or Auto-Yes behavior.

### A05:2021 - Security Misconfiguration

**Status**: Pass

No new configuration surfaces are introduced. No new environment variables, config files, or settings are added. The `CLAUDE_INIT_TIMEOUT` (15s) is shared but unchanged.

### A06:2021 - Vulnerable and Outdated Components

**Status**: Not Applicable

No new dependencies. The change uses existing modules only.

### A07:2021 - Identification and Authentication Failures

**Status**: Not Applicable

No authentication mechanism changes. The trust dialog response is a tmux-level keyboard input.

### A08:2021 - Software and Data Integrity Failures

**Status**: Pass

The `CLAUDE_TRUST_DIALOG_PATTERN` is a compile-time constant, not derived from external input or configuration. The regex cannot be modified at runtime. No deserialization is involved.

### A09:2021 - Security Logging and Monitoring Failures

**Status**: Pass

The design specifies a fixed-string log message: `'Trust dialog detected, sending Enter to confirm'`. This follows the project's SEC-003 pattern (used in `prompt-detector.ts` `getAnswerInput()`) of using fixed error messages to prevent log injection. No user input, paths, or dynamic content is included.

Existing log lines in `claude-session.ts` that include `sessionName` (L347, L361) are safe because `sessionName` is validated to contain only `[a-zA-Z0-9_-]+` characters.

### A10:2021 - Server-Side Request Forgery

**Status**: Not Applicable

No server-side requests to external URLs. The change operates entirely within local tmux session management.

---

## Security Boundary Analysis

### Trust Boundary: CommandMate <-> Claude CLI

The trust boundary between CommandMate and Claude CLI is **maintained**. Analysis:

| Aspect | Assessment |
|--------|-----------|
| What is sent | Empty string + Enter (equivalent to pressing Enter key) |
| When it is sent | During initialization only, before session is marked ready |
| How many times | At most once per session (trustDialogHandled flag) |
| What it affects | Accepts default trust dialog selection ("Yes, I trust this folder") |
| Does it bypass CLI security | No -- it responds to a dialog, not bypasses it. Claude CLI still controls what happens after trust is granted |

### Trust Boundary: User <-> CommandMate

The user's trust intent is established by the act of selecting a worktree and initiating a session. The auto-response does not grant permissions beyond what the user has already implicitly approved. If a user did NOT want to trust a workspace, they would not have selected it in CommandMate's UI.

### Trust Boundary: Auto-Yes <-> Trust Dialog

These mechanisms operate in non-overlapping lifecycle phases:

```
Session Lifecycle:
  [Initialization Phase] -> [Active Phase]
       |                         |
  Trust dialog handler      Auto-Yes polling
  (startClaudeSession)      (auto-yes-manager)
       |                         |
  Completes before           Starts after
  function returns           session is ready
```

There is no race condition or interaction between these two auto-response mechanisms.

---

## Input Validation Assessment

| Input | Source | Validation | Status |
|-------|--------|-----------|--------|
| `sessionName` | `getSessionName(worktreeId)` | `SESSION_NAME_PATTERN: /^[a-zA-Z0-9_-]+$/` | Adequate |
| `keys` (sendKeys parameter) | Hardcoded empty string `''` | N/A (no user input) | Adequate |
| `CLAUDE_TRUST_DIALOG_PATTERN` | Compile-time constant | Immutable | Adequate |
| `worktreeId` | API route parameter | Validated by `isValidWorktreeId()` in auto-yes-manager, DB lookup in send/route.ts | Adequate |
| `worktreePath` | Database record | Retrieved from DB by validated worktreeId | Adequate |

No new external inputs are introduced by this change.

---

## Regex Security Analysis

### CLAUDE_TRUST_DIALOG_PATTERN: `/Yes, I trust this folder/m`

| Property | Assessment |
|----------|-----------|
| ReDoS vulnerability | None -- simple fixed string, no quantifiers, alternation, or backtracking |
| False positive risk | Very low -- specific English phrase unlikely in normal CLI output during initialization |
| False negative risk | Low -- exact match on Claude CLI's current English dialog text. Would break if Claude CLI changes dialog wording or supports localization |
| Anchoring strategy | Intentionally unanchored (partial match). Documented via SF-001 inline comment requirement |

The `/m` multiline flag has no practical effect on this pattern since it contains no `^` or `$` anchors. It is included for consistency with other pattern constants.

---

## Race Condition Analysis

The `trustDialogHandled` flag is a local variable within `startClaudeSession()`:

```typescript
let trustDialogHandled = false; // Function scope, not shared

while (Date.now() - startTime < maxWaitTime) {
  // Sequential: await capturePane -> test -> await sendKeys -> loop
  if (!trustDialogHandled && CLAUDE_TRUST_DIALOG_PATTERN.test(cleanOutput)) {
    await sendKeys(sessionName, '', true);
    trustDialogHandled = true;
  }
}
```

- **Single-threaded**: Node.js event loop ensures sequential execution of the async polling loop.
- **No shared state**: The flag is local to the function invocation, not module-scoped or global.
- **No concurrent access**: Only one polling iteration runs at a time due to `await`.

There is no TOCTOU (time-of-check-time-of-use) vulnerability.

---

## Attack Vector Analysis

### Vector 1: Malicious tmux buffer content during initialization

**Scenario**: An attacker places the string "Yes, I trust this folder" in the tmux buffer during Claude CLI initialization.

**Assessment**: For this attack to succeed, the attacker would need:
1. Write access to the tmux session buffer during the narrow initialization window (typically < 2 seconds)
2. Claude CLI to NOT be the process running in the tmux session

This requires local system access with the same user privileges, at which point the attacker already has direct access to the filesystem and processes. The attack provides no privilege escalation.

**Risk**: Negligible. The blast radius is a single Enter keypress.

### Vector 2: Crafted worktreeId for command injection via sessionName

**Scenario**: An attacker provides a malicious worktreeId to inject shell commands into the tmux send-keys command.

**Assessment**: The `SESSION_NAME_PATTERN` (`/^[a-zA-Z0-9_-]+$/`) validates that worktreeId contains only safe characters. The sessionName is further prefixed with `mcbd-claude-`. Even without validation, the sessionName is double-quoted in the tmux command, and the keys parameter is empty. This vector is blocked by existing defenses.

**Risk**: None.

### Vector 3: Auto-Yes responding to trust dialog instead of intended prompt

**Scenario**: The Auto-Yes mechanism detects and responds to a trust dialog instead of a y/n or multiple-choice prompt.

**Assessment**: The trust dialog appears only during initialization (before `startClaudeSession()` returns). Auto-Yes polling only starts after the session is fully initialized and the user explicitly enables auto-yes mode. These lifecycle phases do not overlap. Furthermore, the trust dialog does not match any pattern in `detectPrompt()` (it is neither a y/n nor a numbered multiple-choice format).

**Risk**: None.

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | Simple regex test + conditional Enter send. No complex logic, no state management beyond a local boolean flag |
| Security | Low | No new attack surfaces, no user input processing, no privilege changes. All tmux inputs are hardcoded or validated |
| Operational | Low | Transparent to users. Falls back to existing timeout behavior if pattern does not match. No configuration required |

---

## Findings Summary

### Must Fix: 0 items

No security issues requiring remediation.

### Should Fix: 0 items

No security improvements needed.

### Consider: 2 items

| ID | Title | Severity | OWASP |
|----|-------|----------|-------|
| C-001 | CLAUDE_TRUST_DIALOG_PATTERN partial match scope on adversarial tmux buffer content | Informational | N/A |
| C-002 | Log message information disclosure assessment | Informational | A09 |

#### C-001: Partial match scope

The unanchored regex could theoretically match on non-dialog content if the exact phrase appears in the tmux buffer during initialization. This is a theoretical risk with negligible impact (single Enter keypress). The design document already documents this decision (SF-001) with appropriate justification. No action needed.

#### C-002: Log message assessment

The fixed-string log message approach is consistent with the project's SEC-003 security pattern. Existing log lines that include sessionName are safe due to character validation. The SF-002 TODO for future log structure unification is already planned. No action needed.

---

## Conclusion

The design for Issue #201 demonstrates sound security practices:

1. **Minimal privilege**: Only sends Enter (empty string + C-m), not commands or data
2. **Defense in depth**: trustDialogHandled flag, SESSION_NAME_PATTERN validation, sendKeys escaping
3. **Fixed inputs**: No user-controlled content reaches the tmux command layer
4. **Lifecycle isolation**: Trust dialog handling and Auto-Yes polling operate in non-overlapping phases
5. **Established patterns**: Follows existing SEC-003 (fixed log messages), SESSION_NAME_PATTERN (input validation), and DRY-001 (pattern centralization) conventions

The security risk assessment is **low** across all dimensions. The design is **approved** for implementation.

---

*Generated by architecture-review-agent (Stage 4: Security Review) for Issue #201*
*Reviewed: 2026-02-09*
