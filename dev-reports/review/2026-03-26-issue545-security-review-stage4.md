# Issue #545 セキュリティレビュー (Stage 4)

- **対象**: 設計方針書 `dev-reports/design/issue-545-copilot-cli-design-policy.md`
- **レビュー日**: 2026-03-26
- **レビュー観点**: OWASP Top 10 準拠のセキュリティ評価

## サマリー

| 分類 | 件数 |
|------|------|
| must_fix | 2 |
| should_fix | 5 |
| nice_to_have | 3 |
| **合計** | **10** |

## 総合評価

設計方針書はセキュリティに対して十分な意識を持って記述されており、セクション 6 で主要なセキュリティ対策が整理されている。特に、execFile の使用方針、SESSION_NAME_PATTERN によるセッション名バリデーション、ALLOWED_CLI_TOOLS ホワイトリストなど、既存の防御機構が有効に機能している。

主な懸念は以下の2点に集約される:

1. **ワンショットモデル採用時のシェルインジェクションリスク** (SEC4-002): `escapeShellArg()` が未実装であり、tmux sendKeys 経由でシェルコマンド文字列を構築する際のエスケープ処理が不十分。Phase 1 調査で採用モデルが確定するまでは設計上の最大リスク。

2. **exec vs execFile の不一致** (SEC4-001): `base.ts` の `isInstalled()` が `exec()` を使用しており、設計方針書の CopilotTool オーバーライド実装例でも同じパターンを踏襲している。防御の一貫性の観点から `execFile` への統一が望ましい。

---

## must_fix (2件)

### SEC4-001: base.ts の isInstalled() で exec() によるシェルインジェクションのリスク

- **OWASP**: A03:2021 Injection
- **箇所**: `src/lib/cli-tools/base.ts:29`, 設計方針書セクション 3-3
- **内容**: `BaseCLITool.isInstalled()` は `exec(`which ${this.command}`)` を使用している。CopilotTool では `command='gh'` であるため現時点では安全だが、設計方針書セクション 3-3 の isInstalled() オーバーライド実装でも `execAsync('which gh')` と `execAsync('gh extension list')` を exec (shell=true) で実行する設計となっている。
- **推奨対応**: isInstalled() のオーバーライドでは `execFile('which', ['gh'])` および `execFile('gh', ['extension', 'list'])` を使用する。base.ts の既存 exec 使用も技術的負債として記録する。

### SEC4-002: ワンショットモデルの sendMessage() でシェルインジェクションのリスク

- **OWASP**: A03:2021 Injection
- **箇所**: 設計方針書セクション 3-4, DR2-004
- **内容**: ワンショット実行モデルでは `sendKeys(sessionName, 'gh copilot suggest "${escapeShellArg(message)}"', true)` の形式でシェルコマンド文字列を構築する。`escapeShellArg()` は現時点でコードベースに存在しない。tmux sendKeys は execFile 経由で引数を渡すためシェル展開は行われないが、tmux セッション内のシェルがコマンド文字列を解釈するため、`$(...)`, バッククォート, `; rm -rf /` 等の攻撃文字列が有効になる。
- **推奨対応**:
  - シングルクォートラッピング方式 (`'...'` + 内部シングルクォートのエスケープ) を推奨
  - テストケース必須: ダブルクォート, シングルクォート, バッククォート, `$()`, `; command`, 改行文字, null バイト
  - REPL モデル採用でこの経路を使わない場合は、設計書にワンショットモデル不採用と明記し `escapeShellArg()` を実装しないこと

---

## should_fix (5件)

### SEC4-003: GitHub 認証トークンの tmux capture 経由漏洩リスクの評価が不十分

- **OWASP**: A02:2021 Cryptographic Failures
- **箇所**: 設計方針書セクション 6-2
- **内容**: 「tmuxセッション出力にはトークンは表示されない（ghの標準動作）」と記載しているが根拠が薄い。GH_DEBUG=1 等でトークンが表示される可能性がある。
- **推奨対応**: env-sanitizer.ts の SENSITIVE_ENV_KEYS に `GH_DEBUG` を追加。Phase 1 で実際にトークン漏洩がないことを確認。

### SEC4-004: ALLOWED_CLI_TOOLS と CLI_TOOL_IDS の二重管理

- **OWASP**: A03:2021 Injection
- **箇所**: `src/lib/session/claude-executor.ts:37`, `src/lib/cli-tools/types.ts:10`
- **内容**: 設計書 DR2-002 で認識済み。copilot を CLI_TOOL_IDS に追加しても ALLOWED_CLI_TOOLS に追加し忘れると、スケジュール実行で拒否される。
- **推奨対応**: `ALLOWED_CLI_TOOLS = new Set(CLI_TOOL_IDS)` から導出。

### SEC4-005: エラーメッセージに未検証入力を含むログインジェクションリスク

