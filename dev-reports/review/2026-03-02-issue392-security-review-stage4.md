# Security Architecture Review: Issue #392 - Clone Target Path Validation Bypass Fix

## Executive Summary

| Item | Detail |
|------|--------|
| **Issue** | #392: security: clone target path validation bypass allows repositories outside CM_ROOT_DIR |
| **Stage** | Stage 4 - Security Review |
| **Date** | 2026-03-02 |
| **Focus** | OWASP Top 10 compliance, path manipulation security, information leakage, authentication integration |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |

Issue #392 の設計方針書に対するセキュリティレビューを OWASP Top 10 準拠の観点から実施した。脆弱性の根本原因（isPathSafe() による検証後に未解決パスで git clone を実行する問題）に対する修正設計は適切であり、validateWorktreePath() による検証とカノニカル化の原子的実行は正しいアプローチである。

must_fix 1件を含む計7件の指摘事項を検出した。

---

## OWASP Top 10 Checklist

| OWASP | Category | Status | Details |
|-------|----------|--------|---------|
| A01 | Broken Access Control | CONDITIONAL | Path traversal fix is correct but double-decode bypass risk exists (S4-001) |
| A02 | Cryptographic Failures | N/A | No cryptographic operations in scope |
| A03 | Injection | PASS | spawn() prevents command injection; absolute path prevents git option injection |
| A04 | Insecure Design | PASS | Atomic validate+canonicalize design is sound |
| A05 | Security Misconfiguration | CONDITIONAL | Auth boundary for unauthenticated environments not documented (S4-004) |
| A06 | Vulnerable Components | N/A | No new dependencies introduced |
| A07 | Auth Failures | PASS | Existing middleware auth is not modified |
| A08 | Data Integrity | PASS | Clone job DB records maintain integrity |
| A09 | Security Logging | PASS | S1-001 adds console.warn for attack detection |
| A10 | SSRF | N/A | Clone URL is user-controlled by design; not an SSRF vector |

---

## Detailed Findings

### S4-001 [must_fix] - validateWorktreePath() double decodeURIComponent bypass verification required

**OWASP**: A01 - Broken Access Control

**Description**:

The design document acknowledges the double `decodeURIComponent` risk in S1-002 and marks it as "out of scope." However, since Issue #392's fix adopts `validateWorktreePath()` as the "single point of validation," the safety of this function is a direct dependency of the fix.

The attack scenario is as follows:

1. Input: `%252e%252e%252fetc%252fpasswd`
2. In `isPathSafe()`: `decodeURIComponent('%252e%252e%252fetc%252fpasswd')` yields `%2e%2e%2fetc%2fpasswd`
3. In `isPathSafe()`: `path.resolve(rootDir, '%2e%2e%2fetc%2fpasswd')` resolves to a literal path under rootDir (safe), so `isPathSafe()` returns `true`
4. In `validateWorktreePath()` L110: `decodeURIComponent('%252e%252e%252fetc%252fpasswd')` yields `%2e%2e%2fetc%2fpasswd` (same result, NOT `../etc/passwd` because double-decode only decodes one layer at a time)

**Revised analysis**: Upon closer examination, a single `decodeURIComponent` call decodes `%252e` to `%2e`, not `..`. A second call on the same string would be needed to decode `%2e` to `.`. Since both `isPathSafe()` and `validateWorktreePath()` each call `decodeURIComponent` once on the original input, they both produce the same single-decoded result `%2e%2e%2fetc%2fpasswd`. Therefore, the double-decode attack as described does NOT succeed for single-layer encoding.

However, if the input is `%2e%2e%2f..%2f..%2fetc`, the scenario becomes:
1. `isPathSafe()` decodes to `../../../etc` and correctly rejects it.

The more concerning case: if `isPathSafe()` passes the check with the decoded path, and `validateWorktreePath()` decodes again, the resolved path could differ from what `isPathSafe()` validated. This is a theoretical inconsistency even if no concrete exploit is currently known.

**Recommendation**: Before implementation, add the following empirical verification test cases:

