# Architecture Review Report: Issue #11 Impact Analysis (Stage 3)

**Issue**: #11 - Data Collection Feature Enhancement for Bug Investigation
**Focus Area**: Impact Scope Analysis (影響範囲)
**Date**: 2026-02-10
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

This review analyzes the impact scope of the design policy for Issue #11, which introduces log export sanitization, API logging (withLogging()), and related infrastructure changes. The design is well-structured with clear module boundaries. However, two areas require clarification before implementation: (1) the explicit list of route.ts files targeted for Phase 1 withLogging() application, and (2) the comprehensive list of fs/promises functions that must be mocked in the integration test rewrite.

The change scope is moderate, involving 10 directly modified files (3 new, 7 modified) and 5 indirectly affected files. The risk is contained because new modules are additive, existing module interfaces remain stable, and the changes are backward-compatible.

---

## Impact Analysis: Directly Modified Files

| Category | File | Change Type | Risk | Description |
|----------|------|-------------|------|-------------|
| New Module | `src/config/log-config.ts` | New | Low | LOG_DIR constant centralization. Depends on getEnvByKey(). |
| New Module | `src/lib/log-export-sanitizer.ts` | New | Low | Path sanitization for export. Depends on escapeRegExp(), getEnv(), os.hostname(). |
| New Module | `src/lib/api-logger.ts` | New | Medium | withLogging() helper with generic ApiHandler<P>. Depends on createLogger(). |
| Modified | `src/lib/log-manager.ts` | LOG_DIR import change | Low | Internal constant source change. No interface change. |
| Modified | `src/app/api/worktrees/[id]/logs/[filename]/route.ts` | LOG_DIR import + sanitize option | Medium | Adds ?sanitize=true query parameter. Sanitize call limited to 1 line. |
| Modified | `src/app/api/worktrees/[id]/logs/route.ts` | withLogging() application | Low | Decorator wrapping. No handler logic change. |
| Modified | `src/lib/api-client.ts` | getLogFile() extension | Low | Adds sanitize option + cliToolId to return type. Backward-compatible. |
| Modified | `src/components/worktree/LogViewer.tsx` | Export button + regex refactor | Medium | UI addition + inline regex replacement with escapeRegExp() import. |
| Modified | `src/lib/utils.ts` | JSDoc comment only | Low | No logic change. |
| Modified | `tests/integration/api-logs.test.ts` | Major rewrite | High | fs mock strategy change, extension change, test structure overhaul. |

### Total: 3 new files, 7 modified files

---

## Impact Analysis: Indirectly Affected Files

| File | Impact | Risk |
|------|--------|------|
| `src/lib/conversation-logger.ts` | Imports createLog from log-manager.ts. log-manager.ts internal LOG_DIR change must not affect createLog() behavior. | Low |
| `src/lib/env.ts` | New consumer (log-export-sanitizer.ts) calls getEnv(). No change to env.ts itself. | Low |
| `src/lib/logger.ts` | New consumer (api-logger.ts) calls createLogger(). No change to logger.ts itself. | Low |
| `src/components/worktree/FileTreeView.tsx` | Uses escapeRegExp() from utils.ts. Only JSDoc comment changes; function logic unchanged. | Low |
| `src/lib/clipboard-utils.ts` | LogViewer.tsx export button will call copyToClipboard(). No change to clipboard-utils.ts. | Low |

---

## Impact Analysis: Unaffected Modules

The following modules are confirmed to have zero impact from this change:

- `src/lib/sanitize.ts` -- XSS sanitization, different purpose, fully separate
- `src/lib/db-instance.ts`, `src/lib/db.ts` -- Database layer, no changes
- `src/cli/` -- CLI module in its entirety, no changes
- `src/components/sidebar/` -- Sidebar components, no changes
- `src/components/mobile/` -- Mobile components, no changes
- `src/hooks/` -- Custom hooks (useFileSearch, useContextMenu, etc.), no changes
- `src/contexts/` -- React contexts, no changes
- `src/config/` (existing files) -- status-colors.ts, z-index.ts, etc., no changes

---

## Handler Count Analysis

The codebase currently contains:

| Metric | Count |
|--------|-------|
| Total route.ts files | 25 |
| Total handler functions (GET/POST/PUT/PATCH/DELETE) | 48 |
| Handlers using `params: Promise<...>` | 7 |
| Handlers using non-Promise params | 41 |
| **Phase 1 target handlers (logs-related)** | **2-4** |
| Phase 2 remaining handlers (separate Issue) | 44-46 |

