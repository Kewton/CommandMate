# Issue #525 レビューレポート

**レビュー日**: 2026-03-20
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目
**仮説検証結果**: 参照済み（hypothesis-verification.md）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #525は「auto-yesのエージェント毎独立制御」を実現する機能追加Issueとして、概ね妥当な設計方針を示している。ただし、仮説検証で発見された「単一トグル」表現の不正確さ、およびキー複合化に伴う影響範囲の記載漏れが主な指摘事項となる。

---

## Must Fix（必須対応）

### MF-1: 「単一トグル」表現が不正確

**カテゴリ**: 正確性
**場所**: ## 背景・課題 セクション 1項目目

**問題**:
Issue本文に「現在のauto-yesはworktree単位の単一トグルで、1つのworktreeに対して1つの設定しか持てない」と記載されているが、仮説検証（Rejected）の通りこの表現は不正確である。

実態は以下の通り:
- **状態管理側** (`auto-yes-state.ts`): `Map<string, AutoYesState>` のキーは `worktreeId` のみで、`cliToolId` を保持しない
- **ポーラー側** (`auto-yes-poller.ts`): `AutoYesPollerState.cliToolId` フィールドが既に存在し、エージェント単位の追跡が行われている
- **API層**: `cliToolId` をリクエストから読み取るが、`setAutoYesEnabled()` には渡していない

「単一トグル」ではなく「キー設計の非対称性」が正確な問題描写である。

**証拠**:
- `auto-yes-state.ts` L57-58: `Map<string, AutoYesState>` キーは `worktreeId` のみ
- `auto-yes-state.ts` L105-109: `setAutoYesEnabled()` に `cliToolId` パラメータがない
- `auto-yes-poller.ts` L52: `AutoYesPollerState.cliToolId` フィールドが存在
- `auto-yes/route.ts` L156-165: `cliToolId` は検証されるが `setAutoYesEnabled()` に渡されない

**推奨対応**:
背景・課題の記述を「現在のauto-yes状態管理はworktreeId単位のキーで管理されており、エージェント毎の独立した状態保持ができない（ポーラー側はcliToolIdを保持するが、状態側は保持しない非対称設計）」に修正する。

---

### MF-2: API設計の具体性不足

**カテゴリ**: 完全性
**場所**: ## 実装タスク > バックエンド

**問題**:
実装タスクに「GETのエージェント指定対応」「autoYesレスポンスにcliToolIdを反映」とあるが、具体的な設計方針が不明確である。

複合キー化後に複数エージェントの状態が存在する場合:
1. `GET /auto-yes` は特定エージェントの状態を返すのか、全エージェントの状態をまとめて返すのか
2. `GET /current-output` の `autoYes` フィールドは `cliTool` クエリパラメータで指定されたエージェントの状態のみ返すのか、全エージェント分の配列にするのか

現在の実装:
- `auto-yes/route.ts` L82: `getAutoYesState(params.id)` で worktreeId 単位の1状態のみ取得
- `current-output/route.ts` L116: 同様に `getAutoYesState(params.id)` で1状態のみ取得

**推奨対応**:
APIレスポンス設計を以下のいずれかで明記する:
- (A) `cliToolId` クエリパラメータ必須化 → 指定エージェントの状態のみ返す
- (B) 全エージェント分のマップ/配列で返す → レスポンス型定義の変更を記載

---

## Should Fix（推奨対応）

### SF-1: resource-cleanup.ts / session-cleanup.ts への影響未記載

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > 関連コンポーネント

**問題**:
キーを複合キー化すると、以下のクリーンアップ関数に影響が発生する:

- `resource-cleanup.ts`: `getAutoYesStateWorktreeIds()` が複合キーを返すようになり、worktreeの存在チェックロジックが壊れる
- `session-cleanup.ts`: `deleteAutoYesState(worktreeId)` / `stopAutoYesPolling(worktreeId)` が複合キー対応必要

**証拠**:
- `resource-cleanup.ts` L19-23: `deleteAutoYesState`, `stopAutoYesPolling`, `getAutoYesStateWorktreeIds`, `getAutoYesPollerWorktreeIds` を使用
- `session-cleanup.ts` L12: `stopAutoYesPolling`, `deleteAutoYesState` を使用

**推奨対応**:
影響範囲に `resource-cleanup.ts` と `session-cleanup.ts` を追加。複合キーから `worktreeId` を抽出するヘルパー関数、または worktreeId で前方一致削除する関数の必要性を記載する。

---

### SF-2: checkStopCondition のコールバック変更が未記載

**カテゴリ**: 完全性
**場所**: ## 実装タスク > バックエンド

