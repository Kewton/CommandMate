# マルチステージ設計レビュー完了報告

## Issue #11: バグ原因調査目的のデータ収集機能強化

---

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（設計原則） | 10 (MF:2, SF:5, C:3) | 10/10 | ✅ |
| 2 | 整合性レビュー | 10 (MF:2, SF:5, C:3) | 10/10 | ✅ |
| 3 | 影響分析レビュー | 9 (MF:2, SF:4, C:3) | 9/9 | ✅ |
| 4 | セキュリティレビュー | 10 (MF:2, SF:4, C:4) | 10/10 | ✅ |

---

## 統計

- **総指摘数**: 39件
- **対応完了**: 39件
- **スキップ**: 0件

---

## ステージ別主要改善事項

### Stage 1: 通常レビュー（設計原則）

**スコア**: 4/5 - conditionally_approved

**Must Fix**:
- **MF-001**: ApiHandler型をジェネリクス化（`ApiHandler<P extends Record<string, string>>`）で型安全性確保
- **MF-002**: 統合テスト修正方針を詳細化（fs/promises、.md統一、worktreeIdプレフィックス検証）

**Should Fix**:
- **SF-001**: `?sanitize=true`のSRP維持（条件分岐1行限定、ロジック分離）
- **SF-002**: SanitizeRuleを「Strategyパターン」→「ルールベースパターン」に改名
- **SF-003**: withLogging()のPhase 2を別Issueに切り出し（YAGNI原則）
- **SF-004**: LOG_DIR一元化のため`src/config/log-config.ts`新規追加（DRY原則）
- **SF-005**: `escapeRegex()`を`src/lib/utils.ts`に配置

**Consider**:
- **C-001**: withLogging()の環境変数制御拡張ポイント
- **C-002**: Facadeパターン命名の精緻化
- **C-003**: サニタイズルールのユーザー名パターン省略判断

---

### Stage 2: 整合性レビュー

**スコア**: 4/5 - conditionally_approved

**Must Fix**:
- **S2-MF-001**: 既存の`escapeRegExp()`を再利用（utils.ts 60行目）、JSDoc更新が必要
- **S2-MF-002**: paramsのPromise/非Promise混在状態を文書化、withLogging()内でparams非使用方針

**Should Fix**:
- **S2-SF-001**: api-client.tsのcliToolId型欠落の正確な記述
- **S2-SF-002**: 統合テストのモック戦略詳細化（log-manager.ts経由のファイルアクセス）
- **S2-SF-003**: NODE_ENV=testでのwithLogging()動作明確化
- **S2-SF-004**: LogViewer.tsxのインライン正規表現エスケープを既知の技術的負債として明記
- **S2-SF-005**: Markdownログ構造例の修正（log-manager.ts実装と一致）

**Consider**:
- **S2-C-001**: Phase 2 Issueでparams型統一を前提条件化
- **S2-C-002**: mermaidノードID修正
- **S2-C-003**: hostname取得方法（`os.hostname()`）の明記

---

### Stage 3: 影響分析レビュー

**スコア**: 4/5 - conditionally_approved

**Must Fix**:
- **S3-MF-001**: Phase 1を2ファイル3ハンドラーに明確化（`logs/route.ts` GET、`logs/[filename]/route.ts` GET/DELETE）
- **S3-MF-002**: 統合テストのfs/promisesモック関数を詳細化（access/mkdir/readdir/stat/readFile）

**Should Fix**:
- **S3-SF-001**: 依存関係チェーン分析（循環依存なし）、`npm run build`検証追加
- **S3-SF-002**: getLogFile()の呼び出し箇所は1箇所のみ（LogViewer.tsx 75行目）
- **S3-SF-003**: escapeRegExp() JSDoc更新時のSEC-MF-001保持指針
- **S3-SF-004**: Phase 2用に7つのPromise paramsファイルを列挙（コスト見積もり用）

**Consider**:
- **S3-C-001**: os.hostname()モックガイダンス
- **S3-C-002**: mermaidダイアグラム改善
- **S3-C-003**: 将来のルール数増加時のパフォーマンス考慮

---

### Stage 4: セキュリティレビュー

**スコア**: 4/5 - conditionally_approved

**Must Fix**:
- **S4-MF-001**: LogViewer.tsxのXSS対策として`escapeHtml()`関数を新規追加（Section 3-4）
- **S4-MF-002**: SENSITIVE_PATTERNS相当のルールをサニタイザーに追加（Bearerトークン、パスワード、SSHキー等5カテゴリ）

