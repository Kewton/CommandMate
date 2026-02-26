# Architecture Review Report: Issue #368 - Stage 2 Consistency Review

**Issue**: #368 - CMATEタブAgent設定タブ追加
**Stage**: 2 (整合性レビュー)
**Date**: 2026-02-25
**Focus**: 設計方針書とコードベースの整合性確認

---

## Executive Summary

Issue #368の設計方針書に対し、設計-実装整合性、命名一貫性、インターフェース整合性、依存関係整合性、テスト整合性の5つの観点で整合性レビューを実施した。

**結果**: Must Fix 2件、Should Fix 5件、Nice to Have 3件。

設計方針書は全体として高品質であり、Stage 1の設計原則レビュー指摘事項も適切に反映されている。しかし、コードベースとの詳細な照合により、PATCH APIバリデーションの更新漏れ、DB関数の型ハードコード、変更対象ファイルの網羅性不足、テストファイル存在の誤認など、実装フェーズで手戻りにつながりうる不整合が複数検出された。

---

## Detailed Findings

### Must Fix (2件)

#### R2-001: PATCH APIのvalidCliToolsにvibe-localが含まれない問題の設計漏れ

| 項目 | 内容 |
|------|------|
| カテゴリ | 設計-実装整合性 |
| 対象ファイル | `src/app/api/worktrees/[id]/route.ts` L165 |

**設計書の記載**: セクション8-2でCLI_TOOL_IDSに`'vibe-local'`を追加。セクション14では`route.ts`の変更は`selected_agents`対応のみ記載。

**コードベースの実態**: PATCH APIのcliToolIdバリデーション（L165）に以下のハードコードが存在する。

```typescript
// src/app/api/worktrees/[id]/route.ts L165
const validCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];
if (validCliTools.includes(body.cliToolId)) {
    updateCliToolId(db, params.id, body.cliToolId);
}
```

`vibe-local`がCLI_TOOL_IDSに追加された場合、この`validCliTools`配列も更新が必要だが設計書に明記がない。さらに、`validCliTools`（cliToolId設定バリデーション）と`ALLOWED_CLI_TOOLS`（スケジュール実行ホワイトリスト、`claude-executor.ts` L33）の役割の違いが設計書で区別されていない。

**提案**: 設計書セクション4およびセクション14で、`validCliTools`をCLI_TOOL_IDS参照に変更する旨を明記する。セクション9に`validCliTools`と`ALLOWED_CLI_TOOLS`の役割の違いを追加する。

---

#### R2-002: getLastMessagesByCliBatch()の返値型ハードコードが変更対象から漏れている

| 項目 | 内容 |
|------|------|
| カテゴリ | 設計-実装整合性 |
| 対象ファイル | `src/lib/db.ts` L157 |

**設計書の記載**: R1-002対応として`src/types/models.ts`の`lastMessagesByCli`型を`Partial<Record<CLIToolType, string>>`に変更。`src/lib/db.ts`は「SQL IN句の動的化」として変更対象に含まれている。

**コードベースの実態**: `db.ts`内の`getLastMessagesByCliBatch()`関数の返値型がハードコードされている。

```typescript
// src/lib/db.ts L157
const result = new Map<string, { claude?: string; codex?: string; gemini?: string }>();
```

`models.ts`の型を変更しても、`db.ts`のこの箇所が更新されなければ型不整合が発生する。

**提案**: 設計書セクション14の`src/lib/db.ts`変更内容に「`getLastMessagesByCliBatch()`の返値型を`Partial<Record<CLIToolType, string>>`に変更」を明示する。

---

### Should Fix (5件)

#### R2-003: log-manager.tsの表示名ハードコードが変更対象ファイルから漏れている

| 項目 | 内容 |
|------|------|
| カテゴリ | 設計-実装整合性 |
| 対象ファイル | `src/lib/log-manager.ts` L91, L101, L137, L187, L221 |

**コードベースの実態**:

```typescript
// L91
const toolName = cliToolId === 'claude' ? 'Claude Code' : cliToolId === 'codex' ? 'Codex CLI' : 'Gemini CLI';
// L187
const toolIds = cliToolId === 'all' ? ['claude', 'codex', 'gemini'] : [cliToolId];
// L221
const toolIds = ['claude', 'codex', 'gemini'];
```

設計書セクション6の`getCliToolDisplayName()`統一対象にこれらが含まれておらず、セクション14でも具体的記載がない。

**提案**: セクション6の統一対象とセクション14の変更内容にlog-manager.tsを明示的に追加する。

---

