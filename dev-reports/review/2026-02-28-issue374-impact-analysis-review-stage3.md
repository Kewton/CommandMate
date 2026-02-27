# Architecture Review Report: Issue #374 Impact Analysis (Stage 3)

| 項目 | 内容 |
|------|------|
| Issue | #374 - Vibe Local コンテキストウィンドウサイズ設定 |
| レビュー種別 | Stage 3: 影響範囲分析レビュー |
| 設計方針書 | `dev-reports/design/issue-374-vibe-local-context-window-design-policy.md` |
| レビュー日 | 2026-02-28 |
| ステータス | **conditional_pass** |
| スコア | **4/5** |

---

## 1. Executive Summary

Issue #374 は Vibe Local CLI ツールに `--context-window` パラメータを追加する機能であり、既存の `vibeLocalModel` 実装パターン（DB カラム追加 -> API -> UI -> CLI 実行）を踏襲する設計である。

影響範囲分析の結果、直接変更対象の11ファイルは明確に特定されており、変更パターンも既存実装と一貫している。間接的に影響を受けるファイルについても、破壊的変更は発生しない。

主要な指摘事項は、`schedule-manager.ts` の直接SQLクエリおよび `claude-executor.ts` の `buildCliArgs()` 関数への将来的影響が設計方針書で十分に明示されていない点である。スコープ外と判断した根拠と将来的修正箇所を明記することで、後続の開発者が迷わないようにすべきである。

---

## 2. 影響範囲分析

### 2.1 直接変更ファイル

| カテゴリ | ファイル | 変更内容 | リスク |
|---------|---------|---------|-------|
| DB マイグレーション | `src/lib/db-migrations.ts` | version 20 追加 (ALTER TABLE ADD COLUMN) | Low |
| DB 操作 | `src/lib/db.ts` | updateVibeLocalContextWindow() 追加、SELECT文x2修正、型キャストx2修正、マッピングx2修正 | Low |
| 型定義 | `src/types/models.ts` | Worktree interface に `vibeLocalContextWindow?: number \| null` 追加 | Low |
| 定数/バリデーション | `src/lib/cli-tools/types.ts` | MIN/MAX定数、isValidVibeLocalContextWindow() 追加 | Low |
| API | `src/app/api/worktrees/[id]/route.ts` | PATCH ハンドラにバリデーション・DB更新ロジック追加 | Low |
| CLI 実行 | `src/lib/cli-tools/vibe-local.ts` | startSession() に --context-window オプション構築追加 | Medium |
| UI コンポーネント | `src/components/worktree/AgentSettingsPane.tsx` | number input UI追加、PATCH API呼び出し | Low |
| UI コンポーネント | `src/components/worktree/NotesAndLogsPane.tsx` | props伝播追加 (vibeLocalContextWindow, onVibeLocalContextWindowChange) | Low |
| UI コンポーネント | `src/components/worktree/WorktreeDetailRefactored.tsx` | useState/useCallback追加、MobileContentProps更新、props伝播 | Low |
| i18n | `locales/ja/schedule.json` | vibeLocalContextWindow, vibeLocalContextWindowDefault キー追加 | Low |
| i18n | `locales/en/schedule.json` | vibeLocalContextWindow, vibeLocalContextWindowDefault キー追加 | Low |

### 2.2 間接影響ファイル（変更不要だが影響確認が必要）

| カテゴリ | ファイル | 影響内容 | 変更要否 |
|---------|---------|---------|---------|
| スケジュール実行 | `src/lib/schedule-manager.ts` L320 | 直接SQLクエリ `SELECT path, vibe_local_model FROM worktrees` -- 新カラムは参照不要（スコープ外） | **不要** |
| スケジュール実行 | `src/lib/claude-executor.ts` L94-109 | `buildCliArgs()` vibe-localケース -- --context-window引数は -p モードでは不要（スコープ外） | **不要** |
| スケジュール実行 | `src/lib/claude-executor.ts` L40-43 | `ExecuteCommandOptions` interface -- contextWindowフィールドは不要（スコープ外） | **不要** |
| API レスポンス | `src/app/api/worktrees/[id]/route.ts` GET | getWorktreeById() 経由で自動的にvibeLocalContextWindowがレスポンスに含まれる | **不要** |
| API リスト | `/api/worktrees` ルート | getWorktrees() 経由で自動的にレスポンスに含まれる | **不要** |
| ドキュメント | `CLAUDE.md` | モジュール説明テーブルの更新 | **要** |

