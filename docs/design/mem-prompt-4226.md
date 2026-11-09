# 既存のフックと操作の出来事を使って mem の更新を促す（Issue #4226 / Epic #4220 の子 F）設計

- 状態：設計の段（実装前）。第 1 版。**冒頭の「止める点」で止める**（§0.1。PM の答えを待つ）
- 前提：Epic #4220 の決定事項 D1〜D13。とくに D1（モデルを呼ばない）・D2（導けるものは書かない）・D3（既定は off、有効にするのは人）・D8（新しい常駐・定期の実行を足さない）・D12（記録はデータとして区切る・自由入力の検査）
- 読んだ設計：A `docs/design/mem-store-4221.md`・B `mem-close-when-4222.md`・C `brief-4223.md`・D1 `session-boundary-brief-4274.md`（develop にマージ済み）。D2（`../commandmate-issue-4224` の `HEAD:docs/design/brief-injection-d2-4224.md`、`d21b22712`）・E（`../commandmate-issue-4225` の `HEAD:docs/design/mem-promote-4225.md`、`78ceab299`）は読むだけ（未マージ）
- 凡例：**［事実］** = この文書を書いた時点（2026-11-09、`feature/4226-worktree` = develop `55b8192e0`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. 冒頭

### 0.1 止める点（PM の答えを待つ）

契約の止める条件（A・B・C・D1 のファイルや既存のフックの配線の作り直しが要る／最小の追加で済むなら案を書いて作らずに止める）に当たる点が 3 つある。
**どれも作り直しではなく、最小の追加で済む**。案をここに書き、作らずに止める。S1・S2 の答えが出るまで実装の契約は送れない。S3 は答えがどちらでも §2 以降の作りは変わらない。

| # | 止める点 | 事実（file:line） | 案（最小の追加） | 案を採らないときの代わり |
|---|---|---|---|---|
| **S1** | **Agent の文脈へ一言を戻すには、既存のフックの設定の生成に「出力を文脈へ返す手」を 1 つ足す必要がある。** 今 CommandMate が置くフックは、どれも Agent の文脈へ何も返さない | 中継のスクリプトは POST の応答を捨てる（`scripts/hooks/cmate-agent-event.sh:352` の `curl "$@" >/dev/null`）。Claude の `SessionStart` もこの中継を呼ぶだけ（`src/lib/hooks/hook-settings-generator.ts:443-466`）。Claude の設定は起動のたびに生成して上書きする（`buildAgentHookSettings`、`:515-560`。`writeAgentHookSettings`、`:569-581`）ので、外から足した手は次の起動で消える。中継は `PreCompact` 等を名前で断る（`cmate-agent-event.sh:96-100`）。D2 の設計も同じ事実を H1 として挙げている（D2 §0.1 H1） | 各ツールの既存の生成・merge の関数（Claude `buildAgentHookSettings`、Codex `buildCodexHookSettings`/`mergeCodexHookSettings` `src/lib/hooks/sources/codex/hooks-config.ts:566`・`:635`、Command Code `mergeCommandCodeHookSettings` `command-code/hooks-config.ts:345`、Copilot・Antigravity・Gemini の merge）に、**導入（§2）が有効なときだけ** 1 つの手（`commandmate mem check --suggest --quiet --hook <event>` を呼ぶ `type:"command"`）を足す引数を 1 つ足す。既存の手・印・merge の規則は変えない。**ただし §1 の表のとおり、どのツールでも「その出来事の出力が文脈に入る」ことはこのリポジトリで実測されていない**ので、S1 を採っても、手を足すのは実測（§1.3 の U-F1〜U-F5）で確かめたツールと出来事だけにする | 一言を戻す経路を作らない。全ツールが「戻せない」の行になり、代わりの経路（§1.2：D2 の次の境界の brief に既にある欄・`mem check --suggest` を Agent・skill（H #4228）が呼ぶ）だけになる。受入基準の「未対応の出来事では代替の経路になる」は、この場合も満たす |
| **S2** | **`commandmate mem check --suggest` は A の CLI のファイル（`src/cli/commands/mem.ts`）の `check` に旗を足す必要がある。** 新しい exit code も A が置いた `MemExitCode`（`src/cli/types/index.ts:890-906`）に足す | `mem check` は B が足した `POST …/mem/check`（`src/cli/commands/mem.ts:368-391`、`src/lib/mem/service.ts:594-622`）。評価して成立したものを閉じる。`MemExitCode` は 0・50〜56（`src/cli/types/index.ts:890-906`） | `mem.ts` の `check` に `--suggest`・`--quiet`・`--hook <event>` の 3 つの旗と、旗があるときだけ新しい route（`GET /api/worktrees/:id/mem/suggest`、新規ファイル）を呼ぶ分岐を 1 つ足す。`MemExitCode` に `SUGGESTED: 57` を 1 つ足す。**`service.ts`・`mem-db.ts`・B の評価は変えない**（F の lib は A・B の export を呼ぶだけ、§3.5） | 別のコマンド名（例：`commandmate mem-suggest`、新規ファイル）にする。Issue の名前（`mem check --suggest`）とは違うので、Issue の文面を直す |
| **S3** | **「同じ状態で 1 回」を再起動の後まで保つには、新しい表（migration）が要る** | migration は E が v69 を取る（E §6.1、`CURRENT_SCHEMA_VERSION` は今 68：`src/lib/db/migrations/runner.ts:34`）［事実：E の設計の記述。develop の値は 68］ | 新しい表 `suggestion_shown`（§4、v70）を新しいファイル `src/lib/db/suggestion-shown-db.ts` に置く（`mem-*.ts` の名前にしない＝A のファイルにしない）。マージは E → F の順 | メモリの表だけで持つ（サーバの再起動で 1 回だけ繰り返す）。§4.5 |

