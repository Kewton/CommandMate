# Architecture Review Report: Issue #331 Stage 3 - Impact Analysis

**Issue**: #331 Token Authentication / HTTPS Support
**Stage**: 3 (Impact Analysis Review)
**Focus**: Impact Scope (影響範囲)
**Date**: 2026-02-21
**Status**: Conditionally Approved
**Score**: 3.5/5

---

## Executive Summary

This Stage 3 review evaluates the impact of Issue #331's token authentication and HTTPS design on existing functionality, tests, builds, CLI commands, and parallel development. The design document (post-Stage 1/2 updates) demonstrates strong backward compatibility awareness through the `isAuthEnabled()` guard pattern. However, **3 must-fix items** were identified where the design document fails to account for specific existing test/code dependencies that will break upon implementation. **8 should-fix items** address gaps in the impact analysis that could lead to implementation oversights or runtime issues. **5 nice-to-have items** suggest documentation improvements for completeness.

---

## Detailed Findings

### Must Fix (3 items)

#### I001: i18n-namespace-loading.test.ts will fail after auth namespace addition

**Severity**: Must Fix
**Category**: Test Impact
**Location**: Section 10 (i18n), Section 14 (Changed Files), Section 16 (Test Plan)

**Problem**: The file `tests/integration/i18n-namespace-loading.test.ts` contains a hardcoded assertion:

```typescript
// Line 19
const EXPECTED_NAMESPACES = ['common', 'worktree', 'autoYes', 'error', 'prompt'] as const;

// Line 40-54
it('should have exactly 5 namespace files per locale matching src/i18n.ts', () => {
  // ...
  expect(files).toEqual(expected);  // Will fail when auth.json is added
});
```

Adding `locales/en/auth.json` and `locales/ja/auth.json` will cause this test to fail immediately. The design document does not mention this file in Section 14 (Changed Files) or Section 16 (Test Plan).

**Recommendation**: Add `tests/integration/i18n-namespace-loading.test.ts` to the changed files list in Section 14. Update EXPECTED_NAMESPACES to include 'auth'. Add this to the implementation checklist in Section 20.

---

#### I002: WebSocket test impact from ws-server.ts authentication changes

**Severity**: Must Fix
**Category**: Existing Feature Impact
**Location**: Section 9.2, Section 16.4

**Problem**: The file `tests/integration/websocket.test.ts` creates an HTTP server and passes it directly to `setupWebSocket()`. After adding authentication to the upgrade handler, all 6 existing test cases must continue to pass when `CM_AUTH_TOKEN_HASH` is not set. The design document Section 16.4 covers new WebSocket authentication tests but does not analyze the impact on the 6 existing tests:

1. `should accept WebSocket connections`
2. `should handle client disconnection`
3. `should broadcast messages to clients in the same room`
4. `should handle multiple rooms simultaneously`
5. `should remove client from room on disconnect`
6. `should handle invalid message format gracefully`

**Recommendation**: Explicitly state in Section 16.4 that existing WebSocket tests must pass with `CM_AUTH_TOKEN_HASH` unset. Consider adding an explicit `delete process.env.CM_AUTH_TOKEN_HASH` in the test's `beforeEach` as a safety guard.

---

#### I003: middleware.ts matcher applies to all HTTP requests including high-frequency polling

**Severity**: Must Fix
**Category**: Existing Feature Impact
**Location**: Section 5.3, Section 5.4

**Problem**: Currently no `middleware.ts` exists in the project. Adding one with the matcher `'/((?!_next/static|_next/image|favicon.ico).*)'` means the middleware function will execute on every HTTP request, including high-frequency polling endpoints:

- `/api/worktrees/[id]/check-response` (response-poller)
- `/api/worktrees/[id]/auto-yes-poll` (auto-yes-manager)

While `isAuthEnabled()` returning false leads to an immediate `NextResponse.next()`, the design document should explicitly acknowledge this change in request processing pipeline and confirm the overhead is negligible.

**Recommendation**: Add a note in Section 5.3 or 8.1 (Performance) stating that the middleware overhead when auth is disabled is minimal (single function call + process.env check per request). This ensures implementers and reviewers understand the performance characteristics.

---

### Should Fix (8 items)

#### I004: rateLimiter setInterval starts unconditionally on auth.ts import

