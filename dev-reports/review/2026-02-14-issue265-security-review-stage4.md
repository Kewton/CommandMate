# Architecture Review: Issue #265 - Security Review (Stage 4)

**Date**: 2026-02-14
**Issue**: #265 - Claude CLI Path Cache Invalidation and Broken tmux Session Auto-Recovery
**Focus**: Security (OWASP Top 10)
**Status**: Conditionally Approved
**Score**: 4/5

---

## 1. Executive Summary

Issue #265 addresses three independent bugs: (1) stale CLI path cache, (2) broken tmux session detection/recovery, and (3) CLAUDECODE environment variable leakage into tmux sessions. The design policy document demonstrates strong security awareness for newly introduced `execAsync` calls (fixed strings only, no user input interpolation) and session name sanitization. However, one critical gap exists: the `CLAUDE_PATH` environment variable is consumed without validation and ultimately executed as a shell command via `sendKeys()`. Additionally, `claude-session.ts` has its own `getSessionName()` that lacks the `validateSessionName()` guard present in `BaseCLITool.getSessionName()`.

Overall, the design is sound with minimal new attack surface. The Must Fix item (SEC-MF-001) should be addressed before implementation proceeds.

---

## 2. OWASP Top 10 Checklist

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | N/A | No auth/authz changes in scope |
| A02 | Cryptographic Failures | N/A | No cryptographic operations affected |
| A03 | Injection | Conditional Pass | Fixed-string execAsync is safe; CLAUDE_PATH validation needed (SEC-MF-001) |
| A04 | Insecure Design | Pass | Health check pattern design is defensive; timeout fallback exists |
| A05 | Security Misconfiguration | Pass | Global tmux env operation acceptable for CLAUDECODE-only scope |
| A06 | Vulnerable Components | N/A | No new dependencies added |
| A07 | Auth Failures | N/A | No HTTP session/auth changes |
| A08 | Software/Data Integrity | Pass | Cache clear is simple null assignment; no deserialization |
| A09 | Logging & Monitoring | Pass | Follows existing patterns; exception suppression logging recommended |
| A10 | SSRF | N/A | No server-side HTTP requests added |

---

## 3. Detailed Findings

### 3.1 Must Fix (1 item)

#### SEC-MF-001: CLAUDE_PATH Environment Variable - Unvalidated Command Execution

**Severity**: High | **Impact**: High | **Probability**: Low | **Priority**: P1
**OWASP**: A03:2021 - Injection

**Problem**:

In `src/lib/claude-session.ts`, the `getClaudePath()` function (L125-162) reads `process.env.CLAUDE_PATH` and stores it directly as `cachedClaudePath` without any validation:

```typescript
// src/lib/claude-session.ts L131-134 (current code)
if (process.env.CLAUDE_PATH) {
  cachedClaudePath = process.env.CLAUDE_PATH;
  return cachedClaudePath;
}
```

This cached path is later passed to `sendKeys()` (L329):

```typescript
await sendKeys(sessionName, claudePath, true);
```

Inside `tmux.ts`, `sendKeys()` constructs a shell command:

```typescript
// src/lib/tmux.ts L215-217
const command = sendEnter
  ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
  : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;
```

While `sendKeys()` escapes single quotes in the key string, a malicious `CLAUDE_PATH` value could exploit the tmux `send-keys` semantics. The string is typed into the tmux shell session and executed with Enter (C-m), so any value will be executed as a shell command within the tmux session.

**Attack Scenario**: If an attacker can control the `CLAUDE_PATH` environment variable (e.g., in a shared server environment, CI/CD pipeline, or through `.env` file manipulation), they could set it to an arbitrary command path containing shell metacharacters or point to a malicious executable.

**Note**: The design policy document's Section 6 states "New execAsync calls use fixed strings only" and "No user-input command construction" -- this is accurate for the newly proposed code. However, the existing `getClaudePath()` path (which is exercised after the Bug 1 fix triggers cache clearing) has this pre-existing vulnerability that becomes more frequently exercisable after the fix.

**Recommendation**:

Add path validation in `getClaudePath()`:

```typescript
// Proposed validation for CLAUDE_PATH
function isValidClaudePath(pathValue: string): boolean {
  // Allow only typical filesystem path characters
  const VALID_PATH_PATTERN = /^[/a-zA-Z0-9._-]+$/;
  return VALID_PATH_PATTERN.test(pathValue);
}

async function getClaudePath(): Promise<string> {
  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  if (process.env.CLAUDE_PATH) {
    const envPath = process.env.CLAUDE_PATH;
    if (!isValidClaudePath(envPath)) {
      throw new Error('CLAUDE_PATH contains invalid characters');
    }
    cachedClaudePath = envPath;
    return cachedClaudePath;
  }
  // ... rest of function
}
```

---

### 3.2 Should Fix (4 items)

#### SEC-SF-001: Session Name Validation Gap in claude-session.ts

**Severity**: Medium | **Impact**: Medium | **Probability**: Low | **Priority**: P2
**OWASP**: A03:2021 - Injection

**Problem**:

`src/lib/claude-session.ts` defines its own `getSessionName()` (L192-194):

```typescript
export function getSessionName(worktreeId: string): string {
  return `mcbd-claude-${worktreeId}`;
}
```

Unlike `BaseCLITool.getSessionName()` in `src/lib/cli-tools/base.ts` (L46-49) which calls `validateSessionName()`, this function does not validate the resulting session name. The `worktreeId` parameter flows from `params.id` in API routes (e.g., `send/route.ts` L51) which is a URL path parameter.

In the proposed design, `sanitizeSessionEnvironment()` calls `sendKeys(sessionName, 'unset CLAUDECODE', true)` where `sessionName` is generated by this unvalidated function. While tmux.ts wraps session names in double quotes, a crafted `worktreeId` containing `"` could potentially break the quoting.

**Current Mitigation**: The `params.id` values come from database lookups (worktree IDs), which are typically sanitized at creation time. However, defense-in-depth requires validation at the point of shell command construction.

**Recommendation**: Add `validateSessionName()` call to `claude-session.ts`'s `getSessionName()`, consistent with `BaseCLITool`:

```typescript
import { validateSessionName } from './cli-tools/validation';

export function getSessionName(worktreeId: string): string {
  const sessionName = `mcbd-claude-${worktreeId}`;
  validateSessionName(sessionName);
  return sessionName;
}
```

---

#### SEC-SF-002: Internal Path Information Leakage in Error Messages

**Severity**: Low | **Impact**: Low | **Probability**: Medium | **Priority**: P2
**OWASP**: A04:2021 - Insecure Design

**Problem**:

The proposed catch block modification in `startClaudeSession()`:

```typescript
} catch (error) {
  clearCachedClaudePath(); // MF-S2-002
  throw error;
}
```

The outer catch at L378-380 wraps this:

```typescript
throw new Error(`Failed to start Claude session: ${getErrorMessage(error)}`);
```

Error messages from `execAsync`, `getClaudePath()`, or `createSession()` may contain:
- File system paths (e.g., `/opt/homebrew/bin/claude`)
- tmux internal error messages with session details
- System-level error messages with OS details

These propagate to API route error responses (e.g., `send/route.ts` L120: `{ error: 'Failed to start session: ...' }`), potentially exposing internal architecture details to the client.

**Recommendation**: In API routes, sanitize error messages before returning to clients. Log the full error server-side but return only generic messages to clients.

---

#### SEC-SF-003: Global tmux Environment Scope -- Migration Trigger Documentation

**Severity**: Low | **Impact**: Medium | **Probability**: Low | **Priority**: P3
**OWASP**: A05:2021 - Security Misconfiguration

**Problem**:

The design correctly analyzes the impact of `tmux set-environment -g -u CLAUDECODE` (MF-S3-002), confirming it is safe for the current scope (CLAUDECODE is Claude-specific, operation is idempotent). The design also notes future consideration for session-scoped operations.

However, the "trigger condition" for migration is vague: "If more tmux global environment operations are added for other CLI tools."

**Recommendation**: Add a concrete trigger condition in the code comment:

