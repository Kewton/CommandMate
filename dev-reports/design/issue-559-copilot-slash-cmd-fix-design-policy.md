# 設計方針書: Issue #559 - Copilot CLIスラッシュコマンド修正

## 1. 概要

### 要件
Copilot CLIのスラッシュコマンド（`/model`等）がTerminal API経由で送信された場合に、Copilotのプロンプト待ち状態でないとテキストメッセージとして処理される問題を修正する。

### スコープ
- Terminal API（`/api/worktrees/:id/terminal`）経由のCopilotコマンド送信時にsendMessage()に委譲
- 既存のsendMessage経路（`/api/worktrees/:id/send`）には影響を与えない

## 2. アーキテクチャ設計

### 現行フロー

```
[UI] MessageInput ──> /api/worktrees/:id/send ──> CopilotTool.sendMessage()
                                                    ├── waitForPrompt() [OK]
                                                    ├── extractSlashCommand()
                                                    └── sendKeys()

[UI] Terminal直接入力 ──> /api/worktrees/:id/terminal ──> sendKeys() (直接)
                                                          └── プロンプト確認なし [NG]
```

### 修正後フロー（アプローチC改: Copilot全コマンド委譲パターン）

```
[UI] Terminal直接入力 ──> /api/worktrees/:id/terminal
                           ├── cliToolId === 'copilot'
                           │    └── cliTool.sendMessage() に全コマンドを委譲（ICLITool経由）
                           │         ├── waitForPrompt() [OK]
                           │         ├── extractSlashCommand() (内部で自動判定)
                           │         └── sendKeys()
                           └── それ以外
                                └── sendKeys() (従来通り)
```

### 選定理由: アプローチC改（全コマンド委譲）

| 観点 | アプローチA (route修正) | アプローチB (UI統一) | アプローチC (スラッシュのみ委譲) | **アプローチC改 (全コマンド委譲)** |
|------|----------------------|---------------------|-------------------------------|--------------------------------|
| 既存コード再利用 | x 新規実装 | o | o sendMessage()再利用 | **o sendMessage()再利用** |
| 二重管理リスク | x スラッシュ判定が2箇所 | o | o CopilotTool内で一元管理 | **o 判定自体不要** |
| 変更範囲 | terminal/route.ts + copilot.ts | UI + API | terminal/route.ts + copilot.ts | **terminal/route.tsのみ** |
| 既存経路への影響 | なし | UI変更あり | なし | **なし** |
| SOLID準拠 | SRP違反リスク | o | o 責務委譲 | **o 責務委譲（単純化）** |
| KISS準拠 | - | - | x 判定分岐が冗長 | **o 分岐がcliToolIdのみ** |

#### アプローチD（ICLIToolにhandleTerminalCommand()追加）の評価

ICLIToolインターフェースに `handleTerminalCommand(worktreeId: string, command: string): Promise<{handled: boolean}>` を追加するStrategy的アプローチも検討した。OCP準拠の観点では優れるが、現時点でCopilotのみの特殊処理であり、YAGNIの観点から不採用とした。2つ目のツール固有分岐が必要になった時点でこのパターンへのリファクタリングを検討する。

### アプローチC改の選定根拠 (DR1-004対応)

元のアプローチCでは「スラッシュコマンドのみsendMessage()に委譲、通常テキストは従来通りsendKeys()」としていたが、以下の理由から全コマンド委譲に変更する:

1. **通常メッセージでもwaitForPromptが必要**: Terminal APIのsendKeys()は直接tmuxにキーを送信するため、Copilotがプロンプト状態でないときにテキストが失われるリスクがある。sendMessage()はwaitForPrompt()を行うため、この問題を回避できる。
2. **sendMessage()は通常メッセージも正しく処理可能**: CopilotTool.sendMessage()内でextractSlashCommand()が自動判定し、スラッシュコマンドでなければ通常のsendKeysパスに進む。detectAndResendIfPastedTextも適用される。
3. **設計の単純化**: isSlashCommand()メソッドの新規追加が不要になり、terminal/route.tsの分岐条件も `cliToolId === 'copilot'` のみとなる（KISS原則）。

## 3. 詳細設計

### 3-1. CopilotTool: 変更なし

