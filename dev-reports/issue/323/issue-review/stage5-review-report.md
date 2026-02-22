# Issue #323 レビューレポート (Stage 5)

**レビュー日**: 2026-02-21
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: Stage 5 / 6

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 1 |

## 前回指摘（Stage 1 F001-F005）の対応確認

| 指摘ID | 重要度 | タイトル | 対応状況 |
|--------|--------|---------|---------|
| F001 | must_fix | checkStopCondition()の命名衝突 | **addressed** - `processStopConditionDelta()`に命名変更。既存`checkStopCondition()`との関係を明記 |
| F002 | should_fix | StopConditionCheckerクラスの設計パターン不整合 | **addressed** - 設計選択肢(A)(B)を提示。関数ベース設計との整合性考慮を記載 |
| F003 | should_fix | validatePollingContext()の責務境界不明確 | **addressed** - L457-465のpollerState存在確認+autoYes有効性チェックのみと明記 |
| F004 | should_fix | 機能不変保証の不足 | **addressed** - 受入条件に個別テスト追加要件を追加。テスト方針セクション新設 |
| F005 | should_fix | captureAndCleanOutput()の責務範囲不明確 | **addressed** - captureSessionOutput+stripAnsiまでと明記。戻り値はcleanOutput文字列 |

**評価**: Stage 1の全5件の指摘事項が適切に対応されている。特にF001の命名衝突はmust_fixであったが、`processStopConditionDelta()`への変更と既存関数との関係の明記により完全に解決されている。

---

## Stage 3 指摘（IF001-IF007）の反映確認

| 指摘ID | 重要度 | 対応状況 |
|--------|--------|---------|
| IF001 | should_fix | **applied** - テストファイル変更内容を詳細化 |
| IF002 | should_fix | **applied** - AutoYesPollerStateへの影響を明記 |
| IF003 | must_fix | **applied** - タイマー非依存テスト方針を受入条件に追加 |
| IF004 | nice_to_have | **skipped** - QA計画で管理 |
| IF005 | should_fix | **applied** - processStopConditionDelta()のモック制約を記載 |
| IF006 | should_fix | **applied** - CLAUDE.md更新を変更対象・受入条件に追加 |
| IF007 | nice_to_have | **skipped** - 実装時に自然に採用される見込み |

---

## 新たな指摘事項

### Should Fix

#### S2F001: テストファイルの現在のimport数が「17個」ではなく22個

**カテゴリ**: 正確性
**場所**: Issue本文 > 影響範囲 > 変更対象ファイルテーブル

**問題**:
Issue本文で「import対象が17個→21-25個程度に増加」と記載されているが、現在の`tests/unit/lib/auto-yes-manager.test.ts`（L2-25）のimport対象を実際に数えると22個である。

**証拠**:
テストファイルのimportブロック（L2-25）の内容:
- 関数: getAutoYesState, setAutoYesEnabled, isAutoYesExpired, clearAllAutoYesStates, startAutoYesPolling, stopAutoYesPolling, stopAllAutoYesPolling, getLastServerResponseTimestamp, isValidWorktreeId, calculateBackoffInterval, getActivePollerCount, clearAllPollerStates, disableAutoYes, checkStopCondition, executeRegexWithTimeout (15個)
- 定数: MAX_CONCURRENT_POLLERS, POLLING_INTERVAL_MS, MAX_BACKOFF_MS, MAX_CONSECUTIVE_ERRORS, THINKING_CHECK_LINE_COUNT, COOLDOWN_INTERVAL_MS (6個)
- 型: AutoYesState (1個)
- 合計: 22個

**推奨対応**:
「import対象が17個→21-25個程度に増加」を「import対象が22個→26-30個程度に増加」に修正すること。

---

#### S2F002: detectAndRespondToPrompt()の責務範囲が具体的に定義されていない

**カテゴリ**: 完全性
**場所**: Issue本文 > リファクタリング方針 > 主要な変更点

**問題**:
主要な変更点セクションで `detectAndRespondToPrompt()` は「プロンプト検出・自動応答」とのみ記載されている。しかし現在のpollAutoYes()のL527-582には以下の10ステップが含まれ、他の分割対象関数と比較して責務が集中している。

| ステップ | 行 | 内容 |
|---------|------|------|
| 1 | L528-529 | プロンプト検出（buildDetectPromptOptions + detectPrompt） |
| 2 | L531-536 | no-promptリセット（lastAnsweredPromptKey = null） |
| 3 | L539-543 | 重複チェック（generatePromptKey + isDuplicatePrompt） |
| 4 | L545-551 | 回答解決（resolveAutoAnswer） |
| 5 | L553-566 | tmux送信（CLIToolManager + sendPromptAnswer） |
| 6 | L569 | タイムスタンプ更新 |
| 7 | L572 | エラーカウントリセット |
| 8 | L575 | promptKey記録 |
| 9 | L578 | ログ出力 |
| 10 | L581 | クールダウンスケジューリング |

これらを全て含めると55行以上になり、「各関数が単一責務（20-40行）」の目標と矛盾する可能性がある。一方、captureAndCleanOutput()は実質2行（captureSessionOutput + stripAnsi）、validatePollingContext()は約9行であり、責務のバランスに偏りがある。

**推奨対応**:
detectAndRespondToPrompt()の具体的な責務範囲を明記すること。以下のいずれかの方針を記載:
- (A) L527-582全体を1関数とし、40行目標の例外として扱う
- (B) 内部でさらにsendAndRecordResponse()等のサブ関数に分割する
- (C) no-promptリセット（L531-536）やクールダウンスケジューリング（L581）はpollAutoYes本体に残す

