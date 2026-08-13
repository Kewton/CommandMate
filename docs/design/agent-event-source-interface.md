# `AgentEventSource` — I/F 仕様とツール追加手順

- Issue: [#1759](https://github.com/Kewton/CommandMate/issues/1759)（Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720) Phase 4-1）
- 実装: `src/lib/hooks/sources/`
- 読者: **Phase 4-2〜4-5（#1760 codex / #1761 copilot / #1762 gemini・antigravity / #1763 opencode）の実装者**
- 前提となる実測: [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md)（#1757）/ [`opencode-server-live-verification.md`](./opencode-server-live-verification.md)（#1758）/ [`agent-hooks-live-verification.md`](./agent-hooks-live-verification.md)（#1721）

---

## 0. 3 行で

- **消費層（`sessionStatus` / `wait` / `capture --prompts` / Auto-Yes）は既にツール非依存**。ツールを足すときに書くのは「イベントを発生させて受け口まで届ける部分」と「裁定を返す部分」だけで、残りは自動で付いてくる。
- その 2 つが `AgentEventSource` に閉じている。**1 ツール = 1 ファイル ＋ レジストリ 1 行**。
- **ドキュメントより fixture が正**。`tests/fixtures/hooks/<tool>/` にある実 payload を入力にテストを書くこと。手で書いた想定 payload は、どのツールも送ってこない。

---

## 1. なぜ抽象が要るのか（実測の要約）

Phase 1-3 の時点で Claude 固有だったのは 9 箇所（Issue 本文の S1〜S9）。それを「Claude 用のコードを 4 回コピーする」で解決できない理由は、**6 ツールが実際に食い違っているから**であり、その食い違いはどれも**無言で壊れる**種類のものである。

| # | 食い違い | 実測 | 抽象上の受け皿 |
|---|---|---|---|
| C1 | イベントの向きが逆 | hooks は「エージェント → CommandMate へ POST」。opencode は「CommandMate → エージェントへ SSE を張る」 | `transport: 'push' \| 'pull'` ＋ `subscribe()` / `Subscription.close()` |
| C2 | 裁定の返し方が違う | hooks は受け取った HTTP のレスポンスボディ。opencode は**別の REST 呼び出し** | `encodeVerdict()` が返す `VerdictEncoding`（`responseBody` / `outOfBand`）＋ `decide()` |
| C3 | **fail 方向がソースごとに逆** | Claude / codex / copilot は無応答＝通常フロー（fail-open）。**antigravity は空応答 `{}` を「拒否」と解釈しツールを全停止**（timeout は逆に fail-open）。**opencode はタイムアウト無しで無限待ち**（10分19秒放置を実測） | `noDecision: NoDecisionBehavior` ＋ `describeAbstain()` |
| C4 | 7 語への写像が 1:1 でない | opencode の `message.part.updated` は `part.state.status` で `pre_tool_use` / `post_tool_use` に割れる。`user_prompt_submit` は専用イベント無し。`notification` は 3 イベントの束 | `EventMapper`（**述語つき**。名前表では書けない） |
| C5 | 相関キーが違う | `session_id`(Claude/codex/copilot/gemini) / `conversationId`(antigravity) / `sessionID`(opencode)。tool 相関は `tool_use_id` / `callID` | `NormalizedAgentEvent.conversationId` / `.toolCallId`（**どちらも永続キーにしない**） |
| C6 | 接続の生存という概念が opencode にだけある | `server.heartbeat` 10 秒周期、断は `ECONNREFUSED` | `liveness()` → `SourceLiveness`（push は常に `unknown`） |
| C7 | 取りこぼしの回収手段が違う | hooks は失われる。opencode は `GET /permission` / `/question` / `/session/status` で引き直せる | `listPending()` / `probeActivity()` |
| C8 | 未知イベントを捨ててはいけない | opencode の `server.heartbeat` は**サーバ自身の `/doc` に型が無い**のに 10 秒ごとに来る。89 種は今後も増える | 未知は `null` を返して**数える**（`getUnknownEventTally()`）。**throw しない** |
| R7 | **`type:"http"` は Claude 専用** | codex / copilot / gemini / antigravity すべて不可。codex は http を 1 つ書くと **hooks.json 全体が捨てられて全イベントが死ぬ**（警告は stderr 1 行、TUI には出ない） | 設定生成器は http を出力しない。**`scripts/hooks/cmate-agent-event.sh`（`type:"command"`）が唯一の配送路** |

---

## 2. モジュール構成

```
src/lib/hooks/sources/
├── types.ts                    # I/F と型（ツール名を 1 つも含まない）
├── event-mapper.ts             # 述語つきマッパ、未知イベント計数、payload 読み出しヘルパ
├── hook-event-vocabulary.ts    # Claude/codex/copilot が共有する CamelCase 綴り表と subtype 抽出
├── define-source.ts            # definePushHookSource / definePullEventSource
├── pending-decisions.ts        # 裁定スロットと answerPendingDecision（C2 の実体）
├── abstain.ts                  # describeAbstain / isAbstainSafe（C3 の実体）
├── registry.ts                 # CLIToolType → 実装。globalThis 経由
├── legacy-relay.ts             # 未対応ツール用の互換ソース
├── claude/
│   ├── tool-id.ts              # CLAUDE_CLI_TOOL_ID
│   └── source.ts               # 第一実装
└── index.ts                    # 公開バレル
```

関連:

- `src/lib/hooks/agent-event-types.ts` — **7 語だけ**。ツールの綴りは置かない（#1759 で移設した）
- `src/lib/session/agent-session-lifecycle.ts` — `beginAgentSession()`（S8 の世代フェンス）/ `prepareAgentLaunch()`
- `src/lib/hooks/hook-settings-generator.ts` — **Claude の**設定シリアライザ（S3/S4/S5）。他ツールは自分のを持つ

---

## 3. I/F

```ts
export interface AgentEventSource {
  readonly cliToolId: CLIToolType;
  readonly transport: AgentEventTransport;      // C1
  readonly noDecision: NoDecisionBehavior;      // C3
  readonly capabilities: AgentSourceCapabilities;

  normalizeEvent(raw: RawAgentEvent): NormalizedAgentEvent | null;          // S1/S2/C4/C8
  parsePermissionRequest(payload): PermissionRequestPayload | null;          // S7
  parseQuestion(payload): AskUserQuestionSpec | null;                        // S7
  encodeVerdict(verdict: Verdict): VerdictEncoding;                          // S6/C2
  prepareLaunch(target, executablePath): AgentLaunchPlan;                    // S3/S4/S5

  subscribe(target, onEvent): Promise<Subscription>;                         // C1
  decide(target, decision, verdict): Promise<void>;                          // C2
  listPending(target): Promise<PendingDecision[]>;                           // C7
  probeActivity(target): Promise<'busy' | 'idle' | null>;                    // C7
  liveness(target): SourceLiveness;                                          // C6
}
```

### 3.1 押さえておくべき 5 点

1. **`noDecision` に既定値は無い。** 「判断できないときは黙る」が安全なのは Claude / codex / copilot だけで、antigravity では**逆に働き**、opencode では**セッションが止まる**。`describeAbstain(source).safe === false` のとき、呼び出し側は**見送りを利用者に見せる責務を負う**（`permission-request` route はこれを warn ログにしている）。
2. **マッパは配列で、先勝ち。** `whenNamed()` は 1:1 用の糖衣にすぎない。条件が要るなら素の関数を書く。`fromNameTable()` は表全体を規則列に展開する。
3. **`normalizeEvent` は throw してはいけない。** 未知は `null` ＋ `recordUnknownEvent()`。
4. **`RawAgentEvent.event` は「呼び出し側が既に語を知っている」経路。** 中継スクリプトの `--event` がここに入る。**antigravity はこれしか無い**（payload にイベント名が無い）。
5. **`decide()` を呼ぶのはレシーバであって、レシーバは transport を知らない。** `answerPendingDecision(source, ref, decision, verdict)` を使うこと。push なら body が返り、pull なら `{}` が返る。

### 3.2 `capabilities` は約束である

`supportedEvents` に無い語を待つ処理は**永久に待つ**。実測（#1757 §8.1）:

| 語 | Claude | codex | copilot | gemini | antigravity | opencode |
|---|---|---|---|---|---|---|
| `session_start` | ✅ | ✅※1 | ✅※2 | ✅ | ✅（未文書化） | ✅ |
| `session_end` | ✅ | ✅※3 | ✅ | ✅ | **無し** | △※4 |
| `user_prompt_submit` | ✅ | ✅ | ✅※2 | `BeforeAgent` | **無し** | 複合 |
| `stop` | ✅ | ✅ | ✅ | `AfterAgent` | ✅※5 | `session.idle` |
| `notification` | ✅ | **無し** | ✅ | ✅ | **無し** | 3 イベントの束 |
| `pre_tool_use` / `post_tool_use` | ✅ | ✅ | ✅ | `BeforeTool`/`AfterTool` | ✅ | `message.part.updated` の状態違い |

※1 codex の `SessionStart` は**最初のターン開始時**（プロセス起動時ではない）。起動完了 signal に使うと永久に待つ。
※2 copilot は `UserPromptSubmit` → `SessionStart` の順。**イベント順序に依存した状態機械を書かない**。
※3 codex の `SessionEnd` は `/quit` では出るが強制終了では出ない。
※4 opencode の `session.deleted` は `DELETE /session/:id` を明示的に呼んだときだけ。TUI の `/exit` では 1 件も出ない。
※5 antigravity の `Stop` は「停止しようとしている」通知で、`{"decision":"continue"}` を返すと**停止を阻止できる**（純粋な観測イベントではない）。

**4 ツール（＋Claude）で揃うのは `session_start` / `stop` / `pre_tool_use` / `post_tool_use` の 4 語だけ。**
そして **`session_end` は来ないソースがある**ので、**プロセス終了検知は tmux 側に残す**（全ツール共通）。

---

## 4. ツールを 1 つ足す手順

> 見積りの目安: push 型（codex / copilot / gemini / antigravity）は**ファイル 1 本 ＋ レジストリ 1 行 ＋ テスト 1 本**。
> pull 型（opencode）は購読の実装があるぶん増えるが、**I/F を変える必要は無い**（`tests/unit/hooks/sources/pull-source-contract.test.ts` が実際に組んで確認している）。

### 手順

1. **fixture を確認する。** `tests/fixtures/hooks/<tool>/README.md` にマッピング表がある。**無いイベントは足さない**（未計測を「たぶん同じ」で埋めない）。
2. **`src/lib/hooks/sources/<tool>/source.ts` を作る。** push なら `definePushHookSource({...})`、pull なら `definePullEventSource({...})`。埋めるのは以下:
   - `cliToolId`
   - `noDecision` — **実測した値**。推測で `proceeds` にしない
   - `capabilities` — `supportedEvents` / `configScope` / `decisionTimeoutSeconds`
   - `mappers` — 1:1 なら `fromNameTable()`、条件つきなら素の関数
   - `nativeEventNameFields` — payload にイベント名が無いなら `[]`
   - `conversationIdFields` / `toolCallIdFields`
   - `extractDetail`
   - `parsePermissionRequest` / `parseQuestion` — 実 payload を確認するまで `() => null` でよい（null＝「構造化データなし」＝この機能が無い機械と同じ挙動）
   - `encodeVerdict` — **`{}` が安全でないツールがある**（antigravity）
   - `prepareLaunch` — 設定ファイルの書き出しと起動コマンド。**throw しないこと**（fail-open）
3. **`registry.ts` の末尾に 1 行足す。** `registerAgentEventSource(<tool>AgentEventSource);`
   （静的 import で登録する。副作用 import はバンドラに落とされうる＝**無言で消える**）
4. **`beginAgentSession()` を `src/lib/cli-tools/<tool>.ts` の `startSession` に足す。**
   生成パスのみ・pane 作成前・起動失敗時も張る。詳細は `src/lib/session/agent-session-lifecycle.ts` の module doc。
5. **中継スクリプトの語彙を確認する。** `scripts/hooks/cmate-agent-event.sh` は 7 語 ＋ 5 ツールの native 名に対応済み。新しい綴りが要るなら `map_event_name` に足す（**bash 3.2 互換＝`declare -A` 不可**、`bash -n` で構文確認）。
6. **hooks 設定を書き出す。** ツールごとに置き場所も構造も違う:

   | ツール | 書き先 | 構造 | 罠 |
   |---|---|---|---|
   | Claude | `--settings <file>`（per-instance） | `{"hooks":{"<Event>":[...]}}` | `SessionStart` だけ http 不可 |
   | codex | `$CODEX_HOME/hooks.json` ＋ `<cwd>/.codex/hooks.json` | 同上 | **trust をユーザーの `~/.codex/config.toml` に書く。** 汚さない道は `--dangerously-bypass-hook-trust` か `CODEX_HOME` 差し替えのみ。未 trust の hooks は**完全に無言で skip される** |
   | copilot | **`~/.copilot/settings.json`** | 同上 | doc の言う `config.json` に書くと**次回起動で消える**。timeout 既定 ≈10s |
   | gemini | `<worktree>/.gemini/settings.json` | 同上 | イベント名もツール名もリマップされる |
   | antigravity | **`~/.gemini/config/hooks.json` グローバル 1 本のみ** | `{"<hook 名>":{"<Event>":[...]}}` の 2 階層 | workspace の `.agents/hooks.json` は**読まれない**（doc は誤り）。worktree 単位で出し分けられない |
   | opencode | **無し**（`opencode serve` に購読を張る） | — | 実ポートは stdout か `lsof` でしか判らない（衝突時 ephemeral に落ちる） |

7. **テストを書く。** `tests/unit/hooks/sources/` に置く。**入力は実 fixture**。最低限:
   - 各 fixture が期待どおりの語と detail に写ること
   - 対応語の無いイベントが `null` になり、**throw しないこと**
   - `noDecision` が実測値であること（`describeAbstain(source).safe` の値まで固定する）
   - `encodeVerdict` が実測した wire 形であること
8. **`docs/module-reference.md` に 1 行足す。**（**CLAUDE.md には書かない** — CI で落ちる）

### 骨組みの実例

`tests/unit/hooks/sources/add-one-tool.test.ts` に **codex 版のソース全文**がある（約 50 行）。そのまま `src/lib/hooks/sources/codex/source.ts` へ移せる形で書いてあり、同ファイル内に copilot / gemini / antigravity の骨組みと、それぞれの分岐理由も並べてある。pull 型は `tests/unit/hooks/sources/pull-source-contract.test.ts` の opencode 版が同じ役割を果たす。

---

## 5. やってはいけないこと

- **`hook-event-vocabulary.ts` の表に新しいツールの綴りを足す。** あれは「Claude / codex / copilot が共有する CamelCase 方言」であって、共通表ではない。gemini や antigravity の綴りを混ぜると、**混ぜた瞬間に全ツールがその綴りを受け入れる**（`Stop` を送る gemini は存在しない、という情報が失われる）。ツールごとに `mappers` を持つこと。
- **`conversationId` を永続キーにする。** Claude は `/clear` で変わる。opencode は安定だが `GET /session` に**他プロセスのセッションが混ざる**。キーは常に (worktree, tool, instance)。
- **`session_end` を「エージェントが終わった」の signal にする。** antigravity は出さず、opencode は `DELETE` のときだけ出し、Claude は `/clear` でも出す。
- **`session_start` を起動完了 signal にする。** codex は最初のターン開始時、copilot は `user_prompt_submit` の**後**。
- **未知のイベントで throw する。** 10 秒ごとに落ちる。
- **裁定できないとき無条件に `{}` を返す。** antigravity では拒否、opencode では無限待ち。
- **モジュールスコープに購読レジストリを持つ。** dev モードで無言に分断される（#1736 の前例）。`globalThis` 経由にすること。

---

## 6. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720)
- 本 Issue: [#1759](https://github.com/Kewton/CommandMate/issues/1759)
- 下流: [#1760](https://github.com/Kewton/CommandMate/issues/1760) codex / [#1761](https://github.com/Kewton/CommandMate/issues/1761) copilot / [#1762](https://github.com/Kewton/CommandMate/issues/1762) gemini・antigravity / [#1763](https://github.com/Kewton/CommandMate/issues/1763) opencode
- 実測: [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md) / [`opencode-server-live-verification.md`](./opencode-server-live-verification.md) / [`agent-hooks-live-verification.md`](./agent-hooks-live-verification.md) / [`agent-hooks-permission-deny-verification.md`](./agent-hooks-permission-deny-verification.md)
- fixture: [`tests/fixtures/hooks/`](../../tests/fixtures/hooks/)
- 運用手順: [`docs/user-guide/agent-event-hooks.md`](../user-guide/agent-event-hooks.md)