`src/lib/cli-tools/copilot.ts` に対する変更は不要。

- `isSlashCommand()` メソッドの新規追加は行わない（YAGNI: DR1-006対応）
- `extractSlashCommand()` はprivateのまま維持
- `sendMessage()` は既に通常メッセージとスラッシュコマンドの両方を正しく処理可能

### 3-2. terminal/route.ts: Copilot全コマンド委譲ロジック追加

`src/app/api/worktrees/[id]/terminal/route.ts` に以下の変更:

```typescript
// ※ CopilotTool の import は不要（ICLITool に sendMessage() が定義済み）
// ※ 既存の cliTool 変数（L69: const cliTool = manager.getTool(cliToolId)）を再利用

// sendKeys呼び出し前に判定ロジック追加（L81付近）
if (cliToolId === 'copilot') {
  // Copilot requires waitForPrompt() before sending any command
  // to avoid text loss when Copilot is not in prompt state.
  // sendMessage() handles both slash commands and regular text correctly.
  await cliTool.sendMessage(params.id, command);
  // Note: invalidateCache is called within sendMessage(), no need to call here
  return NextResponse.json({ success: true });
}

// 既存の sendKeys は else パスとして維持（Copilot以外のツール向け）
// Note: 既存のinvalidateCache()呼び出し（L85付近）はこのelse-path内に残る（IA3-007確認済み）
await sendKeys(sessionName, command);
```

**設計判断**:
- `cliToolId === 'copilot'` で早期分岐（他ツールへの影響ゼロ）
- Copilotの全コマンドをsendMessage()に委譲（通常テキストもwaitForPromptの恩恵を受ける）
- `invalidateCache()` はsendMessage()内で呼ばれるため、委譲パスでの追加呼び出しは行わない（DR1-008対応: sendMessage()内の既存invalidateCacheに依存し、二重呼び出しを回避）
- 型キャスト不要: `ICLITool` インターフェース（types.ts L56）に `sendMessage(worktreeId: string, message: string): Promise<void>` が定義済みであり、`getTool()` の戻り値 `ICLITool` をそのまま使用できる。CopilotTool への import や型キャストは不要（CR2-001/CR2-002/CR2-006対応）
- sendEnter挙動の違い（CR2-005参考情報）: terminal/route.tsの既存sendKeys()はsendEnter=true（デフォルト）でEnterキーが自動送信される。一方、CopilotTool.sendMessage()内ではsendEnterを明示的に制御している（通常テキスト: true、スラッシュコマンド選択後: false）。sendMessage()に委譲する設計のため、terminal/route.ts側でsendEnterの制御は不要

### 3-3. SRP違反リスクの管理方針 (DR1-001対応)

terminal/route.tsにCopilot固有の分岐ロジック（`cliToolId === 'copilot'`）が追加されるため、SRP違反のリスクがある。ただし:

- 現時点ではCopilotのみの特殊処理であり、分岐は1箇所のみ
- 2つ目のツール固有分岐が必要になった時点で、ICLIToolインターフェースにhandleTerminalCommand()を追加するリファクタリングを実施する
- このトレードオフはセクション8に記録する

### 3-4. waitForPromptの挙動

**方針: 既存の挙動を変更しない**

現行の `waitForPrompt()` はタイムアウト後にエラーをthrowせずログ出力のみで処理を継続する。この挙動を変更すると既存のsendMessage経路にも影響するため、変更しない。

- タイムアウト後は従来通りコマンド送信を試行（best-effort）
- terminal/route.ts側での追加タイムアウト処理は不要（sendMessage内で完結）

### 3-5. エラーハンドリング

`sendMessage()` がthrowした場合、terminal/route.tsの既存catchブロックで捕捉される:

```typescript
} catch (error) {
  logger.error('terminal-api-error:', { ... });
  return NextResponse.json(
    { error: 'Failed to send command to terminal' },
    { status: 500 }
  );
}
```

追加のエラーハンドリングは不要。

## 4. 影響範囲

### 変更ファイル

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/app/api/worktrees/[id]/terminal/route.ts` | Copilot全コマンド委譲ロジック | 中: 分岐追加 |

### テストファイル

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/terminal-route.test.ts` | Copilotコマンド委譲テスト追加 |

