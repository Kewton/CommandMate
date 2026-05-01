# Issue #689 進捗報告 — Iteration 1

## 概要

Issue #689「Claude Code / Codex の表示コマンドの最新化」の TDD 実装が完了しました。

---

## 実装内容

### 変更ファイル

| ファイル | 変更種別 | 主な変更内容 |
|---------|---------|------------|
| `src/lib/standard-commands.ts` | 更新 | 12件コマンド追加 + FREQUENTLY_USED.codex 更新 |
| `tests/unit/lib/standard-commands.test.ts` | 更新 | テスト名・件数・新規テストブロック追加 |
| `tests/integration/api-worktree-slash-commands.test.ts` | 更新 | 新 Codex コマンドの統合テスト追加 |

### 追加コマンド（Claude 4件 + Codex 8件 = 計 12件）

**Claude（`cliTools: ['claude']` 明示）**:
- `effort` (standard-config) — Adjust model thinking effort (high/medium/low)
- `fast` (standard-config) — Switch to fast response mode
- `focus` (standard-session) — Toggle focus mode
- `lazy` (standard-config) — Toggle lazy mode

**Codex（`cliTools: ['codex']`）**:
- `plan` (standard-session) — Toggle plan mode
- `goal` (standard-session) — Set goal for current session
- `agent` (standard-session) — Switch active agent (Codex)
- `subagents` (standard-session) — Manage subagents
- `fork` (standard-session) — Fork current session
- `memories` (standard-config) — Manage Codex memories
- `skills` (standard-config) — Manage Codex skills
- `hooks` (standard-config) — Manage Codex hooks

### FREQUENTLY_USED.codex 更新

`mcp` → `plan` に変更（根拠: §4 DR1-005 に記載済み）

---

## 検証結果

| チェック項目 | 結果 |
|-------------|------|
| ESLint | ✅ エラー0件 |
| TypeScript | ✅ 型エラー0件 |
| Unit Tests | ✅ 6408 passed |
| Integration Tests (slash commands) | ✅ 6 passed |

### 件数変化サマリー

| 区分 | 変更前 | 変更後 |
|------|-------|-------|
| STANDARD_COMMANDS 総件数 | 33 | 45 |
| Claude 表示総数 | 16 | 20 |
| Codex 表示総数 | 17 | 25 |
| OpenCode 表示総数 | 10 | 10（変更なし） |

---

## 設計方針との整合

全 DR 指摘事項（Must Fix 7件 / Should Fix 13件）に対応済み:

- DR1-001: 新規 Claude 4件の `cliTools: ['claude']` 明示 ✅
- DR1-002: `agent`（Codex）と `agents`（OpenCode）の description 差別化 ✅
- DR3-001: 統合テストで HOME 隔離による global Codex skill/prompt 排除 ✅
- DR4-002/003: セキュリティ allowlist テスト・XSS 回帰テスト追加 ✅
- その他 Should Fix 全件 ✅

---

## 次のアクション

- [ ] コミット
- [ ] PR 作成（`/create-pr` コマンド）
