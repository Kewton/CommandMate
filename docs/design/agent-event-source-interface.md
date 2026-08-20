# `AgentEventSource` — I/F 仕様とツール追加手順

- Issue: [#1759](https://github.com/Kewton/CommandMate/issues/1759)（Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720) Phase 4-1）／I/F 裁定: [#1846](https://github.com/Kewton/CommandMate/issues/1846)（§3.3）
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
├── launch-command.ts           # renderAgentLaunchCommand（env を適用する唯一の場所、#1846）
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
- `src/lib/session/agent-session-lifecycle.ts` — `beginAgentSession()`（S8 の世代フェンス）/ `prepareAgentLaunch()` / `buildAgentLaunchCommandLine()`
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
  prepareLaunch(context: AgentLaunchContext): AgentLaunchPlan;               // S3/S4/S5

  subscribe(target, onEvent): Promise<Subscription>;                         // C1
  decide(target, decision, verdict): Promise<void>;                          // C2
  listPending(target): Promise<PendingDecision[]>;                           // C7
  probeActivity(target): Promise<'busy' | 'idle' | null>;                    // C7
  liveness(target): SourceLiveness;                                          // C6
}

// #1846。起動側の入力と出力は「キー」ではなく「文脈」と「計画」。
export interface AgentLaunchContext {
  target: AgentInstanceRef;   // キー。3 フィールドのまま
  executablePath: string;
  worktreePath: string;       // 必須。per-worktree 設定を書けるようにするため
}

