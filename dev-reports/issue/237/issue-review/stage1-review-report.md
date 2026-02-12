# Issue #237 レビューレポート

**レビュー日**: 2026-02-11
**フォーカス**: 通常レビュー
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 2 |

全体として、削除対象の選定自体は妥当であり、未使用コードの特定は正確です。ただし、LOC見積もりに大幅な誤差があること、修正対象ファイルの変更内容の記述が不十分であること、およびドキュメント更新の考慮が欠落している点が主要な問題です。

---

## Must Fix（必須対応）

### MF-1: WorktreeDetail.tsx のLOC見積もりが大幅に誤っている

**カテゴリ**: 正確性
**場所**: リファクタリング方針 > 削除対象テーブル

**問題**:
`WorktreeDetail.tsx` のLOCが `~200` と記載されていますが、実測値は **937行** です。約4.7倍の誤差があります。

**証拠**:
```
$ wc -l src/components/worktree/WorktreeDetail.tsx
     937 src/components/worktree/WorktreeDetail.tsx
```

**推奨対応**:
LOCを `~200` から `~937` に修正してください。

---

### MF-2: terminal-websocket.ts のLOC見積もりが誤っている

**カテゴリ**: 正確性
**場所**: リファクタリング方針 > 削除対象テーブル

**問題**:
`terminal-websocket.ts` のLOCが `~150` と記載されていますが、実測値は **222行** です。

**証拠**:
```
$ wc -l src/lib/terminal-websocket.ts
     222 src/lib/terminal-websocket.ts
```

**推奨対応**:
LOCを `~150` から `~222` に修正してください。

---

### MF-3: session-cleanup.ts と manager.ts の修正内容が不十分な記載

**カテゴリ**: 完全性
**場所**: リファクタリング方針 > 修正が必要なファイル（参照の更新）テーブル

**問題**:
修正内容が「`claude-poller.ts`からのimportを削除・代替」と記載されていますが、実際にはimport文の削除だけでなく、**関数呼び出しロジックの削除**も必要です。単純なimport削除と誤解されると、ビルドエラーまたはランタイムエラーの原因となります。

**証拠**:

`src/lib/session-cleanup.ts` L100-108:
```typescript
// 2. Stop claude-poller (once per worktree, not per CLI tool)
try {
  stopClaudePolling(worktreeId);
  result.pollersStopped.push('claude-poller');
} catch (error) {
  const errorMsg = `claude-poller: ${error instanceof Error ? error.message : String(error)}`;
  result.pollerErrors.push(errorMsg);
  console.warn(`${LOG_PREFIX} Failed to stop claude-poller ${worktreeId}:`, error);
}
```

`src/lib/cli-tools/manager.ts` L171-178:
```typescript
stopPollers(worktreeId: string, cliToolId: CLIToolType): void {
  stopResponsePolling(worktreeId, cliToolId);
  // claude-poller is Claude-specific
  if (cliToolId === 'claude') {
    stopClaudePolling(worktreeId);
  }
}
```

**推奨対応**:
修正内容を以下のように具体化してください:

| ファイル | 修正内容 |
|---------|---------|
| `src/lib/session-cleanup.ts` | `claude-poller`のimport文削除、L100-108のstopClaudePolling呼び出しブロック全体を削除、コメント（L7, L54）の更新 |
| `src/lib/cli-tools/manager.ts` | `claude-poller`のimport文削除、stopPollers()メソッド内のclaude-poller呼び出しロジック（L175-178）を削除 |

---

## Should Fix（推奨対応）

### SF-1: SimpleTerminal.tsx のLOCが欠落

**カテゴリ**: 完全性
**場所**: リファクタリング方針 > 削除対象テーブル

**問題**:
`SimpleTerminal.tsx` のLOCが `-` と記載されており、見積もりが欠落しています。削除対象としてリストされているにもかかわらず、LOCが未記入なのは不整合です。

**証拠**:
```
$ wc -l src/components/SimpleTerminal.tsx
     253 src/components/SimpleTerminal.tsx
```

**推奨対応**:
LOCを `~253` に設定してください。

---

### SF-2: ドキュメント更新が影響範囲に含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル テーブル

**問題**:
`docs/architecture.md` の L569 に `claude-poller` への言及があり、削除後に内容が陳腐化します。影響範囲の変更対象ファイルにドキュメントが含まれていません。

**証拠**:
```
docs/architecture.md L569:
3. response-poller / claude-pollerを停止
```

**推奨対応**:
影響範囲テーブルに以下を追加してください:

| ファイル | 変更内容 |
|---------|---------|
| `docs/architecture.md` | L569の「response-poller / claude-pollerを停止」を「response-pollerを停止」に修正 |

---

### SF-3: index.ts のWorktereeDetailRefactored export追加の検討が必要

