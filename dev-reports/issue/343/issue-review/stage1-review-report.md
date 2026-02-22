# Issue #343 Stage 1 レビューレポート

**レビュー日**: 2026-02-22
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 4 |

**総合評価**: needs_improvement

Issue の基本的な方向性と動機は妥当であり、現状分析もおおむね正確である。しかし、変更候補ファイルの網羅性に不足があり、型システムへの影響やエッジケースの考慮が欠けている。特に `SlashCommandSource` 型への追加漏れと `CATEGORY_ORDER` への追加方針の曖昧さは、実装フェーズで混乱を招く可能性がある。

---

## Must Fix（必須対応）

### F002: SlashCommandSource 型への 'skill' 追加が変更候補ファイルに欠如

**カテゴリ**: completeness
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - `src/types/slash-commands.ts`

**問題**:
現在 `SlashCommandSource` は `'standard' | 'mcbd' | 'worktree'` の3値のみ定義されている（`src/types/slash-commands.ts:30`）。Issue の変更候補では `SlashCommandCategory` に `'skill'` を追加し、`CATEGORY_LABELS` を更新すると記載されているが、`SlashCommandSource` への `'skill'` 追加が欠如している。

`source` フィールドは API レスポンスのソースカウント（`route.ts:102-107`）で使用されており、skills のカウントが正しく行われなくなる。

**証拠**:
```typescript
// src/types/slash-commands.ts:30
export type SlashCommandSource = 'standard' | 'mcbd' | 'worktree';
// 'skill' が未定義

// src/app/api/worktrees/[id]/slash-commands/route.ts:102-107
const filteredStandardCount = filteredGroups
  .flatMap(g => g.commands)
  .filter(cmd => cmd.source === 'standard').length;
const filteredWorktreeCount = filteredGroups
  .flatMap(g => g.commands)
  .filter(cmd => cmd.source === 'worktree').length;
// skill ソースのカウントが存在しない
```

**推奨対応**:
`src/types/slash-commands.ts` の変更内容に以下を追記する:
- `SlashCommandSource` に `'skill'` を追加
- API レスポンスの `sources` オブジェクトに `skill` カウントを追加するか、既存の `worktree` カウントに含めるかの方針を明確化

---

### F003: CATEGORY_ORDER への 'skill' 追加が変更候補に不明確

**カテゴリ**: completeness
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - `src/lib/command-merger.ts`

**問題**:
`command-merger.ts` の `CATEGORY_ORDER` 配列はカテゴリの表示順序を制御する唯一の情報源（single source of truth）である。`'skill'` カテゴリを追加する場合、この配列への追加が必須だが、Issue では `command-merger.ts` の変更内容が「skills マージロジック（必要に応じて）」と曖昧な記述にとどまっている。

`CATEGORY_ORDER` に追加しないと、`groupByCategory()` の残余カテゴリフォールバック（`command-merger.ts:74-83`）で処理されるため表示はされるが、表示位置が不定になる。

**証拠**:
```typescript
// src/lib/command-merger.ts:25-38
export const CATEGORY_ORDER: SlashCommandCategory[] = [
  'planning', 'development', 'review', 'documentation', 'workflow',
  'standard-session', 'standard-config', 'standard-monitor', 'standard-git', 'standard-util',
];
// 'skill' カテゴリが未定義

// src/lib/command-merger.ts:74-83 - フォールバック処理
for (const [category, categoryCommands] of groupMap) {
  if (!CATEGORY_ORDER.includes(category) && categoryCommands.length > 0) {
    groups.push({ category, label: CATEGORY_LABELS[category] || category, commands: categoryCommands });
  }
}
```

**推奨対応**:
`command-merger.ts` の変更内容を「CATEGORY_ORDER に 'skill' カテゴリを追加（custom カテゴリと standard カテゴリの間に配置を推奨）」と明確化する。

---

## Should Fix（推奨対応）

### F001: command-merger.ts の説明が不正確

