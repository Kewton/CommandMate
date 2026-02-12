# Issue #237 レビューレポート

**レビュー日**: 2026-02-11
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 2 |

**結論**: 全ての前回指摘事項が適切に反映されており、新たなMust Fix / Should Fixの指摘事項は発見されなかった。Issueは実装着手可能な状態にある。

---

## 前回指摘事項の対応確認

### Stage 3 指摘事項

| ID | 指摘内容 | ステータス | 確認結果 |
|----|---------|----------|---------|
| MF-1 | テストファイル6件の影響範囲追加 | VERIFIED | 6件すべてが変更対象ファイルテーブルに追加済み。各ファイルの具体的な修正内容（vi.mock行番号、テストケース削除対象）も正確 |
| SF-1 | session-cleanup.test.tsテストケース削除の明記 | VERIFIED | L58-66の'should stop claude-poller'テストケース削除が変更対象ファイルテーブルと受入条件に明記済み |
| SF-2 | manager-stop-pollers.test.tsテストケース3件削除の明記 | VERIFIED | L43-71の3テストケース削除が変更対象ファイルテーブルと受入条件に明記済み |
| SF-3 | session-cleanup.tsのJSDocコメント更新 | VERIFIED | L7（claude-poller言及削除）とL54（ステップ3記述削除）の更新が修正内容に記載済み |

### Stage 5 指摘事項

| ID | 指摘内容 | ステータス | 確認結果 |
|----|---------|----------|---------|
| MF-1 | api-prompt-handling.test.tsのL239-268テストケース削除 | VERIFIED | 変更対象ファイルテーブルにL239-268の'should resume polling after responding'テストケース削除が追加済み。受入条件にも反映 |
| SF-1 | session-cleanup.tsのL110コメント番号更新 | VERIFIED | 修正が必要なファイルテーブル、影響範囲テーブル、受入条件の3箇所に「`// 3.`から`// 2.`への更新」が記載済み |

---

## 影響範囲の網羅性確認

### 削除対象ファイル（5件）

| ファイル | 相互参照の確認結果 |
|---------|--------------------|
| `src/lib/claude-poller.ts` | 参照元: session-cleanup.ts（L11）、manager.ts（L11）のみ。両方が修正対象に含まれている |
| `src/lib/terminal-websocket.ts` | 参照元: なし（完全なデッドコード）。問題なし |
| `src/components/worktree/WorktreeDetail.tsx` | 参照元: index.ts（L12-13）のみ。index.tsが修正対象に含まれている。内部にsimple-terminalへのリンク（L652, L678）があるが、同時削除のため問題なし |
| `src/app/worktrees/[id]/simple-terminal/page.tsx` | 参照元: Next.jsルーティングのみ（直接importなし）。問題なし |
| `src/components/SimpleTerminal.tsx` | 参照元: simple-terminal/page.tsx（L9）のみ。同時削除のため問題なし |

### 修正対象ファイル（9件 + docs 1件）

| ファイル | 修正内容の正確性 |
|---------|-----------------|
| `src/lib/session-cleanup.ts` | import削除（L11）、L100-108ブロック削除、L110コメント番号更新、JSDoc更新（L7, L54）-- 全て正確 |
| `src/lib/cli-tools/manager.ts` | import削除（L11）、L175-178ブロック削除 -- 全て正確 |
| `src/components/worktree/index.ts` | L12-13のexport削除 -- 正確 |
| `docs/architecture.md` | L569のclaude-poller言及更新 -- 正確 |
| `tests/unit/session-cleanup.test.ts` | vi.mock削除（L15-17）、import削除（L26）、テストケース削除（L58-66） -- 全て正確 |
| `tests/unit/cli-tools/manager-stop-pollers.test.ts` | vi.mock削除（L14-17）、テストケース3件削除（L43-71） -- 全て正確 |
| `tests/integration/api-kill-session-cli-tool.test.ts` | vi.mock削除（L19-22） -- 正確 |
| `tests/integration/api-prompt-handling.test.ts` | vi.mock削除（L53-57）、テストケース削除（L239-268） -- 全て正確 |
| `tests/integration/api-respond-cli-tool.test.ts` | vi.mock削除（L18-21） -- 正確 |
| `tests/integration/api-send-cli-tool.test.ts` | vi.mock削除（L49-51） -- 正確 |

### 設定ファイルへの影響

| ファイル | 影響 |
|---------|------|
| `tsconfig.json` | 影響なし |
| `next.config.js` | 影響なし |
| `package.json` | 影響なし |
| `vitest.config.ts` | 影響なし |
| `.eslintrc.json` | 影響なし |

