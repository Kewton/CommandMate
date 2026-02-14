# マルチステージ設計レビュー完了報告

## Issue #265: Claude CLIパスキャッシュの無効化と壊れたtmuxセッションの自動回復

**レビュー実施日**: 2026-02-14

---

## ステージ別結果

| Stage | レビュー種別 | フォーカス | 指摘数 (Must/Should/Consider) | 対応数 | ステータス | スコア |
|-------|------------|-----------|-------------------------------|-------|-----------|--------|
| 1 | 通常レビュー | 設計原則（SOLID/KISS/YAGNI/DRY） | 2/4/3 | 9/9 | ✅ 条件付き承認 | 4/5 |
| 2 | 整合性レビュー | 設計書と実装の整合性 | 2/5/3 | 10/10 | ✅ 条件付き承認 | 4/5 |
| 3 | 影響分析レビュー | 変更の波及効果 | 2/5/3 | 10/10 | ✅ 条件付き承認 | 4/5 |
| 4 | セキュリティレビュー | OWASP Top 10準拠 | 1/4/3 | 8/8 | ✅ 条件付き承認 | 4/5 |
| **合計** | - | - | **7/18/12** | **37/37** | ✅ **全ステージ完了** | **4/5** |

---

## 主要な指摘事項サマリー

### Stage 1: 設計原則レビュー

#### Must Fix (2件)
- **MF-001**: エラーパターンのハードコード → cli-patterns.ts に定数として定義
- **MF-002**: シェルプロンプト検出が拡張に閉じていない → SHELL_PROMPT_ENDINGS 定数配列化

#### Should Fix (4件)
- **SF-001**: capturePane + stripAnsi パターンの重複 → getCleanPaneOutput() ヘルパー追加
- **SF-002**: startClaudeSession() の責務肥大化 → ensureHealthySession() / sanitizeSessionEnvironment() に分離
- **SF-003**: daemon.ts での process.env 直接操作 → env オブジェクト経由に変更
- **SF-004**: Bug 3 の2段階対策の過剰防御 → 検証テスト追加、100ms 待機理由の明記

---

### Stage 2: 整合性レビュー

#### Must Fix (2件)
- **MF-S2-001**: getCleanPaneOutput() の適用範囲が不明確 → 全4箇所への適用を明示
- **MF-S2-002**: catch ブロックでのキャッシュクリア粒度 → 全エラー時クリアの判断根拠を明記

#### Should Fix (5件)
- **SF-S2-001**: 型宣言スタイル不一致 → readonly + as const を採用
- **SF-S2-002**: SHELL_PROMPT_ENDINGS 配置先未確定 → claude-session.ts 内定数に確定
- **SF-S2-003**: sanitizeSessionEnvironment 呼出位置未記載 → createSession() 直後と明示
- **SF-S2-004**: ensureHealthySession フロー制御不明確 → 既存 early return パターンとの統合方法を明示
- **SF-S2-005**: @internal JSDoc パターン → version-checker.ts の先例に準拠

---

### Stage 3: 影響分析レビュー

#### Must Fix (2件)
- **MF-S3-001**: isClaudeRunning() がヘルスチェックなし → isSessionHealthy() 呼び出しを追加
- **MF-S3-002**: tmux set-environment -g -u のグローバルスコープ → 許容根拠を明記

#### Should Fix (5件)
- **SF-S3-001**: restartClaudeSession() の二重回復パス → 設計根拠を記載
- **SF-S3-002**: 既存テスト25件以上でのモック変化 → 影響対応計画を追加
- **SF-S3-003**: clearCachedClaudePath() export による公開 API 拡張 → 管理方針を明記
- **SF-S3-004**: sanitizeSessionEnvironment() の 100ms 待機がタイムアウトマージンに与える影響 → 明記
- **SF-S3-005**: cli-patterns.ts への新定数追加の影響 → 9インポート元に影響なしを確認

---

### Stage 4: セキュリティレビュー

