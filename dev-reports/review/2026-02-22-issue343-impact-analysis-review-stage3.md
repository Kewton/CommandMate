# Stage 3 影響分析レビュー: Issue #343 - スラッシュコマンドセレクターで .claude/skills も表示する

**レビュー日**: 2026-02-22
**レビュー対象**: 設計方針書 `dev-reports/design/issue-343-skills-loader-design-policy.md`
**レビュー種別**: 影響分析レビュー (Stage 3)
**ステータス**: conditionally_approved
**スコア**: 4/5

---

## 1. エグゼクティブサマリー

Issue #343 の設計方針書について、既存コードベースへの影響範囲を詳細に分析した。全体として、変更は既存アーキテクチャに自然に収まる設計であり、破壊的変更のリスクは低い。ただし、**統合テストの修正漏れ**（I007）と **source フィールド変更のテスト影響**（I012）の2点は実装前に設計方針書への追記が必要である。

### 影響範囲サマリー

| カテゴリ | ファイル数 | リスク |
|---------|----------|-------|
| 直接変更 | 4 | 低 |
| テスト修正 | 3 | 中 |
| 間接影響（動作変更なし） | 5 | 低 |
| 影響なし確認済み | 2 | なし |

---

## 2. 影響分析詳細

### 2-1. 既存テストへの破壊的影響

#### 直接修正が必要なテスト

| テストファイル | 修正箇所 | 影響度 | 設計方針書の対応 |
|-------------|---------|-------|--------------|
| `tests/unit/slash-commands.test.ts` L48-57 | `SlashCommandCategory` テストに `'skill'` 追加、`toHaveLength(6)` | 中 | [C006] で対応済み |
| `tests/unit/slash-commands.test.ts` L154-160 | `labelMap` に `skill: 'Skills'` 追加 | 中 | セクション7で対応済み |
| `tests/integration/api-worktree-slash-commands.test.ts` L87-91 | `sources.skill` プロパティの存在検証追加 | **高** | **未記載（I007）** |

#### 間接的に影響を受ける可能性のあるテスト

| テストファイル | 影響箇所 | 影響度 | 分析結果 |
|-------------|---------|-------|---------|
| `tests/unit/slash-commands.test.ts` L169-193 | `getCachedCommands` の `toEqual` 比較 | 低 | [C002] による source 追加後も、loadSlashCommands() と getCachedCommands() が同一オブジェクト参照を返すため toEqual は成功する。ただし明示的分析が設計方針書に不足（I012） |
| `tests/unit/slash-commands.test.ts` L126 | `validCategories` 配列 | なし | [C005] で変更不要と正しく判断済み |
| `tests/unit/lib/command-merger.test.ts` | 全テスト | なし | テストデータに source を明示的に設定しており、loadSlashCommands() の変更の影響を受けない |

### 2-2. 既存機能への副作用

#### getSlashCommandGroups() の動作変更

**変更前**: commands のみロードしてグルーピング
**変更後**: commands + skills をロードし、deduplicateByName() で重複排除してからグルーピング

| 呼び出し元 | 影響分析 | リスク |
|-----------|---------|-------|
| `/api/worktrees/[id]/slash-commands` (route.ts L89) | worktreeGroups に skills が含まれる。mergeCommandGroups() 経由で処理されるため、skill source のコマンドが正しくカウントされる。sources.skill の追加が必要 | 低 |
| `/api/slash-commands` (route.ts L21) | MCBD の groups に skills が含まれるようになる。クライアントは groups をそのまま表示するため問題なし | 低 |

#### clearCache() の動作変更

**変更前**: `commandsCache = null` のみ
**変更後**: `commandsCache = null; skillsCache = null;` の両方クリア

影響: `clearCache()` を呼び出すコードは直接テスト（L176, L189）と getSlashCommandGroups() のキャッシュリセットシナリオのみ。追加のキャッシュ変数クリアは副作用なし。

