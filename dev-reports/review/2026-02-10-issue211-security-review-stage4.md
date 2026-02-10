# Architecture Review Report: Issue #211 - Security Review (Stage 4)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #211 - History Message Copy Button |
| Focus | Security (OWASP Top 10 Compliance) |
| Stage | 4 (Security Review) |
| Status | **Conditionally Approved** |
| Score | **4/5** |
| Must Fix | 0 items |
| Should Fix | 3 items |
| Consider | 4 items |

The design for Issue #211 demonstrates a **strong security posture** for a client-side clipboard copy feature. The architecture avoids common security pitfalls by:

1. Using `navigator.clipboard.writeText()` (plain text only, no HTML injection risk)
2. Applying `stripAnsi()` sanitization before writing to clipboard
3. Relying on React's auto-escaping for UI rendering (no new `dangerouslySetInnerHTML` usage)
4. Centralizing clipboard operations in a single utility file (`clipboard-utils.ts`)
5. Keeping the feature entirely client-side (no new server-side attack surface)

No critical security vulnerabilities were identified. Three low-severity recommendations are provided for defense-in-depth improvements.

---

## OWASP Top 10 Checklist

### A01:2021 - Broken Access Control

**Status**: PASS

The copy operation is purely client-side. It reads from existing `ChatMessage.content` objects already available in the React component tree and writes to the browser's Clipboard API. No server-side resources are accessed, no authorization checks are bypassed, and no new API endpoints are introduced.

There is no CSRF risk because the operation does not modify any server-side state.

### A02:2021 - Cryptographic Failures

**Status**: NOT APPLICABLE

No cryptographic operations are involved. Clipboard content is stored in the browser's clipboard as plain text, following standard browser behavior. No encryption or hashing is performed or required.

### A03:2021 - Injection

**Status**: PASS

This is the most relevant OWASP category for this feature. Analysis:

**XSS Prevention**:
- The `ConversationPairCard` component renders `message.content` through React JSX using `{part.content}` inside `<span>` and `<button>` elements. React auto-escapes all content, preventing XSS.
- The new copy functionality passes content to `navigator.clipboard.writeText()`, which only accepts plain text. There is **no path** for HTML/script injection through the clipboard write operation.
- The existing `MessageList.tsx` (which uses `dangerouslySetInnerHTML`) is explicitly **out of Phase 1 scope** (SF-2 in Stage 1 review), and the Phase 2 separate Issue will require its own security review.

**ANSI Code Stripping**:
- `stripAnsi()` in `cli-patterns.ts` removes ANSI escape codes before writing to clipboard. This prevents garbled terminal formatting from appearing in pasted content.
- Known limitation (SEC-002): Some rare ANSI sequences (8-bit CSI, DEC private modes, character set switching) are not fully covered. However, since `writeText()` only writes plain text, residual ANSI sequences pose a **data quality issue**, not a security vulnerability.

**No SQL/Command Injection**:
- No database queries or shell commands are executed as part of the copy operation.

### A04:2021 - Insecure Design

**Status**: PASS

The design follows defense-in-depth principles:
- **Single entry point**: All clipboard operations go through `clipboard-utils.ts` (MF-1 DRY principle), making it easy to audit and update sanitization logic.
- **Optional props**: Backward compatibility is maintained through optional props (`onCopy?`, `showToast?`), ensuring existing code paths remain unaffected.
- **Separation of concerns**: Clipboard logic (`clipboard-utils.ts`), UI presentation (`ConversationPairCard`), and orchestration (`HistoryPane` callback composition) are clearly separated.

### A05:2021 - Security Misconfiguration

**Status**: PASS

**Content Security Policy**:
The existing CSP in `next.config.js` (lines 54-63) does not restrict Clipboard API usage:
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval';
  ...
  frame-ancestors 'none';
