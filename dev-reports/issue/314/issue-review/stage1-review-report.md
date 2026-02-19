# Issue #314 Stage 1 レビューレポート

**レビュー日**: 2026-02-19
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 7 |
| Nice to Have | 2 |
| **合計** | **12** |

---

## Must Fix（必須対応）

### S1-F001: 変更対象ファイルテーブルにi18nファイルが未記載

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > ### 変更対象ファイル テーブル

**問題**:
実装タスクに「i18n対応（ja/en: ラベル、プレースホルダー、通知メッセージ）」と明記されているが、変更対象ファイルテーブルに `locales/ja/autoYes.json` と `locales/en/autoYes.json` が記載されていない。既存のautoYes名前空間にStop条件のラベル（例: stopCondition, stopConditionPlaceholder, stoppedByPattern等）を追加する必要がある。

**証拠**:
- 実装タスク10番目: 「i18n対応（ja/en: ラベル、プレースホルダー、通知メッセージ）」
- 既存i18nファイル: `locales/ja/autoYes.json`（19キー）、`locales/en/autoYes.json`（19キー）
- 変更対象ファイルテーブル: 7ファイルのみ記載、i18nファイルなし

**推奨対応**:
変更対象ファイルテーブルに以下2行を追加:

| ファイル | 変更内容 |
|---------|---------|
| `locales/ja/autoYes.json` | Stop条件ラベル・プレースホルダー・停止通知メッセージの日本語翻訳キー追加 |
| `locales/en/autoYes.json` | Stop条件ラベル・プレースホルダー・停止通知メッセージの英語翻訳キー追加 |

---

### S1-F002: Stop条件によるAuto-Yes停止時のクライアント通知メカニズムが未設計

**カテゴリ**: 完全性
**場所**: ## 受入条件 > 4番目の項目 / ## 提案する解決策 > ### サーバーサイド

**問題**:
受入条件に「Auto-Yesが停止した際にユーザーに通知される（トースト or AutoYesToggle上の通知）」とあるが、現在のアーキテクチャではクライアントがAuto-Yesの停止「理由」を知る手段がない。

現在の `current-output` APIレスポンスは以下の形状:
```typescript
autoYes: {
  enabled: boolean;
  expiresAt: number | null;
}
```

この形状では、`enabled: false` が返された際に「時間切れ」「Stop条件マッチ」「手動OFF」のいずれで停止したかを区別できない。トースト通知（「Stop条件にマッチしたためAuto-Yesを停止しました」）を表示するためには、停止理由のフィールドが必要。

**証拠**:
- `src/app/api/worktrees/[id]/current-output/route.ts` L128-131: autoYesレスポンスに `stopReason` フィールドなし
- `src/components/worktree/WorktreeDetailRefactored.tsx` L1037-1041: autoYes状態更新時に停止理由の処理なし
- `src/lib/auto-yes-manager.ts` L22-29: AutoYesStateに停止理由フィールドなし

**推奨対応**:
1. `AutoYesState` に `stopReason?: 'expired' | 'stop_pattern_matched' | 'manual'` フィールドを追加
2. `current-output` APIレスポンスの `autoYes` オブジェクトに `stopReason` を含める
3. `WorktreeDetailRefactored` で `stopReason === 'stop_pattern_matched'` を検出してトースト通知表示
4. 変更対象ファイルテーブルに `src/app/api/worktrees/[id]/current-output/route.ts` を追加

---

### S1-F003: useAutoYes.tsの変更内容が実際のデータフローと矛盾

**カテゴリ**: 正確性
**場所**: ## 影響範囲 > ### 変更対象ファイル > `src/hooks/useAutoYes.ts`

**問題**:
変更対象ファイルテーブルに `src/hooks/useAutoYes.ts` は「stopPatternの状態管理追加」として記載されている。しかし、`useAutoYes.ts` はクライアントサイドの自動応答フック（プロンプト検出後にfetchで応答を送信する）であり、stopPatternの「状態管理」を行う場所としては不適切。

