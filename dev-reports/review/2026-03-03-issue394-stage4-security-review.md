# Issue #394 - Stage 4 Security Review

## Executive Summary

| Item | Detail |
|------|--------|
| **Issue** | #394 - security: symlink traversal in file APIs allows access outside worktree root |
| **Stage** | 4 - Security Review |
| **Focus** | Security (TOCTOU, multi-hop symlink, Fail-safe, ancestor traversal, OWASP Top 10, residual risks, logging) |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |
| **Review Date** | 2026-03-03 |

The design policy document for Issue #394 was reviewed from 8 security perspectives: TOCTOU race conditions, multi-hop symlink resolution, absolute-path symlinks, fail-safe defaults, ancestor traversal termination conditions, OWASP Top 10 alignment, residual attack vectors, and logging/audit adequacy.

The overall design is robust. The 3-layer Defense-in-Depth architecture (Layer 1: lexical isPathSafe, Layer 2: realpathSync-based resolveAndValidateRealPath, Layer 3: lstat+isSymbolicLink in directory traversal) provides comprehensive protection against symlink traversal attacks. The use of `realpathSync()` for both rootDir and targetPath ensures correct handling of multi-hop symlinks and OS-level symlinks (e.g., macOS /var -> /private/var).

One must_fix finding was identified regarding the TOCTOU race condition window between realpathSync() validation and subsequent file I/O operations, which requires explicit documentation and risk acceptance rationale. Three should_fix findings relate to ancestor traversal termination, mkdir() timing after symlink validation, and log duplication concerns.

---

## Findings

### Must Fix (1 item)

#### S4-001: TOCTOU race condition window between realpathSync() validation and file I/O operations lacks documented risk acceptance

**Severity**: must_fix
**Category**: TOCTOU

**Description**: `resolveAndValidateRealPath()` validates the real path via `realpathSync()`, then file I/O operations (`readFile`, `writeFile`, `rm`, etc.) execute afterward. Between these two operations, a symlink can theoretically be created or modified by an attacker (TOCTOU: Time-of-Check-to-Time-of-Use).

Attack scenario:
1. `resolveAndValidateRealPath()` validates a file as being within the worktree
2. Attacker deletes the file and replaces it with a symlink pointing outside the worktree
3. `readFile()` follows the symlink and reads an external file

The design policy's threat model (Section 6) does not list this TOCTOU scenario. While `moveFileOrDirectory()`'s SEC-009 mentions TOCTOU defense, the `resolveAndValidateRealPath()` function's own TOCTOU risk is not documented.

Important context: This attack requires an attacker with write permissions to the worktree directory on the same host, and the application is a local development tool, so the practical risk is limited.

**Location**: Design Policy Section 6 - Security Design, Threat Model

**Suggestion**: Add a "TOCTOU: symlink replacement after realpathSync validation" row to the threat model table in Section 6, documenting:
- Attack prerequisite: write access to worktree directory on the same host
- Acceptance rationale: (1) `O_NOFOLLOW` with `open()` is not available in Node.js standard APIs, (2) kernel-level sandboxing (chroot/namespace) was already rejected in Section 3, (3) local development tool context means same-host attackers have other attack vectors, (4) Layer 3 (lstat+isSymbolicLink) partially mitigates this for directory traversal operations

---

### Should Fix (3 items)

#### S4-002: Ancestor traversal algorithm lacks explicit termination guard for root filesystem (/) arrival

**Severity**: should_fix
**Category**: Ancestor Traversal

**Description**: Section 5.1 algorithm steps 4a-4d traverse path components from the tail to find the nearest existing ancestor directory. In the abnormal case where rootDir itself does not exist (e.g., worktree deleted while API is called), `path.dirname()` recursive calls could ascend to the root filesystem (`/`). Since `path.dirname('/')` returns `'/'`, a missing termination condition could result in an infinite loop.

S1-006 (deferred as nice_to_have) states "Layer 1 isPathSafe() already rejects" but Layer 1 performs only lexical checks and does not verify rootDir existence. Section 5.1's error handling says "realpathSync(rootDir) failure returns false", which provides implicit protection at step 1. However, this implicit protection is insufficient as an explicit algorithm design.

**Location**: Design Policy Section 5.1 Algorithm Step 4a

**Suggestion**: Add an explicit termination condition to step 4: use a loop guard like `while (currentPath !== path.dirname(currentPath))` to guarantee termination when the root filesystem is reached. Also document that if the traversal reaches a path equal to resolvedRoot, return true (valid creation at worktree root level).

---

#### S4-003: createFileOrDirectory/writeBinaryFile mkdir(recursive:true) executes after symlink validation with undocumented TOCTOU window

**Severity**: should_fix
**Category**: TOCTOU

