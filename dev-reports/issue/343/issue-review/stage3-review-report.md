# Issue #343 Stage 3 レビューレポート - 影響範囲レビュー（1回目）

**レビュー日**: 2026-02-22
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）
**前提**: Stage 1（通常レビュー）の指摘を Stage 2 で反映済みの Issue 内容に対するレビュー

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 7 |
| Nice to Have | 3 |
| **合計** | **13** |

**総合評価**: needs_improvement

Stage 1 で発見された主要な問題（SlashCommandSource への 'skill' 追加、CATEGORY_ORDER への追加、MCBD ルートの漏れ等）は Stage 2 で反映済みだが、影響範囲の観点からは新たな問題が見つかった。特に、型定義変更の波及（CATEGORY_LABELS の Record 型制約）、キャッシュ機構への影響、API レスポンス型の不整合、マージ処理における skills の挿入順序が具体的な実装方針として不足している。

---

## Must Fix（必須対応）- 3件

### F101: CATEGORY_LABELS に 'skill' キーが未定義のため TypeScript コンパイルエラーが発生する

**カテゴリ**: compatibility
**影響ファイル**: `src/types/slash-commands.ts`, `src/lib/command-merger.ts`
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - src/types/slash-commands.ts

**問題**:
`CATEGORY_LABELS` は `Record<SlashCommandCategory, string>` として定義されている（`src/types/slash-commands.ts:75`）。TypeScript の `Record` 型は全キーの存在を要求するため、`SlashCommandCategory` に `'skill'` を追加した時点で `CATEGORY_LABELS` に `'skill'` キーがなければコンパイルエラーとなる。

Issue の変更候補では「`CATEGORY_LABELS` 更新」が言及されているが、具体的なラベル文字列が明記されていない。

**証拠**:
```typescript
// src/types/slash-commands.ts:75
export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  planning: 'Planning',
  development: 'Development',
  // ... 10カテゴリ全て列挙 → 'skill' がなければコンパイルエラー
};
```

**推奨対応**:
変更内容に「`CATEGORY_LABELS` に `skill: 'Skills'` を追加」と明記する。`SlashCommandCategory` への `'skill'` 追加と同時に行わなければコンパイルエラーとなるため、必須の同時変更として記載すべきである。

---

### F102: SlashCommandsResponse 型の sources フィールドに skill カウントが未定義（型不整合）

**カテゴリ**: compatibility
**影響ファイル**: `src/app/api/worktrees/[id]/slash-commands/route.ts`, `src/lib/api-client.ts`
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - route.ts

**問題**:
worktree 用 API ルートの `SlashCommandsResponse` インターフェースでは `sources` を `{ standard: number; worktree: number; mcbd: number; }` と定義している。Issue では「sources レスポンスに skill カウントを追加」と記載されているが、具体的な型変更が不明確。

以下 2 箇所の `SlashCommandsResponse` が存在し、影響を整理する必要がある:
1. `src/app/api/worktrees/[id]/slash-commands/route.ts:29-36` - sources フィールドあり
2. `src/lib/api-client.ts:384-386` - groups のみ（sources なし）

**証拠**:
```typescript
// route.ts:29-36
interface SlashCommandsResponse {
  groups: ReturnType<typeof getStandardCommandGroups>;
  sources: {
    standard: number;
    worktree: number;
    mcbd: number;
    // skill: number が必要
  };
  cliTool: CLIToolType;
}
```

**推奨対応**:
以下を変更候補に明記する: (1) `route.ts` の `SlashCommandsResponse.sources` に `skill: number` を追加、(2) `route.ts` のカウント計算に `cmd.source === 'skill'` フィルタを追加、(3) `api-client.ts` の `SlashCommandsResponse` は groups のみのため変更不要であることを確認として記載。

---

### F103: commandsCache が skills を含まないためキャッシュ不整合が発生する

**カテゴリ**: impact
**影響ファイル**: `src/lib/slash-commands.ts`, `src/app/api/slash-commands/route.ts`
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - src/lib/slash-commands.ts

**問題**:
`slash-commands.ts` の `commandsCache`（L22）は `loadSlashCommands()` で読み込んだ commands のみをキャッシュし、skills は含まない。`getSlashCommandGroups()` は basePath 未指定時にキャッシュを使用する。

Issue の設計では `loadSkills()` を別関数として追加する方針だが、skills のキャッシュ管理方針が未定義。

具体的な問題:
1. MCBD ルートで `getSlashCommandGroups()` を呼ぶ際、キャッシュに commands のみが入り skills が欠落する
2. `clearCache()` が commands キャッシュのみクリアし skills キャッシュが残る可能性
3. `filterCommands()` は `commandsCache` のみを検索対象とするため skills が除外される

