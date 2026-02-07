# Issue #180 レビューレポート

**レビュー日**: 2026-02-07
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 6 |
| Nice to Have | 3 |
| **合計** | **10** |

---

## Must Fix（必須対応）

### S1-003: 修正案の技術的記述が不完全

**カテゴリ**: 正確性
**場所**: ## 修正案

**問題**:
修正案に記載されている現在のコードスニペットは概ね正確だが、提案する「改善案」が問題の全体像をカバーしていない。修正案は検出優先順位の変更（まず末尾の入力プロンプトをチェック）を提案しているが、`detectPrompt()` 関数の内部検索範囲（yes/no系: 最後10行、multiple_choice系: 最後50行）自体が問題の一端であるにもかかわらず、この点に言及がない。

現在のコードでは以下の2段階構造で検索が行われている:
1. `captureSessionOutput(worktreeId, cliToolId, 100)` -- tmuxバッファの最後100行を取得
2. `detectPrompt(cleanOutput)` -- 100行分の出力の最後10行/50行を検索

修正案は優先順位変更のみを記述しており、`detectPrompt()` の検索範囲制限や末尾位置検証については触れていない。

**証拠**:
- `src/lib/prompt-detector.ts` 行48: `const lastLines = lines.slice(-10).join('\n');`
- `src/lib/prompt-detector.ts` 行268: `const scanStart = Math.max(0, lines.length - 50);`
- `src/app/api/worktrees/route.ts` 行58: `captureSessionOutput(worktree.id, cliToolId, 100)`

**推奨対応**:
修正案を以下の2つの軸で整理すべき:
1. 検出優先順位の変更（末尾の入力プロンプト❯の確認を最優先）
2. `detectPrompt()` の検索範囲制限または末尾位置検証の追加

---

## Should Fix（推奨対応）

### S1-001: Issueタイトルのスコープが不正確

**カテゴリ**: 正確性
**場所**: Issueタイトル

**問題**:
タイトルが「モバイルステータス表示の不整合」とモバイル固有の問題として記述されているが、根本原因はAPI層（`/api/worktrees/route.ts`、`/api/worktrees/[id]/route.ts`）のステータス検出ロジックにある。このAPIレスポンスはデスクトップ表示（`WorktreeDetailRefactored.tsx` の `deriveWorktreeStatus()`）でも同一のデータを使用しているため、問題はプラットフォーム非依存である。

**証拠**:
- `src/components/worktree/WorktreeDetailRefactored.tsx` 行107-118: `deriveWorktreeStatus()` がAPI由来の `sessionStatusByCli` を参照
- `src/types/sidebar.ts` 行30-38: `deriveCliStatus()` も同一のAPIデータを使用
- `src/components/sidebar/BranchListItem.tsx` 行94-96: サイドバーでも `cliStatus` を表示

**推奨対応**:
タイトルを「fix: ステータス表示の不整合 - CLIがidle状態でもrunning/waitingと誤表示」のように修正するか、モバイルでのみ顕在化する固有条件があるならその理由を明記する。

---

### S1-002: 影響範囲の漏れ（[id]/route.ts）

**カテゴリ**: 完全性
**場所**: ## 影響範囲

**問題**:
影響範囲に `src/app/api/worktrees/route.ts` のみが記載されているが、完全に同一のステータス検出ロジックが `src/app/api/worktrees/[id]/route.ts` にも重複して存在する。

**証拠**:
- `src/app/api/worktrees/route.ts` 行47-100: ステータス検出ロジック
- `src/app/api/worktrees/[id]/route.ts` 行47-100: 同一のステータス検出ロジック（コピー＆ペースト）

**推奨対応**:
影響範囲に `src/app/api/worktrees/[id]/route.ts` を追加する。また、ロジック重複の解消（共通関数への抽出）も修正方針として検討すべき。

---

### S1-004: 検出アーキテクチャの説明不足

**カテゴリ**: 明確性
**場所**: ## 根本原因 > 問題1

**問題**:
「detectPrompt() が最後10-50行を検索」という記述は正確だが、`captureSessionOutput()` がtmuxバッファの最後100行を取得し、その100行分の出力に対して `detectPrompt()` が更に最後10行/50行を検索するという2段階構造が明確ではない。

**推奨対応**:
「captureSessionOutput() がtmuxバッファの最後100行を取得 → detectPrompt() がその中の最後10行（yes/no）/ 最後50行（multiple_choice）を検索」という構造を明記する。

---

### S1-005: 受け入れ条件の欠如

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
テスト可能な受け入れ条件が定義されていない。「期待される動作」セクションは存在するが、検証可能な条件としては不十分。