### 影響なし（確認済み）

- `src/lib/cli-tools/copilot.ts`: 変更不要（sendMessage()は既に対応済み）
- `src/lib/session-key-sender.ts`: Claude用のsendMessage経路、Copilotには無関係
- `src/app/api/worktrees/[id]/special-keys/route.ts`: 特殊キー送信、テキスト入力ではない
- `src/lib/detection/cli-patterns.ts`: パターン定義のみ、変更不要
- 他CLIツール（claude, codex, gemini, vibe-local, opencode）: `cliToolId === 'copilot'` 分岐により影響ゼロ

### Terminal APIの呼び出し元の明確化（IA3-003対応）

Terminal HTTP API（`/api/worktrees/:id/terminal`）の呼び出し元について:
- **フロントエンドのTerminalコンポーネント**: xterm.jsのキーボード入力はWebSocket経由（`ws-server.ts` の `handleTerminalInput`）で処理される。Terminal HTTP APIルートは使用されない。
- **MessageInputコンポーネント**: `/api/worktrees/:id/send` ルート経由で送信される。Terminal HTTP APIは使用されない。
- **NavigationButtonsコンポーネント**: `/api/worktrees/:id/special-keys` ルート経由。Terminal HTTP APIは使用されない。
- **主な呼び出し元**: CLIコマンド（`commandmate send`）やその他外部クライアントがTerminal HTTP APIを使用する。

この修正は主にCLI/外部クライアントからのCopilotコマンド送信を正しく処理するためのものである。WebSocket経由のターミナル直接入力は別のコードパスであり、本修正の対象外である（IA3-006参照）。

### 既知の制限事項（IA3-002, IA3-004, IA3-006対応）

1. **respond/route.tsの同様のリスク（IA3-002）**: `src/app/api/worktrees/[id]/respond/route.ts` もCopilotプロンプトへの応答時に `sendKeys()` を直接使用しており、`waitForPrompt()` を経由しない。ただし、respondルートはCopilotがプロンプト状態にある時にのみ使用される（ユーザーがプロンプトに回答するシナリオ）ため、テキスト消失リスクは低い。将来的にrespondルートでも同様の問題が報告された場合は、sendMessage委譲パターンの適用を検討する。

2. **セッション存在チェックの二重実行（IA3-004）**: terminal/route.tsのL73-79で `hasSession()` チェック後、`cliTool.sendMessage()` 内部（copilot.ts L245-249）でも再度 `hasSession()` チェックが行われる。2つのチェック間でセッションが終了した場合、404ではなく500エラーが返される。実運用上の影響は極めて小さいため、現時点では対応不要とする。

3. **WebSocketターミナル入力パスは本修正の対象外（IA3-006）**: xterm.jsターミナルウィジェットからの直接キーボード入力はWebSocket（`ws-server.ts` の `handleTerminalInput` -> `ControlModeTmuxTransport.sendInput()`）経由で処理される。このパスは文字単位のraw terminal I/Oであり、本修正（Terminal HTTP APIルート）とは完全に別のコードパスである。ユーザーがターミナルウィジェットでスラッシュコマンドを直接入力する場合は、Copilotが既にプロンプト状態であるため（ターミナル内で対話的に入力しているため）、テキスト消失の問題は発生しない。

## 5. テスト戦略

### 単体テスト

#### 前提条件: 既存モックの修正（CR2-003, IA3-001対応）

既存の `tests/unit/terminal-route.test.ts` L12 の `isCliToolType` モックは `['claude', 'codex', 'gemini', 'vibe-local', 'opencode']` のみを許可しており、`'copilot'` が含まれていない。Copilot関連テストを追加する前に、このモックに `'copilot'` を追加する必要がある。修正しないと `cliToolId='copilot'` が 400 エラーとなり、全てのCopilot委譲テストが失敗する。

```typescript
// tests/unit/terminal-route.test.ts L12付近
// Before: ['claude', 'codex', 'gemini', 'vibe-local', 'opencode']
// After:  ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot']
```

#### 前提条件: CLIToolManager.getTool()モックにsendMessageを追加（IA3-001対応）