### 2.3 テスト影響

| テストファイル | 影響内容 | 変更要否 |
|--------------|---------|---------|
| `tests/unit/lib/db-migrations.test.ts` L37 | `CURRENT_SCHEMA_VERSION` 期待値 19 -> 20 | **要** |
| `tests/unit/lib/db-migrations.test.ts` L430 | rollbackMigrations テスト内 getCurrentVersion 期待値 19 -> 20 | **要** |
| `tests/unit/lib/db-migrations.test.ts` L443 | rollbackMigrations テスト内 getCurrentVersion 期待値 19 -> 20 | **要** |
| `tests/unit/components/worktree/AgentSettingsPane.test.tsx` | defaultProps に vibeLocalContextWindow, onVibeLocalContextWindowChange 追加 | **要** |
| `tests/unit/components/worktree/NotesAndLogsPane.test.tsx` | defaultProps に vibeLocalContextWindow, onVibeLocalContextWindowChange 追加 | **要** |
| `tests/unit/lib/claude-executor.test.ts` | buildCliArgs() テスト -- 変更なし（スコープ外） | **不要** |
| (新規) isValidVibeLocalContextWindow テスト | 正常値/異常値/型ガード境界テスト | **新規作成** |
| (新規) API PATCH バリデーションテスト | vibeLocalContextWindow の各パターン | **新規作成** |

---

## 3. DB スキーマ変更の影響

### マイグレーション互換性

```sql
-- version 20: add-vibe-local-context-window-column
ALTER TABLE worktrees ADD COLUMN vibe_local_context_window INTEGER DEFAULT NULL;
```

| 観点 | 評価 |
|------|------|
| 前方互換性 | 問題なし。NULL デフォルトのため既存行は影響なし |
| 後方互換性 | 問題なし。down() は console.log のみ（SQLite DROP COLUMN 制限） |
| SELECT 文との整合性 | getWorktrees() と getWorktreeById() の両方に追加が必要（計6箇所） |
| upsertWorktree() | 変更不要（個別 update 関数パターン踏襲） |
| schedule-manager.ts | 直接SQLクエリ（L320）は vibe_local_model のみ参照。新カラムは不要 |

### 重要: schedule-manager.ts の直接SQLクエリ

`schedule-manager.ts` L320 には以下のような直接SQLクエリがある:

```typescript
const worktree = db.prepare('SELECT path, vibe_local_model FROM worktrees WHERE id = ?')
  .get(state.worktreeId) as { path: string; vibe_local_model: string | null } | undefined;
```

このクエリは `getWorktreeById()` を使用せず、必要なカラムのみを直接SELECTしている。Issue #374 ではスケジュール実行がスコープ外のため、このクエリへの `vibe_local_context_window` カラム追加は不要である。ただし、将来的にスケジュール実行で `--context-window` をサポートする場合は:

1. このSELECTに `vibe_local_context_window` を追加
2. `buildCliArgs()` に contextWindow パラメータを追加
3. `ExecuteCommandOptions` に `contextWindow?: number` を追加

が必要になる。

---

## 4. 型定義変更の影響（TypeScript strict mode）

