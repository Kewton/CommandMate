# Issue #374 影響範囲レビューレポート

**レビュー日**: 2026-02-28
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 4 |

**総合評価**: Issue #374 の影響範囲は、Issue #368 の `vibeLocalModel` 実装パターンを忠実に踏襲するものであり、限定的かつ予測可能である。変更対象リストの漏れ（2ファイル）と、DB の SELECT 文修正箇所の明示が主な改善点。

---

## 影響範囲マップ

### High Impact（必ず修正が必要）

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/db.ts` | `getWorktrees()` と `getWorktreeById()` の SELECT 文・型キャスト・マッピング（計6箇所の同期修正） |
| `src/lib/db-migrations.ts` | `CURRENT_SCHEMA_VERSION` を 20 に更新、version 20 マイグレーション追加 |
| `src/types/models.ts` | `Worktree` interface に `vibeLocalContextWindow` フィールド追加（型定義の起点） |
| `src/lib/cli-tools/vibe-local.ts` | `startSession()` のコマンド構築ロジック（セキュリティ上重要） |

### Medium Impact（修正が必要）

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/route.ts` | PATCH ハンドラへのバリデーション追加 |
| `src/components/worktree/AgentSettingsPane.tsx` | コンテキストウィンドウ入力 UI 追加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | state 管理・props 伝播の追加（**Issue 本文に記載漏れ**） |
| `src/components/worktree/NotesAndLogsPane.tsx` | props 受け渡しの追加（**Issue 本文に記載漏れ**） |
| `locales/ja/schedule.json`, `locales/en/schedule.json` | i18n キー追加 |
| `tests/unit/lib/db-migrations.test.ts` | `CURRENT_SCHEMA_VERSION` 期待値更新 |

### Low Impact（影響なし確認済み）

| ファイル | 確認結果 |
|---------|---------|
| `src/lib/session-cleanup.ts` | CLI_TOOL_IDS イテレートのみ、セッション起動パラメータとは無関係 |
| `src/lib/auto-yes-manager.ts` | セッション起動パラメータとは無関係 |
| `src/lib/schedule-manager.ts` | vibe-local 固有パラメータを使用しない |
| Claude/Codex/Gemini CLITool 実装 | vibe_local_context_window カラムを読み取らない |
| `tests/integration/api-worktrees-cli-tool.test.ts` | optional フィールドのため既存テスト破壊なし |
| `tests/integration/api-worktrees.test.ts` | optional フィールドのため既存テスト破壊なし |

---

## Must Fix（必須対応）

### IR-001: getWorktrees() / getWorktreeById() の SELECT 文に新カラムの追加が必要

**カテゴリ**: DBスキーマ変更の影響
**影響ファイル**: `src/lib/db.ts`

**問題**:
`src/lib/db.ts` の `getWorktrees()`（L194-264）と `getWorktreeById()`（L303-364）では、SELECT 文でカラムを明示的に列挙している。新カラム `vibe_local_context_window` を追加する場合、以下の 6 箇所を同期修正する必要がある。

1. `getWorktrees()` の SELECT 文（L199）
2. `getWorktrees()` の行結果の型キャスト（L215-234）
3. `getWorktrees()` の返却オブジェクトマッピング（L240-264）
4. `getWorktreeById()` の SELECT 文（L312）
5. `getWorktreeById()` の行結果の型キャスト（L319-338）
6. `getWorktreeById()` の返却オブジェクトマッピング（L344-363）

**証拠**:
既存の `vibe_local_model` の実装パターン:
```typescript
// SELECT文 (L199)
w.selected_agents, w.vibe_local_model,

// 型キャスト (L232)
vibe_local_model: string | null;

// マッピング (L262)
vibeLocalModel: row.vibe_local_model ?? null,
```

**推奨対応**:
Issue 本文の「変更対象」セクションで、`db.ts` 内の修正箇所として `getWorktrees()` および `getWorktreeById()` の SELECT 文・型キャスト・マッピング処理の 3 点 x 2 関数 = 6 箇所を明示的に記載する。

---

## Should Fix（推奨対応）

### IR-002: WorktreeDetailRefactored.tsx と NotesAndLogsPane.tsx の props 伝播修正