既存の `tests/unit/terminal-route.test.ts` L17-20 の `CLIToolManager.getTool()` モックは `getSessionName()` のみを返すオブジェクトを使用している。Copilot委譲パスでは `cliTool.sendMessage()` が呼ばれるため、モックにも `sendMessage: vi.fn()` を含める必要がある。修正しないと `cliTool.sendMessage is not a function` エラーとなる。

```typescript
// tests/unit/terminal-route.test.ts L17-20付近
// Before: getTool: vi.fn(() => ({ getSessionName: vi.fn(() => 'session-name') }))
// After:  getTool: vi.fn(() => ({
//           getSessionName: vi.fn(() => 'session-name'),
//           sendMessage: vi.fn(),
//         }))
```

#### terminal/route.ts Copilot委譲

```
- cliToolId='copilot', command='/model' → cliTool.sendMessage()に委譲（ICLITool経由）
- cliToolId='copilot', command='hello' → cliTool.sendMessage()に委譲（通常テキストも委譲、ICLITool経由）
- cliToolId='copilot', command=' /model' → cliTool.sendMessage()に委譲（先頭空白含む、ICLITool経由）
- cliToolId='claude', command='/model' → 通常のsendKeys（Copilot以外は影響なし）
- cliToolId='codex', command='hello' → 通常のsendKeys（Copilot以外は影響なし）
- cliToolId='copilot', cliTool.sendMessage()がthrow → 既存catchブロックで500エラー返却
```

### 既存テストへの影響

- 既存のterminal/route.tsテスト: copilot以外の通常パスは変更なし -> 既存テストはそのままパス
- 既存のcopilot.test.ts: sendMessage()テストは変更なし -> 既存テストはそのままパス

## 6. パフォーマンス考慮事項

- Copilotの全コマンド送信時にwaitForPrompt()による最大15秒のブロッキングが発生する可能性がある
  - ただし、Copilotがプロンプト状態であれば即座に返る（通常ケース）
  - 従来のsendKeys()直接送信ではwaitForPromptがなく高速だったが、テキスト消失リスクがあった
  - 信頼性とのトレードオフとして許容する
- 他ツールには影響なし
- ユーザー体感への影響（IA3-005）: Copilotが処理中（プロンプト状態でない）の場合、waitForPrompt()のタイムアウトまで最大15秒の遅延が発生する可能性がある。従来はsendKeys()で即座に送信されていたが、テキスト消失していた。信頼性向上とのトレードオフとして許容する
- フロントエンドのHTTPタイムアウト: フロントエンドapi-client.tsはネイティブfetchを使用しAbortControllerは未設定のため、ブラウザデフォルト（通常300秒）が適用される。15秒のwaitForPromptタイムアウトは問題にならない（IA3-005確認済み）

## 7. セキュリティ考慮事項

- terminal/route.tsの既存セキュリティ（MAX_COMMAND_LENGTH, isCliToolType, DB存在確認等）はそのまま適用
- `sendMessage()` への委譲パスでも同じセッション名・ワークツリー検証が行われる
- 新規のpublicメソッド追加はないため、攻撃面の増加なし

### 7-1. コマンドインジェクション対策（SEC4-001, SEC4-002確認済み）

- tmux.tsの`sendKeys()`は`execFile()`を使用しシェルを介さないため、シェルインジェクションのリスクはない
- セッション名は`validateSessionName()`で英数字・ハイフン・アンダースコアのみに制限されている
- `MAX_COMMAND_LENGTH`（10000文字）の検証は`sendMessage()`委譲の前に実行されるため、委譲によるバリデーションバイパスは発生しない
- 将来のリファクタリングで`execFile`が`exec`に変更されないよう注意が必要（コメントやlintルールで保護を検討）

### 7-2. 認証・認可（SEC4-003, SEC4-007確認済み）

- Terminal APIルートはNext.jsミドルウェアでCookie/Bearer認証が適用される。`sendMessage()`への委譲はルートハンドラ内部の処理変更であり、認証バイパスは発生しない
- 委譲前に以下の全セキュリティチェックが実行される: (1) isCliToolType()によるcliToolIdバリデーション、(2) commandパラメータの型・存在チェック、(3) MAX_COMMAND_LENGTH制限、(4) DB worktree存在確認、(5) セッション存在確認