**Description**: In `createFileOrDirectory()` and `writeBinaryFile()`, when a file does not yet exist, `resolveAndValidateRealPath()` uses the ancestor traversal fallback to validate the nearest existing ancestor. After validation, `mkdir(parentDir, { recursive: true })` creates parent directories. Between validation and mkdir(), an attacker could replace an intermediate directory with a symlink pointing outside the worktree, causing mkdir() to create directories in an external location.

This is structurally the same TOCTOU issue as S4-001, but is specific to file creation operations where `mkdir()` modifies directory structure. `writeBinaryFile()` is particularly relevant because upload operations allow remote clients to specify new file paths.

**Location**: Design Policy Section 5.2 file-operations.ts writeBinaryFile/createFileOrDirectory

**Suggestion**: Add a note to the writeBinaryFile/createFileOrDirectory entries in Section 5.2 acknowledging this as the same TOCTOU risk category addressed in S4-001, and confirming that no additional mitigation is needed. Note that if a TOCTOU attack succeeded against mkdir(), the impact would be limited to external directory creation (file content writing occurs in the subsequent writeFile() call).

---

#### S4-004: moveFileOrDirectory SEC-006 and resolveAndValidateRealPath() defense overlap may cause duplicate log output

**Severity**: should_fix
**Category**: Logging

**Description**: Per S3-004, `resolveAndValidateRealPath()` will output `console.warn('[SEC-394]')` when returning false. Meanwhile, `moveFileOrDirectory()`'s SEC-006 (lines 544-553) performs its own symlink validation for the destination directory. When `resolveAndValidateRealPath()` is integrated into `validateFileOperation()`, the same request could trigger both the resolveAndValidateRealPath() log (for source path validation) and the SEC-006 rejection. Additionally, SEC-006 itself does not output logs, creating an inconsistency with the new logging approach.

In the current design scope, SEC-006 validates destinationDir while resolveAndValidateRealPath() in validateFileOperation() validates sourcePath, so they are not fully redundant. However, future changes (e.g., applying resolveAndValidateRealPath() to destination) could cause log duplication.

**Location**: Design Policy Section 5.2 moveFileOrDirectory, Section 5.1 S3-004

**Suggestion**: Add a note to the moveFileOrDirectory entry in Section 5.2: "SEC-006 destination validation performs equivalent realpathSync+startsWith checking. This Issue does not add resolveAndValidateRealPath() to the destination side (SEC-006 provides equivalent functionality). If SEC-006 is replaced with resolveAndValidateRealPath() in the future, ensure S3-004 log output duplication is addressed."

---

### Nice to Have (3 items)

#### S4-005: OWASP A01 Broken Access Control - implicit trust of worktree.path from DB

**Severity**: nice_to_have
**Category**: OWASP

**Description**: `resolveAndValidateRealPath()` resolves rootDir (worktree.path) via realpathSync(), but this value is retrieved from the database. If the database were compromised (e.g., via SQL injection), the rootDir could be attacker-controlled. The design implicitly trusts worktree.path but does not document this assumption. The risk is low because the application uses better-sqlite3 parameterized queries.

**Location**: Design Policy Section 4 Defense Layer Design

**Suggestion**: Consider adding a prerequisite note: "rootDir (worktree.path) is a trusted value retrieved from the database. DB operations are protected by better-sqlite3 parameterized queries."

---

#### S4-006: Hardlink-based worktree boundary bypass is not addressed

**Severity**: nice_to_have
**Category**: Residual Risk

**Description**: `realpathSync()` resolves symlinks but does not detect hardlinks. An attacker with access to the worktree directory could create a hardlink to a file outside the worktree, and file read/write operations through this hardlink would pass resolveAndValidateRealPath(). However, hardlink creation requires access permissions to the target file, directory hardlinks are prohibited on most operating systems, and git does not support hardlinks (so they cannot be committed/checked out). The design policy threat model does not mention hardlinks.

**Location**: Design Policy Section 6 Threat Model

**Suggestion**: Consider adding a "hardlink-based file access" row to the threat model: "Out of scope: hardlinks are not detectable by realpathSync(). Directory hardlinks are OS-prohibited, file hardlink creation requires target access permissions, git does not support hardlinks. Practical risk is minimal."

---

#### S4-007: Symlink rejection log lacks HTTP request context information

**Severity**: nice_to_have
**Category**: Logging

**Description**: The planned `console.warn('[SEC-394] Symlink traversal blocked: ...')` log includes target path, resolved path, and root path, but does not include HTTP request context (request ID, HTTP method, API endpoint, client IP). For security audit purposes, correlating symlink rejections with specific API requests would be desirable. However, since resolveAndValidateRealPath() is placed in path-validator.ts (business logic layer), directly referencing HTTP request information would violate separation of concerns.

**Location**: Design Policy Section 5.1 S3-004 Log Output