**証拠**:
```typescript
// slash-commands.ts:22
let commandsCache: SlashCommand[] | null = null;

// slash-commands.ts:108-110
const commands = basePath
  ? await loadSlashCommands(basePath)
  : commandsCache || (await loadSlashCommands());
// skills はどこにもキャッシュされない
```

**推奨対応**:
skills のキャッシュ戦略を明確化する。推奨案: (A) `commandsCache` を commands + skills の統合キャッシュに変更する、または (B) `skillsCache` を別変数として管理し `clearCache()` で両方クリアする。また `filterCommands()` への影響も明記する。

---

## Should Fix（推奨対応）- 7件

### F104: 既存テスト slash-commands.test.ts の SlashCommandCategory 検証が失敗する可能性

**カテゴリ**: testing
**影響ファイル**: `tests/unit/slash-commands.test.ts`

**問題**:
`tests/unit/slash-commands.test.ts:126-129` で `validCategories = ['planning', 'development', 'review', 'documentation', 'workflow']` のみをチェックしている。skills が同じ `loadSlashCommands` 経路で返される場合、このアサーションが失敗する。

**推奨対応**:
skills の読み込みパスを明確化し、テスト影響を判断できるようにする。`loadSkills()` が独立関数であれば既存テストへの影響は最小限。

---

### F105: filterCommandsByCliTool() での skills の扱いが未定義

**カテゴリ**: impact
**影響ファイル**: `src/lib/command-merger.ts`

**問題**:
`filterCommandsByCliTool()` は `cliTools` が `undefined` の場合 Claude-only として扱う。skills の `cliTools` が `undefined` のままだと Codex CLI ユーザーには skills が表示されない。

**証拠**:
```typescript
// command-merger.ts:190-194
if (!cmd.cliTools) {
  return cliToolId === 'claude';  // undefined → Claude-only
}
```

**推奨対応**:
「skills は .claude/ ディレクトリ配下のため、初期実装では cliTools を undefined（Claude-only）として扱う」と明記する。

---

### F106: MCBD ルートの skills 読み込みにおける basePath の扱い

**カテゴリ**: impact
**影響ファイル**: `src/app/api/slash-commands/route.ts`, `src/lib/slash-commands.ts`

**問題**:
`/api/slash-commands/route.ts` は `getSlashCommandGroups()` を basePath なしで呼び出す。`loadSkills()` も同じ `basePath` パラメータ設計にすべきか、`getSlashCommandGroups()` 内で統合的に処理するかの方針が不明確。

**推奨対応**:
`loadSkills()` を `loadSlashCommands()` と同じシグネチャ（`basePath?: string`）で設計し、`getSlashCommandGroups()` 内で commands と skills の両方を basePath ベースで読み込む構造を推奨する。

---

### F107: mergeCommandGroups() の名前重複解決ロジックにおける skills の挿入位置が不明確

**カテゴリ**: impact
**影響ファイル**: `src/lib/command-merger.ts`, `src/app/api/worktrees/[id]/slash-commands/route.ts`

**問題**:
Issue では「同名の command と skill が存在する場合、command を優先する」と定義されているが、`mergeCommandGroups()` は `Map.set` による後勝ちロジック。skills の登録順序によって結果が変わる。

具体的パターン:
- (A) worktreeGroups に skills を含めてからマージ → worktree commands と skills の名前衝突時は後者優先
- (B) マージ後に skills を追加 → skills が全 commands を上書き
- (C) skills を先に登録し commands で上書き → command 優先（要件に合致）

**推奨対応**:
skills を先に `commandMap` に登録し、その後 commands（standard, worktree）で上書きする方式を推奨。具体的な実装方針を Issue に追記する。

---

### F108: 既存テスト command-merger.test.ts の影響と新規テストの必要性

**カテゴリ**: testing
**影響ファイル**: `tests/unit/lib/command-merger.test.ts`

**問題**:
既存テストは壊れないが、skills マージの以下カバレッジが不足:
1. `CATEGORY_ORDER` に `'skill'` が含まれることの検証
2. skills を含む 3 ウェイマージテスト
3. command/skill 名前衝突時の優先順位テスト

**推奨対応**:
テスト計画として上記 3 点を Issue に追加する。

---

### F109: worktree API の integration テストへの影響

**カテゴリ**: testing
**影響ファイル**: `tests/integration/api-worktree-slash-commands.test.ts`

**問題**:
`data.sources.standard > 0` のみ検証しており、skills 追加後の `sources.skill` 検証が存在しない。テストでモックされている worktree パスは実在しないため、skills ディレクトリの有無による分岐テストが行えない。

**推奨対応**:
統合テストとして skills ディレクトリの有無両方のケースを追加する。

---

### F110: parseCommandFile() と skills パースの設計上の差異が未整理

**カテゴリ**: impact
**影響ファイル**: `src/lib/slash-commands.ts`