```typescript
// MF-S3-002: -g flag affects global tmux environment.
// Migration trigger: If sanitizeSessionEnvironment() needs to unset
// any variable that is NOT specific to a single CLI tool type,
// switch to session-scoped set-environment (without -g flag).
// Current: Only CLAUDECODE (Claude-specific) -> global scope is safe.
```

---

#### SEC-SF-004: Health Check Pattern Evasion Risk

**Severity**: Medium | **Impact**: Medium | **Probability**: Low | **Priority**: P2
**OWASP**: A04:2021 - Insecure Design

**Problem**:

`isSessionHealthy()` relies on string pattern matching against CLI output:

```typescript
// Error string matching
for (const pattern of CLAUDE_SESSION_ERROR_PATTERNS) {
  if (cleanOutput.includes(pattern)) {
    return false;
  }
}
```

The current error pattern is a single English string:
```typescript
export const CLAUDE_SESSION_ERROR_PATTERNS: readonly string[] = [
  'Claude Code cannot be launched inside another Claude Code session',
] as const;
```

Risks:
1. **Claude CLI version updates** may change error message wording
2. **Locale-dependent messages**: If Claude CLI outputs localized error messages, the English-only pattern will not match
3. **Partial output capture**: If the tmux pane output is truncated, the error pattern may be split across the capture boundary

The design document acknowledges false-positive risk for `SHELL_PROMPT_ENDINGS` (C-S2-002) but does not address false-negative risk (failing to detect broken sessions).

**Existing Mitigation**: The `CLAUDE_INIT_TIMEOUT` (15s) provides a fallback -- if a session is incorrectly judged healthy but is actually broken, the initialization polling will eventually timeout and throw an error.

