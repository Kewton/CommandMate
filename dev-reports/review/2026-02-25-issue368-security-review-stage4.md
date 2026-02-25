# Architecture Review: Issue #368 Security Review (Stage 4)

**Date**: 2026-02-25
**Issue**: #368 - CMATEタブAgent設定タブ追加
**Focus**: セキュリティ (OWASP Top 10 準拠確認)
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #368の設計方針書に対してOWASP Top 10準拠のセキュリティレビューを実施した。全体として設計段階でセキュリティを意識した構造（CLI_TOOL_IDSホワイトリスト、validateSessionName()、ALLOWED_CLI_TOOLSの独立管理等）が取り入れられており、基本的なセキュリティ姿勢は良好である。

must_fixは2件、should_fixは4件、nice_to_haveは2件を検出した。

---

## OWASP Top 10 Checklist

| OWASP Category | Status | Findings |
|---------------|--------|----------|
| A01: Broken Access Control | Warning | R4-002 (worktree IDフォーマット検証欠如), R4-007 (オーナーシップ検証) |
| A02: Cryptographic Failures | OK | 該当なし（暗号化操作は本変更スコープ外） |
| A03: Injection | Warning | R4-001 (SQL IN句動的生成), R4-003 (シェルインジェクション) |
| A04: Insecure Design | OK | 多層防御が適切に設計されている |
| A05: Security Misconfiguration | Warning | R4-004 (ALLOWED_CLI_TOOLS判断基準), R4-008 (マイグレーションリテラル) |
| A06: Vulnerable Components | Warning | R4-004 (vibe-localの外部依存リスク) |
| A07: XSS | Info | R4-006 (ReactのXSS自動エスケープへの暗黙依存) |
| A08: Software Integrity | OK | CLI_TOOL_IDSがas constハードコードで改竄リスク低 |
| A09: Logging & Monitoring | Warning | R4-005 (監査ログ不足、ログインジェクション) |
| A10: SSRF | OK | 該当なし |

---

## Detailed Findings

### Must Fix (2 items)

#### R4-001: getLastMessagesByCliBatch() SQL IN句の動的生成方法が未規定

**OWASP Category**: A03 (Injection)
**Severity**: Must Fix

**Description**:
設計方針書セクション14にて、`db.ts` L143のSQL IN句を `CLI_TOOL_IDS` から動的生成する方針が記載されているが、具体的な生成方法が規定されていない。

現在の実装 (`/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/db.ts` L129-L143):
```typescript
const placeholders = worktreeIds.map(() => '?').join(',');
const stmt = db.prepare(`
  ...
  WHERE worktree_id IN (${placeholders})
    AND cli_tool_id IN ('claude', 'codex', 'gemini')
  ...
`);
```

`worktreeIds` はプレースホルダーバインドされているが、`cli_tool_id` のIN句はリテラル文字列である。これを `CLI_TOOL_IDS` から動的生成する場合、文字列テンプレートリテラルで直接埋め込む実装になるリスクがある。CLI_TOOL_IDSは現在ハードコード定数であり即時のリスクは低いが、将来の変更時にリスクが顕在化する。

**Suggestion**:
設計方針書に以下の実装方針を明記すること。

推奨: IN句除去方式を採用し、`cli_tool_id` のフィルタリングはアプリケーション層で行う。ツール数は高々4-5であり、パフォーマンス影響は無視できる。

代替: パラメータバインド方式を採用する場合は以下を必須とする:
```typescript
const cliPlaceholders = CLI_TOOL_IDS.map(() => '?').join(',');
// ... IN (${cliPlaceholders})
stmt.all(...worktreeIds, ...CLI_TOOL_IDS);
```

---

#### R4-002: PATCH /api/worktrees/:id のworktree IDフォーマット検証が欠如

**OWASP Category**: A01 (Broken Access Control)
**Severity**: Must Fix

