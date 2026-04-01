# Issue #600 Stage 4 セキュリティレビュー報告書

## レビュー概要

| 項目 | 値 |
|------|---|
| レビュー対象 | Issue #600 設計方針書: ホーム中心のUX刷新とWorktree Detail中心導線の再設計 |
| レビューステージ | Stage 4: セキュリティレビュー（OWASP Top 10 準拠） |
| レビュアー | Claude Opus |
| 対象ドキュメント | `dev-reports/design/issue-600-ux-refresh-design-policy.md` |
| Must Fix | 2件 |
| Should Fix | 5件 |
| Nice to Have | 3件 |

---

## 総括

既存の認証基盤（middleware + SameSite=strict Cookie + Bearer トークン + IP制限）は堅牢であり、新規4画面（/sessions, /repositories, /review, /more）はmiddleware matcherパターンにより自動的に認証保護される設計は適切である。DBスキーマ変更なし、既存API後方互換の方針もセキュリティ面で好ましい。

主な改善点は以下の2点に集約される:

1. **テスト計画における認証保護検証の優先度引き上げ**: 新規4画面の認証テストがNice to Have扱い（DR3-007）になっており、Must Fixに昇格すべき
2. **入力バリデーション実装指針の具体化**: `?include` と `?pane` クエリパラメータのランタイム検証方針が抽象的であり、型ガード関数やホワイトリスト定数の配置場所を明示すべき

---

## 指摘事項一覧

| ID | 重要度 | OWASP | カテゴリ | タイトル |
|----|--------|-------|---------|---------|
| DR4-001 | Should Fix | A03 | 入力バリデーション | ?include クエリパラメータのホワイトリスト検証実装指針なし |
| DR4-002 | Should Fix | A03 | 入力バリデーション | ?pane クエリパラメータの型安全なバリデーション指針不足 |
| DR4-003 | Must Fix | A01 | Broken Access Control | 新規4画面のmiddleware保護検証テストが不十分 |
| DR4-004 | Should Fix | A03 | Injection | SimpleMessageInputのインライン返信XSSリスク考慮未記載 |
| DR4-005 | Nice to Have | A04 | Insecure Design | クライアントサイド集計の信頼性注記なし |
| DR4-006 | Should Fix | A05 | Security Misconfiguration | CSPヘッダー方針の考慮なし |
| DR4-007 | Nice to Have | A09 | Logging/Monitoring | 新規画面のセキュリティイベントログ方針未記載 |
| DR4-008 | Nice to Have | A05 | CSRF対策 | CSRF対策の前提（SameSite=strict）が未記載 |
| DR4-009 | Should Fix | A08 | Data Integrity | 共有キャッシュモード切替時のデータ整合性 |
| DR4-010 | Must Fix | A03 | Injection | deep link paneパラメータのランタイム検証保証なし |

---

## Must Fix（2件）

### DR4-003: 新規4画面のmiddleware保護検証テストが不十分

**OWASP参照**: A01 Broken Access Control

**指摘**: 新規URL（/sessions, /repositories, /review, /more）は既存middleware matcherパターンで自動保護される設計だが、`AUTH_EXCLUDED_PATHS`への誤追加防止テストがStage 3で「DR3-007 Nice to Have」として備考扱いになっている。認証バイパスは最もクリティカルなセキュリティ欠陥であり、特に /sessions と /review はworktreeのセッション状態やメッセージ送信機能を含む。

**改善提案**: テスト戦略セクション12の統合テスト「認証ミドルウェア: 新規URL4件の保護検証」をMust Fixに昇格し、具体的なテストケースを明記する:
- /sessions, /repositories, /review, /more が認証なしで401/302を返すこと
- AUTH_EXCLUDED_PATHS にこれら4パスが含まれていないことのアサーション
- middleware.config.matcher パターンがこれら4パスにマッチすることのユニットテスト

---

### DR4-010: deep link paneパラメータのランタイム検証保証なし

**OWASP参照**: A03 Injection

**指摘**: `?pane=xxx` パラメータは `useSearchParams()` 経由でURLから取得され、`useWorktreeTabState()` 内でタブ切替ロジックに使用される。DeepLinkPane型への変換は記載されているが、TypeScriptの型チェックはランタイムでは機能しない。不正なpane値がDOM属性やclassName生成に使用される場合にDOM-based XSSのリスクがある。

**改善提案**: セクション7に以下を追加:
- `useWorktreeTabState()`の冒頭でpane値をDeepLinkPane型のホワイトリストに対して検証し、不一致は 'terminal' にフォールバック
- フォールバック後のpane値のみを内部ロジックで使用し、生の `searchParams.get('pane')` 値をコンポーネント内で直接参照しない設計規約を明記
- DR4-002と合わせて実装する

---

## Should Fix（5件）