#### filterCommandsByCliTool() への影響

skills は `cliTools: undefined` で登録されるため、`filterCommandsByCliTool()` では `cliToolId === 'claude'` の場合のみ表示される。Codex/Gemini ユーザーには skills が非表示。これは設計方針書 [D009] で意図的な決定。

### 2-3. パフォーマンスへの影響

| 操作 | 追加コスト | 頻度 | 影響度 |
|------|----------|------|-------|
| `loadSkills()` - `fs.existsSync()` | 1回の stat syscall | API リクエスト毎 | 極小 |
| `loadSkills()` - `fs.readdirSync()` | 1回のディレクトリ読み取り | skills ディレクトリ存在時のみ | 極小 |
| `loadSkills()` - `fs.readFileSync()` x N | N回のファイル読み取り（N=スキル数） | skills ディレクトリ存在時のみ | 小 |
| `gray-matter` パース x N | N回の frontmatter パース | skills 存在時のみ | 小 |
| `deduplicateByName()` | O(skills + commands) の Map 操作 | 毎回 | 極小 |

**MCBD キャッシュ使用時**: 初回のみ skills をロード。以降はキャッシュから返すためパフォーマンス影響なし。
**worktree パス指定時**: 毎回 commands + skills を再ロード。既存の commands 再ロードに加えて skills 走査が追加される（I004）。

### 2-4. スケーラビリティへの影響

| シナリオ | skills 数 | 影響 |
|---------|----------|------|
| 通常（0-10 skills） | 0-10 | パフォーマンス影響なし |
| 中規模（10-50 skills） | 10-50 | 数十 ms の追加遅延（同期 I/O） |
| 大規模（50+ skills） | 50+ | 顕著な遅延の可能性。上限チェックなし（I005） |

実運用上、.claude/skills/ に50以上のスキルを配置するケースは極めてまれであり、現時点での上限チェックは YAGNI に基づき不要。

### 2-5. skills のみのリポジトリへの影響

| シナリオ | commands | skills | 動作 |
|---------|---------|--------|------|
| 通常リポジトリ | 存在 | なし | 既存動作と同一。skills = []、deduplicateByName() は commands のみ返す |
| skills 追加済みリポジトリ | 存在 | 存在 | commands + skills が統合表示。名前衝突時は command 優先 |
| skills のみのリポジトリ | なし | 存在 | loadSlashCommands() が warn ログ出力。loadSkills() が skills を返す。skill カテゴリのみ表示（I006） |
| 両方なし | なし | なし | 空のグループ。既存動作と同一 |

### 2-6. 後方互換性

| 変更項目 | 後方互換 | 理由 |
|---------|---------|------|
| `SlashCommandCategory` に `'skill'` 追加 | 互換 | Union 型の拡張。既存コードは新しい値を参照しないため影響なし |
| `SlashCommandSource` に `'skill'` 追加 | 互換 | Union 型の拡張。既存の source フィルタリングは `=== 'standard'` や `=== 'worktree'` で行われており `'skill'` を無視する |
| `CATEGORY_LABELS` に `skill` 追加 | 互換 | `Record<SlashCommandCategory, string>` 型のため、コンパイル時に強制。ランタイムでは新しいキーが追加されるのみ |
| `CATEGORY_ORDER` に `'skill'` 追加 | 互換 | 配列への要素追加。既存のカテゴリの順序は変更なし |
| `sources.skill` の API レスポンス追加 | 互換 | JSON に新しいプロパティが追加されるのみ。既存クライアントは参照しないため影響なし |
| `loadSlashCommands()` への source 設定 [C002] | 互換 | `mergeCommandGroups()` のフォールバック値と同一値を明示設定するため、結果は同一 |
| `getSlashCommandGroups()` の戻り値変更 | **注意** | skills が存在する場合、skill カテゴリのグループが追加される。groups をイテレートするクライアントは新しいカテゴリを表示する（意図通りの動作） |

