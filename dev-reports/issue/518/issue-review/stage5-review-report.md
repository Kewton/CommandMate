# Issue #518 Review Report - Stage 5: Normal Review (2nd Iteration)

**Date:** 2026-03-18
**Reviewer:** Issue Review Agent
**Focus:** Consistency & Correctness (2nd iteration)

---

## Previous Findings Status

All 22 findings from Stage 1 (F1-01 to F1-11) and Stage 3 (F3-01 to F3-11) have been **resolved**. The issue has been significantly improved with detailed sections on:
- Status derivation logic for `ls` command
- PromptData-conformant JSON output for `wait` exit 10
- Duration conversion table for `--duration` option
- WaitExitCode enum with non-conflicting value range (10+)
- Authentication token handling
- HTTP client utility (api-client.ts) design
- CLI import constraints (relative paths, no `@/*` alias)
- API field mappings and test strategy

---

## New Findings

### Must Fix (1)

#### F5-01: `isComplete` field interpretation conflicts with actual API implementation

**Location:** wait command > current-output API response field mapping table

The mapping table states that `isComplete === true` means "processing complete" with exit 0. However, in the actual `current-output/route.ts` implementation (line 124), `isComplete` is defined as:

```typescript
isComplete: isPromptWaiting,
```

This means `isComplete` is true when a **prompt is detected**, not when processing has finished normally. If the wait command treats `isComplete === true` as exit 0 (SUCCESS), it will incorrectly report success when a prompt is waiting, conflicting with the exit 10 (PROMPT_DETECTED) path.

**Recommendation:** Remove `isComplete` from the mapping table or clarify that it should NOT be used for completion detection. Normal completion should be determined solely by `isRunning === false` (session no longer active). The wait command's termination conditions should be:
1. `isPromptWaiting === true` -> exit 10 (when `--on-prompt agent`)
2. `isRunning === false` -> exit 0
3. Timeout exceeded -> exit 124

---

### Should Fix (5)

#### F5-02: `worktreeId` in exit 10 JSON is not part of PromptData type

The exit 10 JSON examples include a `worktreeId` field while claiming conformance to the `PromptData` type. The actual `PromptData` type (union of `YesNoPromptData | MultipleChoicePromptData`) does not include `worktreeId`. This is a documentation accuracy issue.

**Recommendation:** Define a CLI-specific output type (e.g., `{ worktreeId: string } & PromptData`) and document it explicitly as an extension of `PromptData`.

#### F5-03: Importing `auto-yes-config.ts` pulls in `safe-regex2` dependency

The issue recommends importing `ALLOWED_DURATIONS` from `../../config/auto-yes-config`, but that file has a top-level `import safeRegex from 'safe-regex2'`. This creates an implicit runtime dependency for CLI builds.

**Recommendation:** Split `ALLOWED_DURATIONS` and `isAllowedDuration` into a separate file without the `safe-regex2` dependency, or document the dependency requirement.

#### F5-04: GET /api/worktrees response wrapper structure undocumented

The `ls` command section does not mention that the API response is wrapped as `{ worktrees: [...], repositories: [...] }`. Implementers need to know to access `response.worktrees`.

**Recommendation:** Add response structure to the `ls` internal implementation section.

#### F5-05: `send` command API request body format undocumented

The `send` command does not specify the POST request body format (`{ content: string, cliToolId?: CLIToolType }`).

**Recommendation:** Document the request body schema and how CLI options map to request fields.

#### F5-06: `respond` command API request body format undocumented

The `respond` command does not document the POST request body for `prompt-response` API. The API accepts `{ answer, cliTool?, promptType?, defaultOptionNumber? }`, and the flow for passing `promptType`/`defaultOptionNumber` from wait output to respond is not described.

**Recommendation:** Document the request body and the data flow from `wait` exit 10 output to `respond` input.

---

### Nice to Have (2)

#### F5-07: `capture --json` output fields undefined

The capture command supports `--json` but does not define which fields from the current-output API response are included.

#### F5-08: `auto-yes` command `--stop-pattern` support unclear

The `--stop-pattern` option is documented on `send --auto-yes` but not on the standalone `auto-yes --enable` command.

---

## Summary

| Severity | Count |
|----------|-------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 2 |
| **Total** | **8** |

The issue quality has improved substantially from the 1st iteration (11 findings reduced to 8, with only 1 must_fix). The critical finding (F5-01) regarding `isComplete` semantics could lead to incorrect wait command behavior and should be addressed before implementation. The should_fix items are primarily about documenting API request/response formats that implementers will need.