### DR4-001: ?include クエリパラメータのホワイトリスト検証実装指針なし

**OWASP参照**: A03 Injection

**指摘**: セクション8で「許可値のホワイトリスト検証」と記載されているが、許可値の定義場所、不正値時の挙動、複数値対応の可否が未記載。

**改善提案**: (1) `const VALID_INCLUDE_VALUES = ['review'] as const` を定数定義、(2) 不正値は無視してincludeなしと同等に扱う、(3) カンマ区切り時は各値を個別にホワイトリスト検証する方針をセクション5に明記。

---

### DR4-002: ?pane クエリパラメータの型安全なバリデーション指針不足

**OWASP参照**: A03 Injection

**指摘**: DeepLinkPane型（9種）とバリデーション関数の関係が未明示。ランタイム型ガード関数が定義されていない。

**改善提案**: `src/types/ui-state.ts` にランタイム型ガード関数 `isDeepLinkPane()` を定義し、`useWorktreeTabState()` 内で検証する実装指針をセクション7に追加する。

---

### DR4-004: SimpleMessageInputのインライン返信XSSリスク考慮未記載

**OWASP参照**: A03 Injection

**指摘**: SimpleMessageInputは新規コンポーネントとして独立実装されるため、既存MessageInputのサニタイズ処理の継承が保証されない。

**改善提案**: (1) `useSendMessage()` 内でcommandの長さ制限を明記、(2) chat-db永続化はプレーンテキスト保存で表示時はReactのデフォルトエスケープを利用する旨を明記、(3) ReviewCard内で `dangerouslySetInnerHTML` を使用しない方針を明記。

---

### DR4-006: CSPヘッダー方針の考慮なし

**OWASP参照**: A05 Security Misconfiguration

**指摘**: 既存プロジェクト全体でCSPが未設定。新規4画面追加にあたりCSP方針の検討が必要。

**改善提案**: CSP導入はIssue #600スコープ外とし別Issue起票する旨を明記。ただしSimpleMessageInput/ReviewCardではインラインスクリプトやeval()を使用しない方針をセクション8に追加。

---

### DR4-009: 共有キャッシュモード切替時のデータ整合性

**OWASP参照**: A08 Software and Data Integrity Failures

**指摘**: Review画面離脱時に `?include=review` 付きレスポンスが返却された場合、review用フィールドが通常画面に残留するレースコンディションのリスク。

**改善提案**: (1) フェッチモード切替時にAbortControllerでキャンセル、(2) 通常モード復帰時にreview用フィールドをundefinedにクリア、(3) モード切替時のデータ整合性テストケースを追加。

---

## Nice to Have（3件）

### DR4-005: クライアントサイド集計の信頼性注記なし

**OWASP参照**: A04 Insecure Design

Home画面のクライアントサイド集計値は表示目的のみであり、アクセス制御や操作可否の判断に使用しない旨の注記を追加する。

---

### DR4-007: 新規画面のセキュリティイベントログ方針未記載

**OWASP参照**: A09 Security Logging and Monitoring Failures

不正パラメータはサイレントフォールバック（DoSログ汚染防止）、worktree ID不正は既存terminal APIのエラーログに委ねる方針を明記する。

---

### DR4-008: CSRF対策の前提（SameSite=strict）が未記載

**OWASP参照**: A05 Security Misconfiguration

認証CookieのSameSite=strict設定と同一オリジンfetchにより防御されている前提を明記し、追加のCSRFトークン実装が不要である根拠をセクション8に追加する。

---

## 既存セキュリティ基盤の評価

| セキュリティ機能 | 実装状態 | 評価 |
|----------------|---------|------|
| 認証middleware（Edge Runtime） | 実装済み | 良好: 定数時間比較、Cookie/Bearer両対応 |
| AUTH_EXCLUDED_PATHS | exactマッチ（startsWith不使用） | 良好: バイパス攻撃防止 |
| SameSite=strict Cookie | 実装済み（auth.ts） | 良好: CSRF防御 |
| HttpOnly Cookie | 実装済み | 良好: XSS経由のCookie窃取防止 |
| IP制限 | 実装済み（CIDR対応） | 良好: ネットワークレベル防御 |
| コマンド長制限（MAX_COMMAND_LENGTH） | 実装済み（10000文字） | 良好: DoS防止 |
| cliToolIdバリデーション | ホワイトリスト検証済み | 良好: インジェクション防止 |
| ログインジェクション防止 | normalizeIp + substring(0, 45) | 良好 |

---

## 次のアクション

1. **DR4-003** と **DR4-010** の Must Fix 指摘を設計方針書に反映する
2. Should Fix 5件の改善提案をセクション5, 7, 8 に反映する
3. Phase 1 統合テストに新規URL認証保護テストを組み込む
