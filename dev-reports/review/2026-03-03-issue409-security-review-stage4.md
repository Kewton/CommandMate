# Architecture Review: Issue #409 - Stage 4 Security Review

## Review Summary

| Item | Detail |
|------|--------|
| **Issue** | #409 - perf: DB index addition and schedule manager query optimization |
| **Stage** | Stage 4: Security Review |
| **Focus** | OWASP Top 10 compliance for proposed changes |
| **Status** | **conditionally_approved** |
| **Score** | **4/5** |
| **Date** | 2026-03-03 |

---

## Executive Summary

The proposed changes in Issue #409 (mtime cache introduction, batch upsert, DB index addition) have a low overall security risk profile. The design operates primarily on server-side internal data (DB-sourced worktree paths, CMATE.md files) and does not introduce new external attack surfaces. All SQL operations use prepared statements with parameterized queries. The `crypto.randomUUID()` function used for ID generation is cryptographically secure. The main finding is the absence of an explicit size limit on the `cmateFileCache` Map, which is a low-severity concern that should be documented or constrained.

---

## OWASP Top 10 Evaluation

### A01:2021 - Broken Access Control

**Status**: PASS (with note)

**Analysis of `getCmateMtime()` path traversal risk**:

The proposed `getCmateMtime()` function constructs a file path as follows:

```typescript
const filePath = path.join(worktreePath, CMATE_FILENAME);
```

Where:
- `worktreePath` is sourced from `getAllWorktrees()` which queries `SELECT id, path FROM worktrees` directly from the SQLite database.
- `CMATE_FILENAME` is a compile-time constant (`'CMATE.md'`) from `@/config/cmate-constants.ts`.

**Path traversal risk assessment**:
- The `worktreePath` value originates from the database, not from user input. Worktree paths are registered through controlled flows (clone operations, worktree detection) that apply `validateWorktreePath()` and `resolveAndValidateRealPath()` at registration time.
- `CMATE_FILENAME` is a hardcoded constant and cannot be manipulated.
- The combination `path.join(dbPath, 'CMATE.md')` cannot produce a path traversal unless the database itself is compromised.

**Comparison with `readCmateFile()`**: The existing `readCmateFile()` calls `validateCmatePath()` which uses `realpathSync()` to verify the file is within the worktree directory. `getCmateMtime()` lacks this explicit check. The design document (Section 10) states this is intentional because `worktreePath` is DB-derived, but the asymmetry in defense layers between `getCmateMtime()` and `readCmateFile()` is noted as SEC4-003.

**Verdict**: Low risk. DB-sourced paths are treated as trusted. The defense-in-depth gap is minor but should be documented in code comments.

---

### A02:2021 - Cryptographic Failures

**Status**: PASS

**Analysis of `randomUUID()` cryptographic safety**:

The `batchUpsertSchedules()` function uses `randomUUID()` from Node.js `crypto` module for generating new schedule IDs:

```typescript
import { randomUUID } from 'crypto';
// ...
const newId = randomUUID();
```

`crypto.randomUUID()` is implemented using CSPRNG (Cryptographically Secure Pseudo-Random Number Generator) and generates RFC 4122 v4 UUIDs. This is confirmed by Node.js documentation and verified in this environment.

The generated UUIDs serve as internal database primary keys for `scheduled_executions` records. They are not used as:
- Authentication tokens
- Session identifiers
- Cryptographic keys
- Values that require unpredictability for security

**Verdict**: `crypto.randomUUID()` is more than adequate for this use case. No cryptographic concern.

---

### A03:2021 - Injection

**Status**: PASS

**Analysis of SQL injection in `batchUpsertSchedules()`**:

All SQL operations in the proposed `batchUpsertSchedules()` use `better-sqlite3`'s `db.prepare()` with parameterized queries:

```typescript
// SELECT - parameterized
const existingRows = db.prepare(
  'SELECT id, name FROM scheduled_executions WHERE worktree_id = ?'
).all(worktreeId);

// UPDATE - parameterized
const updateStmt = db.prepare(`
  UPDATE scheduled_executions
  SET message = ?, cron_expression = ?, cli_tool_id = ?, enabled = ?, updated_at = ?
  WHERE id = ?