**Recommendation**:
1. Document in the design policy that `CLAUDE_INIT_TIMEOUT` serves as a safety net against `isSessionHealthy()` false negatives
2. Add a comment in the `CLAUDE_SESSION_ERROR_PATTERNS` definition noting the Claude CLI version dependency and the need to verify patterns when upgrading Claude CLI
3. Consider adding a process-level check (e.g., checking if the tmux pane's child process is alive) as a future defense-in-depth measure

---

### 3.3 Consider (3 items)

#### SEC-C-001: CLAUDE_PATH Security Documentation

Document the security implications of the `CLAUDE_PATH` environment variable. In shared server environments, users who can modify environment variables could redirect Claude CLI execution to a malicious binary. Add a note to `.env.example` or README indicating this variable should only be set in trusted environments.

#### SEC-C-002: stopClaudeSession() Direct execAsync Usage

In `stopClaudeSession()` (L489), `execAsync(`tmux send-keys -t "${sessionName}" C-d`)` constructs a shell command with string interpolation rather than using the `sendKeys()` wrapper from tmux.ts. While currently safe (sessionName contains only `[a-zA-Z0-9_-]`), this pattern bypasses the escaping logic in `sendKeys()`. Consider refactoring to use `sendSpecialKey(sessionName, 'C-d')` for consistency.

#### SEC-C-003: isSessionHealthy() Silent Exception Handling

The catch block in `isSessionHealthy()` silently returns `false` for all exceptions. While this correctly triggers session recovery, repeated failures (e.g., tmux daemon crash, permission issues) will go unlogged, potentially delaying operational incident detection. Consider adding `console.warn` logging in the catch block.

---

## 4. Risk Assessment

| Risk Category | Level | Rationale |
|--------------|-------|-----------|
| Technical | Low | Changes are well-scoped with clear helper function separation (SRP). Fallback mechanisms (timeouts) provide safety nets. |
| Security | Medium | Pre-existing CLAUDE_PATH validation gap (SEC-MF-001) becomes more exercisable after Bug 1 fix. New code (execAsync with fixed strings) has minimal attack surface. |
| Operational | Low | Health check adds ~50ms overhead per API call, within acceptable range. Auto-recovery reduces manual intervention needs. |

---

## 5. Security Design Review of Proposed Changes

### 5.1 Bug 1: Cache Invalidation (Low Risk)

- `clearCachedClaudePath()` performs `cachedClaudePath = null` -- no security concern
- Cache clearing in catch block is safe (null assignment, no side effects)
- `@internal` export tag follows established patterns (version-checker.ts)

### 5.2 Bug 2: Health Check and Session Recovery (Low Risk)

- `getCleanPaneOutput()` is a pure wrapper around `capturePane() + stripAnsi()` -- no new attack surface
- `isSessionHealthy()` reads tmux pane output (read-only operation) and performs local string matching -- no injection vector
- `ensureHealthySession()` calls `killSession()` which is already well-protected in tmux.ts
- Pattern matching dependency documented as limitation (SEC-SF-004)

### 5.3 Bug 3: CLAUDECODE Environment Variable Removal (Low-Medium Risk)

- `execAsync('tmux set-environment -g -u CLAUDECODE 2>/dev/null || true')` -- fixed string, safe
- `sendKeys(sessionName, 'unset CLAUDECODE', true)` -- sessionName validation gap noted (SEC-SF-001), but fixed command string `'unset CLAUDECODE'` is safe
- `daemon.ts` env object manipulation (`delete env.CLAUDECODE`) -- safe, no process.env mutation

### 5.4 Design Document Section 6 Assessment

The design policy document's security section correctly identifies:
- Session name sanitization via `getSessionName()` (though the gap in claude-session.ts version is noted)
- `execAsync` timeout usage
- No user-input command construction in new code

Missing from the security section:
- `CLAUDE_PATH` environment variable validation (SEC-MF-001)
- Error message sanitization for client responses (SEC-SF-002)
- Health check pattern evasion analysis (SEC-SF-004)

---

## 6. Improvement Recommendations Summary

### Must Fix (before implementation)

| ID | Title | Priority |
|----|-------|----------|
| SEC-MF-001 | Validate CLAUDE_PATH environment variable before use in getClaudePath() | P1 |

### Should Fix (during implementation)

| ID | Title | Priority |
|----|-------|----------|
| SEC-SF-001 | Add validateSessionName() to claude-session.ts getSessionName() | P2 |
| SEC-SF-002 | Sanitize error messages in API responses (or document as known limitation) | P2 |
| SEC-SF-003 | Document concrete migration trigger for session-scoped tmux env operations | P3 |
| SEC-SF-004 | Document health check pattern limitations and CLAUDE_INIT_TIMEOUT safety net | P2 |

### Consider (future)

| ID | Title |
|----|-------|
| SEC-C-001 | Document CLAUDE_PATH security implications in environment variable docs |
| SEC-C-002 | Refactor stopClaudeSession() to use sendSpecialKey() instead of direct execAsync |
| SEC-C-003 | Add warning-level logging to isSessionHealthy() exception handler |

---

## 7. Approval Status

**Status: Conditionally Approved**

The design is approved for implementation on the condition that **SEC-MF-001** (CLAUDE_PATH validation) is addressed. This can be implemented as part of the `getClaudePath()` function modification, which is already in scope for Bug 1 (cache invalidation fix).

The Should Fix items (SEC-SF-001 through SEC-SF-004) are recommended for inclusion in the implementation but are not blocking.

---

## 8. Reviewed Files

| File | Review Scope |
|------|-------------|
| `src/lib/claude-session.ts` | Primary target -- all proposed changes reviewed |
| `src/lib/cli-patterns.ts` | New constant additions reviewed |
| `src/cli/utils/daemon.ts` | CLAUDECODE env removal in spawn reviewed |
| `src/lib/tmux.ts` | Shell command construction and escaping reviewed |
| `src/lib/cli-tools/base.ts` | Session name validation pattern reviewed |
| `src/lib/cli-tools/claude.ts` | ICLITool wrapper delegation reviewed |
| `src/lib/cli-tools/validation.ts` | Session name validation logic reviewed |
| `src/app/api/worktrees/[id]/send/route.ts` | Error propagation to client reviewed |
| `dev-reports/design/issue-265-claude-session-recovery-design-policy.md` | Full design document reviewed |
