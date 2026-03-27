# Issue #559 仮説検証レポート

## 検証日時
- 2026-03-27

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | Terminal APIの`sendKeys`はCopilotの状態を確認せず即座に送信する | Confirmed | terminal/route.tsはprompt確認なしにsendKeys呼出 |
| 2 | Copilotがプロンプト状態でない場合、スラッシュコマンドとして認識されない | Partially Confirmed | sendMessage経路はprompt待機するが、terminal API経由では状態無視 |

## 詳細検証

### 仮説 1: Terminal APIのsendKeysはCopilotの状態を確認せず即座に送信する

**Issue内の記述**: 「Terminal APIの`sendKeys`はCopilotの状態を確認せず即座に送信する」

**検証手順**:
1. `src/app/api/worktrees/[id]/terminal/route.ts` を確認
2. `src/lib/cli-tools/copilot.ts` の `sendMessage()` と比較
3. `src/lib/session-key-sender.ts` の `sendMessageToSession()` と比較

**判定**: Confirmed

**根拠**:
- `terminal/route.ts:81-82`: `await sendKeys(sessionName, command)` でプロンプト状態確認なしに即座送信
- 対照的に `copilot.ts:254`: `await this.waitForPrompt(sessionName)` でプロンプト待機後に送信
- `session-key-sender.ts:136-140`: `CLAUDE_PROMPT_PATTERN.test()` でプロンプト状態確認後に送信

**Issueへの影響**: 記載内容は正確

---

### 仮説 2: Copilotがプロンプト状態でない場合、スラッシュコマンドとして認識されない

**Issue内の記述**: 「Copilotがプロンプト状態でない場合、スラッシュコマンドとして認識されない」

**検証手順**:
1. `src/lib/cli-tools/copilot.ts` の `sendMessage()` メソッドを確認
2. `src/lib/detection/cli-patterns.ts` のCopilotパターン定義を確認
3. `src/lib/slash-commands.ts` の `getCopilotBuiltinCommands()` を確認

**判定**: Partially Confirmed

**根拠**:
- `copilot.ts:254`: `sendMessage()` はプロンプト待機してからスラッシュコマンドを処理するため、正しい経路（/send API）を使えば問題なし
- `copilot.ts:257-265`: `extractSlashCommand()` でスラッシュコマンド判定後、`SELECTION_LIST_COMMANDS` に基づき特殊処理
- ただし、terminal API経由（`/terminal`ルート）では `CopilotTool.sendMessage()` を経由しないため、プロンプト待機なしに送信される
- Copilot CLI自体の内部状態機械がコマンドを認識するかはCommandMateのコード外の問題

**Issueへの影響**: 仮説は部分的に正確。terminal API経由の場合のみ問題が発生する点を明確化すべき

## コード経路比較

| 操作 | ルート | 関数 | プロンプト確認 |
|------|--------|------|--------------|
| メッセージ送信 | `/api/worktrees/[id]/send` | `CopilotTool.sendMessage()` | YES |
| Terminal sendKeys | `/api/worktrees/[id]/terminal` | route.ts POST | NO |
| プロンプト応答 | `/api/worktrees/[id]/respond` | raw sendKeys | NO |

---

## Stage 1レビューへの申し送り事項

- terminal API経由とsendMessage経由の2つの送信経路があり、問題はterminal API経由のみで発生する点をIssueに明記すべき
- 「根本原因」セクションの記述は概ね正確だが、sendMessage経由では既にプロンプト待機が実装されている点を補足すべき
- 修正対象の特定: terminal APIでCopilotスラッシュコマンドを送信する際にプロンプト待機を追加するか、UIから送信経路をsendMessage経由に変更するかの判断が必要
