# マルチステージ設計レビュー完了報告

## Issue #161: auto yes 実行時、それなりの頻度で"1"が送信される

**レビュー日**: 2026-02-06
**設計方針書**: `dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md`

---

### ステージ別結果

| Stage | レビュー種別 | 指摘数 | Must Fix | Should Fix | Nice to Have | 設計方針書反映 | ステータス |
|-------|------------|-------|----------|------------|--------------|--------------|----------|
| 1 | 通常レビュー（設計原則） | 9 | 2 | 4 | 3 | 9/9件 | ✅ |
| 2 | 整合性レビュー | 10 | 1 | 5 | 4 | 10/10件 | ✅ |
| 3 | 影響分析レビュー | 11 | 2 | 6 | 3 | 11/11件 | ✅ |
| 4 | セキュリティレビュー | 8 | 0 | 5 | 3 | 8/8件 | ✅ |
| **合計** | | **38** | **5** | **20** | **13** | **38/38件** | ✅ |

---

### Must Fix指摘と対応

| ID | Stage | タイトル | 対応内容 |
|----|-------|---------|---------|
| S1-001 | 1 | thinking判定のDRY違反（prompt-detector.tsとauto-yes-manager.tsで二重実行） | prompt-detector.ts内のthinking判定を削除、auto-yes-manager.ts側のみに集約 |
| S1-002 | 1 | CLAUDE_THINKING_PATTERNのimportによるSRP/OCP違反 | prompt-detector.tsのCLIツール非依存性を維持 |
| S2-001 | 2 | normalOptionPatternのコンテキスト制約と検出ロジックの不整合 | 2パス検出方式を採用（Pass 1: ❯存在確認、Pass 2: 選択肢収集） |
| S3-001 | 3 | API routeファイル3件がdetectPrompt()呼び出し元として漏れている | Section 7.1に3件追加（worktrees/route.ts, [id]/route.ts, current-output/route.ts） |
| S3-002 | 3 | サーバー・クライアント重複防止メカニズムの確認 | Section 6に3秒タイムスタンプウィンドウが影響を受けない旨を追記 |

---

### 主な設計改善点

1. **2パス検出方式の導入**（S2-001）
   - Pass 1: 50行ウィンドウ内で❯インジケーターの存在を確認
   - Pass 2: ❯が存在する場合のみ、選択肢行を収集
   - 効果: 通常の番号付きリストがoptions配列に蓄積されるのを根本的に防止

2. **thinking判定の呼び出し元への集約**（S1-001/S1-002）
   - prompt-detector.tsはCLIツール非依存を維持
   - auto-yes-manager.tsでdetectThinking()による事前チェックを実施
   - SRP/OCP/DRY原則に準拠

3. **連番検証（防御的措置）**（S1-005）
   - MustからShouldに優先度変更
   - 実際のIssue #161パターンは1始まり連番のため、これ単体では防止不可
   - 将来の未知パターンに対する防御層として実装

4. **影響範囲の網羅的な特定**（S3-001/S1-006）
   - detectPrompt()の全呼び出し元（7ファイル+APIルート3ファイル）を特定
   - 各呼び出し元のthinking判定方式の違いを明記
   - UI下流コンポーネントへの影響も確認

5. **セキュリティ考慮事項の文書化**（S4-001〜S4-008）
   - 正規表現のReDoS耐性を確認
   - コマンドインジェクション防御を確認
   - Auto-Yesの自動承認リスクを文書化

---

### セキュリティ評価

| 項目 | 結果 |
|------|------|
| ReDoS耐性 | ✅ 提案パターンはアンカー付きで安全 |
| コマンドインジェクション | ✅ resolveAutoAnswer()の出力が'y'または数値に制限 |
| 入力検証 | ✅ stripAnsi()による事前処理が適切 |
| ログ出力 | ✅ 機密情報の出力なし |
| OWASP Top 10 | ✅ 違反なし |

---

### スコープ外の技術的負債

| 項目 | 関連ID | 説明 |
|------|--------|------|
| yes/noパターンのDRY改善 | S1-003 | detectPrompt()内のPattern 1-4を配列ループ方式にリファクタリング |
| claude-poller.tsのthinkingPattern統一 | S1-008 | ローカルthinkingPatternをdetectThinking()に統一 |
| detectMultipleChoicePrompt()の責務分割 | S1-009 | parse/validate/buildへの分割リファクタリング |
| 重複防止メカニズム強化 | S3-002 | 3秒ウィンドウからprompt ID/ハッシュベースへ |
| resolveAutoAnswer()出力アサーション | S4-003 | sendKeys()前の防御的検証追加 |
| Auto-Yesの破壊的操作制御 | S4-006 | yes/no以外の選択肢やタイムアウト導入 |

---

### 変更対象ファイル（確定版）

| ファイル | 変更内容 | 変更規模 |
|---------|----------|----------|
| `src/lib/prompt-detector.ts` | 2パス検出、❯パターン分離、連番検証 | 中 |
| `src/lib/auto-yes-manager.ts` | thinking判定の事前チェック追加 | 小 |
| `src/lib/status-detector.ts` | detectPrompt前のthinkingチェック追加（必要に応じて） | 小 |
| `tests/unit/prompt-detector.test.ts` | 誤検出防止・回帰・境界テスト追加 | 中 |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 回帰テスト確認 | 小 |
| `tests/unit/lib/auto-yes-manager.test.ts` | thinking判定テスト追加 | 小 |

---

### 次のアクション

1. 設計方針書のレビュー・承認
2. `/tdd-impl` または `/pm-auto-dev` で実装を開始（TDDアプローチ: 回帰テストを先に作成）
3. CI品質チェック（lint, type-check, test, build）
4. `/create-pr` でPR作成