**カテゴリ**: accuracy
**場所**: 現状の仕組み - 3. `src/lib/command-merger.ts` の説明

**問題**:
Issue では `command-merger.ts` を「Standard + MCBD + Worktree コマンドをマージ」と説明しているが、実際には `mergeCommandGroups()` は Standard と Worktree の2グループのみをマージする。MCBD コマンドは `/api/slash-commands` ルートで別途処理される。

**証拠**:
```typescript
// src/lib/command-merger.ts:98-100
export function mergeCommandGroups(
  standardGroups: SlashCommandGroup[],
  worktreeGroups: SlashCommandGroup[]
): SlashCommandGroup[] {
```
引数は2つのみ。仮説検証レポートでも「Partially Confirmed」と判定されている。

**推奨対応**:
「Standard + Worktree コマンドをマージ（MCBD コマンドは /api/slash-commands ルートで別途処理）」に修正する。

---

### F004: /api/slash-commands/route.ts（MCBD ルート）の変更候補が欠如

**カテゴリ**: completeness
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル

**問題**:
Issue の変更候補ファイルには worktree 用 API ルートのみ記載されているが、MCBD 用の `/api/slash-commands/route.ts` も skills 読み込みの変更が必要である。このルートは `worktreeId` が指定されない場合（`useSlashCommands.ts:91-93`）に使用され、MCBD のプロジェクトルートの `.claude/skills/` を読み込むべきである。

**証拠**:
```typescript
// src/hooks/useSlashCommands.ts:91-93
let endpoint = worktreeId
  ? `/api/worktrees/${worktreeId}/slash-commands`
  : '/api/slash-commands';  // worktreeId なしの場合はこちら

// src/app/api/slash-commands/route.ts:21
const groups = await getSlashCommandGroups();  // skills を読み込まない
```

**推奨対応**:
`src/app/api/slash-commands/route.ts` を変更候補ファイルに追加する。ただし、`slash-commands.ts` の `loadSlashCommands()` 内で skills も読み込むよう変更すれば、このルートの修正は不要になる可能性がある。実装方針を明確化すべきである。

---

### F005: skills の frontmatter フィールドの取り扱い方針が不明確

**カテゴリ**: clarity
**場所**: 要件 - skills の SKILL.md 構造

**問題**:
Issue では skills の SKILL.md 構造として `name`, `description`, `disable-model-invocation`, `argument-hint` の4フィールドを例示しているが、実際の SKILL.md ファイルには `allowed-tools` フィールドも存在する。また、既存の `SlashCommand` インターフェースにはこれらに対応するフィールドが存在しない。

どのフィールドを取得し、どのフィールドを UI に表示するかの方針が不明確である。

**証拠**:
```yaml
# .claude/skills/rebuild/SKILL.md
---
name: rebuild
description: サーバーをリビルドして再起動する。
allowed-tools: Bash(./scripts/*), Bash(git worktree list)
---

# .claude/skills/release/SKILL.md
---
name: release
description: Create a new release with version bump...
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write
argument-hint: [version-type] (major|minor|patch) or [version] (e.g., 1.2.3)
---
```

**推奨対応**:
以下を明確化する:
1. SKILL.md の frontmatter から取得するフィールド（最小限: `name`, `description` のみで十分か）
2. `SlashCommand` インターフェースへの新フィールド追加の要否
3. `argument-hint` を UI に表示するかどうか（例: description の末尾に追記する等）

---

### F006: skills 読み込み時のセキュリティ考慮が不足

**カテゴリ**: completeness
**場所**: 非機能要件

**問題**:
既存の commands 読み込みは `readdirSync` でフラットに `.md` ファイルのみ列挙するシンプルな構造だが、skills は `.claude/skills/*/SKILL.md` というサブディレクトリ走査が必要になる。worktree パスと組み合わせた場合のセキュリティリスクに対する考慮が Issue に記載されていない。

**推奨対応**:
非機能要件に以下を追加:
- skills ディレクトリ走査時はシンボリックリンクを追跡しない（`lstatSync` で確認）
- サブディレクトリ名に `..` を含むパスを拒否する
- 走査対象を `.claude/skills/` 直下の1階層のみに限定する

