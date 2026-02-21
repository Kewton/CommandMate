# Issue #331 Stage 4 Security Review Report

## Executive Summary

| Item | Detail |
|------|--------|
| Issue | #331 Token Authentication / HTTPS Support |
| Stage | 4 - Security Review |
| Focus | OWASP Top 10 (2021) Compliance |
| Status | **Conditionally Approved** |
| Score | **3/5** |
| Date | 2026-02-21 |

This security review evaluates the design policy document for Issue #331 (Token Authentication / HTTPS Support) against OWASP Top 10 (2021) criteria and additional security concerns. The design demonstrates a solid understanding of security fundamentals with appropriate use of cryptographic primitives, defense-in-depth Cookie attributes, and rate limiting. However, three critical gaps were identified: (1) missing timing-safe comparison for token verification, (2) ambiguous path prefix matching in authentication exclusion logic, and (3) insufficient path traversal protection for certificate file paths.

---

## OWASP Top 10 Checklist

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| A01 | Broken Access Control | WARN | AUTH_EXCLUDED_PATHS prefix matching allows unintended path bypass |
| A02 | Cryptographic Failures | **FAIL** | No timing-safe comparison specified for token hash verification |
| A03 | Injection | WARN | Certificate path traversal protection lacks concrete design |
| A04 | Insecure Design | PASS | 256-bit random token generation is sufficient |
| A05 | Security Misconfiguration | WARN | --allow-http risk communication could be stronger |
| A06 | Vulnerable Components | PASS | No external dependencies, as designed |
| A07 | Identification and Authentication Failures | WARN | IP acquisition method for rate limiting unspecified |
| A08 | Software and Data Integrity Failures | WARN | Certificate/key pair integrity verification not designed |
| A09 | Security Logging and Monitoring Failures | WARN | Authentication event logging policy missing |
| A10 | Server-Side Request Forgery | WARN | Certificate path validation insufficient |

**Result**: 2 PASS, 1 FAIL, 7 WARN

---

## Detailed Findings

### Must Fix (3 items)

#### S001: Timing Attack Vulnerability in verifyToken() [A02 - Cryptographic Failures]

**Severity**: Must Fix
**Location**: Section 2.3 `verifyToken()`, Section 6.3 Token Management

**Description**:
The design specifies that `verifyToken()` compares `hashToken(input)` against `CM_AUTH_TOKEN_HASH`, but the comparison method is not specified. Using JavaScript's `===` operator for string comparison is vulnerable to timing attacks, where an attacker can measure response time differences to infer the hash value one byte at a time.

SHA-256 produces a 64-character hexadecimal string. With a timing attack, an attacker could theoretically determine the full hash in 64 * 16 = 1024 attempts (far fewer than brute force). While the rate limiter provides some mitigation (5 attempts / 15 min lockout), a sophisticated attacker could work across multiple IP addresses or exploit network timing precision.

**Affected code pattern** (from Section 2.3):
```typescript
// VULNERABLE: implicit === comparison
export function verifyToken(hash: string): boolean {
  return hash === process.env.CM_AUTH_TOKEN_HASH;  // Timing attack possible
}
```

**Recommendation**:
Explicitly specify `crypto.timingSafeEqual()` in the design document:

```typescript
import { timingSafeEqual } from 'crypto';

export function verifyToken(computedHash: string): boolean {
  const expected = process.env.CM_AUTH_TOKEN_HASH ?? '';
  if (computedHash.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(computedHash), Buffer.from(expected));
}
```

Add this to Section 2.3 and Section 6.3 of the design document.

---

#### S002: AUTH_EXCLUDED_PATHS Prefix Match Bypass Risk [A01 - Broken Access Control]

**Severity**: Must Fix
**Location**: Section 5.3 `middleware.ts`, Section 2.3 `AUTH_EXCLUDED_PATHS`

**Description**:
The middleware authentication exclusion uses `pathname.startsWith(path)`:

```typescript
// From Section 5.3
if (AUTH_EXCLUDED_PATHS.some((path) => pathname.startsWith(path))) {
  return NextResponse.next();
}
```

With `AUTH_EXCLUDED_PATHS = ['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/status']`, the following paths would bypass authentication:

- `/loginAnything` -- matches `/login` prefix
- `/api/auth/loginAdmin` -- matches `/api/auth/login` prefix
- `/api/auth/statusDetails` -- matches `/api/auth/status` prefix

While Next.js routing means these paths would likely return 404, this creates a fragile security assumption that depends on the routing layer rather than explicit access control.

**Recommendation**:
Replace prefix matching with exact match or segment-aware matching:

```typescript
// Option 1: Exact match (recommended for this use case)
if (AUTH_EXCLUDED_PATHS.some((path) => pathname === path)) {
  return NextResponse.next();
}

// Option 2: Segment-aware match (if sub-paths needed in future)
if (AUTH_EXCLUDED_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'))) {
  return NextResponse.next();
}
```

Update Section 5.3 and Section 2.3 to specify the matching algorithm explicitly.

---

#### S003: Certificate File Path Traversal Protection Insufficient [A03/A10 - Injection/SSRF]

**Severity**: Must Fix
**Location**: Section 9.3 Certificate Validation (start.ts)

**Description**:
The design states "path traversal prevention (path.resolve + existing pattern compliant)" but provides no concrete validation logic. The `--cert` and `--key` CLI options accept arbitrary file paths. Without explicit validation, an attacker with CLI access could read arbitrary files on the filesystem by specifying paths like `--cert /etc/shadow` (which would fail as a certificate but may leak error information).

The existing `env-setup.ts` (Line 109-121) has a concrete path traversal protection pattern:

```typescript
// Existing pattern from env-setup.ts
throw new Error(`Path traversal detected: ${targetPath} resolves outside of ${allowedBaseDir}`);
```

However, certificate file paths are intentionally outside the project directory, so the "resolve outside base" pattern does not directly apply. A different validation approach is needed.

**Recommendation**:
Design concrete certificate file validation for Section 9.3:

1. `path.resolve()` for absolute path normalization
2. `fs.realpathSync()` for symlink resolution (prevent TOCTOU via symlink)
3. File extension whitelist (`.pem`, `.crt`, `.key`, `.cert`)
4. File size upper limit (e.g., 1MB -- certificates should be small)
5. Readable permission check before `readFileSync()`
6. Error messages must NOT include file content (only path and error type)

---

### Should Fix (5 items)

#### S004: Security Event Logging Policy Missing [A09]

**Severity**: Should Fix
**Location**: Section 6.2, Section 6.3

**Description**:
The design does not specify logging for authentication events. The existing `src/cli/utils/security-logger.ts` is not referenced for integration. Security events that should be logged:

| Event | Log Level | Details to Include |
|-------|-----------|-------------------|
| Authentication failure | `warn` | IP address, timestamp, attempt count (never log token value) |
| Lockout triggered | `warn` | IP address, lockout duration |
| Authentication success | `info` | IP address, timestamp |
| Token expiration | `info` | Timestamp |

**Recommendation**:
Add a security logging subsection to Section 6 specifying which events are logged, at what level, and what data is included. Explicitly state that token values must never appear in logs.

---

#### S005: Rate Limiter IP Acquisition Method Unspecified [A07]

**Severity**: Should Fix
**Location**: Section 6.2

**Description**:
The design specifies IP-based rate limiting but does not document how the IP address is obtained. In Next.js middleware, `request.ip` is available but depends on the `trustProxy` configuration. The `X-Forwarded-For` header is spoofable by attackers when no trusted proxy is present.

The design's trade-off section (Section 13) mentions "behind proxy same IP issue (X-Forwarded-For has trust issues)" but does not specify the actual IP acquisition logic.

