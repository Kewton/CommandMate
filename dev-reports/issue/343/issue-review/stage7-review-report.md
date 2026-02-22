# Issue #343 レビューレポート - Stage 7

**レビュー日**: 2026-02-22
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: Stage 7（最終影響範囲レビュー）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 5 |
| Nice to Have | 2 |

**総合評価**: good

Stage 3 の重要指摘（F101, F102, F103, F105, F107）は全て適切に反映されている。Stage 5 の指摘（F201-F204）も全て解消されている。更新後の Issue は影響範囲の記述が大幅に改善されており、変更候補ファイル・変更不要ファイル・マージ責務分担・セキュリティ対策が明確に記載されている。残存する指摘は主に細部の整合性とテスト計画に関するものであり、must_fix は存在しない。

---

## 前回指摘（Stage 3）の解消状況

### F101: CATEGORY_LABELS に skill キーが未定義 -- **解消済み**

変更候補テーブルの `src/types/slash-commands.ts` に「CATEGORY_LABELS に `skill: 'Skills'` を追加」と明記されている。Record 型の全キー制約による必須同時変更であることも説明されている。受け入れ条件 9 にも対応する検証項目が追加されている。

### F102: SlashCommandsResponse の sources に skill カウントが未定義 -- **解消済み**

変更候補テーブルの route.ts に「`SlashCommandsResponse.sources` に `skill: number` フィールドを追加」「カウント計算ロジックに `cmd.source === 'skill'` のフィルタを追加」と明記されている。

### F103: commandsCache が skills を含まないキャッシュ不整合 -- **解消済み**

変更候補テーブルに「`skillsCache` を `commandsCache` とは別変数として管理し、`clearCache()` で両方をクリアする」と明記。`filterCommands()` への影響も「commandsCache のみを対象とし skills は検索対象外とする（初期実装）」と方針が定義されている。

### F105: filterCommandsByCliTool() での skills の扱い -- **解消済み**

機能要件に「skills の cliTools は初期実装では未定義（`undefined`）とし、Claude-only として扱う」と明記されている。

### F107: mergeCommandGroups() の名前重複解決ロジック -- **解消済み**

機能要件に「`getSlashCommandGroups()` 内で skills を先に配列に追加し、その後 commands を追加する方式とする（Map.set による後勝ちの仕組みを利用）」と明記。`mergeCommandGroups()` 自体は変更しないことも明確化されている。

---

## 前回指摘（Stage 5）の解消状況

### F201: CATEGORY_ORDER の配置推奨が不正確 -- **解消済み**

「custom カテゴリ」を「workflow カテゴリと standard-session カテゴリの間（6番目の位置）」に修正済み。

### F202: セキュリティ考慮の不足 -- **解消済み**

非機能要件にシンボリックリンク不追跡・`..` 拒否・パス検証の3点が追加されている。

### F203: getSlashCommandGroups() の統合フロー記述不足 -- **解消済み**

変更候補テーブルに具体的な統合フロー（commands 取得 -> skills 取得 -> [...skills, ...commands] 結合 -> groupByCategory()）が明記されている。

### F204: skills マージにおける mergeCommandGroups() の役割が不明確 -- **解消済み**

skills のマージ責務は `slash-commands.ts` の `getSlashCommandGroups()` が担い、`command-merger.ts` では CATEGORY_ORDER 追加のみという責務分担が明確化されている。

---

## Should Fix（推奨対応）

### F301: MCBD ルートは変更候補から除外すべき

**カテゴリ**: impact
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - `/api/slash-commands/route.ts`

**問題**:

変更候補テーブルに `src/app/api/slash-commands/route.ts` が「skills の取得・マージ追加（MCBD プロジェクトルートの `.claude/skills/` 読み込み）」として記載されている。しかし、実際のコードを確認すると、MCBD ルートは `getSlashCommandGroups()` を呼び出して結果を返すだけである。

```typescript
// src/app/api/slash-commands/route.ts:21
const groups = await getSlashCommandGroups();
return NextResponse.json({ groups });
```

Issue の設計では `getSlashCommandGroups()` 内部で skills の読み込み・統合が行われるため、MCBD ルートのコード自体には変更が不要である。変更候補に含まれていると、実装者が不要なコード変更を行う可能性がある。

**推奨対応**:

