# Issue #501 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 4 |
| **合計** | **9** |

---

## Must Fix（必須対応）

### F3-008: 対策1で WorktreeDetailRefactored.tsx の変更箇所が暗黙的

**カテゴリ**: missing_impact
**場所**: 対策1

**問題**:
対策1では `fetchCurrentOutput()` 内で `lastServerResponseTimestamp` を state に保存すると記載されているが、具体的な変更手順が不明確。実装には以下の4箇所の変更が必要:

1. `CurrentOutputResponse` 型に `lastServerResponseTimestamp?: number | null` を追加（L116-132）
2. `useState<number | null>(null)` で state 変数を追加
3. `fetchCurrentOutput` 内（L352-398）で `data.lastServerResponseTimestamp` を setState
4. `useAutoYes` の呼び出し（L961-967）に `lastServerResponseTimestamp` を渡す

現状のコードを確認したところ、`lastServerResponseTimestamp` は WorktreeDetailRefactored.tsx 内で一切参照されていないことを確認。API は L139 で返しているが、クライアントで完全に無視されている。

**推奨対応**:
対策1の変更内容を上記4ステップとして明確に列挙する。

---

## Should Fix（推奨対応）

### F3-001: worktree-status-helper.ts での lastOutputTimestamp のデータソースと CLIツール間干渉

**カテゴリ**: missing_impact
**場所**: 対策3

**問題**:
対策3では `worktree-status-helper.ts` の `detectSessionStatus()` に `lastOutputTimestamp` を渡すと記載されている。しかし `getLastServerResponseTimestamp()` は worktreeId 単位で管理されており、CLIツール単位ではない。`worktree-status-helper.ts` は全 `CLI_TOOL_IDS` をループして各ツールのステータスを検出するため、Claude のポーラータイムスタンプが他のCLIツール（Codex, OpenCode 等）のステータス検出に影響する可能性がある。

**証拠**:
- `auto-yes-poller.ts` L79: `autoYesPollerStates` は `Map<string, AutoYesPollerState>` で worktreeId をキーとする
- `worktree-status-helper.ts` L67-68: `allCliTools.map(async (cliToolId) => ...)` で全CLIツールをループ
- `worktree-status-helper.ts` L91: `detectSessionStatus(output, cliToolId)` は2引数で呼ばれている

**推奨対応**:
CLIツール間の干渉リスクを検討し、worktree-status-helper への lastOutputTimestamp 伝播の方針を明確にする。

---

### F3-002: worktree-status-helper.ts のテストファイルが不存在

**カテゴリ**: test_coverage
**場所**: 受入条件

**問題**:
`tests/` ディレクトリに `worktree-status-helper` のテストが存在しない。対策3で `detectSessionStatus()` への引数追加を行う場合、挙動変更を検証するテストが必要。

**推奨対応**:
受け入れ条件にテスト追加要件を明記する。

---

### F3-003: 対策2と対策3の暗黙の依存関係

**カテゴリ**: cross_fix_interaction
**場所**: 対策2, 対策3

**問題**:
対策2でポーラーが再利用されると `lastServerResponseTimestamp` が保持される。対策3はこのタイムスタンプを `detectSessionStatus()` に渡す。つまり対策2のポーラー再利用が対策3のタイムスタンプ保持の前提条件となっている。対策2なしに対策3だけ実装すると、worktree クリック時にタイムスタンプがリセットされ対策3が無効化される。

**推奨対応**:
対策間の依存関係を Issue に明記する。

---

### F3-006: session-cleanup.ts が間接影響ファイルに未記載

**カテゴリ**: missing_impact
**場所**: 関連ファイル

**問題**:
`session-cleanup.ts` L115 で `stopAutoYesPolling(worktreeId)` を呼んでいる。対策2でポーラーの再作成ロジックが変わった場合のクリーンアップ後の再起動シナリオを検討する必要がある。`stopAutoYesPolling()` は `autoYesPollerStates.delete(worktreeId)` するため、クリーンアップ後は「既存ポーラーなし」として新規作成される。これは期待通りの動作だが、間接影響ファイルとして明記すべき。