```

The `Permissions-Policy` header restricts `camera=(), microphone=(), geolocation=()` but does not restrict `clipboard-write`, which is correct for this feature.

**Security Headers**:
- `X-Frame-Options: DENY` -- Prevents clickjacking (unchanged)
- `X-Content-Type-Options: nosniff` -- Prevents MIME sniffing (unchanged)
- `X-XSS-Protection: 1; mode=block` -- Browser XSS filter (unchanged)

No CSP or security header changes are required for this feature.

### A06:2021 - Vulnerable and Outdated Components

**Status**: PASS

No new npm dependencies are introduced. The feature uses:
- `navigator.clipboard.writeText()` -- Browser standard API
- `stripAnsi()` -- Existing function in `cli-patterns.ts`
- `lucide-react` `Copy` icon -- From the existing dependency (no version change)
- `useToast` -- Existing hook from `Toast.tsx`

### A07:2021 - Identification and Authentication Failures

**Status**: NOT APPLICABLE

CommandMate is a local development tool running on localhost. The copy functionality does not involve authentication or session management.

### A08:2021 - Software and Data Integrity Failures

**Status**: PASS

No serialization or deserialization of untrusted data occurs. The `ChatMessage.content` string is read from existing React state, processed through `stripAnsi()`, and written as plain text to the clipboard. There is no deserialization of clipboard data, no eval(), and no dynamic code execution.

### A09:2021 - Security Logging and Monitoring Failures

**Status**: PASS (with note)

The error handling design specifies:
```typescript
catch (error) {
  if (showToast) {
    showToast('コピーに失敗しました', 'error');
  } else {
    console.warn('Clipboard copy failed:', error);
  }
}
```

- The Toast message is appropriately generic (no sensitive data exposed to UI).
- The `console.warn` logs only the error object, not the message content being copied. This is appropriate for a localhost tool. See SF-S4-3 for a recommendation to add a comment making this intentional.

### A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: NOT APPLICABLE

No server-side requests are involved. The copy operation is entirely client-side.

---

## Detailed Findings

### Should Fix

#### SF-S4-1: Input validation in copyToClipboard

| Attribute | Value |
|-----------|-------|
| Severity | Low |
| OWASP | A03:2021 Injection (input validation) |
| File | `src/lib/clipboard-utils.ts` (new) |

**Issue**: The design specifies `copyToClipboard(text: string)` with no runtime input validation. While TypeScript provides compile-time type safety, runtime data from tmux capture could theoretically yield unexpected values (empty strings, strings that become empty after `stripAnsi` processing).

**Recommendation**: Add a defensive guard for empty or whitespace-only content:

```typescript
export async function copyToClipboard(text: string): Promise<void> {
  const cleanText = stripAnsi(text);
  if (!cleanText.trim()) return; // or throw a descriptive error
  await navigator.clipboard.writeText(cleanText);
}
```

This is a defense-in-depth measure rather than a critical vulnerability fix.

---

#### SF-S4-2: stripAnsi known limitations (SEC-002) documentation in clipboard-utils.ts

| Attribute | Value |
|-----------|-------|
| Severity | Low |
| OWASP | A03:2021 Injection (output encoding) |
| File | `src/lib/clipboard-utils.ts` (new), `src/lib/cli-patterns.ts` (existing) |

**Issue**: The `stripAnsi` function documents known limitations under SEC-002 in `cli-patterns.ts` (lines 193-201). Some rare ANSI sequences are not stripped. When content is copied to clipboard, these residual sequences could appear as garbled characters in the paste target.

**Recommendation**: Add a comment in `clipboard-utils.ts` referencing the SEC-002 known limitation:

```typescript
/**
 * Copy text to clipboard with ANSI code stripping.
 *
 * Note: stripAnsi has known limitations (see SEC-002 in cli-patterns.ts).
 * Some rare ANSI sequences may not be fully stripped. Since writeText
 * only writes plain text, this is a data quality issue, not a security risk.
 */