S1〜S3 のほかに、**D1〜D13 と違う作りは要らない**。A・B・C・D1 のファイル（`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`src/lib/session/brief-provider.ts`・`session-brief.ts`）は、S2 の `mem.ts` の分岐と `MemExitCode` の 1 行のほかは変えない。D2（#4224）・E（#4225）の worktree とファイルには触らない。

### 0.2 D・A・Issue の文面だけでは一意に決まらず、この文書が選んだ解釈

| # | 文面 | 選んだ解釈［見立て］ | 理由 |
|---|---|---|---|
| F1 | Issue「導入は新しい opt-in の操作」と D3「有効にするのは人だけ。変える経路は画面だけ」 | opt-in は 2 段。(1) **促しを出すかの設定**は A が既に置いた `features.promptOnEvents`（`src/types/mem.ts:117-123`、`src/lib/db/mem-db.ts:44`・`:257-260`、既定 `false`）で、変える経路は画面だけ（A §11）。(2) **フックの手を置くか**（S1）は、人が端末で行う `commandmate mem hooks install`（§2）。Agent のセッションの中からは断る（A の `purge` と同じ検査で、保証ではない） | D3 の「有効にする」は mode と feature の話で、A がその置き場を作っている。フックの設定ファイルは各ツールの持ち物で、DB からは書けないので、別の操作にする |
| F2 | Issue「会話の要約の直前：戻せるツールでは一言を戻す」 | 戻すのは固定の文 1 行と読むコマンドだけ（§3.4）。項目の本文は戻さない | D1（モデルを呼ばない・テンプレート）、D12（記録はデータとして区切る）。本文は brief（C）の区切りの中で読む |
| F3 | Issue「`send --note "<text>"` … relay への参照と一緒に mem に残す」 | `--note` は `--reply-to`（relay を開く送信）と一緒のときだけ受ける。mem には kind `waiting`・`close_when=relay:<id>`・`evidence=[relay:<id>]`・`text=<note>` の 1 項目として書く。**送る本文には足さない**（§6） | relay が無い送信には「参照する relay」が無い。`waiting` は「相手の返事を待つ」を型で書ける唯一の kind で、`relay` の条件を受ける（A §2.3）。本文に足すと利用者の本文を変え、#2464 の予算にも入る |
| F4 | Issue「ターンの終わり」 | ターンの終わりの出来事（`Stop`）で文脈へ一言を戻す手は**どのツールでも作らない**（§1.1） | 戻せるのは「止まるのを断って続けさせる」形だけで（Command Code の `decision:"block"`／exit 2：`command-code/hooks-config.ts:84-89`、Antigravity の `continue`：`antigravity/hooks-config.ts:45-48`）、それはモデルにもう 1 ターン走らせる＝**モデルの実行を増やす**（受入基準に反する） |

---

## 1. ツールごとの表（決めること 1）

### 1.1 表

列の読み方：**出来事** = その時点の出来事を CommandMate の既存の配線が受けているか（○ 受けている／△ ツールに出来事はあるが配線していない／× ツールに無い・分からない）。**戻せるか** = 今の配線で Agent の文脈へ一言を戻せるか。**代わり** = 戻せないときの経路。

| ツール（配線の正本） | 開始 | 会話の要約の直前 | ターンの終わり |
|---|---|---|---|
| **Claude Code**（#1722。`hook-settings-generator.ts:515-560`、起動ごとに `--settings` で渡す：`:595-626`） | 出来事 ○ `SessionStart`（`type:"command"`、`:531-540`）。戻せるか：**今は戻さない**（中継は stdout に書かない、`cmate-agent-event.sh:352`）。出力が文脈に入るかは［未確認：U-F1。D2 の U-H1 と同じ］。代わり：D1・D2 の境界の brief（D1 §2.2 で Claude は ○） | 出来事 △ `PreCompact` は生成に無い（`:530-556` の鍵に無い）。中継も名前で断る（`cmate-agent-event.sh:97`）。出力が文脈に入るかは［未確認：U-F2］。代わり：**無し（その時点では）**。要約は境界ではない（D1 §2.2 の注：`SessionStart(source=compact)` は境界にしない）ので brief も付かない。要約の後は transcript の要約の行（`isCompactSummary`、`src/lib/hooks/sources/claude/transcript.ts:283-284`）で「要約があった」ことだけは読めるが、F では使わない（§1.2 の R3） | 出来事 ○ `Stop`（http、`:543`）。戻せるか：×（F4。続けさせる形しか無い）。代わり：次の境界の brief |
| **Codex**（#1760。`$CODEX_HOME/hooks.json` 1 本を全セッションで共有：`codex/hooks-config.ts:141`・`:264-277`・`:635-656`・`:672-728`） | 出来事 ○ `SessionStart`（最初のターンの送信時に来る：D1 §2.2）。戻せるか：今は戻さない。出力が文脈に入るかは［未確認：U-F3］。代わり：境界の brief（D1 §2.2 で ○） | 出来事 △ `PreCompact` はツールにある（`cmate-agent-event.sh:97-98` の注）が登録していない（`CODEX_REGISTERED_EVENTS`、`:264-270`）。出力の扱いは［未確認：U-F3］。**手を足すとファイルの中身が変わる**：hooks は人が trust するまで黙って飛ばされ、中身が一致するときだけ trust が保たれる（`:665-668`、CHANGELOG #1760 の「trust を無駄にしない」）［見立て：中身が変われば人のレビューがもう一度要る］。代わり：無し（その時点では） | 出来事 ○ `Stop`。戻せるか：×（F4）。代わり：次の境界の brief |
| **Command Code**（#2251。worktree の `.commandcode/settings.local.json` に merge：`command-code/hooks-config.ts:122-130`・`:162-167`・`:345-368`） | 出来事 ○ `SessionStart`（打つ前に来る：D1 §2.2）。戻せるか：今は戻さない（`:84-89`：中継は stdout に書かない前提）。出力が文脈に入るかは［未確認：U-F4］。代わり：境界の brief | 出来事 × ツールのフックは 4 語だけ（`:13`、`["PreToolUse","PostToolUse","Stop","SessionStart"]`）。代わり：無し | 出来事 ○ `Stop`。戻せるか：×（`decision:"block"`・exit 2 は「止まるのを断る」：`:84-89`。F4）。代わり：次の境界の brief |
| **Copilot**（`copilot/hook-settings.ts`、`~/.copilot/settings.json` に印 `cmate-copilot-agent-hooks` で merge：`:63-70`・`:173`・`:245-251`・`:536-560`） | 出来事 ○ `SessionStart`（ただし `UserPromptSubmit` の後に来る：D1 §2.2 が引く `copilot/source.ts:53-64`）。戻せるか：今は戻さない。出力の扱いは［未確認：U-F5］。代わり：**境界の brief も無い**（D1 §2.2：未対応のツール）。`send --with-brief`（D1 §7.3）と `mem check --suggest` を Agent が呼ぶ | 出来事 ×［未確認：ツールに要約の前の出来事があるか］。代わり：無し | 出来事 ○ `Stop`。戻せるか：×。代わり：明示の口（`--with-brief`・`mem check --suggest`） |
| **Antigravity**（`antigravity/hooks-config.ts`、`~/.gemini` の下の agy の設定に名前 `commandmate` で merge：`:94-112`・`:124-128`・`:403`） | 出来事 ○ `SessionStart`。戻せるか：×（「返事の契約が無い」：`:49`）。代わり：明示の口（D1 は未対応） | 出来事 ×［未確認］。代わり：無し | 出来事 ○ `Stop`。戻せるか：×（`continue` は止まるのを断る：`:45-48`。F4）。代わり：明示の口 |
| **Gemini**（`gemini/settings-generator.ts`、worktree の `.gemini/settings.json` に merge：`:15-22`・`:108-114`・`:264-288`） | 出来事 ○ `SessionStart`。戻せるか：今は戻さない。出力の扱いは［未確認］。代わり：明示の口（D1 は未対応） | 出来事 △ `PreCompress` はツールにある（`gemini/event-vocabulary.ts:22-27`、採取済み）が登録していない。出力の扱いは［未確認］。代わり：無し | 出来事 ○ `AfterAgent`（`stop`、`:111`）。戻せるか：×［見立て：F4 と同じ扱い］。代わり：明示の口 |
| **OpenCode / OpenCode V2**（`opencode/source.ts:1-20`：設定を書かず、サーバから購読する。`configScope:'none'`） | 出来事 ○（購読の `session_start` 相当、`OPENCODE_SUPPORTED_EVENTS = AGENT_EVENT_TYPES`：`:112`。V2 は `user_prompt_submit`・`stop`・`notification` だけ：`opencode-v2/source.ts:292`）。戻せるか：×（フックの手を置く場所が無い。購読は観測だけ）。代わり：明示の口 | 出来事 ×（transcript に `compaction` の部品は読める：`opencode/transcript.ts:42`。事後で、出来事ではない）。代わり：無し | 出来事 ○ `stop`。戻せるか：×。代わり：明示の口 |
| vibe-local・legacy-relay | 出来事 ×（`supportedEvents: []`：`legacy-relay.ts:63`） | × | × |

**まとめ［事実と見立て］**：今の配線で文脈へ一言を戻せる組は **0**。S1 の案を採っても、戻す手を足せるのは「ツールにその出来事がある・出力が文脈に入ると実測した」組だけで、候補は Claude の `SessionStart`・`PreCompact`、Codex の `SessionStart`・`PreCompact`、Command Code の `SessionStart`、Gemini の `SessionStart`・`PreCompress` に限られる（どれも［未確認］）。**ターンの終わりは全ツールで戻さない**（F4）。

### 1.2 代わりの経路（全ツール共通。S1 の答えに依らない）

| # | 経路 | 何が出るか | 根拠 |
|---|---|---|---|
| R1 | **D2 の次の境界の brief**（D1 が境界を検出する Claude・Codex・Command Code） | brief の各項目に既にある `stale`・`unreflected`・条件の結果（`src/lib/brief/sources.ts:479-480`［事実］）と、D2 が足す「終わる前の更新を確認できない」の 1 行（D2 §7.1） | **C・D2 のファイルを変えずに**、F の規則のうち「古い」「未反映」「条件が成立」は brief で読める。F は brief に行を足さない（C・D2 の予算と固定の先頭を変えない。§3.6） |
| R2 | **`commandmate mem check --suggest` を Agent・skill が呼ぶ**（全ツール） | §3 の規則の一覧 | H（#4228 の `cmate-handoff`）がターンの区切り・要約の前の手順として呼ぶ（H の範囲） |
| R3 | 要約の後の「要約があった」 | 使わない［見立て］ | transcript の要約の行は事後の観測で、D1 は要約を境界にしない（D1 §2.2）。境界にするかは D1・D2 の判断で、F では変えない（§8 の U-F7） |
| R4 | 送信の明示の口 `send --with-brief`（D1 §7.3） | brief をその送信に付ける | 境界を検出しないツール（Copilot・Antigravity・Gemini・OpenCode） |

**ターンの終わりに CommandMate が何かを送ることはしない**：Agent へ文を送るとモデルが 1 ターン走る（受入基準「モデルの実行が増えない」に反する）。`Stop` の出来事で F が行うのは何も無い（記録も作らない。§4 の表は促しを**出した**ときだけ書く）。

### 1.3 実測で確かめること（S1 を採るときの前提）

| # | 確かめること | 方法 |
|---|---|---|
| U-F1 | Claude の `SessionStart` の `type:"command"` の stdout が会話の文脈に入るか（D2 の U-H1 と同じ） | 隔離の HOME で、手を 1 つ足した設定を `--settings` で渡し、次のターンで Agent に「最初に見えた文」を答えさせる（UAT）。D2 の §6.3 の `--session-start` と同じ実測で済ませる |
| U-F2 | Claude の `PreCompact` の出力が要約の後の文脈に入るか。`matcher`（`manual`/`auto`）の扱い | 同上、`/compact` を打つ |
| U-F3 | Codex の `SessionStart`・`PreCompact` の出力の扱い。手を足したときに trust のレビューがもう一度出るか | 隔離の `CODEX_HOME`（`tests/setup.ts` の pin と同じ考え方）で |
| U-F4 | Command Code の `SessionStart` の出力の扱い | 隔離の worktree で |
| U-F5 | Copilot・Gemini の `SessionStart`（と Gemini の `PreCompress`）の出力の扱い | 同上 |

実測で「入らない」と分かった組は、手を足さず §1.2 の代わりの経路だけにする。

---

## 2. 導入（決めること 2：opt-in の操作・既存の設定を保つ・二重に登録しない・冪等）

**S1 を採ったときだけ作る。** 採らないときは §2 全体を作らない（§3 以降は作る）。

### 2.1 操作

```
commandmate mem hooks status  [--tool <id>] [--json]          # 読むだけ。どのツールのどのファイルに手があるか
commandmate mem hooks install --tool <id> [--event <e>] [--confirm] [--json]
commandmate mem hooks uninstall --tool <id> [--confirm] [--json]
```

- `--confirm` が無いと何も書かず、書く予定の差分（ファイルのパス・足す手の数・印）を出して exit 0（A の `purge` と同じ形、A §8.3）
- **Agent のセッションの中**（`whoami` が成功する：`src/cli/commands/whoami.ts:60-63` の環境変数か tmux のセッション）からの `install`・`uninstall` は断る（exit 55 `NOT_OWNER`）。環境変数を消せば通るので**検査で保証ではない**（A §11.3 と同じ書き方）
- `--event` は §1.3 で実測が通った組だけを受ける（表 `MEM_PROMPT_HOOK_EVENTS`、ツール → 出来事の一覧。最初は空で、実測のたびに 1 行ずつ足す）。表に無い組は exit 2
- `install` が書くのは**導入の印のファイル** `~/.commandmate/hooks/mem-prompt.json`（`{ "version": 1, "tools": { "<id>": ["<event>", …] } }`、0600）だけ。ツールの設定ファイル自体は**各ツールの既存の生成・merge の関数が次の起動のときに書く**（S1 の引数がこの印を読む）。理由：Claude の設定は起動ごとに生成・上書きされ（`hook-settings-generator.ts:569-581`）、外から書いた手は残らない。Codex・Copilot・Antigravity は共有のファイルを既存の merge が持ち、Command Code・Gemini は worktree のファイルを起動時に merge する。書き手を既存の関数 1 つに保てば「既存の手を保つ・二重にしない」は既存の merge の規則がそのまま守る
- 印のファイルの置き場は `getHookSettingsDirectory`（`hook-settings-generator.ts:320-327`、`CM_AGENT_HOOKS_DIR` で変えられる）。試験は一時ディレクトリに向ける

### 2.2 既存の設定を保つ・二重に登録しない

| ツール | 足す手の印 | 既存の手 | 二重にしない仕組み［事実：既存の merge］ |
|---|---|---|---|
| Claude | 生成物の中の 1 グループ。command に `# commandmate:mem-prompt` | 生成物は CommandMate のもので、利用者の設定とは Claude が連結する（CHANGELOG #1722「`--settings` の hooks はユーザー設定と連結」） | 起動ごとに全体を生成し直す（`writeAgentHookSettings`）。手は印のファイルに書かれた出来事にだけ 1 つ |
| Codex | 既存の印 `commandmate:agent-hooks`（`codex/hooks-config.ts:141`）を含む command に、`mem-prompt` の語を足す | 利用者の手・他の鍵はそのまま（`mergeCodexHookSettings`、`:635-656`：自分の手だけ外して足し直す） | 自分の手を外してから足すので重ならない。中身が同じならファイルを開かない（`:725`）。**読めないファイルは書かない**（`:710-721`） |
| Command Code | 既存の判定 `isCommandMateHookCommand(command, worktreeId)`（`command-code/hooks-config.ts:261`）に当たる command | 同（`:345-368`） | 同 |
| Copilot | 既存の印 `cmate-copilot-agent-hooks`（`copilot/hook-settings.ts:173`） | 同（`stripOwnedEntries`、`:550-` ） | 同 |
| Antigravity | 名前 `commandmate`（`antigravity/hooks-config.ts:112`） | 同（`mergeAntigravityHooksConfig`、`:403`） | 同 |
| Gemini | 既存の判定 `isCommandMateHookCommand`（`gemini/settings-generator.ts:182`） | 同（`:264-288`） | 同 |