**Should Fix**:
- **S4-SF-001**: withLogging()に`skipResponseBody`オプション追加（ファイルコンテンツのログ出力防止）
- **S4-SF-002**: デフォルト非サニタイズの意図的設計を文書化
- **S4-SF-003**: エラーレスポンスの情報開示ポリシー明記
- **S4-SF-004**: ホスト名マスキングのスコープ（`os.hostname()`のみ、IPアドレスは対象外）

**Consider**:
- **S4-C-001**: ANSI除去後のXSSリスク低減評価
- **S4-C-002**: レート制限の将来的検討
- **S4-C-003**: サニタイズバイパスの監査ログ検討
- **S4-C-004**: 環境変数ホワイトリスト方式の検討

**新規追加**:
- **Section 6-6**: OWASP Top 10チェックリスト

---

## 設計方針書の主要な拡張

### 新規セクション追加

1. **Section 3-4**: `escapeHtml()`関数設計（XSS対策）
2. **Section 6-5**: XSSリスク/緩和策テーブル
3. **Section 6-6**: OWASP Top 10チェックリスト

### 新規モジュール追加

| モジュール | 目的 | 理由 |
|-----------|------|------|
| `src/config/log-config.ts` | LOG_DIR一元管理 | DRY原則（SF-004） |
| `src/lib/utils.ts` の `escapeRegExp()` | 正規表現エスケープ | 既存関数の再利用（S2-MF-001） |
| `src/lib/utils.ts` の `escapeHtml()` | HTMLエスケープ | XSS対策（S4-MF-001） |

### 機能拡張

| 機能 | 拡張内容 |
|------|---------|
| `log-export-sanitizer.ts` | SENSITIVE_PATTERNSルール追加（S4-MF-002） |
| `WithLoggingOptions` | `skipResponseBody`オプション追加（S4-SF-001） |
| `ApiHandler` | ジェネリクス型化（MF-001） |

### テスト強化

| テスト対象 | 追加内容 |
|-----------|---------|
| `api-logs.test.ts` | fs/promisesモック詳細化、worktreeIdプレフィックス検証（MF-002） |
| `log-export-sanitizer.test.ts` | SENSITIVE_PATTERNSテストケース7件追加（S4-MF-002） |
| `api-logger.test.ts` | ジェネリクス型推論テスト、skipResponseBodyテスト（MF-001, S4-SF-001） |
| `LogViewer-export.test.ts` | XSSテストケース追加（S4-MF-001） |

---

## 最終検証結果

設計方針書は全4段階のレビューを完了し、39件の指摘事項がすべて反映されました。

**品質指標**:
- **設計原則準拠**: ✅ SOLID/KISS/YAGNI/DRY
- **整合性**: ✅ 既存コードベースとの整合性確保
- **影響範囲**: ✅ 明確なスコープ定義（Phase 1: 2ファイル3ハンドラー）
- **セキュリティ**: ✅ OWASP Top 10準拠、XSS/情報漏洩対策完備

---

## 変更ファイル一覧（設計方針書）

- **更新済み**: `dev-reports/design/issue-11-data-collection-design-policy.md`

**主要な追加セクション**:
- Section 3-4: escapeHtml()関数設計
- Section 6-5: XSSリスク/緩和策
- Section 6-6: OWASP Top 10チェックリスト
- Section 12: レビュー指摘事項サマリー（全4ステージ）
- Section 13: 実装チェックリスト（詳細化）
- Section 14: レビュー履歴

---

## 次のアクション

- [x] 設計方針書の4段階レビュー完了
- [ ] 作業計画立案（`/work-plan`）
- [ ] TDD実装開始（`/tdd-impl` または `/pm-auto-dev`）

---

## 関連ファイル

- **設計方針書**: `dev-reports/design/issue-11-data-collection-design-policy.md`
- **Stage 1 レビュー結果**: `dev-reports/issue/11/multi-stage-design-review/stage1-review-result.json`
- **Stage 1 反映結果**: `dev-reports/issue/11/multi-stage-design-review/stage1-apply-result.json`
- **Stage 2 レビュー結果**: `dev-reports/issue/11/multi-stage-design-review/stage2-review-result.json`
- **Stage 2 反映結果**: `dev-reports/issue/11/multi-stage-design-review/stage2-apply-result.json`
- **Stage 3 レビュー結果**: `dev-reports/issue/11/multi-stage-design-review/stage3-review-result.json`
- **Stage 3 反映結果**: `dev-reports/issue/11/multi-stage-design-review/stage3-apply-result.json`
- **Stage 4 レビュー結果**: `dev-reports/issue/11/multi-stage-design-review/stage4-review-result.json`
- **Stage 4 反映結果**: `dev-reports/issue/11/multi-stage-design-review/stage4-apply-result.json`

---

*Generated by multi-stage-design-review command*
*Date: 2026-02-10*