**Description**:
現在の `worktrees/[id]/route.ts` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/[id]/route.ts`) のPATCHハンドラではworktree IDのフォーマット検証が行われていない。

他のルートとの比較:
- `auto-yes/route.ts` L91: `isValidWorktreeId(params.id)` -- 検証あり
- `schedules/route.ts` L31, L69: `isValidWorktreeId(params.id)` -- 検証あり
- `worktrees/[id]/route.ts` PATCH: -- **検証なし**

エラーレスポンスに `params.id` が直接含まれる (L27, L132):
```typescript
{ error: `Worktree '${params.id}' not found` }
```

selected_agents更新機能の追加により、このルートの重要性が増す。Defense-in-Depth原則に基づく入力検証の追加が必要。

**Suggestion**:
PATCHおよびGETハンドラの冒頭に `isValidWorktreeId(params.id)` チェックを追加する。実装パターンは既存のauto-yes/route.tsと同一:
```typescript
if (!isValidWorktreeId(params.id)) {
  return NextResponse.json(
    { error: 'Invalid worktree ID format' },
    { status: 400 }
  );
}
```

---

### Should Fix (4 items)

#### R4-003: BaseCLITool.isInstalled()のシェルインジェクションリスク

**OWASP Category**: A03 (Injection)
**Severity**: Should Fix

**Description**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/cli-tools/base.ts` L29:
```typescript
await execAsync(`which ${this.command}`, { timeout: 5000 });
```

`exec()` を使用しておりシェル解釈を経由する。`vibe-local` のハイフンは安全だが、`execFile` を使用する `claude-executor.ts` のパターンとの一貫性がない。commandプロパティはハードコード定数であるため現時点でのリスクは低い。

**Suggestion**:
`execFile('which', [this.command])` に変更し、シェル解釈を回避する。

---

#### R4-004: ALLOWED_CLI_TOOLSへのvibe-local追加判断基準の不在

**OWASP Category**: A05 / A06 (Security Misconfiguration / Vulnerable Components)
**Severity**: Should Fix

**Description**:
設計方針書ではvibe-localのALLOWED_CLI_TOOLS追加は「技術調査後に判断」とされているが、その判断基準（セキュリティチェック項目）が具体的に規定されていない。vibe-localが外部CLIツールとしてスケジュール実行される場合のサンドボックス設定、環境変数サニタイズ、出力サイズ制限の確認が必要。

**Suggestion**:
技術調査フェーズの完了条件として、以下のセキュリティチェック項目を設計方針書に追記する:
1. 非インタラクティブモードでのサンドボックス設定（ファイルシステムアクセス範囲、ネットワークアクセス制限）
2. `env-sanitizer.ts` の `SENSITIVE_ENV_KEYS` がvibe-localプロセスにも適用されること
3. 出力サイズ制限（`MAX_OUTPUT_SIZE` 相当）の確認
4. vibe-localの `buildCliArgs()` 引数生成でのコマンドインジェクション防止

---

#### R4-005: selected_agents変更操作のセキュリティ監査ログ不足

**OWASP Category**: A09 (Security Logging & Monitoring Failures)
**Severity**: Should Fix

**Description**:
selected_agents変更操作自体のセキュリティ監査ログが未設計。cli_tool_id自動更新時の `console.info` は設計済みだが、selected_agents変更（変更前後の値）の記録がない。

加えて、`parseSelectedAgents()` のフォールバック時のconsole.warn (設計方針書セクション5):
```typescript
console.warn(`[selected-agents] Invalid data in DB (${result.error}), falling back to default: ${raw}`);
```
`raw` パラメータはDBから取得したJSON文字列であり、改行文字やANSIエスケープシーケンスを含む可能性がある。これはログインジェクションベクターとなる。

**Suggestion**:
1. PATCH APIでselected_agents更新時に変更前後の値をログ出力
2. `parseSelectedAgents()` のconsole.warnに出力する `raw` 値をサニタイズ:
```typescript
const safeRaw = stripAnsi(raw).replace(/[\n\r]/g, ' ').substring(0, 100);
console.warn(`[selected-agents] Invalid data in DB, falling back to default: ${safeRaw}`);
```

---

#### R4-006: AgentSettingsPaneのXSS防御方針の明示

**OWASP Category**: A07 (Cross-Site Scripting)
**Severity**: Should Fix

**Description**:
ReactのJSXは自動的にXSSエスケープを行うが、設計書にはこの防御がUIコンポーネントの実装要件として明示されていない。`getCliToolDisplayName()` のフォールバック値 (`id` そのもの) や、将来のDB由来カスタムツールID導入時のXSSリスクが考慮されていない。`dangerouslySetInnerHTML` を使用しないことの設計レベルでの保証もない。

