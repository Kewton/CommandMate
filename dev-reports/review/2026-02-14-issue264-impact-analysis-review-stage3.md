# Architecture Review: Issue #264 - Impact Analysis (Stage 3)

| Item | Detail |
|------|--------|
| **Issue** | #264 |
| **Focus** | 影響範囲 (Impact Scope) |
| **Stage** | 3 - 影響分析レビュー |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |
| **Date** | 2026-02-14 |
| **Reviewer** | Architecture Review Agent |

---

## Executive Summary

Issue #264 is a multi-scope feature that adds feedback/issue management links to the UI, introduces `commandmate issue` and `commandmate docs` CLI commands, and consolidates scattered GitHub URLs into a single configuration file. The change spans 7 new files and 14 modified files across 6 distinct layers (presentation, config, CLI commands, CLI utils, i18n, and documentation).

The overall impact risk is **low**. The design makes effective use of existing extension points (OCP for cli-dependencies, VersionSection component pattern for FeedbackSection, commander.js subcommand pattern). Backward compatibility is well-preserved through re-exports and optional dependency flags. One must-fix item concerns build verification for cross-boundary TypeScript imports.

---

## Impact Scope Analysis

### Direct Changes

| Category | File | Change Description | Risk |
|---------|------|--------------------|------|
| New Config | `src/config/github-links.ts` | GitHub URL constants centralization (GITHUB_REPO_BASE_URL and derived URLs) | Low |
| New UI Component | `src/components/worktree/FeedbackSection.tsx` | Feedback links (bug report, feature request, question, issues list) | Low |
| New CLI Command | `src/cli/commands/issue.ts` | `commandmate issue create/search/list` via gh CLI | Low |
| New CLI Command | `src/cli/commands/docs.ts` | `commandmate docs --section/--search/--all` | Low |
| New CLI Utility | `src/cli/utils/docs-reader.ts` | Section map, path resolution, file read, search logic | Low |
| New CLI Config | `src/cli/config/ai-integration-messages.ts` | AI tool integration guide message | Low |
| New Documentation | `docs/user-guide/support-and-feedback.md` | Support guide document | Low |

### Modified Files

| Category | File | Change Description | Risk |
|---------|------|--------------------|------|
| UI Integration | `src/components/worktree/WorktreeDetailRefactored.tsx` | Add FeedbackSection import and render in InfoModal (line ~509) and MobileInfoContent (line ~774) | Low |
| URL Re-export | `src/lib/version-checker.ts` | Change `GITHUB_RELEASE_URL_PREFIX` from direct definition to re-export from `github-links.ts` | Medium |
| Security URL | `src/cli/config/security-messages.ts` | Replace hardcoded Security Guide URL with import from `github-links.ts` using template literal | Medium |
| Dependency Config | `src/cli/config/cli-dependencies.ts` | Add gh CLI entry (`{ name: 'gh CLI', command: 'gh', required: false }`) | Low |
| Install Hints | `src/cli/utils/preflight.ts` | Add gh CLI installation hint to `getInstallHint()` | Low |
| CLI Entry | `src/cli/index.ts` | Register issue/docs commands via `program.addCommand()`, add AI integration help text | Low |
| CLI Types | `src/cli/types/index.ts` | Add `IssueCreateOptions` and `DocsOptions` interfaces | Low |
| Init Command | `src/cli/commands/init.ts` | Display AI integration guide after init completion | Low |
| i18n (English) | `locales/en/worktree.json` | Add `feedback.*` translation keys | Low |
| i18n (Japanese) | `locales/ja/worktree.json` | Add `feedback.*` translation keys | Low |
| Package Config | `package.json` | Add `docs/` to `files` field | Low |
| CLI Setup Docs | `docs/user-guide/cli-setup-guide.md` | Add issue/docs command documentation | Low |
| Commands Guide | `docs/user-guide/commands-guide.md` | Add reference link to cli-setup-guide.md | Low |
| Project Guide | `CLAUDE.md` | Add new module information entries | Low |

### Test Files