---

### F009: commands と skills の名前衝突時の優先順位が未定義

**カテゴリ**: clarity
**場所**: 要件 - 機能要件

**問題**:
既存の `mergeCommandGroups()` では worktree commands が standard commands を上書きする優先順位（SF-1）が定義されている。skills を追加した場合、同名の command と skill が存在するケース（例: `/rebuild` が `.claude/commands/rebuild.md` にも `.claude/skills/rebuild/SKILL.md` にも存在する場合）の優先順位が未定義である。

**推奨対応**:
名前衝突時の優先順位を明記する。例: 「同名の command と skill が存在する場合、command を優先する。」

---

## Nice to Have（あれば良い）

### F007: skills の cliTools フィールドの扱いが未記載

**カテゴリ**: completeness
**場所**: 要件 - 機能要件

既存の commands には `cliTools` フィールド（Issue #4）が定義されており、CLI ツールごとのフィルタリングに使用されている。skills の `cliTools` をどう扱うかが未定義。`cliTools` が未定義の場合は Claude-only として扱われる既存の動作（`command-merger.ts:192-194`）があるため、初期実装では skills に `cliTools` を設定しないことで自動的に Claude-only になるが、この方針を明示すると実装者の迷いが減る。

---

### F008: テスト計画の記載がない

**カテゴリ**: completeness
**場所**: Issue 全体

Issue にテスト計画やテスト対象の記載がない。既存テストファイルとの整合性のため、以下のテストケースを検討:

1. skills ディレクトリが存在する場合の正常読み込み
2. skills ディレクトリが存在しない場合のスキップ（エラーにならないこと）
3. 不正な SKILL.md（frontmatter なし等）のエラーハンドリング
4. commands と skills の名前衝突時の振る舞い
5. skill カテゴリのグルーピングと表示順

既存テスト: `tests/unit/slash-commands.test.ts`, `tests/unit/lib/command-merger.test.ts`, `tests/integration/api-worktree-slash-commands.test.ts`

---

### F010: CLAUDE.md のモジュール一覧への追記方針が未記載

**カテゴリ**: consistency
**場所**: Issue 全体

CLAUDE.md の「利用可能なスキル」セクションに `rebuild`, `release`, `release-post` が記載されているが、skills 読み込み機能に関するモジュール情報（例: `loadSkills()` 関数）は未記載。実装完了後のドキュメント更新の要否について言及がない。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/types/slash-commands.ts` | SlashCommandSource 型と SlashCommandCategory 型の変更が必要 |
| `src/lib/command-merger.ts` | CATEGORY_ORDER 配列への skill カテゴリ追加が必要 |
| `src/lib/slash-commands.ts` | skills 読み込みロジック（loadSkills()）追加の主要対象 |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | skills 取得・マージの API ルート変更対象 |
| `src/app/api/slash-commands/route.ts` | MCBD ルートでの skills 読み込み追加が必要（Issue 未記載） |
| `src/lib/standard-commands.ts` | 参照のみ。skills は standard commands とは異なるソースとして管理 |
| `src/components/worktree/SlashCommandList.tsx` | UI 表示の確認。skills カテゴリのラベル表示に影響 |
| `.claude/skills/rebuild/SKILL.md` | 既存 SKILL.md の frontmatter 構造の参照 |
| `.claude/skills/release/SKILL.md` | 既存 SKILL.md の frontmatter 構造の参照 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成情報。利用可能なスキルセクションに rebuild, release, release-post が記載 |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/slash-commands.test.ts` | 既存の slash-commands 単体テスト。skills テスト追加が必要 |
| `tests/unit/lib/command-merger.test.ts` | 既存の command-merger 単体テスト。skill カテゴリテスト追加が必要 |
| `tests/integration/api-worktree-slash-commands.test.ts` | 既存の API 結合テスト。skills マージテスト追加が必要 |
