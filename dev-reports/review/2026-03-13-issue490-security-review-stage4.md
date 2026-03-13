# Issue #490 Stage 4 セキュリティレビュー

| 項目 | 内容 |
|------|------|
| Issue | #490 HTMLファイル レンダリング |
| Stage | 4 - セキュリティレビュー |
| レビュー日 | 2026-03-13 |
| 対象 | dev-reports/design/issue-490-html-preview-design-policy.md |
| 総合評価 | acceptable |

---

## レビューサマリー

HTMLプレビュー機能のセキュリティ設計は、iframe sandbox属性による段階的制御、既存path-validator.tsとの整合、認証ミドルウェアとの一貫性など、基本的なセキュリティ要件を満たしている。ただし、以下の3点のmust_fix指摘がある。

1. HTMLコンテンツのサニタイズ方針（DOMPurify使用/不使用）が明記されていない
2. Interactiveモード切り替え時の警告UIが未設計
3. CSPとiframe内スクリプト実行の関係分析が不足

全体としてセキュリティ意識の高い設計であるが、XSS防御の最終ラインに関する明確な方針記載が必要である。

---

## 指摘事項一覧

| ID | 重要度 | カテゴリ | OWASP | タイトル |
|----|--------|---------|-------|---------|
| DR4-001 | must_fix | XSS防御方針 | A03/A07 | HTMLサニタイズ方針が未明記（DOMPurify使用/不使用の設計判断） |
| DR4-002 | must_fix | Interactiveモード | A07 | allow-scripts切り替え時の警告UIが未設計 |
| DR4-003 | must_fix | CSP整合性 | A05 | CSP script-srcとiframe内スクリプト実行の関係分析が不足 |
| DR4-004 | should_fix | DoS防止 | A05 | GET時のHTMLファイルサイズ事前チェック（stat()）が未設計 |
| DR4-005 | should_fix | パスバリデーション | A03 | 5層防御がHTMLファイルに適用されることの明記 |
| DR4-006 | should_fix | 認証保護 | A07 | iframe内からのCookie/認証トークンアクセス不可能性の明記 |
| DR4-007 | should_fix | CSP設定 | A05 | frame-srcのblob:がYAGNI原則に反する |
| DR4-008 | nice_to_have | リソース制御 | A05 | iframe内の無限ループ・メモリリーク検出機構の検討 |
| DR4-009 | nice_to_have | 既存資産活用 | A03 | containsDangerousContent関数のHTMLプレビュー連携 |

---

## must_fix 詳細

### DR4-001: HTMLサニタイズ方針が未明記

**問題**: 設計方針書では「HTMLの変換・加工ができない（意図通り）」と記載されているが、DOMPurifyを使用しない設計判断とその根拠が明記されていない。プロジェクトには既にDOMPurify（isomorphic-dompurify）が`src/lib/security/sanitize.ts`で導入されている。

**リスク**: 将来の保守者がDOMPurify導入の要否を判断する根拠が不在。Interactiveモードでの悪意あるHTMLファイル（git clone経由）への対策方針が不明確。

**対応**: 設計方針書のセクション4に「4-4. HTMLサニタイズ方針」を新設し、Safeモードではsandbox=''による防御で十分であること、Interactiveモードではユーザーの明示的許可に基づくためサニタイズを行わないこと、その代わりに切り替え時の警告UIが必須であることを明記する。

### DR4-002: Interactiveモード切り替え時の警告UIが未設計

**問題**: Interactiveモードへのトグルがワンクリックで切り替わる設計であり、allow-scripts有効化による以下のリスクへの対策が不足。
- iframe内でのCPU消費（無限ループ）
- 大量DOM生成によるメモリ消費
- window.alert/confirm/promptによるUIブロック
- 他者のリポジトリをcloneした場合の悪意あるHTML

**対応**: Interactiveモード切り替え時にconfirmダイアログを表示する設計を追加。DR1-003でFullレベルに「警告ダイアログ必須」と記載されている方針と一貫させる。セッション中の同一ファイルへの再確認はスキップ可能とする。

### DR4-003: CSPとiframe内スクリプト実行の関係分析

**問題**: 現在のCSP（`script-src 'self' 'unsafe-inline' 'unsafe-eval'`）とiframe srcDocのスクリプト実行の関係が未分析。sandbox属性でallow-same-originがない場合のCSP継承挙動はブラウザ実装依存であり、iframe内からの外部リソースfetchやWebSocket接続の制約が明記されていない。

