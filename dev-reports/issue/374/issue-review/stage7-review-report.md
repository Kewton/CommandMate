# Issue #374 レビューレポート - Stage 7

**レビュー日**: 2026-02-28
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7/8

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

---

## Stage 3 指摘事項の反映確認

全10件のStage 3指摘（IR-001 ~ IR-010）が Issue本文に適切に反映されていることを確認した。

| ID | 反映状態 | 確認内容 |
|----|---------|---------|
| IR-001 | 反映済み | db.ts の getWorktrees()/getWorktreeById() の計6箇所の同期修正が明記 |
| IR-002 | 反映済み | 変更対象に WorktreeDetailRefactored.tsx / NotesAndLogsPane.tsx を追加 |
| IR-003 | 反映済み | defense-in-depth バリデーションの具体的コード例を記載 |
| IR-004 | 反映済み | db-migrations.test.ts の期待値更新（L37, L430, L443）を明記 |
| IR-005 | 反映済み | i18n キーの具体的テキスト値（en/ja）を記載 |
| IR-006 | 反映済み | 受け入れ基準に他ツールへの影響なし確認を追加 |
| IR-007 | 反映済み | API 後方互換性維持パターンを記載 |
| IR-008 | 反映済み | upsertWorktree() 修正不要の根拠を記載 |
| IR-009 | 反映済み | IR-002 と同一指摘、変更対象追加で対応 |
| IR-010 | 反映済み | CLAUDE.md 更新内容の具体的方針を記載 |

---

## Should Fix（推奨対応）

### IR2-001: スケジュール実行パスが context-window を考慮していない

**カテゴリ**: 影響範囲の漏れ
**場所**: `src/lib/schedule-manager.ts` L320, `src/lib/claude-executor.ts` L40-43, L100-104

**問題**:

`schedule-manager.ts` はスケジュール実行時に直接SQL `'SELECT path, vibe_local_model FROM worktrees WHERE id = ?'` でworktreeデータを取得している（`getWorktreeById()` を使用していない）。この SQL に `vibe_local_context_window` カラムが含まれていないため、スケジュール実行時に `--context-window` オプションは渡されない。

また、`claude-executor.ts` の `ExecuteCommandOptions` interface には `model` フィールドのみ定義されており、`contextWindow` フィールドが存在しない。`buildCliArgs()` 関数の `vibe-local` ケースにも `--context-window` 引数の構築ロジックがない。

これにより、対話モード（tmux セッション）と非対話モード（`-p` フラグによるスケジュール実行）で context-window 設定の有無に非対称が生じる。

**証拠**:

```typescript
// schedule-manager.ts L320 - vibe_local_context_window が SELECT に含まれない
const worktree = db.prepare('SELECT path, vibe_local_model FROM worktrees WHERE id = ?')
  .get(state.worktreeId);

// claude-executor.ts L40-43 - contextWindow フィールドがない
export interface ExecuteCommandOptions {
  model?: string;
  // contextWindow?: number; が必要
}

// claude-executor.ts L100-104 - --context-window 引数の構築ロジックがない
case 'vibe-local':
  if (options?.model) {
    return ['--model', options.model, '-p', message, '-y'];
  }
  return ['-p', message, '-y'];
```

**推奨対応**:

この非対称が意図的かどうかを Issue 本文で明示する。

- **意図的な場合**: 「スケジュール実行（`claude-executor.ts` 経由の `-p` モード）では context-window オプションは適用しない」と記載する。
- **サポートする場合**: 変更対象に以下を追加する:
  1. `src/lib/claude-executor.ts` - `ExecuteCommandOptions` に `contextWindow?: number` 追加、`buildCliArgs` の vibe-local ケースに `--context-window` 引数追加
  2. `src/lib/schedule-manager.ts` - SELECT 文に `vibe_local_context_window` 追加、options 構築ロジック拡張

---

### IR2-002: rollbackMigrations テストの down() 関数依存

**カテゴリ**: テスト範囲
**場所**: `tests/unit/lib/db-migrations.test.ts` L427-438, `src/lib/db-migrations.ts`

**問題**:

`db-migrations.test.ts` の rollbackMigrations テスト（L428-438）は、`runMigrations(db)` 後に `rollbackMigrations(db, 16)` を呼び出す。version 20 の新マイグレーションが追加されると、ロールバック時に version 20 の `down()` 関数が呼ばれる。`rollbackMigrations()` は `down()` が未定義の場合にエラーを投げる（`db-migrations.ts` L1105-1109）ため、`down()` 関数を省略するとこのテストが失敗する。

Issue 本文のテスト戦略セクションでは CURRENT_SCHEMA_VERSION 期待値更新の3箇所を言及しているが、`down()` 関数を定義する必要性については明示されていない。

**証拠**:

```typescript
// db-migrations.ts L1104-1109
if (!migration.down) {
  throw new Error(
    `Cannot rollback migration ${migration.version} (${migration.name}): ` +
    `no down() function defined`
  );
}
```

```typescript
// db-migrations.test.ts L428-438
it('should rollback Migration #17 and remove schedule tables', () => {
  runMigrations(db);
  expect(getCurrentVersion(db)).toBe(19); // -> 20 に更新必要
  rollbackMigrations(db, 16); // version 20の down() が必要
  expect(getCurrentVersion(db)).toBe(16);
```

