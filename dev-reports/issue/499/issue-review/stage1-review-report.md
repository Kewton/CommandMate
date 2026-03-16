# Issue #499 レビューレポート

**レビュー日**: 2026-03-15
**フォーカス**: 通常レビュー（整合性・正確性・完全性・明確性・受入条件）
**イテレーション**: 1回目
**Issue タイトル**: perf: Auto-Yes ポーリング性能改善（7項目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 4 |

**総合評価**: Good

Issue本文の7項目は全て仮説検証で確認済みであり、ファイルパス・行番号・関数名のいずれも実コードと正確に整合している。指摘事項は主に実装判断を支援するための根拠補足や方針明確化であり、Issueの品質は高い。

---

## Should Fix（推奨対応）

### F1-001: Item 3 - キャプチャ行数削減の推奨値200行の根拠が不明確

**カテゴリ**: 正確性

**問題**:
stopPattern未設定時のキャプチャ行数を「200行程度」と記載しているが、根拠が示されていない。prompt-detector.tsのスキャンウィンドウは50行だが、rawContent用にRAW_CONTENT_MAX_LINES=200行が必要。単純に200行では不足の可能性がある。

**証拠**:
- `src/lib/detection/prompt-detector.ts` L758: `scanStart = Math.max(0, effectiveEnd - 50)` (50行スキャン)
- `src/lib/detection/prompt-detector.ts` L76: `RAW_CONTENT_MAX_LINES = 200`

**推奨対応**:
300行程度を推奨値とし、根拠（50行スキャン + 200行rawContent + マージン）を明記する。

---

### F1-002: Item 2 - Thinking検出時の推奨間隔の根拠が未記載

**カテゴリ**: 完全性

**問題**:
5-10秒という推奨間隔の根拠がない。Thinkingの典型的な持続時間や応答遅延の許容範囲を踏まえた判断材料が必要。

**推奨対応**:
「Thinkingは通常10-60秒継続し、その間プロンプトは出ない。5秒間隔であればThinking終了後の応答遅延は最大5秒に抑えられる」等の根拠を追記する。

---

### F1-003: Item 4 - split改修のインターフェース変更範囲が不明確

**カテゴリ**: 完全性

**問題**:
detectPrompt()のインターフェースを行配列受け取りに変更する提案だが、既存の呼び出し元への後方互換性影響が未整理。

**推奨対応**:
detectPrompt()の既存インターフェース(string)は維持し、オプショナル引数として事前分割済み行配列を受け取れるようにするアプローチを推奨として明記する。

---

### F1-004: Item 5 - 連続エラー閾値と通知方法が未定義

**カテゴリ**: 完全性

**問題**:
「20回」の根拠と、「ユーザーに通知する」の具体的方法が未定義。AutoYesStopReasonへの新しいreason追加が必要になるが、型変更の影響が未記載。

**証拠**:
- `src/config/auto-yes-config.ts` L43: `AutoYesStopReason = 'expired' | 'stop_pattern_matched'` への追加が必要

**推奨対応**:
閾値20回の根拠（backoff最大60秒 x 20回 = 約20分で自動停止）を明記し、AutoYesStopReasonに`'consecutive_errors'`を追加する方針を記載する。

---

## Nice to Have（あれば良い）

### F1-005: Item 6 - キャッシュTTL変更の副作用考慮

キャッシュTTLを2秒から3秒に変更すると、通常のcapture APIのデータ鮮度が1秒劣化する。許容事項として明記すると実装者の判断が容易になる。

---

### F1-006: Item 3, 4, 6, 7の受入条件にテスト項目なし

受入条件にはItem 1, 2, 5の個別テスト確認項目があるが、残り4項目は「既存テストパス」のみでカバーされている。特にItem 3（キャプチャ行数削減）は動作変更を伴うため、個別テスト追加が望ましい。

---

### F1-007: Item 1の対策案が二択で方針未決定

stripBoxDrawing除去の方針が二択のまま。推奨は `detectAndRespondToPrompt` 内のL318から `stripBoxDrawing()` 呼び出しを除去する方法（cleanOutputは既にstrip済みのため安全）。

---

### F1-008: 関連ファイルにprompt-answer-sender.tsが未記載

`src/lib/prompt-answer-sender.ts` は `detectAndRespondToPrompt()` 内で呼ばれる依存先であり、参照用として関連ファイル一覧への追加が望ましい。

---

## 参照ファイル

### コード
- `src/lib/auto-yes-poller.ts`: 主要改修対象（Item 1, 2, 3, 4, 7）
- `src/lib/auto-yes-state.ts`: 状態管理・定数定義（Item 5, 7）
- `src/config/auto-yes-config.ts`: 設定定数・型定義（Item 2, 5）
- `src/lib/detection/prompt-detector.ts`: プロンプト検出（Item 1, 3, 4）
- `src/lib/tmux/tmux-capture-cache.ts`: キャッシュ管理（Item 6）

### ドキュメント
- `dev-reports/issue/499/issue-review/hypothesis-verification.md`: 仮説検証結果