**Suggestion**: Consider this for future enhancement. If request context logging becomes necessary, the API layer (getWorktreeAndValidatePath / route handlers) can add supplementary logging when resolveAndValidateRealPath() returns false. Out of scope for this Issue.

---

## OWASP Top 10 Checklist

| OWASP Category | Status | Notes |
|---------------|--------|-------|
| A01: Broken Access Control | Pass (with notes) | 3-layer defense prevents symlink traversal. DB trust for rootDir is implicit (S4-005). |
| A02: Cryptographic Failures | N/A | Not related to this Issue. |
| A03: Injection (Path Traversal) | Pass | Layer 1 (lexical) + Layer 2 (realpathSync) prevent path traversal. Multi-hop symlinks fully resolved. |
| A04: Insecure Design | Pass | Defense-in-depth with 3 layers. Option B minimizes impact on existing code. |
| A05: Security Misconfiguration | Pass | Fail-safe defaults: realpathSync() failure rejects access. Clear internal-symlink-only policy. |
| A06: Vulnerable Components | N/A | Uses Node.js standard library only. No new external dependencies. |
| A07: Auth Failures | N/A | Authentication handled separately by middleware.ts. |
| A08: Data Integrity Failures | Pass | Post-resolution path comparison ensures real filesystem path is within worktree boundary. |
| A09: Logging & Monitoring | Pass (with notes) | S3-004 provides symlink rejection logging. Missing request context (S4-007). |
| A10: SSRF | N/A | Not related to this Issue. |

---

## Risk Assessment

| Risk Category | Level | Notes |
|--------------|-------|-------|
| Technical | Low | realpathSync() is well-established. Algorithm is straightforward. |
| Security | Medium | TOCTOU window exists but is mitigated by operational context (local dev tool). Hardlinks are out of scope but low risk. |
| Operational | Low | No new dependencies. VFS cache minimizes realpathSync() performance impact. |

---

## Security Design Strengths

The following aspects of the design are particularly well-considered:

1. **Defense-in-Depth (3 layers)**: Layer 1 (lexical), Layer 2 (realpathSync), Layer 3 (lstat+isSymbolicLink) provide overlapping protection with different failure modes.

2. **rootDir realpathSync resolution**: Applying realpathSync() to both rootDir and targetPath automatically handles OS-level symlinks (macOS /var -> /private/var) and prevents path comparison mismatches.

3. **Fail-safe defaults**: All realpathSync() failures result in access denial (return false), ensuring the system never fails open.

4. **Ancestor traversal fallback**: For non-existent paths (create/upload), the nearest existing ancestor check correctly prevents symlink-based bypasses for new file creation.

5. **Consistent application**: The design applies resolveAndValidateRealPath() to all file API endpoints (files, upload, tree) with appropriate integration patterns for each route's existing validation structure (S2-001).

6. **Internal symlink allowance**: The design correctly permits internal symlinks (within worktree) while blocking external symlinks, balancing security with legitimate use cases.

7. **Existing pattern reuse**: The SEC-006 pattern from moveFileOrDirectory() is generalized rather than inventing a new approach, reducing implementation risk.

---

## Relationship to Previous Stages

| Stage | Finding | Security Relevance |
|-------|---------|--------------------|
| S1-001 | validateFileOperation() integration plan | Correctly splits defense between shared helper and individual functions. No security gap. |
| S1-002 | API layer + business logic dual defense | Defense-in-depth principle properly applied. Redundant checks are intentional. |
| S1-003 | rename destination symlink check skipped | Justified: basename-only change stays within same parent directory. No security gap. |
| S1-004 | Image/video readFile() auto-protected | getWorktreeAndValidatePath() provides single entry point protection. Verified correct. |
| S2-001 | upload/tree API routes use inline isPathSafe | Correctly identified that getWorktreeAndValidatePath() only covers files API. Each route gets appropriate protection. |
| S3-001 | resolvedSource return value unchanged | Correct security decision: realpath validation is internal-only. No information leakage. |
| S3-004 | symlink rejection logging | Appropriate server-side logging. Client receives only INVALID_PATH (no path leakage). |

All previous stage findings have been properly addressed and do not introduce security gaps.

---

## Summary

| Metric | Count |
|--------|-------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 3 |
| **Total** | **7** |

The design policy for Issue #394 demonstrates strong security engineering. The 3-layer defense architecture, fail-safe defaults, and consistent application across all file API endpoints provide robust protection against symlink traversal attacks. The primary remaining concern is the inherent TOCTOU window between validation and I/O operations, which is a well-known limitation of userspace path validation in Unix-like systems. Documenting this as a known and accepted risk (must_fix S4-001) completes the threat model. After addressing the must_fix item, this design is ready for implementation.

---

*Generated by architecture-review-agent for Issue #394 Stage 4 Security Review*
*Review date: 2026-03-03*
