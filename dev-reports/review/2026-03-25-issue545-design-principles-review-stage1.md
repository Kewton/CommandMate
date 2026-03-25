# Architecture Review: Issue #545 Copilot-CLI対応 - Stage 1 設計原則レビュー

| 項目 | 内容 |
|------|------|
| Issue | #545 Copilot-cliに対応したい |
| Stage | 1 - 通常レビュー |
| Focus | 設計原則 (SOLID / KISS / YAGNI / DRY) |
| Date | 2026-03-25 |
| Design Doc | dev-reports/design/issue-545-copilot-cli-design-policy.md |

## 総合評価

設計方針書は既存の Strategy パターンに従った拡張であり、全体的に堅実な設計である。既に8回のレビューを経て洗練されており、影響範囲の洗い出しも網羅的。ただし、設計原則の観点からいくつかの改善点が確認された。

| 分類 | 件数 |
|------|------|
| must_fix | 1 |
| should_fix | 5 |
| nice_to_have | 4 |
| **合計** | **10** |

## Findings

### DR1-004 [must_fix] CopilotTool の command='gh' が BaseCLITool.isInstalled() の LSP 契約を暗黙変更する

- **原則**: Liskov Substitution Principle (LSP)
- **対象セクション**: 3-3. isInstalled() のオーバーライド

BaseCLITool.isInstalled() は `which ${this.command}` で存在確認する (base.ts line 29)。CopilotTool で command='gh' とすると、isInstalled() をオーバーライドしなければ gh CLI の存在だけで copilot がインストール済みと誤判定される。設計方針書セクション 3-3 で isInstalled() オーバーライドを計画しているが、Phase 2 コア実装タスクの必須チェック項目として明記されていない。

**対応案**: Phase 2 の実装タスクに isInstalled() オーバーライドを必須項目として追記。テスト戦略に 'gh インストール済み・copilot 拡張なし' のケースを追加する。

---

### DR1-001 [should_fix] claude-executor.ts が cliToolId を直接コマンド名として使用しており OCP に違反

- **原則**: Open/Closed Principle (OCP)
- **対象セクション**: 3-2. コマンド形式の設計判断

claude-executor.ts line 157-159 で `execFile(cliToolId, args, ...)` としており、copilot の場合に `cliToolId === 'copilot' ? 'gh' : cliToolId` という条件分岐が必要になる。ICLITool.command プロパティや専用マッピング関数を使うことで OCP 準拠にできる。

**対応案**: buildCliArgs() の隣にコマンド名解決関数 `getCommandForTool(cliToolId)` を配置し、copilot='gh' のマッピングを局所化する。

---

### DR1-002 [should_fix] cli-patterns.ts の switch-case が6分岐に増加、移行 Issue の追跡が曖昧

- **原則**: Open/Closed Principle (OCP)
- **対象セクション**: 8. 設計上の決定事項とトレードオフ

D1-003 レジストリパターン移行の延期方針は合理的だが、別 Issue 番号やマイルストーンが未記載で技術的負債の追跡が曖昧。

**対応案**: copilot 実装 PR のクローズ条件として移行 Issue の作成を含め、設計方針書に仮番号または TODO マーカーを記載する。

---

### DR1-005 [should_fix] IImageCapableCLITool の条件付き実装の判断フローが不明確

- **原則**: Interface Segregation Principle (ISP)
- **対象セクション**: 8. 設計上の決定事項とトレードオフ

ISP の観点から画像非対応なら実装しない方針は正しいが、調査結果の記録場所やレビューポイントが未定義。

**対応案**: Phase 1 に調査結果の記録・レビュー手順を追加する。

---

### DR1-006 [should_fix] ワンショットと REPL の両モデルを含む設計が実装時に混乱を招く

- **原則**: Keep It Simple, Stupid (KISS)
- **対象セクション**: 3-4. ワンショット実行モデル（想定パターン）

前提調査未完了段階で両モデルを記載するのは妥当だが、調査完了後に不採用モデルを明示的にマークする運用ルールが必要。

**対応案**: Phase 1 完了後に設計方針書を更新し、不採用モデルを明示的にマークする。

---

### DR1-009 [should_fix] ALLOWED_CLI_TOOLS と CLI_TOOL_IDS の二重管理

- **原則**: Dependency Inversion Principle (DIP)
- **対象セクション**: 3-2. コマンド形式の設計判断

claude-executor.ts の ALLOWED_CLI_TOOLS (line 37) は CLI_TOOL_IDS と同じ値をハードコードしている。CLI_TOOL_IDS が 'single source of truth' として設計されているにもかかわらず参照していない。

**対応案**: `new Set(CLI_TOOL_IDS)` から導出するか、意図的な分離であればその理由を設計方針書に明記する。

---

### DR1-003 [nice_to_have] getErrorMessage() が5つのファイルに重複

- **原則**: Don't Repeat Yourself (DRY)
- **対象セクション**: 3-1. Strategyパターン（既存拡張）

4つの CLI ツールファイルに同一の getErrorMessage() が定義されており、copilot.ts で5つ目になる。既知の技術的負債 (D1-002) であり、本 Issue のスコープ外とする判断は妥当。

---

### DR1-007 [nice_to_have] response-poller.ts の変更対象が包括的すぎる

- **原則**: You Aren't Gonna Need It (YAGNI)
- **対象セクション**: 10. ファイル変更一覧

全ディスパッチポイントを列挙しているが、前提調査未完了の段階で '変更対象' と '確認対象' を区別すべき。

---

### DR1-008 [nice_to_have] ワンショット実行モデルのシェル引数エスケープの責務境界

- **原則**: Single Responsibility Principle (SRP)
- **対象セクション**: 6. セキュリティ設計

sendKeys() の tmux エスケープとシェルコマンド文字列としてのエスケープは異なるセキュリティ境界であることをセキュリティ設計セクションに明記すべき。

---

### DR1-010 [nice_to_have] sendMessage() の共通パターンが6つのツールに重複

- **原則**: Don't Repeat Yourself (DRY)
- **対象セクション**: 3-1. Strategyパターン（既存拡張）

既知の技術的負債 (D1-004 Template Method パターン候補)。copilot 追加で6つ目の重複だが、本 Issue のスコープ外とする判断は妥当。

## 総括

設計方針書は既存アーキテクチャの Strategy パターンに忠実に従っており、新規レイヤーの不要な追加を避けている点で KISS 原則に合致する。唯一の must_fix は isInstalled() のオーバーライドを実装タスクの必須項目として明確化する点であり、設計方針書のセクション 3-3 に記載はあるが Phase 2 タスクリストでの優先度が不明確である。should_fix の5件はいずれもコードの保守性に関わるものであり、copilot 実装の品質を高めるために対応を推奨する。nice_to_have の4件は既知の技術的負債に関するもので、別 Issue での対応が適切である。