```

No code change required; documentation only.

---

#### SF-S4-3: Error logging should not include message content

| Attribute | Value |
|-----------|-------|
| Severity | Low |
| OWASP | A09:2021 Security Logging and Monitoring Failures |
| File | `src/components/worktree/HistoryPane.tsx` |

**Issue**: The `console.warn('Clipboard copy failed:', error)` in the catch clause correctly logs only the error object, not the message content. However, this intentional omission should be documented to prevent future developers from accidentally adding content to the log.

**Recommendation**: Add a comment in the catch clause:

```typescript
} catch (error) {
  if (showToast) {
    showToast('コピーに失敗しました', 'error');
  } else {
    // Intentionally not logging 'content' to avoid exposing sensitive message data
    console.warn('Clipboard copy failed:', error);
  }
}
```

---

### Consider (Future)

#### C-S4-1: Feature detection guard for Clipboard API

The `clipboard-utils.ts` design assumes `navigator.clipboard.writeText` is available. Adding a feature detection guard (`if (!navigator?.clipboard?.writeText)`) would provide a clearer error message in environments where the API is unavailable, rather than a generic TypeError. This is low priority since CommandMate targets modern browsers on localhost.

#### C-S4-2: XSS safety confirmation for ConversationPairCard

Confirmed: `ConversationPairCard` renders all content via React auto-escaping. No `dangerouslySetInnerHTML` is used. The clipboard copy path (`writeText`) only handles plain text. No new XSS vectors are introduced by this design. Phase 2 (MessageList.tsx, which uses `dangerouslySetInnerHTML`) should undergo its own security review.

#### C-S4-3: No CSRF risk

Confirmed: The copy operation is entirely client-side with no server-side state mutation. No CSRF mitigation is needed.

#### C-S4-4: CSP compatibility

Confirmed: The existing Content-Security-Policy and Permissions-Policy headers are fully compatible with Clipboard API usage. No changes to security headers are required.

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | Standard browser API usage. No complex data transformations. Single entry point via clipboard-utils.ts. |
| Security | Low | No new attack surface. Plain text clipboard write only. React auto-escaping for UI rendering. ANSI stripping for sanitization. No server-side changes. |
| Operational | Low | Feature is additive (optional props). No breaking changes. No new dependencies. |

---

## Data Flow Security Analysis

```
[tmux capture-pane]
    -> [Server: response-poller.ts / assistant-response-saver.ts]
    -> [DB: SQLite messages table]
    -> [API: /api/worktrees/[id]/messages]
    -> [Client: ChatMessage.content in React state]
    -> [User clicks Copy button]
    -> [ConversationPairCard: onCopy?.(message.content)]
    -> [HistoryPane: onCopy callback]
    -> [clipboard-utils.ts: stripAnsi(text)]
    -> [navigator.clipboard.writeText(cleanText)]
    -> [Success: showToast('コピーしました', 'success')]
    -> [Error: showToast('コピーに失敗しました', 'error') or console.warn]
```

**Trust boundaries analyzed**:

1. **tmux capture -> Server**: Existing trust boundary. Content from tmux may contain ANSI escape codes, CLI spinner characters, and raw terminal output. This boundary is handled by existing response-poller.ts and assistant-response-saver.ts.

2. **Server -> Client**: Existing trust boundary. Content is delivered as JSON via API responses. React auto-escaping prevents XSS when rendering.

3. **Client -> Clipboard** (NEW): The new trust boundary introduced by this feature. `stripAnsi()` sanitizes ANSI codes before `writeText()` writes plain text to clipboard. Since `writeText()` only accepts plain text, there is no injection risk at this boundary.

---

## Comparison with Existing Security Patterns

| Pattern | Existing Implementation | Issue #211 Design | Assessment |
|---------|------------------------|-------------------|------------|
| ANSI handling | `sanitizeTerminalOutput()` in `sanitize.ts` uses DOMPurify + AnsiToHtml for HTML rendering | `stripAnsi()` in `cli-patterns.ts` for plain text stripping | Appropriate: clipboard needs plain text, not sanitized HTML |
| XSS prevention | `rehype-sanitize` in MarkdownEditor, DOMPurify in TerminalDisplay, React auto-escape elsewhere | React auto-escaping (existing) + writeText plain text | Consistent with project security patterns |
| Error messages | Generic user-facing messages, detailed server-side logging | Generic Toast message + console.warn without content | Consistent |
| Input validation | `sanitizeInput()`, `sanitizePath()` in CLI utils | TypeScript type system + optional runtime guard | Acceptable for client-side utility |

---

## Approval Conditions

This design is **conditionally approved** for security. The conditions are:

1. **SF-S4-1**: Add input validation guard in `clipboard-utils.ts` for empty/whitespace content (defense-in-depth)
2. **SF-S4-2**: Add SEC-002 limitation documentation comment in `clipboard-utils.ts`
3. **SF-S4-3**: Add comment in HistoryPane catch clause about intentional content omission from error logs

All three conditions are low-severity documentation/defensive-coding improvements. No architectural changes are required.

---

*Generated by architecture-review-agent (Stage 4: Security Review)*
*Date: 2026-02-10*
