# Architecture Review Report: Issue #526 Stage 2 (整合性レビュー)

## Executive Summary

Issue #526の設計方針書「syncWorktreesToDB() tmuxセッションクリーンアップ」に対する整合性レビューを実施した。設計方針書と実際のコードベースの整合性は概ね良好であるが、1件のmust_fix（killWorktreeSession()のgetTool()戻り値処理の不整合）を検出した。

**判定**: conditionally_approved (条件付き承認)
**スコア**: 4/5

---

## Review Scope

- **対象**: 設計方針書 `dev-reports/design/issue-526-sync-tmux-cleanup-design-policy.md`
- **フォーカス**: 整合性（設計書と実装の整合性確認）
- **確認観点**:
  1. 設計方針書に記載されたコード例と実際のコードベースの整合性
  2. 設計方針書で参照しているファイルパス・行番号・関数名の正確性
  3. 設計方針書の各セクション間の整合性（矛盾がないか）
  4. 型定義（SyncResult等）の整合性

---

## Detailed Findings

### Must Fix (1件)

#### MF-C01: killWorktreeSession() の getTool() 戻り値のnullチェックが実装と不整合

**影響度**: High

設計方針書Section 3およびSection 11(SF-004対応)のkillWorktreeSession()コード例:

```typescript
const tool = manager.getTool(cliToolId);
if (!tool) return false;  // null check
```

実際の `CLIToolManager.getTool()` 実装 (`src/lib/cli-tools/manager.ts` L61-65):

```typescript
getTool(type: CLIToolType): ICLITool {
  const tool = this.tools.get(type);
  if (!tool) {
    throw new Error(`CLI tool '${type}' not found`);
  }
  return tool;
}
```

`getTool()` はツールが見つからない場合にnullを返さず、Errorをthrowする。既存の `repositories/route.ts` L30-44のローカル実装でもnullチェックなしで直接使用している。

**推奨対応**: 設計書のコード例を修正し、(A) nullチェックを除去して既存パターンに合わせるか、(B) try-catchでラップしてError時にfalseを返すパターンにする。既存のrepositories/route.tsに合わせるなら(A)が適切。

---

### Should Fix (4件)

#### SF-C01: syncWorktreesToDB()の空配列時の早期リターンがSyncResult未返却

**影響度**: Medium

現在の `syncWorktreesToDB()` 実装 (`src/lib/git/worktrees.ts` L269-272) では `worktrees.length === 0` の場合に `return;` で早期リターンしている。SyncResult型に変更後、このパスでも適切な戻り値を返す必要があるが、設計書のコード例にはこのケースの記載がない。

**推奨対応**: 設計書に `if (worktrees.length === 0) return { deletedIds: [], upsertedCount: 0 };` を明記する。

#### SF-C02: cleanupMultipleWorktrees()のwarningsに対する不要なnullish coalescing

**影響度**: Low

設計方針書のsyncWorktreesAndCleanup()コード例で `cleanupResult.warnings ?? []` としているが、`CleanupResult.warnings` は `string[]` 型（非optional）であり、undefinedにはならない。`?? []` は不要。

**推奨対応**: `cleanupResult.warnings` に修正する。

#### SF-C03: server.ts excludedPaths処理の行番号

**影響度**: Low

設計方針書Section 4-7でexcludedPaths削除処理の位置を「L225-232」としている。実際のserver.ts L225-232はexcludedPathsのログ出力とworktree削除のforループに概ね対応するが、修正対象の核心部分（deleteWorktreesByIds呼び出し）はL229付近。行番号はおおむね正確だが、コード変更により今後ずれる可能性がある。

**推奨対応**: 行番号よりもコードコンテキスト（関数名、コメント等）で位置を特定する記述に変更することを検討する。

#### SF-C04: worktrees.tsのexec使用に関するセキュリティ補足

**影響度**: Low