`src/app/api/slash-commands/route.ts` を変更候補テーブルから「変更不要ファイル」テーブルに移動し、理由を「`getSlashCommandGroups()` 内部で skills 読み込みが行われるため、呼び出し側のコード変更は不要」と記載する。

---

### F302: worktree ルートの source カウント計算の具体的な変更箇所が不足

**カテゴリ**: impact
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - route.ts

**問題**:

Issue の変更候補テーブルで route.ts に「カウント計算ロジックに `cmd.source === 'skill'` のフィルタを追加」と記載されているが、現在のコードには3段階の変更が必要である。

1. `filteredSkillCount` 変数の追加（`cmd.source === 'skill'` フィルタ）-- route.ts:102-107 付近
2. `sources` オブジェクトに `skill` フィールドの追加 -- route.ts:112-114 付近
3. `SlashCommandsResponse` インターフェースの `sources` 型に `skill: number` の追加 -- route.ts:31-35

Issue では (3) は明記されているが、(1)(2) の変更が1行の記述に圧縮されている。実装上は自明であるが、変更候補の記述精度として明示が望ましい。

**推奨対応**:

変更内容を「SlashCommandsResponse.sources に `skill: number` フィールドを追加し、カウント計算に `filteredSkillCount`（`cmd.source === 'skill'`）を追加してレスポンスに含める」のように段階を明示する。

---

### F303: getSlashCommandGroups() のキャッシュ判定と skills の整合性

**カテゴリ**: impact
**場所**: 影響範囲 - 変更が必要なファイル（候補）テーブル - `src/lib/slash-commands.ts`

**問題**:

現在の `getSlashCommandGroups()` は basePath なしの場合に `commandsCache` を使用する:

```typescript
// src/lib/slash-commands.ts:108-110
const commands = basePath
  ? await loadSlashCommands(basePath)
  : commandsCache || (await loadSlashCommands());
```

Issue の設計では `skillsCache` を `commandsCache` とは別変数として管理する方針だが、`getSlashCommandGroups(basePath なし)` の場合に両方のキャッシュをどう判定するかが未定義である。

具体的なリスク:
- `commandsCache` が存在するが `skillsCache` が null の場合（`loadSlashCommands()` のみが先に呼ばれたレガシーコードパス）、skills が欠落する
- `skillsCache` が存在するが `commandsCache` が null の場合は現状起こり得ないが、将来の変更で発生し得る

**推奨対応**:

`getSlashCommandGroups()` のキャッシュ判定方針を明確化する。例: 「basePath なしの場合、`commandsCache` と `skillsCache` の両方が非 null の場合のみキャッシュを使用し、いずれかが null の場合は両方を再読み込みする」。

---

### F304: getSlashCommandGroups テストの labelMap が skill カテゴリ未対応

**カテゴリ**: testing
**場所**: テスト影響範囲

**問題**:

`tests/unit/slash-commands.test.ts` L154-160 の `labelMap` は5カテゴリのみ:

```typescript
const labelMap: Record<string, string> = {
  planning: 'Planning',
  development: 'Development',
  review: 'Review',
  documentation: 'Documentation',
  workflow: 'Workflow',
};
```

`getSlashCommandGroups()` が skills を返すようになると、`category: 'skill'` のグループが含まれる。L163 の `expect(group.label).toBe(labelMap[group.category])` で `labelMap['skill']` が `undefined` となり、テストが失敗する。

このテストはモックなしで実際の `.claude/skills/` ディレクトリを読み込むため、現プロジェクトの `rebuild`, `release`, `release-post` の3つの skills が返される。

**推奨対応**:

テスト計画に「`slash-commands.test.ts` の `labelMap` に `skill: 'Skills'` を追加」を含める。同様に L126 の `validCategories` 配列にも `'skill'` の追加が必要。

---

### F305: CATEGORY_ORDER 更新漏れに対する受け入れ条件の不足

**カテゴリ**: impact
**場所**: 受け入れ条件

**問題**:

受け入れ条件 9 は「`CATEGORY_LABELS` に `skill: 'Skills'` が追加され、TypeScript コンパイルエラーが発生しない」と定義しているが、`CATEGORY_ORDER` への `'skill'` 追加に対応する受け入れ条件が存在しない。

