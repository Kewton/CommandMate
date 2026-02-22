# Architecture Review Report: Issue #343 - Stage 2 整合性レビュー

| 項目 | 内容 |
|------|------|
| Issue | #343 |
| ステージ | Stage 2 |
| レビュー種別 | 整合性レビュー |
| 対象 | 設計方針書 issue-343-skills-loader-design-policy.md |
| 日付 | 2026-02-22 |
| ステータス | conditionally_approved |
| スコア | 4/5 |

---

## 1. エグゼクティブサマリー

Issue #343 の設計方針書は全体的に高品質であり、Stage 1 のレビュー指摘事項が網羅的に反映されている。しかし、既存ソースコードとの整合性チェックにおいて、型定義の安全性とデータフローにおける source フィールドの整合性に関して2件の must_fix 指摘が発見された。これらは実装時に確実に問題を引き起こすものであるため、設計方針書の修正を推奨する。

should_fix 5件は設計方針書の精度向上に関するものであり、nice_to_have 5件は補足的な改善提案である。

---

## 2. レビュー対象ファイルと実施内容

### 設計方針書

- `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/dev-reports/design/issue-343-skills-loader-design-policy.md`

### 検証した既存ソースコード

| ファイル | 検証観点 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/types/slash-commands.ts` | 型定義の整合性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/slash-commands.ts` | 既存関数のシグネチャ・動作との整合性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/command-merger.ts` | CATEGORY_ORDER、mergeCommandGroups、groupByCategory の整合性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/app/api/worktrees/[id]/slash-commands/route.ts` | API レスポンス型・データフローの整合性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/app/api/slash-commands/route.ts` | MCBD API の変更不要性の検証 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/api-client.ts` | SlashCommandsResponse 型の二重定義の確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/hooks/useSlashCommands.ts` | groups 消費パターンの検証 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/standard-commands.ts` | 依存関係の検証 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/components/worktree/SlashCommandSelector.tsx` | UI 消費パターンの検証 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/components/worktree/SlashCommandList.tsx` | CATEGORY_LABELS 依存の検証 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/tests/unit/slash-commands.test.ts` | テスト構造の整合性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/tests/unit/lib/command-merger.test.ts` | テスト構造の整合性 |

---

## 3. 整合性チェック結果一覧

### 3-1. 設計方針書とコードの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| SlashCommandCategory に 'skill' 追加 | セクション 3-1 に明記 | 現在未実装（10カテゴリ） | 整合 -- 新規追加の設計 |
| SlashCommandSource に 'skill' 追加 | セクション 3-1 に明記 | 現在 3値（standard/mcbd/worktree） | 整合 -- 新規追加の設計 |
| CATEGORY_LABELS に 'skill' 追加 | セクション 3-1 に明記 | Record型により追加が強制される | 整合 |
| loadSkills() 新規関数 | セクション 3-2 に詳細記載 | 新規追加 | 整合 |
| skillsCache 追加 | セクション 3-2 に明記 | 現在 commandsCache のみ | 整合 |
| clearCache() 拡張 | セクション 3-2 に明記 | 現在 commandsCache のみクリア | 整合 |
| getSlashCommandGroups() 拡張 | セクション 3-2 に詳細記載 | 現在 commands のみ処理 | **C002: source 未設定問題** |
| deduplicateByName() 新規関数 | セクション 3-2 に明記 | 新規追加 | 整合 |
| CATEGORY_ORDER に 'skill' 追加 | セクション 3-3 に明記 | 現在 10カテゴリ | 整合 |
| SlashCommandsResponse に skill 追加 | セクション 3-4 に明記 | 現在 sources に 3項目 | 整合 |
| parseCommandFile() source 未設定 | [D008] で認識 | 実際に未設定（確認済み） | **C002: 対応方針が曖昧** |
| api/slash-commands/route.ts 変更不要 | セクション 4 に明記 | groups のみ返却（確認済み） | 整合 |
| filterCommandsByCliTool の skills 動作 | セクション 8 [D009] | cliTools undefined で Claude-only | 整合 |