**カテゴリ**: 型定義の伝播
**影響ファイル**: `src/components/worktree/WorktreeDetailRefactored.tsx`, `src/components/worktree/NotesAndLogsPane.tsx`

**問題**:
Issue 本文の「変更対象（想定）」セクションには `AgentSettingsPane.tsx` のみ UI コンポーネントとして記載されているが、実際には props を伝播させるために以下の修正が必要:

- `WorktreeDetailRefactored.tsx`: `useState`, `useCallback` の追加（API レスポンスからの値取得、state 管理）
- `NotesAndLogsPane.tsx`: props 定義と `AgentSettingsPane` への伝播

**証拠**:
`vibeLocalModel` の既存実装パターン（`WorktreeDetailRefactored.tsx` L966, L1016-1019, L1103-1105, L1946-1947）と `NotesAndLogsPane.tsx`（L43-45, L73-74, L115-116）を参照。同一のパターンで `vibeLocalContextWindow` の state/callback/props 伝播が必要。

**推奨対応**:
「変更対象（想定）」に `src/components/worktree/WorktreeDetailRefactored.tsx` と `src/components/worktree/NotesAndLogsPane.tsx` を追加する。

---

### IR-003: vibe-local.ts の startSession() でのコマンドインジェクション防御

**カテゴリ**: 既存機能への影響
**影響ファイル**: `src/lib/cli-tools/vibe-local.ts`

**問題**:
現在の `vibe-local.ts`（L88-94）では文字列テンプレートでコマンドを構築し、`tmux sendKeys` に渡している。`context-window` パラメータは数値であるため、`OLLAMA_MODEL_PATTERN` とは異なるバリデーションが必要。

**証拠**:
```typescript
// 現在のコマンド構築パターン (L93)
vibeLocalCommand = `vibe-local -y -m ${wt.vibeLocalModel}`;
// 追加予定
vibeLocalCommand += ` --context-window ${wt.vibeLocalContextWindow}`;
```

**推奨対応**:
Issue 本文のセクション 4 に、`startSession()` 内での defense-in-depth バリデーションの具体例を追記する:
```typescript
if (typeof wt.vibeLocalContextWindow === 'number'
    && Number.isInteger(wt.vibeLocalContextWindow)
    && wt.vibeLocalContextWindow >= 128) {
  vibeLocalCommand += ` --context-window ${wt.vibeLocalContextWindow}`;
}
```

---

### IR-004: CURRENT_SCHEMA_VERSION 更新に伴う既存テスト修正

**カテゴリ**: テスト範囲
**影響ファイル**: `tests/unit/lib/db-migrations.test.ts`, `src/lib/db-migrations.ts`

**問題**:
`CURRENT_SCHEMA_VERSION` を 19 から 20 に更新すると、以下の既存テストが失敗する:

- L37: `expect(CURRENT_SCHEMA_VERSION).toBe(19)` -- 20 に更新が必要
- L430: `expect(getCurrentVersion(db)).toBe(19)` -- 20 に更新が必要

**推奨対応**:
既存テストの期待値を 20 に更新する。新マイグレーションのテストケースも追加する（カラム存在確認、NULL デフォルト値確認）。

---

### IR-005: i18n キーの具体的テキスト値が未記載

**カテゴリ**: i18n / ドキュメント更新
**影響ファイル**: `locales/ja/schedule.json`, `locales/en/schedule.json`

**問題**:
Issue 本文では i18n キーの追加先と名前は記載されているが、具体的な翻訳テキストが明記されていない。

**推奨対応**:
以下のテキスト値を Issue に追記:
- `vibeLocalContextWindow`: EN: "Context Window" / JA: "コンテキストウィンドウ"
- `vibeLocalContextWindowDefault`: EN: "Default (auto)" / JA: "デフォルト（自動）"

---

### IR-008: upsertWorktree() の修正不要であることの確認

**カテゴリ**: テスト範囲
**影響ファイル**: `src/lib/db.ts` (upsertWorktree)

**問題**:
`upsertWorktree()` は worktree のメタデータ登録用であり、`vibe_local_model` も含んでいない（個別の `updateVibeLocalModel()` で管理）。同様に `vibe_local_context_window` も個別の `updateVibeLocalContextWindow()` で管理するため、`upsertWorktree()` の修正は不要。

**推奨対応**:
この設計判断を実装時のコードコメントに残す。既存パターンの踏襲であることを確認済み。