**カテゴリ**: 完全性
**場所**: リファクタリング方針 > 修正が必要なファイル

**問題**:
現在 `src/components/worktree/index.ts` は `WorktreeDetail` をexportしています。削除時にこのexportを削除するだけでよいのか、代わりに `WorktreeDetailRefactored` のexportを追加すべきかの判断が記載されていません。

**証拠**:
- `src/components/worktree/index.ts` L12-13: `WorktreeDetail` をexport
- `src/app/worktrees/[id]/page.tsx` L10: `WorktreeDetailRefactored` を直接import（barrel exportを使用していない）
- `src/components/worktree/index.ts` には `WorktreeDetailRefactored` のexportが存在しない

**推奨対応**:
修正内容の記載を以下のいずれかに更新してください:
- A) `WorktreeDetail` のexportを削除するのみ（現状の利用者が直接importしているため）
- B) `WorktreeDetail` のexportを `WorktreeDetailRefactored` のexportに置き換える（barrel exportの一貫性のため）

---

### SF-4: 総LOC削減数が大幅に過小評価されている

**カテゴリ**: 明確性
**場所**: リファクタリング方針 > After

**問題**:
「約840行以上のデッドコードを削減」と記載されていますが、実測値に基づく合計は **約1,903行** であり、2倍以上過小評価されています。

**証拠**:

| ファイル | 記載LOC | 実測LOC |
|---------|---------|---------|
| claude-poller.ts | ~400 | 400 |
| terminal-websocket.ts | ~150 | 222 |
| WorktreeDetail.tsx | ~200 | 937 |
| simple-terminal/page.tsx | ~90 | 91 |
| SimpleTerminal.tsx | - | 253 |
| **合計** | **~840** | **1,903** |

**推奨対応**:
「約840行以上のデッドコードを削減」を「約1,900行以上のデッドコードを削減」に修正してください。

---

## Nice to Have（あれば良い）

### NTH-1: 内部設計ドキュメントへの言及がある

**カテゴリ**: 完全性
**場所**: 影響範囲

**問題**:
`docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` が `claude-poller.ts` と `WorktreeDetail.tsx` に言及しています。内部ドキュメントであるため影響は限定的ですが、整合性の観点から更新を検討する余地があります。

**証拠**:
- L456: `src/lib/claude-poller.ts` (MODIFY)
- L589: `import { startPolling } from '@/lib/claude-poller';`
- L872: `src/components/worktree/WorktreeDetail.tsx` (MODIFY)

**推奨対応**:
任意対応として、内部設計ドキュメントの更新を記載することを検討してください。

---

### NTH-2: 受入条件にドキュメント整合性の確認がない

**カテゴリ**: 完全性
**場所**: 受入条件

**問題**:
現在の受入条件はビルド・テスト・リントの成功確認のみで、ドキュメントの整合性確認が含まれていません。

**推奨対応**:
「関連ドキュメント（docs/architecture.md等）が更新されていること」を受入条件に追加することを検討してください。

---

## 削除対象の妥当性検証

### 未使用確認結果

| ファイル | import参照数 | テスト参照 | 動的import | 判定 |
|---------|-------------|----------|-----------|------|
| claude-poller.ts | 2箇所（session-cleanup.ts, manager.ts） | なし | なし | stopPolling のみ使用。startPolling は未使用 |
| terminal-websocket.ts | 0箇所 | なし | なし | 完全なデッドコード |
| WorktreeDetail.tsx | 0箇所（index.tsのexportのみ） | なし | なし | barrel exportのみで実際のインポートなし |
| simple-terminal/page.tsx | 0箇所（Next.jsルート） | なし | なし | ルートとして存在するが未参照 |
| SimpleTerminal.tsx | 1箇所（simple-terminal/page.tsxのみ） | なし | なし | 削除対象ページからのみ参照 |

全ての削除対象が妥当であることを確認しました。

---

## 参照ファイル

### コード
- `src/lib/claude-poller.ts`: 削除対象ファイル（400行）
- `src/lib/terminal-websocket.ts`: 削除対象ファイル（222行）
- `src/components/worktree/WorktreeDetail.tsx`: 削除対象ファイル（937行）
- `src/app/worktrees/[id]/simple-terminal/page.tsx`: 削除対象ファイル（91行）
- `src/components/SimpleTerminal.tsx`: 削除対象ファイル（253行）
- `src/lib/session-cleanup.ts`: 修正対象ファイル（import + ロジック削除）
- `src/lib/cli-tools/manager.ts`: 修正対象ファイル（import + ロジック削除）
- `src/components/worktree/index.ts`: 修正対象ファイル（export削除）

### ドキュメント
- `docs/architecture.md`: claude-pollerへの言及あり（L569）
- `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md`: claude-poller, WorktreeDetailへの言及あり（内部ドキュメント）
