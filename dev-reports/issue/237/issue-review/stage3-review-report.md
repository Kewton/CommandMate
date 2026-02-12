# Issue #237 レビューレポート (Stage 3)

**レビュー日**: 2026-02-11
**フォーカス**: 影響範囲レビュー（1回目）
**イテレーション**: 1
**ステージ**: 3/4

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

Stage 1/2で指摘されたLOC・修正内容の具体化・ドキュメント影響範囲は既に反映済みです。本Stage 3では **テストファイルへの影響** を中心に精査した結果、**6件のテストファイルが claude-poller.ts を直接mockしており、削除後にテストが失敗する** ことが判明しました。これはIssueの影響範囲・変更対象ファイルに含まれていません。

---

## Must Fix（必須対応）

### MF-1: テストファイル6件がclaude-pollerをmockしており削除後にテスト失敗する

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲 > 変更対象ファイル テーブル / ## 受入条件

**問題**:
`claude-poller.ts` を削除すると、以下の6件のテストファイルで `vi.mock('@/lib/claude-poller')` のモジュール解決が失敗し、テストが実行不能になります。Issueの受入条件に「`npm run test:unit` が全テストパスすること」「`npm run lint` がエラーなしで通ること」がありますが、変更対象ファイルにこれらのテストファイルが含まれていません。

**影響を受けるテストファイル**:

| テストファイル | mockの位置 | 修正内容 |
|--------------|-----------|---------|
| `tests/unit/session-cleanup.test.ts` | L15-17 | vi.mock削除、L26のimport削除、L58-66のテストケース削除 |
| `tests/unit/cli-tools/manager-stop-pollers.test.ts` | L14-17 | vi.mock削除、L43-71のclaude-poller関連テストケース3件の削除 |
| `tests/integration/api-kill-session-cli-tool.test.ts` | L19-22 | vi.mock行の削除 |
| `tests/integration/api-prompt-handling.test.ts` | L53-57 | vi.mock行の削除 |
| `tests/integration/api-respond-cli-tool.test.ts` | L18-21 | vi.mock行の削除 |
| `tests/integration/api-send-cli-tool.test.ts` | L49-51 | vi.mock行の削除 |

**証拠**:
```
$ grep -rn "vi.mock.*claude-poller" tests/
tests/unit/session-cleanup.test.ts:15:vi.mock('@/lib/claude-poller', () => ({
tests/unit/cli-tools/manager-stop-pollers.test.ts:15:vi.mock('@/lib/claude-poller', () => ({
tests/integration/api-kill-session-cli-tool.test.ts:20:vi.mock('@/lib/claude-poller', () => ({
tests/integration/api-prompt-handling.test.ts:54:vi.mock('@/lib/claude-poller', () => ({
tests/integration/api-respond-cli-tool.test.ts:19:vi.mock('@/lib/claude-poller', () => ({
tests/integration/api-send-cli-tool.test.ts:49:vi.mock('@/lib/claude-poller', () => ({
```

**推奨対応**:
上記6ファイルを影響範囲の変更対象ファイルテーブルに追加し、各ファイルの具体的な修正内容を記載してください。

---

## Should Fix（推奨対応）

### SF-1: session-cleanup.test.tsのclaude-poller関連テストケースの削除明記

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲 > 変更対象ファイル テーブル

**問題**:
`tests/unit/session-cleanup.test.ts` の L58-66 に `should stop claude-poller` テストケースが存在します。`session-cleanup.ts` から claude-poller 呼び出しブロック (L100-108) を削除する以上、このテストケースは検証対象がなくなり、削除が必要です。

**証拠**:
```typescript
// tests/unit/session-cleanup.test.ts L58-66
it('should stop claude-poller', async () => {
  const killSessionFn = vi.fn().mockResolvedValue(true);
  await cleanupWorktreeSessions('wt-1', killSessionFn);
  // Should call stopClaudePolling once per worktree
  expect(stopClaudePolling).toHaveBeenCalledTimes(1);
  expect(stopClaudePolling).toHaveBeenCalledWith('wt-1');
});
```

**推奨対応**:
テストケースの削除を修正内容に明記してください。

---

### SF-2: manager-stop-pollers.test.tsのclaude-poller関連テストケース3件の削除明記

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲 > 変更対象ファイル テーブル

**問題**:
`tests/unit/cli-tools/manager-stop-pollers.test.ts` の L43-71 に claude-poller 呼び出しの有無を検証するテストケースが3件存在します。

```
L43: 'should stop claude-poller only for claude tool'
L53: 'should NOT stop claude-poller for codex tool'
L63: 'should NOT stop claude-poller for gemini tool'
```

`manager.ts` から claude-poller 呼び出しブロック (L175-178) を削除する以上、これら3テストケースは不要です。

**証拠**:
```typescript
// tests/unit/cli-tools/manager-stop-pollers.test.ts L43-50
it('should stop claude-poller only for claude tool', async () => {
  const { stopPolling: stopResponsePolling } = await import('@/lib/response-poller');
  const { stopPolling: stopClaudePolling } = await import('@/lib/claude-poller');
  manager.stopPollers('test-worktree', 'claude');
  expect(stopResponsePolling).toHaveBeenCalledWith('test-worktree', 'claude');
  expect(stopClaudePolling).toHaveBeenCalledWith('test-worktree');
});
```

**推奨対応**:
3テストケースの削除を修正内容に明記してください。

---

### SF-3: session-cleanup.tsのJSDocコメント更新の明記

**カテゴリ**: ドキュメント更新
**場所**: ## リファクタリング方針 > 修正が必要なファイル

**問題**:
`session-cleanup.ts` のJSDocコメントに claude-poller への言及が2箇所残っています。