### Promise params files (7 handlers across 5 files):

1. `src/app/api/external-apps/[id]/route.ts` -- GET, PATCH, DELETE (3 handlers)
2. `src/app/api/external-apps/[id]/health/route.ts` -- GET (1 handler)
3. `src/app/api/repositories/clone/[jobId]/route.ts` -- GET (1 handler)
4. `src/app/api/worktrees/[id]/interrupt/route.ts` -- POST (1 handler)
5. `src/app/api/worktrees/[id]/slash-commands/route.ts` -- GET (1 handler)

---

## Dependency Chain Analysis

### New Module Dependencies

```
log-config.ts (new)
  -> env.ts (getEnvByKey)
  -> path (Node.js built-in)

log-export-sanitizer.ts (new)
  -> env.ts (getEnv)
  -> utils.ts (escapeRegExp)
  -> os (Node.js built-in - hostname())

api-logger.ts (new)
  -> logger.ts (createLogger)
  -> next/server (NextRequest, NextResponse)
```

### Circular Dependency Check

- `log-config.ts` -> `env.ts`: No risk. env.ts does not import from config/.
- `log-export-sanitizer.ts` -> `env.ts` + `utils.ts`: No risk. Neither env.ts nor utils.ts imports from lib/log-export-sanitizer.ts.
- `api-logger.ts` -> `logger.ts`: No risk. logger.ts does not import from lib/api-logger.ts.

**Result**: No circular dependency risks identified.

---

## LOG_DIR Duplication Analysis

Current duplication (confirmed by code review):

| Location | Current Definition | After T0 |
|----------|-------------------|----------|
| `src/lib/log-manager.ts` (line 14) | `getEnvByKey('CM_LOG_DIR') \|\| path.join(process.cwd(), 'data', 'logs')` | Import from log-config.ts |
| `src/app/api/worktrees/[id]/logs/[filename]/route.ts` (line 14) | Same expression (exact duplicate) | Import from log-config.ts |

These are the **only 2 locations** where LOG_DIR is defined. T0 correctly identifies both.

---

## Risk Assessment

| Risk Category | Level | Justification |
|---------------|-------|---------------|
| Technical | Medium | Integration test rewrite (T1) has high complexity due to fs/promises mock strategy with log-manager.ts intermediary. New generic type ApiHandler<P> introduces moderate type system complexity. |
| Security | Low | Server-side sanitization prevents sensitive data leakage. Existing security mechanisms (path traversal check, DOMPurify) remain unchanged. New sanitization is additive only. |
| Operational | Low | No database schema changes. No deployment configuration changes. New modules are opt-in (sanitize query parameter, withLogging wrapper). |

---

## Detailed Findings

### Must Fix Items

#### S3-MF-001: Phase 1 withLogging() Scope is Ambiguous

**Severity**: Must Fix
**Location**: Design policy section 10, T7

The design states that T7 should apply withLogging() to "log-related APIs + APIs needed for bug investigation" but does not enumerate the specific route.ts files. With 25 route files containing 48 handlers, this ambiguity risks scope creep during implementation.

**Current confirmed log-related route files**:
- `src/app/api/worktrees/[id]/logs/route.ts` (GET -- log file list)
- `src/app/api/worktrees/[id]/logs/[filename]/route.ts` (GET -- log file content)

**Recommendation**: Add an explicit file list to T7 in the design policy. If the scope is limited to the 2 log-related files above, state so explicitly. If additional "bug investigation" APIs are included, list them.

---

#### S3-MF-002: Integration Test Rewrite (T1) fs/promises Mock Coverage Gap

**Severity**: Must Fix
**Location**: Design policy sections 9, 10 (T1)

The `logs/route.ts` handler calls `listLogs()` from log-manager.ts, which internally calls:
- `fs.access()` -- in ensureLogDirectory()
- `fs.mkdir()` -- in ensureLogDirectory()
- `fs.readdir()` -- to list files

Additionally, logs/route.ts itself calls `fs.stat()` on each returned path.

The `logs/[filename]/route.ts` handler calls directly:
- `fs.stat()` -- to check file existence
- `fs.readFile()` -- to read content

