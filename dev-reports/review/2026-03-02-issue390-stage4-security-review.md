# Issue #390 Stage 4: Security Review Report

## Executive Summary

**Issue**: #390 - 言語未指定コードブロックの背景修正
**Stage**: 4 - セキュリティレビュー
**Status**: approved
**Score**: 5/5

Issue #390 の設計方針書は CSS スタイル変更のみを対象としており、セキュリティリスクは極めて低い。OWASP Top 10 の主要カテゴリはすべて pass と評価される。設計方針書セクション6のセキュリティ設計記述に改善の余地があるが、いずれも nice_to_have レベルであり、実装を妨げるものではない。

---

## OWASP Top 10 Compliance

| Category | Status | Analysis |
|----------|--------|----------|
| A03: Injection | pass | CSS 変更のみ。ユーザー入力を処理するロジックの変更なし。色値はハードコードされた静的値 |
| A04: Insecure Design | pass | CSSフォールバックパターンは安全な設計。外部入力への依存なし |
| A05: Security Misconfiguration | pass | mermaid securityLevel='strict' の設定は維持。globals.css の変更は @layer components 内に限定 |
| A07: XSS | pass | rehype-sanitize による保護（MarkdownEditor.tsx）は維持。カスタム pre コンポーネントの変更は className 属性のみで dangerouslySetInnerHTML は使用していない |

---

## Detailed Findings

### D4-001: FileViewerPage および MessageList に rehype-sanitize が未適用 [nice_to_have]

**OWASP**: A07 (XSS)

**Description**:
設計方針書セクション6では「rehype-sanitize によるXSS保護は既存のまま維持」と記述されているが、この保護は `MarkdownEditor.tsx` にのみ適用されている。`FileViewerPage` (page.tsx L151-153) と `MessageList.tsx` (L202-208) の ReactMarkdown では `rehype-highlight` のみが使用されており、`rehype-sanitize` は適用されていない。

**Evidence**:

`src/components/worktree/MarkdownEditor.tsx` (L540-542) -- rehype-sanitize あり:
```tsx
rehypePlugins={[
  rehypeSanitize, // [SEC-MF-001] XSS protection
  rehypeHighlight,
]}
```

`src/app/worktrees/[id]/files/[...path]/page.tsx` (L153) -- rehype-sanitize なし:
```tsx
rehypePlugins={[rehypeHighlight]}
```

`src/components/worktree/MessageList.tsx` (L204) -- rehype-sanitize なし:
```tsx
rehypePlugins={[rehypeHighlight]}
```

**Impact**: 本 Issue #390 の CSS 修正はこの状況を悪化させない。これは既存の問題であり、本 Issue のスコープ外である。

**Suggestion**: 設計方針書セクション6の記述を正確に修正し、rehype-sanitize の適用範囲を明確にする。FileViewerPage と MessageList への rehype-sanitize 追加は別 Issue として検討すべきである。

---

### D4-002: セキュリティ設計セクションに CSS Injection 分析が欠如 [nice_to_have]

**OWASP**: N/A

**Description**:
設計方針書セクション6は XSS リスクのみに言及しているが、CSS Injection の観点での分析が記載されていない。本修正で追加されるハードコード色値（`#0d1117`, `#c9d1d9`）は `globals.css` に静的に定義されるため CSS Injection のリスクはないが、設計方針書としてその分析結果を明記すべきである。

**Suggestion**: セクション6に CSS Injection リスク分析を追加する。

---

### D4-003: セキュリティ設計セクションの記述が簡潔すぎる [nice_to_have]

**OWASP**: N/A

**Description**:
セクション6は4行の簡潔な記述のみで構成されている。CSS のみの変更であっても、以下の分析が含まれるべきである:

1. **rehype-sanitize 適用範囲の正確な記述**: MarkdownEditor.tsx にのみ適用されている点
2. **dangerouslySetInnerHTML への影響分析**: 関連コンポーネント内の dangerouslySetInnerHTML 使用箇所への影響がないことの確認
   - `MermaidDiagram.tsx` L169: SVG 描画（mermaid securityLevel='strict' で保護）
   - `MessageList.tsx` L199, L600: ANSI-to-HTML 変換（escapeXML: true で保護）