**問題**:
`checkStopCondition()` の `onStopMatched` コールバックは `(worktreeId: string) => void` のシグネチャで `stopAutoYesPolling` を受け取る。複合キー化後はこのコールバックにも複合キーを渡す必要があるが、実装タスクに言及がない。

**証拠**:
- `auto-yes-state.ts` L211-214: `checkStopCondition(worktreeId, cleanOutput, onStopMatched)`
- `auto-yes-poller.ts` L308: `checkStopCondition(worktreeId, newContent, stopAutoYesPolling)`

**推奨対応**:
`checkStopCondition()` と `disableAutoYes()` の引数変更を実装タスクに追加。

---

### SF-3: 既存実装活用ポイントでのギャップ未記載

**カテゴリ**: 明確性
**場所**: ## 既存実装の活用ポイント

**問題**:
「API（POST /api/worktrees/:id/auto-yes）は既にcliToolIdパラメータを受け付けている」と記載されているが、実際には API が `cliToolId` を受け取った後 `setAutoYesEnabled()` に渡していないというギャップがある。この不完全な実装状況の記載がないと、実装者が「既に動いている」と誤解する可能性がある。

**証拠**:
- `auto-yes/route.ts` L156-158: `cliToolId` は `isValidCliTool()` で検証される
- `auto-yes/route.ts` L160-165: `setAutoYesEnabled(params.id, body.enabled, duration, stopPattern)` に `cliToolId` が渡されていない
- `auto-yes/route.ts` L170: `startAutoYesPolling(params.id, cliToolId)` には渡されている

**推奨対応**:
「ただしsetAutoYesEnabled()にcliToolIdを渡しておらず、状態管理側でのcliToolId紐付けが未実装」というギャップを明記する。

---

### SF-4: 複数同時ポーリングのリソース影響未検討

**カテゴリ**: 技術的妥当性
**場所**: ## 提案する解決策 > バックエンドの変更

**問題**:
現在の `startAutoYesPolling()` は同一 `worktreeId` で異なる `cliToolId` のリクエストが来ると、既存ポーラーを停止して新規作成する排他的な動作をする（L552-554）。複合キー化後は同一 worktree で複数ポーラーが同時稼働する設計になるが、以下の点が未検討:

1. `MAX_CONCURRENT_POLLERS = 50` の制限が worktree x agent の組み合わせで急増する可能性
2. 同一 worktree の複数ポーラーが同時に `captureSessionOutput()` を呼び出すことによる tmux 負荷

**推奨対応**:
1 worktree あたりの同時ポーラー数の上限、または `MAX_CONCURRENT_POLLERS` の見直し要否を記載。

---

## Nice to Have（あれば良い）

### NTH-1: DB永続化への言及

**カテゴリ**: 完全性
**場所**: ## 提案する解決策

auto-yes 状態は in-memory (`globalThis`) で管理されており、サーバー再起動で状態がリセットされる。複数エージェント同時制御の場面ではサーバー再起動時の影響が大きくなる可能性がある。スコープ外であればその旨を明記し、将来検討の follow-up Issue へのリンクを追加することを推奨。

---

### NTH-2: i18n翻訳ファイルの変更タスク

**カテゴリ**: 完全性
**場所**: ## 実装タスク > フロントエンド

`AutoYesConfirmDialog` では既に `cliToolName` を使った翻訳キー（`enableTitleWithTool`, `appliesOnlyToCurrent`）が存在するが、エージェント毎の独立制御に伴い新しい翻訳キーが必要になる可能性がある。i18n ファイルの変更タスクが記載されていない。

---

## 参照ファイル

### コード（変更対象）
- `src/lib/auto-yes-state.ts`: 状態管理キーの複合キー化、setAutoYesEnabled()へのcliToolId追加
- `src/lib/auto-yes-poller.ts`: ポーラーキーの複合キー化、startAutoYesPolling()の排他ロジック変更
- `src/app/api/worktrees/[id]/auto-yes/route.ts`: GET/POST のエージェント指定対応
- `src/app/api/worktrees/[id]/current-output/route.ts`: autoYesレスポンスの改善
- `src/hooks/useAutoYes.ts`: エージェント毎状態取得対応
- `src/components/worktree/AutoYesToggle.tsx`: エージェント毎トグル
- `src/components/worktree/AutoYesConfirmDialog.tsx`: エージェント名表示（既に部分対応済み）

### コード（Issue未記載の影響範囲）
- `src/lib/resource-cleanup.ts`: 複合キーからのworktreeId抽出ロジック追加が必要
- `src/lib/session-cleanup.ts`: deleteAutoYesState/stopAutoYesPollingの複合キー対応が必要
- `src/lib/polling/auto-yes-manager.ts`: バレルファイルのエクスポート整合性確認

### ドキュメント
- `CLAUDE.md`: モジュール説明の更新可能性
