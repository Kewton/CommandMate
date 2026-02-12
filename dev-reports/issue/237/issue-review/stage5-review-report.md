# Issue #237 レビューレポート

**レビュー日**: 2026-02-11
**フォーカス**: 通常レビュー
**イテレーション**: 2回目（Stage 5）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 1 |
| Nice to Have | 2 |

## 前回指摘の対応確認

Stage 1-4 で指摘されたすべての項目が適切に反映されていることを確認した。

### Stage 1 Must Fix（3件） -- すべて対応済み

| ID | 指摘内容 | 状態 |
|----|---------|------|
| MF-1 | WorktreeDetail.tsx LOC ~200 -> ~937 | 対応済み |
| MF-2 | terminal-websocket.ts LOC ~150 -> ~222 | 対応済み |
| MF-3 | session-cleanup.ts/manager.ts の修正内容具体化 | 対応済み -- import削除に加え、関数呼び出しブロック削除とJSDocコメント更新が明記されている |

### Stage 1 Should Fix（4件） -- すべて対応済み

| ID | 指摘内容 | 状態 |
|----|---------|------|
| SF-1 | SimpleTerminal.tsx LOC 「-」 -> ~253 | 対応済み |
| SF-2 | docs/architecture.md を影響範囲に追加 | 対応済み |
| SF-3 | index.ts での WorktreeDetailRefactored export検討 | 対応済み -- 検討事項として記載されている |
| SF-4 | 総LOC 約840行 -> 約1,900行以上 | 対応済み |

### Stage 3 Must Fix（1件） -- 対応済み

| ID | 指摘内容 | 状態 |
|----|---------|------|
| MF-1 | テストファイル6件を影響範囲に追加 | 対応済み -- 6件すべて変更対象ファイルテーブルに記載、受入条件にも反映 |

### Stage 3 Should Fix（3件） -- すべて対応済み

| ID | 指摘内容 | 状態 |
|----|---------|------|
| SF-1 | session-cleanup.test.ts テストケース削除明記 | 対応済み -- 受入条件に1件の削除が明記 |
| SF-2 | manager-stop-pollers.test.ts テストケース3件削除明記 | 対応済み -- 受入条件に3件の削除が明記 |
| SF-3 | session-cleanup.ts JSDocコメント更新 | 対応済み -- L7, L54の具体的な修正内容が記載 |

---

## Must Fix（必須対応）

### MF-1: api-prompt-handling.test.ts のインライン動的importの記載漏れ

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > 変更対象ファイル テーブル > `tests/integration/api-prompt-handling.test.ts`

**問題**:
Issueでは `api-prompt-handling.test.ts` の変更内容として「`vi.mock('@/lib/claude-poller')`行の削除（L53-57）」のみ記載されている。しかし、同ファイルのL240に `const { startPolling } = await import('@/lib/claude-poller');` というインライン動的importが存在し、L267で `expect(startPolling).toHaveBeenCalledWith('test-worktree');` というアサーションが使用されている。

`vi.mock`行の削除だけでは、このテストケース（L239-268: `'should resume polling after responding'`）内のimport解決がモジュール不在で失敗し、テスト実行時にエラーとなる。

**証拠**:
```typescript
// tests/integration/api-prompt-handling.test.ts
// L239-268
it('should resume polling after responding', async () => {
  const { startPolling } = await import('@/lib/claude-poller');  // L240
  // ...
  expect(startPolling).toHaveBeenCalledWith('test-worktree');     // L267
});
```

他の4つのintegrationテストファイル（api-send-cli-tool, api-respond-cli-tool, api-kill-session-cli-tool, api-send-cli-tool）にはvi.mock以外のclaude-poller参照がないことを確認済み。

**推奨対応**:
1. 変更対象ファイルテーブルの `api-prompt-handling.test.ts` の変更内容を以下に更新:
   - 「`vi.mock('@/lib/claude-poller')`行の削除（L53-57）、および `'should resume polling after responding'` テストケースの削除または修正（L239-268: L240のインライン動的importとL267のstartPollingアサーション）」
2. 受入条件に「`api-prompt-handling.test.ts` のclaude-poller参照テストケースが削除/修正されていること」を追加

---

## Should Fix（推奨対応）

### SF-1: session-cleanup.ts のステップ番号コメント更新の未記載

**カテゴリ**: 明確性
**場所**: ## リファクタリング方針 > 修正が必要なファイル > `src/lib/session-cleanup.ts`

**問題**:
`session-cleanup.ts` の `cleanupWorktreeSessions` 関数内には、処理ステップを示すコメントが振られている:
- L74: `// 1. Kill sessions and stop response-pollers for each CLI tool`
- L100: `// 2. Stop claude-poller (once per worktree, not per CLI tool)` -- 削除対象
- L110: `// 3. Stop auto-yes-poller (Issue #138)`

claude-pollerブロック（L100-108）を削除した後、auto-yes-pollerのコメントが `// 3.` のまま残ると、ステップ1の次がステップ3になり不整合が生じる。

**証拠**:
```typescript
// src/lib/session-cleanup.ts
// L74:  // 1. Kill sessions and stop response-pollers ...
// L100: // 2. Stop claude-poller ... (削除対象)
// L110: // 3. Stop auto-yes-poller (Issue #138)
```

**推奨対応**:
`session-cleanup.ts` の修正内容に「L110のコメント番号を `// 3.` から `// 2.` に更新」を追加する。

---

## Nice to Have（あれば良い）

### NTH-1: manager.ts の Future コメントの扱い

**カテゴリ**: 明確性
**場所**: ## リファクタリング方針 > 修正が必要なファイル > `src/lib/cli-tools/manager.ts`

**問題**:
`manager.ts` L179に `// Future: Add other tool-specific pollers here if needed` というコメントがある。claude-pollerの条件分岐（L175-178）を削除した後、このコメントの扱いが明記されていない。

**推奨対応**:
実装者の判断に委ねる旨を記載してもよい。stopPollers()メソッドがresponse-pollerの呼び出しのみになるため、Futureコメントを残すか削除するかは実装時に判断できる。

### NTH-2: 行番号の参考値である旨の補足

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > 変更対象ファイル テーブル

**問題**:
影響範囲テーブルには多数の具体的な行番号が記載されている（L15-17, L26, L53-57, L58-66, L100-108, L175-178等）。これらは現時点のスナップショットであり、他のブランチからの変更がマージされた場合にずれる可能性がある。

**推奨対応**:
影響範囲テーブルの注釈として「行番号は main ブランチ c20b609 時点の参考値」などの補足を追加することを検討する。

---

## 全体評価

Stage 1-4 の指摘はすべて適切に反映されており、Issue全体の品質は大幅に向上している。LOCの正確性、修正内容の具体性、テストファイルの影響範囲、受入条件の網羅性のいずれも十分な水準に達している。

今回新たに発見された Must Fix 1件（api-prompt-handling.test.ts のインライン動的import漏れ）は、修正しないとテスト実行が失敗する実質的な問題であるため対応が必要だが、修正自体は限定的で容易である。

Should Fix 1件（ステップ番号コメント）も軽微な修正であり、実装時に自然に対応される可能性が高い。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-237/tests/integration/api-prompt-handling.test.ts`: L240のインライン動的importとL267のアサーションがIssue記載漏れ
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-237/src/lib/session-cleanup.ts`: L100-108の削除後、L110のauto-yes-pollerコメント番号が不整合
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-237/src/lib/cli-tools/manager.ts`: L179のFutureコメントの扱いが未定義