export interface AgentLaunchPlan {
  command: string;              // `NAME=value ` 前置は入れない
  settingsPath: string | null;
  env: Record<string, string>;  // 相関キーはここ。適用は renderAgentLaunchCommand 1 箇所
}
```

### 3.1 押さえておくべき 5 点

1. **`noDecision` に既定値は無い。** 「判断できないときは黙る」が安全なのは Claude / codex / copilot だけで、antigravity では**逆に働き**、opencode では**セッションが止まる**。`describeAbstain(source).safe === false` のとき、呼び出し側は**見送りを利用者に見せる責務を負う**（`permission-request` route はこれを warn ログにしている）。
2. **マッパは配列で、先勝ち。** `whenNamed()` は 1:1 用の糖衣にすぎない。条件が要るなら素の関数を書く。`fromNameTable()` は表全体を規則列に展開する。
3. **`normalizeEvent` は throw してはいけない。** 未知は `null` ＋ `recordUnknownEvent()`。
4. **`RawAgentEvent.event` は「呼び出し側が既に語を知っている」経路。** 中継スクリプトの `--event` がここに入る。**antigravity はこれしか無い**（payload にイベント名が無い）。
5. **`decide()` を呼ぶのはレシーバであって、レシーバは transport を知らない。** `answerPendingDecision(source, ref, decision, verdict)` を使うこと。push なら body が返り、pull なら `{}` が返る。

### 3.1.1 起動は 2 段（#1846）

```ts
// cli-tools/<tool>.ts の startSession から
const launchCommand = buildAgentLaunchCommandLine({
  target: { worktreeId, cliToolId, instanceId },
  executablePath: this.command,
  worktreePath,
});
await sendKeys(sessionName, launchCommand, true);
```

- `prepareLaunch` は**設定ファイルを書き**、`{ command, settingsPath, env }` を返す
- `renderAgentLaunchCommand`（`buildAgentLaunchCommandLine` の中身）が `env` を**1 箇所だけで**シェル代入へ展開する
- **`command` に `NAME=value ` を自分で前置しない。** argv 起動のツールでは同じ手が使えず、ログに出す側は分解できない

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

**この一覧は「出せる語」ではなく「届く語」である**（#1846 の裁定 4。理由は §3.3）。

---

### 3.3 I/F 申し送りの裁定（#1846）

Phase 4-2〜4-5 は I/F を変えずに 6 ツールを載せきったが、その過程で **5 件**が「報告だけされて未裁定」のまま残った。#1846 はその 5 件を裁定した。**採る／採らないの両方をここに残す**のは、同じ申し送りが 3 回目に来ないようにするためである。

裁定の線は 1 本しか引いていない: **2 実装以上が独立に同じ回避策へ到達したものは I/F に入れる。1 実装しか要求していないものは入れず、規約として書く。**

| # | 申し送り | 出所 | 裁定 | 実装／根拠 |
|---|---|---|---|---|
| 1 | `prepareLaunch` が worktree の**パス**を受け取れない | codex #1777 / gemini #1776（独立に 2 件） | **採用** | `AgentLaunchContext.worktreePath`（**必須**）。`AgentInstanceRef` は 3 フィールドのまま |
| 2 | `AgentLaunchPlan` に**環境変数**を宣言する場所が無い | copilot #1775 / gemini・agy #1776（＋codex #1760 も同じ手）＝独立に 4 実装 | **採用** | `AgentLaunchPlan.env`（**必須**）＋ `renderAgentLaunchCommand` |
| 3 | `NoDecisionBehavior` に `denies` が無い | agy #1762 | **不採用** | 前提が失効（#1779 の実測）。下記 |
| 4 | `supportedEvents` が「出せる語」と「届く語」を兼ねる | #1759 | **不採用（文書化）** | **届く語**である、と型 doc に明記。分割しない |
| 5 | pull 型は再送の畳み込み（turn-gate）が要る | opencode #1778 | **不採用（規約化）** | §4 手順 6′ ＋ §5 に規約として明記 |

裁定はすべて `tests/unit/hooks/sources/launch-contract-1846.test.ts` に固定してある（不採用の 3・4・5 も含む）。

### 3.3.1 採用したもの

**1. `worktreePath`（必須）。** gemini だけが `configScope: 'per-worktree'` で、設定の書き先が `<worktree>/.gemini/settings.json`。#1762 は `prepareLaunch(target, executablePath)` にパスが無かったため `injectGeminiHookSettings(worktreePath, target)` を**別 export** し、`cli-tools/gemini.ts` が **2 回呼ぶ**形になっていた。6 ソースのうち 1 つだけ設定の書き出し場所が違う、という状態は Epic #1720 が潰そうとした形そのものである。

- **`AgentInstanceRef` は太らせない。** あれは**キー**で、`agent-event-state` / `pending-decisions` / 両レシーバが等値比較する。パスを持つキーは worktree を移動した瞬間に自分自身と等しくなくなる。
- **optional にしない。** optional なら「パスが無いときは黙って設定を書かない」実装が合法のまま残り、それはこのサブシステムの他の失敗と同じく**エラーもイベントも出さずに**壊れる。

**2. `env`（必須）。** codex / copilot / gemini / antigravity の**4 実装が独立に**「`NAME=value ` を `command` の先頭に書く」へ到達していた。tmux ペインに打ち込む今の起動路では動くが、宣言されていない前提（**起動側はシェルである**）に 4 箇所が乗っている。

- argv 起動のツールでは同じ手が使えない（7 本目がそうでない保証は無い）
- ログ・画面に出す側は前置を**分解できない**（値は相関キー入りの URL）
- クォートはシェルの性質で、4 コピーは取り違えの機会が 4 回

適用は `renderAgentLaunchCommand`（`lib/hooks/sources/launch-command`）**1 箇所だけ**。`buildAgentLaunchCommandLine` がそれを呼ぶので、`startSession` 側は 1 行で済む。**出力バイト列は #1846 前と同一**（宣言順で展開する）。

### 3.3.2 採用しなかったもの、とその理由

**3. `NoDecisionBehavior` に `denies` を足す — 不採用。前提が失効している。**

申し送りは「agy は `{}` = 拒否なので、現在 `blocks` で近似している」だった。**近似はもう存在しない。** #1762 は確かに `{ kind: 'blocks' }` を置いたが、#1779 が `PreToolUse` フックを実際に登録して agy 1.1.12 を実測し、`src/lib/hooks/sources/antigravity/source.ts:181` は `{ kind: 'proceeds' }` になっている。

- `{"decision":"ask"}` は agy の**通常の承認ダイアログ**を描く（hooks 無しの対照と同一）
- **何も出力せず exit 0 したフック**、および timeout は、hooks 無しと区別できない（fail-open）
- 拒否になるのは `{}` を**送ったとき**だけ。CommandMate は送らない（`encodeVerdict(abstain)` が `{"decision":"ask"}`）

`blocksUntil`（実測ゼロだが union に入っている）との違いはここにある。`blocksUntil` は `blocks` の**程度**であり、この I/F が実測している軸の上に乗る。`denies` は**どのソースも出さないワイヤ値**を記述する上に、次の実装者に「エンコードを直す代わりに `denies` を宣言する」という逃げ道を与える。agy を止めないために立っているのは、まさにそのエンコードである。

> **agy を再び `blocks` へ戻さないこと。** `blocks` は opencode の実測（10分19秒、タイムアウト無し）が占めている語で、「拒否される」の近似ではない。

**4. `supportedEvents` を `emittable` / `delivered` に分ける — 不採用。「届く語」だと明記する。**

2 つの意味が食い違う実例は既に 2 件ある:

- copilot は `PreToolUse` を**出す**（マッパも認識する。#1549 の手書きフックが event route を指していても動く）。しかし CommandMate はそのイベントを `/api/hooks/permission-request` に向けており、そこは裁定するだけで**記録しない**。だから消費層には届かない
- gemini は `BeforeTool` / `AfterTool` を写像として持つが、生成する設定に**登録しない**

消費層（`wait` / `capture --prompts` / `status-mapping`）が聞きたいことは 1 つ、「この語は自分に届くのか」だけである。分割すると消費層が**どちらを見るか選ばされ**、`emittable` を選んだ実装は上の 2 件でちょうど永久に待つ。この項目が防いでいる事故そのものなので、リストは 1 本にする。

**5. `definePullEventSource` に turn-gate を共通部品として持たせる — 不採用。規約にする。**

turn-gate の**状態機械**は汎用（初出だけ通す／arm→complete）だが、それを駆動する語彙は完全に opencode 固有である: `message.updated` の `properties.info.role`、`session.status` の `properties.status.type`、`session.idle`、`session.error`。共通部品にするなら**フレーム名と読み取り位置を全部パラメータ化**することになり、それは opencode 版をもう 1 本書くのと同じ分量で、実装例は 1 件しか無い。

代わりに、**pull 型を足すときの必須手順**にした（§4 手順 6′、§5）。畳み込みが要る理由は I/F では直せない性質のものである — `normalizeEvent` は 1 フレームの純関数で、再送された同一フレームを 1 通目と区別できない。記憶を持てるのは接続を持っている購読側だけで、そこが turn-gate の居場所である。

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
   - `prepareLaunch` — 設定ファイルの書き出しと起動コマンド。**throw しないこと**（fail-open）。
     受け取るのは `AgentLaunchContext`（`target` / `executablePath` / `worktreePath`）。
     設定ファイルに入れられない相関キーは **`env` に宣言する**（`command` に `NAME=value ` を前置しない、#1846）
3. **`registry.ts` の末尾に 1 行足す。** `registerAgentEventSource(<tool>AgentEventSource);`
   （静的 import で登録する。副作用 import はバンドラに落とされうる＝**無言で消える**）
4. **`beginAgentSession()` を `src/lib/cli-tools/<tool>.ts` の `startSession` に足す。**
   生成パスのみ・pane 作成前・起動失敗時も張る。詳細は `src/lib/session/agent-session-lifecycle.ts` の module doc。
   起動行は **`buildAgentLaunchCommandLine({ target, executablePath, worktreePath })` の 1 本**にする（§3.1.1）。
   `prepareAgentLaunch(...).command` を直接 `sendKeys` に渡すと **`env` が落ちる**＝フックは飛ぶが誰の
   イベントか判らなくなる（エラーは出ない）。
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

6′. **pull 型なら turn-gate を置く（#1846 裁定 5、必須）。**
   ストリームは**同一フレームを再送する**。opencode の実測では `session.idle` が異常終了時に 19ms 差で
   2 回、`message.updated`（`role: "user"`）が `session.idle` の**後**にもう一度来る（`../opencode/turn-gate.ts`）。
   1:1 で写像すると、終わったターンの最新イベントが `user_prompt_submit` になり `status-mapping` は
   `running` と読む＝`commandmate wait` が 30 分の staleness まで返らない。
   **`normalizeEvent` では直せない**（1 フレームの純関数で、2 通目を 1 通目と区別できない）。
   購読側に「初出だけ通す」状態機械を置くこと。`createTurnGate` は共通部品では**ない**
   （フレーム名と読み取り位置がツール固有だから。§3.3.2）ので、自分のツールの語彙で書く。

7. **テストを書く。** `tests/unit/hooks/sources/` に置く。**入力は実 fixture**。最低限:
   - 各 fixture が期待どおりの語と detail に写ること
   - 対応語の無いイベントが `null` になり、**throw しないこと**
   - `noDecision` が実測値であること（`describeAbstain(source).safe` の値まで固定する）
   - `encodeVerdict` が実測した wire 形であること
   - `prepareLaunch` の `command` に `NAME=value` 前置が**無い**こと、`env` に相関キーが**在る**こと
     （`launch-contract-1846.test.ts` が 6 ソース全部に対してこれを回している）
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
- **`AgentLaunchPlan.command` に `NAME=value ` を前置する。** 4 実装が独立にこれをやって #1846 で剥がした。相関キーは `env` に宣言し、適用は `renderAgentLaunchCommand` に任せる（§3.3.1）。
- **`AgentInstanceRef` にパスや設定の場所を足す。** あれはキーで、6 モジュールが等値比較する。起動時だけ要るものは `AgentLaunchContext` へ。
- **pull 型を turn-gate 無しで足す。** 再送は必ず来る（§4 手順 6′）。
- **`supportedEvents` に「出せるが CommandMate には届かない語」を書く。** あの一覧は**届く語**の約束で、待つ側はそれしか見ない（§3.3.2）。

---

## 6. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720)
- 本 Issue: [#1759](https://github.com/Kewton/CommandMate/issues/1759) / I/F 申し送りの裁定: [#1846](https://github.com/Kewton/CommandMate/issues/1846)（§3.3）
- 下流: [#1760](https://github.com/Kewton/CommandMate/issues/1760) codex / [#1761](https://github.com/Kewton/CommandMate/issues/1761) copilot / [#1762](https://github.com/Kewton/CommandMate/issues/1762) gemini・antigravity / [#1763](https://github.com/Kewton/CommandMate/issues/1763) opencode
- 実測: [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md) / [`opencode-server-live-verification.md`](./opencode-server-live-verification.md) / [`agent-hooks-live-verification.md`](./agent-hooks-live-verification.md) / [`agent-hooks-permission-deny-verification.md`](./agent-hooks-permission-deny-verification.md)
- fixture: [`tests/fixtures/hooks/`](../../tests/fixtures/hooks/)
- 運用手順: [`docs/user-guide/agent-event-hooks.md`](../user-guide/agent-event-hooks.md)
