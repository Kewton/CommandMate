# Architecture Review: Issue #166 Stage 2 - 整合性レビュー

| 項目 | 内容 |
|------|------|
| Issue | #166 - Codexカスタムスキル読込対応 |
| Stage | 2 (整合性レビュー) |
| 対象 | `dev-reports/design/issue-166-codex-skills-loader-design-policy.md` |
| 日付 | 2026-03-14 |
| ステータス | Conditionally Approved |
| スコア | 4/5 |

---

## Executive Summary

設計方針書は既存コードベースの構造・関数セマンティクス・データフローを正確に把握した上で設計されている。`mergeCommandGroups()`のworktree優先仕様、`deduplicateByName()`の優先度制御、`filterCommandsByCliTool()`のフィルタリング動作のいずれも実装と整合しており、提案されている変更は既存アーキテクチャへの自然な拡張となっている。

ただし、設計書内部に1件の自己矛盾（決定6 vs セクション3.4）があり、実装前に解消が必要である。

---

## 整合性チェック結果

### 合格 (OK): 5件

| # | 確認項目 | 結果 |
|---|---------|------|
| 1 | APIルートの`mergeCommandGroups(standardGroups, worktreeGroups)`実装 | route.ts L104で設計書3.4と一致する呼び出しを確認。standard先登録 -> worktree上書きでSF-1準拠 |
| 2 | `getSlashCommandGroups(basePath)`のbasePath指定時の挙動 | slash-commands.ts L333-338でキャッシュなし都度読み込み。設計書3.4と整合 |
| 3 | `SlashCommandsResponse`型への`sources.codexSkill`追加 | route.ts L36-45のローカルinterfaceへの追加は後方互換性を損なわない自然な拡張 |
| 4 | `mergeCommandGroups()`のworktree優先仕様 | command-merger.ts L103-129: standard先 -> worktree後のMap.set()で後勝ち。設計書と一致 |
| 5 | `deduplicateByName()`の優先度セマンティクス | slash-commands.ts L303-317: skills先 -> commands後で commands優先。skills配列内はcodexLocalSkillsが後のため同名時ローカル優先。設計書と一致 |

### 問題あり (Issue): 3件

| # | 確認項目 | 詳細 |
|---|---------|------|
| 1 | 決定6 vs セクション3.4の自己矛盾 | 決定6は「MBCDパスではCodexスキル不要」と記述、3.4のコード例はMBCDパスでcodexSkillsCacheを読み込む |
| 2 | cliTools JSDoc記述の既存バグ | 型定義は`undefined = ALL tools`と記述、実装は`undefined = claude-only`。設計書3.1の修正提案は妥当 |
| 3 | D009コメントの既存誤り | 「Skills available for all CLI tools」は不正確。設計書3.5の修正案は正確 |

---

## 詳細指摘事項

### Must Fix: 1件

#### D2-001: 設計書内の自己矛盾 -- 決定6 vs セクション3.4

**重要度**: Must Fix

**問題**: 決定6（D1-004）では「MCBD APIではCodexグローバルスキルキャッシュは不要。worktree API経由でのみCodexスキルを返す」と明記している。一方、セクション3.4の`getSlashCommandGroups()`コード例では、basePath未指定時（MBCDパス）にも以下のコードが含まれている:

```typescript
if (codexSkillsCache === null) {
  codexSkillsCache = await loadCodexSkills().catch(() => []);
}
const deduplicated = deduplicateByName([...skillsCache, ...codexSkillsCache], commandsCache);
```

この2箇所が矛盾しており、実装者がどちらの設計意図に従うべきか判断できない。

**推奨対応**: 決定6の意図に従い、セクション3.4のbasePath未指定パスからCodexスキル読み込みコードを削除する。理由: `filterCommandsByCliTool()`がcliTool未指定時はclaudeとして処理するため、MBCDパスにCodexスキルを含めてもフィルタで除外される。含める必然性がない。

---

### Should Fix: 2件

#### D2-002: cliToolsフィールドJSDocの既存バグ修正

**重要度**: Should Fix

**問題**: `src/types/slash-commands.ts` L52-53のJSDoc:

```typescript
// 現在の記述（不正確）
* - undefined: available for ALL tools (backward compatible)
```

`filterCommandsByCliTool()` (command-merger.ts L193-195) の実装:

```typescript
if (!cmd.cliTools) {
  return cliToolId === 'claude';  // undefined = claude-only
}
```

設計書3.1の修正提案が正確にこの矛盾を指摘しており、本Issueの実装時に修正すべき。

#### D2-003: D009コメントの既存誤り修正

**重要度**: Should Fix

**問題**: `slash-commands.ts` L129-130:

```
Skills currently do not set cliTools, making them available for all CLI tools via filterCommandsByCliTool().
```

実際には`cliTools`未設定のスキルはclaude-onlyとして扱われる。設計書3.5の修正案が正確。

---

### Nice to Have: 2件

#### D2-004: parseSkillFile()のfilePathがグローバルスキルで不自然なパスになる

`parseSkillFile()`は`path.relative(process.cwd(), skillPath)`でfilePathを計算する。`~/.codex/skills/`からの読み込み時、cwd外となり`../../../.codex/skills/...`のような相対パスが生成される可能性がある。設計書にこの挙動への注記を追加することを推奨。

#### D2-005: loadSlashCommands()のキャッシュ副作用の注記

`loadSlashCommands()`はbasePath指定時にもグローバルの`commandsCache`を上書きする既存の副作用がある。Issue #166のスコープ外だが、設計書に既知の制約として注記があると実装者の助けになる。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 設計書内の自己矛盾による実装の不確実性 | Medium | High | P1 |
| セキュリティ | なし（既存セキュリティパターンを正しく踏襲） | Low | Low | - |
| 運用リスク | JSDoc/コメントの誤りが開発者の誤解を招く | Low | Medium | P2 |

---

## 承認ステータス

**Conditionally Approved** -- 決定6とセクション3.4の自己矛盾（D2-001）を解消した上で実装に進むこと。D2-002、D2-003の既存ドキュメントバグは本Issue実装時に合わせて修正すること。

---

## レビュー対象ファイル

- `dev-reports/design/issue-166-codex-skills-loader-design-policy.md`
- `src/lib/slash-commands.ts`
- `src/lib/command-merger.ts`
- `src/app/api/worktrees/[id]/slash-commands/route.ts`
- `src/types/slash-commands.ts`