`CATEGORY_LABELS` の更新は `SlashCommandCategory` 型変更に伴うコンパイルエラーで強制されるが、`CATEGORY_ORDER` は `SlashCommandCategory[]` 型であり、新カテゴリの追加を省略してもコンパイルエラーにならない。`groupByCategory()` のフォールバックループ（command-merger.ts:74-83）により skill カテゴリは末尾に表示されるため動作上は問題ないが、Issue で指定された「workflow と standard-session の間」という配置が検証されない。

**推奨対応**:

受け入れ条件に「`CATEGORY_ORDER` に `'skill'` が追加され、Skills カテゴリが workflow と standard-session の間に表示される」を追加する。

---

## Nice to Have（あれば良い）

### F306: テスト計画セクションが未記載

**カテゴリ**: testing
**場所**: 受け入れ条件の後

**問題**:

Stage 5 の F205 で指摘された「テスト計画セクション」が依然として Issue 本文に含まれていない。受け入れ条件は機能的な検証項目として充実しているが、自動テストとして何を追加すべきかの方針が不明確である。

**推奨対応**:

受け入れ条件の後に簡潔なテスト計画を追加する:
1. `loadSkills()` 正常系テスト（skills ディレクトリあり）
2. `loadSkills()` スキップテスト（skills ディレクトリなし）
3. SKILL.md frontmatter パースエラー時のフォールバックテスト
4. command/skill 名前衝突時の優先順位テスト
5. `CATEGORY_ORDER` に `'skill'` が含まれることの検証テスト
6. 既存テスト `labelMap` / `validCategories` への `skill` 追加

---

### F307: CLAUDE.md の更新が影響範囲に含まれていない

**カテゴリ**: impact
**場所**: 影響範囲

**問題**:

CLAUDE.md の「利用可能なスキル」セクションは手動管理されている。本 Issue の実装後、skills は自動検出されるようになるが、CLAUDE.md の記載は変更候補・変更不要のいずれにも含まれていない。

**推奨対応**:

変更不要ファイルテーブルに「CLAUDE.md - 利用可能なスキルセクションは手動管理のため本 Issue では変更不要。実装完了後に別途更新を検討」と追記する。

---

## 全ステージ指摘の最終確認

| 指摘ID | Stage | Severity | ステータス |
|--------|-------|----------|-----------|
| F001-F009 | Stage 1 | 各種 | Stage 2 で反映済み |
| F101 | Stage 3 | must_fix | Stage 4 で反映済み、Stage 7 で確認 |
| F102 | Stage 3 | must_fix | Stage 4 で反映済み、Stage 7 で確認 |
| F103 | Stage 3 | must_fix | Stage 4 で反映済み、Stage 7 で確認 |
| F104-F113 | Stage 3 | should_fix / nice_to_have | Stage 4 で主要項目反映済み |
| F105 | Stage 3 | should_fix | Stage 4 で反映済み、Stage 7 で確認 |
| F107 | Stage 3 | should_fix | Stage 4 で反映済み、Stage 7 で確認 |
| F201-F204 | Stage 5 | should_fix | Stage 6 で反映済み、Stage 7 で確認 |
| F205-F206 | Stage 5 | nice_to_have | 未反映（nice_to_have のため許容） |
| F301-F305 | Stage 7 | should_fix | 新規指摘 |
| F306-F307 | Stage 7 | nice_to_have | 新規指摘 |

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/app/api/slash-commands/route.ts` | MCBD ルート。`getSlashCommandGroups()` 呼び出しのみ。変更不要ファイルへ移動推奨 |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | sources 型・カウント計算・レスポンスの3箇所に skill 追加が必要 |
| `src/lib/slash-commands.ts` | `getSlashCommandGroups()` のキャッシュ判定ロジック（L108-110）の skills 対応設計が必要 |
| `src/lib/command-merger.ts` | `CATEGORY_ORDER`（L25-38）への 'skill' 追加。`groupByCategory()` のフォールバック（L74-83）は安全網 |
| `src/types/slash-commands.ts` | `SlashCommandCategory`, `SlashCommandSource`, `CATEGORY_LABELS` の変更が必要 |
| `tests/unit/slash-commands.test.ts` | `labelMap`（L154-160）と `validCategories`（L126）に 'skill' 追加が必要 |
| `tests/unit/lib/command-merger.test.ts` | 既存テスト破壊なし。skill カテゴリの追加テスト推奨 |
| `tests/integration/api-worktree-slash-commands.test.ts` | sources.skill の検証追加推奨 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | 利用可能なスキルセクションの更新検討（本 Issue スコープ外） |
