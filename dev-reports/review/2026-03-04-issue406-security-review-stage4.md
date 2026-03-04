# Issue #406: Security Architecture Review (Stage 4)

## Executive Summary

This review evaluates the security implications of converting synchronous I/O operations (`realpathSync()`, `readFileSync()`) to their async equivalents (`fs.promises.realpath()`, `fs.promises.readFile()`) in `cmate-parser.ts` and propagating the async change through `schedule-manager.ts`.

**Overall Assessment**: The design policy demonstrates thorough understanding of the security landscape. The core path traversal defense mechanism is fully preserved. However, the async transition introduces subtle concurrency and error propagation changes that require additional documentation and one mitigation measure.

**Status**: conditionally_approved (4/5)

---

## OWASP Top 10 Evaluation

| OWASP Category | Status | Notes |
|---------------|--------|-------|
| A01: Broken Access Control | PASS | Path traversal prevention via `realpath()` maintained |
| A02: Cryptographic Failures | N/A | No cryptographic operations affected |
| A03: Injection | PASS | Parameterized SQL queries unchanged, no command injection |
| A04: Insecure Design | PASS (conditional) | TOCTOU gap widened but within acceptable risk |
| A05: Security Misconfiguration | PASS | No new configuration surfaces |
| A06: Vulnerable Components | N/A | No new dependencies introduced |
| A07: Auth Failures | N/A | No auth logic affected |
| A08: Data Integrity | PASS | File content validation logic unchanged |
| A09: Logging Failures | PASS (conditional) | Error messages may disclose internal paths |
| A10: SSRF | N/A | No network requests affected |

---

## Detailed Security Analysis

### 1. Path Traversal Security (SEC-406-001)

**Finding**: `fs.promises.realpath()` and `realpathSync()` both invoke the same underlying libuv function (`uv_fs_realpath`). The symlink resolution behavior is identical. The validation logic in `validateCmatePath()` is unchanged:

```typescript
// cmate-parser.ts L88-95 - Logic preserved exactly
if (
  !realFilePath.startsWith(realWorktreeDir + path.sep) &&
  realFilePath !== path.join(realWorktreeDir, CMATE_FILENAME)
) {
  throw new Error(
    `Path traversal detected: ${filePath} is not within ${worktreeDir}`
  );
}
```

The `startsWith(realWorktreeDir + path.sep)` pattern correctly prevents prefix-match attacks (e.g., `/home/user/worktree-evil` matching `/home/user/worktree`). The fallback exact-match check for `CMATE_FILENAME` handles the edge case where the file is directly in the root of the worktree.

**Verdict**: SEC-406-001 is accurate. Path traversal defense is fully maintained.

### 2. TOCTOU (Time-of-Check-Time-of-Use) Analysis (SEC-406-002)

**Finding**: The design policy states "no practical risk increase" which is technically inaccurate but acceptable in context.

**Sync version TOCTOU window**: Between `realpathSync(filePath)` (L84) and `readFileSync(filePath)` (L317), the only interruption possible is an OS context switch. Window: ~microseconds.

**Async version TOCTOU window**: Between `await realpath(filePath)` and `await readFile(filePath)`, the event loop can process other pending microtasks and I/O callbacks. Window: milliseconds to potentially seconds under heavy load.

**Risk Assessment**: LOW. The attack requires:
1. Filesystem write access to the worktree directory (to create/modify symlinks)
2. Precise timing to replace the symlink between the two async operations
3. The `worktreeDir` paths are DB-derived (from `getAllWorktrees()`) and server-controlled

An attacker with filesystem write access could simply modify the CMATE.md content directly, making symlink replacement a strictly inferior attack vector.

**Reference**: SEC-406-002 in design policy Section 5.

### 3. Error Message Information Disclosure (SEC-406-003)

**Finding**: The error message at `cmate-parser.ts` L92-94 includes raw paths:

```typescript
throw new Error(
  `Path traversal detected: ${filePath} is not within ${worktreeDir}`
);
```

This error propagates through `readCmateFile()` when it is not an ENOENT (L320-327). In the current codebase, the only caller is `schedule-manager.ts` L516 which uses DB-derived paths. However, `validateCmatePath()` is exported (DJ-001) and `readCmateFile()` is also exported. Future callers could pass user-controllable paths, causing internal directory structures to appear in error responses.

The design policy states this is "maintained as-is" without assessing the disclosure risk.

### 4. Race Conditions in Concurrent syncSchedules() (NEW)

**Finding**: The design policy does not address the possibility of concurrent `syncSchedules()` invocations. With the sync version, `syncSchedules()` blocked the event loop, making concurrent execution impossible. With the async version, if a `syncSchedules()` invocation takes longer than `POLL_INTERVAL_MS` (60 seconds), the `setInterval` callback will fire while the previous invocation is still running.

Two concurrent executions would:
- Read/modify `manager.schedules` (Map) simultaneously
- Read/modify `manager.cmateFileCache` (Map) simultaneously
- Call `batchUpsertSchedules()` with potentially overlapping data
- Call `disableStaleSchedules()` with incomplete `activeScheduleIds`

While JavaScript is single-threaded, async yields (at each `await`) allow interleaving. For example:
1. Invocation A: reads worktree 1, starts `await readCmateFile(worktree1.path)`
2. Event loop yields, Invocation B starts: reads worktree 1, starts `await readCmateFile(worktree1.path)`
3. Both get the same config, both call `batchUpsertSchedules()`, both create cron jobs for the same schedules