The design policy mentions this layering (S2-SF-002) but does not provide a concrete list of all fs/promises functions that must be mocked per API endpoint. This risks mock omissions causing test failures or false passes.

**Recommendation**: Add a table to the T1 section listing each test describe block and the corresponding fs/promises functions that must be mocked:

| Test Suite | Route | fs/promises Functions to Mock |
|-----------|-------|-------------------------------|
| `GET /api/worktrees/:id/logs` | logs/route.ts -> log-manager.ts | access, mkdir, readdir, stat |
| `GET /api/worktrees/:id/logs/:filename` | logs/[filename]/route.ts | stat, readFile |

---

### Should Fix Items

#### S3-SF-001: log-config.ts Module Initialization Order

The new `log-config.ts` will be imported by both `log-manager.ts` and `logs/[filename]/route.ts`. Since `log-config.ts` calls `getEnvByKey()` at module top-level (like the current LOG_DIR definitions), the initialization order depends on which module is imported first. This matches the current behavior (both files already call getEnvByKey() at top level), so no functional change occurs. However, the dependency chain should be documented: `log-config.ts` -> `env.ts` -> `db-path-resolver.ts`.

**Recommendation**: Add a brief note to T0 confirming no circular dependency exists in this chain.

#### S3-SF-002: getLogFile() Call Site Documentation

Currently `getLogFile()` from api-client.ts is called in exactly 1 location:
- `src/components/worktree/LogViewer.tsx` (line 75)

This should be documented in the design policy to prevent implementation-time ambiguity.

#### S3-SF-003: escapeRegExp() JSDoc Update Must Preserve SEC-MF-001 Note

The current JSDoc for `escapeRegExp()` contains a critical security note about ReDoS prevention (SEC-MF-001). When updating the JSDoc to indicate server-side usage, this note must be preserved. The design policy should specify the exact JSDoc update wording.

#### S3-SF-004: Phase 2 Cost Estimation Should Include Promise Params Type Unification

The 7 handlers across 5 files that use `params: Promise<...>` represent additional work when unifying all APIs under withLogging() in Phase 2. The design policy should list these files in T7 for future reference.

---

### Consider Items

#### S3-C-001: os.hostname() Mock Strategy for CI

`buildSanitizeRules()` uses `os.hostname()` which varies across environments. Test mocking is needed.

#### S3-C-002: LogViewer.tsx Export Button Mobile Layout

Adding a button to the existing CardHeader may cause layout issues on narrow screens.

#### S3-C-003: Sanitization Performance for Large Log Files

With 4-5 rules, performance impact is negligible. Only relevant if rules grow beyond 10.

---

## Migration and Deployment Considerations

### Backward Compatibility

All changes are backward-compatible:

1. **API**: The `?sanitize=true` parameter is optional. Existing calls without it behave identically.
2. **api-client.ts**: The `sanitize` option is optional. The `cliToolId` field addition to the return type is additive.
3. **withLogging()**: Wrapping is opt-in per handler. Unwrapped handlers continue to work.
4. **LOG_DIR centralization**: Internal refactoring; no external API change.

### Deployment Steps

No special deployment steps required:

- No database migrations
- No environment variable additions required (all new modules use existing env vars)
- No configuration changes
- Standard `npm run build` is sufficient

### Rollback Strategy

If issues arise, any individual task can be reverted independently:

- T0 (log-config.ts): Revert to inline LOG_DIR definitions
- T2 (sanitizer): Remove new file, no other files depend on it until T3
- T6 (api-logger.ts): Remove new file, unwrap withLogging() calls
- T5 (LogViewer export button): Remove button, revert inline regex

---

## Summary of Findings

| Category | Count |
|----------|-------|
| Must Fix | 2 |
| Should Fix | 4 |
| Consider | 3 |
| Directly Modified Files | 10 |
| Indirectly Affected Files | 5 |
| Unaffected Module Groups | 8+ |

---

## Approval

**Status**: Conditionally Approved

**Conditions**:
1. S3-MF-001: Enumerate specific route.ts files for Phase 1 withLogging() application in T7.
2. S3-MF-002: Document the complete list of fs/promises functions to mock per test suite in T1.

Once these two items are addressed, the design policy is ready for implementation.

---

*Reviewed by: architecture-review-agent*
*Review type: Impact Analysis (Stage 3 of multi-stage design review)*
*Date: 2026-02-10*
