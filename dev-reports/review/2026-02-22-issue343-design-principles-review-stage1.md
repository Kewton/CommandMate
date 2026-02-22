# Architecture Review Report: Issue #343 - Stage 1 Design Principles Review

**Issue**: #343 - feat: スラッシュコマンドセレクターで .claude/skills も表示する
**Stage**: 1 - 通常レビュー（設計原則）
**Date**: 2026-02-22
**Status**: conditionally_approved
**Score**: 4/5

---

## Executive Summary

Issue #343 の設計方針書は、既存のスラッシュコマンドローダーに `.claude/skills/*/SKILL.md` の読み込み機能を追加する設計を提案している。全体として既存アーキテクチャを適切に踏襲し、KISS 原則に従った最小限の変更に収まっている。ただし、名前衝突解決ロジックの実装不整合（must_fix）およびキャッシュ障害時の再ロード非効率（must_fix）の2件の重要な指摘がある。これらを修正すれば実装に進んでよい。

---

## Review Checklist

### SOLID Principles

| Principle | Status | Notes |
|-----------|--------|-------|
| Single Responsibility (SRP) | Warning | `getSlashCommandGroups()` の責務がやや増大（D006）。`parseSkillFile` は skills パースに限定され SRP 準拠 |
| Open/Closed (OCP) | Pass | 既存の `loadSlashCommands()` を変更せず `loadSkills()` を追加して拡張。OCP に適合 |
| Liskov Substitution (LSP) | Pass | `SlashCommand` 型を共通で使用し、skills も commands も同じインターフェースで扱える |
| Interface Segregation (ISP) | Pass | 新規インターフェースの追加なし。既存型の拡張のみ |
| Dependency Inversion (DIP) | N/A | 直接的な DIP の適用箇所なし。fs モジュールへの直接依存は既存パターンと一貫 |

### Other Principles

| Principle | Status | Notes |
|-----------|--------|-------|
| KISS | Pass | 新しい設計パターンの導入なし。既存関数ベースのアプローチを維持 |
| YAGNI | Pass | 初期実装は name/description のみ取得。cliTools マッピングや高度な UI は明示的にスコープ外 |
| DRY | Warning | `parseCommandFile` と `parseSkillFile` に軽微な重複（D002）。route.ts の source カウント計算に繰り返しパターン（D012） |

---

## Detailed Findings

### Must Fix (2 items)

#### D001: 名前衝突解決が暗黙的な Map.set() 後勝ち特性に依存（OCP リスク）

**Severity**: must_fix
**Category**: SOLID (OCP)
**Location**: 設計方針書 セクション3-2「設計根拠」項目1、セクション8「名前衝突の解決」

**Description**:

設計方針書では `[...skills, ...commands]` の配列順序と `groupByCategory()` 内部の `Map.set()` 後勝ち特性を活用して、同名 command が skill を上書きする仕様としている。しかし、`groupByCategory()` の現在の実装（`/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/command-merger.ts` L46-86）を確認すると、カテゴリでグルーピングしているのみで、同名コマンドの重複排除は行っていない。

```typescript
// command-merger.ts L52-58 - groupByCategory の実装
const groupMap = new Map<SlashCommandCategory, SlashCommand[]>();
for (const command of commands) {
  const existing = groupMap.get(command.category) || [];
  existing.push(command);  // push するだけで上書きしない
  groupMap.set(command.category, existing);
}
```

`Map.set()` は category をキーとしており、command name をキーとした重複排除ではない。そのため、同名の skill と command が異なるカテゴリに分類される場合はもちろん、同一カテゴリでも両方が配列に push される。名前ベースの重複排除は `mergeCommandGroups()` 内の `commandMap.set(cmd.name, ...)` で行われるが、`getSlashCommandGroups()` 内の直接結合ではこのロジックを経由しない。

**Suggestion**:

`getSlashCommandGroups()` 内で skills と commands を結合する際に、明示的に name ベースの重複排除ロジックを追加する。

```typescript
// 例: 明示的な重複排除
const commandMap = new Map<string, SlashCommand>();
for (const skill of skills) {
  commandMap.set(skill.name, skill);
}
for (const cmd of commands) {
  commandMap.set(cmd.name, cmd); // commands が後勝ちで skill を上書き
}
return groupByCategory(Array.from(commandMap.values()));
```