#### Must Fix (1件)
- **SEC-MF-001**: CLAUDE_PATH 環境変数の未検証使用 → isValidClaudePath() 検証関数を追加

#### Should Fix (4件)
- **SEC-SF-001**: sessionName バリデーションチェーンの文書化 → JSDoc に記載
- **SEC-SF-002**: エラーメッセージのサニタイズ → API層でのエラーメッセージサニタイズ方針を追加
- **SEC-SF-003**: tmux グローバルスコープの移行トリガー → コメントに明記
- **SEC-SF-004**: パターンマッチング依存のフォールバック → CLAUDE_INIT_TIMEOUT との関係を文書化

---

## 生成ファイル

### 設計方針書（更新済み）
- `dev-reports/design/issue-265-claude-session-recovery-design-policy.md`

### レビュー結果
- `dev-reports/issue/265/multi-stage-design-review/stage1-review-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage1-apply-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage2-review-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage2-apply-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage3-review-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage3-apply-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage4-review-result.json`
- `dev-reports/issue/265/multi-stage-design-review/stage4-apply-result.json`

### 詳細レポート
- `dev-reports/review/2026-02-14-issue265-design-principles-review-stage1.md`
- `dev-reports/review/2026-02-14-issue265-consistency-review-stage2.md`
- `dev-reports/review/2026-02-14-issue265-impact-analysis-review-stage3.md`
- `dev-reports/review/2026-02-14-issue265-security-review-stage4.md`

---

## 設計方針書の主要な更新内容

### 追加されたセクション

1. **共通ヘルパー関数**:
   - `getCleanPaneOutput()` - capturePane + stripAnsi の共通化
   - `isValidClaudePath()` - CLAUDE_PATH 環境変数の検証

2. **責務分離ヘルパー**:
   - `ensureHealthySession()` - セッション健全性保証
   - `sanitizeSessionEnvironment()` - 環境変数サニタイズ

3. **定数の追加**:
   - `CLAUDE_SESSION_ERROR_PATTERNS` - エラーパターン定数（cli-patterns.ts）
   - `CLAUDE_SESSION_ERROR_REGEX_PATTERNS` - 正規表現エラーパターン（cli-patterns.ts）
   - `SHELL_PROMPT_ENDINGS` - シェルプロンプト検出配列（claude-session.ts）

4. **セキュリティ設計の強化**:
   - CLAUDE_PATH バリデーション（コマンドインジェクション防止）
   - sessionName バリデーションチェーンの文書化
   - エラーメッセージサニタイズ方針
   - OWASP Top 10 準拠チェックリスト

### 拡張されたタスク

**実装タスク**: 8個 → 21個
- 新規追加タスク: `isClaudeRunning()` ヘルスチェック統合、CLAUDE_PATH 検証、エラーメッセージサニタイズ など

**テストケース**: 7個 → 27個
- 新規追加テスト: ヘルスチェック、セキュリティバリデーション、整合性チェック など

---

## 次のアクション

### 完了したこと
- ✅ 4段階の設計レビュー完了
- ✅ 全指摘事項（37件）を設計方針書に反映
- ✅ 設計方針書の品質を段階的に向上

### これから行うこと
- [ ] 設計方針書の最終レビュー
- [ ] `/work-plan` で作業計画を立案
- [ ] `/tdd-impl` または `/pm-auto-dev` で TDD 実装を開始

---

## まとめ

Issue #265 の設計方針書に対して4段階のマルチステージレビューを実施しました。

**総指摘数**: 37件（Must Fix 7件、Should Fix 18件、Consider 12件）
**反映率**: 100%（37/37件）
**最終スコア**: 4/5（全ステージで条件付き承認）

設計方針書は以下の観点で段階的に改善されました:
1. **設計原則への準拠**（SOLID/KISS/YAGNI/DRY）
2. **既存実装との整合性**
3. **影響範囲の適切な管理**
4. **セキュリティ上の懸念の解決**

これにより、実装時のリスクが大幅に低減され、高品質なコード実装の基盤が整いました。
