# Issue #188 レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目
**ステージ**: 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

## 前回指摘事項の検証

### Stage 3 指摘事項（影響範囲レビュー 1回目）: 7件中7件が解決済み

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| MF-1 | useAutoYes.ts(クライアント側)への影響が未記載 | 解決済み: 下流影響セクションとして追記済み |
| SF-1 | Issue #161との整合性に関する設計判断が不明確 | 解決済み: 設計判断セクション追加済み |
| SF-2 | テスト計画が具体的でない | 解決済み: 4テストファイル明記済み |
| SF-3 | response-poller.ts extractResponse()が影響範囲から欠落 | 解決済み: 問題箇所3として追加済み |
| SF-4 | ウィンドウサイズ統一の設計判断が不明確 | 解決済み: 設計判断セクション追加済み |
| NTH-1 | CLAUDE.md更新の必要性が未記載 | 解決済み: ドキュメント受け入れ条件に追加済み |
| NTH-2 | sidebar.ts deriveCliStatus()への間接影響が未記載 | 解決済み: 下流影響テーブルと影響範囲テーブルに追加済み |

### Stage 5 指摘事項（通常レビュー 2回目）: 3件中3件が解決済み

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| SF-1 | promptOptions引数がコードスニペットから省略 | 解決済み: buildDetectPromptOptions()行とpromptOptions引数追加済み |
| NTH-1 | response-poller.ts L549がウィンドウ不整合テーブルに未掲載 | 解決済み: 6番目の不整合ポイントとして追加済み |
| NTH-2 | WorktreeDetail.tsx L477が下流影響テーブルに未記載 | 解決済み: L477追加、isGenerating参照箇所2つを明記済み |

---

## Should Fix（推奨対応）

### SF-1: WorktreeDetail.tsx vs WorktreeDetailRefactored.tsx の参照先の不一致

**カテゴリ**: 影響ファイル
**場所**: 下流影響テーブル / 影響範囲 間接影響ファイルテーブル

**問題**:
Issueの下流影響分析と影響範囲テーブルは `WorktreeDetail.tsx`（L180, L477）を参照しているが、実際のアプリケーションでレンダリングされているコンポーネントは `WorktreeDetailRefactored.tsx` である。

`src/app/worktrees/[id]/page.tsx` L10で `WorktreeDetailRefactored` をimportしている:

```typescript
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
```

`WorktreeDetail.tsx` はどこからもimportされておらず、実質的にデッドコードである。

**実際の影響箇所（WorktreeDetailRefactored.tsx）**:
- L67: `isGenerating?: boolean` (CurrentOutputResponse interface定義)
- L73: `thinking?: boolean` (同interface定義)
- L989: `actions.setTerminalThinking(data.thinking ?? false)` -- `data.thinking`を直接消費
- L992-994: `data.isPromptWaiting`を読み取り、`showPrompt`/`clearPrompt`を制御
- L1378-1383: `useAutoYes`フックに`state.prompt.visible`を`isPromptWaiting`として渡す

特に重要な差異: `WorktreeDetail.tsx`は`data.isGenerating`を直接条件分岐に使用しているが、`WorktreeDetailRefactored.tsx`は`data.isGenerating`を読み取らず、`data.thinking`を使用している。P0修正で`isGenerating`の値が変わっても、実際のUI影響は`thinking`フィールド経由で発生する。

**証拠**:
- `src/app/worktrees/[id]/page.tsx` L10, L18: `WorktreeDetailRefactored`をimport、レンダリング
- `WorktreeDetail.tsx`のimport元: grep検索で該当なし

**推奨対応**:
下流影響テーブルと影響範囲の間接影響ファイルテーブルにおいて、`WorktreeDetail.tsx`の記載を`WorktreeDetailRefactored.tsx`に変更するか、両方を併記して`WorktreeDetail.tsx`がデッドコードである旨を注記する。`WorktreeDetailRefactored.tsx`の影響箇所（L989, L992-994, L1378-1383）を明記する。

---

## Nice to Have（あれば良い）

### NTH-1: テスト計画のcli-patterns.test.tsパスの不一致

**カテゴリ**: テスト範囲
**場所**: 受け入れ条件 > テスト計画

**問題**:
テスト計画では `tests/unit/lib/cli-patterns.test.ts` にウィンドウ境界テストを追加と記載されているが、既存のcli-patterns.test.tsは `src/lib/__tests__/cli-patterns.test.ts` に配置されている。`tests/unit/lib/cli-patterns.test.ts` は存在しない。

一方で、`prompt-detector.test.ts` は `tests/unit/prompt-detector.test.ts` に存在しており、テストファイルの配置パターンが2種類混在している。

**推奨対応**:
テスト計画のファイルパスを `src/lib/__tests__/cli-patterns.test.ts` に修正するか、新規テストの配置意図を明記する。

---

### NTH-2: prompt-response/route.tsの影響範囲明示

**カテゴリ**: 影響ファイル
**場所**: 影響範囲 間接影響ファイルテーブル