### 7-3. 情報露出対策（SEC4-004確認済み）

- `sendMessage()`がthrowするエラーメッセージにはセッション名が含まれる可能性があるが、クライアントには固定文字列（`'Failed to send command to terminal'`）のみが返される（D1-007パターン）
- サーバーログへのセッション名記録は運用上有用な情報であり問題なし

### 7-4. waitForPromptブロッキングによるDoSリスク（SEC4-005）

- `sendMessage()`への委譲により、全てのCopilotコマンドで`waitForPrompt()`が最大15秒ブロックする
- 認証済みユーザーが短時間に多数のリクエストを送信した場合、サーバーのリクエスト処理スレッドが枯渇する可能性がある
- **緩和要因**: 認証が必要なため外部攻撃のリスクは低い。Next.jsのasync実行モデルにより、I/O待機中は他のリクエストを処理可能
- **将来課題**: 同一worktreeIdに対するCopilot `sendMessage()`の同時実行を1つに制限する排他制御の導入を検討する。ただし既存の`sendMessage`経路（`/api/worktrees/:id/send`）にも同様のリスクが存在するため、本Issueのスコープ外としバックログに記録する（REC-002）

### 7-5. レースコンディション（SEC4-006, IA3-004関連）

- terminal/route.tsの`hasSession()`チェック後、`cliTool.sendMessage()`内部で再度`hasSession()`チェックが行われる（TOCTOU）
- 2つのチェック間でセッションが終了した場合、500エラーが返されるが、セキュリティ上の影響はない
- セッション終了はユーザーの明示的操作によるものであり、ミリ秒単位のチェック間で発生する確率は極めて低い
- 既にIA3-004で認識済み。現時点では対応不要

### 7-6. ログインジェクション（SEC4-008確認済み）

- `extractSlashCommand()`の正規表現`/^\/(\S+)/`により空白を含まない文字列に限定されるため、ログインジェクション（改行やANSIエスケープ）のリスクは低い
- structuredログ（createLogger）使用によりリスクは更に低減されている

## 8. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| アプローチC改（全コマンド委譲パターン）採用 | KISS原則: 分岐条件が単純、通常テキストもwaitForPromptの恩恵を受ける | Copilotの通常テキスト送信でwaitForPrompt()のオーバーヘッドが追加される |
| waitForPrompt挙動は変更しない | sendMessage経路への波及防止 | タイムアウト後もbest-effortで送信される |
| isSlashCommand()メソッドは追加しない | YAGNI: 全コマンド委譲により不要（DR1-006） | - |
| copilot.tsは変更しない | sendMessage()が既に必要な機能を全て持つ | ICLIToolにsendMessage()が定義済みのため型キャスト不要 |
| cli-patterns.tsは変更しない | スラッシュコマンド判定はsendMessage()内で完結 | - |
| 委譲パスでinvalidateCacheを呼ばない | sendMessage()内で既にinvalidateCacheが呼ばれるため二重呼び出し不要（DR1-008） | sendMessage()の内部実装に依存する |

### OCP違反リスクの認識 (DR1-002)

terminal/route.tsに新たなツール固有処理が必要になった場合、route.tsの直接修正が必要になる。OCPの観点では拡張に対してオープンであることが望ましいが、現時点ではCopilotのみの特殊処理であり、YAGNIの観点から過度な抽象化は行わない。2つ目のツール固有分岐が必要になった時点で、ICLIToolインターフェースへのhandleTerminalCommand()追加によるリファクタリングを実施する。

### 将来の拡張パス (DR1-005, CR2-001/CR2-004対応)

ICLIToolインターフェース（types.ts L56）に既に `sendMessage(worktreeId: string, message: string): Promise<void>` が定義されているため、型キャストは不要であり、LSP非対称性の懸念は解消された。`getTool()` の戻り値である `ICLITool` をそのまま使用して `cliTool.sendMessage()` を呼べる。

将来、他ツールでもterminal route経由のsendMessage委譲が必要になった場合、型キャストなしで同じパターンを適用可能である。ただし、2つ以上のツールで異なるterminalコマンド処理が必要になった場合は、以下の移行パスを検討する:
1. ICLIToolインターフェースに `handleTerminalCommand?(worktreeId: string, command: string): Promise<void>` をオプショナルメソッドとして追加
2. 各ツールが必要に応じて実装（Copilotのみ実装、他はundefined）
3. terminal/route.tsでは `cliTool.handleTerminalCommand?.()` で呼び出し

