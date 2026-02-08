# Issue #4 Review Report - Stage 1 (Consistency & Correctness)

**Issue**: codex対応
**Reviewed**: 2026-02-04
**Reviewer**: issue-review-agent
**Focus Area**: 通常 (Consistency & Correctness)

---

## Executive Summary

Issue #4 aims to add Codex CLI support to CommandMate. However, the technical scope contains significant inaccuracies regarding the current codebase state. The existing `src/lib/cli-tools/codex.ts` is not "old code to be deleted" but rather a valid implementation following the established Strategy pattern. Additionally, the availability of OpenAI's Codex CLI itself needs verification as it may have been deprecated.

---

## Findings

### Must Fix (Critical Issues)

#### MF-001: Incorrect Deletion Scope
**Description**: The technical scope incorrectly identifies `src/lib/cli-tools/codex.ts` as "old code to be deleted." This file is actually a current, valid implementation following the Strategy pattern (`BaseCLITool` inheritance). Similarly, the CODEX_* patterns in `src/lib/cli-patterns.ts` are part of the current architecture.

**Evidence**:
- `src/lib/cli-tools/codex.ts` extends `BaseCLITool` and implements `ICLITool` interface
- The file follows the same pattern as `claude.ts` and `gemini.ts`
- `CLIToolManager` already registers CodexTool at line 27

**Recommendation**: Revise the technical scope:
- Change "Delete and re-implement" to "Review and enhance existing codex.ts implementation"
- Clarify that `codex.ts` already provides basic session management functionality

---

#### MF-002: Codex CLI Availability Not Verified
**Description**: OpenAI's original Codex CLI has reached End of Life (EOL). The acceptance criteria assume Codex CLI is available and installable, but this may not be the case.

**Evidence**:
- OpenAI Codex API was deprecated in March 2023
- Current OpenAI tools are based on ChatGPT/GPT-4

**Recommendation**:
1. Investigate the current status of Codex CLI (availability, installation method, authentication)
2. If Codex CLI is unavailable, consider alternatives:
   - OpenAI's official CLI tool
   - `aider` (AI pair programming tool supporting OpenAI)
   - Close this issue and create a new one for a different CLI tool
3. Update the Issue description with findings

---

### Should Fix (Important Issues)

#### SF-001: UI Tab Status Mismatch
**Description**: The technical scope states "UI Codex tab code (temporarily hidden or deleted)" but the actual codebase shows Codex tabs are already restricted.

**Evidence** (`src/components/worktree/WorktreeDetail.tsx`):
```typescript
// Line 30-31
// Check if tab is a CLI tab (only Claude after Issue #33)
const isCliTab = (tab: TabView): tab is 'claude' => tab === 'claude';
```

**Recommendation**: Update the technical scope to "Add Codex tab to UI (extend isCliTab function)" instead of "hide or delete."

---

#### SF-002: Session Management Architecture Unclear
**Description**: Claude has a dedicated session module (`claude-session.ts`) while Codex implementation is directly in `codex.ts`. The Issue does not clarify which approach to take.

**Current Architecture**:
- Claude: `claude-session.ts` (dedicated module) + `cli-tools/claude.ts` (wrapper)
- Codex: `cli-tools/codex.ts` (self-contained)
- Gemini: `cli-tools/gemini.ts` (self-contained)

**Recommendation**: Clarify in the technical scope whether to:
1. Maintain current pattern (self-contained in `codex.ts`) - Recommended
2. Create dedicated `codex-session.ts` module similar to Claude

---

#### SF-003: Prompt Detection Validation Missing
**Description**: The acceptance criteria does not include verification of prompt detection patterns.

**Current Patterns** (`src/lib/cli-patterns.ts`):
```typescript
export const CODEX_THINKING_PATTERN = /•\s*(Planning|Searching|Exploring|Running|Thinking|Working|Reading|Writing|Analyzing)/m;
export const CODEX_PROMPT_PATTERN = /^›\s+.+/m;
export const CODEX_SEPARATOR_PATTERN = /^─.*Worked for.*─+$/m;
```

**Recommendation**: Add acceptance criteria:
- "Codex prompt detection patterns accurately match actual CLI output"
- "Codex status detection (thinking/ready/waiting) works correctly"

---

### Nice to Have (Suggestions)

#### NTH-001: Auto-Yes Feature Compatibility
The Issue does not mention Auto-Yes feature (Issue #138) compatibility for Codex. Consider adding this as Phase 2 scope.

#### NTH-002: Security Considerations Missing
No security requirements are documented. Consider adding:
- OpenAI API key handling
- tmux session isolation

#### NTH-003: Test Requirements Missing
No test requirements are specified. Consider adding:
- Unit tests for `codex.ts` (Vitest)
- Integration tests for Codex session management
- E2E tests for Codex tab interaction

---

## Current Codex Implementation Analysis

### Files Involved

| File | Status | Description |
|------|--------|-------------|
| `src/lib/cli-tools/codex.ts` | Existing | Full implementation of CodexTool class |
| `src/lib/cli-tools/types.ts` | Existing | Includes 'codex' in CLIToolType |
| `src/lib/cli-tools/manager.ts` | Existing | Registers CodexTool |
| `src/lib/cli-patterns.ts` | Existing | Contains CODEX_* patterns |
| `src/components/worktree/WorktreeDetail.tsx` | Needs Update | Restricts to Claude only |
| `src/components/worktree/MessageList.tsx` | Existing | Supports 'codex' case |
| `src/components/worktree/LogViewer.tsx` | Existing | Supports 'codex' filter |

### Existing Functionality in codex.ts

1. Session management via tmux (start, stop, check running)
2. Message sending functionality
3. Auto-skip update notification handling
4. Graceful shutdown with Ctrl+D
5. Interrupt support (inherited from BaseCLITool)

---

## Recommended Revised Technical Scope

### Phase 1: Core Functionality
1. Verify Codex CLI availability and installation
2. Test existing `codex.ts` implementation with actual Codex CLI
3. Update prompt detection patterns if needed
4. Enable Codex tab in UI (`WorktreeDetail.tsx`)
5. Add unit tests for `codex.ts`

### Phase 2: Enhancement (Optional)
1. Auto-Yes feature support for Codex
2. Improved error handling and user feedback
3. Documentation update

---

## Conclusion

Before proceeding with implementation, the following actions are recommended:

1. **Immediate**: Verify Codex CLI availability
2. **Required**: Correct the technical scope regarding deletion targets
3. **Required**: Add prompt detection validation to acceptance criteria
4. **Suggested**: Add test requirements

The existing codebase already has substantial Codex support through the Strategy pattern. The main work will be verification, testing, and UI enablement rather than deletion and re-implementation.