**Recommendation**:
Specify in Section 6.2:
- For Next.js middleware (middleware.ts): Use `request.ip` (Next.js handles trusted header resolution)
- For login API route: Use `request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'`
- Document that X-Forwarded-For is only reliable behind a trusted reverse proxy
- Consider falling back to a fixed string like `'unknown'` when IP cannot be determined (prevents bypass but may lock out all users behind same proxy)

---

#### S006: Cookie Parser Security Edge Cases [A03]

**Severity**: Should Fix
**Location**: Section 3 (Technology Selection), Section 16.1

**Description**:
The custom Cookie parser (`split(';')`) has potential edge cases:
1. Cookie values containing `;` (though RFC 6265 prohibits this in cookie-value)
2. Multiple cookies with the same name (use first match)
3. No maximum length limit on Cookie header processing
4. Malformed UTF-8 sequences

**Recommendation**:
Add to `parseCookieToken()` design:
1. Cookie header max length check (e.g., 8192 bytes -- common server limit)
2. Token format validation: `/^[a-f0-9]{64}$/` before further processing
3. Specify first-match behavior for duplicate cookie names
4. Add these as explicit test cases in Section 16.1

---

#### S007: --allow-http Security Risk Communication [A05]

**Severity**: Should Fix
**Location**: Section 7, Section 12 (C015)

**Description**:
HTTP-based token authentication exposes tokens to network interception via man-in-the-middle attacks. The `--allow-http` flag suppresses the warning, but there is no interactive confirmation prompt to prevent accidental use in production.

**Recommendation**:
Consider adding an interactive confirmation when `--allow-http` is specified:
```
WARNING: Authentication over HTTP exposes tokens to network interception.
This is only safe for localhost or trusted networks.
Continue? [y/N]
```
Alternatively, strengthen the `AUTH_HTTP_WARNING` message to include specific risk description.

---

#### S008: Certificate/Key Pair Integrity Verification [A08]

**Severity**: Should Fix
**Location**: Section 9.1

**Description**:
The design reads certificate and key files via `readFileSync()` and passes them to `https.createServer()`. If the certificate and key do not form a valid pair, `https.createServer()` will throw a cryptographic error with potentially unclear messaging for operators.

**Recommendation**:
After reading cert/key files, add a validation step:
```typescript
try {
  crypto.createPublicKey(cert);
  crypto.createPrivateKey(key);
} catch (error) {
  console.error('Invalid certificate or key file format');
  process.exit(2);
}
```
Alternatively (KISS approach), catch the `https.createServer()` error and provide a user-friendly error message.

---

### Nice to Have (4 items)

#### S009: Rate Limiter Map Memory Exhaustion [A07]

**Severity**: Nice to Have
**Location**: Section 6.2, Section 8.3

**Description**:
The `Map<string, RateLimitEntry>` grows without bound if an attacker sends requests from many different IP addresses. The 1-hour cleanup interval may not be sufficient during an active attack.

**Recommendation**:
Add `MAX_RATE_LIMIT_ENTRIES` constant (e.g., 10000) and evict oldest entries when exceeded. Given this is a local development tool, risk level is low.

---

#### S010: CM_AUTH_TOKEN_HASH Process Environment Visibility [A05]

**Severity**: Nice to Have
**Location**: Section 6.3, Section 13

**Description**:
The hash value is visible via `/proc/<pid>/environ` (Linux) or `ps e` (macOS). Since the hash is of a 256-bit random token, preimage recovery is computationally infeasible. Risk is properly acknowledged in design trade-offs but could be more specific.

**Recommendation**:
Update trade-off description: "256-bit random token SHA-256 hash is computationally irreversible. Exposure via /proc/<pid>/environ poses negligible practical risk."

---

#### S011: Rate Limit Counting for Expired Token Attempts [A07]

**Severity**: Nice to Have
**Location**: Section 6.2, Section 15

**Description**:
When a token expires, a legitimate user re-entering the old token in the login form counts toward rate limiting. This could cause unintentional lockout.

