# Architecture Review Report: Issue #202 - Security Review (Stage 4)

## Executive Summary

| Item | Detail |
|------|--------|
| **Issue** | #202 fix: server restart causes deleted repositories to reappear |
| **Focus** | Security (OWASP Top 10) |
| **Stage** | 4 (Security Review) |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |
| **Date** | 2026-02-09 |

Issue #202 modifies `server.ts` to add exclusion filtering (`ensureEnvRepositoriesRegistered()` + `filterExcludedPaths()`) to the `initializeWorktrees()` function, preventing deleted repositories from reappearing after a server restart. The modification reuses existing, tested functions from `db-repository.ts` (Issue #190).

**Security Assessment**: The proposed changes introduce no new security vulnerabilities. The existing security measures (parameterized SQL queries, null byte prevention, system directory protection, path normalization, MAX_DISABLED_REPOSITORIES limit) remain intact and are properly leveraged by the new code path. The primary security concern is a pre-existing issue (scan/route.ts bypassing exclusion filters), which is already documented as a known limitation (SF-IA-001) and planned for follow-up.

---

## OWASP Top 10 Checklist

### A01:2021 - Broken Access Control

**Status**: Acceptable (pre-existing limitation, not introduced by this change)

- The modification adds server-side initialization logic in `server.ts`; no new API endpoints are created.
- Existing API endpoints (`DELETE /api/repositories`, `PUT /api/repositories/restore`, `POST /api/repositories/scan`, `POST /api/repositories/sync`) lack authentication/authorization mechanisms.
- **Mitigation**: Default bind address is `127.0.0.1` (local-only access). The `getEnv()` function in `src/lib/env.ts` (L218) validates bind address to `127.0.0.1`, `0.0.0.0`, or `localhost`.
- **Risk**: Low. Attacker would need local access to the server host.

### A02:2021 - Cryptographic Failures

**Status**: Not Applicable

- No cryptographic operations are involved in this change.
- Database directory permissions are set to `0o700` (owner-only) via SEC-003 in `src/lib/db-instance.ts` (L42).

### A03:2021 - Injection

**Status**: Pass

All database operations use parameterized queries (prepared statements) via better-sqlite3:

- `ensureEnvRepositoriesRegistered()` calls `getRepositoryByPath()` which uses `db.prepare('SELECT * FROM repositories WHERE path = ?')` at `src/lib/db-repository.ts` L221-223.
- `createRepository()` uses `db.prepare('INSERT INTO repositories (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')` at `src/lib/db-repository.ts` L147-153.
- `filterExcludedPaths()` calls `getExcludedRepositoryPaths()` which uses `db.prepare('SELECT path FROM repositories WHERE enabled = 0')` at `src/lib/db-repository.ts` L452.
- `updateRepository()` dynamically constructs SET clauses but still uses parameterized values at `src/lib/db-repository.ts` L269-275.

**Path injection prevention**:
- `resolveRepositoryPath()` uses `path.resolve()` for normalization (`src/lib/db-repository.ts` L315).
- `validateRepositoryPath()` includes null byte check (`repositoryPath.includes('\0')`) at L344 and system directory check via `isSystemDirectory()` at L350.
- `scanWorktrees()` in `src/lib/worktrees.ts` (L190) filters out paths containing null bytes or `..`.
- `scan/route.ts` uses `isPathSafe()` for path traversal prevention at L29.

### A04:2021 - Insecure Design

**Status**: Pass