**Suggestion**:
セキュリティ設計セクション（セクション9）に以下を追記:
1. 新規UIコンポーネントでは `dangerouslySetInnerHTML` を使用しない
2. ツール表示名はReact JSXのテキストノードとして描画し、HTMLとして挿入しない

---

### Nice to Have (2 items)

#### R4-007: worktree IDのオーナーシップ検証の不在

**OWASP Category**: A01 (Broken Access Control)
**Severity**: Nice to Have

CommandMateは現在シングルユーザー/ローカル利用が前提であり、現時点では問題にならない。将来のマルチユーザー対応時に、全worktree操作APIにオーナーシップ検証レイヤーを追加する設計を検討すべきことをセクション13のトレードオフテーブルに記録しておくことを推奨する。

---

#### R4-008: DBマイグレーションv18のリテラル値のセキュリティ影響

**OWASP Category**: A05 (Security Misconfiguration)
**Severity**: Nice to Have

マイグレーション済みDBに対してCLI_TOOL_IDSが変更された場合、DBに不正なselected_agents値が残存する可能性がある。`parseSelectedAgents()` のフォールバック機構が救済するが、アプリケーション起動時のDB整合性ヘルスチェックの追加を検討する。

---

## Risk Assessment

| Risk Type | Level | Detail |
|-----------|-------|--------|
| Technical Risk | Low | CLI_TOOL_IDSハードコードによる型安全性、better-sqlite3のパラメータバインドで基本的なSQLi防御済み |
| Security Risk | Medium | SQL IN句動的生成の実装方法とPATCH APIのID検証欠如が要対処。ALLOWED_CLI_TOOLSの独立管理は適切 |
| Operational Risk | Low | selected_agents変更のログ不足は運用監視に影響するが、シングルユーザー前提では影響限定的 |

---

## Security Architecture Strengths

設計方針書で特に評価できるセキュリティ設計:

1. **CLI_TOOL_IDSホワイトリスト方式**: `as const` 定数による型安全なホワイトリストバリデーション。`validateSelectedAgentsInput()` が `CLI_TOOL_IDS.includes()` で包含チェックを行い、任意の文字列が受理されることを防止。

2. **ALLOWED_CLI_TOOLSの独立管理**: selected_agentsとスケジュール実行のセキュリティホワイトリストを分離する設計（セクション9, R2-001）。未検証ツールの自動実行を防止する多層防御。

3. **validateSessionName()の既存防御**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/cli-tools/validation.ts` の `SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/` により、vibe-localのハイフン含むID (`mcbd-vibe-local-{worktreeId}`) も安全にtmuxセッション名として使用可能。

4. **parseSelectedAgents()のフォールバック設計**: 不正値に対してクラッシュせずデフォルト値に安全にフォールバックする堅牢な設計。JSON.parseのtry-catch、配列型チェック、長さチェック、包含チェック、重複チェックの5層バリデーション。

5. **env-sanitizer.tsによる環境変数サニタイズ**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/env-sanitizer.ts` でSENSITIVE_ENV_KEYSを一元管理し、子プロセスへの機密情報漏洩を防止。

---

## Implementation Checklist (Security Items)

### Must Fix

- [ ] **R4-001**: SQL IN句の実装方針を設計方針書に明記する（推奨: IN句除去方式、代替: パラメータバインド方式）
- [ ] **R4-002**: `src/app/api/worktrees/[id]/route.ts` のGET/PATCHハンドラに `isValidWorktreeId(params.id)` チェックを追加する

### Should Fix

- [ ] **R4-003**: `src/lib/cli-tools/base.ts` の `isInstalled()` を `execFile('which', [this.command])` に変更する
- [ ] **R4-004**: 設計方針書にvibe-localのALLOWED_CLI_TOOLS追加セキュリティチェックリストを追加する
- [ ] **R4-005**: PATCH APIでselected_agents更新時の監査ログを追加する
- [ ] **R4-005**: `parseSelectedAgents()` のconsole.warnの `raw` 値にサニタイズ（stripAnsi + 改行除去 + 長さ制限）を適用する
- [ ] **R4-006**: セクション9にUIコンポーネントのXSS防御方針（dangerouslySetInnerHTML禁止、テキストノード描画）を追記する

---

*Generated by architecture-review-agent for Issue #368 Stage 4 Security Review*
