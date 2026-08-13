# gemini / antigravity への hooks 横展開 — 設計判断と実測

- Issue: [#1762](https://github.com/Kewton/CommandMate/issues/1762)（Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720) Phase 4-4）
- 前提: [`agent-event-source-interface.md`](./agent-event-source-interface.md)（#1759 の I/F）/ [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md) §5.3・§5.4（#1757 の実測）
- 実装: `src/lib/hooks/sources/gemini/` / `src/lib/hooks/sources/antigravity/`

---

## 0. 3 行で

- **gemini の承認は Policy Engine 専任。** hooks は拒否とエスカレーションはできるが**承認はできない**（CLI 実装読み）。したがって Auto-Yes の意味は二重にならない。
- **agy の hooks 設定はマシンに 1 本しか無い。** worktree / instance の相関は**設定ファイルではなく起動プロセスの環境変数**（`CM_HOOK_URL`）に置いた。1 本の設定で N worktree × M instance が同時に動く。
- **agy の `PreToolUse` は張っていない。** 空応答＝拒否で、中継スクリプトは stdout に何も書かないため、張れば「マシン全体のツール呼び出しが止まる」。

---

## 0.1 ⚠️ gemini の `timeout` はミリ秒（#1757 の記載が誤り）

**先に読むべき 1 件。** #1757 §8.2 R13 は 4 ツールの timeout について「単位はすべて秒」としているが、**gemini は違う**。

他ツールと同じつもりで `timeout: 5` を書いた実 v0.55.1 セッションの出力:

```
WARNING: The following project-level hooks have been detected in this workspace:
  - '…/cmate-agent-event.sh' --tool gemini --event session_start --worktree-id 'wt-live' --stdin-json
  … （5 件すべて開示バナーに出る）
Hook execution error: Hook timed out after 5ms
Hook execution for SessionStart: 0 succeeded, 1 failed (…), total duration: 8ms
```

**設定は正しく読まれ、hook は開示され、起動もしていた。** それでも curl が socket を開く前に殺されるので、**受け口には 1 件も届かない**。バナーが出るぶん「動いているように見える」度合いが高い。

バンドル側の裏取り:

```js
const timeout = hookConfig.timeout ?? DEFAULT_HOOK_TIMEOUT;   // DEFAULT_HOOK_TIMEOUT = 6e4
… new Error(`Hook timed out after ${timeout}ms`)
```

→ **単位は ms、既定は 60 秒**（Claude 600s / codex 600s / copilot ≈10s / agy 30s はいずれも秒）。
`GEMINI_HOOK_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000` を使い、ms と秒の両方をテストで固定してある。

---

## 1. gemini — Policy Engine と hooks の優先順位（本 Issue の必須確認事項）

#1757 §5.3.6 は項目 6（timeout の fail 方向）と項目 7（承認裁定）を**未計測**として残した。この環境の Google アカウントが `IneligibleTierError` でモデル呼び出しに到達できず、ツール実行を伴うターンを 1 度も成立させられなかったためである。

そこで**出荷バイナリの実装を読んで確定させた**（`@google/gemini-cli` v0.55.1 の bundle）。推測ではなく、実行されるコードそのものである。

### 1.1 hook 出力の解釈（`DefaultHookOutput`）

```js
isBlockingDecision()  { return this.decision === "block" || this.decision === "deny"; }
isAskDecision()       { return this.decision === "ask"; }
shouldStopExecution() { return this.continue === false; }
```

3 つとも「**値が入っている**こと」を判定している。空応答・無応答にはどのフィールドも無いので、

> **gemini の no-decision は fail-OPEN。** 阻止もエスカレーションも停止もできない。

これは計測より強い根拠である（「そのとき止まらなかった」ではなく「止められる分岐が無い」）。`noDecision: { kind: 'proceeds' }` の根拠はこれ。

### 1.2 ツール実行の順序（scheduler）

```js
const hookResult = await evaluateBeforeToolHook(config, tool, request, invocation);  // (1)
if (hookResult.status === "error") { …ツールをエラーにして return… }                  //   deny / block / continue:false
const { hookDecision } = hookResult;                                                //   "ask" だけ持ち越す
const { decision: policyDecision, rule } = await checkPolicy(toolCall, config, …);   // (2)
let decision = policyDecision;
if (hookDecision === "ask") decision = "ask_user";                                   // (3)
if (decision === "deny") { …拒否… }
if (decision === "ask_user") { …確認ダイアログ… }
```

読み取れる優先順位は次のとおり:

| 段 | 誰が | できること |
|---|---|---|
| (1) | **hook** | `deny` / `block` → **即座にツールをエラー**（Policy Engine は評価すらされない）。`continue:false` → エージェント停止 |
| (2) | **Policy Engine**（`--approval-mode` / `--policy` / `--admin-policy` / `-y,--yolo`） | `allow` / `deny` / `ask_user` を決める |
| (3) | **hook**（`ask` のみ） | (2) の結果を **`ask_user` へ引き上げる**（エスカレーションのみ） |

> **hook が `checkPolicy` の裁定を「承認」に変える分岐は存在しない。**
> `"allow"` という文字列を hook 出力から読む箇所も無い。

### 1.3 したがって Auto-Yes の意味は一意である

- **CommandMate は gemini に対して裁定を返さない。** `geminiAgentEventSource.encodeVerdict()` はどの `Verdict` でも `{}` を返す。
  - `deny` を出せてしまうのは「待てば覆せない方向」の権限であり、Claude でも Auto-Yes には与えていない。
  - `ask` を出すと Policy Engine が既に決着させた許可をわざわざダイアログに引き戻す。
- **CommandMate は Policy Engine のフラグを一切渡さない。** 起動コマンドに付くのは `CM_HOOK_URL=…` の環境変数だけで、`--approval-mode` も `--policy` も `-y` も付けない。**hooks を注入しても gemini セッションの権限は広がらない。**
- よって gemini の Auto-Yes は**従来どおり TUI 経路のみ**（画面のダイアログを検出して応答する）。hooks 側に第 2 の承認経路が生まれないので、二重定義にならない。

利用者が gemini 側で `--approval-mode yolo` 等を使う選択は当然できるが、それは**利用者が gemini に指示した設定**であって CommandMate の Auto-Yes とは別レイヤーである。両者が同じツール呼び出しについて食い違う瞬間は存在しない（hooks が承認を出さないため）。

---

## 2. antigravity — グローバル設定 1 本を複数 worktree でどう扱うか（本 Issue の必須確認事項）

### 2.1 制約

#1757 §5.4.2 が候補パスごとにサイズの違う `hooks.json` を置き、agy 自身のログ（`loaded N named hooks from M hooks.json file(s)`）でどれが読まれたかを同定している。結果:

- 公式 doc が指定する `<workspace>/.agents/hooks.json` は **読まれない**（`.git` あり・trusted でも `0 hooks.json file(s)`）
- 読まれるのは `~/.gemini/config/hooks.json` **ただ 1 本**
- 加えて payload には `cwd` が無く `workspacePaths` は空配列、hook の作業ディレクトリは `hooks.json` のあるディレクトリ

つまり **設定ファイルには worktree も instance も書けない**（書いたら 1 セッション以外すべてで誤り）。

### 2.2 採った設計 — 相関を設定ファイルから追い出す

```
~/.gemini/config/hooks.json   ← 相関キーを一切含まない。マシンに 1 本。全 worktree 共用
   { "commandmate": { "SessionStart": [...], "PostToolUse": [...], "Stop": [...] } }

起動コマンド（セッションごと）
   CM_HOOK_URL='http://127.0.0.1:<port>/api/hooks/agent-event?tool=antigravity&worktreeId=<id>&instanceId=<inst>' 'agy'
```

- 中継スクリプトは `CM_HOOK_URL` を**自分で読む**（`scripts/hooks/cmate-agent-event.sh` の `URL="${CM_HOOK_URL:-}"`）。hook コマンド文字列の中でシェル展開に頼らないので、実行方式の想定に依存しない。
- 受け口はクエリ文字列から `tool` / `worktreeId` / `instanceId` を読む。Claude の注入 `--settings` と同じ相関方式である。
- **hook は agy の子プロセスであり、agy は CommandMate が起動した pane の子プロセス**なので環境変数は継承される。既存の `CM_AUTH_TOKEN` も同じ経路で中継に届いている。

### 2.3 この設計で成り立つこと / 成り立たないこと

| 状況 | 結果 |
|---|---|
| 複数 worktree で同時に agy を動かす | **正しく相関する**（設定は共用、URL はプロセスごと） |
| 同一 worktree の `antigravity` と `antigravity-2` | **正しく相関する**（同上） |
| ユーザーが自前の `hooks.json` を持っている | **温存される**（トップレベルの `commandmate` キー 1 つだけを占有。agy は名前つき hook を merge して順次実行する） |
| ユーザーが CommandMate 外で `agy` を起動 | `CM_HOOK_URL` が無い → 既定 URL に POST → `cwd` が `~/.gemini/config` で worktree に解決できず **202 で捨てられる**。誤って他セッションに紐づくことはない |
| CommandMate サーバが停止中 | curl が失敗し中継は exit 0（fail-open）。**agy は止まらない** |
| CommandMate を 2 台のサーバで動かす | 後に起動した方の `hooks.json` が勝つ（内容は相関を含まないため実質同一。URL はプロセスごとなので**どちらのサーバにも正しく届く**） |

### 2.4 `PreToolUse` を張らない判断

agy の `PreToolUse` は応答の `decision` が**必須**で、#1757 P10 が「必須」の意味を計測している: `{}` を返すと `run_command` / `list_dir` / `search_web` がすべて拒否され、エージェントは「all tool executions were denied by the environment's system policy」と報告して代替手段を探し回った（hooks.json を退避した対照実行では正常動作）。

中継スクリプト `scripts/hooks/cmate-agent-event.sh` は **stdout に何も書かない**（`curl … >/dev/null`）。これは agy にとって「`decision` の無い応答」であり、上記の拒否そのものである。

- 中継に「裁定 JSON を stdout に出す」機能は無く、**その追加は本 Issue のスコープ外**（`scripts/hooks/**` は変更対象外）。
- したがって **agy の承認裁定（Auto-Yes v2 経路）は本 Issue では実装しない。** `encodeVerdict` は正しい wire 形（`{"decision":"allow"}` / `{"decision":"deny","reason":…}`）を実装済みで、中継が裁定を返せるようになった時点で `PreToolUse` を登録すれば有効になる。
- 逆に **`PostToolUse` と `Stop` は空応答で安全**であることが doc と実測の両方で裏付けられている（`PostToolUse` は「`{}` を期待」、`Stop` は「`continue` 以外なら停止を許可」、かつスパイクは両方を張ったまま正常終了している）。

---

## 3. `AgentEventSource` I/F で表現できなかったもの（#1759 への報告）

**ツール名で分岐する抜け道（`if (tool === 'gemini')`）は 1 つも入れていない。** そのうえで、I/F に収まりきらなかった点が 3 つある。いずれも回避策は各ツールの実装内に閉じている。

| # | 表現できなかったこと | 実装での扱い | あるべき解 |
|---|---|---|---|
| **G1** | **`AgentInstanceRef` に worktree の *パス* が無い。** `configScope: 'per-worktree'` は gemini だけで、`prepareLaunch(target, executablePath)` は `(worktreeId, cliToolId, instanceId)` しか受け取らない | `injectGeminiHookSettings(worktreePath, target)` を別に export し、パスを持っている `GeminiTool.startSession` から呼ぶ。`prepareLaunch` は起動コマンドだけを組み、`settingsPath` は null を返す | `AgentLaunchPlan` の生成に worktree パス（または解決器）を渡せるようにする。DB 参照を `sources/` に持ち込むのは受け口の import グラフを重くするので避けた |
| **G2** | **`NoDecisionBehavior` に「裁定しない＝拒否される」が無い。** `proceeds` / `blocks` / `blocksUntil` の 3 値で、agy はどれでもない | `blocks` を選択（`describeAbstain().safe === false` になる唯一の値で、拒否は待機より悪いので危険側に倒れる）。`AbstainOutcome.summary` の文面（「無限に待つ」）は**機構としては不正確** | 4 値目（`denies`）を足す。現時点でこの区別で挙動を変える呼び出し側は無いので、I/F の owner の判断に委ねる |
| **G3** | **`detail`（subtype）の語彙が共通化されていない。** #1759 はイベント*名*を抽象化したが、`status-mapping.ts` と `agent-event-state.ts` は `detail === 'permission_prompt'` という **Claude のリテラル**を直接比較している | gemini の `extractDetail` で `ToolPermission` → `permission_prompt` に翻訳する（ソースの仕事＝ツールの方言を CommandMate の語彙に写す、の一貫） | subtype も 7 語と同様に共通語彙として定義する。翻訳しないと「イベントは正しく届いて記録もされているのに `waiting` にならない」という無言の失敗になる |

---

## 4. 登録するイベントと、しないイベント

| ツール | 登録する | 登録しない理由 |
|---|---|---|
| gemini | `SessionStart` / `BeforeAgent` / `AfterAgent` / `Notification` / `SessionEnd` | `BeforeTool` / `AfterTool`: hooks は同期実行なのでツール呼び出しごとに 2 往復ブロックする。得られる `running` は `BeforeAgent` が既に立てており、`stop` まで消えない。`AskUserQuestion` に相当するツールも無い。**綴りの写像だけは持つ**（ユーザーが自前で張る可能性があるため） |
| gemini | — | `PreCompress` / `BeforeModel` / `AfterModel` / `BeforeToolSelection`: 7 語に対応語が無い。`null` を返して数える（`getUnknownEventTally`） |
| antigravity | `SessionStart` / `PostToolUse`(matcher `*`) / `Stop` | `PreToolUse`: §2.4。`SessionEnd` / `Notification` / `UserPromptSubmit`: **agy に存在しない**（設定しても 1 度も発火しない） |

`PostToolUse` は往復コストがあるが agy では**唯一の「実行中」signal** である（`user_prompt_submit` が無く `PreToolUse` を張れないため）。gemini の `BeforeTool` と判断が逆になっているのはこの差による。

---

## 5. 共有 config ツリーの非破壊

`~/.gemini/` には gemini の `settings.json` と **OAuth 資格情報**、agy の `config/hooks.json` と `antigravity/` `antigravity-cli/` の状態が同居する。

- **`HOME` / `GEMINI_CLI_HOME` の差し替えはしない。** gemini の資格情報ごと別マシン扱いになり、利用者はログイン画面に戻される。
- **書き込みは常にマージ。** JSON を読み、CommandMate のキーだけ差し替え、残りをそのまま書き戻す（`gemini/shared-config-tree.ts`。antigravity 側も同じ実装を import する）。
- 新規作成時のみ file 0600 / dir 0700。**既存ファイルの permission は変えない**（利用者のファイルであってこちらのものではない）。
- 両方向の非破壊は `tests/unit/hooks/sources/shared-config-tree-1762.test.ts` が sha256 で固定している（gemini 注入後に agy 設定が不変、agy 注入後に gemini 設定が不変。最悪ケースとして「worktree の `.gemini` が共有ツリーそのもの」でも検証）。

### 5.1 既知の副作用 — gemini の設定は利用者のリポジトリに書かれる

gemini の hooks 設定の正規の置き場は `<worktree>/.gemini/settings.json` であり、**これは利用者の作業ツリーの中**である。したがって:

- gemini セッションを起動した worktree では `.gemini/settings.json` が `git status` に現れる（`.gitignore` していない場合）。
- 既にチームで `.gemini/settings.json` をコミットしているリポジトリでは、**注入によって差分が出る**（既存キーは保たれるが `hooks` の下に CommandMate のエントリが増える）。

これは gemini の設計上避けられない（`--settings` 相当のフラグが無く、user スコープの `$GEMINI_CLI_HOME/.gemini/settings.json` へ逃がすと **OAuth 資格情報ごと別ツリーになり利用者がログイン画面に戻される**）。回避したい利用者は `CM_AGENT_HOOKS_INJECT=0` で注入そのものを止められる。

---

## 6. 実機検証の記録（2026-08-13）

**本番サーバ（port 3000）には 1 件も飛ばしていない。** 受け口はローカルのダンプサーバ 127.0.0.1:3762、tmux は専用 socket `cmate-p44-gem` のみ（`kill-server` 不使用）。

### 6.1 gemini v0.55.1

| 検証 | 結果 |
|---|---|
| 生成した `.gemini/settings.json` が読まれる | ✅ 開示バナーに 5 件すべて列挙された |
| `session_start` 到達 | ✅ `?tool=gemini&worktreeId=wt-live&instanceId=gemini-2` / body に `cwd`・`sessionId`・`detail:"startup"` |
| `user_prompt_submit`（`BeforeAgent`）到達 | ✅ |
| `session_end` 到達 | ✅ `detail:"exit"` |
| `stop`（`AfterAgent`）/ `notification` | ❌ **未計測** — このマシンのアカウントが `IneligibleTierError`（`UNSUPPORTED_CLIENT`）でモデル呼び出しに到達できず、ターンが完了しない（#1757 §5.3.6 と同じ制約）。**「確認できなかった」であって「実在しない」ではない**: 綴りは CLI 自身の `HookEventName` enum と `hooks migrate` 変換表で確定済み |
| ユーザーの既存キーの温存 | ✅ workspace settings に `security.auth` を置いてから注入し、マージ後も残ることを実ファイルで確認 |
| fail-open（受け口停止） | ✅ hook 失敗ログ 0 件。中継が exit 0 を返すので gemini からは成功に見える |

### 6.2 antigravity (`agy`) v1.1.12

| 検証 | 結果 |
|---|---|
| 生成した `~/.gemini/config/hooks.json` が読まれる | ✅ |
| `session_start` / `post_tool_use`(×6) / `stop` 到達 | ✅ `?tool=antigravity&…&instanceId=antigravity-2`、`cwd` は予告どおり `~/.gemini/config`（＝worktree 特定はクエリ以外に手段が無いことの実証） |
| **ユーザー自身の名前つき hook との併存** | ✅ 同じ `hooks.json` に置いた `user-probe` の `Stop` ハンドラも**同時に発火**した |
| `Stop` に空応答 | ✅ **エージェントは正常に停止**（fail-safe を実測） |
| fail-open（受け口停止） | ✅ 通常どおり応答して終了 |
| `--print`（headless）の `Stop` | ⚠️ ツール承認が auto-deny で終わった実行では**発火しなかった**（CommandMate の hook もユーザーの hook も動かず＝agy 側の挙動）。ツールを使わない通常ターンでは発火する |

### 6.3 ユーザー設定の before/after

検証前に sha256 を採り、終了後に再取得して比較。

```
~/.gemini/settings.json                    sha256 一致 / diff 空
~/.gemini/config/config.json               sha256 一致
~/.gemini/config/mcp_config.json           sha256 一致
~/.gemini/antigravity-cli/settings.json    sha256 一致 / diff 空
~/.gemini/config/hooks.json                検証前は「ファイル無し」→ 検証後に削除して原状復帰
```

---

## 7. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720) / I/F: [#1759](https://github.com/Kewton/CommandMate/issues/1759)
- 実測: [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md) §5.3 / §5.4 / §8
- fixture: `tests/fixtures/hooks/gemini/` / `tests/fixtures/hooks/antigravity/`
- 中継: `scripts/hooks/cmate-agent-event.sh`（本 Issue では変更していない）