### 3-2. 型の整合性

| 型項目 | 設計書のスニペット | 既存の型定義 | 差異 |
|-------|-----------------|------------|------|
| SlashCommandCategory union | 11値（skill 追加） | 10値 | 整合 -- 追加設計 |
| SlashCommandSource union | 4値（skill 追加） | 3値 | **C001: as キャストに依存** |
| SlashCommand.source フィールド | `source?: SlashCommandSource` | `source?: SlashCommandSource`（L49） | 整合 |
| SlashCommand.cliTools フィールド | 設計書では未設定（undefined） | `cliTools?: CLIToolType[]`（L57） | 整合 |
| CATEGORY_LABELS Record 型 | Record<SlashCommandCategory, string> | 同型（L75） | 整合 -- コンパイル時強制 |
| SlashCommandsResponse.sources | skill: number 追加 | route.ts ローカル型（L29-37） | 整合 -- 追加設計 |

### 3-3. API レスポンスの整合性

| API エンドポイント | 設計書の記載 | 既存実装 | 差異 |
|-------------------|------------|---------|------|
| GET /api/worktrees/[id]/slash-commands | sources に skill 追加 | sources: { standard, worktree, mcbd } | 整合 -- 追加設計 |
| GET /api/slash-commands | 変更不要 | { groups } のみ返却 | 整合 |
| SlashCommandsResponse（api-client.ts） | 変更不要（groups のみ） | { groups: SlashCommandGroup[] } | **C003: 同名型の二重定義** |

### 3-4. テスト計画の整合性

| テスト項目 | 設計書の記載 | 既存テスト構造 | 差異 |
|-----------|------------|--------------|------|
| validCategories に 'skill' 追加（L126） | セクション 7 に明記 | loadSlashCommands テスト内 | **C005: loadSlashCommands は skill を返さない** |
| labelMap に skill 追加（L154-160） | セクション 7 に明記 | getSlashCommandGroups テスト内 | **注意: getSlashCommandGroups が skills を返す場合のみ有効** |
| カテゴリ数 5 -> 6（L48-57） | セクション 7 に明記 | 手動列挙の配列テスト | **C006: 配列への 'skill' 追加詳細が不足** |
| tests/fixtures/skills/ | セクション 7 補足 | 現在ディレクトリ不在 | **C011: フィクスチャ内容の詳細不足** |

### 3-5. 依存関係の整合性

| 依存関係 | 設計書の記載 | 実際のインポート | 差異 |
|---------|------------|----------------|------|
| slash-commands.ts -> command-merger.ts | 構成図に WtAPI -> CM のみ | `import { groupByCategory } from '@/lib/command-merger'` | **C007: SC -> CM の矢印が不足** |
| standard-commands.ts -> command-merger.ts | 構成図に記載なし | `import { groupByCategory } from '@/lib/command-merger'` | **C007: StdCmd -> CM の矢印が不足** |
| route.ts -> slash-commands.ts | 構成図に WtAPI -> SC | `import { getSlashCommandGroups } from '@/lib/slash-commands'` | 整合 |
| route.ts -> command-merger.ts | 構成図に WtAPI -> CM | `import { mergeCommandGroups, filterCommandsByCliTool } from '@/lib/command-merger'` | 整合 |
| route.ts -> standard-commands.ts | 構成図に WtAPI -> StdCmd | `import { getStandardCommandGroups } from '@/lib/standard-commands'` | 整合 |

---

## 4. 詳細指摘事項

### 4-1. Must Fix (2件)

#### C001: SlashCommand.source フィールドの型が設計方針書の 'skill' 値を受け入れられない

**重大度**: must_fix
**カテゴリ**: type_consistency

設計方針書セクション 3-2 の `parseSkillFile()` コードスニペットでは以下のように記載されている:

```typescript
source: 'skill' as SlashCommandSource,
```

現在の `SlashCommandSource` 型（`/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/types/slash-commands.ts` L30）は:

```typescript
export type SlashCommandSource = 'standard' | 'mcbd' | 'worktree';
```

設計方針書セクション 3-1 では `SlashCommandSource` に `'skill'` を追加する変更が記載されているため、型変更と `parseSkillFile()` の実装が共に行われれば問題はない。しかし `as SlashCommandSource` の型アサーションは、型変更が漏れた場合でもコンパイルエラーを起こさないため、型安全性のガードとして機能しない。

**推奨対応**: コードスニペットから `as SlashCommandSource` キャストを除去し、型定義変更を先行させる実装順序を明記する。

---

#### C002: parseCommandFile() の source 未設定問題がカウント正確性に影響

**重大度**: must_fix
**カテゴリ**: code_consistency

現在の `parseCommandFile()`（`/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/slash-commands.ts` L38-57）は返却オブジェクトに `source` フィールドを含めていない:

```typescript
// L46-51 の返却オブジェクト
return {
  name: fileName,
  description: frontmatter.description || '',
  category: category as SlashCommandCategory,
  model: frontmatter.model,
  filePath: path.relative(process.cwd(), filePath),
  // source フィールドなし
};
```

既存のデータフローでは `mergeCommandGroups()`（`/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/command-merger.ts` L120）のフォールバックで `source: cmd.source || 'worktree'` が適用されていた。

しかし設計方針書の新しい `getSlashCommandGroups()` では、basePath あり（worktree 用）の場合:

```typescript
const commands = await loadSlashCommands(basePath);
const skills = await loadSkills(basePath);
const deduplicated = deduplicateByName(skills, commands);
return groupByCategory(deduplicated);
```

この経路では `mergeCommandGroups()` を経由しないため、`commands` の `source` は `undefined` のまま。

route.ts（`/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/app/api/worktrees/[id]/slash-commands/route.ts`）のデータフローは:

1. `getSlashCommandGroups(worktree.path)` --> `deduplicateByName()` 経由（source フォールバックなし）
2. `mergeCommandGroups(standardGroups, worktreeGroups)` --> source フォールバック適用

route.ts L89 で `worktreeGroups = await getSlashCommandGroups(worktree.path)` を呼び出し、L96 で `mergeCommandGroups(standardGroups, worktreeGroups)` に渡す。`mergeCommandGroups()` の L118-122 で worktreeGroups 内の各コマンドに `source: cmd.source || 'worktree'` が適用されるため、最終的には route.ts 経由では source は補完される。

ただし、`getSlashCommandGroups()` を直接使用する `/api/slash-commands` API（MCBD 用）では、MCBD パスの `deduplicateByName(skillsCache, commandsCache)` で結合された結果がそのまま `groupByCategory()` に渡される。この場合 `commandsCache` のコマンドは `source: undefined` のままとなる。MCBD API は sources フィールドを返さないため直接的な影響はないが、将来的に sources を追加する場合にバグの温床となる。

設計方針書の [D008] でこの問題を認識しているが、対応を「実装時に判断」としており不明確。

**推奨対応**: 本 Issue スコープ内で `parseCommandFile()` に `source` フィールドを追加するか、`deduplicateByName()` 内でフォールバック処理を行うかを設計方針書で決定し、実装チェックリストに含める。

---

### 4-2. Should Fix (5件)

#### C003: route.ts と api-client.ts に同名の SlashCommandsResponse 型が存在

route.ts L29-37 のローカル `SlashCommandsResponse`（sources 含む）と、api-client.ts L384-386 のエクスポート `SlashCommandsResponse`（groups のみ）は異なるスコープ・異なる構造であるが同名。設計方針書ではこの点に言及がない。

#### C004: getSlashCommandGroups() MCBD パスのキャッシュ二重代入