3. **CSS Injection リスク分析**: ハードコード静的値のため安全
4. **コンテンツ視認性**: ダーク背景変更によるテキスト視認性は手動テスト T-001 から T-010 でカバー

**Suggestion**: セクション6を上記4項目の構成に拡充する。

---

## Dependency Security Analysis

### highlight.js / rehype-highlight

| Package | Version | Known CVEs | Status |
|---------|---------|-----------|--------|
| highlight.js | 11.11.1 | None found | Safe |
| rehype-highlight | 7.0.2 | None found | Safe |
| rehype-sanitize | 6.0.0 | None found | Safe |
| react-markdown | 10.1.0 | None found | Safe |

### npm audit findings (unrelated to Issue #390)

| Package | Severity | Description | Relevance |
|---------|----------|-------------|-----------|
| lodash-es (via mermaid) | moderate | Prototype Pollution in _.unset/_.omit | Not related to CSS changes |
| next | high | DoS via Image Optimizer / RSC deserialization | Not related to CSS changes |

---

## dangerouslySetInnerHTML Impact Analysis

本 Issue の CSS 変更が影響する `.prose pre` セレクタ内で `dangerouslySetInnerHTML` を使用しているコンポーネントの分析:

| Component | Location | Pattern | Impact |
|-----------|----------|---------|--------|
| MermaidDiagram.tsx | L169 | `dangerouslySetInnerHTML={{ __html: svg }}` | mermaid 出力の SVG を描画。`<div>` 要素のため `.prose pre` ルールの影響を受けない。mermaid securityLevel='strict' で保護 |
| MessageList.tsx | L199 | `dangerouslySetInnerHTML={{ __html: convertAnsiToHtml(...) }}` | `<pre>` 要素だが `className="... bg-gray-900 ..."` で明示的背景色を持つ。Tailwind ユーティリティが `@layer components` の `.prose pre` より優先されるため、背景色の変更は適用されない。`escapeXML: true` で XSS 保護 |
| MessageList.tsx | L600 | `dangerouslySetInnerHTML={{ __html: new AnsiToHtml({...}).toHtml(...) }}` | 同上。`bg-gray-900` により `.prose pre` のダーク背景とは独立 |

**結論**: `dangerouslySetInnerHTML` を使用している箇所はすべて、本 CSS 変更の影響範囲外であるか、既存のセキュリティ保護メカニズムにより安全である。

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical Risk | Low | CSS のみの変更。既存のセキュリティメカニズムに影響なし |
| Security Risk | Low | OWASP Top 10 全項目 pass。新たな攻撃面の追加なし |
| Operational Risk | Low | 視覚的変更のみ。サーバーサイド処理への影響なし |

---

## Reviewed Files

| File | Security Relevance |
|------|-------------------|
| `src/app/globals.css` (L31-45) | `.prose pre` ルールの変更。静的 CSS のみ |
| `src/app/worktrees/[id]/files/[...path]/page.tsx` (L150-173) | カスタム pre/code コンポーネント。className 変更のみ |
| `src/components/worktree/MarkdownEditor.tsx` (L538-543) | rehype-sanitize 適用確認 |
| `src/components/worktree/MessageList.tsx` (L196-209, L597-606) | rehype-sanitize 未適用確認、dangerouslySetInnerHTML 使用箇所確認 |
| `src/components/worktree/MermaidDiagram.tsx` (L149-161, L164-171) | エラー表示 pre 要素、dangerouslySetInnerHTML 使用箇所確認 |
| `src/config/mermaid-config.ts` | securityLevel='strict' 確認 |

---

## Conclusion

Issue #390 の設計方針書はセキュリティの観点から approved である。must_fix および should_fix の指摘事項はない。3件の nice_to_have は設計方針書の記述品質向上に関するものであり、セキュリティ上の実質的なリスクを示すものではない。

---

*Generated by architecture-review-agent for Issue #390 Stage 4*
*Date: 2026-03-02*