---

## 3. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| テスト破壊 | 統合テストの sources.skill 検証漏れ（I007） | Medium | High | P1 |
| テスト破壊 | source フィールド追加による toEqual 不一致（I012） | Medium | Low | P2 |
| 機能副作用 | filterCommands() が skills を対象外（I002） | Low | Low | P3 |
| パフォーマンス | worktree パスでの追加ファイル走査（I004） | Low | Low | P3 |
| 互換性 | MCBD API レスポンスへの暗黙的 skills 追加（I009） | Low | Medium | P3 |

---

## 4. 指摘事項一覧

### 必須改善項目 (Must Fix) - 2件

#### I007: 統合テスト api-worktree-slash-commands.test.ts の sources.skill 未検証

- **カテゴリ**: test_impact
- **場所**: 設計方針書 セクション7: 新規テストケース
- **説明**: `tests/integration/api-worktree-slash-commands.test.ts` L87-91 の既存テストが `sources.skill` プロパティの存在を検証していない。`SlashCommandsResponse` に `sources.skill` が追加されるため、統合テストにも `expect(data.sources).toHaveProperty('skill')` の追加が必要。
- **改善案**: 設計方針書セクション7の「既存テスト修正が必要な箇所」テーブルに `api-worktree-slash-commands.test.ts` を追加し、`sources.skill` プロパティの検証追加を明記する。

#### I012: loadSlashCommands() の source フィールド設定 [C002] が既存テストに与える影響の分析不足

- **カテゴリ**: test_impact
- **場所**: 設計方針書 セクション8: [D008] source フィールドに関する実装上の注意事項
- **説明**: [C002] により `loadSlashCommands()` の結果に source フィールドが追加される。`getCachedCommands` テスト（L169-193）の `toEqual` 比較では、`loadSlashCommands()` の結果と `getCachedCommands()` の結果が同一オブジェクト参照であるため `toEqual` は成功するが、この分析が設計方針書に明示されていない。
- **改善案**: セクション7またはセクション8に「[C002] による source 追加が getCachedCommands テストに与える影響は、commandsCache がオブジェクト参照であるため同一値を返し toEqual は成功する」旨の分析を追記する。

### 推奨改善項目 (Should Fix) - 5件

#### I001: getSlashCommandGroups テストの labelMap 検証

- **カテゴリ**: test_impact
- **説明**: `labelMap` テストに `skill: 'Skills'` の追加が必要。また、テスト環境の `.claude/skills/` ディレクトリの有無による非決定的動作のリスクがある。
- **改善案**: `labelMap` への `skill: 'Skills'` 追加に加え、テスト環境でのスキルディレクトリの影響を考慮したテスト設計を記載する。

#### I002: filterCommands() が skills を対象外

- **カテゴリ**: functional_impact
- **説明**: `filterCommands()` は `commandsCache` のみ参照し skills は検索対象外。UI では `filterCommandGroups()` が使用されるため実害なし。
- **改善案**: `filterCommands()` の JSDoc に skills を対象外とする旨と、UI フィルタリングには `filterCommandGroups()` を使用すべき旨の注意を追加する。

#### I003: API レスポンスの sources.skill 追加の後方互換性

- **カテゴリ**: compatibility_impact
- **説明**: `sources.skill` の追加は後方互換だが、`api-client.ts` の同名型との整合性について将来の TODO を明記すべき。
- **改善案**: route.ts にコメントとして api-client.ts 側の型更新の TODO を記載する。

#### I004: worktree パスでのキャッシュ無し追加走査

- **カテゴリ**: performance_impact
- **説明**: worktree パス指定時は毎回 commands + skills を再ロードする。skills 追加により I/O 量が増加。
- **改善案**: 将来的な TTL 付きキャッシュの検討事項を設計ノートに記載する。

#### I008: Codex/Gemini での skills 非表示の拡張パス