- **新しい手も既存の印で「CommandMate の手」と判定される**ようにする（新しい印を別に作らない）。新しい印を別にすると、既存の merge が新しい手を利用者の手と読み、外さずに残す → 起動のたびに増える（二重の登録）
- 既存の手（中継・権限の判断）の command・timeout・順は 1 バイトも変えない。新しい手は各出来事の CommandMate のグループの**後ろ**に足す
- UAT の隔離（`CM_UAT_ISOLATION`）で共有のファイルを読むだけにする規則（`codex/hooks-config.ts:677-688`・`:759-816`）はそのまま。隔離の下では手を足さない（読みだけの経路は「空のファイルに書く中身と 1 バイト同じ」を求めるので、手を足した中身は使えないと判定される［見立て］）

### 2.3 冪等（2 回導入しても同じ状態）の印

- 印のファイルの中身は `tools` を ID の順、出来事を表の順で並べた正規の JSON。`install` を 2 回しても同じバイト（2 回目はファイルを開かない：中身が同じなら書かない、Codex の `:725` と同じ）
- 各ツールの設定は「既存の merge(既存の中身, 生成物)」で決まり、生成物は印のファイルで決まる。merge は「自分の手を外して足す」ので、**merge(merge(x, g), g) = merge(x, g)**（冪等）。試験で全ツールについて固定する（§7 の I-F3）
- `uninstall` は印のファイルからツールを外す。次の起動で既存の merge が新しい手を外す（生成物に無いので足し直さない）。印のファイルの `tools` が空になれば、ファイルを消す
- `status` は印のファイルと、各ツールの設定ファイルを**読むだけ**で、「印に有る・ファイルにも有る」「印に有る・まだ起動していない（ファイルに無い）」「印に無い・ファイルに有る（古い起動の残り）」を出す