**問題**:
`src/app/api/worktrees/[id]/prompt-response/route.ts` L73-84にも `captureSessionOutput` + `stripAnsi` + `detectPrompt` の呼び出しチェーンがあるが、thinking検出は行っていない。P0修正で `current-output/route.ts` のthinking/prompt優先順位を変更しても、`prompt-response/route.ts` は独自にプロンプト再検証を行っているため直接影響はない。

**推奨対応**:
影響範囲の網羅性の観点から、`prompt-response/route.ts` を「影響なし」のファイルとして間接影響テーブルに注記すると、実装者がスコープ外であることを明示的に確認できる。

---

## 影響範囲の検証結果

### 直接修正対象ファイル: 正確

| ファイル | 検証結果 |
|---------|---------|
| `src/app/api/worktrees/[id]/current-output/route.ts` | 行番号(L73-74, L83, L89-90)が実コードと一致。コードスニペットも正確 |
| `src/lib/status-detector.ts` | 行番号(L50, L83, L85-107)が実コードと一致。優先順位ロジックの記載が正確 |

### 間接影響ファイル: 概ね正確（1件修正推奨）

| ファイル | 検証結果 |
|---------|---------|
| `src/lib/auto-yes-manager.ts` | L79 THINKING_CHECK_LINE_COUNT=50が正確。L310-311のdetectThinking呼び出しが正確 |
| `src/lib/response-poller.ts` | L236, L282, L353, L549の4箇所が全て正確 |
| `src/lib/cli-patterns.ts` | detectThinking(), buildDetectPromptOptions()の記載が正確 |
| `src/lib/claude-poller.ts` | 到達不能コードの記載が正確。stopPolling()の外部参照も確認済み |
| `src/components/worktree/WorktreeDetail.tsx` | **要修正**: デッドコード（未使用）。SF-1参照 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | **追加推奨**: 実際のUIコンポーネント。SF-1参照 |
| `src/hooks/useAutoYes.ts` | L49 isPromptWaitingパラメータが正確 |
| `src/types/sidebar.ts` | L34-35 deriveCliStatus()が正確 |
| `src/app/api/worktrees/route.ts` | L58 detectSessionStatus()呼び出しが正確 |
| `src/app/api/worktrees/[id]/route.ts` | L58 detectSessionStatus()呼び出しが正確 |

### テストファイル: 概ね正確（パス不一致1件）

| テストファイル | 存在 | 備考 |
|--------------|------|------|
| `tests/unit/lib/status-detector.test.ts` | 未存在 | テスト計画通り新規作成が必要 |
| `tests/unit/lib/cli-patterns.test.ts` | 未存在 | 実際は `src/lib/__tests__/cli-patterns.test.ts` に存在。NTH-1参照 |
| `tests/unit/prompt-detector.test.ts` | 存在 | テスト計画通り追加可能 |
| `tests/integration/current-output-thinking.test.ts` | 未存在 | テスト計画通り新規作成が必要 |

### 破壊的変更: 正しく評価済み

APIレスポンスのフィールド名（`isGenerating`, `isPromptWaiting`）は変更なし。値の意味論が変わるが、フロントエンドは同一リポジトリ内のため後方互換性の問題はない。

---

## 総合評価

Issue #188の影響範囲分析は、4回のレビューサイクル（Stage 1-2: 通常、Stage 3-4: 影響範囲、Stage 5-6: 通常2回目、Stage 7: 影響範囲2回目）を経て高い品質に達している。

**強み**:
- 6箇所のウィンドウ不整合が検出ウィンドウテーブルとして体系的に整理されている
- thinking/prompt優先順位の設計判断がIssue #161との整合性を含めて明確化されている
- 下流影響チェーン（current-output API -> UI/Auto-Yes -> sidebar）が追跡可能
- テスト計画が具体的なファイル名とシナリオで構成されている
- 全20件の過去の指摘事項が正しく反映されている

**残課題**:
- SF-1: WorktreeDetail.tsx（デッドコード）ではなく WorktreeDetailRefactored.tsx を影響ファイルとして参照すべき

**判定**: 実装着手可能。SF-1はIssue修正時の注意事項として認識すれば、実装に支障はない。

---

## 参照ファイル

### コード
- `src/app/worktrees/[id]/page.tsx`: WorktreeDetailRefactored をimport（SF-1の根拠）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 実際のUIコンポーネント（SF-1）
- `src/components/worktree/WorktreeDetail.tsx`: デッドコード（SF-1）
- `src/app/api/worktrees/[id]/current-output/route.ts`: P0修正の主要対象
- `src/lib/status-detector.ts`: P1修正の参照実装
- `src/lib/response-poller.ts`: L236, L282, L353, L549のthinkingチェック
- `src/lib/auto-yes-manager.ts`: L79 THINKING_CHECK_LINE_COUNT=50
- `src/lib/cli-patterns.ts`: detectThinking(), buildDetectPromptOptions()
- `src/lib/__tests__/cli-patterns.test.ts`: 既存テスト（NTH-1の根拠）
- `src/app/api/worktrees/[id]/prompt-response/route.ts`: 影響範囲外の確認（NTH-2）

### ドキュメント
- `CLAUDE.md`: Issue #180, #191, #161, #193の設計経緯
