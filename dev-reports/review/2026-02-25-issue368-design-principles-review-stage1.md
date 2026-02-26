# Architecture Review Report: Issue #368 Stage 1 - Design Principles

| 項目 | 値 |
|------|-----|
| Issue | #368 |
| Stage | 1 - 通常レビュー（設計原則） |
| Focus | SOLID / KISS / YAGNI / DRY / TypeSafety |
| Date | 2026-02-25 |
| Status | conditionally_approved |
| Score | 4/5 |

---

## Executive Summary

Issue #368の設計方針書（CMATEタブAgent設定タブ追加）に対し、設計原則の観点からレビューを実施した。設計方針書は全体として堅実であり、CLI_TOOL_IDSハードコードの一元化を前提作業として独立させた点、selected_agentsとcli_tool_idの役割分離、JSON文字列によるシンプルなDB設計など、SOLID/KISS/YAGNIの各原則が適切に適用されている。

ただし、Must Fix 1件、Should Fix 5件の指摘がある。特にmodels.ts/route.tsの型定義にハードコードが残存する設計はDRY原則の一元化方針と矛盾しており、対応が必要である。

---

## Findings

### Must Fix (1件)

#### R1-002: models.ts sessionStatusByCliの型定義にハードコードが残存 [DRY]

**影響箇所:**
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/types/models.ts` L73-77
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/types/models.ts` L55-59
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/[id]/route.ts` L36-40
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/route.ts` L36

**問題:**
設計方針書のセクション7-4でsidebar.tsのcliStatusを`Partial<Record<CLIToolType, BranchStatus>>`に変更する計画があるが、models.tsのWorktreeインターフェースにおけるsessionStatusByCli型は依然としてハードコードされたキー`{ claude?: {...}; codex?: {...}; gemini?: {...} }`で定義されている。

現在のコード:
```typescript
// src/types/models.ts L73-77
sessionStatusByCli?: {
  claude?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  codex?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  gemini?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
};
```

また`lastMessagesByCli`（L55-59）も同様の問題を持つ:
```typescript
lastMessagesByCli?: {
  claude?: string;
  codex?: string;
  gemini?: string;
};
```

**改善提案:**
```typescript
// CLIToolType参照に統一
sessionStatusByCli?: Partial<Record<CLIToolType, {
  isRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
}>>;
lastMessagesByCli?: Partial<Record<CLIToolType, string>>;
```

設計方針書のセクション14「変更ファイル」にmodels.tsのsessionStatusByCli/lastMessagesByCli型変更を明記すべき。

---

### Should Fix (5件)

#### R1-001: parseSelectedAgents()とvalidateSelectedAgentsInput()のバリデーションロジック重複 [SRP]

**問題:**
2関数の責務自体は明確に分離されている（DB読み取り用 vs API入力バリデーション用）が、バリデーションロジック（配列長チェック、CLI_TOOL_IDS包含チェック、重複チェック）が実質的に重複している。また、parseSelectedAgents()がDB側の不正データを無言で修正する振る舞いは、データ不整合のデバッグを困難にする。

設計方針書セクション5のコード:
```typescript
// parseSelectedAgents() - DB読み取り用
if (!Array.isArray(parsed) || parsed.length !== 2) return DEFAULT_SELECTED_AGENTS;
if (!parsed.every(id => (CLI_TOOL_IDS as readonly string[]).includes(id))) return DEFAULT_SELECTED_AGENTS;
if (parsed[0] === parsed[1]) return DEFAULT_SELECTED_AGENTS;

// validateSelectedAgentsInput() - API入力バリデーション用
if (!Array.isArray(input) || input.length !== 2) { return { valid: false, error: '...' }; }
if (!input.every(id => typeof id === 'string' && ...)) { return { valid: false, error: '...' }; }
if (input[0] === input[1]) { return { valid: false, error: '...' }; }
```

**改善提案:**
共通のバリデーションコア関数を抽出し、フォールバック時に`console.warn`で警告ログを出力する。

#### R1-003: allCliTools/validCliToolsのハードコードが一元化対象から漏れている [DRY]

**影響箇所:**
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/[id]/route.ts` L34, L165
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/route.ts` L31
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/[id]/auto-yes/route.ts` L23

**問題:**
```typescript
// route.ts内のハードコード（CLI_TOOL_IDSから導出すべき）
const allCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];
const validCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];
```

設計方針書のセクション14「変更ファイル（リファクタリング）」にこれらの置換が含まれているか確認が必要。`[...CLI_TOOL_IDS]`で置換可能。

#### R1-005: switch文exhaustive guard導入時にbuildCliArgs()の引数型がstring [OCP]

**影響箇所:**
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/claude-executor.ts` L85