#### R2-004: VibeLocalToolのname属性と表示名パターンの不統一

| 項目 | 内容 |
|------|------|
| カテゴリ | 命名一貫性 |

**整合性比較表**:

| ツール | tool.name (CLIToolInfo.name) | getCliToolDisplayName() |
|--------|------------------------------|------------------------|
| claude | `'Claude Code'` | `'Claude'` |
| codex | `'Codex CLI'` | `'Codex'` |
| gemini | `'Gemini CLI'` | `'Gemini'` |
| vibe-local | `'Vibe Local'` (設計書) | `'Vibe Local'` (設計書) |

既存ツールでは`tool.name`と`getCliToolDisplayName()`が異なる値だが、`vibe-local`では同じ値。これ自体は問題ではないが、2つの名前属性の使い分け方針が設計書に記載されていない。

**提案**: セクション6に`tool.name`（正式名称、CLIToolInfo用）と`getCliToolDisplayName()`（UI表示用短縮名）の使い分け方針を追記する。

---

#### R2-005: WorktreeインターフェースにselectedAgentsフィールドが未定義

| 項目 | 内容 |
|------|------|
| カテゴリ | インターフェース整合性 |
| 対象ファイル | `src/types/models.ts` |

**設計書の記載**: セクション4でGET APIレスポンスに`selectedAgents`フィールドを追加する旨を記載。セクション14の変更ファイル一覧で`models.ts`は`sessionStatusByCli`型変更のみ記載。

**コードベースの実態**: 現行の`Worktree`インターフェースに`selectedAgents`フィールドは存在しない。GET APIでは`{ ...worktree, selectedAgents: [...] }`のようにスプレッドで返却する想定と推測されるが、Worktree型自体にフィールドがなければクライアント側での型安全性が確保できない。

さらに、`db.ts`の`getWorktreeById()`（L288-344）と`getWorktrees()`（L180-250）のSELECT文に`selected_agents`カラムの取得が追加されていない点も設計書で言及されていない。

**提案**: セクション3または14で、`Worktree`インターフェースへの`selectedAgents`フィールド追加方針と、`db.ts`のクエリ関数における`selected_agents`カラム取得・`parseSelectedAgents()`変換の追加を明記する。

---

#### R2-006: selected-agents-validator.tsの依存関係レイヤー図への反映

| 項目 | 内容 |
|------|------|
| カテゴリ | 依存関係整合性 |

`src/lib/selected-agents-validator.ts`（ビジネスロジック層）から`src/lib/cli-tools/types.ts`（CLIツール層）への依存はコードベースの確立されたパターンに沿っているが、設計書セクション2のmermaid図でこの依存が表現されていない。

**提案**: セクション2のmermaid図に`VAL --> CLI_TOOL_IDS`のような依存矢印を追加する。

---

#### R2-007: テスト設計で参照している既存テストファイルの一部が存在しない

| 項目 | 内容 |
|------|------|
| カテゴリ | テスト整合性 |

**設計書の記載** (セクション11 既存テスト影響):

| テストファイル | 実際の存在 |
|--------------|-----------|
| `tests/unit/cli-tools/*.test.ts` | 存在する (10ファイル) |
| `tests/unit/models.test.ts` | **存在しない** |
| `tests/integration/api/*.test.ts` | 存在する (file-upload, memosのみ。worktrees APIテストは**存在しない**) |
| `tests/unit/sidebar.test.ts` | **存在しない** |

特に`tests/unit/cli-tools/types-cli-tool-ids.test.ts`のL20 `expect(CLI_TOOL_IDS).toHaveLength(3)` は`vibe-local`追加後に4に更新が必要。L32/L44の`'claude', 'codex', 'gemini'`リテラルも更新が必要。

**提案**: セクション11を現状のテストファイル構成と照合して修正する。存在しないテストファイルは「新規作成」として分類する。`types-cli-tool-ids.test.ts`の具体的なアサーション更新箇所を明記する。

---

### Nice to Have (3件)

#### R2-008: sessionStatusByCli型のGETハンドラローカル定義が2ファイルで重複

`src/app/api/worktrees/[id]/route.ts` L36-40と`src/app/api/worktrees/route.ts` L36-40に全く同じハードコード型定義が存在する。設計書セクション14では後者のL31のリテラル配列変更は記載されているが、L36-40の型変更は明記されていない。

#### R2-009: getCliToolDisplayName()のフォールバック値変更によるUI影響

既存の`MessageList.tsx`の`getToolName()`はdefaultで`'Assistant'`を返すが、`getCliToolDisplayName()`に置換するとフォールバック値が`id`文字列に変わる。Stage 1 R1-008として記録済みだが、置換時の注意事項として設計書に追記が望ましい。