**Severity**: Should Fix
**Category**: Existing Feature Impact
**Location**: Section 6.2, Section 11.1, C010

**Problem**: The design specifies that `auth.ts` creates a rateLimiter at module scope:

```typescript
const rateLimiter = createRateLimiter(); // starts setInterval cleanup
```

When `server.ts` imports `auth.ts` (added to tsconfig.server.json), the cleanup timer starts regardless of whether authentication is enabled. This means every server instance (including `--auth`-free ones) will have a 1-hour interval timer running unnecessarily.

**Recommendation**: Guard rateLimiter creation with `isAuthEnabled()`, or use lazy initialization (create on first `checkLimit()` call). Document this decision in Section 6.2.

---

#### I005: start.ts foreground mode lacks auth environment variable setup

**Severity**: Should Fix
**Category**: CLI Impact
**Location**: Section 12 (Phase 4), Section 7

**Problem**: Section 12 Phase 4 details `daemon.ts` environment variable propagation (C008) with concrete code examples, but `start.ts` foreground mode (lines 130-179) has the same requirement and is not covered. The foreground mode builds its own `env` object (lines 148-163) and spawns `npm run start/dev`. Authentication environment variables (`CM_AUTH_TOKEN_HASH`, `CM_AUTH_TOKEN_EXPIRE_AT`, etc.) must be added here too.

**Recommendation**: Add `start.ts` foreground mode to Phase 4 implementation guidance with the same environment variable propagation pattern as `daemon.ts`.

---

#### I006: server.ts startup log message shows 'http://' even for HTTPS

**Severity**: Should Fix
**Category**: Existing Feature Impact
**Location**: Section 9.1