### 変更なしの関連ファイル

| ファイル | 確認結果 |
|---------|---------|
| `src/lib/response-poller.ts` | claude-pollerの後継。変更不要 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | WorktreeDetailの後継。`src/app/worktrees/[id]/page.tsx`から直接importされており、index.ts経由ではない。変更不要 |
| `src/app/page.tsx` | index.tsからWorktrreeListをimport。WorktreeDetail削除の影響なし |
| `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` | claude-poller, WorktreeDetailに言及するが、過去の実装計画書であり更新不要（Stage 1 NTH-1で判断済み） |

### 破壊的変更

なし。削除対象は全て未使用コードであり、外部公開APIへの影響はない。

---

## Nice to Have（あれば良い）

### NTH-1: 内部ドキュメントのclaude-poller/WorktreeDetail言及

**カテゴリ**: ドキュメント更新
**場所**: `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md`

**問題**:
内部ドキュメントがclaude-poller.ts（L456, L589, L1137）とWorktreeDetail.tsx（L870, L872, L875, L1149）に複数箇所で言及しているが、影響範囲に含まれていない。

**判断**:
Stage 1のNTH-1で対応不要と判断済み。内部ドキュメント（docs/internal/）は過去の実装計画書であり、削除対象ファイルとの齟齬が生じても実害はない。将来的に内部ドキュメントの整理を行う際の更新候補とすることを推奨する。

---

### NTH-2: テストファイル名の意味的整合性

**カテゴリ**: 整合性
**場所**: `tests/unit/cli-tools/manager-stop-pollers.test.ts`

**問題**:
claude-poller関連3テストケース削除後、残存テストはresponse-pollerの動作検証のみとなる。テストファイル名の'stop-pollers'（複数形）との意味的な齟齬がわずかに生じる。

**判断**:
本Issueのスコープ外。response-pollerを「各CLIツールに対して停止する」という意味で複数形は許容範囲内であり、変更は不要。

---

## 受入条件の検証

Issue記載の受入条件15項目を検証した結果、全項目が適切に定義されている。

| # | 受入条件 | 検証可能性 |
|---|---------|----------|
| 1 | 削除対象ファイル5件の削除 | ファイル存在チェックで検証可能 |
| 2 | 参照ファイルのimport/export更新 | ビルド成功で検証可能 |
| 3 | stopClaudePolling呼び出し削除 | コード検索で検証可能 |
| 4 | JSDocコメント更新 | コード確認で検証可能 |
| 5 | コメント番号更新 | コード確認で検証可能 |
| 6 | docs/architecture.md更新 | テキスト確認で検証可能 |
| 7 | テストファイル6件のvi.mock削除 | grep検索で検証可能 |
| 8 | session-cleanup.test.tsテストケース削除 | テスト実行で検証可能 |
| 9 | manager-stop-pollers.test.tsテストケース3件削除 | テスト実行で検証可能 |
| 10 | api-prompt-handling.test.tsテストケース削除 | テスト実行で検証可能 |
| 11 | npm run build 成功 | CI/CDで検証可能 |
| 12 | npm run test:unit パス | CI/CDで検証可能 |
| 13 | npm run test:integration パス | CI/CDで検証可能 |
| 14 | npm run lint エラーなし | CI/CDで検証可能 |
| 15 | 既存機能への影響なし | テスト全体パスで検証可能 |

---

## 参照ファイル

### コード
- `src/lib/session-cleanup.ts`: claude-poller関連コード（L7, L11, L54, L100-108, L110）の削除・更新
- `src/lib/cli-tools/manager.ts`: claude-poller関連コード（L11, L175-178）の削除
- `src/components/worktree/index.ts`: WorktreeDetail export（L12-13）の削除
- `tests/unit/session-cleanup.test.ts`: vi.mock・import・テストケースの削除
- `tests/unit/cli-tools/manager-stop-pollers.test.ts`: vi.mock・テストケース3件の削除
- `tests/integration/api-prompt-handling.test.ts`: vi.mock・テストケース1件の削除
- `tests/integration/api-kill-session-cli-tool.test.ts`: vi.mock行の削除
- `tests/integration/api-respond-cli-tool.test.ts`: vi.mock行の削除
- `tests/integration/api-send-cli-tool.test.ts`: vi.mock行の削除

### ドキュメント
- `docs/architecture.md`: L569のclaude-poller言及更新
- `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md`: 内部ドキュメント（更新不要）