#### R2-010: cliToolIdAutoUpdatedフラグのレスポンス型定義

PATCHレスポンスに`cliToolIdAutoUpdated?: boolean`を追加する方針が記載されているが、レスポンスの型定義方針（Worktree型拡張 or レスポンス専用型）が不明確。

---

## 整合性比較表

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| CLI_TOOL_IDS | `['claude','codex','gemini','vibe-local']` | `['claude','codex','gemini']` | 未実装（今後追加予定） |
| sessionStatusByCli型 | `Partial<Record<CLIToolType, ...>>` | `{ claude?; codex?; gemini? }` ハードコード | 2ファイルで変更必要 |
| lastMessagesByCli型 | `Partial<Record<CLIToolType, string>>` | `{ claude?; codex?; gemini? }` ハードコード | models.ts + db.ts で変更必要 |
| buildCliArgs()引数型 | `CLIToolType` | `string` | R1-005対応として記載済み |
| selected_agents DB | v18マイグレーション | カラム未存在 | 未実装（今後追加予定） |
| parseSelectedAgents() | 新規 `selected-agents-validator.ts` | 未存在 | 未実装（今後追加予定） |
| getCliToolDisplayName() | 新規 `cli-tools/types.ts` | 未存在 | 未実装（今後追加予定） |
| PATCH API validCliTools | CLI_TOOL_IDS参照（暗黙） | `['claude','codex','gemini']` ハードコード | **設計書に明記なし** |
| Worktree.selectedAgents | GET APIレスポンスに含む | Worktree型にフィールド未定義 | **設計書に型追加の明記なし** |
| getLastMessagesByCliBatch()返値型 | 暗黙的にPartial<Record<...>> | `{ claude?; codex?; gemini? }` ハードコード | **設計書に変更の明記なし** |
| log-manager.ts表示名 | 未記載 | 3箇所で三項演算子ハードコード | **設計書の変更対象に含まれていない** |
| tests/unit/models.test.ts | 既存テスト影響として記載 | **ファイル不存在** | テスト新規作成が必要 |
| tests/unit/sidebar.test.ts | 既存テスト影響として記載 | **ファイル不存在** | テスト新規作成が必要 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | PATCH API validCliToolsの更新漏れにより、vibe-localがcliToolIdとして設定できない | Medium | High | P1 |
| 技術的リスク | db.ts返値型の不整合によりTypeScriptコンパイルエラー | Medium | High | P1 |
| 技術的リスク | Worktree型にselectedAgentsがないことによるクライアント側型安全性の欠如 | Medium | Medium | P2 |
| 運用リスク | 存在しないテストファイルへの依存によるテスト計画の混乱 | Low | High | P2 |
| 技術的リスク | log-manager.tsのハードコード残存による表示名不統一 | Low | Medium | P3 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. **R2-001**: 設計書セクション4およびセクション14で、PATCH APIの`validCliTools`をCLI_TOOL_IDS参照に変更する旨を明記。セクション9に`validCliTools`と`ALLOWED_CLI_TOOLS`の役割差を追加。
2. **R2-002**: 設計書セクション14の`src/lib/db.ts`変更内容に`getLastMessagesByCliBatch()`返値型変更を追加。

### 推奨改善項目 (Should Fix)

3. **R2-003**: セクション6統一対象およびセクション14にlog-manager.tsを追加。
4. **R2-004**: セクション6に`tool.name`と`getCliToolDisplayName()`の使い分け方針を追記。
5. **R2-005**: Worktreeインターフェースへの`selectedAgents`フィールド追加方針と、db.tsクエリ関数の変更を明記。
6. **R2-006**: セクション2のmermaid図にバリデーション層からCLI_TOOL_IDSへの依存を追加。
7. **R2-007**: セクション11のテスト影響を現状と照合して修正。

### 検討事項 (Nice to Have)

8. **R2-008**: sessionStatusByCli型の共通型抽出を検討。
9. **R2-009**: getCliToolDisplayName()置換時のフォールバック値変更の注記追加。
10. **R2-010**: PATCHレスポンスの型定義方針を明確化。

---

## Approval Status

**Status**: conditionally_approved

Must Fix 2件の指摘は設計書の補完で解消可能であり、アーキテクチャ上の根本的な問題はない。Must Fix項目を反映した上で実装フェーズに進むことを推奨する。

**Score**: 4/5

---

*Generated by architecture-review-agent for Issue #368 Stage 2*