```typescript
// Verify double-decode does not create bypass
expect(() => validateWorktreePath('%252e%252e%252fetc', '/home/user')).not.toThrow();
// The resolved path must still be under rootDir
const result = validateWorktreePath('%252e%252e%252fetc', '/home/user');
expect(result.startsWith('/home/user/')).toBe(true);

// Triple-encoded traversal attempt
expect(() => validateWorktreePath('%25252e%25252e%25252f', '/home/user')).not.toThrow();
```

If any bypass is found, fix `validateWorktreePath()` by removing its independent `decodeURIComponent` (L109-113) and using only the path already validated by `isPathSafe()`.

**Location**: Design document Section 10-1 [S1-002], `src/lib/path-validator.ts` L89-117

---

### S4-002 [should_fix] - Symlink attack defense not addressed

**OWASP**: A01 - Broken Access Control

**Description**:

The design document focuses on path traversal prevention but does not address symlink-based attacks. Attack scenario: an attacker creates a symlink within CM_ROOT_DIR pointing to a sensitive directory outside CM_ROOT_DIR. `validateWorktreePath()` validates the logical path without resolving symlinks, so the path appears to be within CM_ROOT_DIR.

Mitigating factor: `git clone` creates a new directory at the target path. If a symlink already exists at that path, the clone operation fails because the target already exists (caught by `existsSync()` check). The risk is therefore limited.

**Recommendation**: Add a symlink attack entry to Section 6-3's attack vector table, documenting the implicit defense provided by `existsSync()` check and `git clone`'s directory creation behavior. Consider `fs.realpathSync()` verification for future hardening.

**Location**: Design document Section 6-3

---

### S4-003 [should_fix] - executeClone() mkdirSync defense-in-depth for parent directory

**OWASP**: A01 - Broken Access Control

**Description**:

`clone-manager.ts` L382-385 executes `mkdirSync(parentDir, { recursive: true })` to create the parent directory of `targetPath`. After the Issue #392 fix, `targetPath` should always be an absolute path under `basePath`. However, if `validateWorktreePath()` is bypassed (as in S4-001), the `mkdirSync` call could recursively create directories outside `basePath`.

This is a defense-in-depth concern. The primary defense is `validateWorktreePath()`, but a secondary check on `parentDir` would prevent directory creation outside the allowed boundary even if the primary check fails.

**Recommendation**: Document this as a known dependency on `validateWorktreePath()` correctness in Section 6. Optionally, add an `isPathSafe(parentDir, basePath)` check before `mkdirSync` in `executeClone()`.

**Location**: Design document Section 2 data flow, `src/lib/clone-manager.ts` L382-385

---

### S4-004 [should_fix] - Authentication boundary documentation for unauthenticated environments

**OWASP**: A05 - Security Misconfiguration

**Description**:

The middleware (`middleware.ts` L99-101) skips authentication when `CM_AUTH_TOKEN_HASH` is not set. In such environments, the clone API is accessible without authentication. Before the Issue #392 fix, this meant unauthenticated users could clone repositories to arbitrary paths outside CM_ROOT_DIR. After the fix, cloning is restricted to CM_ROOT_DIR, which is a significant improvement.

However, the design document does not explicitly discuss the security posture difference between authenticated and unauthenticated environments. In unauthenticated environments bound to `0.0.0.0`, any network-reachable user can trigger clone operations within CM_ROOT_DIR.

**Recommendation**: Add a "6-4. Authentication State and Security Boundary" subsection documenting: (1) CM_AUTH_TOKEN_HASH unset means no authentication, (2) default CM_BIND=127.0.0.1 provides network boundary defense, (3) CM_AUTH_TOKEN_HASH is strongly recommended when CM_BIND=0.0.0.0.

**Location**: Design document Section 6

---

### S4-005 [nice_to_have] - Include sanitized input value in rejection log

**OWASP**: A09 - Security Logging and Monitoring

**Description**:

The S1-001 fix adds `console.warn('[CloneManager] Invalid custom target path rejected')` with a fixed message to avoid leaking `rootDir`. While correct for D4-001, attack detection would benefit from including a sanitized portion of the rejected input (control characters removed, truncated to 50 characters, no rootDir).

**Recommendation**: Consider expanding the log message to include `customTargetPath.replace(/[\x00-\x1f]/g, '').substring(0, 50)`. The risk of information leakage is minimal since the value is a path string provided by the attacker.