### 2.4 手の中身

```
commandmate mem check --suggest --quiet --hook <event> # commandmate:agent-hooks mem-prompt
```

- `--quiet` の契約（§3.3）：**exit は常に 0**、出すのは新しい促しの 1 行だけ、無ければ何も出さない。Claude・Command Code の `Stop`・`PreToolUse` の exit 2 は「止める」なので（`command-code/hooks-config.ts:84-87`）、どの出来事に付けても止めない形にする
- 身元（`CM_AGENT_WORKTREE_ID`・`CM_AGENT_INSTANCE_ID` 等、`whoami.ts:61-63`）が無い・解決できないときは何も出さず exit 0。**headless の `codex exec` は共有の `hooks.json` を読み、身元を持たずに手を走らせる**（D1 §2.1 が引く `src/lib/session/claude-executor.ts:931-943`）ので、この規則で黙る
- timeout は既存の `HOOK_TIMEOUT_SECONDS`（5 秒、`hook-settings-generator.ts:83`）。`--quiet` は照会（git・gh）をしない（§3.3）ので、DB の読みだけで返る
- D2 の新しいガード（D2 §6.3 の `tests/unit/guards/hook-no-brief-output-4224.test.ts`：生成物が旗なしの `commandmate brief` を呼ばない・中継が stdout に書かない）とは衝突しない（F の手は `brief` を呼ばず、中継でもない）。F の手が出力するのは §3.4 の固定の 1 行だけ

---

## 3. `commandmate mem check --suggest [--quiet] [--json]`（決めること 3）

### 3.1 形

```
commandmate mem check --suggest [--worktree <id>] [--instance <id>] [--json]
commandmate mem check --suggest --quiet [--hook <event>]
```

- `--suggest` が無い `mem check` は今のまま（B の評価と close。出力・exit を変えない）
- `--suggest` は **新しい route `GET /api/worktrees/:id/mem/suggest?instanceId=&full=1|0&hook=`** を呼ぶ（S2）。route は F の lib `src/lib/mem-suggest/service.ts` の `memSuggest` を呼ぶ
- 全体の評価（`--suggest`、`--quiet` なし）は B の評価を 1 回走らせる：A・B の既存の export `memList`（`src/lib/mem/service.ts:527`）を呼び、その答え（項目・`now` の枠・`warnings`・`conditions`）から規則を当てる。**`memList` は mode `on` で評価し、成立した条件で閉じる**（A §4、B §4）ので、`--suggest` の副作用は `mem list` と同じで、それより増えない
- `--quiet` は**照会をしない**：B の評価を呼ばず、A の読みの export（`listMem`・`presentMemItem`、C の S7 と同じ：`src/lib/db/mem-db.ts:954`・`src/lib/mem/present.ts:85`）だけで当てられる規則だけを使う（§3.2 の「quiet」列）。フックの 5 秒の内に返し、フックの出来事のたびに `gh`・`git` を走らせないため

### 3.2 規則の一覧

材料はすべて A・B・C・D1 の正本の読み。**項目の本文は材料にも出力にも使わない**（ID・kind・状態・時刻・版・条件の結果だけ）。**意図の書き漏れ（書くべきだったのに書かれていない意図）を見つけるとは約束しない**：規則は「書かれた項目の状態」と「`now` の枠が空」しか見ない。

| code | 意味 | 判定の材料［事実：場所］ | quiet | 指紋（§4.1）に入れるもの |
|---|---|---|---|---|
| `now_missing` | 呼び手の instance に `now` が無い | `memList` の `now`（instance ごとの枠、D6）に呼び手の instance の行が無い。roster に居る instance だけ（`resolveAgentInstances`、C の S1） | ○ | code・instance・「無い」 |
| `now_stale` | 呼び手の `now` が古い | `memItemStaleness`（`src/lib/mem/staleness.ts:22-34`、`now` は 1 日）が `stale` | ○ | `now` の item ID・`version` |
| `now_condition_met` | 呼び手の `now` の条件が成立した（閉じた） | B の評価の結果（`conditions[itemId].result === 'met'`、`now` の枠も評価に入る：`src/lib/mem/evaluate.ts:162`）。閉じた後の枠は `now_missing` にもなるので、同じ回では `now_condition_met` だけを出す | ×（評価が要る） | item ID・`version`・`met` |
| `decision_unreflected` | decision が未反映のまま古い | `state` が `open`・`recorded` で `memItemStaleness` が `stale`（decision は 14 日、A §8.2 の「未反映」）。または B の評価で `unreflected:true`（`evaluate.ts:443`、B §5） | ○（古さだけ）／全体では `unreflected` も | item ID・`version`・`state` |
| `manual_stale` | 閉じる条件が `manual` の open 項目が古い | `memItemStaleness` が `stale` で kind が `next`・`external`・`note`（`manual` を受ける kind、A §2.3） | ○ | item ID・`version` |
| `open_count` | open の件数が警告の数を超えた | `memList`／`listMem` の `warnings`（A §8.1） | ○ | kind・件数の段（10 件刻み） |
| `ref_unknown` | 条件の参照先が取れない | B の評価の `unknown` のうち、参照先が無いことを示す語（`relay_not_found`・`not_found`、B §1.9）。照会の失敗（offline・timeout・上限）は**出さない**（一時的で、同じ促しを繰り返すだけになる） | × | item ID・`version`・理由の語 |
| `evidence_missing` | `evidence` の `path:` が今は無い | 項目の `evidence` の `path:` を worktree の root から `lstat`（A §6.2 と同じ連鎖。symlink は「無い」扱い） | ○（ファイルの `lstat` だけ） | item ID・`version`・欠けた参照の数 |
| `decision_no_destination` | decision に記録の行き先が無い | `state='open'` の decision の `promoteTo` が null（E が承認の差分を作れない［見立て］） | ○ | item ID・`version` |

