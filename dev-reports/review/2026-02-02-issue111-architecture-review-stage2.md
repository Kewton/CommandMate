# Architecture Review Report - Issue #111 Stage 2

**Review Type**: 整合性レビュー (Consistency Review)
**Issue**: #111 - 現在の作業ブランチを可視化して欲しい
**Design Doc**: `dev-reports/design/issue-111-branch-visualization-design-policy.md`
**Review Date**: 2026-02-02
**Reviewer**: Architecture Review Agent

---

## Executive Summary

The design document for Issue #111 (Branch Visualization) is **mostly consistent** with the existing codebase and issue requirements. The review identified 2 Must Fix items, 4 Should Fix items, and 2 Nice to Have items.

**Key Findings**:
- Design doc shows Worktree.id as `number` but codebase uses `string` (type mismatch)
- exec vs execFile discrepancy for git command execution
- All 8 acceptance criteria from Issue #111 are covered
- Internal design consistency is good with no contradictions

---

## Review Scope

1. Design document vs existing codebase implementation patterns
2. Design document vs Issue #111 requirements (fetched via `gh issue view 111`)
3. Design document internal consistency
4. Naming conventions, file structure, and coding patterns

### Files Reviewed

| File | Purpose |
|------|---------|
| `src/types/models.ts` | Type definitions |
| `src/lib/db-migrations.ts` | Migration patterns |
| `src/lib/db.ts` | Database functions |
| `src/lib/worktrees.ts` | Existing git command patterns |
| `src/app/api/worktrees/[id]/route.ts` | API route patterns |
| `src/app/api/worktrees/[id]/send/route.ts` | Send route patterns |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Component patterns |
| `src/components/mobile/MobileHeader.tsx` | Mobile header patterns |

---

## Findings

### Must Fix (Critical)

#### CON-MF-001: exec() vs execFile() Pattern Mismatch

| Attribute | Value |
|-----------|-------|
| **Category** | Implementation Pattern Mismatch |
| **Impact** | Security inconsistency |

**Issue**: The design policy specifies using `execFile()` for security (Section 8.1), but existing `worktrees.ts` uses `exec()` via promisify.

**Evidence**:
- Design doc Section 8.1: "execFile使用（シェル解釈なし）"
- Existing code `src/lib/worktrees.ts` line 6: `import { exec } from 'child_process'`

**Recommendation**:
- **Option A**: Update design to use `exec()` for consistency with existing `worktrees.ts` pattern (acceptable since worktreePath comes from trusted DB source)
- **Option B**: Create `git-utils.ts` with `execFile()` and plan future migration of `worktrees.ts`
- Document this discrepancy in Stage 1 Review's SF-1 note

---

#### CON-MF-002: Worktree ID Type Mismatch

| Attribute | Value |
|-----------|-------|
| **Category** | Type Definition Inconsistency |
| **Impact** | Type compilation errors |

**Issue**: Design doc shows `Worktree` interface with `id: number` (Section 5.1), but existing `src/types/models.ts` defines `id: string`.

**Evidence**:
- Design doc Section 5.1 API response: `id: number`
- Existing code `src/types/models.ts` line 12: `id: string`

**Recommendation**: Update design doc Section 5.1 to use `id: string` to match existing codebase pattern.

---

### Should Fix (Important)

#### CON-SF-001: Migration Name Not Specified

| Attribute | Value |
|-----------|-------|
| **Category** | Migration Pattern |
| **Impact** | Minor - migration works but name should follow conventions |

**Issue**: Existing migrations use kebab-case names (e.g., 'add-multi-repo-and-memo-support'), but design doc Section 3.2 doesn't specify a name for Migration #15.

**Recommendation**: Add migration name `'add-initial-branch-column'` in design doc Section 3.1.

---

#### CON-SF-003: API Response Pattern Clarity

| Attribute | Value |
|-----------|-------|
| **Category** | API Response Pattern |
| **Impact** | Medium - Implementation needs clear guidance |

**Issue**: Existing `route.ts` returns worktree data spread with session status fields. Design should clarify that `gitStatus` will be added to this existing spread pattern.

