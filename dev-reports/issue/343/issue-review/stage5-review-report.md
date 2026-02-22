# Issue #343 レビューレポート - Stage 5

**レビュー日**: 2026-02-22
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5 / 6
**前回レビュー**: Stage 1（通常）、Stage 3（影響範囲）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**: good

Stage 1 の Must Fix 指摘（F002, F003）および Stage 3 の Must Fix 指摘（F101, F102, F103）は全て適切に反映されている。更新後の Issue は実装に向けて十分な品質に達しており、残存する指摘は全て should_fix 以下である。

---

## 前回指摘事項の解決状況

### Must Fix 指摘（全件解決済み）

| 指摘ID | 指摘内容 | 解決状況 |
|--------|---------|---------|
| F002 | SlashCommandSource 型への 'skill' 追加が変更候補に欠如 | 解決済み - 変更候補テーブルと受け入れ条件 6 に明記 |
| F003 | CATEGORY_ORDER への 'skill' 追加が不明確 | 解決済み - 変更候補テーブルに具体的な配置推奨と共に明記 |
| F101 | CATEGORY_LABELS に 'skill' キーが未定義のため TypeScript コンパイルエラー | 解決済み - 変更候補テーブルに Record 型制約による必須同時変更として明記、受け入れ条件 9 にも反映 |
| F102 | SlashCommandsResponse.sources に skill カウントが未定義 | 解決済み - 変更候補テーブルに skill: number フィールド追加とカウント計算ロジック追加を明記 |
| F103 | commandsCache が skills を含まないキャッシュ不整合 | 解決済み - 変更候補テーブルに skillsCache 別変数管理と clearCache() 両方クリアを明記、受け入れ条件 10 にも反映 |

### Should Fix 指摘（Stage 1, 3 から）の反映状況

| 指摘ID | 指摘内容 | 反映状況 |
|--------|---------|---------|
| F004 | /api/slash-commands/route.ts の変更候補欠如 | 反映済み - 変更候補テーブルに追加 |
| F005 | frontmatter フィールドの取り扱い方針不明確 | 反映済み - 「frontmatter フィールドの取り扱い方針」サブセクション追加 |
| F009 | 名前衝突時の優先順位未定義 | 反映済み - 機能要件に command 優先の方針とマージ順序を明記 |
| F105 | filterCommandsByCliTool() での skills の扱い未定義 | 反映済み - 機能要件に cliTools は undefined（Claude-only）方針を追加 |
| F107 | mergeCommandGroups() の名前重複解決ロジックの挿入位置不明確 | 反映済み - skills を先に登録し commands で上書きする方式を明記 |

---

## Should Fix（推奨対応）

### F201: CATEGORY_ORDER の配置推奨「custom カテゴリと standard カテゴリの間」に 'custom' カテゴリが存在しない

**カテゴリ**: accuracy
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - src/lib/command-merger.ts

**問題**:
変更候補テーブルの command-merger.ts 行に「CATEGORY_ORDER に 'skill' カテゴリを追加（custom カテゴリと standard カテゴリの間に配置を推奨）」と記載されているが、`SlashCommandCategory` 型にも `CATEGORY_ORDER` 配列にも 'custom' というカテゴリは存在しない。

**証拠**:
`src/types/slash-commands.ts:14-25` の SlashCommandCategory 型定義:
```typescript
export type SlashCommandCategory =
  | 'planning'
  | 'development'
  | 'review'
  | 'documentation'
  | 'workflow'
  | 'standard-session'
  | 'standard-config'
  | 'standard-monitor'
  | 'standard-git'
  | 'standard-util';
```

`src/lib/command-merger.ts:25-38` の CATEGORY_ORDER 配列にも 'custom' は含まれない。

**推奨対応**:
「custom カテゴリと standard カテゴリの間に配置を推奨」を「workflow カテゴリと standard-session カテゴリの間に配置を推奨（CATEGORY_ORDER の6番目の位置）」に修正する。

---

### F202: skills ディレクトリ走査時のセキュリティ考慮が依然として不足

**カテゴリ**: completeness
**場所**: 非機能要件

**問題**:
Stage 1 の F006 で指摘された skills ディレクトリ走査時のセキュリティリスクが、更新後の Issue にも反映されていない。既存の commands 読み込みは `readdirSync` でフラットに `.md` ファイルを列挙するのみだが、skills は `.claude/skills/*/SKILL.md` というサブディレクトリ走査が必要であり、シンボリックリンクやディレクトリ名に `..` を含むエントリが存在した場合のリスクがある。

**証拠**:
- `src/lib/slash-commands.ts:75` - 既存 commands 読み込みはフラットな readdirSync のみ
- `src/lib/worktree-path-validator.ts` - リクエストパラメータのバリデーションのみ。ファイルシステム走査中のパス検証は対象外
- Issue 本文全体に「シンボリック」「symlink」「lstat」「パストラバーサル」等のキーワードなし

**推奨対応**:
非機能要件に以下を追加する:
- skills ディレクトリ走査時はシンボリックリンクを追跡しない（`lstatSync` で確認、`isSymbolicLink()` が true の場合はスキップ）
- サブディレクトリ名に `..` を含むエントリを拒否する
- 解決後のパスが `.claude/skills/` 配下であることを `path.resolve` + `startsWith` で検証する

---

### F203: loadSkills() の basePath パラメータ設計に関する処理フローが不足

**カテゴリ**: completeness
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - src/lib/slash-commands.ts