**Problem**: Current `server.ts` line 130:
```typescript
console.log(`> Ready on http://${hostname}:${port}`);
```

The design document's HTTPS conditional branching (Section 9.1) does not mention updating this log message. After implementing HTTPS support, the server will display "Ready on http://..." when actually serving HTTPS.

**Recommendation**: Add protocol-dynamic log message update to Section 9.1 code examples, mirroring the C013 pattern used for `status.ts`.

---

#### I007: StartOptions type extension backward compatibility not explicitly stated

**Severity**: Should Fix
**Category**: Test Impact
**Location**: Section 14, Section 12 (Phase 4)

**Problem**: Adding new fields to `StartOptions` in `src/cli/types/index.ts` will affect all code importing this interface. While new optional fields (`auth?: boolean`, `authExpire?: string`, etc.) maintain backward compatibility, the design document does not explicitly confirm this. Existing tests in `tests/unit/cli/` may construct `StartOptions` objects that would still be valid.

**Recommendation**: Explicitly state in Section 12 that all new `StartOptions` fields are optional (`?` suffix) and existing usages remain valid.

---

#### I008: auth.ts import dependency constraint for tsconfig.server.json

**Severity**: Should Fix
**Category**: Build Impact
**Location**: Section 11.1, Section 2.3

**Problem**: Adding `src/lib/auth.ts` to `tsconfig.server.json` include means auth.ts must not import from files outside the existing include list. If auth.ts accidentally imports from `@/config/auto-yes-config.ts` (referenced in design for pattern similarity), it would pull in additional files. The `@/*` path alias is resolved via `tsconfig.base.json` paths which `tsconfig.server.json` extends.

**Recommendation**: Add an explicit constraint in Section 11.1: "auth.ts MUST only use Node.js standard library imports (crypto). No @/ path alias imports allowed." This is a build boundary constraint.

---

#### I009: commandmate init template not updated for auth/HTTPS variables

**Severity**: Should Fix
**Category**: CLI Impact
**Location**: Section 14 (Changed Files)

**Problem**: `.env.example` is listed as a changed file (HTTPS comment addition), but `commandmate init` generates `.env` files via `src/cli/utils/env-setup.ts`. The init command's template should optionally include commented-out authentication/HTTPS variables to guide users. Neither `env-setup.ts` nor `init.ts` appear in the changed files list.

**Recommendation**: Decide whether init-generated `.env` files should include auth/HTTPS variable comments. If yes, add `src/cli/utils/env-setup.ts` to the changed files list.

---

#### I010: Security warning display precedence with --auth

**Severity**: Should Fix
**Category**: Existing Feature Impact
**Location**: Section 12 (Phase 5, C015), Section 7

**Problem**: Current `start.ts` and `daemon.ts` display `REVERSE_PROXY_WARNING` when `CM_BIND=0.0.0.0`. With `--auth` enabled, the design adds `AUTH_HTTP_WARNING` and `AUTH_ENABLED_MESSAGE` (C015). The display priority when both conditions are true (0.0.0.0 bind + auth enabled) is not defined. Should both warnings display? Should auth presence suppress the reverse proxy warning?

**Recommendation**: Define a clear precedence rule in Section 12 or C015. Suggested logic:
- `--auth` + HTTPS: Show `AUTH_ENABLED_MESSAGE` only (reverse proxy not needed)
- `--auth` + HTTP + `--allow-http`: Show `AUTH_ENABLED_MESSAGE` only
- `--auth` + HTTP: Show `AUTH_HTTP_WARNING` only (supersedes reverse proxy warning)
- No `--auth` + 0.0.0.0: Show `REVERSE_PROXY_WARNING` (existing behavior)

---

#### I011: middleware.ts test mock strategy could contaminate other tests

**Severity**: Should Fix
**Category**: Test Impact
**Location**: Section 16.3, Section 11.3

**Problem**: The design specifies `vi.mock('next/server')` for middleware.ts tests. The vitest environment is `node` (not edge runtime). If `vi.mock()` is placed at the file level, it could affect other test files in the same test run that import from `next/server`. API route tests in `tests/integration/` may depend on the actual `next/server` module behavior.

**Recommendation**: Recommend scoping the mock within the test file and using `afterEach(() => vi.restoreAllMocks())`. Do not add global mocks to `vitest.setup.ts` or `tests/setup.ts`.

---

### Nice to Have (5 items)

#### I012: useWebSocket.ts reconnection auth check lacks concrete design

**Severity**: Nice to Have
**Category**: Existing Feature Impact
**Location**: Section 15.3, Section 14

**Problem**: Section 15.3 states "integrate auth check in existing useWebSocket.ts reconnection logic," but Section 14 lists `useWebSocket.ts` under "No Changes Required" with the reason "wss:// auto-detection already implemented." These two sections contradict each other. The current reconnection logic (lines 137-141) is a simple setTimeout; adding async auth status checks would require structural changes.

**Recommendation**: Reconcile Section 14 and 15.3. Either move `useWebSocket.ts` to the changed files list, or revise Section 15.3 to implement auth-aware reconnection in a separate hook/wrapper.

---

#### I013: npm run build:all impact is implicit

**Severity**: Nice to Have
**Category**: Build Impact
**Location**: Section 11

**Problem**: The design covers individual build impacts (Next.js build, server build, CLI build) but does not explicitly confirm that `npm run build:all` will succeed. Specifically, `middleware.ts` at `src/middleware.ts` is auto-included in Next.js builds per App Router convention, and its import of `@/lib/auth` must resolve correctly.

**Recommendation**: Add a brief note in Section 11 confirming `npm run build:all` compatibility.

---

#### I014: Parallel development conflict risk is low

**Severity**: Nice to Have
**Category**: Conflict
**Location**: Section 14

**Problem**: Analysis of main branch history shows recent merges (Issues #321, #323, #326) do not modify the primary target files of Issue #331 (server.ts, ws-server.ts, middleware.ts, auth.ts). However, `server.ts` is shared infrastructure, and the `gracefulShutdown()` function is a common modification point.

**Recommendation**: Note in Section 12 that `destroyRateLimiter()` should be added after the existing `stopAllAutoYesPolling()` call in `gracefulShutdown()`, as a conflict resolution guide.

---

#### I015: E2E test HTTPS configuration not detailed

**Severity**: Nice to Have
**Category**: Test Impact
**Location**: Section 16.5

**Problem**: Section 16.5 outlines E2E test scenarios for the login flow but does not specify how existing E2E tests run against a non-authenticated server. This is likely fine (existing tests simply do not use `--auth`), but should be stated explicitly.

**Recommendation**: Add a note: "Existing Playwright E2E tests continue to run against a server started without `--auth`. New E2E tests for auth flow are additive and do not modify existing test files."

---

#### I016: WebSocket Cookie auto-send behavior undocumented

**Severity**: Nice to Have
**Category**: Existing Feature Impact
**Location**: Section 14 (No Changes Required), Section 2.2

**Problem**: The design correctly states `useWebSocket.ts` needs no changes for wss:// detection. However, it does not document why WebSocket authentication works without client-side Cookie handling: browser WebSocket API automatically includes cookies in the upgrade handshake for same-origin connections.

**Recommendation**: Add this technical rationale to Section 14's "No Changes Required" entry for `useWebSocket.ts`.

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | i18n test breakage (I001) | High | High | P1 |
| Technical | WebSocket test regression (I002) | High | Medium | P1 |
| Technical | middleware overhead on polling (I003) | Low | High | P2 |
| Operational | rateLimiter timer in auth-disabled mode (I004) | Low | High | P2 |
| Technical | Foreground mode env vars missing (I005) | High | High | P1 |
| Operational | Incorrect log protocol (I006) | Low | High | P3 |
| Build | tsconfig.server.json dependency leak (I008) | Medium | Low | P3 |
| Operational | Security warning display overlap (I010) | Low | Medium | P3 |

---

## Impact Analysis Summary

### Category: Existing Feature Impact

| File | Change Type | Impact | Risk |
|------|------------|--------|------|
| `server.ts` | Modified (HTTPS branching, gracefulShutdown) | Direct | Medium - log message, shutdown sequence |
| `src/lib/ws-server.ts` | Modified (type + auth) | Direct | Medium - existing broadcast/export API unchanged |
| `src/middleware.ts` | New file | Indirect | Low - all requests pass through when exists |
| `src/hooks/useWebSocket.ts` | Conflicting requirement | Indirect | Low - may or may not need changes per Section 14 vs 15.3 |
| `src/lib/env.ts` | No change (intentional) | None | None - C003 excludes ENV_MAPPING changes |
| `next.config.js` | No change | None | None - CSP already allows ws:/wss: |
| `src/lib/response-poller.ts` | Indirect (middleware intercept) | Indirect | Low - middleware passes through when auth disabled |
| `src/lib/auto-yes-manager.ts` | Indirect (middleware intercept) | Indirect | Low - same as above |
| API route files importing ws-server.ts | No change to import API | None | None - broadcast/broadcastMessage signatures unchanged |

### Category: Test Impact

| Test File | Impact | Action Required |
|-----------|--------|----------------|
| `tests/integration/i18n-namespace-loading.test.ts` | **Breaks** | Update EXPECTED_NAMESPACES (I001) |
| `tests/integration/websocket.test.ts` | Requires verification | Confirm auth-disabled passthrough (I002) |
| `tests/unit/ws-server-cleanup.test.ts` | Minimal | No change expected |
| `tests/unit/env.test.ts` | None | C003 ensures no env.ts changes |
| `tests/unit/cli/**` | Minimal | StartOptions backward compatible (I007) |
| Existing Playwright E2E tests | None | Run without --auth flag |

### Category: Build Impact

| Build Target | Impact | Details |
|-------------|--------|---------|
| `npm run build` (Next.js) | Low | middleware.ts auto-included, auth.ts resolved via @/ |
| `npm run build:server` | Low | auth.ts added to tsconfig.server.json include |
| `npm run build:cli` | None | tsconfig.cli.json unchanged (C001) |
| `npm run build:all` | Low | Combination of above |

### Category: CLI Command Impact

| Command | Impact | Details |
|---------|--------|---------|
| `commandmate start` | Direct | New --auth/--cert/--key/--https/--allow-http options |
| `commandmate start` (foreground) | Direct | Env var propagation needed (I005) |
| `commandmate start --daemon` | Direct | daemon.ts env vars (C008) |
| `commandmate status` | Direct | HTTPS URL display (C013) |
| `commandmate stop` | Minimal | No auth-specific changes needed |
| `commandmate init` | Should be addressed | Template may need auth comments (I009) |

---

## Approval Status

**Conditionally Approved** - The design is implementable with the following conditions:

1. **Must address I001**: Update `tests/integration/i18n-namespace-loading.test.ts` in the changed files list and implementation checklist
2. **Must address I002**: Document existing WebSocket test compatibility in Section 16.4
3. **Must address I003**: Add middleware performance note for auth-disabled mode

The 8 should-fix items are recommended for incorporation before implementation begins to avoid preventable issues during development.

---

*Reviewed by: Architecture Review Agent*
*Review Type: Stage 3 Impact Analysis*
*Design Document Version: Post-Stage 1/2 Updates (2026-02-21)*
