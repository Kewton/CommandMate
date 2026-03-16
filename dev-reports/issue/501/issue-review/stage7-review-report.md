# Issue #501 レビューレポート（Stage 7）

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

## 前回（Stage 3）指摘事項の対応状況

| ID | タイトル | 対応状況 |
|----|---------|---------|
| F3-001 | worktree-status-helper.ts のデータソース未特定 | 対応済 |
| F3-002 | worktree-status-helper.ts のテストファイル不在 | 対応済 |
| F3-003 | 対策間の依存関係が暗黙的 | 対応済 |
| F3-004 | セッション起動直後のポーラー開始タイミング | 未対応 |
| F3-005 | pollingStarted フィールドの意味変更 | 対応済 |
| F3-006 | session-cleanup.ts への影響が未記載 | 対応済 |
| F3-007 | useAutoYes テストの不足 | 対応済 |
| F3-008 | 対策1の4ステップ明確化 | 対応済 |
| F3-009 | resource-cleanup.ts への影響確認 | 対応済 |

9件中8件が対応済。未対応の F3-004 は severity: should_fix であり、既存問題が対策2で悪化するわけではないため、ドキュメントコメントでの対応で十分と判断する。

---

## Should Fix（推奨対応）

### F7-001: StartPollingResult の already_running 方針が未確定

**カテゴリ**: 影響範囲の欠落
**場所**: 対策2

**問題**:
対策2で `startAutoYesPolling()` が既存ポーラーを再利用する場合の戻り値が未確定。Issue には「`started: true` を返すか、`reason` による分岐を追加するか」の2案が記載されているが、どちらを採用するか確定していない。

実装時の判断ブレにより、`auto-yes/route.ts` L172 の warn ログが不要に出力される可能性がある。

**証拠**:
- `auto-yes/route.ts` L170-174: `result.started` を `pollingStarted` に代入し、`!result.started` で warn ログを出力
- `StartPollingResult` 型（`auto-yes-poller.ts` L62-67）: `{ started: boolean; reason?: string }`

**推奨対応**:
`already_running` の場合は `started: true` を返す方針に確定する。理由: API レスポンスの `pollingStarted` の意味が変わらず、`auto-yes/route.ts` の変更が最小限で済む。

---

### F7-002: ポーラー再利用テストの追加先ファイルが未指定

**カテゴリ**: テストカバレッジ
**場所**: 受入条件

**問題**:
受入条件に「同一 `cliToolId` で `startAutoYesPolling()` を再呼び出ししてもポーラーが再作成されないことをテストで確認」とあるが、テストを追加するファイルが明示されていない。

既存テストファイルは `tests/unit/lib/auto-yes-manager.test.ts` であり、バレルファイル（`auto-yes-manager.ts`）経由でテストしている。

**推奨対応**:
受入条件に「`tests/unit/lib/auto-yes-manager.test.ts` にポーラー再利用テストケースを追加」と明記する。

---

## Nice to Have（あれば良い）

### F7-003: 対策2のcliToolId変更時の競合タイミング

**カテゴリ**: エッジケース
**場所**: 対策2

`cliToolId` が変わった場合のポーラー停止・再作成間に `getLastServerResponseTimestamp()` が呼ばれると null が返る可能性があるが、Node.js のシングルスレッド特性により、`stop -> create` は同期的に完了するため問題にならない。コードコメントでの注記を推奨する。

---

### F7-004: detectWorktreeSessionStatus の呼び出し元が間接影響ファイルに未記載

**カテゴリ**: 影響範囲の欠落
**場所**: 関連ファイル

`detectWorktreeSessionStatus()` は `src/app/api/worktrees/route.ts` と `src/app/api/worktrees/[id]/route.ts` から呼ばれている。対策3による `worktree-status-helper.ts` の内部変更で、これらのAPIのステータス検出結果が改善される。関数シグネチャは変わらないため破壊的変更はないが、間接影響ファイルとして記載することが望ましい。

---

## 総合評価

Issue #501 は Stage 3 の影響範囲レビュー指摘を概ね的確に反映しており、影響範囲の文書化品質は高い。特に以下の点が改善されている:

1. **対策間の依存関係**が明示的にセクション化されている
2. **CLIツール間のタイムスタンプ干渉リスク**がスコープ判断と共に記載されている
3. **間接影響ファイル**に `session-cleanup.ts` と `resource-cleanup.ts` が追加されている
4. **テスト要件**が受入条件に具体化されている

残りの指摘は方針確定（F7-001）とテストファイル名の明記（F7-002）の2件が should_fix であり、実装着手前に対応することを推奨する。

## 参照ファイル

### コード（直接変更対象）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 対策1（型・state・fetch・useAutoYes引数の4箇所）
- `src/lib/auto-yes-poller.ts`: 対策2（ポーラー再利用ロジック）
- `src/app/api/worktrees/[id]/current-output/route.ts`: 対策3（detectSessionStatus に lastOutputTimestamp を渡す）
- `src/lib/session/worktree-status-helper.ts`: 対策3（detectSessionStatus に lastOutputTimestamp を渡す）
- `src/app/api/worktrees/[id]/auto-yes/route.ts`: 対策2（already_running ハンドリング）

### コード（間接影響）
- `src/hooks/useAutoYes.ts`: 対策1で lastServerResponseTimestamp が正しく渡される（変更不要）
- `src/lib/detection/status-detector.ts`: 既存の lastOutputTimestamp パラメータを活用（変更不要）
- `src/lib/session-cleanup.ts`: stopAutoYesPolling 経由の影響（変更不要）
- `src/lib/resource-cleanup.ts`: 孤立ポーラー検出への影響（変更不要）
- `src/app/api/worktrees/route.ts`: detectWorktreeSessionStatus 呼び出し元（変更不要）
- `src/app/api/worktrees/[id]/route.ts`: detectWorktreeSessionStatus 呼び出し元（変更不要）

### テスト
- `tests/unit/lib/auto-yes-manager.test.ts`: ポーラー再利用テスト追加先
- `tests/unit/hooks/useAutoYes.test.ts`: lastServerResponseTimestamp 重複防止テスト追加先