This is the same pattern that `executeSchedule()` guards against with `state.isExecuting` (L422-425).

### 5. Unhandled Rejection in initScheduleManager() (DJ-002)

**Finding**: The design policy provides thorough analysis in DR3-002 about fail-fast behavior. However, the async transition introduces new error categories that bypass the internal try-catch:

- `fs.promises.realpath()` can reject with `EPERM` (transient permission change)
- `fs.promises.readFile()` can reject with `EMFILE` (too many open files)
- Module-level errors during dynamic import resolution

The internal try-catch at L486 (`for (const worktree of worktrees)`) catches per-worktree errors, and the outer try-catch at L574 (if it exists) would catch broader errors. However, any error thrown AFTER the for-loop completes but BEFORE the function returns (e.g., in `disableStaleSchedules()`) would propagate as an unhandled rejection.

Examining the code: `disableStaleSchedules()` at L370-409 has its own try-catch, so this specific scenario is covered. The fail-fast design is acceptable for the initial call.

### 6. Symlink Attack Prevention

**Finding**: The test at `cmate-parser.test.ts` L358-391 creates actual symlinks and verifies that `validateCmatePath()` rejects them. The test creates:
- A correct `CMATE.md` in `worktreeDir` (should pass)
- A symlink in `worktreeDir` pointing to `outsideDir/CMATE.md` (should throw)

The async version will resolve symlinks identically. The test needs only syntax changes (`async/await`, `resolves`/`rejects` matchers) as documented in Section 4.3.

**Verdict**: Symlink attack prevention is fully maintained.

### 7. Input Validation Preservation

**Finding**: All input validation occurs in pure functions that are not affected by the async transition:

| Validation | Function | Affected by async? |
|-----------|----------|-------------------|
| Name pattern | `NAME_PATTERN.test()` | No (pure regex) |
| Cron expression | `isValidCronExpression()` | No (pure function) |
| CLI tool type | `isCliToolType()` | No (pure function) |
| Unicode sanitization | `sanitizeMessageContent()` | No (pure function) |
| Entry count limit | `MAX_SCHEDULE_ENTRIES` | No (constant) |
| Schedule count limit | `MAX_CONCURRENT_SCHEDULES` | No (constant) |

### 8. Node.js `fs.promises` API Security

**Finding**: The `fs.promises` API has identical security characteristics to the synchronous `fs` API:
- Same file permission checks
- Same symlink resolution
- Same error types (`ENOENT`, `EACCES`, `EPERM`, etc.)
- The `utf-8` encoding parameter in `readFile()` prevents raw buffer handling

The `import { realpath, readFile } from 'fs/promises'` pattern matches the project convention documented in DR2-006 (verified against 5 existing files using the same pattern).

---

## Risk Assessment

| Risk Category | Level | Rationale |
|--------------|-------|-----------|
| Technical | Low | Straightforward sync-to-async conversion with well-understood behavior |
| Security | Low | Core security mechanisms fully preserved; TOCTOU increase is within acceptable bounds |
| Operational | Low | No new configuration, no new dependencies, no new attack surfaces |

---

## Findings Summary

### Must Fix (1 item)

| ID | Category | Title |
|----|----------|-------|
| SEC4-001 | Error Information Disclosure | SEC-406-003 should document path disclosure risk in validateCmatePath() error messages and recommend sanitization in readCmateFile() |

### Should Fix (3 items)

| ID | Category | Title |
|----|----------|-------|
| SEC4-002 | TOCTOU | SEC-406-002 should quantify the atomicity gap widening rather than stating "no practical risk increase" |
| SEC4-003 | Unhandled Rejection | DJ-002 should reconsider adding .catch() or explicitly document which error types bypass internal try-catch in async version |
| SEC4-004 | Race Condition | Add concurrency guard to prevent overlapping syncSchedules() invocations |

### Consider (5 items)

| ID | Category | Title |
|----|----------|-------|
| SEC4-005 | Symlink Attack | fs.promises.realpath() provides identical symlink resolution (positive finding) |
| SEC4-006 | Input Validation | All input validation measures maintained (positive finding) |
| SEC4-007 | DoS Prevention | No new DoS vectors beyond overlapping invocations (positive finding) |
| SEC4-008 | Node.js Security | fs.promises API security equivalence confirmed (positive finding) |
| SEC4-009 | Error Handling | ENOENT handling correctly maintained in async version (positive finding) |

---

## Approval Status

**Status**: conditionally_approved

**Conditions for approval**:
1. Address SEC4-001: Add path disclosure risk acknowledgment to SEC-406-003
2. Address SEC4-004: Add concurrency guard for overlapping syncSchedules() invocations (this is the most significant security-relevant finding as it could lead to duplicate cron job creation)

**Recommended but not blocking**:
- SEC4-002: Improve TOCTOU risk documentation
- SEC4-003: Reconsider .catch() symmetry between DJ-002 and DJ-003

---

*Reviewed: 2026-03-04*
*Reviewer: Architecture Review Agent (Stage 4: Security)*
*Design Policy: dev-reports/design/issue-406-async-cmate-parser-design-policy.md*