stopPatternの実際のデータフローは:
1. `AutoYesConfirmDialog` (入力) -> `AutoYesToggle` (中継) -> `WorktreeDetailRefactored.handleAutoYesToggle` (API呼び出し) -> `route.ts` (サーバー受信) -> `auto-yes-manager.ts` (保存・照合)

`useAutoYes.ts` はこのフローに関与しない。

**証拠**:
- `src/hooks/useAutoYes.ts`: `UseAutoYesParams` にstopPattern関連パラメータなし、`resolveAutoAnswer` + `fetch` によるプロンプト応答のみ
- データフロー: `WorktreeDetailRefactored.handleAutoYesToggle` (L1188-1203) が直接 `/api/worktrees/${worktreeId}/auto-yes` を呼び出し、useAutoYesを経由しない

**推奨対応**:
`useAutoYes.ts` の変更内容を再検討する。stopPatternはサーバーサイドで管理されるため、useAutoYes.ts自体の変更は不要の可能性が高い。変更が不要であれば「変更なし」に修正するか、テーブルから削除する。

---

## Should Fix（推奨対応）

### S1-F004: ReDoS対策の具体的な実装方針が曖昧

**カテゴリ**: 明確性
**場所**: ## セキュリティ考慮 > ReDoS対策

**問題**:
「タイムアウト付き実行またはパターン複雑度チェックを適用する」と記載されているが、Node.jsにはネイティブの正規表現タイムアウト機能がなく、具体的な実装手法が不明確。

**推奨対応**:
- 方針A（推奨）: `safe-regex2` ライブラリでパターン安全性を検証 + 最大長500文字制限
- 方針B: `new RegExp(pattern)` try-catch構文検証 + 最大長制限 + マッチ対象の行数制限
- `MAX_STOP_PATTERN_LENGTH` 定数は `src/config/auto-yes-config.ts` に配置（設計一貫性）

---

### S1-F005: stopPatternのサーバーサイド処理フローが未記述

**カテゴリ**: 完全性
**場所**: ## 実装タスク > 3番目

**問題**:
`pollAutoYes()` 内でのStop条件マッチ時の具体的な処理フロー（状態無効化→ポーラー停止→停止理由記録）が記述されていない。

**推奨対応**:
以下の処理フローを明記:
1. `pollAutoYes()` 内、thinkingチェック後（L385）にstopPattern照合
2. マッチ時: `setAutoYesEnabled(worktreeId, false)` + `stopAutoYesPolling(worktreeId)` + `stopReason` 記録
3. return でポーリング終了

---

### S1-F006: WorktreeDetailRefactored.tsxのstopPattern伝達経路の具体的記述が不足

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > ### 変更対象ファイル > `src/components/worktree/WorktreeDetailRefactored.tsx`

**問題**:
「stopPatternの受け渡し追加」のみの記載では、具体的にどの関数シグネチャを変更し、どのfetch呼び出しのbodyにstopPatternを含めるかが不明確。

**推奨対応**:
以下のデータフローを明記:
1. `AutoYesConfirmDialog`: `useState` でstopPattern入力管理、`onConfirm(duration, stopPattern)` で親に渡す
2. `AutoYesToggle`: `handleConfirm` で `onToggle(true, duration, stopPattern)` を呼び出し
3. `WorktreeDetailRefactored`: `handleAutoYesToggle(enabled, duration?, stopPattern?)` でfetch bodyに `stopPattern` を含める

---

### S1-F007: auto-yes-config.tsの変更要否判定が関連コンポーネント表と矛盾

**カテゴリ**: 整合性
**場所**: ## 影響範囲 > ### 関連コンポーネント > `src/config/auto-yes-config.ts`

**問題**:
関連コンポーネントセクションで「変更不要」と記載されているが、セキュリティ考慮でstopPatternの最大長制限（500文字）が要件。既存の設計パターン（Auto-Yes定数の一元管理）に従えば `auto-yes-config.ts` への定数追加が妥当であり、「変更不要」は不正確。

**推奨対応**:
`auto-yes-config.ts` を変更対象ファイルテーブルに移動し、「MAX_STOP_PATTERN_LENGTH等のStop条件関連定数追加」と記載する。

---

