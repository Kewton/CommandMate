# Issue #525 レビューレポート

**レビュー日**: 2026-03-20
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## 前提

Stage 1の通常レビューで指摘された8件のうち7件が Stage 2で反映済み。特に `resource-cleanup.ts` と `session-cleanup.ts` の影響範囲追加、`checkStopCondition()` のコールバックシグネチャ変更、API設計方針の明記が完了している。本レビューでは、それらの反映を踏まえた上で、更に見落とされている影響範囲を特定する。

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: worktree-status-helper.ts が影響範囲に未記載

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 > 変更対象ファイル

**問題**:
`src/lib/session/worktree-status-helper.ts` が影響範囲に記載されていない。このファイルは `getLastServerResponseTimestamp(worktreeId)` を呼び出しており（L93）、ポーラーのキーが `worktreeId` から `worktreeId:cliToolId` の複合キーに変更されると、`worktreeId` 単体では正しいタイムスタンプを取得できなくなる。

このファイルは `detectWorktreeSessionStatus()` 内の `CLI_TOOL_IDS` 毎のループで呼ばれており、各イテレーションで `cliToolId` が利用可能。複合キー対応は自然に行えるが、変更対象として認識されていないことが問題。

**証拠**:
- `src/lib/session/worktree-status-helper.ts` L21: `import { getLastServerResponseTimestamp } from '@/lib/polling/auto-yes-manager';`
- L93: `const lastServerResponseTs = getLastServerResponseTimestamp(worktreeId);`
- このループ内では `cliToolId` が利用可能だが、引数に渡されていない

**推奨対応**:
`src/lib/session/worktree-status-helper.ts` を影響範囲の変更対象ファイルに追加し、`getLastServerResponseTimestamp()` の呼び出しを `cliToolId` 指定に変更するタスクを追加する。

---

### MF-2: current-output API の serverPollerActive/lastServerResponseTimestamp がエージェント毎に対応していない

**カテゴリ**: 影響ファイル
**場所**: ## 実装タスク > バックエンド > current-output API

**問題**:
Issueの実装タスクでは current-output API について「autoYesレスポンスのエージェント毎対応」のみ記載されているが、同APIでは `isPollerActive(params.id)` と `getLastServerResponseTimestamp(params.id)` もworktreeId単体で呼び出している。

`serverPollerActive` と `lastServerResponseTimestamp` はフロントエンドの `useAutoYes` フックでクライアント側の重複応答防止に使用されており（`WorktreeDetailRefactored.tsx` L393-394, L997-1004）、これらがエージェント毎に正しく返されないと、あるエージェントのポーラー状態が別エージェントのクライアント側応答を誤って抑制する。

**証拠**:
- `current-output/route.ts` L87: `getLastServerResponseTimestamp(params.id)` - worktreeIdのみ
- L149: `isPollerActive(params.id)` - worktreeIdのみ
- L116: `getAutoYesState(params.id)` - worktreeIdのみ（こちらはIssueで言及済み）
- 既に `cliTool` クエリパラメータで特定エージェントのコンテキストが指定されている（L49-50）

**推奨対応**:
current-output API の実装タスクを拡充し、`isPollerActive()`, `getLastServerResponseTimestamp()`, `getAutoYesState()` の全てを `cliToolId` 指定で呼び出すよう変更することを明記する。

---

## Should Fix（推奨対応）

### SF-1: session-cleanup.ts のクリーンアップが全エージェント分に対応できていない設計

**カテゴリ**: 破壊的変更
**場所**: ## 影響範囲 > 変更対象ファイル > session-cleanup.ts

**問題**:
`cleanupWorktreeSessions()` は `stopAutoYesPolling(worktreeId)` と `deleteAutoYesState(worktreeId)` をそれぞれ1回ずつ呼んでいる（L114-131）。複合キー化後は同一worktreeIdに対して `worktreeId:claude`, `worktreeId:codex` 等の複数エントリが存在するため、1回の呼び出しでは全エージェント分がクリーンアップされない。

