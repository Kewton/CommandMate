# Architecture Review: Issue #264 - Design Principles (Stage 1)

**Issue**: #264 - User Feedback Link and CLI Commands
**Focus Area**: Design Principles (SOLID / KISS / YAGNI / DRY)
**Stage**: 1 (Normal Review)
**Date**: 2026-02-14
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

The design policy for Issue #264 demonstrates strong adherence to design principles overall. The `GITHUB_REPO_BASE_URL` centralization is a well-motivated DRY improvement, the `FeedbackSection` component correctly follows the established `VersionSection` SRP pattern, and the OCP-compliant dependency extension via `cli-dependencies.ts` is clean. One must-fix item (YAGNI violation with empty `IssueOptions` interface) was identified, along with several should-fix and consideration items that would further improve design quality.

---

## Detailed Findings

### SOLID Principles

#### S - Single Responsibility Principle

**FeedbackSection (PASS)**

The design correctly follows the `VersionSection` pattern (Issue #257 SF-001) by extracting `FeedbackSection` as an independent component. This component has a single responsibility: displaying feedback/support links. It is reused in both `InfoModal` and `MobileInfoContent`, achieving DRY without violating SRP.

Reference from existing code (`src/components/worktree/VersionSection.tsx`):

```typescript
// VersionSection pattern - FeedbackSection follows same structure
export interface VersionSectionProps {
  version: string;
  className?: string;  // CONS-005 pattern for parent style differences
}
```

**docs command (SHOULD FIX - SF-003)**

The `docs` command design combines section lookup (whitelist validation), file system reading, content searching, and terminal output formatting in a single command handler. While acceptable for an initial implementation, extracting a `DocsReader` utility would better maintain SRP and make the logic independently testable.

#### O - Open/Closed Principle

**cli-dependencies.ts extension (PASS)**

The approach of adding `{ name: 'gh CLI', command: 'gh', versionArg: '--version', required: false }` to the existing `DEPENDENCIES` array is an excellent OCP application. The `PreflightChecker.checkAll()` method automatically picks up new entries without code modification.

However, there is a gap: `PreflightChecker.getInstallHint()` (line 135-145 of `src/cli/utils/preflight.ts`) uses a separate hardcoded `Record` that must be updated independently:

```typescript
// Current pattern - hints are NOT co-located with dependencies
static getInstallHint(name: string): string {
  const hints: Record<string, string> = {
    'Node.js': 'Install with: nvm install 20 or visit https://nodejs.org',
    npm: 'npm is included with Node.js...',
    tmux: 'Install with: brew install tmux...',
    git: 'Install with: brew install git...',
    'Claude CLI': 'Install with: npm install -g @anthropic-ai/claude-cli',
    // gh CLI hint must be added here separately
  };
  return hints[name] || `Please install ${name}`;
}
```

This is a minor OCP gap (see C-001).

#### L - Liskov Substitution Principle

Not applicable. No inheritance hierarchies are introduced in this design.

#### I - Interface Segregation Principle

**DocsOptions (CONSIDER - C-002)**

The `DocsOptions` interface combines three mutually exclusive operation modes:

```typescript
export interface DocsOptions {
  section?: string;   // --section <name>
  search?: string;    // --search <query>
  all?: boolean;      // (list all)
}
```

These fields represent three distinct operations. A discriminated union would make the mutual exclusivity explicit at the type level. This is a consideration for improved type safety, not a blocking issue.

**IssueCreateOptions (PASS)**

Well-focused interface with appropriate fields for the create subcommand.

#### D - Dependency Inversion Principle

**Cross-boundary imports (PASS)**

The design correctly identifies the `src/cli/utils/port-allocator.ts` precedent for cross-boundary imports from `src/cli/` to `src/`:

```typescript
// port-allocator.ts line 12 - validated precedent
import { AppError, ErrorCode } from '../../lib/errors';
```

The plan to import `GITHUB_SECURITY_GUIDE_URL` from `src/config/github-links.ts` in `security-messages.ts` follows this established pattern. The fallback plan (CLI-specific copy if build fails) is pragmatic.

The decision to keep `GITHUB_API_URL` hardcoded in `version-checker.ts` (SEC-001) is a justified deviation from DRY that correctly prioritizes security over code organization.

---

### KISS Principle

**gh CLI delegation (PASS)**

Using `gh` CLI for GitHub Issue operations instead of implementing direct HTTP API calls is an excellent KISS decision. The design document explicitly compares this with the alternative (Section 8-2, Alternative 2) and correctly concludes that `gh` CLI handles authentication transparently.

**Whitelist pattern for docs (PASS)**

The `SECTION_MAP` whitelist approach is simple and effective for path traversal prevention:

```typescript
const SECTION_MAP: Record<string, string> = {
  'quick-start': 'docs/user-guide/quick-start.md',
  'commands': 'docs/user-guide/commands-guide.md',
  // ...
};
```

**Path resolution (SHOULD FIX - SF-004)**

`path.join(__dirname, '../../../docs/')` is functional but relies on knowledge of the exact compilation output structure (`tsconfig.cli.json` compiles `src/cli/commands/docs.ts` to `dist/cli/commands/docs.js`). This works but is fragile against directory restructuring. Using `require.resolve` or resolving from the package root would be more resilient.

---

### YAGNI Principle

**Empty IssueOptions interface (MUST FIX - MF-001)**

```typescript
export interface IssueOptions {
  // issueコマンド全体のオプション (future extension)
}
```

This empty interface with a "future extension" comment is a textbook YAGNI violation. The interface should not exist until there is a concrete need for it. If `issueCommand` needs options, they can be added at that time.

**No new ExitCode additions (PASS)**

The decision to reuse existing `ExitCode.DEPENDENCY_ERROR` and `ExitCode.UNEXPECTED_ERROR` rather than adding command-specific codes is a good YAGNI application. The existing codes provide sufficient granularity.

**Minimal URL constants (PASS)**

Only the URLs actually needed by the feature are defined in `github-links.ts`. No speculative "we might need this" URL constants are included.

---

### DRY Principle

**GITHUB_REPO_BASE_URL centralization (PASS - Strong)**

This is the strongest design principle application in the proposal. Currently, GitHub URLs are scattered:

| Location | Current URL |
|----------|------------|
| `src/lib/version-checker.ts` line 33 | `https://github.com/Kewton/CommandMate/releases/` |
| `src/cli/config/security-messages.ts` line 26 | `https://github.com/Kewton/CommandMate/blob/main/docs/security-guide.md` |

The design introduces `GITHUB_REPO_BASE_URL` as the single source of truth, deriving all other URLs:

```typescript
export const GITHUB_REPO_BASE_URL = 'https://github.com/Kewton/CommandMate' as const;
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_BASE_URL}/issues` as const;
export const GITHUB_RELEASE_URL_PREFIX = `${GITHUB_REPO_BASE_URL}/releases/` as const;
export const GITHUB_SECURITY_GUIDE_URL = `${GITHUB_REPO_BASE_URL}/blob/main/docs/security-guide.md` as const;
```

The `as const` assertions ensure type narrowing to literal types.

**re-export backward compatibility (PASS)**

The plan to re-export `GITHUB_RELEASE_URL_PREFIX` from `version-checker.ts` maintains backward compatibility for existing consumers:

```typescript
// src/lib/version-checker.ts
export { GITHUB_RELEASE_URL_PREFIX } from '@/config/github-links';
```

**FeedbackSection shared component (PASS)**

Using `FeedbackSection` in both `InfoModal` and `MobileInfoContent` with `className` prop for style differences follows the established `VersionSection` pattern.

**Template name mapping (CONSIDER - C-003)**

The template reference format differs between CLI (`"Bug Report"` - front matter name) and UI (`bug_report.md` - filename). While the design documents this clearly, a shared mapping constant would further reduce divergence risk.

---

## Design Pattern Assessment

| Pattern | Usage | Assessment |
|---------|-------|------------|
| Component extraction (SRP) | FeedbackSection | Follows VersionSection precedent correctly |
| Data-driven config (OCP) | cli-dependencies.ts | Clean extension point, minor gap in getInstallHint |
| Whitelist validation | docs SECTION_MAP | Simple, secure, appropriate |
| Commander.js subcommands | issue create/search/list | Consistent with existing start/stop/status pattern |
| re-export for backward compat | version-checker.ts | Clean migration path |
| Constant centralization (DRY) | github-links.ts | Well-motivated, properly scoped |

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | `__dirname` path resolution fragile against restructuring | Low | Low | P3 |
| Technical | CLI build may fail if cross-boundary import is rejected | Low | Low | P3 |
| Security | None identified - all security patterns are sound | - | - | - |
| Operational | gh CLI not installed blocks issue command usage | Low | Medium | P3 |

---

## Improvement Recommendations

### Must Fix (1 item)

| ID | Principle | Issue | Recommendation |
|----|-----------|-------|----------------|
| MF-001 | YAGNI | Empty `IssueOptions` interface with "future extension" comment | Remove the interface entirely. Add it when a concrete need arises. |

### Should Fix (4 items)

| ID | Principle | Issue | Recommendation |
|----|-----------|-------|----------------|
| SF-001 | DRY | `compareVersions` logic exists in both version-checker.ts and preflight.ts | Note for future refactoring. Not blocking. |
| SF-002 | DRY | security-messages.ts must use imported constant, not hardcoded URL | Ensure implementation imports `GITHUB_SECURITY_GUIDE_URL` and uses template interpolation. |
| SF-003 | SRP | docs command mixes I/O, search, and presentation | Extract DocsReader utility for file resolution and search. |
| SF-004 | KISS | `path.join(__dirname, '../../../docs/')` is fragile | Consider resolving from package root instead. |

### Consider (3 items)

| ID | Principle | Issue | Recommendation |
|----|-----------|-------|----------------|
| C-001 | OCP | getInstallHint not co-located with dependency definitions | Add optional `installHint` to `DependencyCheck` interface. |
| C-002 | ISP | DocsOptions combines mutually exclusive fields | Consider discriminated union type for type-safe operation modes. |
| C-003 | DRY | Template name mapping in two formats (CLI/URL) | Consider shared TEMPLATE_CONFIG mapping. |

---

## Approval Status

**Conditionally Approved** - The design demonstrates strong understanding and application of SOLID, KISS, YAGNI, and DRY principles. The `GITHUB_REPO_BASE_URL` centralization and `FeedbackSection` component extraction are well-designed. One must-fix item (remove empty `IssueOptions` interface) should be addressed before implementation proceeds. The should-fix and consideration items are improvements that can be addressed during implementation or in follow-up work.

---

*Reviewed by: Architecture Review Agent (Stage 1 - Design Principles)*
*Generated: 2026-02-14*