### S1-F008: current-output APIルートの変更がテーブルに未記載

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > ### 変更対象ファイル テーブル

**問題**:
Stop条件停止時のクライアント通知には `current-output` ルートのautoYesレスポンス形状変更が必要。変更対象テーブルに含まれていない。

**推奨対応**:
変更対象ファイルテーブルに追加:
| `src/app/api/worktrees/[id]/current-output/route.ts` | autoYesレスポンスにstopReasonフィールド追加 |

---

### S1-F009: stopPatternの照合対象範囲が曖昧

**カテゴリ**: 正確性
**場所**: ## 提案する解決策 > ### 判定タイミング > ステップ4

**問題**:
「ターミナル出力をStop条件パターンと照合する」とあるが、照合対象が全出力（`cleanOutput` 全体）か直近N行（`recentLines`）かが不明確。全出力に照合すると、過去の出力にマッチして即座に停止する恐れがある。

**推奨対応**:
照合対象を明確にする。推奨: `captureSessionOutput` で取得した直近5000文字の `cleanOutput` 全体に対して照合。ただし、前回マッチ済みの出力による重複停止防止メカニズム（例: 前回のキャプチャとの差分照合）も検討が必要。

---

### S1-F010: バリデーションエラーUI表示の実装場所・形式が未明記

**カテゴリ**: 完全性
**場所**: ## 実装タスク > 正規表現バリデーション / ## 受入条件 > 5番目

**問題**:
バリデーションをクライアントサイドのみで行うか、サーバーサイドでも行うかが未明記。UI表示形式（インラインエラー vs トースト）も不明確。

**推奨対応**:
1. クライアントサイド: `AutoYesConfirmDialog` 内でリアルタイムバリデーション。無効時はボタン無効化 + インラインエラー
2. サーバーサイド: `route.ts` POSTハンドラーで再バリデーション（Defense in Depth）
3. i18nキー: `invalidRegexPattern` を追加

---

## Nice to Have（あれば良い）

### S1-F011: Auto-Yes有効中のstopPattern確認手段が未記載

**カテゴリ**: 完全性
**場所**: ## 提案する解決策 > ### UX

**問題**:
Auto-Yes有効化後に、現在設定されているstopPatternをユーザーが確認する手段が記載されていない。

**推奨対応**:
AutoYesToggle有効時にstopPatternを表示する小さなインジケーター（ツールチップ等）を検討。将来Issueとしてもよい。

---

### S1-F012: デフォルトstopPattern（プリセット）の検討が未記載

**カテゴリ**: 完全性
**場所**: ## 提案する解決策 > ### UX > ステップ4

**問題**:
背景で挙げられている「rm -rf、DROP TABLE、force push」をデフォルトプリセットとして提供する検討がない。

**推奨対応**:
初期バージョンではスコープ外として明記し、将来のエンハンスメントとして記録。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/auto-yes-manager.ts` | AutoYesState/AutoYesPollerState定義、pollAutoYes()処理順序（L344-453）、stopPattern挿入ポイント（L385-387間） |
| `src/config/auto-yes-config.ts` | Auto-Yes設定定数の一元管理。MAX_STOP_PATTERN_LENGTH追加候補 |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | onConfirm型定義（L27）、stopPattern入力フィールド追加先 |
| `src/components/worktree/AutoYesToggle.tsx` | onToggle型定義（L24）、handleConfirm（L88-92）のstopPattern伝達 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | POSTハンドラー（L85-158）、stopPatternバリデーション追加先 |
| `src/hooks/useAutoYes.ts` | クライアントサイド自動応答フック。stopPatternとの関連性の再検討が必要 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | handleAutoYesToggle（L1188-1203）、autoYes状態ポーリング（L1037-1041） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | autoYesレスポンス形状（L128-131）、stopReason追加候補 |
| `locales/ja/autoYes.json` | Auto-Yes日本語翻訳キー（19キー）。Stop条件関連キー追加必要 |
| `locales/en/autoYes.json` | Auto-Yes英語翻訳キー（19キー）。Stop条件関連キー追加必要 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト設計パターン・モジュール配置規約の参照元 |
