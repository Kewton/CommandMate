# Impact Analysis Review - Issue #559: Copilot CLI Slash Command Fix

**Stage**: 3 (影響分析レビュー)
**Date**: 2026-03-27
**Target**: dev-reports/design/issue-559-copilot-slash-cmd-fix-design-policy.md
**Focus**: 影響範囲 (Impact Scope Analysis)

---

## 1. Review Summary

The design document proposes a single-file change to `src/app/api/worktrees/[id]/terminal/route.ts` that delegates all Copilot commands to `cliTool.sendMessage()` instead of calling `sendKeys()` directly. The impact analysis in the design document is largely accurate but has notable gaps.

**Verdict**: Conditional approval -- 1 must_fix and 1 should_fix item require resolution before implementation.

---

## 2. Findings

### IA3-001 [must_fix] - Test mock missing sendMessage method

The existing test mock for `CLIToolManager.getTool()` at `tests/unit/terminal-route.test.ts` L17-20 returns an object with only `getSessionName()`. After the change, the copilot path calls `cliTool.sendMessage()`, but the mock does not provide this method. The design document mentions CR2-003 (adding `copilot` to the `isCliToolType` mock) but does not address the `getTool` mock needing `sendMessage`.

**Recommendation**: Add `sendMessage: vi.fn()` to the mock's `getTool` return value and include this in the implementation checklist.

---

### IA3-002 [should_fix] - respond/route.ts has the same sendKeys-without-waitForPrompt pattern

The respond route (`src/app/api/worktrees/[id]/respond/route.ts` L150-159) sends answers to Copilot prompts via `sendKeys()` directly, without `waitForPrompt()`. This route is not mentioned in the design document's impact analysis (section 4). While the risk is lower because prompt responses are sent when Copilot is already in prompt state, this should be documented as a known limitation.

**Recommendation**: Add `respond/route.ts` to section 4 ("Impact: None -- prompt responses are sent when Copilot is at prompt state").

---

### IA3-003 [nice_to_have] - No frontend caller identified for terminal HTTP API route

The design document's architecture diagram shows `[UI] Terminal direct input -> /api/worktrees/:id/terminal`, but code analysis reveals:

- `MessageInput` component sends messages via `/api/worktrees/:id/send` route (which already calls `cliTool.sendMessage()`)
- `Terminal` component (xterm.js) sends input via WebSocket `terminal_input` -> `ws-server.ts` `handleTerminalInput` -> control mode tmux transport (completely separate path)
- `NavigationButtons` uses `/api/worktrees/:id/special-keys` route
- No component in `src/components/` calls the terminal HTTP API route via fetch
- The frontend `api-client.ts` has no terminal-related methods

It is unclear which actual UI path triggers the terminal HTTP API for Copilot commands. If no current caller sends Copilot commands through this route, the fix may not address the user-facing bug.

**Recommendation**: Clarify the actual caller in the design document.

---

### IA3-004 [should_fix] - Double session existence check creates inconsistent error behavior

The terminal route checks `hasSession()` at L73-79 (returns 404). Then `sendMessage()` checks `hasSession()` again at copilot.ts L245-249 (throws Error, caught by route as 500). If the session dies between the two checks, the user receives a 500 error instead of the more informative 404.

**Recommendation**: Document this as a known behavior. The practical impact is minimal.

---

### IA3-005 [nice_to_have] - Frontend HTTP timeout is not a concern

The frontend `api-client.ts` uses native `fetch` with no explicit timeout or `AbortController`. Browser defaults (typically 300 seconds) far exceed the 15-second `waitForPrompt` timeout. The design document's note in section 10 to verify frontend timeout is satisfied.

---

### IA3-006 [nice_to_have] - WebSocket terminal_input path bypasses the fix

The `Terminal` component's direct keyboard input goes through WebSocket -> `ws-server.ts` `handleTerminalInput` -> `ControlModeTmuxTransport.sendInput()`. This is a completely separate code path. Copilot commands typed directly in the xterm.js terminal widget will not benefit from the `sendMessage` delegation fix.

**Recommendation**: Document as a known limitation. This is acceptable because the WebSocket path is raw character-by-character I/O where Copilot would already be at a prompt.

---

### IA3-007 [nice_to_have] - invalidateCache handling is correct

The existing `invalidateCache()` call at L85 of terminal/route.ts remains in the else-path (non-copilot tools). For the copilot path, `sendMessage()` handles cache invalidation internally. No double-call issue exists because the proposed code does an early return before L85.

---

## 3. Impact Verification Matrix

| File | Design Doc Claim | Verified | Notes |
|------|-----------------|----------|-------|
| `terminal/route.ts` | Changed (copilot delegation) | Yes | Single file change is correct |
| `copilot.ts` | No change needed | Yes | `sendMessage()` handles both slash commands and regular text |
| `session-key-sender.ts` | No impact | Yes | Only used by `ClaudeTool.sendMessage()` |
| `special-keys/route.ts` | No impact | Yes | Handles special keys, not text commands |
| `cli-patterns.ts` | No impact | Yes | Pattern definitions consumed by copilot.ts internally |
| Other CLI tools | No impact | Yes | `cliToolId === 'copilot'` guard ensures zero impact |
| `respond/route.ts` | **Not mentioned** | N/A | Uses sendKeys directly for Copilot (IA3-002) |
| `ws-server.ts` | **Not mentioned** | N/A | Separate WebSocket path bypasses fix (IA3-006) |

## 4. Hidden Dependencies

1. **respond/route.ts**: Also sends commands to Copilot via `sendKeys` without `waitForPrompt`. Not in the design doc's impact analysis.
2. **ws-server.ts handleTerminalInput**: Completely separate code path for terminal input via WebSocket. Fix does not apply here.
3. **No frontend HTTP caller found**: The terminal HTTP API route may not be the actual entry point for the user-facing bug.

## 5. Regression Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Non-copilot tools affected | Very Low | High | `cliToolId === 'copilot'` guard |
| Error response format change | Low | Low | Same catch block produces same fixed-string 500 |
| 15-second blocking on normal text | Low | Medium | Only if Copilot not at prompt state |
| Double hasSession race condition | Very Low | Low | Produces 500 instead of 404 |

**Overall regression risk**: Low

## 6. Edge Case Analysis

| Edge Case | Handled | Details |
|-----------|---------|---------|
| sendMessage calls sendKeys with different sendEnter args | Yes | Design doc addresses this in CR2-005 |
| Session dies between route check and sendMessage check | Partially | Returns 500 instead of 404 (IA3-004) |
| Empty command | Yes | Route validates non-empty at L44 before delegation |
| Command with newlines | Improved | sendMessage handles `detectAndResendIfPastedText`, which current sendKeys path does not |
| Command exceeding MAX_COMMAND_LENGTH | Yes | Route validates at L50 before delegation |

---

## 7. Conclusion

The design document's impact analysis is mostly accurate. The single-file change is well-scoped and the `cliToolId === 'copilot'` guard effectively isolates the change. Two items require attention before implementation:

1. **IA3-001 (must_fix)**: The test mock needs `sendMessage` on the `getTool` return value
2. **IA3-003 (should_fix)**: Clarify which actual caller triggers the terminal HTTP API for Copilot commands -- this is important to ensure the fix addresses the real user-facing issue

---

*Reviewed by: architecture-review-agent*
*Review date: 2026-03-27*