**問題:**
```typescript
// 現在の実装: cliToolIdがstring型
export function buildCliArgs(message: string, cliToolId: string, permission?: string): string[] {
```

CLIToolType型ではないため、exhaustive guard (`const _exhaustive: never = cliToolId`) がコンパイル時に機能しない。detectThinking()のdefaultフォールバック（cli-patterns.ts L152）でCLAUDE_THINKING_PATTERNを返す暗黙の動作も、新規ツール追加時にバグの温床になる。

**改善提案:**
buildCliArgs()のcliToolId引数を`CLIToolType`型に変更することを設計方針書に明記する。

#### R1-007: cli_tool_idとselected_agentsの自動整合性ロジックが暗黙的 [KISS]

**問題:**
設計方針書セクション3の整合性ルール:
> cli_tool_idがselected_agentsに含まれない場合 -> cli_tool_idをselected_agents[0]に自動更新

この暗黙の自動更新は驚き最小の原則に反する。PATCH APIでselectedAgentsのみを更新した場合に、副作用としてcli_tool_idが変わるのはデバッグ困難。

**改善提案:**
- 案A: バリデーション段階で400エラーを返す
- 案B: APIレスポンスに`autoUpdatedCliToolId: true`フラグを含めて変更を明示する

#### R1-010: DBマイグレーションv18のCASE文がCLI_TOOL_IDSと同期していない [TypeSafety]

**問題:**
```sql
WHEN cli_tool_id NOT IN ('claude', 'codex')
THEN json_array(cli_tool_id, 'claude')
```

SQL文中のリテラル値はTypeScriptのCLI_TOOL_IDS定数と同期が保証されない。geminiが既にcli_tool_idの場合、`['gemini', 'claude']`が生成されるが、この動作の意図が不明確。

**改善提案:**
マイグレーションテストで全CLIToolType値についてテストケースを用意し、設計意図を明記する。

---

### Nice to Have (4件)

#### R1-004: 「2要素固定」制約の定数化 [YAGNI]

要素数を`SELECTED_AGENTS_COUNT = 2`として定数化すれば、将来の変更時の影響箇所が明確になる。現時点では2要素固定で妥当。

#### R1-006: AgentSettingsPaneのAPI呼び出し責務 [SRP]

プロジェクトの慣習（MemoPane等）と一貫しているため問題ないが、`onSelectedAgentsChange`コールバックの契約をJSDocで明記することを推奨。

#### R1-008: getCliToolDisplayName()のnull合体演算子 [DRY]

`Record<CLIToolType, string>`型であれば`?? id`は到達不能。`satisfies Record<CLIToolType, string>`でコンパイル時キー網羅性を保証する方が型安全。

#### R1-009: 実装順序ステップ4-6の並列化明記 [Other]

ステップ4（AgentSettingsPane）、ステップ5（WorktreeDetailRefactored）、ステップ6（sidebar.ts）は相互独立であり並列実装可能。設計書に明記すると開発効率が向上する。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | models.ts型定義のハードコード残存によるvibe-local追加時の型不整合 | High | High | P1 |
| 技術的リスク | buildCliArgs()のstring型引数によるexhaustive guard無効化 | Med | High | P2 |
| 技術的リスク | cli_tool_id自動更新の暗黙的副作用 | Med | Med | P2 |
| 運用リスク | DBマイグレーションSQL内リテラルとCLI_TOOL_IDSの乖離 | Low | Med | P3 |

---

## Positive Aspects

1. **CLI_TOOL_IDSハードコード一元化をステップ1として独立させた設計** -- 前提作業として他のステップへの依存を明確にしている点は優れている
2. **selected_agentsとcli_tool_idの役割分離** -- 既存API/セッション管理への影響を最小化する堅実な判断
3. **代替案との比較セクション** -- 4つの代替案それぞれのメリット/デメリットを検討し、根拠を持って不採用としている点は設計ドキュメントとして模範的
4. **ICLITool/BaseCLIToolのStrategy パターン活用** -- 新規ツール追加に対してOCPに準拠した拡張ポイントが既に存在している
5. **ALLOWED_CLI_TOOLSとselected_agentsの独立管理** -- セキュリティホワイトリストとUI表示設定を分離する判断は適切

---

## Approval Status

**conditionally_approved** -- Must Fix 1件（models.ts型定義のDRY違反）の対応後に承認可能。Should Fix 5件は実装フェーズでの対応でも許容。

---

*Generated by architecture-review-agent for Issue #368 Stage 1*