Section 9で「killSession()はexecFileを使用」と記載があるが、worktrees.tsが `exec` を使用している点に言及がない。本Issue #526の変更範囲ではworktrees.tsのexec使用箇所は変更しないため実質的な影響はないが、明記するとより安心感がある。

---

### Consider (3件)

#### C-C01: syncWorktreesAndCleanup()配置によるworktrees.tsへの逆依存

session-cleanup.ts が git/worktrees.ts に依存する新規パターンとなる。設計書Section 8で認識されているが、将来の循環依存リスクに注意が必要。

#### C-C02: clone-manager.tsのonCloneSuccess()でのawait追加

onCloneSuccess()は既にasyncメソッドだが、syncWorktreesAndCleanup()への置換時にawait追加を忘れないようチェックリストで明記すべき。

#### C-C03: 「4箇所で同一パターン使用」の内訳不明

Section 8のkillWorktreeSession共通化で「4箇所」の根拠が不明。現在のローカル定義は1箇所のみ。新規追加先を含むならその旨を補足すべき。

---

## Consistency Matrix

| 設計項目 | 設計書の記載 | 実装状況 | 整合性 |
|---------|------------|---------|-------|
| syncWorktreesToDB() シグネチャ | `(db: Database.Database, worktrees: Worktree[]): void` | L265-268: 一致 | OK |
| killWorktreeSession() 行番号 | repositories/route.ts:30-44 | L30-44: 一致 | OK |
| killSession() の execFile 使用 | Section 9 に記載 | tmux.ts L6, L372: execFileAsync使用 | OK |
| isRunning() の非同期性 | SF-004 で await 明記 | ICLITool.isRunning(): Promise<boolean> | OK |
| cleanupMultipleWorktrees() 構造 | forループ逐次実行、warnings収集 | session-cleanup.ts L160-173: 一致 | OK |
| getTool() の戻り値 | nullを返す前提 (null check) | throw Error if not found | NG (MF-C01) |
| worktrees.ts imports | child_process, util, path, etc. | 一致 | OK |
| CLI_TOOL_IDS 数 | 5 CLI tools | 5 items: claude, codex, gemini, vibe-local, opencode | OK |
| excludedPaths処理順序 | cleanup -> delete | 現状はdeleteのみ（cleanup追加が本Issue） | OK |
| sync処理順序 | delete -> cleanup | 現状syncWorktreesToDB内でdelete実行 | OK |

---

## Internal Consistency Check

| チェック項目 | Section間の関係 | 結果 |
|-------------|---------------|------|
| 処理順序の説明 | Section 2 vs Section 11 (SF-002) | 一貫性あり |
| ヘルパー関数の使用 | Section 4-3~4-7 vs Section 11 (MF-001) | 一貫性あり |
| 実装チェックリスト | Section 12 vs Section 4, 10 | 一貫性あり |
| 並列化の影響範囲 | Section 6 vs Section 11 (SF-003) | 一貫性あり |
| SyncResult型の配置 | Section 4-1 vs Section 11 (SF-001) | 一貫性あり |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | getTool()のnullチェックパターン不整合による実装時バグ | Medium | High | P1 |
| 技術的リスク | 空配列時の早期リターンでSyncResult未返却 | Medium | Medium | P2 |
| セキュリティ | 新たなセキュリティリスクなし（既存パターン踏襲） | Low | Low | P3 |
| 運用リスク | 行番号のずれによる将来の混乱 | Low | Medium | P3 |

---

## Approval Status

**条件付き承認 (Conditionally Approved)**

以下の条件を満たした上で実装に進むこと:

1. **MF-C01**: killWorktreeSession()のコード例におけるgetTool()戻り値処理を実際のAPIに合わせて修正する
2. **SF-C01**: syncWorktreesToDB()の空配列早期リターンケースをコード例に追加する（推奨）

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-03-20*
*Focus: 整合性 (Consistency)*
*Design Doc: dev-reports/design/issue-526-sync-tmux-cleanup-design-policy.md*