Issueでは session-cleanup.ts を影響範囲に追加済みだが、具体的にどう変更するか（全エージェント分のイテレーション or worktreeIdプレフィックスで一括操作する新API）が不明確。

**証拠**:
- `session-cleanup.ts` L114-121: `stopAutoYesPolling(worktreeId)` - 1回のみ呼出
- L124-131: `deleteAutoYesState(worktreeId)` - 1回のみ呼出

**推奨対応**:
以下のいずれかの設計方針を明記:
1. `stopAutoYesPollingByWorktree(worktreeId)` / `deleteAutoYesStateByWorktree(worktreeId)` のようなワイルドカード削除APIを追加
2. `CLI_TOOL_IDS` でループして各エージェント分の複合キーで個別に呼び出す

---

### SF-2: resource-cleanup.ts の孤立エントリ検出が複合キー化後に破綻する

**カテゴリ**: 破壊的変更
**場所**: ## 実装タスク > バックエンド > resource-cleanup.ts

**問題**:
`cleanupOrphanedMapEntries()` は `getAutoYesStateWorktreeIds()` の返り値をDBの `worktreeId` と `validWorktreeIds.has(worktreeId)` で比較している。複合キー化後は返り値が `"worktreeId:claude"` のような複合キーになるため、`validWorktreeIds.has("worktreeId:claude")` は常に `false` を返し、全ての有効なエントリが孤立エントリとして誤削除される。

Issueでは resource-cleanup.ts を影響範囲に追加し、`extractWorktreeId()` ヘルパーの必要性を記載済みだが、具体的な使用箇所の変更が明確でない。

**証拠**:
- `resource-cleanup.ts` L229-235: `autoYesStateIds` を `validWorktreeIds.has(worktreeId)` でチェック
- L238-243: `autoYesPollerIds` も同様のパターン
- 複合キー `"abc123:claude"` に対して `validWorktreeIds.has("abc123:claude")` は `false`

**推奨対応**:
`extractWorktreeId()` の具体的な使用箇所を実装タスクに明記:
```
for (const compositeKey of autoYesStateIds) {
  const worktreeId = extractWorktreeId(compositeKey);
  if (!validWorktreeIds.has(worktreeId)) {
    deleteAutoYesState(compositeKey);  // 複合キーで削除
  }
}
```

---

### SF-3: テスト範囲に複合キー化の影響を受ける既存テストファイルが未記載

**カテゴリ**: テスト範囲
**場所**: ## 実装タスク > テスト

**問題**:
Issueのテストタスクには `auto-yes-state.ts`, `auto-yes-poller.ts`, `API route`, `resource-cleanup.ts` の単体テストが記載されているが、以下の既存テストファイルへの影響が未特定:

1. `tests/unit/lib/worktree-status-helper.test.ts` - `getLastServerResponseTimestamp` のモック更新
2. `tests/integration/auto-yes-persistence.test.ts` - globalThisのMapキー構造変更
3. `tests/unit/auto-yes-manager-cleanup.test.ts` - クリーンアップ処理のテスト更新
4. `tests/unit/session-cleanup-issue404.test.ts` - 全エージェント分クリーンアップのテスト
5. `tests/unit/resource-cleanup.test.ts` - 孤立エントリ検出ロジックのテスト

**推奨対応**:
テストタスクに上記5ファイルの更新を追加。特に `auto-yes-persistence.test.ts` と `resource-cleanup.test.ts` は複合キー化による破壊的変更の影響が大きい。

---

## Nice to Have（あれば良い）

### NTH-1: CLI型定義 api-responses.ts の更新が影響範囲に未記載

**カテゴリ**: ドキュメント更新
**場所**: ## 影響範囲 > 関連コンポーネント

**問題**:
`src/cli/types/api-responses.ts` の `CurrentOutputResponse` 型には `autoYes` が単一オブジェクトとして定義されており（L45-49）、`lastServerResponseTimestamp` (L54) と `serverPollerActive` (L55) も単一値。current-output APIのレスポンス形式変更に伴い、この型定義の更新も必要になる可能性がある。