**問題**:
既存の `parseCommandFile()` は (1) ファイル名から name を取得、(2) `COMMAND_CATEGORIES` で category を決定、(3) `filePath` を相対パスで設定する。skills のパースでは (1) frontmatter の name を使用、(2) category は固定 `'skill'`、(3) source は `'skill'` と異なる。`parseCommandFile()` の再利用は不適切で `parseSkillFile()` の新設が必要。

**推奨対応**:
`loadSkills()` の内部設計として `parseSkillFile()` 関数の存在を明記し、name のフォールバック方針（frontmatter 優先、ディレクトリ名フォールバック）を要件に含める。

---

## Nice to Have（あれば良い）- 3件

### F111: SlashCommandList の UI で skills カテゴリの視覚的区別がない

**カテゴリ**: impact
**影響ファイル**: `src/components/worktree/SlashCommandList.tsx`

skills カテゴリが追加されても既存カテゴリと同じスタイルで表示される。カテゴリラベル「Skills」で十分かもしれないが、将来的な視覚的区別の要否を記載しておくとよい。

---

### F112: useSlashCommands、api-client.ts、UI コンポーネントの変更不要確認

**カテゴリ**: compatibility
**影響ファイル**: `src/hooks/useSlashCommands.ts`, `src/lib/api-client.ts`, `src/components/worktree/SlashCommandSelector.tsx`, `src/components/worktree/SlashCommandList.tsx`

これらのファイルは skills 追加による変更が不要。影響範囲セクションに「変更不要ファイル」として列挙し、理由を簡潔に記載すると実装時の混乱を防げる。

---

### F113: SKILL.md の name フィールド欠落時のフォールバック動作が未定義

**カテゴリ**: testing
**影響ファイル**: `src/lib/slash-commands.ts`

外部リポジトリの SKILL.md で name が欠落している可能性がある。ディレクトリ名をフォールバック値として使用する方針を非機能要件に追加することを推奨。

---

## 影響範囲マップ

### 変更が必要なファイル（確定）

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| `src/types/slash-commands.ts` | `SlashCommandCategory` に `'skill'` 追加、`SlashCommandSource` に `'skill'` 追加、`CATEGORY_LABELS` に `skill: 'Skills'` 追加 | 高（型変更が全ファイルに波及） |
| `src/lib/slash-commands.ts` | `loadSkills()` / `parseSkillFile()` 追加、キャッシュ管理の統合、`getSlashCommandGroups()` の skills 統合 | 高（コアロジック変更） |
| `src/lib/command-merger.ts` | `CATEGORY_ORDER` に `'skill'` 追加 | 中（表示順序に影響） |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | skills マージ、`sources.skill` カウント追加 | 中（API レスポンス変更） |
| `src/app/api/slash-commands/route.ts` | skills の取得・マージ追加 | 中（MCBD ルート） |

### 変更不要のファイル（確認済み）

| ファイル | 理由 |
|---------|------|
| `src/hooks/useSlashCommands.ts` | `groups` フィールドのみ使用、`sources` 未使用 |
| `src/lib/api-client.ts` | `SlashCommandsResponse` は `groups` のみ |
| `src/components/worktree/SlashCommandSelector.tsx` | `groups` を受け取るのみ |
| `src/components/worktree/SlashCommandList.tsx` | カテゴリラベル表示は自動的に対応 |
| `src/lib/standard-commands.ts` | skills とは独立 |

### テスト影響

| テストファイル | 影響 | 対応 |
|--------------|------|------|
| `tests/unit/slash-commands.test.ts` | `validCategories` アサーションが影響を受ける可能性 | skills 読み込みパスの明確化後に判断 |
| `tests/unit/lib/command-merger.test.ts` | 直接的な破壊なし | skills マージのテスト追加が必要 |
| `tests/integration/api-worktree-slash-commands.test.ts` | 直接的な破壊なし | `sources.skill` の検証テスト追加が必要 |
| `tests/integration/api-slash-commands.test.ts` | 直接的な破壊なし | MCBD ルートでの skills 読み込みテスト追加が必要 |

---

## 参照ファイル

### コード（影響大順）
- `src/types/slash-commands.ts`: 型定義の変更起点（12ファイルから import されている）
- `src/lib/slash-commands.ts`: skills 読み込みとキャッシュ管理の主要変更対象
- `src/lib/command-merger.ts`: CATEGORY_ORDER とマージロジック
- `src/app/api/worktrees/[id]/slash-commands/route.ts`: API レスポンス型変更
- `src/app/api/slash-commands/route.ts`: MCBD ルート
- `src/lib/api-client.ts`: 変更不要の確認対象

### 既存 SKILL.md（パース仕様の参照）
- `.claude/skills/rebuild/SKILL.md`: name, description, allowed-tools
- `.claude/skills/release/SKILL.md`: name, description, disable-model-invocation, argument-hint, allowed-tools
- `.claude/skills/release-post/SKILL.md`: name, description, disable-model-invocation, argument-hint, allowed-tools