| 変更 | 影響 |
|------|------|
| `Worktree.vibeLocalContextWindow?: number \| null` | optional 型。既存コードで参照されていないため、型エラーなし |
| `AgentSettingsPaneProps` への props 追加 | 全呼び出し箇所で props 追加が必要（コンパイルエラーで検出可能） |
| `NotesAndLogsPaneProps` への props 追加 | 全呼び出し箇所で props 追加が必要（コンパイルエラーで検出可能） |
| `MobileContentProps` への props 追加 | WorktreeDetailRefactored.tsx 内部 interface。同ファイル内で完結 |
| `isValidVibeLocalContextWindow(value: unknown): value is number` | 新規追加。既存型への影響なし |

TypeScript strict mode で全てのprops追加漏れはコンパイル時に検出されるため、型定義変更のリスクは低い。

---

## 5. API 変更の影響（破壊的変更チェック）

| 観点 | 評価 |
|------|------|
| PATCH リクエスト | `'vibeLocalContextWindow' in body` パターンにより、フィールド未送信時は既存動作に影響なし。**非破壊的** |
| GET レスポンス | `getWorktreeById()` 経由で自動的に新フィールドがレスポンスに追加される。**追加のみ（非破壊的）** |
| リスト GET レスポンス | `getWorktrees()` 経由で自動的に追加。**追加のみ（非破壊的）** |
| エラーレスポンス | 新しい 400 エラーケース追加（不正な vibeLocalContextWindow）。既存の正常リクエストには影響なし |

結論: **破壊的変更なし**。全て後方互換。

---

## 6. UI 変更の影響

### レイアウト・レスポンシブ対応

| 画面 | 変更内容 | 影響 |
|------|---------|------|
| デスクトップ AgentSettingsPane | Ollama モデルセレクター下に number input 追加 | スクロール可能エリア内。レイアウト崩れリスクなし |
| モバイル AgentSettingsPane | 同上 | 同上 |
| デスクトップ NotesAndLogsPane | props 伝播のみ。UIは変更なし | 影響なし |
| モバイル NotesAndLogsPane | props 伝播のみ。UIは変更なし | 影響なし |

### Props 伝播チェーン

```
WorktreeDetailRefactored (state管理)
  |-- MobileContent (MobileContentProps)
  |     `-- NotesAndLogsPane (props伝播)
  |           `-- AgentSettingsPane (UI入力)
  `-- Desktop layout
        `-- NotesAndLogsPane (props伝播)
              `-- AgentSettingsPane (UI入力)
