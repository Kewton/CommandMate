# Architecture Review: Issue #485 Stage 4 Security Review

**Issue**: #485 履歴・メモからメッセージ入力欄への挿入機能
**Review Type**: セキュリティ (Security)
**Date**: 2026-03-13
**Status**: approved
**Score**: 5/5

---

## Executive Summary

Issue #485 の設計方針書に対するセキュリティレビューを実施した。本機能はUIのみの変更であり、新規APIの追加は行われない。挿入データの流れは、DBから取得済みのテキストデータをReact stateとして伝播し、textarea要素のvalue属性経由で表示するという一方向のデータフローであり、セキュリティ上のリスクは極めて低い。

OWASP Top 10の全10項目について評価を行い、該当する項目（A03 Injection、A04 Insecure Design、A08 Software and Data Integrity Failures）は全てパスしている。必須修正項目（must_fix）および推奨修正項目（should_fix）はなし。

---

## OWASP Top 10 Checklist

| ID | Category | Status | Note |
|----|----------|--------|------|
| A01 | Broken Access Control | N/A | 新規API追加なし。既存認証に影響なし |
| A02 | Cryptographic Failures | N/A | 暗号化処理の変更なし |
| A03 | Injection | PASS | React state + textarea value で自動エスケープ |
| A04 | Insecure Design | PASS | 一方向データフロー、明確なライフサイクル |
| A05 | Security Misconfiguration | N/A | 設定変更なし |
| A06 | Vulnerable/Outdated Components | N/A | 新規依存なし |
| A07 | Identification/Auth Failures | N/A | 認証フロー変更なし |
| A08 | Data Integrity Failures | PASS | DB取得済みデータを再利用 |
| A09 | Logging/Monitoring Failures | N/A | ログ変更なし |
| A10 | SSRF | N/A | サーバーリクエスト変更なし |

---

## Detailed Findings

### D4-001 [nice_to_have] XSS: React標準エスケープ依存の明示的文書化

**カテゴリ**: XSS

挿入テキストはMessageInputのtextarea要素のvalue属性にsetState経由で設定される。textarea要素のvalueはReactが自動的にエスケープするため、XSSの危険はない。

ただし、将来的にtextareaからcontentEditableやdangerouslySetInnerHTMLベースのリッチテキストエディタに変更された場合、この安全性の前提が崩れる。

**現時点の評価**: 問題なし。ConversationPairCard.tsxおよびMemoCard.tsxのいずれもdangerouslySetInnerHTMLを使用していないことを実コードで確認済み。

**提案**: MessageInput.tsxのpendingInsertText消費箇所に、textarea valueによるエスケープが安全性を保証する旨のコメント追加を推奨。

---

### D4-002 [nice_to_have] データ流出: localStorage下書き保存の動作

**カテゴリ**: データ流出

挿入されたテキストはmessage stateに追加後、既存の500msデバウンスによりlocalStorageに自動保存される。これは既存動作の延長であり、以下の理由からセキュリティ上の追加リスクはない。

1. localStorageは同一オリジンポリシーにより保護されている
2. 挿入元データ（履歴・メモ）は既にDB保存済みであり、localStorage保存による新たな情報漏洩経路は生じない
3. 送信時にはlocalStorageからドラフトが削除される（既存実装: 行135）

**評価**: 対応不要。

---

### D4-003 [nice_to_have] インジェクション: スラッシュコマンド意図しない発火

**カテゴリ**: インジェクション

メモや履歴テキストが `/` で始まる場合、スラッシュコマンド検出ロジック（handleMessageChange, 行244）に合致する可能性がある。しかし、pendingInsertTextによるテキスト挿入はsetMessage経由のプログラマティックなstate変更であり、ReactのイベントモデルではonChangeイベントが発火しない。

したがって、挿入によりスラッシュコマンドセレクタが意図せず表示されることはない。

**評価**: 対応不要。

---

### D4-004 [nice_to_have] XSS: ConversationPairCard parseContentPartsとの安全な分離

**カテゴリ**: XSS

ConversationPairCardはparseContentParts関数でファイルパスをクリッカブルなリンクに変換して表示するが、挿入ボタンはuserMessage.contentの生テキストを直接渡す設計となっている。これにより、パース済みのJSXではなくプレーンテキストがtextareaに安全に挿入される。

**評価**: 設計は正しい。対応不要。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ(XSS) | React auto-escapeに依存（textarea value） | Low | Low | P3 |
| セキュリティ(Injection) | スラッシュコマンド意図しない発火 | Low | Low | P3 |
| データ流出 | localStorage下書き保存 | Low | Low | P3 |
| 技術的リスク | なし | - | - | - |
| 運用リスク | なし | - | - | - |

---

## Security Architecture Analysis

### Data Flow Security

```
DB (server) --> API Response --> React State (client)
                                      |
                                      v
                              pendingInsertText (string | null)
                                      |
                                      v
                              setMessage(prev => prev + content)
                                      |
                                      v
                              <textarea value={message} />  [React auto-escape]
                                      |
                                      v
                              localStorage (draft save, same-origin protected)
                                      |
                                      v
                              worktreeApi.sendMessage(message.trim())  [existing server-side handling]
```

全ての段階でデータはプレーンテキストとして扱われ、HTML/JSXへの変換は行われない。React JSXの自動エスケープ機構とtextarea要素の特性により、挿入コンテンツがスクリプトとして実行されることは構造的にあり得ない。

### Authentication Boundary

本機能はUIのみの変更であり、既存の認証境界（middleware.ts + auth.ts）に影響を与えない。新規APIエンドポイントの追加がないため、認証バイパスのリスクは存在しない。

---

## Improvement Recommendations

### Must Fix (必須改善項目)

なし。

### Should Fix (推奨改善項目)

なし。

### Consider (検討事項)

1. **D4-001**: MessageInput.tsxのpendingInsertText消費useEffect付近に、テキストがtextarea value経由でのみ表示されることを明記するコメントの追加
2. 将来MessageInputがリッチテキストエディタに置き換えられる場合は、挿入テキストのサニタイズ層を追加すること

---

## Approval

**Status**: approved -- セキュリティ上の問題なし

本設計方針書は、UIのみの変更・プレーンテキスト操作・React自動エスケープという3つの安全性要素により、セキュリティリスクが極めて低い設計となっている。OWASP Top 10の該当項目は全てパスしており、必須・推奨修正項目はない。実装を進めて問題ない。
