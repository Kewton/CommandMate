# Issue #689 仮説検証レポート

## 検証対象Issue

- **Issue番号**: #689
- **タイトル**: claude codeやcodexの表示コマンドの最新化
- **検証日**: 2026-05-01

---

## 検証結果一覧

| # | 仮説/主張 | 判定 | 詳細 |
|---|----------|------|------|
| 1 | Claude Code: `/effort`, `/fast`, `/focus`, `/lazy` 等が未定義 | **Confirmed** | STANDARD_COMMANDS配列にこれらは存在しない |
| 2 | Codex: `/plan` が CommandMate の `STANDARD_COMMANDS` に未定義 | **Confirmed** | `/plan` はSTANDARD_COMMANDSに存在しない |
| 3 | 現在の `STANDARD_COMMANDS` は 33 件 | **Confirmed** | テスト・ソース共に33件を確認 |
| 4 | Codex表示対象は `cliTools` に `codex` を含むコマンドのみ | **Confirmed** | filterCommandsByCliTool関数がこの通り動作 |
| 5 | 現在のCodex対象コマンドリスト（clear, compact, resume, model, permissions, status, review, new, undo, logout, quit, approvals, diff, mention, mcp, init, feedback） | **Confirmed** | 全17件が cliTools に `codex` を含む形で定義済み |
| 6 | `/undo` は現行Codex側でコメントアウトされており見直しが必要 | **Unverifiable** | 外部Codex CLIのソースコードは本リポジトリでは確認不可 |

---

## 詳細検証

### Hypothesis 1: Claude Codeの不足コマンド

**主張**: `/effort`, `/fast`, `/focus`, `/lazy` が未定義

**検証**: `src/lib/standard-commands.ts` の STANDARD_COMMANDS 配列を確認

```
現在のClaudeコマンド（cliTools未定義またはclaudeを含む）:
- clear, compact, resume, rewind, config, model, permissions, status, context, cost,
  review, pr-comments, help, doctor, export, todos
```

`effort`, `fast`, `focus`, `lazy` はいずれも存在しない → **Confirmed**

### Hypothesis 2: Codexの不足コマンド

**主張**: `/plan` が未定義

**検証**: STANDARD_COMMANDS配列の全33件を確認
`plan` はCodexセクションにも他のセクションにも存在しない → **Confirmed**

### Hypothesis 3: STANDARD_COMMANDS件数

**主張**: 現在33件

**検証**: 
- `tests/unit/lib/standard-commands.test.ts` で `expect(STANDARD_COMMANDS.length).toBe(33)` を確認
- ソースファイルの実際の定義数を手動カウント: 33件 → **Confirmed**

内訳:
- Claude専用（cliTools未定義）: 8件（rewind, config, context, cost, pr-comments, doctor, export, todos）
- Claude+Codex共有: 7件（clear, compact, resume, model, permissions, status, review）
- Claude+OpenCode共有: 1件（help）→ compactも含む
- Codex専用: 9件（undo, logout, quit, approvals, diff, mention, mcp, init, feedback）
- Codex+OpenCode共有: 1件（new）
- OpenCode専用: 7件（sessions, connect, exit, models, agents, themes, editor）

### Hypothesis 4: Codexフィルタリングロジック

**主張**: Codex表示は `cliTools` に `codex` を含むコマンドのみ

**検証**: `src/lib/command-merger.ts` の `filterCommandsByCliTool` 関数:
```typescript
if (!cmd.cliTools) {
  return cliToolId === 'claude'; // cliTools未定義はClaudeのみ
}
return cmd.cliTools.includes(cliToolId); // 指定ツールが含まれるか確認
```
→ **Confirmed**

### Hypothesis 5: 現在のCodex対象コマンド

**主張**: clear, compact, resume, model, permissions, status, review, new, undo, logout, quit, approvals, diff, mention, mcp, init, feedback の17件

**検証**: STANDARD_COMMANDSで `cliTools.includes('codex')` を持つコマンドを確認
→ テストで `codexCommands.length` が17件であることを確認 → **Confirmed**

### Hypothesis 6: `/undo` のCodex側廃止

**主張**: 現行Codex CLIでは `Undo` がコメントアウトされており見直しが必要

**検証**: 外部Codex CLI（`codex-rs/tui/src/slash_command.rs`）はこのリポジトリに含まれないため検証不可
→ **Unverifiable**

---

## Stage 1レビューへの申し送り

- Hypothesis 6（`/undo` の廃止可能性）は外部ソース依存のため、Issue本文の記載として扱う
- 追加候補コマンドの表示方針（feature-gated / debug-only）の判断基準をIssueに明記することを推奨
- Codexのコマンド増加に伴い、FREQUENTLY_USED.codexの更新基準も明確化すべき