- 対象の範囲：`now_*` は呼び手の instance の枠だけ（他のセッションの `now` に促しを出さない、D6）。他の規則は呼び手のブランチの項目のうち、**呼び手が作成者の項目**と、作成者の無い（人・サーバの）項目［見立て：他の Agent の項目は、その Agent に促す］
- `withheld` の項目（A §6.4 の出口の読み直しで止めた項目）は ID だけ使い、規則は当てる（本文を出さないので安全）
- 規則の表は `src/lib/mem-suggest/rules.ts` の 1 つの配列に置き、テキスト・`--json`・`--quiet`・試験が同じ表を読む

### 3.3 exit の契約

| 状況 | `--suggest`（テキスト・`--json`） | `--suggest --quiet` |
|---|---|---|
| mode `on`・`promptOnEvents=true`・促しが 1 つ以上 | **exit 57**（`MemExitCode.SUGGESTED`、S2）。テキストは 1 行に 1 つ、`--json` は §3.5 | 新しい促し（§4 で未表示）だけを §3.4 の 1 行で出し、表示を記録する。**exit 0** |
| 同・促しが 0 | exit 0。テキストは何も出さない、`--json` は `suggestions: []` | 何も出さない。exit 0 |
| 同・促しはあるが全部表示済み | exit 57（明示の呼び出しは表示済みでも全部出す。表示を記録しない） | 何も出さない。exit 0 |
| mode `on`・`promptOnEvents=false` | exit 0、`suggestions: []`、`--json` に `disabledBy: "promptOnEvents"` | 何も出さない。exit 0 |
| mode `off`・`derived` | **stdout に何も出さない**、stderr に 1 行、exit 50（A の `mem check` と同じ） | 何も出さない。exit 0 |
| 曖昧・未登録・worktree が無い | exit 53／52（A §12.1） | 何も出さない。exit 0 |
| 身元が無い（`--instance` も無い） | `now_*` を除いて当てる。exit は上と同じ | 何も出さない。exit 0（§2.4） |
| サーバに届かない・認証の失敗 | A の CLI の既存の扱い（exit 99 等） | 何も出さない。exit 0（fail-open。理由は stderr に 1 行） |
| 旗の誤り（`--quiet` だけ・`--hook` だけ等） | exit 2 | exit 2 にしない：**exit 0**、stderr に 1 行（フックを止めない） |

- `--quiet` が「表示を記録する」のは mode `on` かつ `promptOnEvents=true` のときだけ。`off`・`derived` では DB に何も書かない（A §4 の「F：更新の促し」の行のとおり）
- `--suggest` の全体の評価の期限は B の `check` と同じ（B §7 G5 の 10 秒）。`--quiet` は照会しないので期限を足さない

### 3.4 出す文（固定のテンプレート）

テキスト（`--suggest`）：

```
suggest now_stale      item=<id> v<version>  `now` が 1 日以上更新されていません。今の作業で書き換えてください: commandmate mem now "<…>"
suggest decision_unreflected item=<id> v<version>  未反映の decision があります。画面で承認・反映を確かめてください
```

`--quiet`（フックの出力。1 回の呼び出しで 1 行だけ）：

```
[CommandMate mem] 未更新の項目が <n> 件あります（<code>,<code>…）。open の項目と now を確かめて更新してください: commandmate mem check --suggest
```

- 文は code ごとの固定の文と数・ID・版だけ。**項目の本文・ブランチ名・自由入力は入れない**（D1・D12）。ブランチ名も入れないのは、C がブランチ名を出口で置き換える（`sanitizeBranch`、`src/lib/brief/sanitize.ts:126`）のと同じ検査を足さずに済ませるため
- 1 行の長さは 240 バイト以下（code は 9 種で固定の長さ）。D2 の 48 KiB の予算（D1 §6.1）には入らない（送信の本文ではない）

### 3.5 `--json` の形

```json
{
  "ok": true,
  "mode": "on",
  "branch": "feature/1-x",
  "instanceId": "claude",
  "full": true,
  "suggestions": [
    { "code": "now_stale", "itemIds": ["…"], "versions": [3], "fingerprint": "sha256:…", "shown": false,
      "message": "…固定の文…", "command": "commandmate mem now \"<…>\"" }
  ],
  "skipped": [{ "code": "ref_unknown", "reason": "quiet_no_query" }]
}
```

- `branch` は C の `sanitizeBranch` の結果を出す（A の `mem check --json` は生のブランチを出している：`service.ts:616`［事実］。F の `--json` は C の出口の規則に揃える［見立て］）
- 型は `src/types/mem-suggest.ts`（新規）

### 3.6 F の lib が呼ぶもの・変えないもの