- L7: `Abstracts the differences between response-poller and claude-poller.`
- L54: `3. Stops claude-poller for the worktree`

現在のIssueでは import削除と関数呼び出しブロック削除のみ記載されていますが、コメントの更新も含めるべきです。

**推奨対応**:
修正内容にコメント更新を追加してください:
- L7 -> `Provides a unified interface for cleaning up CLI tool sessions and pollers.`（claude-poller 言及を削除）
- L54 -> 行削除（番号繰り上げ）

---

## Nice to Have（あれば良い）

### NTH-1: 削除順序は一括で問題ないことの確認記載

**カテゴリ**: 削除順序
**場所**: ## リファクタリング方針

**問題**:
削除を段階的に行うべきか一括で行うべきかの記載がありません。

**調査結果**:
依存関係を精査した結果、**一括削除で問題ありません**。理由は以下の通りです:
1. `claude-poller.ts` の参照元は `session-cleanup.ts` と `manager.ts` の2箇所のみ。両方を同一コミットで修正すれば問題なし
2. `SimpleTerminal.tsx` は `simple-terminal/page.tsx` からのみ参照。同時削除で問題なし
3. `WorktreeDetail.tsx` は `index.ts` からの export のみで、外部 import なし。export 行の削除で完結
4. `terminal-websocket.ts` は完全なデッドコード。依存関係なし
5. 循環依存は確認されなかった

---

### NTH-2: 型定義の影響なしの確認

**カテゴリ**: 型定義
**場所**: ## リファクタリング方針

**問題**:
`WorktreeDetailProps` が `index.ts` から re-export されていますが、外部からの import は確認されませんでした。

**調査結果**:
- `src/app/page.tsx` が `@/components/worktree` (index.ts) から `WorktreeList` をインポートしているが、`WorktreeDetail`/`WorktreeDetailProps` は使用していない
- `WorktreeDetailRefactoredProps` は `WorktreeDetailRefactored.tsx` 内で独自に定義されており、旧 `WorktreeDetailProps` とは独立
- `claude-poller.ts` の `stopAllPolling()` と `getActivePollers()` は claude-poller.ts 内部でのみ定義されており、外部からの import なし。`response-poller.ts` に同名の関数が存在するため混同リスクもなし

---

## 影響範囲の全体像

### 変更対象ファイル（更新提案）

現在のIssue記載に加えて、以下のテストファイルを追加すべきです。

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/session-cleanup.test.ts` | `vi.mock('@/lib/claude-poller')` 削除、`stopClaudePolling` import削除、`should stop claude-poller` テストケース削除 |
| `tests/unit/cli-tools/manager-stop-pollers.test.ts` | `vi.mock('@/lib/claude-poller')` 削除、claude-poller関連テストケース3件削除 |
| `tests/integration/api-kill-session-cli-tool.test.ts` | `vi.mock('@/lib/claude-poller')` 行削除 |
| `tests/integration/api-prompt-handling.test.ts` | `vi.mock('@/lib/claude-poller')` 行削除 |
| `tests/integration/api-respond-cli-tool.test.ts` | `vi.mock('@/lib/claude-poller')` 行削除 |
| `tests/integration/api-send-cli-tool.test.ts` | `vi.mock('@/lib/claude-poller')` 行削除 |

### 影響のないことを確認した項目

| 確認項目 | 結果 |
|---------|------|
| tsconfig.json | 個別ファイルの参照なし。影響なし |
| .eslintrc.json | 個別ファイルの参照なし。影響なし |
| vitest.config.ts | 個別ファイルの参照なし。影響なし |
| next.config.* | 個別ファイルの参照なし。影響なし |
| package.json | 個別ファイルの参照なし。影響なし |
| README.md | 削除対象ファイルへの言及なし。影響なし |
| docs/implementation-history.md | 削除対象ファイルへの言及なし。影響なし |
| docs/features/* | 削除対象ファイルへの言及なし。影響なし |
| CLAUDE.md | 削除対象ファイルへの言及なし。影響なし |
| e2eテスト | e2eテストディレクトリは空。影響なし |
| ミドルウェア | middleware.ts は存在しない。影響なし |
| 型のre-export | WorktreeDetailPropsは外部未使用。影響なし |
| claude-pollerのstopAllPolling/getActivePollers | 外部未使用。response-pollerに同名関数あり混同なし |
| simple-terminalへのリンク | WorktreeDetail.tsx内のみ（同時削除）。影響なし |

---

## 参照ファイル

### テスト（修正が必要）
- `tests/unit/session-cleanup.test.ts`: claude-poller mock/import/テストケースの削除が必要
- `tests/unit/cli-tools/manager-stop-pollers.test.ts`: claude-poller mock/テストケース3件の削除が必要
- `tests/integration/api-kill-session-cli-tool.test.ts`: claude-poller mock行の削除が必要
- `tests/integration/api-prompt-handling.test.ts`: claude-poller mock行の削除が必要
- `tests/integration/api-respond-cli-tool.test.ts`: claude-poller mock行の削除が必要
- `tests/integration/api-send-cli-tool.test.ts`: claude-poller mock行の削除が必要

### コード（Issue既記載、変更なし）
- `src/lib/session-cleanup.ts`: 修正対象（import + 呼び出し + コメント）
- `src/lib/cli-tools/manager.ts`: 修正対象（import + 呼び出し）
- `src/components/worktree/index.ts`: 修正対象（export削除）

### ドキュメント
- `docs/architecture.md`: L569 修正（Issue既記載）
- `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md`: 内部ドキュメント（対応任意、Stage1 NTH-1）