**問題**:
変更候補テーブルに「loadSkills() は loadSlashCommands() と同様に basePath パラメータを受け取る設計とする」と記載されているが、`getSlashCommandGroups()` 内でどのように skills を統合するかの処理フローが明示されていない。

**証拠**:
`src/lib/slash-commands.ts:105-114` の現在の getSlashCommandGroups():
```typescript
export async function getSlashCommandGroups(basePath?: string): Promise<SlashCommandGroup[]> {
  const commands = basePath
    ? await loadSlashCommands(basePath)
    : commandsCache || (await loadSlashCommands());
  return groupByCategory(commands);
}
```

skills を統合する場合、この関数をどのように拡張するかのフローが不明確。

**推奨対応**:
変更内容に処理フローを追記する: 「getSlashCommandGroups(basePath) を拡張し、(1) commands = loadSlashCommands(basePath)、(2) skills = loadSkills(basePath)、(3) skills + commands を結合した配列を groupByCategory() に渡す。skills を先に配列に入れ commands を後から追加することで、groupByCategory 前の段階で重複は発生しないが、route.ts の mergeCommandGroups 内で Map.set の後勝ちにより command が skill を優先する」。

---

### F204: skills のマージにおける mergeCommandGroups() の役割と責務分担が不明確

**カテゴリ**: clarity
**場所**: 要件 - 機能要件（マージ順序）および影響範囲テーブル

**問題**:
機能要件に「skills のマージ順序: skills を先に commandMap に登録し、その後 commands（standard, worktree）で上書きする方式」と記載されているが、このマージが `mergeCommandGroups()` 内で行われるのか `route.ts` 内で行われるのかが不明確。`slash-commands.ts` の変更候補に「skills マージロジック」の言及があり、`command-merger.ts` の変更候補にも「skills マージロジック追加」とあるため、責務の分担が曖昧。

**証拠**:
- `src/app/api/worktrees/[id]/slash-commands/route.ts:96` - 現在は `mergeCommandGroups(standardGroups, worktreeGroups)` の2引数呼び出し
- Issue の変更候補テーブル - slash-commands.ts と command-merger.ts の両方に「マージロジック」の言及

**推奨対応**:
以下の推奨方式を採用し明確化する。方式(A): `getSlashCommandGroups()` が skills を含んだ worktree コマンドグループを返すよう拡張し、`mergeCommandGroups()` は変更不要とする。skills の commandMap 登録は `getSlashCommandGroups()` 内で行い（skills を先、commands を後に配列結合）、route.ts は既存の呼び出し構造を維持する。この方式であれば `command-merger.ts` の変更は `CATEGORY_ORDER` への 'skill' 追加のみで済む。

---

## Nice to Have（あれば良い）

### F205: テスト計画が受け入れ条件に未記載のまま

**カテゴリ**: completeness
**場所**: 受け入れ条件の後

**問題**:
Stage 1 の F008 で指摘されたテスト計画の不足は、更新後の Issue でも対応されていない。受け入れ条件は機能検証項目として十分に記載されているが、自動テストとして何を追加すべきかの方針が未定義である。

**推奨対応**:
受け入れ条件の後に簡易的なテスト計画を追加する。

---

### F206: argument-hint の表示方針が「実装時に判断」と曖昧

**カテゴリ**: clarity
**場所**: 要件 - frontmatter フィールドの取り扱い方針

**問題**:
argument-hint について「取得し、description の末尾に付加表示することを検討する（実装時に判断）」と記載されており、方針が未確定。

**推奨対応**:
初期実装での方針を確定させることが望ましいが、実装時判断でも大きな問題にはならない。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/command-merger.ts` | CATEGORY_ORDER に 'custom' が存在しないことの確認（L25-38） |
| `src/types/slash-commands.ts` | SlashCommandCategory 型に 'custom' が含まれないことの確認（L14-25） |
| `src/lib/slash-commands.ts` | getSlashCommandGroups() の処理フロー設計（L105-114） |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | mergeCommandGroups 呼び出し構造（L96） |
| `src/lib/worktree-path-validator.ts` | パストラバーサル防止のスコープ確認 |
| `.claude/skills/rebuild/SKILL.md` | 既存 SKILL.md 構造の参照 |
| `.claude/skills/release/SKILL.md` | 既存 SKILL.md 構造の参照 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成情報。利用可能なスキルセクションの参照 |

---

## 総合評価

Issue #343 は Stage 1 および Stage 3 の Must Fix 指摘を全て適切に反映しており、実装に向けて十分な品質に達している。特に以下の点が良好である:

1. **型安全性の確保**: `SlashCommandCategory`, `SlashCommandSource`, `CATEGORY_LABELS` の同時変更が明記されており、TypeScript コンパイルエラーを防止する設計となっている
2. **キャッシュ戦略の明確化**: `skillsCache` を独立管理し `clearCache()` で両方クリアする方針が具体的
3. **名前衝突の解決方針**: skills を先に登録し commands で上書きする Map.set 後勝ち方式が明確
4. **変更不要ファイルの明示**: `useSlashCommands.ts`, `api-client.ts`, `SlashCommandSelector.tsx`, `SlashCommandList.tsx` の変更不要理由が具体的に記載されている
5. **受け入れ条件の充実**: 10項目の具体的な検証条件が定義されている

残存する should_fix 指摘（F201-F204）は実装品質に大きく影響するものではなく、実装者の判断で対応可能な範囲である。特に F201（CATEGORY_ORDER の配置表現）は不正確な記述であるため修正が望ましい。F202（セキュリティ考慮）は実装時に対応すれば機能面での影響はないが、Issue に明記しておくことで考慮漏れを防止できる。