**推奨対応**:
以下の受け入れ条件を追加する:
1. ❯プロンプトが出力末尾にある場合 → ready 表示であること
2. 過去の(y/n)プロンプトがスクロールバックに残っていても、末尾が❯の場合 → ready 表示であること
3. thinking インジケーターが末尾にある場合 → running 表示であること
4. (y/n)プロンプトが末尾にある場合 → waiting 表示であること
5. 既存テスト（`tests/unit/prompt-detector.test.ts`）が全てパスすること

---

### S1-007: 優先順位変更のトレードオフ未検討

**カテゴリ**: 技術的妥当性
**場所**: ## 修正案

**問題**:
修正案で「まず最後2-3行で入力プロンプト(❯)をチェック → ready」とあるが、この変更により `detectPrompt()`（インタラクティブプロンプト検出）よりも入力プロンプト検出が先に実行されることになる。❯プロンプトとyes/noプロンプトが近接して表示されている場合のトレードオフが検討されていない。

**推奨対応**:
優先順位変更のエッジケースを明確にする。例えば「(y/n) の直後に ❯ が出ている場合はreadyとみなすのか」「❯ の後に (y/n) が出ている場合は」等を定義する。

---

### S1-010: 修正方式の選択肢が未整理

**カテゴリ**: 技術的妥当性
**場所**: ## 修正案

**問題**:
route.ts 側で事前に末尾数行に制限してから `detectPrompt()` に渡すのか、`detectPrompt()` 内部のスライス範囲を変更するのか、末尾位置検証を追加するのかが不明確。

**推奨対応**:
以下の選択肢を整理し、採用方式を明記する:
- (A) route.ts 側で末尾N行に切り出してから detectPrompt() に渡す方式
- (B) detectPrompt() 内部の検索範囲を制限する方式
- (C) detectPrompt() に「検出されたプロンプトが出力末尾にあるか」の検証を追加する方式

---

## Nice to Have（あれば良い）

### S1-006: auto-yes-manager.ts への影響言及

**カテゴリ**: 完全性
**場所**: ## 影響範囲

**問題**:
`auto-yes-manager.ts` のポーリングロジック（`pollAutoYes` 関数、行290）も `detectPrompt()` を使用しており、同様の誤検出リスクがある。ただし Layer 1（thinking状態スキップ）による防御がある点が異なる。

**推奨対応**:
`auto-yes-manager.ts` を関連影響範囲として追記し、今回の修正がauto-yesポーリングにも波及するかどうかを明記する。

---

### S1-008: スクリーンショット未添付

**カテゴリ**: 完全性
**場所**: ## スクリーンショット

**問題**:
「調査時に確認した問題」のテキスト記述はあるが、実際のスクリーンショット画像が添付されていない。

**推奨対応**:
問題が発生している状態のスクリーンショットを添付する。

---

### S1-009: 関連Issueの不足

**カテゴリ**: 完全性
**場所**: ## 関連

**問題**:
直接的に関連する Issue #161（Auto-Yes誤検出修正、prompt-detector.ts の2パス検出方式導入）および Issue #152（プロンプト検出強化）への参照がない。

**推奨対応**:
関連Issueに以下を追加する:
- Issue #161（Auto-Yes誤検出修正 -- prompt-detector.ts への変更）
- Issue #152（セッション初回メッセージ送信の信頼性向上 -- プロンプト検出強化）

---

## 参照ファイル

### コード
| ファイルパス | 関連性 |
|------------|--------|
| `src/app/api/worktrees/route.ts` | ステータス検出ロジック（修正対象） |
| `src/app/api/worktrees/[id]/route.ts` | 同一ステータス検出ロジック（修正対象だがIssue未記載） |
| `src/lib/prompt-detector.ts` | プロンプト検出関数（修正対象） |
| `src/lib/cli-patterns.ts` | thinking検出、promptPattern定義 |
| `src/lib/cli-session.ts` | captureSessionOutput 関数 |
| `src/lib/auto-yes-manager.ts` | detectPrompt 使用箇所（影響確認必要） |
| `src/types/sidebar.ts` | deriveCliStatus -- ステータスUI変換 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | deriveWorktreeStatus -- デスクトップ/モバイル共通 |
| `src/components/mobile/MobileHeader.tsx` | モバイルヘッダーのステータス表示 |
| `src/config/status-colors.ts` | ステータス色定義 |

### テスト
| ファイルパス | 関連性 |
|------------|--------|
| `tests/unit/prompt-detector.test.ts` | 既存プロンプト検出テスト（回帰確認必要） |
| `tests/unit/lib/auto-yes-manager.test.ts` | auto-yes 関連テスト |