**Evidence**:
```typescript
// Current pattern in src/app/api/worktrees/[id]/route.ts
return NextResponse.json({
  ...worktree,
  isSessionRunning: anyRunning,
  isWaitingForResponse: anyWaiting,
  isProcessing: anyProcessing,
  sessionStatusByCli,
});
```

**Recommendation**: Design doc should explicitly show gitStatus being added to existing spread pattern:
```typescript
{ ...worktree, gitStatus, isSessionRunning, isWaitingForResponse, ... }
```

---

#### CON-SF-004: BranchMismatchAlert DOM Location

| Attribute | Value |
|-----------|-------|
| **Category** | Component Integration Pattern |
| **Impact** | Medium - Implementer needs guidance |

**Issue**: Design specifies "DesktopHeader の下部" but doesn't specify the exact integration point in `WorktreeDetailRefactored.tsx`.

**Recommendation**: Specify that `BranchMismatchAlert` should be placed between `DesktopHeader` and the `flex-1` div containing `WorktreeDesktopLayout`, similar to how the prompt panel overlay is positioned.

---

### Nice to Have

#### CON-NTH-001: GitStatus Import Pattern

Add note that GitStatus should be exported and imported same as Worktree:
```typescript
import type { Worktree, GitStatus } from '@/types/models';
```

#### CON-NTH-002: Test Directory Structure

Verify test path `tests/unit/components/` exists for React component tests (may need to create this subdirectory).

---

## Issue Requirements Coverage

| Requirement | Status | Design Coverage |
|-------------|--------|-----------------|
| Branch name display in header | Covered | Section 6.1, 10 |
| Visual warning on branch mismatch | Covered | Section 6.1 BranchMismatchAlert |
| Mobile branch display | Covered | Section 10 MobileHeader.tsx |
| Polling-based updates (2s/5s) | Covered | Uses existing GET /api/worktrees/:id |
| Migration #15 | Covered | Section 3.1-3.2 |
| detached HEAD handling | Covered | Section 5.2 error handling table |
| Timeout handling | Covered | Section 5.2-5.3 (1s timeout) |
| aheadBehind out of scope | Covered | Section 1.3, 7.3 |

**Result**: 8/8 acceptance criteria covered

---

## Internal Consistency Check

| Check | Status |
|-------|--------|
| Section 3.3 (db.ts) aligns with Section 5.1 (send/route.ts) | Consistent |
| GitStatus interface (4.1) matches BranchMismatchAlertProps (6.1) | Consistent |
| Affected files (10) matches implementation tasks (11) | Consistent |

**Result**: No contradictions found between sections

---

## Naming Convention Check

| Item | Convention | Status |
|------|------------|--------|
| `GitStatus` interface | PascalCase for interfaces | OK |
| `BranchMismatchAlert` component | PascalCase for components | OK |
| `initial_branch` column | snake_case for DB columns | OK |
| `saveInitialBranch` function | camelCase for functions | OK |
| `isBranchMismatch` field | camelCase for TS properties | OK |
| `git-utils.ts` filename | kebab-case for lib files | OK |

**Result**: All naming follows project conventions

---

## File Structure Check

| Proposed File | Convention Check | Status |
|---------------|------------------|--------|
| `src/lib/git-utils.ts` | New utility in lib folder | OK (follows worktrees.ts, tmux.ts) |
| `src/components/worktree/BranchMismatchAlert.tsx` | Worktree-specific component | OK (follows existing patterns) |

**Result**: Proposed structure aligns with codebase patterns

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |
| **Total Findings** | **8** |

---

## Recommended Actions

1. **Immediately**: Fix CON-MF-002 (Worktree id type: number -> string in design doc)
2. **Before Implementation**: Document exec vs execFile decision (CON-MF-001)
3. **During Implementation**: Address Should Fix items for clearer integration
4. **Optional**: Address Nice to Have items for improved developer experience

---

## Approval Status

- [x] Requirements coverage verified
- [x] Internal consistency verified
- [x] Naming conventions verified
- [x] File structure verified
- [ ] Must Fix items addressed (pending)

**Review Status**: CONDITIONAL APPROVAL - Address Must Fix items before implementation

---

*Report generated by Architecture Review Agent*