なお、`handleTerminalCommand()` は `sendMessage()` と責務が重複する可能性がある点に注意。ICLIToolに既にsendMessage()が存在するため、handleTerminalCommand()の導入前にsendMessage()の活用で十分かを評価すべきである。

## 9. レビュー指摘事項サマリー

### Stage 1: 通常レビュー（設計原則）

| ID | 重要度 | カテゴリ | 指摘内容 | 対応 |
|----|--------|---------|---------|------|
| DR1-001 | should_fix | SRP | terminal/route.tsにCopilot固有分岐が入るSRP違反リスク | セクション3-3に管理方針を記載。2つ目の分岐発生時にリファクタリング |
| DR1-002 | nice_to_have | OCP | ツール固有処理の拡張にroute.ts修正が必要 | セクション8にOCPリスクと将来方針を明記 |
| DR1-003 | should_fix | DRY | isSlashCommand()とextractSlashCommand()の二重パース | 全コマンド委譲に変更しisSlashCommand()自体を廃止。解消済み |
| DR1-004 | must_fix | KISS | スラッシュコマンドのみ委譲する根拠が不十分 | 全コマンド委譲に設計変更。セクション2に根拠を明記 |
| DR1-005 | nice_to_have | LSP | CopilotTool固有メソッドによるICLIToolとの非対称性 | セクション8に将来の拡張パスを記載 |
| DR1-006 | should_fix | YAGNI | isSlashCommand()の追加は不要の可能性 | 全コマンド委譲により不要に。copilot.tsの変更自体を廃止 |
| DR1-007 | nice_to_have | 設計パターン | 代替案の評価が一部不足 | セクション2にアプローチDの評価とC改の根拠を追加 |
| DR1-008 | should_fix | エラーハンドリング | invalidateCache二重呼び出し防止の記述が不正確 | セクション3-2で委譲パスからinvalidateCache呼び出しを削除。sendMessage()内の既存呼び出しに依存する方針を明記 |

### Stage 2: 整合性レビュー（コードベースとの整合性）

| ID | 重要度 | カテゴリ | 指摘内容 | 対応 |
|----|--------|---------|---------|------|
| CR2-001 | should_fix | 型整合性 | CopilotToolへの型キャストは不要。ICLIToolにsendMessage()が既に存在 | セクション3-2のコード例を修正。型キャストとCopilotTool importを削除し、既存cliTool変数を使用 |
| CR2-002 | should_fix | コード例の正確性 | CopilotTool importの指示が不要 | CR2-001と統合対応。import指示を削除 |
| CR2-003 | must_fix | テスト整合性 | 既存テストのisCliToolTypeモックにcopilotが含まれていない | セクション5にモック修正の前提条件を追記 |
| CR2-004 | should_fix | コード例の正確性 | ICLIToolの全ツールがsendMessage()を持つ点が未考慮 | セクション8の将来の拡張パスにICLITool.sendMessage()活用可能性を明記 |
| CR2-005 | nice_to_have | 設計書の正確性 | sendEnterパラメータの挙動差異が未記載 | セクション3-2の設計判断に参考情報として追記 |
| CR2-006 | nice_to_have | 設計書の正確性 | getTool()の再呼び出しが不要。既存cliTool変数を再利用すべき | CR2-001と統合対応。cliTool変数を再利用する形に修正 |

### Stage 3: 影響分析レビュー