`);

// INSERT - parameterized
const insertStmt = db.prepare(`
  INSERT INTO scheduled_executions
  (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
```

No string concatenation or template literal interpolation is used in any SQL statement. All values are bound through the parameter mechanism.

**Analysis of `disableStaleSchedules()` dynamic IN clause**:

The existing `disableStaleSchedules()` constructs a dynamic IN clause:

```typescript
const placeholders = worktreeIds.map(() => '?').join(',');
const rows = db.prepare(
  `SELECT id FROM scheduled_executions WHERE worktree_id IN (${placeholders}) AND enabled = 1`
).all(...worktreeIds);
```

This pattern generates only `?` placeholders dynamically; the actual values are bound via the spread operator. The SQL statement itself never contains user-supplied data. However, `worktreeIds` has no explicit size limit, and extremely large arrays could exceed SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (default: 999). This is noted as SEC4-002 but is a robustness concern rather than an injection vulnerability.

**Input sanitization chain**: Schedule entry data flows through `parseSchedulesSection()` which applies:
1. `sanitizeMessageContent()` - removes Unicode control characters
2. `NAME_PATTERN` validation - restricts name to safe characters (1-100 chars)
3. `isValidCronExpression()` - validates cron format and length (max 100 chars)
4. `isCliToolType()` - validates CLI tool ID against whitelist

**Verdict**: No SQL injection vulnerability. All queries use prepared statements with parameterized binding.

---

### A04:2021 - Insecure Design

**Status**: PASS

The mtime cache is a pure optimization layer. It does not constitute a security boundary. Cache misses result in the same behavior as the pre-change code (full file read + parse + DB write). The cache cannot be poisoned externally because:
1. `fs.statSync()` returns OS-level metadata, not user-controllable values.
2. The cache key is a DB-sourced worktree path.
3. Cache entries are only set after successful file parsing.

---

### A05:2021 - Security Misconfiguration

**Status**: PASS (with note)

**Analysis of `cmateFileCache` Map size limit**:

The proposed `cmateFileCache: Map<string, number>` has no explicit size constraint. Each entry stores a string key (worktree path) and a number value (mtimeMs), consuming approximately 100-500 bytes per entry depending on path length.

**Practical bounds**:
- The cache is populated only for worktrees returned by `getAllWorktrees()`, which queries the `worktrees` table.
- The `worktrees` table has no hard row limit in the database schema.
- The CLI port allocator has `MAX_WORKTREES = 10`, but this applies only to CLI-initiated worktree operations, not to the total number of DB-registered worktrees.
- `MAX_CONCURRENT_SCHEDULES = 100` limits the `schedules` Map but NOT the `cmateFileCache` Map.

**Memory impact**: Even with 10,000 worktrees (extreme case), the cache would consume roughly 5MB -- not a practical DoS vector. However, the absence of an explicit limit is a defense-in-depth gap that should be addressed with documentation or a constant.

**Verdict**: Low practical risk, but explicit documentation of the natural bound (worktree count) is recommended. See SEC4-001.

---

### A06:2021 - Vulnerable and Outdated Components

**Status**: PASS

No new external dependencies are introduced. The changes use:
- `fs.statSync()` - Node.js built-in
- `better-sqlite3` `db.prepare()` / `db.transaction()` - existing dependency
- `crypto.randomUUID()` - Node.js built-in
- `croner` - existing dependency

---

### A07:2021 - Identification and Authentication Failures

**Status**: NOT APPLICABLE

The changes do not modify authentication or authorization mechanisms. The schedule manager operates as an internal server-side component without external authentication surfaces.

---

### A08:2021 - Software and Data Integrity Failures

**Status**: PASS

The introduction of `db.transaction()` improves data integrity by ensuring worktree-level atomicity. Previously, individual `upsertSchedule()` calls could partially fail, leaving the database in an inconsistent state. The transactional batch approach ensures all-or-nothing semantics per worktree.

---

### A09:2021 - Security Logging and Monitoring Failures

**Status**: PASS (with note)

`getCmateMtime()` logs the full file path on error:

```typescript
console.warn(`[schedule-manager] Failed to stat ${filePath}:`, error);
```

This includes the worktree directory path which may contain user-identifying information (home directory, project names). This is consistent with existing logging patterns in `readCmateFile()` and `schedule-manager.ts`, and is server-side only (not exposed to clients). The project has `log-export-sanitizer.ts` for sanitizing exported logs.

---

### A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: NOT APPLICABLE

No external HTTP requests are introduced or modified. All operations are local filesystem access and SQLite database operations.

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Security | cmateFileCache unbounded Map size | Low | Low | P3 |
| Security | getCmateMtime() missing validateCmatePath() | Low | Low | P3 |
| Technical | disableStaleSchedules() IN clause parameter limit | Low | Very Low | P3 |
| Operational | Log output contains filesystem paths | Low | Medium | P3 |

---

## Detailed Findings

### Must Fix (1 item)

#### SEC4-001: cmateFileCache Map size limit undocumented

**Category**: A05:2021 Security Misconfiguration / Memory Exhaustion
**Severity**: Medium

The `cmateFileCache: Map<string, number>` has no explicit size constraint. While the practical bound is the number of worktrees in the database, this is implicit and not enforced.

**Recommendation**: Add a comment in the `ManagerState` interface documenting that the cache size is naturally bounded by the number of worktrees:

```typescript
interface ManagerState {
  // ...
  /**
   * CMATE.md file mtime cache: worktree path -> mtimeMs
   * Size is naturally bounded by worktree count from getAllWorktrees().
   * Each entry: ~100-500 bytes (path string + number).
   */
  cmateFileCache: Map<string, number>;
}
```

Alternatively, if the project considers worktree count potentially unbounded, add a `MAX_CACHE_ENTRIES` constant and eviction logic.

---

### Should Fix (3 items)

#### SEC4-002: disableStaleSchedules() dynamic IN clause parameter bound

**Category**: A03:2021 Injection (parameter limit)
**Severity**: Low

The `disableStaleSchedules()` function constructs a dynamic `IN (?, ?, ...)` clause with `worktreeIds.length` placeholders. SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999. With more than 999 worktrees, the query would fail.

**Current code** (existing, not changed by this Issue):
```typescript
const placeholders = worktreeIds.map(() => '?').join(',');
```

**Recommendation**: This is a pre-existing condition not introduced by Issue #409. However, since the design review covers the full `schedule-manager.ts`, it is noted for awareness. A chunk-based approach could be implemented as a future improvement.

#### SEC4-003: getCmateMtime() defense-in-depth gap

**Category**: A01:2021 Broken Access Control
**Severity**: Low

`getCmateMtime()` uses `path.join(worktreePath, CMATE_FILENAME)` without `validateCmatePath()`, while `readCmateFile()` (called on the same path in the same cycle) includes validation. The design document states this is intentional (Section 10: "path traversal is prevented because worktreePath is DB-derived").

**Recommendation**: Add a code comment in `getCmateMtime()` explicitly documenting the trust assumption:

```typescript
function getCmateMtime(worktreePath: string): number | null {
  // worktreePath is DB-derived (getAllWorktrees()), validated at registration time.
  // validateCmatePath() is intentionally omitted here for performance;
  // readCmateFile() applies it when the file is actually read.
  const filePath = path.join(worktreePath, CMATE_FILENAME);
  // ...
}
```

#### SEC4-004: Full path in log output

**Category**: A09:2021 Security Logging and Monitoring
**Severity**: Low

`getCmateMtime()` outputs the full filesystem path in `console.warn`. This is consistent with existing patterns across the codebase and is mitigated by `log-export-sanitizer.ts` for export scenarios.

**Recommendation**: Acknowledge in code comments that path information is present in logs and that `sanitizeForExport()` should be applied when logs are exported.

---

### Consider (3 items)

#### SEC4-005: randomUUID() cryptographic adequacy

No action needed. `crypto.randomUUID()` is CSPRNG-based and appropriate for internal ID generation.

#### SEC4-006: mtime cache invalidation DoS resistance

No action needed. The worst case (all cache misses) equals the pre-change behavior. The 60-second polling interval serves as a natural rate limiter.

#### SEC4-007: sanitizeMessageContent() coverage at batchUpsertSchedules() boundary

No action needed for current design. The single call path (`parseSchedulesSection()` -> `batchUpsertSchedules()`) ensures sanitization. If `batchUpsertSchedules()` is called from additional paths in the future, input validation should be added at the function boundary.

---

## Security Checklist for Implementation

- [ ] **SEC4-001**: Document cmateFileCache size bound in ManagerState interface comment
- [ ] **SEC4-003**: Add trust assumption comment in getCmateMtime() explaining why validateCmatePath() is omitted
- [ ] **SEC4-004**: Acknowledge path logging in getCmateMtime() error handler comment
- [ ] **SEC4-007**: Ensure batchUpsertSchedules() is only called with parseSchedulesSection() output (enforce via code review)

---

## Approval

**Status**: Conditionally Approved (Score: 4/5)

The proposed changes demonstrate a sound security posture. All SQL operations use prepared statements, UUID generation uses cryptographically secure methods, and the mtime cache does not introduce new attack surfaces. The one conditional item (SEC4-001: document or constrain cmateFileCache size) is low-severity and can be addressed during implementation. No blocking security issues were identified.

The design is approved for implementation provided that:
1. SEC4-001 is addressed (documentation or explicit size constraint)
2. SEC4-003 trust assumption is documented in code comments