- **カテゴリ**: functional_impact
- **説明**: skills の `cliTools: undefined` により Claude 以外では非表示。将来的な拡張パスが未検討。
- **改善案**: SKILL.md の frontmatter に `cliTools` フィールドを追加する将来拡張を設計ノートに記載する。

### 検討事項 (Nice to Have) - 5件

#### I005: skills 大量存在時の上限チェック

- **カテゴリ**: performance_impact
- **改善案**: 現時点では YAGNI。将来の MAX_SKILLS_COUNT 検討コメントの追加程度でよい。

#### I006: skills のみのリポジトリのテストシナリオ

- **カテゴリ**: functional_impact
- **改善案**: テストケースに commands 不在 + skills のみのシナリオを追加することを推奨する。

#### I009: MCBD API レスポンスへの暗黙的 skills 追加

- **カテゴリ**: compatibility_impact
- **改善案**: セクション4の「変更不要」テーブルの説明を具体化する。

#### I010: CATEGORY_ORDER テストの配置場所

- **カテゴリ**: test_impact
- **改善案**: CATEGORY_ORDER の skill 配置テストを command-merger.test.ts に追加することを明示する。

#### I011: groupByCategory の fallback ブランチ

- **カテゴリ**: functional_impact
- **改善案**: CATEGORY_ORDER への追加忘れに対する防御としてテスト（I010）と実装チェックリストで二重防御する。

---

## 5. 影響を受けるファイル一覧

### 直接変更ファイル

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/types/slash-commands.ts` | `SlashCommandCategory`, `SlashCommandSource`, `CATEGORY_LABELS` への `'skill'` 追加 | 低 |
| `src/lib/slash-commands.ts` | `loadSkills()`, `parseSkillFile()`, `deduplicateByName()` 追加、`getSlashCommandGroups()` 拡張、`clearCache()` 拡張 | 低 |
| `src/lib/command-merger.ts` | `CATEGORY_ORDER` に `'skill'` 追加 | 低 |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | `SlashCommandsResponse` に `sources.skill` 追加、カウント計算追加 | 低 |

### テスト修正ファイル

| ファイル | 修正内容 | リスク |
|---------|---------|-------|
| `tests/unit/slash-commands.test.ts` | `SlashCommandCategory` テスト修正、`labelMap` 修正、新規テスト追加 | 中 |
| `tests/unit/lib/command-merger.test.ts` | `CATEGORY_ORDER` テスト追加 | 低 |
| `tests/integration/api-worktree-slash-commands.test.ts` | `sources.skill` 検証追加 | 中 |

### 間接影響ファイル（変更不要）

| ファイル | 影響分析 | リスク |
|---------|---------|-------|
| `src/app/api/slash-commands/route.ts` | groups に skills が含まれるようになるが、route.ts 自体は変更不要 | 低 |
| `src/hooks/useSlashCommands.ts` | groups をそのまま表示。sources は未参照 | なし |
| `src/components/worktree/SlashCommandSelector.tsx` | groups を受け取り表示するだけ | なし |
| `src/components/worktree/SlashCommandList.tsx` | CATEGORY_LABELS から label を取得。skill 追加で自動対応 | なし |
| `src/lib/api-client.ts` | MCBD 用の型。sources フィールドなし。変更不要 | なし |

---

## 6. 承認ステータス

**ステータス: conditionally_approved**

設計方針書は全体として高品質であり、影響範囲の分析も概ね適切に行われている。以下の2点の Must Fix を反映した上で実装に進むことを推奨する:

1. **I007**: 統合テスト `api-worktree-slash-commands.test.ts` の `sources.skill` 検証をセクション7に追記する
2. **I012**: [C002] による source フィールド追加が `getCachedCommands` テストに影響しないことの分析をセクション7またはセクション8に追記する

---

*Generated by Architecture Review Agent - 2026-02-22*
*Stage 3: Impact Analysis Review for Issue #343*
