# Architecture Review: Issue #270 - Design Principles (Stage 1)

**Date**: 2026-02-14
**Issue**: #270 - update-check route static prerendering fix
**Focus**: Design Principles (SOLID, KISS, YAGNI, DRY)
**Stage**: 1 (Normal Review)
**Reviewer**: Architecture Review Agent

---

## Executive Summary

The design policy for Issue #270 proposes adding `export const dynamic = 'force-dynamic'` to the `/api/app/update-check` route handler to prevent Next.js from statically prerendering it at build time. This is a minimal, well-scoped change that exemplifies excellent adherence to all evaluated design principles. The document is thorough, documents alternatives and their rejection reasons, cites 5 prior project precedents, and includes a clear test strategy.

**Status: APPROVED**
**Score: 5/5**

---

## Design Principles Evaluation

### SOLID Principles

#### Single Responsibility Principle (SRP) -- PASS

The proposed change adds exactly one concern (dynamic route marking) without altering the existing responsibilities of the route handler. The current `route.ts` file already demonstrates strong SRP through its separation of concerns:

- `detectInstallType()` -- install detection with error handling
- `toUpdateCheckResponse()` -- domain-to-API response mapping
- `buildResponse()` -- HTTP response construction with security headers
- `GET()` -- orchestration only

The `export const dynamic` declaration is a route-level configuration concern, properly placed at the module level alongside imports and type definitions, not mixed into handler logic.

#### Open/Closed Principle (OCP) -- PASS

The fix extends the route's runtime behavior (from static to dynamic) without modifying any existing function signatures, return types, or internal logic. The existing code does not need to be opened for modification -- the `dynamic` export is an additive, declarative configuration.

#### Liskov Substitution Principle (LSP) -- NOT APPLICABLE

No class hierarchies, inheritance, or polymorphic contracts are involved in this change.

#### Interface Segregation Principle (ISP) -- PASS

The `UpdateCheckResponse` interface remains focused and cohesive. No new fields are added to the response contract. The change does not introduce any new interfaces or widen existing ones.

#### Dependency Inversion Principle (DIP) -- PASS

The existing architecture already follows DIP well. The route handler depends on abstractions (`checkForUpdate` from `version-checker.ts`, `isGlobalInstall` from `install-context.ts`) rather than concrete implementations. The `dynamic` export does not alter this dependency structure.

### KISS Principle -- PASS

This is a textbook KISS application. The design document correctly identifies the simplest solution:

| Approach | Complexity | Adopted |
|----------|-----------|---------|
| `export const dynamic = 'force-dynamic'` | 1 line, declarative | Yes |
| `export const revalidate = 0` | Semantically incorrect | No |
| `cookies()` / `headers()` dummy calls | Side-effect workaround | No |
| `unstable_noStore()` | Unstable API risk | No |

The chosen approach is the simplest correct solution. The alternatives were properly evaluated and rejected with clear rationale in the design document's Section 3 (Technology Selection).

### YAGNI Principle -- PASS

The design policy shows exemplary YAGNI discipline:

- Only one file is modified (`src/app/api/app/update-check/route.ts`)
- No speculative additions (no ISR configuration, no configurable caching strategies, no revalidation intervals)
- No premature generalization (does not attempt to audit or fix all 36 API routes)
- The scope is precisely bounded to the identified problem

### DRY Principle -- PASS

The solution reuses the exact pattern already established in 5 project files:

1. `src/app/api/worktrees/route.ts` (line 10)
2. `src/app/api/external-apps/route.ts` (line 23)
3. `src/app/api/external-apps/[id]/route.ts` (line 21)
4. `src/app/api/external-apps/[id]/health/route.ts` (line 14)
5. `src/app/proxy/[...path]/route.ts` (line 17)

The design document explicitly references these precedents in Section 3, which is excellent for establishing pattern consistency.

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | Minimal change, well-established Next.js pattern | Low | Low | P3 |
| Security | No security implications; existing SEC-SF-003/SEC-001/SEC-SF-001 protections unchanged | Low | Low | P3 |
| Operational | Route becomes dynamic (per-request), but version-checker.ts globalThis cache (1hr TTL) prevents excessive GitHub API calls | Low | Low | P3 |

---

## Detailed Findings

### Must Fix Items

None.

### Should Fix Items

None.

### Consider Items

#### C-001: Placement Convention Minor Inconsistency

**Principle**: DRY/Consistency
**Severity**: Low

The design policy (Section 4) specifies placing `export const dynamic` after all import statements and before type definitions, which matches the pattern in `src/app/api/external-apps/route.ts` (line 23, after all imports). However, `src/app/api/worktrees/route.ts` places it between import statements (line 10, with more imports following on lines 11-16).

This is a very minor pre-existing inconsistency in the codebase, not introduced by this change. The design document's proposed placement (after all imports, before types) is the cleaner convention and aligns with the majority pattern.

**Relevant code from `src/app/api/worktrees/route.ts`**:
```typescript
import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering - this route uses searchParams and database access
export const dynamic = 'force-dynamic';
import { getDbInstance } from '@/lib/db-instance';  // <-- imports continue after
```

**Relevant code from `src/app/api/external-apps/route.ts`**:
```typescript
import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
// ... more imports ...

// Force dynamic rendering
export const dynamic = 'force-dynamic';  // <-- after all imports
```

**Recommendation**: The design policy's proposed placement (after all imports) is correct. No action required for this issue.

#### C-002: Broader Route Audit Opportunity

**Principle**: YAGNI (acceptable scope limitation)
**Severity**: Info

Of the 36 API route handler files in `src/app/api/`, only 5 currently use `export const dynamic = 'force-dynamic'`. While this issue correctly limits scope to the `update-check` route (proper YAGNI application), other routes that perform runtime I/O (database queries, external API calls) may benefit from the same treatment in a future audit. This is an informational note, not a recommendation for this issue.

---

## Test Strategy Assessment

The design document's test strategy is sound:

1. **Existing tests unaffected**: The 10 existing test cases in `tests/unit/api/update-check.test.ts` test the `GET` function directly via mock imports, so the `dynamic` export addition has zero test impact.

2. **New test proposed**: A unit test verifying `dynamic === 'force-dynamic'` is a simple, valuable regression guard. This is appropriate and follows the pattern of testing route-level configuration.

3. **Build verification**: The acceptance criteria include verifying the `npm run build` output shows the route as Dynamic (`f`) rather than Static (`o`). This is the definitive functional validation.

---

## Approval Status

**APPROVED** -- The design policy demonstrates excellent adherence to all evaluated design principles. The change is minimal, well-justified, follows established project patterns, and introduces no technical debt. The alternatives analysis is thorough, the test strategy is appropriate, and the risk profile is low across all dimensions.

---

*Architecture Review Agent - Stage 1 Design Principles Review*
