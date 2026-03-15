# Issue #501 Stage 4: セキュリティレビュー

**レビュー日**: 2026-03-16
**対象**: dev-reports/design/issue-501-auto-yes-dual-response-fix-design-policy.md
**フォーカス**: セキュリティ (OWASP Top 10 準拠性)

---

## 総合評価

セキュリティ上の重大な懸念は検出されなかった。設計書セクション6の「影響なし」判断は妥当である。

3つの対策はいずれもサーバー側メモリ内の状態管理とクライアント側の型定義補完に限定されており、入力バリデーション・認証・tmuxサニタイズ等の既存セキュリティ機構に変更を加えない。

---

## レビューサマリ

| 指標 | 値 |
|------|-----|
| 総指摘数 | 7 |
| must_fix | 0 |
| should_fix | 0 |
| nice_to_have | 7 |

---

## 対策別セキュリティ分析

### 対策1: lastServerResponseTimestamp 伝播

**分析対象**: CurrentOutputResponse型追加、useState保存、useAutoYes引数渡し

- **XSSリスク**: なし。lastServerResponseTimestamp は number | null 型であり、DOM に直接レンダリングされない。Date.now() との差分計算にのみ使用される
- **データ露出**: lastServerResponseTimestamp は既に current-output API レスポンスに含まれている (L139)。新たな露出なし
- **クライアント側バリデーション** (SEC4-001): fetchCurrentOutput() で data.lastServerResponseTimestamp を取得する際、typeof チェックが設計書に記載されていない。正規サーバーからのレスポンスでは常に number | null だが、改竄された場合に NaN 比較となる可能性がある。ただし認証ミドルウェアにより実際のリスクは極めて低い

### 対策2: ポーラー冪等性

**分析対象**: startAutoYesPolling() の cliToolId 比較ロジック

- **cliToolId バイパス**: 不可能。auto-yes/route.ts の isValidCliTool() で CLI_TOOL_IDS ホワイトリストチェック済み (L69-72)。ポーラー状態の cliToolId もサーバー側で設定された値のみ保持
- **DoSリスク**: 軽減方向。既存の MAX_CONCURRENT_POLLERS 制限は維持。冪等化により不要なポーラー破棄・再作成が削減される
- **入力バリデーション**: worktreeId は isValidWorktreeId() (WORKTREE_ID_PATTERN: /^[a-zA-Z0-9_-]+$/) でバリデーション済み

### 対策3: ステータス検出改善

**分析対象**: detectSessionStatus() への lastOutputTimestamp 引数追加

- **タイミング攻撃**: ベクタなし。タイムスタンプはサーバー側のメモリ内 Map (autoYesPollerStates) で管理。クライアントからの操作経路なし (API は GET のみ、タイムスタンプ受信パラメータなし)
- **タイムスタンプ操作**: getLastServerResponseTimestamp() は Map.get() で内部状態を読み取るのみ。外部からの注入不可

### 横断的セキュリティ確認

- **tmuxインジェクション**: 新規パス なし。3つの対策はいずれも tmux コマンド呼び出しパターンを変更しない
- **認証**: バイパスなし。新規エンドポイント追加なし。既存の middleware.ts トークン認証が全ルートで有効
- **リソース枯渇**: 新規ベクタなし。MAX_CONCURRENT_POLLERS 制限維持。冪等化は改善方向

---

## 指摘一覧

### SEC4-001: lastServerResponseTimestamp の型チェック (nice_to_have)

- **カテゴリ**: 入力バリデーション
- **対象**: src/components/worktree/WorktreeDetailRefactored.tsx
- **内容**: クライアント側で typeof data.lastServerResponseTimestamp === 'number' のガードが設計書に未記載。正規レスポンスでは問題ないが、防御的プログラミングとして検討可能
- **判断**: 認証済みアクセスのみのため必須ではない

### SEC4-002: cliToolId 比較の安全性 (nice_to_have)

- **カテゴリ**: ロジック安全性
- **対象**: src/lib/auto-yes-poller.ts, src/app/api/worktrees/[id]/auto-yes/route.ts
- **内容**: 厳密比較 (===) + ホワイトリストバリデーション済み。バイパスリスクなし

### SEC4-003: リソース枯渇リスク軽減 (nice_to_have)

- **カテゴリ**: リソース枯渇
- **対象**: src/lib/auto-yes-poller.ts
- **内容**: 冪等化は既存保護を維持しつつリソース消費を削減する改善方向の変更

### SEC4-004: タイミング操作リスク不在 (nice_to_have)

- **カテゴリ**: タイミング攻撃
- **対象**: current-output/route.ts, worktree-status-helper.ts
- **内容**: タイムスタンプはサーバー側メモリで完全管理。外部操作経路なし

### SEC4-005: API レスポンス情報露出 (nice_to_have)

- **カテゴリ**: 情報露出
- **対象**: current-output/route.ts
- **内容**: 既存のデータ露出範囲に変更なし。認証済みユーザーのみアクセス可能

### SEC4-006: tmux インジェクション不在 (nice_to_have)

- **カテゴリ**: tmuxインジェクション (OWASP A03:2021-Injection)
- **内容**: tmux 呼び出しパターンに変更なし。既存サニタイズ機構維持

### SEC4-007: 認証バイパス不在 (nice_to_have)

- **カテゴリ**: 認証・認可 (OWASP A01:2021-Broken Access Control)
- **内容**: 新規エンドポイントなし。既存の認証・バリデーション機構に変更なし

---

## OWASP Top 10 チェックリスト

| OWASP カテゴリ | 該当 | 評価 |
|---------------|------|------|
| A01:2021-Broken Access Control | なし | 認証・認可メカニズムに変更なし |
| A02:2021-Cryptographic Failures | なし | 暗号処理に変更なし |
| A03:2021-Injection | なし | tmux/SQL インジェクション経路に変更なし |
| A04:2021-Insecure Design | なし | 設計パターンはセキュリティ中立 |
| A05:2021-Security Misconfiguration | なし | 設定変更なし |
| A06:2021-Vulnerable and Outdated Components | なし | 新規依存ライブラリなし |
| A07:2021-Identification and Authentication Failures | なし | 認証処理に変更なし |
| A08:2021-Software and Data Integrity Failures | なし | データ整合性に影響なし |
| A09:2021-Security Logging and Monitoring Failures | なし | ログ機構に変更なし |
| A10:2021-Server-Side Request Forgery | なし | 外部リクエスト処理に変更なし |

---

## 結論

設計書のセキュリティ評価「影響なし」は、コード実装の確認に基づき妥当と判断する。既存のセキュリティ機構 (worktreeId バリデーション、cliToolId ホワイトリスト、認証ミドルウェア、tmux サニタイズ、MAX_CONCURRENT_POLLERS 制限) は全て維持され、新たな攻撃面は生じない。must_fix / should_fix の指摘はなく、本設計はセキュリティ観点から承認可能である。