**推奨対応**:
`src/cli/types/api-responses.ts` を影響範囲の関連コンポーネントに追加。

---

### NTH-2: 複合キー生成ユーティリティの統一

**カテゴリ**: 依存関係
**場所**: ## 実装タスク > バックエンド > auto-yes-poller.ts

**問題**:
`auto-yes-poller.ts` 内には `worktreeId` をMapキーとして使用する箇所が11箇所以上ある（getPollerState, getLastServerResponseTimestamp, isPollerActive, updateLastServerResponseTimestamp, resetErrorCount, incrementErrorCount, autoYesPollerStates.set 等）。これらを全て `worktreeId:cliToolId` の複合キーに変更する際、文字列結合の散在はバグのリスクが高い。

**推奨対応**:
`buildCompositeKey(worktreeId, cliToolId)` と `extractWorktreeId(compositeKey)` のユーティリティ関数を共通モジュール（例: `auto-yes-state.ts`）に配置し、`auto-yes-state.ts` と `auto-yes-poller.ts` の両方から使用する設計を記載。

---

## 影響範囲サマリー（Stage 1反映後の差分）

### Issue記載済み（Stage 2反映済み）の影響ファイル

| ファイル | 状態 |
|---------|------|
| `src/lib/auto-yes-state.ts` | 記載済み |
| `src/lib/auto-yes-poller.ts` | 記載済み |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | 記載済み |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 記載済み（ただしタスク不十分 - MF-2） |
| `src/components/worktree/AutoYesToggle.tsx` | 記載済み |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | 記載済み |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 記載済み |
| `src/hooks/useAutoYes.ts` | 記載済み |
| `src/lib/resource-cleanup.ts` | 記載済み（ただしタスク不十分 - SF-2） |
| `src/lib/session-cleanup.ts` | 記載済み（ただしタスク不十分 - SF-1） |

### 本レビューで新たに特定された影響ファイル

| ファイル | 影響内容 | 重要度 |
|---------|---------|--------|
| `src/lib/session/worktree-status-helper.ts` | getLastServerResponseTimestamp()の複合キー対応 | Must Fix |
| `src/cli/types/api-responses.ts` | CurrentOutputResponse型定義の更新 | Nice to Have |
| `tests/unit/lib/worktree-status-helper.test.ts` | テスト更新 | Should Fix |
| `tests/integration/auto-yes-persistence.test.ts` | テスト更新 | Should Fix |
| `tests/unit/auto-yes-manager-cleanup.test.ts` | テスト更新 | Should Fix |
| `tests/unit/session-cleanup-issue404.test.ts` | テスト更新 | Should Fix |
| `tests/unit/resource-cleanup.test.ts` | テスト更新 | Should Fix |

---

## 参照ファイル

### コード
- `src/lib/session/worktree-status-helper.ts`: getLastServerResponseTimestamp(worktreeId)呼び出し（L93）
- `src/app/api/worktrees/[id]/current-output/route.ts`: isPollerActive/getLastServerResponseTimestamp呼び出し（L87, L149）
- `src/lib/session-cleanup.ts`: stopAutoYesPolling/deleteAutoYesStateが1回のみ呼出（L114-131）
- `src/lib/resource-cleanup.ts`: validWorktreeIds.has()による比較（L229-243）
- `src/cli/types/api-responses.ts`: CurrentOutputResponse型定義（L45-55）
- `src/lib/auto-yes-poller.ts`: worktreeIdをMapキーとして使用する全箇所

### テスト
- `tests/unit/lib/worktree-status-helper.test.ts`
- `tests/integration/auto-yes-persistence.test.ts`
- `tests/unit/auto-yes-manager-cleanup.test.ts`
- `tests/unit/session-cleanup-issue404.test.ts`
- `tests/unit/resource-cleanup.test.ts`