```

NotesAndLogsPane の呼び出し箇所は2箇所（モバイル L900, デスクトップ L1941）。両方に props 追加が必要であり、設計方針書 [C2-009] で明示されている。

---

## 7. i18n 変更の影響

| ロケール | ファイル | 追加キー | 状態 |
|---------|---------|---------|------|
| en | `locales/en/schedule.json` | vibeLocalContextWindow, vibeLocalContextWindowDefault | 設計方針書に記載済み |
| ja | `locales/ja/schedule.json` | vibeLocalContextWindow, vibeLocalContextWindowDefault | 設計方針書に記載済み |

ロケールディレクトリは en と ja の2つのみ。更新漏れリスクは低い。[C2-004] の日本語訳の意図的な表現差異（「デフォルト（自動）」 vs 「デフォルト」）は設計方針書で合理的に説明されている。

---

## 8. CLAUDE.md ドキュメント更新

設計方針書ではCLAUDE.mdの「モジュール説明更新」が記載されているが、具体的な更新内容が不明確。以下のモジュール説明行の更新が必要:

| モジュール | 現在の記載 | 追記内容 |
|-----------|----------|---------|
| `src/lib/cli-tools/types.ts` | CLI_TOOL_IDS, CLIToolType, CLI_TOOL_DISPLAY_NAMES, ... | VIBE_LOCAL_CONTEXT_WINDOW_MIN/MAX, isValidVibeLocalContextWindow() 追加 |
| `src/lib/cli-tools/vibe-local.ts` | VibeLocalTool, BaseCLITool継承, tmuxセッション管理 | --context-window サポート追加 |
| `src/components/worktree/AgentSettingsPane.tsx` | checkbox UI で2ツールまで選択, ... | コンテキストウィンドウ入力UI追加 |

---

## 9. スケジュール実行への影響の明確化

### 現状の実装

`schedule-manager.ts` はスケジュール実行時に以下のフローで vibe-local を呼び出す:

1. `schedule-manager.ts` L320: 直接SQL で `path` と `vibe_local_model` を取得
2. `schedule-manager.ts` L328-331: `ExecuteCommandOptions` を構築（model のみ）
3. `claude-executor.ts` `buildCliArgs()`: vibe-local ケースで `-p`, `-y`, `--model` を構築
4. `claude-executor.ts` `executeClaudeCommand()`: `execFile` でプロセス実行

### Issue #374 での影響

- **影響なし**。スケジュール実行は `-p` モード（非対話モード）であり、`--context-window` は対話モード（tmux セッション）のみが対象。
- `schedule-manager.ts` の直接SQLクエリは変更不要。
- `buildCliArgs()` は変更不要。

### 将来的な拡張時の修正箇所

vibe-local の `-p` モードで `--context-window` をサポートする場合:

1. `src/lib/claude-executor.ts`:
   - `ExecuteCommandOptions` に `contextWindow?: number` 追加
   - `buildCliArgs()` vibe-local ケースに `--context-window` 引数追加
2. `src/lib/schedule-manager.ts` L320:
   - SQL に `vibe_local_context_window` カラム追加
   - options 構築に contextWindow 追加

---

## 10. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 実装漏れ | getWorktrees() のSELECT/マッピング修正漏れ | Medium | Low | P2 |
| 実装漏れ | NotesAndLogsPane の2箇所のprops追加漏れ | Low | Low | P3 |
| テスト不足 | isValidVibeLocalContextWindow() のテスト未作成 | Medium | Medium | P2 |
| 将来負債 | schedule-manager.ts のcontextWindow未対応 | Low | Low | P3 |
| 型安全性 | TypeScript strict mode でprops漏れはコンパイル時検出 | N/A | N/A | N/A |

---

## 11. 指摘事項サマリー

### Must Fix (1件)

| ID | タイトル | 対策 |
|----|---------|------|
| I3-001 | schedule-manager.ts の直接SQLクエリへの影響が未分析 | 設計方針書にスコープ外の具体的根拠と将来修正箇所を明記 |

### Should Fix (4件)

| ID | タイトル | 対策 |
|----|---------|------|
| I3-002 | db-migrations.test.ts の実際の行番号確認 | 行番号の正確性確認済み。it文タイトル変更不要の明記 |
| I3-003 | claude-executor.ts buildCliArgs() への将来的影響の明示 | セクション9に将来修正箇所を付記 |
| I3-004 | isValidVibeLocalContextWindow() テストファイル配置の明記 | セクション8にテストファイル名を追記 |
| I3-005 | WorktreeDetailRefactored.tsx MobileContentProps への影響詳細 | セクション10の変更内容を詳細化 |

### Nice to Have (3件)

| ID | タイトル | 対策 |
|----|---------|------|
| I3-006 | CLAUDE.md の更新対象モジュールの具体的列挙 | 更新対象の3モジュールを明示 |
| I3-007 | getWorktrees() 修正漏れ防止チェック | 実装チェックリストに明示 |
| I3-008 | i18nキーのネームスペース配置確認 | 対応不要（既存パターンと一致） |

---

## 12. 結論

設計方針書の影響範囲は概ね適切に分析されており、`vibeLocalModel` の既存パターンを踏襲することで変更の予測可能性が高い。TypeScript strict mode による型チェックにより、props 追加漏れはコンパイル時に検出可能である。

主要な改善ポイントは、スケジュール実行関連ファイル（`schedule-manager.ts`, `claude-executor.ts`）への将来的影響を設計方針書に明記することで、後続の Issue でのスコープ拡張時に迷いなく対応できるようにすることである。

**判定: conditional_pass (4/5)**

---

*Generated by architecture-review-agent for Issue #374 Stage 3*
*Review date: 2026-02-28*