---

#### D011: キャッシュ再ロード時に片方だけ失敗するケースの考慮不足

**Severity**: must_fix
**Category**: Error Handling
**Location**: 設計方針書 セクション3-2 getSlashCommandGroups キャッシュロジック

**Description**:

設計案のキャッシュロジックでは `commandsCache === null || skillsCache === null` の場合に両方を再ロードする。しかし、`loadSlashCommands()` が成功して `commandsCache` が更新された後に `loadSkills()` が例外を投げた場合、`skillsCache` は null のままとなる。

```typescript
// 設計案のコード
if (commandsCache === null || skillsCache === null) {
  commandsCache = await loadSlashCommands();  // 成功 -> commandsCache 更新
  skillsCache = await loadSkills();           // 失敗 -> skillsCache は null のまま
}
```

次回呼び出し時に `skillsCache === null` により再度両方がロードされ、`loadSlashCommands()` が不必要に再実行される。`loadSkills()` が毎回失敗する場合（例: パーミッション問題）、毎回 `loadSlashCommands()` も再実行される非効率が生じる。

**Suggestion**:

`loadSkills()` が失敗した場合でも `skillsCache` を空配列 `[]` に設定して「ロード試行済み」を表現する。

```typescript
if (commandsCache === null || skillsCache === null) {
  commandsCache = await loadSlashCommands();
  try {
    skillsCache = await loadSkills();
  } catch {
    console.warn('[slash-commands] Failed to load skills, using empty list');
    skillsCache = [];
  }
}
```

あるいは、`loadSkills()` 自体が内部で例外をキャッチして空配列を返す保証があるなら（現設計では try-catch 内で return null するが関数全体は try-catch で囲まれていない）、関数レベルでの保証を明記する。

---

### Should Fix (4 items)

#### D002: parseCommandFile と parseSkillFile の責務重複（DRY/SRP）

**Severity**: should_fix
**Category**: DRY
**Location**: 設計方針書 セクション3-2 parseSkillFile 関数定義

両関数はファイル読み込み -> gray-matter パース -> SlashCommand 構築という同一パターンを共有している。差異は name 取得方法、category 決定方法、source 設定の3点のみ。現時点では関数が小さいため KISS 優先で許容可能だが、将来の拡張時に共通パースヘルパーの抽出を検討するコメントを残すことを推奨する。

---

#### D003: parseSkillFile のエラーハンドリングがサイレントすぎる

**Severity**: should_fix (severity updated from initial assessment - parseSkillFile errors should be logged but are not critical)
**Category**: Error Handling
**Location**: 設計方針書 セクション3-2 parseSkillFile 関数定義（catch ブロック）

既存の `parseCommandFile()` は `console.error()` でログ出力しているが、設計案の `parseSkillFile()` は catch ブロックで null を返すだけ。SKILL.md の設定ミスやフォーマット不正が開発者に通知されない。

```typescript
// 既存: parseCommandFile (slash-commands.ts L53-55)
} catch (error) {
  console.error(`Error parsing command file ${filePath}:`, error);
  return null;
}

// 設計案: parseSkillFile - ログなし
} catch {
  return null;
}
```

**Suggestion**: `console.warn(`Error parsing skill file ${skillPath}:`, error);` を追加する。

---

#### D006: getSlashCommandGroups() の責務増大（SRP 違反の兆候）

**Severity**: should_fix
**Category**: SOLID (SRP)
**Location**: 設計方針書 セクション3-2 getSlashCommandGroups、セクション8 トレードオフ

変更後の `getSlashCommandGroups()` は commands ロード + skills ロード + 結合 + グルーピング + キャッシュ管理の5つの責務を持つ。設計書でもトレードオフとして認識されている。現時点では KISS で許容するが、3つ以上のソース種別追加時の抽出方針を設計ノートに記載すべき。

---

#### D008: parseSkillFile で source 設定、parseCommandFile では未設定（非対称性）

**Severity**: should_fix
**Category**: SOLID (一貫性)
**Location**: 設計方針書 セクション3-2 parseSkillFile、既存コード `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/slash-commands.ts` L38-57