**Location**: Design document Section 4-1, Section 5-2b

---

### S4-006 [nice_to_have] - Document git option injection defense

**OWASP**: A03 - Injection

**Description**:

`executeClone()` uses `spawn('git', ['clone', '--progress', cloneUrl, targetPath])`, which does not invoke a shell and is therefore not vulnerable to command injection. Additionally, since `validateWorktreePath()` returns an absolute path starting with `/`, the `targetPath` argument cannot be interpreted as a git option (e.g., `--upload-pack=...`). This implicit defense should be documented.

**Recommendation**: Add a git option injection entry to Section 6-3's attack vector table, noting that `validateWorktreePath()` always returns absolute paths (starting with `/`) which cannot be misinterpreted as git command options.

**Location**: Design document Section 6-3

---

### S4-007 [nice_to_have] - Extract targetDir length limit as a named constant

**OWASP**: A05 - Security Misconfiguration

**Description**:

The 1024-character length limit for `targetDir` (S1-003) is defined as an inline literal in the design. Following the project's existing patterns (e.g., `MAX_NAME_LENGTH` in `schedule-config.ts`), this value should be a named constant for maintainability and test consistency.

**Recommendation**: Define `MAX_TARGET_DIR_LENGTH = 1024` as a constant in `route.ts` or a relevant config file, and reference it in tests.

**Location**: Design document Section 5-1

---

## Risk Assessment

| Risk Category | Content | Impact | Probability | Priority |
|---------------|---------|--------|-------------|----------|
| Technical | Double decodeURIComponent bypass in validateWorktreePath() | High | Low-Medium | P1 |
| Security | Symlink-based path escape | Medium | Low | P3 |
| Security | mkdirSync directory creation outside basePath if validation bypassed | High | Low | P2 |
| Security | Unauthenticated clone API access (CM_AUTH_TOKEN_HASH unset) | Medium | Medium | P2 |
| Operational | Missing attack input in rejection logs | Low | N/A | P3 |

---

## Improvement Recommendations

### Must Fix (1 item)

1. **S4-001**: Empirically verify that `validateWorktreePath()`'s double `decodeURIComponent` does not create a path traversal bypass. Add test cases for multi-layer URL-encoded inputs. If a bypass is found, fix `validateWorktreePath()` before or concurrently with Issue #392.

### Should Fix (3 items)

1. **S4-002**: Document symlink attack vector and implicit defenses in Section 6-3.
2. **S4-003**: Document the mkdirSync defense-in-depth dependency on validateWorktreePath() correctness, or add an isPathSafe() check on parentDir.
3. **S4-004**: Add authentication boundary documentation for unauthenticated environments.

### Consider (3 items)

1. **S4-005**: Include sanitized input value in rejection log for attack analysis.
2. **S4-006**: Document git option injection implicit defense.
3. **S4-007**: Extract targetDir length limit as a named constant.

---

## Reviewed Files

| File | Path | Security Relevance |
|------|------|--------------------|
| Design Document | `dev-reports/design/issue-392-clone-path-validation-fix-design-policy.md` | Primary review target |
| Path Validator | `src/lib/path-validator.ts` | Core security function (isPathSafe, validateWorktreePath) |
| Clone Manager | `src/lib/clone-manager.ts` | Vulnerability location and fix target |
| Clone Route | `src/app/api/repositories/clone/route.ts` | API entry point, input sanitization |
| Middleware | `src/middleware.ts` | Authentication boundary |
| Env Config | `src/lib/env.ts` | CM_ROOT_DIR resolution |
| Auth Config | `src/config/auth-config.ts` | Authentication configuration |
| Unit Tests | `tests/unit/lib/clone-manager.test.ts` | Existing test coverage |
| Integration Tests | `tests/integration/api-clone.test.ts` | Integration test coverage |

---

## Approval Status

**Conditionally Approved** - The design is fundamentally sound and addresses the root cause of the vulnerability correctly. The single must_fix item (S4-001) requires empirical verification of the double-decode behavior before implementation proceeds. If verification confirms that no bypass exists (which is the likely outcome based on analysis), the implementation can proceed with the should_fix items addressed as documentation additions.

---

*Generated by architecture-review-agent for Issue #392 Stage 4 Security Review*