---

### IR-009: 変更対象リストの更新

**カテゴリ**: 変更対象の漏れ

**推奨される完全な変更対象リスト**:
```
- src/lib/db-migrations.ts          (version 20 マイグレーション追加)
- src/lib/db.ts                     (updateVibeLocalContextWindow 関数追加、getWorktrees/getWorktreeById 修正)
- src/types/models.ts               (Worktree interface フィールド追加)
- src/app/api/worktrees/[id]/route.ts (PATCH バリデーション追加)
- src/lib/cli-tools/vibe-local.ts   (startSession コマンド構築修正)
- src/components/worktree/AgentSettingsPane.tsx       (UI 入力欄追加)
- src/components/worktree/WorktreeDetailRefactored.tsx (state/callback/props 追加) *** 追加 ***
- src/components/worktree/NotesAndLogsPane.tsx         (props 伝播追加)    *** 追加 ***
- locales/ja/schedule.json          (i18n キー追加)
- locales/en/schedule.json          (i18n キー追加)
- tests/unit/lib/db-migrations.test.ts (バージョン期待値更新)   *** 追加 ***
- CLAUDE.md                         (モジュール説明更新)
```

---

## Nice to Have（あれば良い）

### IR-006: 他 CLI ツールへの影響なし確認

Claude/Codex/Gemini の `startSession()` メソッドは `vibe_local_context_window` カラムを参照しないことを確認済み。`session-cleanup.ts` と `auto-yes-manager.ts` もセッション起動パラメータとは無関係であり、影響はない。

受け入れ基準に「他ツールへの影響がないこと」を明示的に追加すると、テスト時の確認漏れを防げる。

### IR-007: API 後方互換性の確認

PATCH API への新フィールド追加は `'vibeLocalContextWindow' in body` パターンにより後方互換性を維持する。GET レスポンスへの新フィールド追加も、クライアントは未知のフィールドを無視するため影響なし。

### IR-010: CLAUDE.md のモジュール説明更新

`vibe-local.ts`、`AgentSettingsPane.tsx`、`Worktree` interface の CLAUDE.md 記載をそれぞれ更新する必要がある。Issue 本文で変更対象に含まれており対応済み。

---

## 参照ファイル

### コード（影響あり）

| ファイル | 関連性 |
|---------|--------|
| `src/lib/db.ts` | SELECT 文・型キャスト・マッピング修正（2関数 x 3箇所 = 6箇所） |
| `src/lib/db-migrations.ts` | version 20 マイグレーション追加、CURRENT_SCHEMA_VERSION 更新 |
| `src/types/models.ts` | Worktree interface フィールド追加（型の起点） |
| `src/lib/cli-tools/vibe-local.ts` | startSession() のコマンド構築修正 |
| `src/app/api/worktrees/[id]/route.ts` | PATCH ハンドラのバリデーション追加 |
| `src/components/worktree/AgentSettingsPane.tsx` | コンテキストウィンドウ UI 追加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | state/callback/props 追加 |
| `src/components/worktree/NotesAndLogsPane.tsx` | props 伝播追加 |

### コード（影響なし確認済み）

| ファイル | 確認結果 |
|---------|---------|
| `src/lib/session-cleanup.ts` | セッション起動パラメータ不使用 |
| `src/lib/auto-yes-manager.ts` | セッション起動パラメータ不使用 |
| `src/lib/schedule-manager.ts` | vibe-local 固有パラメータ不使用 |
| `src/lib/cli-tools/base.ts` | 基底クラス、拡張不要 |
| `src/lib/cli-tools/codex.ts` | vibe-local 固有フィールド不使用 |
| `src/app/api/worktrees/route.ts` | スプレッド構文のため自動伝播 |

### テスト

| ファイル | 影響 |
|---------|------|
| `tests/unit/lib/db-migrations.test.ts` | CURRENT_SCHEMA_VERSION 期待値更新が必要 |
| `tests/integration/api-worktrees-cli-tool.test.ts` | 既存テスト破壊なし |
| `tests/integration/api-worktrees.test.ts` | 既存テスト破壊なし |

### i18n

| ファイル | 影響 |
|---------|------|
| `locales/ja/schedule.json` | 2キー追加 |
| `locales/en/schedule.json` | 2キー追加 |