設計案の `parseSkillFile()` は `source: 'skill'` を明示的に設定するが、既存の `parseCommandFile()` は source を設定していない。`mergeCommandGroups()` 内で `cmd.source || 'worktree'` のフォールバックがあるため merge 経由では問題ないが、`getSlashCommandGroups()` 内で直接結合する場合、parseCommandFile 由来のコマンドは source が undefined となる。route.ts の `cmd.source === 'worktree'` によるカウントに影響する可能性がある。

**Suggestion**: `loadSlashCommands()` 内または `getSlashCommandGroups()` 内で、basePath の有無に応じて source を設定するステップを追加する。

---

### Nice to Have (5 items)

#### D004: loadSkills が async 宣言だが同期処理のみ（一貫性の記録）

既存 `loadSlashCommands()` との一貫性で許容されるが、JSDoc に理由を明記するとよい。

#### D005: parseSkillFile の引数名 skillDir の曖昧さ

`skillDirPath` や `skillSubDir` の方が、skills ルートディレクトリとの混同を防げる。

#### D009: cliTools と SKILL.md の allowed-tools の関係性の明記不足

SKILL.md の `allowed-tools` は Claude CLI のツール許可設定であり、CommandMate の `cliTools` とは異なることを設計決定事項に明記すべき。

#### D010: MCBD API 側の skills 対応の暗黙性

MCBD API（`/api/slash-commands`）が sources フィールドを返すかどうか、skill カウントを含むかを明記すべき。

#### D012: route.ts の source カウント計算の DRY 改善

3回の `flatMap + filter` を1回の `flatMap` + `reduce` に統合可能。

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | D001: 名前衝突解決ロジックが設計書の想定と実装で不一致 | High | High | P1 |
| Technical | D011: キャッシュ片方失敗時の非効率な再ロード | Medium | Low | P2 |
| Technical | D008: source フィールドの非対称設定 | Medium | Medium | P2 |
| Operational | D003: skills パースエラーのサイレント無視 | Low | Medium | P3 |

---

## Improvement Recommendations

### Must Fix (before implementation)

1. **D001**: `getSlashCommandGroups()` 内の skills/commands 結合で、明示的な name ベース重複排除を実装する。`groupByCategory()` の `Map.set()` に依存しない。
2. **D011**: キャッシュロジックで `loadSkills()` 失敗時に `skillsCache = []` を設定し、不必要な再ロードを防止する。

### Should Fix (during implementation)

3. **D003/D008**: `parseSkillFile()` にエラーログを追加し、`parseCommandFile()` と同等のエラー通知を行う。source フィールドの非対称性を解消する。
4. **D006**: 責務増大の将来的な対処方針をコードコメントまたは設計ノートに記録する。

### Consider (future improvement)

5. **D002**: 共通パースヘルパーの抽出は将来のソース種別追加時に検討。
6. **D012**: route.ts のカウント計算を1パスに最適化。

---

## Reviewed Files

| File | Path | Role |
|------|------|------|
| Design Policy | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/dev-reports/design/issue-343-skills-loader-design-policy.md` | Review target |
| slash-commands.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/slash-commands.ts` | Primary change target |
| slash-commands types | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/types/slash-commands.ts` | Type extension target |
| command-merger.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/command-merger.ts` | CATEGORY_ORDER change target |
| route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/app/api/worktrees/[id]/slash-commands/route.ts` | API response extension target |
| SKILL.md (rebuild) | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/.claude/skills/rebuild/SKILL.md` | Reference (actual skill structure) |
| SKILL.md (release) | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/.claude/skills/release/SKILL.md` | Reference (actual skill structure) |
| Test file | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/tests/unit/slash-commands.test.ts` | Existing test reference |

---

## Approval Status

**Status**: conditionally_approved

2件の must_fix 指摘（D001: 名前衝突解決ロジックの不整合、D011: キャッシュ障害時の再ロード非効率）を設計方針書に反映した後、実装に進んでよい。設計全体の品質は高く、既存アーキテクチャとの整合性、KISS/YAGNI 原則への準拠、セキュリティ3層防御の設計は適切である。

---

*Generated: 2026-02-22 | Reviewer: Architecture Review Agent (Stage 1)*