- **OWASP**: A03:2021 Injection
- **箇所**: `src/lib/cli-tools/validation.ts:38`
- **内容**: `validateSessionName()` がバリデーション失敗時にユーザー入力をそのままエラーメッセージに含める。制御文字や ANSI エスケープシーケンスによるログインジェクションの可能性。
- **推奨対応**: エラーメッセージに含めるセッション名を先頭50文字に切り詰め、制御文字を除去する。

### SEC4-008: buildCliArgs() copilot ケースのコマンドマッピング整合性

- **OWASP**: A03:2021 Injection
- **箇所**: 設計方針書セクション 3-2
- **内容**: `getCommandForTool()` が正しく 'gh' を返すことが前提。マッピングミスで 'copilot' がコマンド名として使われると予期しないバイナリが実行される可能性。
- **推奨対応**: `getCommandForTool()` のユニットテストを追加し、copilot -> 'gh' のマッピングを検証する。

### SEC4-010: env-sanitizer.ts に GH_TOKEN / GITHUB_TOKEN が含まれていない

- **OWASP**: A02:2021 Cryptographic Failures
- **箇所**: `src/lib/security/env-sanitizer.ts:19-28`
- **内容**: SENSITIVE_ENV_KEYS には CM_* プレフィックスの変数のみ含まれ、GH_TOKEN / GITHUB_TOKEN は対象外。copilot 以外のツール (claude, codex 等) にもこれらのトークンが渡されている。
- **推奨対応**: GH_TOKEN の扱いを設計書に明記する。copilot の正常動作に必要なため意図的にサニタイズ対象外とする旨をコメントに追記する。

---

## nice_to_have (3件)

### SEC4-006: tmux セッション名のプレフィックスマッチリスク

- **箇所**: `src/lib/tmux/tmux.ts`
- **内容**: tmux の `-t` オプションはプレフィックスマッチを行うため、類似セッション名で意図しないセッションが操作される理論的リスク。
- **推奨対応**: 現行のセッション名フォーマットが十分に一意であるため、現状維持でも許容される。

### SEC4-007: execFile 使用の一貫性

- **箇所**: `src/lib/cli-tools/base.ts:6,12,29`
- **内容**: プロジェクト全体で execFile が推進されているが、base.ts で exec が使用されている。防御の一貫性の観点。
- **推奨対応**: `execFileAsync('which', [this.command])` に変更する。

### SEC4-009: gh copilot による外部 API 呼び出しの SSRF リスク

- **OWASP**: A10:2021 SSRF
- **箇所**: 設計方針書セクション 6-2
- **内容**: gh copilot は GitHub API を呼び出すが、CommandMate が直接制御する外部 API 呼び出しではない。プロキシ設定の継承に注意。
- **推奨対応**: 現時点では対応不要。

---

## セキュリティチェックリスト

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| コマンドインジェクション (OWASP A03) | 要対応 | SEC4-001, SEC4-002 |
| セッション名インジェクション | 合格 | SESSION_NAME_PATTERN で防御済み |
| パストラバーサル | 合格 | 新規ファイルパス操作なし、既存防御が有効 |
| 認証・認可 | 合格 | 新規攻撃面の追加なし |
| 機密データ漏洩 | 要確認 | SEC4-003, SEC4-010 |
| 入力バリデーション | 要対応 | SEC4-004, SEC4-005 |
| execFile vs exec 一貫性 | 要改善 | SEC4-001, SEC4-007 |
| tmux sendKeys エスケープ | 条件付き合格 | REPL モデルなら安全、ワンショットなら SEC4-002 対応必須 |
| ワンショットモデルのシェルエスケープ | 未実装 | SEC4-002 |
| SSRF 防止 | 合格 | 新規外部 API 呼び出しなし |

---

## 実装チェックリスト（セキュリティ観点の追加項目）

- [ ] **[SEC4-001 must_fix]** CopilotTool.isInstalled() で execFile を使用する（exec ではなく）
- [ ] **[SEC4-002 must_fix]** Phase 1 でモデル確定後、ワンショット採用なら escapeShellArg() を実装しテストする。REPL 採用なら設計書に不採用を明記
- [ ] **[SEC4-003 should_fix]** env-sanitizer.ts の SENSITIVE_ENV_KEYS に GH_DEBUG を追加
- [ ] **[SEC4-003 should_fix]** Phase 1 で gh copilot のエラー出力にトークンが含まれないことを確認
- [ ] **[SEC4-004 should_fix]** ALLOWED_CLI_TOOLS を CLI_TOOL_IDS から導出（DR2-002 と同一）
- [ ] **[SEC4-005 should_fix]** validateSessionName() のエラーメッセージで入力値をサニタイズ
- [ ] **[SEC4-008 should_fix]** getCommandForTool() のユニットテスト追加
- [ ] **[SEC4-010 should_fix]** GH_TOKEN の扱いを設計書・コードコメントに明記