- The design reuses the proven pattern from `sync/route.ts` (Issue #190), which has been in production.
- `ensureEnvRepositoriesRegistered()` is idempotent -- already-registered repositories are skipped (L375-376 of `db-repository.ts`).
- `disableRepository()` includes `MAX_DISABLED_REPOSITORIES = 1000` limit (SEC-SF-004) to prevent unlimited record accumulation from malicious DELETE requests (`src/lib/db-repository.ts` L302, L432-437).
- `scanWorktrees()` in `src/lib/worktrees.ts` (L178-196) filters dangerous system paths (`/etc`, `/root`, `/sys`, `/proc`, `/dev`, `/boot`, `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`).

### A05:2021 - Security Misconfiguration

**Status**: Pass

- `tsconfig.server.json` changes are additive (adding include entries), not modifying security-relevant compiler options.
- Environment variable validation in `getEnv()` (`src/lib/env.ts` L198-238) enforces:
  - Port range: 1-65535 (L214)
  - Bind address: whitelist of `127.0.0.1`, `0.0.0.0`, `localhost` (L218-219)
  - DB path: validated via `validateDbPath()` with fallback (L222-231)

### A06:2021 - Vulnerable and Outdated Components

**Status**: Not Applicable

- No new dependencies are introduced. The change reuses existing `db-repository.ts` functions.

### A07:2021 - Identification and Authentication Failures

**Status**: Acceptable (pre-existing limitation)

- No authentication mechanism exists in this project. This is a pre-existing condition unrelated to Issue #202.
- The server is designed for local development use, bound to `127.0.0.1` by default.

### A08:2021 - Software and Data Integrity Failures

**Status**: Pass

- `ensureEnvRepositoriesRegistered()` is idempotent and uses `getRepositoryByPath()` for existence checks before insert.
- `filterExcludedPaths()` relies on the `enabled` column in the `repositories` table, which is set via validated API operations (`disableRepository()`, `restoreRepository()`).
- The calling order constraint (register before filter) is documented via inline comments (SF-001) and JSDoc `@requires` (SF-CS-001). A follow-up Issue for function extraction (encapsulating the constraint) is planned.

### A09:2021 - Security Logging and Monitoring Failures

**Status**: Acceptable

- The design logs excluded repository count: `console.log('Excluded repositories: ${excludedCount}, Active repositories: ${filteredPaths.length}')`.
- Specific excluded paths are not logged (SF-SEC-003). This is a minor gap for audit purposes but does not create a security vulnerability.
- Error handling includes `console.error` at L98 of `server.ts` for initialization failures.
- Existing API routes follow SEC-SF-003 by not exposing internal error details in responses (e.g., `src/app/api/repositories/restore/route.ts` L67-72).

### A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: Not Applicable

- The modification does not make outbound HTTP requests. All operations are local filesystem and SQLite database operations.

---

## Detailed Findings

### Should Fix Items

#### SF-SEC-001: scan/route.ts bypasses exclusion filter (pre-existing, known limitation)

| Attribute | Value |
|-----------|-------|
| **OWASP** | A03:2021 Injection |
| **Severity** | Medium |
| **File** | `src/app/api/repositories/scan/route.ts` |
| **Related** | SF-IA-001 (Stage 3) |

**Finding**: `POST /api/repositories/scan` accepts a `repositoryPath` from the request body and calls `scanWorktrees()` -> `syncWorktreesToDB()` without checking the repository's exclusion status (`enabled=0`) in the `repositories` table. If a user manually enters the path of a previously deleted repository, the worktrees will be re-registered in the database, effectively bypassing the exclusion.

**Current protection at `src/app/api/repositories/scan/route.ts` L29**:
```typescript
if (!isPathSafe(repositoryPath, CM_ROOT_DIR)) {
  return NextResponse.json(
    { error: 'Invalid or unsafe repository path' },
    { status: 400 }
  );
}
```

This validates path traversal but does not check exclusion status.

**Recommendation**: In a follow-up Issue, add a check before scanning:
```typescript
const repo = getRepositoryByPath(db, normalizedPath);
if (repo && !repo.enabled) {
  return NextResponse.json(
    { error: 'Repository is excluded. Restore it first.' },
    { status: 400 }
  );
}
```

#### SF-SEC-002: No upper limit on repository path count from environment variables

| Attribute | Value |
|-----------|-------|
| **OWASP** | A04:2021 Insecure Design |
| **Severity** | Low |
| **File** | `server.ts` |

**Finding**: `getRepositoryPaths()` in `src/lib/worktrees.ts` (L122-139) splits `WORKTREE_REPOS` by comma without an upper limit. An extremely large value could cause excessive DB operations during `ensureEnvRepositoriesRegistered()`.

**Risk**: Very low. Environment variables are set by the server administrator, not by external users. This is not an external attack vector.

**Recommendation**: Consider adding a reasonable upper limit (e.g., 100 repositories) with a warning log when exceeded.

#### SF-SEC-003: Excluded repository paths not logged at detail level

| Attribute | Value |
|-----------|-------|
| **OWASP** | A09:2021 Security Logging and Monitoring Failures |
| **Severity** | Low |
| **File** | `server.ts` |

**Finding**: The design logs the count of excluded repositories but not their specific paths. For security auditing and debugging, it would be useful to log which repositories were excluded.

**Recommendation**: Add a debug-level log line that outputs the excluded paths when `excludedCount > 0`.

### Consider Items

#### C-SEC-001: No authentication on API endpoints (project-wide pre-existing)

All repository management API endpoints lack authentication. This is mitigated by the default `127.0.0.1` bind address but should be documented for users who configure `CM_BIND=0.0.0.0`.

#### C-SEC-002: DB isolation between worktree-specific servers

Worktree-specific server instances (via `commandmate start --issue`) have independent databases, so exclusion state is not synchronized between them. This is a design limitation, not a vulnerability.

#### C-SEC-003: Calling order constraint relies on code convention

The `ensureEnvRepositoriesRegistered()` -> `filterExcludedPaths()` order dependency is enforced only by comments and JSDoc, not by the type system. The planned follow-up Issue for common function extraction (`initializeFilteredRepositories()`) will encapsulate this constraint.

---

## Risk Assessment

| Risk Type | Level | Justification |
|-----------|-------|---------------|
| Technical | Low | Reuses tested functions; minimal code change; sync/route.ts reference implementation exists |
| Security | Low | No new attack surface; existing protections (parameterized queries, path validation, system directory check, MAX_DISABLED_REPOSITORIES) remain intact |
| Operational | Low | Server startup behavior changes slightly (adds filtering step); filtered repositories are logged; no user-facing behavioral change except the bug fix |

---

## Security Measures Inventory

The following existing security measures are relevant to this change and remain intact:

| ID | Measure | Location | Status |
|----|---------|----------|--------|
| SEC-001 | System directory protection | `src/config/system-directories.ts` | Active |
| SEC-003 | DB directory permissions (0o700) | `src/lib/db-instance.ts` L42 | Active |
| SEC-MF-001 | Null byte check in path validation | `src/lib/db-repository.ts` L344 | Active |
| SEC-SF-002 | Case-sensitive path comparison note | `src/lib/db-repository.ts` L393-396 | Documented |
| SEC-SF-003 | Internal error detail suppression in API responses | Multiple route handlers | Active |
| SEC-SF-004 | MAX_DISABLED_REPOSITORIES limit (1000) | `src/lib/db-repository.ts` L302, L432-437 | Active |
| SEC-SF-005 | TOCTOU risk acknowledgment in restore | `src/app/api/repositories/restore/route.ts` L55 | Documented |
| Path safety | isPathSafe() path traversal prevention | `src/lib/path-validator.ts` | Active |
| Parameterized queries | All DB operations use prepared statements | `src/lib/db-repository.ts`, `src/lib/db.ts` | Active |
| Bind address validation | Whitelist of 127.0.0.1, 0.0.0.0, localhost | `src/lib/env.ts` L218-219 | Active |

---

## Approval Status

**Conditionally Approved** -- The proposed changes are secure and appropriate for the stated goal. No must-fix security issues were identified. The three should-fix items are either pre-existing limitations (SF-SEC-001), low-severity design considerations (SF-SEC-002), or minor logging improvements (SF-SEC-003). None of these block implementation.

**Conditions for full approval**:
1. Ensure the follow-up Issue for `scan/route.ts` exclusion check (SF-SEC-001 / SF-IA-001) is created during implementation.
2. Consider adding excluded repository path logging at debug level (SF-SEC-003) during implementation.

---

*Generated by architecture-review-agent for Issue #202*
*Stage 4: Security Review (OWASP Top 10)*
*Date: 2026-02-09*