- 呼ぶ（export を呼ぶだけ）：A の `withMemTarget`（`src/lib/mem/target.ts:116`）・`memList`・`listMem`・`presentMemItem`・`memItemStaleness`、B の評価の結果（`memList` の `conditions`）、D1 の `getCurrentBoundary`（`src/lib/db/session-brief-db.ts:139`、§4.1 の境界の ID）、A の `getInstanceIncarnation`（`src/lib/mem/incarnation.ts:24`）
- 変えない：`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`brief-provider.ts`・`session-brief.ts`。**brief に行を足さない**（§1.2 の R1）
- E と共有（§5.2）：E が decision の未反映の判定を関数として export したら、`decision_unreflected` はそれを呼ぶ。E がマージされるまでは A の `memItemStaleness` と B の `unreflected` で決める（どちらも E が「警告」の根拠にしている事実：E §0.1 S3）

---

## 4. 同じ状態で同じ促しを繰り返さない条件（決めること 4）

### 4.1 状態の指紋

- 促しの単位：**(worktree, instance, instance の世代, 会話の境界, code)**
  - instance の世代：A の `getInstanceIncarnation`（D5：ID の再利用で前の作業の記録を引き継がない）
  - 会話の境界：D1 の台帳の今の行の ID（`getCurrentBoundary`）。境界を検出しないツールでは `null`（その instance の世代の間で 1 回）。新しい会話には前の会話の促しが見えていないので、境界が変われば同じ状態でも 1 回出す［見立て］
- 指紋：`sha256(JSON.stringify([code, 規則ごとの材料]))`。材料は §3.2 の「指紋に入れるもの」を ID の順に並べた配列。**時刻を入れない**（`stale` に変わった瞬間に 1 回出て、更新されるまで同じ指紋）。項目を更新すれば `version` が変わり、まだ当たれば新しい指紋でもう 1 回出る
- `--quiet` が 1 回の呼び出しで出す 1 行は、新しい指紋を持つ code をまとめたもの。表示を記録するのは出した code の分だけ

### 4.2 保存先

S3 の案：新しい表（v70。番号は実装の契約で develop の `runner.ts` と E の v69 を確かめて決める）。

```sql
CREATE TABLE suggestion_shown (
  worktree_id    TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id    TEXT NOT NULL,
  incarnation    TEXT,            -- A の instance の世代。NULL は世代の無い instance
  boundary_id    TEXT,            -- D1 の境界の ID。NULL は境界を検出しないツール
  code           TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  shown_at       INTEGER NOT NULL, -- サーバの時刻（D6）
  PRIMARY KEY (worktree_id, instance_id, code)
);
```

- 1 つの (worktree, instance, code) に 1 行だけ。`incarnation`・`boundary_id`・`fingerprint` のどれかが今と違えば「未表示」と読み、出したら行を置き換える
- 列名 `worktree_id` を使い、worktree の削除（`deleteWorktreeChildRows`、`src/lib/db/migrations/worktree-id-rename.ts:84`）と ID の改名（`renameWorktreeIdPreservingChildren`、`:128`）に既存の仕組みで付いていく（A が `mem_items` に `worktree_id` を使わなかった理由（A §10.3）は「ブランチの単位で残す項目」の話で、この表は instance の単位の一時の記録なので当たらない［見立て］）
- 書くのは `--quiet` の route の 1 つの transaction だけ（mode `on`・`promptOnEvents=true` を同じ同期の区間で読み直してから）

### 4.3 寿命と消える条件

| 条件 | 起きること |
|---|---|
| 同じ code の指紋が変わった・世代が変わった・境界が変わった | 次の `--quiet` で出し、行を置き換える |
| roster から instance が消えた | 次にその worktree の `--quiet` が書く transaction で、roster に居ない instance の行を消す［見立て：roster の変更の経路（A §10.4）に手を入れない］ |
| worktree の削除 | CASCADE と `deleteWorktreeChildRows` で消える |
| 規則の表から code が消えた（版の更新） | 次の書き込みの transaction で、表に無い code の行を消す |
| mode が `off`・`derived` になった | 行は残す（何も書かない・何も評価しない、A §4）。`on` に戻って指紋が同じなら、出さない［見立て：off の間に状態が変わっていなければ、同じ促しになる］ |

- 新しい定期の実行・タイマー・常駐の見張りを足さない（D8・D13）。消すのはすべて次の書き込みの同じ transaction の中
- 件数は (instance 数 × code 9) で上限がある

### 4.4 明示の呼び出しは記録を見ない

`--suggest`（`--quiet` なし）は表示済みかを `shown` の欄で出すだけで、出す・出さないを変えず、記録も書かない。人や Agent が自分で聞いたときは、今の状態を全部答える。

### 4.5 S3 を採らないとき

表の代わりに route のプロセスのメモリの `Map`（同じ鍵、最大 1,000 件で古いものから捨てる）。サーバの再起動の後に同じ促しが 1 回だけ出る。受入基準「同じ状態で同じ促しが繰り返されない」は「1 回の稼働の間」に弱まるので、文書と試験にそう書く。

---

## 5. `manual` の open 項目の古さと、decision の未反映の警告（決めること 5）

### 5.1 古さ（A の「増え方の扱い」と共有）

- 古さは A の `memItemStaleness`（`src/lib/mem/staleness.ts:22-34`）**1 つ**だけで決める。F は閾値を持たない（A §8.2 の「list・F・G が同じ関数」）。閾値を変えるのは A の 1 か所
- F が出すのは `manual_stale`・`now_stale`・`decision_unreflected` の促しだけで、**項目を消さない・閉じない・書き換えない**。`mem check --suggest` の全体の評価が閉じるのは B の条件の成立だけ（`memList` の既存の動き）で、古さは閉じる理由にならない（A §8.2「古さは警告だけで、削除に使わない」）
- 件数の警告（`open_count`）は A の `warnings` をそのまま使う（A §8.1 の数）

### 5.2 decision の未反映の警告を E と共有する方法

［事実］E は未反映の警告を E の画面と E の API の応答の欄（`unreflected:true`）で出し、CLI の一覧・brief の文言は G へ送った（E §0.1 S3）。brief は既に `recorded` を区別し（`src/lib/brief/sources.ts:452`）、`unreflected` を出す（`:479`）。

| 何を | 正本 | F での扱い |
|---|---|---|
| 「未反映」の意味 | decision の `state` が `open`・`recorded`（E §1.1：`recorded` は「記録しただけで正本へ未反映」） | F は `state` を読むだけ。遷移は E だけ（E §0.2 E3：F の促しから E の書き込みを呼ぶ口を作らない） |
| 「期限超え」 | A の `memItemStaleness`（decision 14 日） | 同じ関数 |
| 「条件は成立したが未反映」 | B の評価の `unreflected:true` | `memList` の `conditions` を読む |
| 警告の文言 | E の画面の文（E §4.1）。CLI・brief の文言は G | F の文は「画面で承認・反映を確かめてください」の固定の 1 文だけで、E の画面へ人を送る。E の文を写さない |
| 判定の関数 | E が export するなら E の関数［未確認：E の設計に export の名前は無い］ | E がマージされた後の F の実装の契約で、E の export があれば呼ぶ。無ければ A・B の 2 つを F の `rules.ts` で組む（判定を写さないよう、組み方は「`state ∈ {open, recorded}` かつ (`stale` または `unreflected`)」の 1 式だけ） |

- F の促しは E の operation（進行中・不明、E §1.2）を見ない［見立て］：進行中の operation があっても項目はまだ未反映で、促しは人を画面へ送るだけ。画面が operation の印を出す（E §4.1）

---

## 6. `send --note` と自由入力の検査（決めること 6）

### 6.1 形

```
commandmate send <worktree-id> "<message>" --instance <id> --reply-to <target> --note "<目的の一言>"
```

- `--note` は `--reply-to` と一緒のときだけ受ける。無ければ **exit 2、何も送らない**（F3）
- 呼び手の身元（`whoami`）が無ければ exit 2（mem の項目の作成者が決まらない。A の書き込みは instance を要る：`mem.ts:209`）
- 送る本文（`<message>`）には足さない。`--json` の応答に `note: { itemId, state }` を足す

### 6.2 手順（既存の送信の順に、mem の書き込みを 1 つ挟む）

［事実］relay は本文を送る**前に**開く（`src/cli/commands/send.ts:1062-1073`：条件なしの経路。条件つきの経路は `:1003-1009`）。失敗は本文の前なので何も送っていない。

1. relay を開く（既存。ID が決まる）
2. **mem に書く**：既存の `POST /api/worktrees/<送り手の worktree>/mem/items`（A、`mem add` と同じ口）に `{ kind:'waiting', text:<note>, closeWhen:'relay:<id>', evidence:['relay:<id>'], key:'send-note:<relay id>', instanceId:<送り手> }`
   - 断られたら（mode が `on` でない＝exit 50、検査で 400、件数の上限 56、曖昧・未登録 52/53）：**relay を取り下げ**（既存の `cancelRelayQuietly`、`send.ts:1037`）、mem の exit code で終わる。**本文は送らない**［見立て：`--note` を付けた送信は、記録できなければ送らない。送ってから記録に失敗すると、意図の無い依頼が残る］
   - `key` で再試行が冪等（A §5.4）
3. 本文を送る（既存）
4. 送れなかったと確定した（`not-sent`）：既存の経路が relay を取り下げる。mem の項目は作成者として閉じる（`POST …/mem/items/<id>/close`、`reason:'send_not_sent'`）。閉じるのに失敗しても、relay が取り下げられたので B の評価が `relay` の条件で閉じる（B §1.5・§2）
5. 結果が不明（`indeterminate`）：何もしない。項目は relay の状態で B が閉じる

### 6.3 relay の事実を写さない（D2）

| 欄 | 入れるもの | 入れないもの |
|---|---|---|
| `text` | `--note` の文だけ（A の検査を通った値） | 相手の worktree・instance・送った時刻・本文の一部 |
| `close_when` | `relay:<id>` | — |
| `evidence` | `relay:<id>` だけ | — |
| 作成者・時刻 | A が付ける（送り手の instance・サーバの時刻） | — |

- 送った・相手・時刻・状態は relay の台帳（`getSessionRelaySummary`、`src/lib/db/relay-db.ts:201`）を brief（C の S3）と `commandmate relays` が都度読む
- CLI は `--note` の文を mem へ渡す前に**組み立てない**（相手の名前や relay の ID を文に足さない）

### 6.4 自由入力の検査

| 段 | 検査 | 正本 |
|---|---|---|
| 入口（保存） | A の `validateMemFields` の `text`（`now` 以外：1000 code point・制御文字・秘密らしい文字列：`src/lib/mem/validate.ts:113`・`:297`、`secret-scan.ts:21-45`） | サーバ。CLI の検査は便宜（A §6）。断った原文はどこにも残さない（A §7） |
| 出口（brief） | C の見えない文字の置き換え（`revealInvisible`・`sanitizeBriefField`、`src/lib/brief/sanitize.ts:88`・`:109`）と、A の出口の読み直し（`presentMemItem`、A §6.4） | C・A。F は出口を足さない |
| 出口（F の促し） | 自由入力を出さない（§3.4）ので検査の対象が無い | — |
| D12 | brief の中で、出所（`src=mem`）・作者・時刻つきのデータの区画として出る（C §3） | C |

- `--note` の文が CLI のエラーの表示で繰り返されない（A §7「CLI は stdin・引数で受けた原文を、エラーの表示で繰り返さない」）
- `--quiet` の手の command の引数に自由入力は無い（`--hook <event>` は表の語だけ）

---

## 7. 実装の範囲と、全入口の不変条件の表駆動の試験（決めること 7）

### 7.1 新規ファイル

| ファイル | 中身 | S |
|---|---|---|
| `src/lib/mem-suggest/rules.ts` | §3.2 の規則の表と判定（純関数） | — |
| `src/lib/mem-suggest/fingerprint.ts` | §4.1 | — |
| `src/lib/mem-suggest/service.ts` | `memSuggest(db, spec, { full, instanceId, hook }, deps)`。A・B・D1 の export を呼ぶだけ | — |
| `src/lib/db/suggestion-shown-db.ts`・`src/lib/db/migrations/v70-suggestion-shown.ts` | §4.2 | S3 |
| `src/app/api/worktrees/[id]/mem/suggest/route.ts` | §3.1 | S2 |
| `src/types/mem-suggest.ts` | §3.5 | — |
| `src/lib/hooks/mem-prompt-install.ts` | §2 の印のファイルの読み書きと `MEM_PROMPT_HOOK_EVENTS`（最初は空） | S1 |
| `src/cli/commands/mem-hooks.ts` | §2.1 | S1 |
| `tests/unit/guards/mem-suggest-no-resident-4226.test.ts` | §7.3 の I-F4 | — |
| `tests/unit/lib/mem-suggest/suggest-invariants.test.ts` | §7.3 の表 | — |

### 7.2 変える既存のファイル

| ファイル | 変更 | S |
|---|---|---|
| `src/cli/commands/mem.ts` | `check` に `--suggest`・`--quiet`・`--hook`。旗があるときだけ新しい route を呼ぶ分岐 1 つ。`mem hooks` の登録 1 行（S1） | S2（・S1） |
| `src/cli/types/index.ts` | `MemExitCode.SUGGESTED = 57` | S2 |
| `src/cli/commands/send.ts` | `--note`（§6） | — |
| `src/lib/db/migrations/runner.ts` | v70 の登録 | S3 |
| `src/lib/hooks/hook-settings-generator.ts`・`sources/codex/hooks-config.ts`・`sources/command-code/hooks-config.ts`・`sources/copilot/hook-settings.ts`・`sources/antigravity/hooks-config.ts`・`sources/gemini/settings-generator.ts` | 生成物に「導入の印のファイルにある出来事だけ」手を足す引数（既定は空＝今と 1 バイト同じ）。**実測（§1.3）が通ったツールだけ**変える | S1 |
| `docs/user-guide/cli-operations-guide.md` と `docs/en/` の対 | `mem check --suggest`・`send --note`・`mem hooks` の節。「意図の書き漏れまでは見つけない」「Agent のセッションからの導入を断るのは検査で保証ではない」を書く | — |

### 7.3 全入口の不変条件の表駆動の試験

入口（行）× 不変条件（列）を 1 つの表にし、同じ関数で当てる。状態は `os.tmpdir()` 配下の `fs.mkdtempSync` に DB（migration を全部当てた SQLite）・worktree の root・フックの設定ファイル・印のファイルを作り、`afterEach` で消す。本物の `~/.claude`・`~/.codex`・`~/.copilot`・`~/.gemini` には書かない（`CM_AGENT_HOOKS_DIR`・`CODEX_HOME` 等を一時ディレクトリへ向ける。`tests/setup.ts` の `CODEX_HOME` の pin と同じ）。

**入口**：

| # | 入口 |
|---|---|
| E-1 | `mem check --suggest`（テキスト） |
| E-2 | `mem check --suggest --json` |
| E-3 | `mem check --suggest --quiet`（フックの手から） |
| E-4 | `mem check --suggest --quiet --hook <event>` を、身元の無い環境（headless の `codex exec` の形）で |
| E-5 | 生成されたフックの設定（Claude・Codex・Command Code・Copilot・Antigravity・Gemini）［S1］ |
| E-6 | `mem hooks install`／`uninstall`［S1］ |
| E-7 | `send --note` |
| E-8 | brief（C の provider と CLI）— F が変えないことの陰性対照 |

**不変条件**：

| # | 不変条件 | 確かめ方 | 陽性対照（壊れた実装で落ちる） | 陰性対照（変わらない動き） |
|---|---|---|---|---|
| I-F1 | `off`・`derived` で促さない | E-1〜E-4 で mode `off`・`derived`：stdout 空、E-1・E-2 は exit 50、E-3・E-4 は exit 0。`suggestion_shown` の行が増えない。`promptOnEvents=false` の `on` も促しが 0 | mode を見ずに規則を当てる版、`derived` で `listMem` を読んで捨てる版（読みの回数 0 を偽で確かめる） | `on`・`promptOnEvents=true` で古い `now` の状態なら `now_stale` が出る |
| I-F2 | 同じ状態で 1 回 | E-3 を同じ状態で 3 回：1 回目だけ 1 行、2・3 回目は空。`now` を更新（`version+1`）して古くした状態で 1 回だけ出る。境界の ID・instance の世代を変えると 1 回出る。サーバの再起動（モジュールの再読み込み）の後も出ない（S3） | 記録を書かない版、指紋に時刻を入れる版（2 回目も出る）、鍵に境界を入れない版（新しい会話で出ない） | E-1 は同じ状態で毎回全部出す（§4.4）。別の instance には別に 1 回 |
| I-F3 | 既存のフックの設定が変わらない・冪等 | (a) 導入なし：E-5 の全ツールの生成物が今の生成物と 1 バイト同じ（既存の試験の期待を変えない）。(b) 利用者の手・他の鍵を置いたファイルに E-6 → 起動の生成 → もう一度 E-6 → 生成：ファイルが 1 回目と 1 バイト同じ、利用者の手が順も含めて残る、CommandMate の手が各出来事に 1 つ。(c) `uninstall` の後の生成が (a) と同じ。(d) 読めない JSON のファイルは書かない | 新しい手に別の印を付けた版（2 回目で手が 2 つになる）、利用者の手を外す版、導入なしでも手を足す版 | 既存の merge の試験（`mergeCodexHookSettings` 等）が変えずに通る |
| I-F4 | モデルの実行と常駐の見張りが増えない | 静的（ガード）：`src/lib/mem-suggest/**`・`src/lib/db/suggestion-shown-db.ts`・新しい route・`src/cli/commands/mem-hooks.ts` に `setInterval`・`setTimeout`・`setImmediate`・`new Worker`・`fork(`・`detached: true`・`.unref(`・`schedule-manager`/`timer-manager` の import・LLM の SDK・`@/lib/report`・`child_process` が無い。サーバの起動の経路（`server.ts`・`src/lib/server/**`）が `@/lib/mem-suggest` を import しない（B の G1・G2 と同じ形）。動的：`vi.useFakeTimers()` で E-1〜E-3 の後に `vi.getTimerCount() === 0`。E-3 で `execFile` の偽が 0 回（照会しない）。tmux への送信の偽が 0 回（Agent へ文を送らない） | ガードの走査に `setInterval(` を含む文字列・`execFile` を呼ぶ版を渡すと違反。E-3 で `memList`（評価つき）を呼ぶ版は `execFile` の偽が 1 回以上で落ちる | E-1 の評価は B の照会（`git`/`gh`）だけを呼ぶ（B の期限の helper のタイマーは評価の終わりで 0） |
| I-F5 | `--note` が relay を参照し、relay の事実を写さない | E-7 で作られた項目：kind `waiting`、`closeWhen=relay:<id>`、`evidence=[relay:<id>]`、`text` が `--note` の文と同じ。項目の全欄（`--json` の全鍵）に相手の worktree ID・instance ID・送った時刻の文字列が現れない。relay の取り下げ → B の評価で閉じる | 文に相手の名前を足す版、`evidence` に相手の worktree を足す版、`--reply-to` 無しでも書く版（exit 2 にならず落ちる） | `--note` の無い `send` の body・relay・exit が今と同じ（既存の send の試験が変えずに通る） |
| I-F6 | 記録できない `--note` は送らない | mode `off`・秘密らしい文字列・件数の上限で、送信の偽が 0 回・relay が取り下げられる・exit が mem の code | 送ってから書く版 | mode `on` の正しい `--note` は送り、項目が 1 つ |
| I-F7 | 促しの文に自由入力が出ない | 項目の本文・ブランチ名に目印の文字列・秘密判定の fixture（`ghp_`＋36 文字）・U+202E・BOM を入れ、E-1〜E-3 の stdout・stderr・`--json` に現れない | `message` に項目の `text` を入れる版 | 項目 ID・版・code は出る |
| I-F8 | フックの手は止めない・身元が無ければ黙る | E-3・E-4 の全ての状況（§3.3 の表の全行・サーバに届かない・旗の誤り）で exit 0。E-4 は stdout が空で `suggestion_shown` が増えない | 誤りで exit 2 を返す版（Claude・Command Code の `Stop` を止める） | E-1 の旗の誤りは exit 2 |
| I-F9 | F は brief を変えない | E-8：F の実装の前後で C の `brief-invariants.test.ts` が変えずに通る。`getBriefProvider()` の既定は D2 の決めたまま | brief に促しの行を足す版が C の I1・I14（予算・固定の部分）で落ちる | — |

試験のファイル：`tests/unit/lib/mem-suggest/suggest-invariants.test.ts`（E-1〜E-4・E-7）、`tests/unit/lib/hooks/mem-prompt-install.test.ts`（E-5・E-6、S1）、`tests/unit/guards/mem-suggest-no-resident-4226.test.ts`（I-F4 の静的）。確認のコマンドは `npx vitest run <これらのファイル> tests/unit/guards tests/unit/docs`・`npm run lint`・`npx tsc --noEmit`。

### 7.4 実装の分け方［見立て］

1. **F-1**（S2・S3 の答えの後）：§3〜§6 と I-F1・I-F2・I-F4〜I-F9。フックの手は置かない（全ツール「戻せない」で、代わりの経路だけ）
2. **F-2**（S1 の答えと §1.3 の実測の後）：§2 と I-F3。実測が通ったツールの行だけ
3. H（#4228）が `mem check --suggest` を skill の手順に入れる

---

## 8. 未確認・未決（レビューで見てほしい点）

| # | 点 | 影響 |
|---|---|---|
| U-F1〜U-F5 | §1.3 の実測 | S1 で手を足すツール |
| U-F6 | Codex の hooks.json に手を足したとき、trust のレビューがもう一度出るか（§1.1） | 出るなら、Codex の導入は「人がレビュー画面で 1 回 trust する」手順を `mem hooks install` の出力に書く |
| U-F7 | 会話の要約を D1・D2 の境界にするか（D1 §2.2 の注は「しない」） | しないままなら、要約の直前に戻せないツールでは、その時点の代わりの経路が無い。境界にするなら D1・D2 の変更で、F の範囲の外 |
| U-F8 | 規則の対象を「呼び手が作成者の項目」に絞る（§3.2）でよいか | 絞らないと、同じブランチの他のセッションの項目まで促す |
| U-F9 | `--note` を記録できないとき送らない（§6.2 の 2）でよいか。代わりは「送って記録しない（stderr に警告）」 | 送らない方は、mode を `off` にしたブランチで `--note` を付けた依頼がすべて止まる |
| U-F10 | E が未反映の判定を export するか（§5.2） | しなければ F の `rules.ts` に 1 式を置く |
| U-F11 | `promptOnEvents` を「促しの全部」の切り替えにする（§3.3：`false` なら明示の `--suggest` も 0 件）でよいか。代わりは「フックの手（`--quiet`）だけを切り替える」 | 代わりを採ると、明示の `--suggest` は `promptOnEvents` に依らず答える |

---

## 9. 対になる場所（探した結果）

| 探した対象 | 結果 |
|---|---|
| 促しの単位の写し：CLI（`mem check`）と画面（G #4227） | 画面の mem の表示は未実装（G）。G は同じ `memItemStaleness` を使う（A §8.2）。F の規則の表を G が読むかは G の判断。F は画面を変えない |
| フックの設定の生成：ツールごとの実装 | 6 つ（Claude・Codex・Command Code・Copilot・Antigravity・Gemini）。OpenCode・OpenCode V2・vibe-local は設定を書かない（§1.1）。§7.2 に全部挙げた |
| 型の写し（`src/cli/types/`） | `MemExitCode`（`src/cli/types/index.ts:890-906`）。`MemCommonOptions`（`:910-917`）に `suggest`・`quiet`・`hook` を足すかは S2 の実装で決める |
| 説明（`docs/` の ja と en） | `docs/user-guide/cli-operations-guide.md` と `docs/en/` の対（§7.2）。CLAUDE.md の CLI の節は「踏むと事故になる規則」だけなので、`send --note` に `--reply-to` が要ること（exit 2）を 1 行足すかを実装の契約で決める |
| 古い動きを固定する試験 | 生成物を 1 バイトで固定する試験（例：`CM_AGENT_HOOKS_INJECT=0` で起動コマンドが同じ：CHANGELOG #1760）。導入なしで生成物を変えないので変わらない（I-F3 の (a)） |
| D2 のガード `hook-no-brief-output-4224` | 未マージ。F の手は `brief` を呼ばない・中継ではないので衝突しない（§2.4）。D2 がマージされた後の F-2 の契約で、ガードが F の手を「stdout に書く手」として落とさないかを確かめる |

---

## 10. 本文に無い指摘（この設計の範囲外。直さない）

- `mem check --json` の `branch` は生のブランチ名を出している（`src/lib/mem/service.ts:616`）。C は brief の出口でブランチ名を置き換える（`src/lib/brief/sanitize.ts:126`）。`mem list`・`mem check` の `--json` の出口の扱いは A・B の範囲（F の `--json` だけ C に揃える、§3.5）
- `cmate-agent-event.sh` の注（`:96-100`）は Codex の `PreCompact`・`PostCompact` を「実在する」と書くが、`tests/fixtures/hooks/codex/` に採取が無い（`session-start.json` 等 7 件だけ）。U-F3 の実測で採取を足す