**推奨対応**:

テスト戦略セクションに、version 20 のマイグレーションに `down()` 関数を定義する必要がある旨を追記する。既存パターン（version 18, 19）を踏襲し、以下のような実装とする:

```typescript
down: () => {
  console.log('No rollback for vibe_local_context_window column (SQLite limitation)');
}
```

---

### IR2-003: context-window の上限値バリデーションがない

**カテゴリ**: バリデーション
**場所**: PATCH API バリデーション、defense-in-depth バリデーション

**問題**:

Issue 本文では context-window の値として「null または 128以上の正の整数」としているが、上限値が定義されていない。`Number.MAX_SAFE_INTEGER`（9007199254740991）のような極端に大きな値が許容される。

- SQLite の INTEGER 型は最大 2^63-1 を格納可能で技術的には問題ないが、アプリケーション上は無意味
- CLI 引数として非常に長い数値文字列が渡される可能性
- Ollama モデルの物理メモリに依存するため、実用的な上限設定が妥当

**推奨対応**:

バリデーション条件を「128 以上かつ上限値以下の正の整数」に拡張する。上限値として `2097152`（2M tokens）程度の定数を定義し、API バリデーションと defense-in-depth の両方で使用する。定数は `src/lib/cli-tools/types.ts` など共通の場所に定義して DRY 原則を維持する。

テストケースにも上限超過のケース（例: `2097153` が拒否されること）を追加する。

---

## Nice to Have（あれば良い）

### IR2-004: models.ts の具体的な型定義

**カテゴリ**: 型定義
**場所**: `src/types/models.ts` Worktree interface

Issue 本文の変更対象に models.ts が含まれているが、追加するフィールドの TypeScript 型定義が明示されていない。既存の `vibeLocalModel?: string | null`（L81）と同様に `vibeLocalContextWindow?: number | null` とすべきである。

### IR2-005: 既存コンポーネントテストの props factory 更新

**カテゴリ**: テスト
**場所**: `tests/unit/components/worktree/AgentSettingsPane.test.tsx`, `tests/unit/components/worktree/NotesAndLogsPane.test.tsx`

AgentSettingsPane と NotesAndLogsPane の props に新しいフィールド（`vibeLocalContextWindow`, `onVibeLocalContextWindowChange`）が追加される場合、既存テストの props factory も更新が必要。TypeScript strict mode により未提供 props はコンパイルエラーとなるため見落とすリスクは低いが、テスト戦略セクションに記載があるとよい。

### IR2-006: PATCH APIレスポンスの自動伝播

**カテゴリ**: API
**場所**: `src/app/api/worktrees/[id]/route.ts` L254-266

PATCH ハンドラのレスポンスは `...updatedWorktree` でスプレッドされるため、`getWorktreeById()` のマッピング修正で自動的に新フィールドが含まれる。この動作は意図通りであり、追加の修正は不要。

---

## 新たに特定された影響範囲

### 追加検討が必要なファイル

| ファイル | 影響内容 | 重要度 |
|---------|---------|--------|
| `src/lib/schedule-manager.ts` | SELECT文への `vibe_local_context_window` 追加、options構築の拡張（設計判断次第） | 中 |
| `src/lib/claude-executor.ts` | `ExecuteCommandOptions` に `contextWindow` 追加、`buildCliArgs` の拡張（設計判断次第） | 中 |

### 影響なし確認済みファイル

| ファイル | 確認結果 |
|---------|---------|
| `src/lib/session-cleanup.ts` | セッション起動パラメータに関与せず影響なし |
| `src/lib/auto-yes-manager.ts` | セッション起動パラメータに関与せず影響なし |
| `src/app/api/worktrees/route.ts` | GET一覧は getWorktrees() 経由で自動伝播 |
| Claude/Codex/Gemini CLITool | vibeLocalContextWindow を読み取らないため影響なし |
| 既存インテグレーションテスト | optional フィールドのため破壊なし |

---

## 参照ファイル

### コード（影響分析対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/db.ts`: getWorktrees() L194-264, getWorktreeById() L303-364, updateVibeLocalModel() L1004-1016
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/types/models.ts`: Worktree interface L35-84
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/db-migrations.ts`: CURRENT_SCHEMA_VERSION L14, migrations[] L37-949
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/cli-tools/vibe-local.ts`: startSession() L61-111
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/app/api/worktrees/[id]/route.ts`: PATCH L129-274
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/components/worktree/AgentSettingsPane.tsx`: L1-269
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/components/worktree/NotesAndLogsPane.tsx`: L1-125
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/components/worktree/WorktreeDetailRefactored.tsx`: vibeLocalModel state L966, API sync L1016-1018
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/schedule-manager.ts`: executeSchedule() L310-349
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/claude-executor.ts`: ExecuteCommandOptions L40-43, buildCliArgs L94-109

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/tests/unit/lib/db-migrations.test.ts`: L36-37, L427-438
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/tests/unit/components/worktree/AgentSettingsPane.test.tsx`: L21
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/tests/unit/components/worktree/NotesAndLogsPane.test.tsx`: L36

### i18n
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/locales/en/schedule.json`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/locales/ja/schedule.json`
