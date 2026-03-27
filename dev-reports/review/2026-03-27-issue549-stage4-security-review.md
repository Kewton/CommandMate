# Stage 4: Security Review - Issue #549

**Date**: 2026-03-27
**Issue**: #549 - Mobile Markdown Viewer Default Tab Change
**Focus**: Security (OWASP Top 10)
**Score**: 5/5
**Status**: approved

---

## Review Summary

This change is frontend-only, modifying the `mobileTab` initial value from `'editor'` to `'preview'` via a `useEffect` hook, and adding `initialViewMode='split'` prop to the mobile Modal's MarkdownEditor invocation. No security risks were identified.

---

## Analysis Results

### 1. XSS Vector Analysis

**Result**: No new XSS vectors introduced.

The Markdown rendering pipeline in `MarkdownPreview.tsx` uses:
- `remarkGfm` for GitHub Flavored Markdown
- `rehypeSanitize` with `REHYPE_SANITIZE_SCHEMA` (allowlist-based, defined in `src/lib/link-utils.ts` lines 111-124)
- `rehypeHighlight` for syntax highlighting

The sanitize schema restricts `href` attributes via a protocol allowlist regex: `^(?:#|mailto:|tel:|https?:\/\/|(?![a-zA-Z][a-zA-Z0-9+.-]*:))`. This pipeline is entirely outside the change scope and remains unmodified. The change only affects which tab (`editor` vs `preview`) is initially visible -- it does not alter what content is rendered or how it is sanitized.

### 2. Client-Side State Manipulation

**Result**: No risk.

`mobileTab` is a React `useState` local state constrained to the `MobileTab` union type (`'editor' | 'preview'`). This value:
- Is never sent to any API endpoint
- Is never persisted to localStorage or any database
- Only controls which tab panel is visually displayed in the MobileTabBar

Even if manipulated via DevTools, the impact is limited to changing the visible tab -- no data exfiltration, privilege escalation, or injection is possible.

### 3. localStorage Security

**Result**: No new localStorage interaction.

The change does not add any new localStorage read/write operations. The existing `getInitialViewMode` function (line 80-93) is bypassed for the mobile Modal path because `initialViewMode='split'` is explicitly provided as a prop. The existing `isValidViewMode` validation (line 73-75) guards against localStorage poisoning by falling back to `'split'` for any invalid stored value.

### 4. useEffect Exploitation

**Result**: No exploitation vector.

The added `useEffect` has a simple structure:
```typescript
useEffect(() => {
  if (isMobile) {
    setMobileTab('preview');
  }
}, [isMobile]);
```

- Depends only on `isMobile` (a boolean derived from `window.innerWidth`)
- No external/user-controlled input in the dependency array
- No network calls, no DOM manipulation beyond React state
- No timing-sensitive operations that could be exploited via race conditions

### 5. OWASP Top 10 Compliance

| Category | Status | Notes |
|----------|--------|-------|
| A01: Broken Access Control | N/A | No access control changes |
| A02: Cryptographic Failures | N/A | No cryptographic operations |
| A03: Injection | Pass | rehype-sanitize with allowlist maintained |
| A04: Insecure Design | Pass | UI-only change, no data flow modification |
| A05: Security Misconfiguration | N/A | No configuration changes |
| A06: Vulnerable Components | Pass | No new dependencies |
| A07: Authentication Failures | N/A | No auth changes |
| A08: Data Integrity Failures | Pass | Local state only, no persistence |
| A09: Logging Failures | N/A | No logging changes |
| A10: SSRF | N/A | No server-side changes |

### 6. rehype-sanitize Protection

**Result**: Fully intact.

The `REHYPE_SANITIZE_SCHEMA` in `src/lib/link-utils.ts` extends `defaultSchema` from `rehype-sanitize` with a customized `href` attribute allowlist. This configuration:
- Blocks `javascript:` protocol URIs
- Blocks `data:` protocol URIs
- Allows only `#` (anchors), `mailto:`, `tel:`, `http://`, `https://`, and relative paths
- Is applied as a rehype plugin in the markdown rendering pipeline

None of the files in the change scope (`MarkdownEditor.tsx`, `WorktreeDetailRefactored.tsx`) modify the rendering pipeline or the sanitize schema.

---

## Findings

No must_fix, should_fix, or nice_to_have items identified.

All findings are informational (confirming existing security measures remain intact).

---

## Risk Assessment

**Overall Risk**: None

This change is a purely cosmetic UI default adjustment for mobile viewport users. The security boundary (rehype-sanitize XSS protection, API authentication middleware, path validation) is entirely outside the change scope and unaffected.

---

## Conclusion

The design policy for Issue #549 passes the security review with no findings requiring action. The change is OWASP Top 10 compliant and introduces no new attack surface.