**Recommendation**:
Differentiate "invalid token" from "expired token" in `verifyToken()` / `authenticateRequest()`. Do not count expired token attempts toward the rate limit.

---

#### S012: Duplicate Crypto Algorithm in auth-helper.ts and auth.ts [A02]

**Severity**: Nice to Have
**Location**: Section 11.2, Section 16.2

**Description**:
Both `auth-helper.ts` (CLI) and `auth.ts` (server) implement identical `generateToken()` and `hashToken()` functions. Algorithm changes require synchronized updates to both files.

**Recommendation**:
Add an explicit comment to both files: "IMPORTANT: This algorithm MUST match auth.ts/auth-helper.ts". The existing cross-compatibility test (Section 16.2) provides adequate safety net.

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Security | Timing attack on token verification (S001) | High | Medium | **P1** |
| Security | Auth bypass via prefix match (S002) | Medium | Low | **P1** |
| Security | Certificate path traversal (S003) | Medium | Low | **P1** |
| Security | Missing security event logs (S004) | Medium | Medium | P2 |
| Security | IP spoofing in rate limiter (S005) | Medium | Low | P2 |
| Security | Cookie parser edge cases (S006) | Low | Low | P2 |
| Operational | HTTP token interception (S007) | High | Low | P2 |
| Technical | Cert/key mismatch error clarity (S008) | Low | Low | P2 |
| Security | Rate limit memory exhaustion (S009) | Low | Low | P3 |
| Operational | Env variable visibility (S010) | Low | Low | P3 |
| Operational | Expired token lockout (S011) | Low | Medium | P3 |
| Technical | Crypto algorithm sync (S012) | Low | Low | P3 |

---

## Positive Security Design Elements

The following security design decisions are well-considered and should be maintained:

1. **Defense-in-depth Cookie attributes**: HttpOnly + Secure (conditional) + SameSite=Strict + Path=/ provides strong Cookie protection
2. **Hash-only server storage**: Server never stores or receives plaintext token; only SHA-256 hash via `CM_AUTH_TOKEN_HASH`
3. **Sufficient entropy**: `crypto.randomBytes(32)` provides 256-bit randomness, making brute force infeasible
4. **No external dependencies**: Using only Node.js standard crypto modules eliminates supply chain risk
5. **Conditional initialization**: `rateLimiter = isAuthEnabled() ? createRateLimiter() : null` prevents unnecessary resource allocation (I004)
6. **Backward compatibility**: `isAuthEnabled()` guard ensures zero impact when authentication is disabled
7. **Token expiration**: Time-limited tokens with CLI-controlled expiry reduce long-lived credential risk
8. **CSRF protection**: SameSite=Strict Cookie + JSON API body prevents cross-origin form attacks
9. **Cleanup on shutdown**: `destroyRateLimiter()` in `gracefulShutdown()` prevents resource leaks
10. **Build separation**: CLI/server build boundary prevents accidental exposure of server-side auth logic in client bundles

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 4 |
| **Total** | **12** |

The most critical finding (S001: timing attack vulnerability) must be addressed before implementation begins, as it affects the fundamental security of the token verification mechanism. S002 (prefix match bypass) and S003 (certificate path validation) are also must-fix items that could lead to authentication bypass or information disclosure.

The design policy document demonstrates strong security awareness overall -- particularly in its choice of crypto primitives, Cookie protection attributes, and backward compatibility approach. The five should-fix items (S004-S008) address gaps in operational security (logging, error messaging) and edge case handling that should be resolved during implementation.

---

## Approval Status

**Conditionally Approved** -- The design may proceed to implementation after addressing the 3 must-fix items (S001, S002, S003). The should-fix items (S004-S008) should be resolved during implementation and verified in code review.

---

*Generated by architecture-review-agent for Issue #331*
*Date: 2026-02-21*
*Stage: 4 - Security Review (OWASP Top 10)*
