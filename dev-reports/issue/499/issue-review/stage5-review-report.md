# Issue #499 レビューレポート（Stage 5）

**レビュー日**: 2026-03-15
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2
**対象Issue**: perf: Auto-Yes ポーリング性能改善（7項目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

**総合評価**: good

Stage 1の8件の指摘のうち7件が完全に対処され、1件が部分的に対処されている。Stage 3（影響範囲レビュー）の指摘も適切に反映されており、Issue全体の品質は高い。残る指摘は実装判断の補足情報であり、Issueとしての実装可能性は十分に確保されている。

---

## 前回指摘（Stage 1）の対応状況

| ID | タイトル | ステータス |
|----|---------|-----------|
| F1-001 | キャプチャ行数200行の根拠不明確 | 対処済み |
| F1-002 | Thinking検出時間隔の根拠未記載 | 対処済み |
| F1-003 | detectPromptインターフェース変更範囲不明確 | 対処済み |
| F1-004 | 連続エラー閾値の根拠と通知方法未記載 | 対処済み |
| F1-005 | キャッシュTTL変更の副作用考慮不足 | 対処済み |
| F1-006 | Item 3,4,6,7の受入条件テスト記載なし | 部分的に対処 |
| F1-007 | Item 1の対策案が二択で未決定 | 対処済み |
| F1-008 | 関連ファイルにprompt-answer-sender.ts未記載 | 対処済み |

---

## Should Fix（推奨対応）

### F5-001: Item 5 consecutive_errorsのUI表示設計が未定義

**カテゴリ**: 整合性

Issue本文ではWorktreeDetailRefactored.tsx L391のstopReason判定に`'consecutive_errors'`分岐を追加するよう記載しているが、stop_pattern_matched（正常系停止）とconsecutive_errors（異常系停止）ではユーザーへの通知レベルが異なるべきである。現在の実装はsetStopReasonPendingというbooleanフラグを立てるのみで、reasonの種類に応じた表示差異の設計が未定義。

**推奨対応**:
stopReasonの種類に応じたUI表示方針を明記する。例: stop_pattern_matchedは情報通知（info）、consecutive_errorsは警告通知（warning）として表示。stopReasonの値自体をstateに保持し、Toast表示時にreasonに応じたメッセージを出し分ける設計とする。

---

### F5-002: Item 3 キャプチャ行数300行の根拠にTHINKING_CHECK_LINE_COUNTが含まれていない

**カテゴリ**: 完全性

Item 3ではキャプチャ行数300行の根拠として、promptDetectorのスキャンウィンドウ(50行)とRAW_CONTENT_MAX_LINES(200行)を列挙しているが、同じpollAutoYes内で使用されるTHINKING_CHECK_LINE_COUNT（auto-yes-state.ts L345で50と定義）が根拠に含まれていない。実際の値は50行であり300行の範囲内のため問題はないが、根拠の網羅性のために追加が望ましい。

**推奨対応**:
Item 3の根拠にTHINKING_CHECK_LINE_COUNT(50行)も追加する。修正後: 「promptDetectorのスキャンウィンドウ(50行) + THINKING_CHECK_LINE_COUNT(50行) + RAW_CONTENT_MAX_LINES(200行) + マージンを考慮し、300行程度を推奨」

---

## Nice to Have（あれば良い）

### F5-003: Item 4 オプショナル引数の具体的シグネチャ案が未記載

**カテゴリ**: 明確性

detectPromptに追加するオプショナル引数の具体的なシグネチャが示されていない。既存のbuildDetectPromptOptions()が返すoptionsオブジェクトにprecomputedLines?: string[]を追加する方式が自然であり、明記すると実装者の判断が容易になる。

---

### F5-004: Item 7の受入条件が個別に記載されていない

**カテゴリ**: 受入条件

F1-006の指摘のうちItem 3,4は対処されたが、Item 7（冗長チェック除去）の個別確認項目が依然として未記載。コードレビュー確認として明記するとより明確になる。

---

## 参照ファイル

### コード
- `src/lib/auto-yes-poller.ts` - 主要変更対象（Item 1,2,3,4,7）
- `src/lib/auto-yes-state.ts` - THINKING_CHECK_LINE_COUNT定義（L345: 50）、Item 5変更対象
- `src/config/auto-yes-config.ts` - AutoYesStopReason型（L43）
- `src/lib/detection/prompt-detector.ts` - RAW_CONTENT_MAX_LINES（L76: 200）、スキャンウィンドウ（L758: 50行）
- `src/lib/tmux/tmux-capture-cache.ts` - CACHE_TTL_MS（L39: 2000）
- `src/components/worktree/WorktreeDetailRefactored.tsx` - stopReason判定（L391）

### ドキュメント
- `CLAUDE.md` - プロジェクト構成・モジュール参照