| ID | 重要度 | カテゴリ | 指摘内容 | 対応 |
|----|--------|---------|---------|------|
| IA3-001 | must_fix | テスト整合性 | CLIToolManager.getTool()モックにsendMessageが未定義 | セクション5にgetToolモックへのsendMessage追加を前提条件として追記 |
| IA3-002 | should_fix | 影響範囲の網羅性 | respond/route.tsも同様のsendKeys直接送信パターンを持つ | セクション4の既知の制限事項に記載。プロンプト状態での使用のためリスク低 |
| IA3-003 | nice_to_have | 影響範囲の正確性 | Terminal HTTP APIの実際の呼び出し元が不明確 | セクション4にTerminal APIの呼び出し元を明確化するセクション追加 |
| IA3-004 | should_fix | セッション存在チェック重複 | hasSession()が二重チェックされる | セクション4の既知の制限事項に記載。実影響は極小 |
| IA3-005 | nice_to_have | パフォーマンス影響 | waitForPrompt 15秒がユーザー体感に影響する可能性 | セクション6に体感遅延とフロントエンドタイムアウト確認結果を追記 |
| IA3-006 | nice_to_have | 影響範囲の正確性 | WebSocket terminal_inputパスは本修正の対象外 | セクション4の既知の制限事項に記載。ターミナル直接入力は別パスで問題なし |
| IA3-007 | should_fix | 影響範囲の網羅性 | invalidateCacheがelse-pathに残ることの確認 | セクション3-2のコード例にコメント追記。設計書は既に正しく記載済み |

### Stage 4: セキュリティレビュー（OWASP Top 10）

| ID | 重要度 | カテゴリ | 指摘内容 | 対応 |
|----|--------|---------|---------|------|
| SEC4-001 | nice_to_have | コマンドインジェクション (A03) | execFile使用によりシェルインジェクションリスクなし | セクション7-1に確認結果を記載 |
| SEC4-002 | nice_to_have | 入力バリデーション (A03) | MAX_COMMAND_LENGTH検証が委譲前に適用される | セクション7-1に確認結果を記載 |
| SEC4-003 | nice_to_have | 認証・認可 (A01) | 委譲パスの認証はミドルウェアで担保 | セクション7-2に確認結果を記載 |
| SEC4-004 | nice_to_have | 情報露出 (A01) | エラーメッセージのセッション名はクライアントに露出しない | セクション7-3に確認結果を記載 |
| SEC4-005 | should_fix | DoS (A05) | waitForPromptブロッキングによるDoSリスク | セクション7-4にDoSリスクと緩和要因・将来課題を追記 |
| SEC4-006 | should_fix | レースコンディション (A04) | hasSession二重チェックのTOCTOUリスク | セクション7-5にIA3-004との関連含め記載。現時点対応不要 |
| SEC4-007 | nice_to_have | セキュリティチェックバイパス (A01) | 委譲パスで既存チェックはバイパスされない | セクション7-2に確認結果を記載 |
| SEC4-008 | nice_to_have | ログインジェクション (A09) | スラッシュコマンド名のログ記録はリスク低 | セクション7-6に確認結果を記載 |

## 10. 実装チェックリスト

- [ ] terminal/route.tsにCopilot全コマンド委譲ロジックを追加（セクション3-2のコード例に従う）
- [ ] CopilotTool importや型キャストを使用しないこと（既存cliTool変数のICLITool.sendMessage()を使用）
- [ ] 委譲パスでinvalidateCacheを呼ばないことを確認
- [ ] terminal-route.test.tsの既存isCliToolTypeモックにcopilotを追加（CR2-003）
- [ ] terminal-route.test.tsのCLIToolManager.getTool()モックにsendMessage: vi.fn()を追加（IA3-001）
- [ ] terminal-route.test.tsにCopilot委譲テストを追加（セクション5のテストケース）
- [ ] copilot.tsに変更がないことを確認（isSlashCommand()は追加しない）
- [ ] 既存テストが全てパスすることを確認
- [ ] `npm run lint` パス確認
- [ ] `npx tsc --noEmit` パス確認
- [ ] フロントエンドHTTPタイムアウトが15秒以上であることを確認
- [ ] tmux.tsがexecFile（シェル非経由）を使用していることを確認（SEC4-001）
- [ ] 委譲パスでクライアントに固定文字列エラーのみ返却されることを確認（SEC4-004）

## 11. CLAUDE.md更新方針

- `terminal/route.ts` エントリ: Copilot全コマンド委譲ロジックの存在を追記
- `copilot.ts` エントリ: 変更なし（新規publicメソッド追加は行わないため）

---

*作成日: 2026-03-27*
*更新日: 2026-03-27 (Stage 4セキュリティレビュー指摘反映)*
*対象Issue: #559*