---

### Nice to Have

#### S2F003: thinkingチェック処理（L492-496）の所属関数が不明確

**カテゴリ**: 完全性
**場所**: Issue本文 > リファクタリング方針 > 主要な変更点

**問題**:
pollAutoYes()のL492-496にあるthinkingチェック処理（ウィンドウイング + detectThinking呼び出し）が、分割後のどの関数に所属するかが明記されていない。captureAndCleanOutput()の責務は「captureSessionOutput + stripAnsiまで」と明確化されており、thinkingチェックは含まれない。4-5関数のリストには明示されていないため、以下の3つの解釈が可能:
- (A) pollAutoYes本体に残る
- (B) 独立関数として抽出（例: checkThinkingState()）
- (C) 実装者の裁量に委ねる

**推奨対応**:
実装の自由度を確保する場合はそのままで問題ないが、「thinkingチェックはpollAutoYes本体に残すか、独立関数として抽出するかは実装時に判断」等の一文を追加すると分割設計の完全性が向上する。

---

## 追加の整合性確認結果

以下の項目について、更新後のIssue本文とソースコードの整合性を確認した。

### 確認済み（問題なし）

| 確認項目 | 結果 |
|---------|------|
| ファイル行数（706行） | `wc -l`で705行（最終行の空行有無の差、実質一致） |
| pollAutoYes()の行範囲（L455-593） | L455 `async function pollAutoYes` - L593 `}` で139行、一致 |
| pollAutoYes()の責務数（7つ） | タイマー停止確認、auto-yes有効性チェック、tmux出力キャプチャ、ANSI処理、thinking状態検出、停止条件チェック、プロンプト検出・自動応答の7つ、一致 |
| 外部依存数（6つ） | Issue記載の6つ（captureSessionOutput, detectThinking, detectPrompt, resolveAutoAnswer, sendPromptAnswer, CLIToolManager）に加え、stripAnsi, buildDetectPromptOptions, generatePromptKeyも使用されているが、Issue記載は「全てモック必須」の主要依存として概ね妥当 |
| stopCheckBaselineLengthの初期値（-1） | L660 `stopCheckBaselineLength: -1` で一致 |
| pollerState存在確認の重複箇所（L457, L606, L680等） | L307, L318, L330, L343, L457, L606, L680の7箇所を確認、Issue記載と一致 |
| checkStopCondition()の行番号（L409） | L409 `export function checkStopCondition` で一致 |
| 既存テストのcheckStopConditionテスト位置 | L1299-1342 describe('Issue #314: checkStopCondition') で一致 |
| 関連コンポーネント（変更なし）リスト | server.tsを含む6件、全て確認済み |
| 受入条件の完全性 | 9項目あり、機能不変保証・個別テスト・タイマー非依存・CLAUDE.md更新を全て包含 |

### 条件分岐数について

Issue本文では「条件分岐14個」と記載されている。実際にpollAutoYes()のコードを確認したところ、明確な条件分岐（if/else if/catch）は12個である。14個と数えるには`||`演算子による複合条件（L462の`!autoYesState?.enabled || isAutoYesExpired(autoYesState)`）を2つとして数える等の方法が考えられるが、通常のif文の数え方では12個が正確である。ただし、リファクタリングの動機付けとしては12個でも十分に複雑であり、must_fixには該当しない。

---

## テスト方針セクションの評価

Stage 3の指摘（IF003, IF005）を受けて新設されたテスト方針セクションは、以下の3点を適切に網羅している:

1. **既存テストの維持方針**: vi.useFakeTimers + advanceTimersByTimeAsyncベーステストの全パス要件と、テスト修正は最小限に留める方針
2. **分割関数の個別テスト方針**: タイマー非依存（直接関数呼び出し）での記述要件
3. **processStopConditionDelta()のテスト設計**: 同一モジュール内モック制約の説明と、checkStopCondition()をモック化せず入出力を検証する推奨アプローチ

これらは実装者にとって十分なガイダンスを提供しており、テスト方針の品質は高い。

---

## 受入条件の完全性評価

更新後の受入条件は9項目あり、以下の観点を全てカバーしている:

| 観点 | 対応する受入条件 | 評価 |
|------|-----------------|------|
| 機能不変保証 | 既存テスト全パス + 外部インターフェース維持 | 十分 |
| 分割品質 | 4-5個の単一責務関数 | 十分（ただしS2F002の通り責務バランスの詳細は要検討） |
| テスト品質 | 個別テスト追加 + タイマー非依存 | 十分 |
| 命名整合性 | 既存関数との衝突防止 | 十分 |
| コード品質 | pollerState重複解消 | 十分 |
| ドキュメント | CLAUDE.md更新 | 十分 |

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/auto-yes-manager.ts` | リファクタリング対象メインファイル（705行） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/tests/unit/lib/auto-yes-manager.test.ts` | 既存テスト（1516行、import 22個） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/config/auto-yes-config.ts` | 共有設定（116行、変更不要） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/prompt-answer-sender.ts` | プロンプト応答送信（109行、外部依存） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/src/lib/prompt-key.ts` | プロンプトキー生成（40行、外部依存） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/CLAUDE.md` | プロジェクトガイドライン（更新対象） |

### 前回レビュー結果
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/dev-reports/issue/323/issue-review/stage1-review-result.json` | Stage 1通常レビュー結果（F001-F008） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-323/dev-reports/issue/323/issue-review/stage3-review-result.json` | Stage 3影響範囲レビュー結果（IF001-IF007） |