`loadSlashCommands()` 内部の L91 で `commandsCache = commands` と代入し、設計方針書の getSlashCommandGroups() でも `commandsCache = await loadSlashCommands()` と代入するため二重管理になる。

#### C005: validCategories テスト修正の対象関数が不適切

`validCategories`（L126）は `loadSlashCommands()` のテスト内にあるが、`loadSlashCommands()` は skills を返さない。'skill' カテゴリの検証は `loadSkills()` または `getSlashCommandGroups()` のテストで行うべき。

#### C006: カテゴリ数テストの配列変更詳細が不足

L48-57 のテストで配列に 'skill' を追加し toHaveLength(6) に変更する必要があるが、設計方針書にはその具体的な差分が記載されていない。

#### C007: システム構成図の依存矢印が不完全

`slash-commands.ts -> command-merger.ts` と `standard-commands.ts -> command-merger.ts` の依存関係が構成図に欠落している。

---

### 4-3. Nice to Have (5件)

#### C008: loadSkills() のディレクトリ不在時のログ差異

`loadSlashCommands()` は `console.warn()` を出力するが、設計方針書の `loadSkills()` はサイレント。意図的な差異であるが設計根拠に未記載。

#### C009: parseSkillFile() と parseCommandFile() の frontmatter フィールド差異

[D002] の差異リストに model フィールドの有無が含まれていない。

#### C010: route.ts のカウント計算における source フォールバック依存の暗黙性

カウントの正確性が `mergeCommandGroups()` のフォールバックに依存していることの明示的な注記があると良い。

#### C011: テストフィクスチャの具体的内容が未記載

`tests/fixtures/skills/` の SKILL.md ファイルの frontmatter サンプルがない。

#### C012: parseSkillFile() の cliTools 省略に関するコメント不足

cliTools フィールドを意図的に省略していることのコードコメントがあると良い。

---

## 5. リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | C002: source 未設定による worktreeCount 不正（MCBD パス） | Medium | Medium | P2 |
| 技術的リスク | C001: 型アサーションによる型安全性の低下 | Medium | Low | P2 |
| 技術的リスク | C005: テスト修正箇所の誤認による実装漏れ | Low | Medium | P3 |
| 運用リスク | C003: 同名型の二重定義によるメンテナンス負荷 | Low | Low | P3 |

---

## 6. 改善推奨事項

### 必須改善項目 (Must Fix)

1. **C001**: `parseSkillFile()` のコードスニペットから `as SlashCommandSource` キャストを除去し、型定義変更（SlashCommandSource への 'skill' 追加）が先行する実装順序を実装チェックリストで明確化する。
2. **C002**: `parseCommandFile()` の source フィールド未設定問題について、本 Issue スコープ内での対応方針を決定し設計方針書に明記する。推奨は `parseCommandFile()` で `source: 'worktree'` を設定する方式。

### 推奨改善項目 (Should Fix)

3. **C003**: 同名 SlashCommandsResponse 型の二重定義について注記を追加する。
4. **C004**: MCBD パスのキャッシュ管理で `loadSlashCommands()` 内部の代入との関係を注記する。
5. **C005**: validCategories テスト修正の対象を `loadSlashCommands()` テストから除外し、適切なテストに移す。
6. **C006**: カテゴリ数テストの配列変更の具体的な差分を記載する。
7. **C007**: システム構成図に不足している依存矢印を追加する。

### 検討事項 (Nice to Have)

8. **C008-C012**: 設計根拠の補足、フィクスチャ詳細の追加、コメント改善。

---

## 7. 承認ステータス

**ステータス: conditionally_approved**

Must Fix 2件の対応を条件として承認。特に C002 の source フィールド問題は実装時にカウント不正を引き起こす可能性があるため、設計方針書での対応方針の明確化が必要。

---

*Generated: 2026-02-22*
*Reviewer: Architecture Review Agent (Stage 2 - 整合性レビュー)*