| Category | File | Change Description | Risk |
|---------|------|--------------------|------|
| New Test | `tests/unit/config/github-links.test.ts` | URL constant correctness and derivation verification | Low |
| New Test | `tests/unit/components/worktree/feedback-section.test.tsx` | Link rendering, URL correctness, rel attributes, i18n keys | Low |
| New Test | `tests/unit/cli/commands/issue.test.ts` | gh CLI mock, template name arguments, error handling | Low |
| New Test | `tests/unit/cli/commands/docs.test.ts` | DocsReader delegation verification | Low |
| New Test | `tests/unit/cli/utils/docs-reader.test.ts` | Section validation, file read, search, path traversal prevention | Low |
| Updated Test | `tests/unit/cli/config/cli-dependencies.test.ts` | Add gh CLI entry verification to optional dependencies test | Low |

---

## Indirect Impact Analysis

### 1. Build Process Impact

**tsconfig.cli.json cross-boundary import (Medium Risk)**

The `security-messages.ts` -> `../../config/github-links` import crosses the `tsconfig.cli.json` include boundary (`src/cli/**/*`). While the precedent `port-allocator.ts` -> `../../lib/errors` confirms this pattern works with `rootDir: './src'`, this is a new file being created and imported. If the TypeScript compiler does not resolve the file correctly during `build:cli`, it would block the entire CLI build.

The design correctly documents a fallback strategy (Section 6-2: placing CLI-specific constants in `src/cli/config/github-links.ts`), but this should be treated as a build gate during implementation.

**package.json files field expansion (Low Risk)**

Adding `docs/` to the `files` field means the entire docs directory will be included in the npm package. The current `docs/user-guide/` directory contains 6 markdown files plus `cli-setup-guide.md`. This is manageable, but any future addition of large assets (screenshots, PDFs) to docs/ would inflate the package size. The design correctly identifies this as necessary for offline `commandmate docs` operation.

### 2. Backward Compatibility

**version-checker.ts re-export (Low Risk)**

`GITHUB_RELEASE_URL_PREFIX` is currently exported from `version-checker.ts` (line 33) and used only internally within the same file (line 141 in `validateReleaseUrl()`). No external consumer imports this constant directly. The re-export pattern will maintain the same import path for any future consumer while the actual definition moves to `github-links.ts`. The `GITHUB_API_URL` constant remains hardcoded in `version-checker.ts` per SEC-001, so the security-critical URL is unaffected.

**security-messages.ts template literal change (Low Risk)**

The current hardcoded URL string in `REVERSE_PROXY_WARNING` (line 26) will be replaced with an imported constant embedded via template literal. The resulting string output is identical. Consumers (`init.ts`, `start.ts`, `daemon.ts`) import `REVERSE_PROXY_WARNING` as a string constant and are unaffected by the implementation change.

**gh CLI as optional dependency (No Risk)**

Adding `{ name: 'gh CLI', command: 'gh', required: false }` to DEPENDENCIES array is a pure addition. The `PreflightChecker.checkAll()` method iterates all dependencies but only blocks on `required: true` entries. The `preflight.success` result is unaffected by optional dependency failures. The init command will display gh CLI status but will not prevent initialization if gh is missing.

### 3. Runtime Impact

**FeedbackSection in WorktreeDetailRefactored.tsx (Low Risk)**

FeedbackSection renders static links with no API calls, state management, or side effects. It will be added to InfoModal (desktop, line ~509) and MobileInfoContent (mobile, line ~774). Both are scroll containers (`max-h-[70vh] overflow-y-auto` for InfoModal, `overflow-y-auto h-full` for MobileInfoContent). Adding a new section increases scroll height slightly but has no performance impact.

The component follows the established VersionSection pattern:
- Accepts `className?: string` prop for parent style absorption
- Uses `useTranslations('worktree')` for i18n
- No data fetching or async operations

**CLI command registration (Low Risk)**

Adding two `program.addCommand()` calls to `src/cli/index.ts` has negligible impact. The commander.js parser only executes the matched command handler, so registering additional commands does not affect the execution path of existing commands (init/start/stop/status).