**対応**: sandbox属性でallow-same-originが未付与の場合、iframe内はopaque originとなり、外部fetch/XHR/WebSocketはCORSポリシーによりブロックされることを明記。Interactiveモードのリスクが「iframe内でのローカル実行」に限定されることを設計方針書に追記する。

---

## should_fix 詳細

### DR4-004: GET時のサイズ事前チェック

現在のGET APIルートはテキストファイル読み込み時にサイズ制限チェックを行っていない。HTMLファイルの場合、`fileStat.size`（行262で既に取得済み）を`HTML_MAX_SIZE_BYTES`と比較する事前チェックを追加し、readFileContent呼び出し前にメモリ効率的な制限を実現すること。画像・動画の実装パターン（行214-217）に準拠。

### DR4-005: パスバリデーション整合性の明記

HTMLファイルは既存のGET /files/... APIを経由するため、`getWorktreeAndValidatePath()`による全パスバリデーション（isPathSafe、resolveAndValidateRealPath）が自動適用される。セキュリティ設計の明確性のため、これを設計方針書に明記すること。

### DR4-006: 認証トークン保護の明記

iframe sandbox属性でallow-same-originが付与されない限り、iframe内スクリプトは親ページのdocument.cookieやlocalStorageにアクセスできない。各サンドボックスレベルでの認証情報へのアクセス可否をセクション4-1の表に追記すること。

### DR4-007: frame-srcのblob:除外

現時点でblob:を必要とする具体的機能がない。YAGNI原則（DR1-003で適用済み）との一貫性から、`frame-src 'self'`のみとしblob:は除外すること。既存MARPプレビューはblob:なしで動作している実績がある。

---

## OWASPチェックリスト

| OWASP項目 | 評価 | 備考 |
|-----------|------|------|
| A03 Injection | conditional_pass | パスバリデーションは5層防御で担保。サニタイズ方針の明記が必要 |
| A05 Security Misconfiguration | conditional_pass | CSP frame-src追加は妥当。blob:の必要性に疑問。CSP継承分析が不足 |
| A07 XSS | conditional_pass | Safeモードは完全防御。Interactiveモードの警告UIとサニタイズ方針の明記が必要 |

---

## 参照コードベース

| ファイル | 確認結果 |
|---------|---------|
| `src/lib/security/path-validator.ts` | 5層防御（空パス、NULLバイト、URLデコード、トラバーサル、シンボリックリンク）がHTMLファイルにも適用される |
| `src/lib/security/sanitize.ts` | DOMPurify（isomorphic-dompurify）が導入済み。containsDangerousContent関数がHTMLプレビューの警告に活用可能 |
| `next.config.js` | CSPにframe-src未定義（default-src 'self'がフォールバック）。script-srcに'unsafe-inline' 'unsafe-eval'あり |
| `src/middleware.ts` | 認証ミドルウェアが全APIルートに適用。HTMLファイルのGET/PUT APIも認証対象 |
| `src/config/editable-extensions.ts` | validateContent()によるバイナリ検出・サイズ制限がPUT/POST時に適用される |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | getWorktreeAndValidatePath()による共通パスバリデーション。GETのテキスト読み込みパスにサイズ事前チェックなし |

---

## 実装チェックリスト

- [ ] **DR4-001**: 設計方針書にHTMLサニタイズ方針（DOMPurify不使用の根拠）を明記する
- [ ] **DR4-002**: Interactiveモード切り替え時のconfirmダイアログを設計に追加する
- [ ] **DR4-003**: CSPとiframe内スクリプト実行の関係（opaque origin、外部リソースアクセス制限）を設計方針書に追記する
- [ ] **DR4-004**: GET API内でHTMLファイルのfileStat.sizeをHTML_MAX_SIZE_BYTESと比較する事前チェックを追加する
- [ ] **DR4-005**: パスバリデーションの5層防御がHTMLファイルに適用される旨を設計方針書に明記する
- [ ] **DR4-006**: 各サンドボックスレベルでの認証トークン保護状況を設計方針書のsandbox表に追記する
- [ ] **DR4-007**: CSP frame-srcからblob:を除外し、`frame-src 'self'`のみとする
