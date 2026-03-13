# Issue #166 仮説検証レポート

## 検証日時
- 2026-03-14

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | スラッシュコマンドの読込はClaude Code用（`.claude/commands/*.md`）のみ | Partially Confirmed | `.claude/commands/`と`.claude/skills/`の両方を読み込む（Issue #343で追加済み） |
| 2 | Codexは異なるディレクトリ・形式でカスタムコマンドを管理 | Confirmed | `~/.codex/prompts/`と`.codex/skills/`は既存コードに未実装 |
| 3 | `filterCommandsByCliTool()`でCLIツール別フィルタリング機構が存在する | Confirmed | `src/lib/command-merger.ts`に実装済み |
| 4 | cliToolsが未定義のコマンドはClaude専用として扱われる | Confirmed | `filterCommandsByCliTool()`のデフォルト動作 |

## 詳細検証

### 仮説 1: スラッシュコマンドの読込はClaude Code用のみ

**Issue内の記述**: 「スラッシュコマンドの読込は現在Claude Code用（`.claude/commands/*.md`）のみ対応している」

**検証手順**:
1. `src/lib/slash-commands.ts` を確認
2. `loadSlashCommands()`: `.claude/commands/*.md` を読み込む (Line 200-233)
3. `loadSkills()`: `.claude/skills/{name}/SKILL.md` を読み込む (Line 256-291、Issue #343で追加済み)

**判定**: Partially Confirmed

**根拠**: `.claude/commands/`に加えて`.claude/skills/`の読み込みもIssue #343で追加済み。Issue本文ではこの点が言及されていない。

**Issueへの影響**: Issue本文の「現在Claude Code用（`.claude/commands/*.md`）のみ」という記述は一部不正確。`.claude/skills/`も読み込まれることを補足すべき。

---

### 仮説 2: Codexは異なるディレクトリで管理

**Issue内の記述**: 「Codexは異なるディレクトリ・形式でカスタムコマンドを管理する」

**検証手順**:
1. `src/lib/slash-commands.ts`に`~/.codex/prompts/`の読み込みコードなし
2. `src/lib/slash-commands.ts`に`.codex/skills/`の読み込みコードなし

**判定**: Confirmed（これが今回の実装対象）

---

### 仮説 3: CLIツール別フィルタリング機構

**Issue内の記述**: Codexタブ選択時にコマンドを候補に表示（暗黙の前提）

**検証手順**:
1. `src/lib/command-merger.ts` の `filterCommandsByCliTool()` を確認 (Line 184-201)
2. `SlashCommand.cliTools?: CLIToolType[]` フィールドの確認

**判定**: Confirmed

**根拠**: `filterCommandsByCliTool(cliToolId)`が実装済みで、`cliTools`未定義はClaude専用扱い。Codex用コマンドには`cliTools: ['codex']`を設定する必要がある。

---

### 仮説 4: cliToolsが未定義のコマンドはClaude専用

**判定**: Confirmed

**根拠**: `command-merger.ts:191-193` - `if (!cmd.cliTools) return cliToolId === 'claude';`

---

## Stage 1レビューへの申し送り事項

- Issue本文の「`.claude/commands/*.md`のみ対応」という記述はIssue #343で`.claude/skills/`も追加済みのため、背景の説明が不正確。修正を推奨。
- Codex Custom Prompts（`~/.codex/prompts/`）は**非推奨**（deprecated）との記載があり、実装優先度・対応方針の明確化が必要。
- `.codex/skills/`（リポジトリローカル）の読み込みは`basePath`パラメータを使った既存アーキテクチャに自然に統合できる。
- グローバル（`~/.codex/`）のコマンドをどのスコープで読み込むか（MCBD共通 or worktree別）の設計方針が未定義。