### 4. Test Coverage Assessment

**Existing test safety nets:**

| Safety Net | Coverage |
|-----------|----------|
| `i18n-translation-keys.test.ts` | Automatically detects missing/mismatched translation keys between en/ja |
| `cli-dependencies.test.ts` | Verifies dependency array structure (needs update for gh CLI) |
| `npm run lint` | ESLint catches unused imports, type errors |
| `npx tsc --noEmit` | Full type checking across all source files |
| `npm run build:cli` | CLI compilation verification |

**Test gaps identified:**

1. The existing `cli-dependencies.test.ts` tests `getOptionalDependencies()` for 'Claude CLI' inclusion but does not verify the total count of optional dependencies. After adding gh CLI, the test will pass without explicitly verifying gh CLI's presence.

2. No existing test verifies `PreflightChecker.getInstallHint()` return values. The gh CLI hint addition cannot be regression-tested automatically unless a new test is added.

3. The design specifies 5 new test files and 1 updated test file, which is proportionate to the 7 new files and 14 modified files. The test-to-change ratio is adequate.

---

## Risk Assessment

| Risk Category | Level | Rationale |
|--------------|-------|-----------|
| Technical Risk | Low | All changes follow established patterns (VersionSection, OCP dependencies, commander subcommands). Cross-boundary import is the only medium-concern item, with documented fallback. |
| Security Risk | Low | GITHUB_API_URL remains hardcoded (SEC-001). External links use rel="noopener noreferrer". CLI uses execFile with array args. docs command uses whitelist pattern. |
| Operational Risk | Low | gh CLI is optional, docs/ offline mode is self-contained. No database schema changes, no API endpoint changes, no deployment configuration changes. |

---

## Findings Detail

### Must Fix (1 item)

#### MF-IMP-001: tsconfig.cli.json cross-boundary import verification

**Category**: Build Process
**Risk**: Medium

The `src/cli/config/security-messages.ts` -> `../../config/github-links` import path crosses the `tsconfig.cli.json` include boundary. While Section 6-2 (C-CONS-002) documents the technical rationale (`rootDir: './src'` makes files outside `include` resolvable), and port-allocator.ts provides a working precedent, this is a new file creation scenario.

**Recommendation**: Add an explicit step to the implementation checklist requiring `npm run build:cli` verification immediately after creating `src/config/github-links.ts` and modifying `security-messages.ts`. If the build fails, immediately execute the fallback strategy (duplicate constants to `src/cli/config/github-links.ts`).

**Affected files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/config/github-links.ts` (new)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/config/security-messages.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tsconfig.cli.json`

### Should Fix (5 items)

#### SF-IMP-001: version-checker.ts re-export test impact verification

The re-export of `GITHUB_RELEASE_URL_PREFIX` from `version-checker.ts` should be accompanied by verification that no existing test mocks or directly references this constant from its original location. While current analysis shows no external import of this constant, test files may use `vi.mock()` patterns that need to account for the re-export chain.

**Affected files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/lib/version-checker.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/config/github-links.ts` (new)

#### SF-IMP-002: package.json files field docs/ inclusion scope

Adding `docs/` to the `files` field includes the entire docs directory in the npm package. Currently `docs/user-guide/` contains 6 files plus `docs/architecture.md` and `README.md`. Ensure that dev-only files (design documents, review reports) are not placed under `docs/`. Consider using `.npmignore` or a more specific glob (e.g., `docs/user-guide/`, `docs/architecture.md`, `README.md`) if docs/ grows.

**Affected files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/package.json`

#### SF-IMP-003: cli-dependencies.test.ts explicit gh CLI verification

The existing test at `tests/unit/cli/config/cli-dependencies.test.ts` line 83-87 checks that `getOptionalDependencies()` includes 'Claude CLI' but does not verify the exact set. After adding gh CLI, an explicit test case should be added:

```typescript
it('should include gh CLI as optional', () => {
  const optional = getOptionalDependencies();
  const ghCli = optional.find(d => d.name === 'gh CLI');
  expect(ghCli).toBeDefined();
  expect(ghCli?.command).toBe('gh');
  expect(ghCli?.required).toBe(false);
});
```

**Affected files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tests/unit/cli/config/cli-dependencies.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/config/cli-dependencies.ts`

#### SF-IMP-004: preflight.ts getInstallHint() gh CLI hint specification

The design mentions updating `preflight.ts` with a gh CLI install hint (Section 9-2) but does not specify the hint text. The current `getInstallHint()` method (line 135-145) uses a Record with dependency name keys. A suggested hint:

```
'gh CLI': 'Install with: brew install gh (macOS) or see https://cli.github.com/'
```

**Affected files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/utils/preflight.ts`

#### SF-IMP-005: i18n mock strategy for FeedbackSection tests

The `feedback-section.test.tsx` will need to mock `useTranslations('worktree')`. The design should reference the existing mock pattern used by `version-section.test.tsx` or `update-notification-banner.test.tsx` to ensure consistency and correct key resolution. This is a test implementation detail but affects the reliability of the test suite.

**Affected files**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/locales/en/worktree.json`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/locales/ja/worktree.json`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tests/integration/i18n-translation-keys.test.ts`

### Consider (3 items)

#### C-IMP-001: WorktreeDetailRefactored.tsx file size

`WorktreeDetailRefactored.tsx` is 2081 lines, containing DesktopHeader, InfoModal, MobileInfoContent, MobileContent, and the main component all in one file. Adding FeedbackSection increases it slightly. Future extraction of InfoModal and MobileInfoContent into separate files would improve maintainability.

#### C-IMP-002: CLI command registration pattern coexistence

After Issue #264, `src/cli/index.ts` will have two registration patterns: inline `program.command().action()` (4 commands) and `program.addCommand(factory())` (2 commands). This is technically justified (MF-CONS-001) but may be confusing for new contributors.

#### C-IMP-003: SECTION_MAP and docs/ file synchronization

The SECTION_MAP in `docs-reader.ts` is a hardcoded mapping. Adding, renaming, or removing documentation files requires updating this map. Consider adding a CI check or documentation note to remind developers of this coupling.

---

## Dependency Graph (Change Propagation)

```
github-links.ts (NEW)
  |-- re-exported by --> version-checker.ts
  |     |-- consumed by --> route.ts (update-check API)
  |-- imported by --> security-messages.ts
  |     |-- consumed by --> init.ts, start.ts, daemon.ts
  |-- imported by --> FeedbackSection.tsx (NEW)
  |     |-- rendered in --> WorktreeDetailRefactored.tsx (InfoModal + MobileInfoContent)

cli-dependencies.ts (UPDATED: +gh CLI entry)
  |-- consumed by --> preflight.ts (checkAll)
  |     |-- consumed by --> init.ts (preflight check)

issue.ts (NEW) + docs.ts (NEW)
  |-- registered in --> cli/index.ts (addCommand)
  |-- docs.ts delegates to --> docs-reader.ts (NEW)

ai-integration-messages.ts (NEW)
  |-- consumed by --> init.ts (post-init guide)
  |-- consumed by --> cli/index.ts (addHelpText)

locales/en/worktree.json + locales/ja/worktree.json (UPDATED)
  |-- consumed by --> FeedbackSection.tsx (useTranslations)
  |-- validated by --> i18n-translation-keys.test.ts (parity check)
```

---

## Approval Status

**Conditionally Approved (4/5)**

The impact analysis reveals a well-designed, low-risk change set with strong backward compatibility preservation. The one must-fix item (MF-IMP-001: build verification for cross-boundary import) requires implementation-stage validation but has a documented fallback strategy. All five should-fix items are minor specification gaps that can be addressed during implementation without design changes.

| Item Count | Category |
|-----------|----------|
| 1 | Must Fix |
| 5 | Should Fix |
| 3 | Consider |

---

*Generated by Architecture Review Agent (Stage 3: Impact Analysis) at 2026-02-14*
