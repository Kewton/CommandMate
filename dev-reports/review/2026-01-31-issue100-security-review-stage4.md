# Issue #100: Mermaid Diagram Security Review (Stage 4)

**Review Date**: 2026-01-31
**Focus Area**: Security (OWASP Top 10 Compliance)
**Design Document**: `dev-reports/design/issue-100-mermaid-diagram-design-policy.md`
**Stage**: 4 (Multi-stage Design Review)

---

## Executive Summary

The security design for Issue #100 Mermaid Diagram Rendering is **generally sound** with appropriate XSS protections through mermaid's `securityLevel='strict'` configuration. The design includes centralized configuration management, planned XSS regression tests, and aligns with OWASP Top 10 requirements.

**Result**: No Must Fix items. 4 Should Fix items related to documentation clarity and consistency verification.

---

## OWASP Top 10 Compliance Assessment

### A03:2021 - Injection (XSS)

| Check Item | Status | Notes |
|------------|--------|-------|
| mermaid securityLevel setting | Pass | `securityLevel='strict'` configured in `src/config/mermaid-config.ts` |
| dangerouslySetInnerHTML usage | Warning | Used for SVG rendering; safety relies on mermaid's internal DOMPurify |
| rehype-sanitize integration | Pass | Applied to non-mermaid content; mermaid uses separate sanitization |
| XSS regression tests | Pass | Section 8.4 includes comprehensive test cases |

**Detailed Analysis**:

The design correctly uses mermaid's `securityLevel='strict'` which:
- Disables script execution in diagrams
- Removes event handler attributes (onclick, onerror, etc.)
- Sanitizes JavaScript/data/vbscript URI schemes
- Uses DOMPurify internally for SVG sanitization

**Concern**: The design document should explicitly document that mermaid uses DOMPurify internally, providing justification for the `dangerouslySetInnerHTML` exception.

---

### A05:2021 - Security Misconfiguration

| Check Item | Status | Notes |
|------------|--------|-------|
| securityLevel correctly set | Pass | 'strict' enforced in centralized config |
| startOnLoad disabled | Pass | Prevents automatic rendering of untrusted content |
| Configuration centralization | Pass | Single source in `src/config/mermaid-config.ts` |
| Fail-safe mechanism | Recommended | Add runtime assertion for securityLevel |

**Detailed Analysis**:

Configuration is appropriately centralized following DRY principle:

```typescript
export const MERMAID_CONFIG = {
  securityLevel: 'strict' as const,
  startOnLoad: false,
  theme: 'default' as const,
} as const;
```

**Recommendation**: Add a fail-safe assertion in MermaidDiagram.tsx to verify securityLevel remains 'strict' after initialization.

---

### A06:2021 - Vulnerable and Outdated Components

| Check Item | Status | Notes |
|------------|--------|-------|
| mermaid version | Pass | 11.12.0 - no known vulnerabilities |
| npm audit status | Pass | No mermaid-related vulnerabilities in audit |
| Version pinning strategy | Pass | Semantic versioning (^11.12.0) allows patches |
| Dependency monitoring | Recommended | Add Dependabot/Renovate for continuous monitoring |

**npm audit Result**: No vulnerabilities found in mermaid package. Existing project vulnerabilities are in eslint and next.js (unrelated to this feature).

**Key Dependencies of mermaid**:
- dompurify (XSS sanitization - security critical)
- d3 (visualization)
- cytoscape (graph rendering)
- katex (math rendering)

---

### A08:2021 - Software and Data Integrity Failures

| Check Item | Status | Notes |
|------------|--------|-------|
| Dynamic import integrity | Pass | Uses Next.js standard dynamic() function |
| Package integrity | Pass | npm registry with package-lock.json hash verification |
| Supply chain security | Pass | Standard npm workflow with lockfile |

**Analysis**: The dynamic import mechanism uses Next.js built-in capabilities which are well-tested. Package integrity is maintained through package-lock.json.

---

## Findings Summary

### Must Fix (0 items)

None.

### Should Fix (4 items)

| ID | Category | Title | Priority |
|----|----------|-------|----------|
| SEC-SF-001 | A03 Injection | dangerouslySetInnerHTML security justification documentation | High |
| SEC-SF-002 | A06 Vulnerable Components | Version pinning strategy review | Medium |
| SEC-SF-003 | A05 Security Misconfiguration | Fail-safe mechanism for config validation | Medium |
| SEC-SF-004 | A03 Injection | Issue #95 SVG XSS alignment verification | Medium |

#### SEC-SF-001: dangerouslySetInnerHTML Security Justification

**Location**: Design document section 5.2

**Issue**: The design mentions using `dangerouslySetInnerHTML` for SVG rendering but lacks explicit documentation of mermaid's XSS prevention mechanism.

**Recommendation**: Add the following to section 5.2:

```markdown
#### 5.2.1 mermaid内部のXSS防止メカニズム

mermaidライブラリは内部でDOMPurifyを使用してSVG出力をサニタイズする。
securityLevel='strict'設定により以下が保証される:

1. **scriptタグ除去**: `<script>`タグは完全に除去
2. **イベントハンドラ無効化**: onclick, onerror等の属性を削除
3. **危険URIスキーム無効化**: javascript:, data:, vbscript:を無害化
4. **DOMPurify使用**: SVG出力は描画前にDOMPurifyでサニタイズ

これにより、dangerouslySetInnerHTMLの使用は安全と判断される。
```

#### SEC-SF-002: Version Pinning Strategy

**Location**: Design document section 10.1, 10.3

**Current**: `"mermaid": "^11.12.0"`

**Recommendation**:
1. Update to latest stable version 11.12.2 at implementation time
2. Add Dependabot configuration for security updates
3. Document in CI/CD that `npm audit` runs on each build

#### SEC-SF-003: Fail-safe Configuration Validation

**Location**: Design document section 5.1

**Recommendation**: Add assertion in MermaidDiagram implementation:

```typescript
// Verify security-critical configuration
if (mermaid.mermaidAPI.getConfig().securityLevel !== 'strict') {
  console.error('SECURITY WARNING: mermaid securityLevel is not strict');
  throw new Error('Invalid mermaid security configuration');
}
```

#### SEC-SF-004: Issue #95 SVG XSS Alignment

**Location**: Design document overall

**Issue**: Issue #95 implements custom SVG XSS validation (validateSvgContent) with 5 checks. Need to verify mermaid's securityLevel='strict' provides equivalent protection.

**Issue #95 SVG XSS Checks**:
1. Script tag detection
2. Event handler attributes (on*)
3. Dangerous URI schemes (javascript:, data:, vbscript:)
4. foreignObject element
5. XML declaration validation

**Recommendation**: Add section to design document confirming mermaid covers all 5 items, or add supplementary tests.

---

### Nice to Have (3 items)

| ID | Category | Title |
|----|----------|-------|
| SEC-NTH-001 | CSP Compatibility | Document CSP compatibility with inline SVG styles |
| SEC-NTH-002 | Error Disclosure | Sanitize error messages in production |
| SEC-NTH-003 | Supply Chain | Add continuous dependency vulnerability monitoring |

---

## Existing Security Patterns Consistency

### Issue #95 SVG XSS Protection

| Aspect | Issue #95 | Issue #100 | Consistency |
|--------|-----------|------------|-------------|
| Approach | Custom validation (validateSvgContent) | mermaid internal (DOMPurify + securityLevel) | Different but equivalent |
| Script tags | Regex detection | DOMPurify removal | Equivalent |
| Event handlers | Regex detection (`on\w+`) | securityLevel='strict' | Equivalent |
| Dangerous URIs | Regex detection | securityLevel='strict' | Equivalent |
| foreignObject | Explicit block | Not applicable (mermaid controls SVG structure) | N/A |

**Conclusion**: Both approaches provide equivalent XSS protection through different mechanisms. Issue #95 validates user-uploaded static SVG files, while Issue #100 relies on mermaid's internal sanitization for dynamically generated diagrams.

### Issue #49 rehype-sanitize Usage

The existing MarkdownEditor uses rehype-sanitize for XSS protection:

```typescript
<ReactMarkdown
  rehypePlugins={[
    rehypeSanitize, // [SEC-MF-001] XSS protection
    rehypeHighlight,
  ]}
>
```

**Consistency**: The mermaid integration correctly separates concerns:
- Non-mermaid content: Processed through rehype-sanitize
- Mermaid code blocks: Delegated to MermaidDiagram component with internal sanitization

This is consistent with the existing architecture.

---

## Security Recommendations Summary

| Priority | Recommendation | Related Finding |
|----------|----------------|-----------------|
| High | Document mermaid's DOMPurify usage and XSS prevention mechanism | SEC-SF-001 |
| Medium | Add runtime assertion for securityLevel='strict' | SEC-SF-003 |
| Medium | Verify Issue #95 SVG XSS checks are covered by mermaid | SEC-SF-004 |
| Low | Add npm audit to CI/CD pipeline | SEC-SF-002 |
| Low | Configure Dependabot for continuous vulnerability monitoring | SEC-NTH-003 |

---

## Conclusion

The Issue #100 Mermaid Diagram design demonstrates appropriate security awareness with:

1. **Correct use of mermaid securityLevel='strict'** - Primary XSS defense
2. **Centralized configuration management** - Reduces misconfiguration risk
3. **Planned XSS regression tests** - Ensures ongoing security validation
4. **Dynamic import pattern** - Follows Next.js best practices

The 4 Should Fix items are documentation and verification improvements, not fundamental security issues. Once addressed, the design will provide robust security for mermaid diagram rendering.

**Overall Security Assessment**: **Approved with recommendations**

---

*Generated by: Architecture Review Agent*
*Review Type: Multi-stage Design Review - Stage 4 (Security)*