**推奨対応**:
`session-cleanup.ts` を間接影響ファイルセクションに追加する。

---

## Nice to Have（あれば良い）

### F3-004: セッション起動直後のポーラー開始で baseline が 0 になる edge case

**カテゴリ**: edge_case
**場所**: 対策2

tmux セッション起動直後に captureSessionOutput() が空文字列を返す場合、stopCheckBaselineLength が 0 に設定される。対策2の再利用ロジックでこの状態が引き継がれることを認識し、必要に応じてコメントで注記する。

---

### F3-005: auto-yes API レスポンスの pollingStarted フィールドの意味変更

**カテゴリ**: backward_compatibility
**場所**: 対策2

`already_running` の場合 `started: false` が返ると `pollingStarted: false` がAPIレスポンスに含まれる。現状クライアント側で `pollingStarted` を使用していないことを確認済みだが、API レスポンス仕様の変更として認識しておく。

---

### F3-007: useAutoYes テストに lastServerResponseTimestamp のテストケースが不足

**カテゴリ**: test_coverage
**場所**: 受入条件

`tests/unit/hooks/useAutoYes.test.ts` に `lastServerResponseTimestamp` による重複防止のテストケースが存在しない。受け入れ条件を満たすため追加が必要。

---

### F3-009: resource-cleanup.ts への影響確認

**カテゴリ**: missing_impact
**場所**: 関連ファイル

`resource-cleanup.ts` は `getAutoYesPollerWorktreeIds()` を使って孤立ポーラーを検出する。対策2でポーラーの生存期間が延びることの影響は軽微（stop/delete のロジックは変わらない）だが、間接影響として言及が望ましい。

---

## 対策間の相互作用まとめ

| 対策の組み合わせ | 相互作用 | リスク |
|----------------|---------|--------|
| 対策1 + 対策2 | 独立。対策1はクライアント側、対策2はサーバー側。 | なし |
| 対策2 + 対策3 | **依存関係あり**。対策2がタイムスタンプ保持の前提条件。 | 対策2なしに対策3を実装すると効果が限定的 |
| 対策1 + 対策3 | 間接的関連。両方とも lastServerResponseTimestamp を利用するが経路が異なる。 | なし |

## 参照ファイル

### コード（直接変更対象）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 対策1（L116-132 型定義、L352-398 fetchCurrentOutput、L961-967 useAutoYes呼び出し）
- `src/lib/auto-yes-poller.ts`: 対策2（L469-516 startAutoYesPolling）
- `src/app/api/worktrees/[id]/current-output/route.ts`: 対策3（L86 detectSessionStatus呼び出し）
- `src/lib/session/worktree-status-helper.ts`: 対策3（L91 detectSessionStatus呼び出し）
- `src/app/api/worktrees/[id]/auto-yes/route.ts`: 対策2（L168-177 startAutoYesPolling呼び出し）

### コード（間接影響）
- `src/hooks/useAutoYes.ts`: 対策1で正しく引数が渡されるようになる（変更不要）
- `src/lib/detection/status-detector.ts`: 対策3で既存の lastOutputTimestamp パラメータが活用される（変更不要）
- `src/lib/session-cleanup.ts`: stopAutoYesPolling を呼んでおり対策2の影響を受ける可能性
- `src/lib/resource-cleanup.ts`: getAutoYesPollerWorktreeIds を使用
- `src/lib/polling/auto-yes-manager.ts`: バレルファイル（re-export のみ、変更不要）

### テストファイル
- `tests/unit/lib/auto-yes-manager.test.ts`: 対策2のポーラー再利用テスト追加が必要
- `tests/unit/hooks/useAutoYes.test.ts`: 対策1のタイムスタンプ重複防止テスト追加が必要
- `tests/integration/current-output-thinking.test.ts`: 対策3の lastOutputTimestamp 伝播テストの候補
- (新規) `worktree-status-helper` のテストファイルが不存在
