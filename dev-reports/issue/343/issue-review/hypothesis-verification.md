# Issue #343 仮説検証レポート

## 検証日時
- 2026-02-22

## 概要

Issue #343 は「スラッシュコマンドセレクターで `.claude/skills` も表示する」という機能追加Issueです。
仮説・原因分析ではなく「現状の仕組み」に関する事実の主張が含まれるため、それらを検証します。

## 検証結果サマリー

| # | 主張 | 判定 | 根拠 |
|---|------|------|------|
| 1 | `src/lib/slash-commands.ts` は `.claude/commands/*.md` のみを読み込む | Confirmed | `loadSlashCommands()` 関数が `getCommandsDir()` → `.claude/commands` のみを参照 |
| 2 | `src/app/api/worktrees/[id]/slash-commands/route.ts` が worktree パスの `.claude/commands/` からコマンドを取得 | Confirmed | `getSlashCommandGroups(worktree.path)` を呼び出し、パス配下の `.claude/commands/` を読む |
| 3 | `src/lib/command-merger.ts` が Standard + MCBD + Worktree コマンドをマージ | Partially Confirmed | Standard + Worktree のマージのみ実装。MCBD は `/api/slash-commands` 別ルートで処理 |
| 4 | `src/hooks/useSlashCommands.ts` が API からコマンドを取得し UI に表示 | Confirmed | `fetchCommands()` で worktreeId 有無に応じてエンドポイントを切り替えてAPIから取得 |
| 5 | `src/components/worktree/SlashCommandSelector.tsx` がセレクター UI | Confirmed | ファイル存在確認済み |

## 詳細検証

### 主張 1: `slash-commands.ts` の読み込み対象

**Issue内の記述**: 「`src/lib/slash-commands.ts` - `.claude/commands/*.md` のみを読み込み」

**検証手順**:
1. `src/lib/slash-commands.ts` を確認
2. `getCommandsDir()` 関数: `path.join(root, '.claude', 'commands')` のみを返す
3. `loadSlashCommands()` 関数: `.md` ファイルのみを読み込む

**判定**: Confirmed

**根拠**: `src/lib/slash-commands.ts:29-33` - `getCommandsDir()` は `.claude/commands` ディレクトリのみを参照。skills ディレクトリへの言及なし。

---

### 主張 2: worktree APIルートの動作

**Issue内の記述**: 「`src/app/api/worktrees/[id]/slash-commands/route.ts` - worktree パスの `.claude/commands/` からコマンドを取得」

**検証手順**:
1. `src/app/api/worktrees/[id]/slash-commands/route.ts` を確認
2. `getSlashCommandGroups(worktree.path)` を呼び出し

**判定**: Confirmed

**根拠**: `route.ts:89` - `worktreeGroups = await getSlashCommandGroups(worktree.path)` で `loadSlashCommands(basePath)` が呼ばれ、`.claude/commands/` のみを読む

---

### 主張 3: command-merger.ts の役割説明

**Issue内の記述**: 「`src/lib/command-merger.ts` - Standard + MCBD + Worktree コマンドをマージ」

**検証手順**:
1. `src/lib/command-merger.ts` を確認
2. `mergeCommandGroups()` 関数の引数を確認

**判定**: Partially Confirmed

**根拠**:
- `mergeCommandGroups(standardGroups, worktreeGroups)` - 引数は Standard と Worktree の2つのみ
- MCBD コマンドは `/api/slash-commands` ルートで別途処理される
- Issue の記述は「MCBD + Worktree コマンドをマージ」の部分が誤り。実際は Standard + Worktree のみ

**Issue への影響**: 変更候補ファイルとして `command-merger.ts` が挙げられているが、説明文が不正確。ただし実装方針は正しいため、説明文の修正のみ必要。

---

### 追加確認事項

**確認した追加情報**:
1. `SlashCommandSource` 型は `'standard' | 'mcbd' | 'worktree'` - `'skill'` は未定義
2. `CATEGORY_ORDER` 配列に `'skill'` カテゴリは未定義
3. `SlashCommandCategory` 型に `'skill'` は未定義
4. `CATEGORY_LABELS` に `'skill'` のラベルは未定義

これらはすべて Issue の要件（「Skills カテゴリとして表示」）を実装するために必要な変更と一致している。

---

## Stage 1レビューへの申し送り事項

- Issue 内の `command-merger.ts` の説明「Standard + MCBD + Worktree コマンドをマージ」は不正確。実際は Standard + Worktree のみ。
- `SlashCommandSource` 型への `'skill'` 追加の必要性が未検討（Issue の変更候補ファイルに記載なし）
- `CATEGORY_ORDER` への `'skill'` 追加が必要だが、Issue の変更候補ファイルに `command-merger.ts` は「必要に応じて」の記述のみで詳細が不明確
- skills のソース管理（`source` フィールド）に関する記述が欠如している
