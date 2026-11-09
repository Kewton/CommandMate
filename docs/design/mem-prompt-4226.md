# 既存のフックと操作の出来事を使って mem の更新を促す（Issue #4226 / Epic #4220 の子 F）設計

- 状態：設計の段（実装前）。**第 2 版**。第 1 版（`c12689c59`）の止める点 S1〜S3 に PM の決定（2026-11-09）が出て、Codex の事前レビュー（P1 2 件・P2 7 件・P3 1 件）を処置した。処置の一覧は §11
- 前提：Epic #4220 の決定事項 D1〜D13。とくに D1（モデルを呼ばない）・D2（導けるものは書かない）・D3（既定は off、有効にするのは人）・D8（新しい常駐・定期の実行を足さない）・D12（記録はデータとして区切る・自由入力の検査）
- 読んだ設計：A `docs/design/mem-store-4221.md`・B `mem-close-when-4222.md`・C `brief-4223.md`・D1 `session-boundary-brief-4274.md`（develop にマージ済み）。D2（`../commandmate-issue-4224` の `HEAD:docs/design/brief-injection-d2-4224.md`）・E（`../commandmate-issue-4225` の `HEAD:docs/design/mem-promote-4225.md`）は読むだけ（未マージ）
- 凡例：**［事実］** = この文書を書いた時点（2026-11-09、`feature/4226-worktree` = develop `55b8192e0` の上）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. 冒頭

### 0.1 止める点（決定済み）

第 1 版の止める点 3 つは、PM の決定（2026-11-09、人が PM の推奨に委任した範囲）で次のとおり決まった。**この版で新たに止める点は無い**（理由は表の下）。

| # | 止める点（第 1 版） | 決定 | この版での作り |
|---|---|---|---|
| **S1** | Agent の文脈へ一言を戻すには、既存のフックの設定の生成に「出力を文脈へ返す手」を 1 つ足す必要がある（今の手はどれも何も返さない：中継は応答を捨てる `scripts/hooks/cmate-agent-event.sh:352` の `curl "$@" >/dev/null`） | **採らない** | 文脈へ戻す手を**どのツールにも足さない**。全ツールが §1.1 の「代わり」の行になる：D2 の境界の brief（R1）と、`mem check --suggest` を Agent・skill（H #4228）が呼ぶ（R2）。フックの設定の生成（`hook-settings-generator.ts`・各 `sources/*/hooks-config.ts` 等）は 1 バイトも変えない。§2（導入の操作 `mem hooks`）は作らない。Codex の S1 への指摘（所有判定の識別形・出来事ごとの出力形式・trust の hash・フックの実行順と境界）は「S1 不採用」として処置し、**実測して手を足すときの条件**として §8.2 に残す（PM が追跡 #4289 に写す） |
| **S2** | `commandmate mem check --suggest` は A の CLI のファイル（`src/cli/commands/mem.ts`）の `check` に旗を足し、`MemExitCode` に 1 つ足す必要がある | **採る**（`MemExitCode.SUGGESTED = 57`） | §3.1 の CLI の契約で、57 を返す経路（`run()` の 1 か所）・足す全部の旗（`--suggest`・`--quiet`・`--hook`・`--instance`）・parser の段の扱いを具体化した。**`service.ts`・`mem-db.ts`・B の評価は変えない** |
| **S3** | 「同じ状態で 1 回」を再起動の後まで保つには新しい表（migration）が要る | **メモリだけで持つ**（migration を足さない） | §4.2。サーバーのプロセスのメモリの `Map`。**サーバーの再起動の後に 1 回だけ繰り返す**、**容量（1,000 件）を超えて追い出した鍵に戻ったとき 1 回だけ繰り返す**、を既知の制限として書く（§4.5） |

止める点が無いと判断した理由：

- **S3 を永続化しないと受入基準に反するか**：受入基準「同じ状態で同じ促しが繰り返されない」に対し、メモリだけの記録は「再起動の後」「追い出しの後」に 1 回だけ繰り返す。Codex の事前レビューはこれを P2（受入基準に反する P1 ではない）とし、繰り返しは 1 回で、規則は状態が変わらない限り増えない（§4.5）。PM の決定の「P1 のときだけ戻す」に当たらないので、既知の制限として書いて進める［見立て］
- **P1 の 2 件の処置**は、F の新しいファイル（§3.6 の寿命の固定と再確認）と `send.ts` の `--note` の段（§6.2）で済み、A・B・C・D1 のファイルの作り直しは要らない。寿命の比較は D1 の export（`readInstanceLifetime`・`isSameInstanceLifetime`、`src/lib/db/session-brief-db.ts:174`・`:201`）、mode の読み直しは A の export（`decideRootMode`、`src/lib/db/mem-db.ts:254`）を呼ぶだけ
- **D1〜D13 と違う作りは要らない**。A・B・C・D1 のファイル（`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`src/lib/session/brief-provider.ts`・`session-brief.ts`・`src/lib/db/session-brief-db.ts`）は、S2 の `mem.ts` の変更（§3.1）と `MemExitCode` の 1 行のほかは変えない。D2（#4224）・E（#4225）の worktree とファイルには触らない

### 0.2 D・A・Issue の文面だけでは一意に決まらず、この文書が選んだ解釈

| # | 文面 | 選んだ解釈［見立て］ | 理由 |
|---|---|---|---|
| F1 | Issue「導入は新しい opt-in の操作」と D3「有効にするのは人だけ。変える経路は画面だけ」 | opt-in は **A が既に置いた `features.promptOnEvents`**（`src/types/mem.ts:117-123`、`src/lib/db/mem-db.ts:254-260`、既定 `false`）を人が画面で `true` にすること（A §11）。S1 を採らないので、フックの手を置く 2 段目の操作（第 1 版 §2 の `mem hooks install`）は無い | D3 の「有効にする」は mode と feature の話で、A がその置き場を作っている。S1 を採らないので、各ツールのフックの設定ファイルは F が変えない |
| F2 | Issue「会話の要約の直前：戻せるツールでは一言を戻す」 | 戻せるツールは**無い**（S1 不採用）。要約の直前は R2（H の skill が `mem check --suggest --quiet` を呼ぶ手順）が代わり。戻す文の形（§3.4 の固定の 1 行）は R2 の出力として使う | D1（モデルを呼ばない・テンプレート）、D12（記録はデータとして区切る）。本文は brief（C）の区切りの中で読む |
| F3 | Issue「`send --note "<text>"` … relay への参照と一緒に mem に残す」 | `--note` は `--reply-to`（relay を開く送信）と一緒のときだけ受ける。mem には kind `waiting`・`close_when=relay:<id>`・`evidence=[relay:<id>]`・`text=<note>` の 1 項目として書く。**送る本文には足さない**（§6） | relay が無い送信には「参照する relay」が無い。`waiting` は「相手の返事を待つ」を型で書ける唯一の kind で、`relay` の条件を受ける（A §2.3）。本文に足すと利用者の本文を変え、#2464 の予算にも入る |
| F4 | Issue「ターンの終わり」 | ターンの終わりの出来事（`Stop` 等）で文脈へ一言を戻す手は**どのツールでも作らない**（§1.1） | ターンの終わりに文脈へ何かを戻す形は、どれも**モデルにもう 1 ターン走らせる**：Command Code の `decision:"block"`／exit 2（`command-code/hooks-config.ts:84-89`）、Antigravity の `continue`（`antigravity/hooks-config.ts:45-48`）、Claude の `Stop` の `decision:"block"` と、エラーでない `additionalContext`（Claude の公式の hooks の仕様［未確認：このリポジトリでの実測は無い］。Codex の事前レビューの指摘）。**追加のモデルの実行を避けるため使わない**（受入基準「モデルの実行が増えない」） |

---

## 1. ツールごとの表（決めること 1）

### 1.1 表

列の読み方：**出来事** = その時点の出来事を CommandMate の既存の配線が受けているか（○ 受けている／△ ツールに出来事はあるが配線していない／× ツールに無い・分からない）。**戻せるか** = Agent の文脈へ一言を戻すか。S1 を採らないので**全部「戻さない」**。**代わり** = その時点の代わりの経路（§1.2 の R1〜R4）。

| ツール（配線の正本） | 開始 | 会話の要約の直前 | ターンの終わり |
|---|---|---|---|
| **Claude Code**（#1722。`hook-settings-generator.ts:515-560`、起動ごとに `--settings` で渡す：`:595-626`） | 出来事 ○ `SessionStart`（`type:"command"`、`:531-540`）。戻せるか：**戻さない**（中継は stdout に書かない、`cmate-agent-event.sh:352`。S1 不採用）。代わり：R1（D1・D2 の境界の brief。D1 §2.2 で Claude は ○） | 出来事 △ `PreCompact` は生成に無い（`:530-556` の鍵に無い）。中継も名前で断る（`cmate-agent-event.sh:97`）。戻せるか：戻さない。代わり：R2（H の skill が要約の前の手順として呼ぶ）。要約は境界ではない（D1 §2.2 の注：`SessionStart(source=compact)` は境界にしない）ので brief も付かない | 出来事 ○ `Stop`（http、`:543`）。戻せるか：戻さない（F4）。代わり：R1（次の境界の brief） |
| **Codex**（#1760。`$CODEX_HOME/hooks.json` 1 本を全セッションで共有：`codex/hooks-config.ts:141`・`:264-277`・`:635-656`・`:672-728`） | 出来事 ○ `SessionStart`（最初のターンの送信時に来る：D1 §2.2）。戻せるか：戻さない。代わり：R1（D1 §2.2 で ○） | 出来事 △ `PreCompact` はツールにある（`cmate-agent-event.sh:97-98` の注）が登録していない（`CODEX_REGISTERED_EVENTS`、`:264-270`）。戻せるか：戻さない。代わり：R2 | 出来事 ○ `Stop`。戻せるか：戻さない（F4）。代わり：R1 |
| **Command Code**（#2251。worktree の `.commandcode/settings.local.json` に merge：`command-code/hooks-config.ts:122-130`・`:162-167`・`:345-368`） | 出来事 ○ `SessionStart`（打つ前に来る：D1 §2.2）。戻せるか：戻さない。代わり：R1 | 出来事 × ツールのフックは 4 語だけ（`:13`、`["PreToolUse","PostToolUse","Stop","SessionStart"]`）。代わり：R2 | 出来事 ○ `Stop`。戻せるか：戻さない（F4）。代わり：R1 |
| **Copilot**（`copilot/hook-settings.ts`、`~/.copilot/settings.json` に印 `cmate-copilot-agent-hooks` で merge：`:63-70`・`:173`・`:245-251`・`:536-560`） | 出来事 ○ `SessionStart`（ただし `UserPromptSubmit` の後に来る：D1 §2.2 が引く `copilot/source.ts:53-64`）。戻せるか：戻さない。代わり：**境界の brief も無い**（D1 §2.2：未対応のツール）。R4（`send --with-brief`）と R2 | 出来事 ×［未確認：ツールに要約の前の出来事があるか］。代わり：R2 | 出来事 ○ `Stop`。戻せるか：戻さない。代わり：R4・R2 |
| **Antigravity**（`antigravity/hooks-config.ts`、`~/.gemini` の下の agy の設定に名前 `commandmate` で merge：`:94-112`・`:124-128`・`:403`） | 出来事 ○ `SessionStart`。戻せるか：戻さない（「返事の契約が無い」：`:49`）。代わり：R4・R2（D1 は未対応） | 出来事 ×［未確認］。代わり：R2 | 出来事 ○ `Stop`。戻せるか：戻さない（`continue` は止まるのを断る：`:45-48`。F4）。代わり：R4・R2 |
| **Gemini**（`gemini/settings-generator.ts`、worktree の `.gemini/settings.json` に merge：`:15-22`・`:108-114`・`:264-288`） | 出来事 ○ `SessionStart`。戻せるか：戻さない。代わり：R4・R2（D1 は未対応） | 出来事 △ `PreCompress` はツールにある（`gemini/event-vocabulary.ts:22-27`、採取済み）が登録していない。代わり：R2 | 出来事 ○ `AfterAgent`（`stop`、`:111`）。戻せるか：戻さない（F4 と同じ扱い）。代わり：R4・R2 |
| **OpenCode**（`opencode/source.ts:1-20`：設定を書かず、サーバから購読する。`configScope:'none'`） | 出来事 ○（購読の `session_start` 相当。`OPENCODE_SUPPORTED_EVENTS = AGENT_EVENT_TYPES`：`:112`）。戻せるか：戻さない（フックの手を置く場所が無い。購読は観測だけ）。代わり：R4・R2 | 出来事 ×（transcript に `compaction` の部品は読める：`opencode/transcript.ts:42`。事後で、出来事ではない）。代わり：R2 | 出来事 ○ `stop`。戻せるか：戻さない。代わり：R4・R2 |
| **OpenCode V2**（`opencode-v2/source.ts:288-296`：`configScope:'none'`） | 出来事 ×（`supportedEvents` は `user_prompt_submit`・`stop`・`notification` だけで、`session_start` が無い：`:292`）。代わり：R4・R2 | 出来事 ×。代わり：R2 | 出来事 ○ `stop`。戻せるか：戻さない。代わり：R4・R2 |
| vibe-local・legacy-relay | 出来事 ×（`supportedEvents: []`：`legacy-relay.ts:63`）。代わり：R4・R2 | ×。代わり：R2 | ×。代わり：R4・R2 |

**まとめ［事実と決定］**：Agent の文脈へ一言を戻す組は **0**（今の配線にも無く、S1 不採用で足さない）。全ツールの全時点が §1.2 の代わりの経路になる。受入基準「未対応の出来事では代替の経路になる」は、全部の出来事を「未対応」として満たす。**ターンの終わりは全ツールで戻さない**（F4）。

### 1.2 代わりの経路（全ツール共通）

| # | 経路 | 何が出るか | 根拠 |
|---|---|---|---|
| R1 | **D2 の次の境界の brief**（D1 が境界を検出する Claude・Codex・Command Code） | brief の各項目に既にある `stale`・`unreflected`・条件の結果（`src/lib/brief/sources.ts:479-480`［事実］）と、D2 が足す「終わる前の更新を確認できない」の 1 行（D2 §7.1） | **C・D2 のファイルを変えずに**、F の規則のうち「古い」「未反映」「条件が成立」は brief で読める。F は brief に行を足さない（C・D2 の予算と固定の先頭を変えない。§3.7） |
| R2 | **`commandmate mem check --suggest` を Agent・skill が呼ぶ**（全ツール） | §3.2 の規則の一覧。skill の手順からは `--quiet`（新しい促しだけ 1 行、§3.4） | H（#4228 の `cmate-handoff`）がターンの区切り・要約の前の手順として呼ぶ（H の範囲） |
| R3 | 要約の後の「要約があった」 | 使わない［見立て］ | transcript の要約の行（`isCompactSummary`、`src/lib/hooks/sources/claude/transcript.ts:283-284`）は事後の観測で、D1 は要約を境界にしない（D1 §2.2）。境界にするかは D1・D2 の判断で、F では変えない（§8 の U-F7） |
| R4 | 送信の明示の口 `send --with-brief`（D1 §7.3） | brief をその送信に付ける | 境界を検出しないツール（Copilot・Antigravity・Gemini・OpenCode・OpenCode V2） |

**ターンの終わりに CommandMate が何かを送ることはしない**：Agent へ文を送るとモデルが 1 ターン走る（受入基準「モデルの実行が増えない」に反する）。`Stop` の出来事で F が行うのは何も無い（記録も作らない。§4 の記録は促しを**出した**ときだけ書く）。

### 1.3 実測（S1 を後で採るときの前提。この版では行わない）

S1 不採用なので、この版の実装は実測を前提にしない。後で文脈へ戻す手を足すときに確かめることと条件は §8.2 にまとめた（U-F1〜U-F6）。

---

## 2. 導入（決めること 2）

S1 を採らないので、**フックの設定へ手を足す導入の操作（第 1 版の `commandmate mem hooks status|install|uninstall`）は作らない**。

| 受入基準・範囲 | この版での満たし方 |
|---|---|
| 「既存の配線を使い、別の配線を増やさない」 | F は配線を足さない。新しい route（§3.1）は CLI が呼ぶ HTTP の口で、フックの配線ではない |
| 「導入は新しい opt-in の操作」 | 人が画面で `features.promptOnEvents` を `true` にする（F1。A の置き場、変える経路は画面だけ：A §11） |
| 「既存のフックの設定が保たれる」 | F はフックの設定の生成・merge の関数とファイルを変えない。試験（§7.3 の I-F3）は全ツールの生成物が F の前後で 1 バイト同じことと、F の新しいファイルがフックの生成の module を import しないことを固定する |
| 「導入を 2 回しても同じ状態になる」 | `promptOnEvents=true` を 2 回保存しても設定は同じ（A の設定の保存は値で置き換える）。F が持つ状態は §4 の表示の記録だけで、導入の操作では作らない |

---

## 3. `commandmate mem check --suggest [--quiet] [--json]`（決めること 3）

### 3.1 CLI の契約（S2 の具体化）

```
commandmate mem check --suggest [--worktree <id>] [--instance <id>] [--json] [--token <t>]
commandmate mem check --suggest --quiet [--hook <event>] [--worktree <id>] [--instance <id>] [--token <t>]
```

**足す旗（`check` にだけ。他の subcommand には足さない）**：

| 旗 | commander の宣言 | 意味 |
|---|---|---|
| `--suggest` | `.option('--suggest', …)` | 促しの規則を当てる。無ければ旗を足す前の `check` と同じ |
| `--quiet` | `.option('--quiet', …)` | 新しい促しだけを 1 行。exit は常に 0（下の「quiet の範囲」） |
| `--hook [event]` | **値を省ける形**（`[event]`）で宣言する | 呼び出した時点の印（`session_start`・`pre_compact`・`turn_end`・`manual` の表 `MEM_SUGGEST_HOOK_EVENTS`）。ログと `--json` に出すだけで、規則は変えない。値を省ける形にするのは、値の無い `--hook` を parser でなく action で受けるため（quiet で 0 にできる） |
| `--instance <id>` | `.option('--instance <id>', …)`。`withTargetOptions(…, false)` の読みの組には無いので、`check` にだけ直接足す［事実：`src/cli/commands/mem.ts:204-212` の `withTargetOptions` は read で `--instance` を足さない］ | `now_*` の規則の対象の instance。無ければ `whoami` の身元（同じ worktree のとき） |

`MemCommonOptions`（`src/cli/types/index.ts:910-917`）には足さず、`check` の action の型に `{ suggest?: boolean; quiet?: boolean; hook?: string | true }` を足す（`instance` は既に `MemCommonOptions` にある）。

**57 を返す経路**：今の `run()`（`src/cli/commands/mem.ts:179-188`）は成功のとき必ず `process.exit(MemExitCode.SUCCESS)` で終わる［事実］。`run()` の `action` の型を `(client) => Promise<void | number>` にし、成功のときは `process.exit(returned ?? MemExitCode.SUCCESS)` にする（1 か所）。`check --suggest` の action だけが `MemExitCode.SUGGESTED`（57）を返す。他の subcommand は何も返さないので 0 のまま（陰性対照：既存の `mem` の CLI の試験が変えずに通る）。

**旗の組み合わせ（action に入った最初の段で、要求を送る前に決める）**：

| 組み合わせ | `--quiet` 無し | `--quiet` 有り |
|---|---|---|
| `--suggest` 無しで `--quiet`・`--hook`・`--instance` のどれか | exit 2（`invalid_request`、`field` に旗の名）。**旗を足す前の `check` は旗を受けなかったので、今の呼び出しは何も変わらない** | `--quiet` があれば exit 0、stderr に 1 行、stdout は空 |
| `--suggest` と `--branch` か `--repository` | exit 2（`target_required`：suggest は worktree と instance の単位で、ブランチを外から選ばない） | exit 0、stderr に 1 行 |
| `--hook` が値なし・表に無い語 | exit 2（`invalid_request`、`field=hook`） | exit 0、stderr に 1 行 |
| `--quiet` と `--json` | （該当なし） | **quiet が勝つ**：stdout は空、stderr に 1 行、exit 0（quiet の出力の形は 1 つだけにする） |
| `--quiet` と `--instance` が身元の instance と違う | （該当なし） | 何もせず exit 0（quiet は表示の記録を消費するので、他の instance の記録を消費させない。§4.4） |

**parser の段の扱い（quiet の「常に 0」の範囲）**：commander が action の前に断るもの（知らない旗、値の要る `--worktree`・`--instance`・`--token` の値なし）は、**今の `commandmate` 全体と同じく commander の既定（stderr と exit 1）のまま**にする。quiet の「常に 0」は **action に入った後**の全部（上の表の誤り・身元・サーバ・mode・期限）に当てる。理由：`check` に `exitOverride` を足すと旗の無い `check` の parser の誤りの exit も変わる（既存の契約を変える）。quiet を呼ぶのは H の skill の固定の文で、parser の誤りは H の試験で落とせる［見立て］。値の無い `--hook` は宣言を値を省ける形にしたので action に入る（上の表）。

**route**：`--suggest` は **新しい route `POST /api/worktrees/:id/mem/suggest`**（body `{ instanceId?: string, full: boolean, hook?: string }`）を呼ぶ。`full=false`（quiet）は表示を記録し、`full=true` は B の評価で項目を閉じうるので、どちらも副作用があり GET にしない（第 1 版の GET を改めた）。route は F の lib `src/lib/mem-suggest/service.ts` の `memSuggest` を呼ぶ。

- `--suggest` が無い `mem check` は今のまま（B の評価と close。出力・exit を変えない）
- `full=true`（`--suggest`、`--quiet` なし）は B の評価を 1 回走らせる：A・B の既存の export `memList`（`src/lib/mem/service.ts:527`）を呼ぶ。**`memList` は mode `on` で評価し、成立した条件で閉じる**（A §4、B §4）ので、副作用は `mem list` と同じで、それより増えない
- `full=false`（quiet）は**条件の評価の照会（B の `git`・`gh`）をしない**。ただし**所属の確認の git はする**（§3.6）：A の `withMemTarget`（`src/lib/mem/target.ts:116`）の既定は worktree の HEAD を `observeWorktreeHead`（`src/lib/mem/git-observe.ts:23`）で読み、`git symbolic-ref`・`git rev-parse`・`git-common-dir` の確かめを順に走らせる［事実］。DB に残ったブランチ名で代用しない（古いブランチで mode を決めると、切り替えた後のブランチの `off` を破る）

**exit の契約**：

| 状況 | `--suggest`（テキスト・`--json`） | `--suggest --quiet` |
|---|---|---|
| mode `on`・`promptOnEvents=true`・促しが 1 つ以上 | **exit 57**（`MemExitCode.SUGGESTED`）。テキストは 1 行に 1 つ、`--json` は §3.5 | 新しい促し（§4 で未表示）だけを §3.4 の 1 行で出し、表示を記録する。**exit 0** |
| 同・促しが 0 | exit 0。テキストは何も出さない、`--json` は `suggestions: []` | 何も出さない。exit 0 |
| 同・促しはあるが全部表示済み | exit 57（明示の呼び出しは表示済みでも全部出す。表示を記録しない） | 何も出さない。exit 0 |
| mode `on`・`promptOnEvents=false` | exit 0、`suggestions: []`、`--json` に `disabledBy: "promptOnEvents"` | 何も出さない。exit 0 |
| mode `off`・`derived` | **stdout に何も出さない**、stderr に 1 行、exit 50（A の `mem check` と同じ） | 何も出さない。exit 0 |
| 要求の途中で mode・`promptOnEvents`・instance や worktree の寿命・ブランチが変わった（§3.6） | exit 0、`suggestions: []`、`--json` に `discarded: "<理由の語>"`、stderr に「状態が変わったのでもう一度」の 1 行 | 何も出さない。記録しない。exit 0 |
| 曖昧・未登録・worktree が無い | exit 53／52（A §12.1） | 何も出さない。exit 0 |
| 身元が無い（`--instance` も無い） | `now_*` を除いて当てる（§3.2 の `unavailable`）。exit は上と同じ | 何も出さない。exit 0（身元の無い呼び出しは記録の鍵が決まらない） |
| サーバに届かない・認証の失敗 | A の CLI の既存の扱い（exit 1・99 等） | 何も出さない。exit 0（fail-open。理由は stderr に 1 行） |
| quiet の期限（§3.6）を超えた | （期限なし。B の `check` と同じ 10 秒の評価の期限：B §7 G5） | 何も出さない。exit 0 |
| action の中の旗の誤り（上の表） | exit 2 | **exit 0**、stderr に 1 行 |

- `--quiet` が表示を記録するのは mode `on` かつ `promptOnEvents=true` のときだけ。`off`・`derived` では何も書かない（A §4 の「F：更新の促し」の行のとおり）。記録はメモリだけ（§4.2）で、DB には書かない

### 3.2 規則の一覧

材料はすべて A・B・C・D1 の正本の読み。**項目の本文は材料にも出力にも使わない**（ID・kind・状態・時刻・版・条件の結果・所有者だけ）。**意図の書き漏れ（書くべきだったのに書かれていない意図）を見つけるとは約束しない**：規則は「書かれた項目の状態」と「`now` の枠が空」しか見ない。

**材料の取り方（Codex の指摘：`memList` の応答だけでは揃わない）**［事実］：

- `memList` の応答の `items`・`now` は `presentMemItem` を通した表示の形で、`withheld` の項目は `promoteTo`・`evidence` を落とす（`MEM_WITHHELD_KEPT_KEYS`、`src/types/mem.ts:100-114`）
- 成立して閉じた `now` は枠から消え（`closeMemItemByCondition`、`src/lib/db/mem-db.ts:1060-1083`）、既定の一覧にも残らない。`conditions` は ID → 条件の結果だけ（`conditionsById`、`src/lib/mem/service.ts:584-588`）で kind・所有者・版を持たない
- `listMem`（`src/lib/db/mem-db.ts:954`）は表示の前の `MemRecord`（`src/lib/mem/present.ts:28-48`：`promoteTo`・`evidence`・`owner`・`version` を持つ）を返すが、`warnings` は持たない。`warnings` は `memList` の中の private の `openWarnings`（`service.ts:311-320`：`countOpenItems(...) >= MEM_OPEN_LIMITS[kind].warn`）が作る

そこで F は次の 3 つを材料にする：(a) `listMem` の `MemRecord`（両方の経路。scope は §3.6 で固定した target の 4 つの欄 `storageRepositoryId`・`readRepositoryIds`・branch・worktreeId から作る。`service.ts:163-170` の `scopeOf` と同じ欄）、(b) `full=true` のときだけ `memList` の `conditions`、(c) 閉じた項目の所有者と版は `getMemRecord`（`mem-db.ts:651`）で ID から引き直す。

| code | 意味 | 判定の材料 | quiet | `unavailable` になるとき（促さず `skipped` に理由を出す） | 指紋（§4.1）に入れるもの |
|---|---|---|---|---|---|
| `now_missing` | 呼び手の instance に `now` が無い | (a) の `now` に呼び手の (worktree, instance) の行が無い。roster に居る instance だけ（`resolveAgentInstances`、C の S1）。`full=true` で同じ回に `now_condition_met` が出たら出さない | ○ | 呼び手の instance が分からない（`no_instance`） | code・instance・「無い」 |
| `now_stale` | 呼び手の `now` が古い | `memItemStaleness`（`src/lib/mem/staleness.ts:22-34`、`now` は 1 日）が `stale` | ○ | 同上 | `now` の item ID・`version` |
| `now_condition_met` | 呼び手の `now` の条件が成立して閉じた | (b) の `conditions[id]` が `result:'met'` かつ `closed:true` で、(c) の記録の kind が `now`、`owner.worktreeId` が呼び手の worktree、`owner.instanceId` が呼び手の instance、`owner.incarnation` が §3.6 で固定した instance の世代と同じ。**版の競合で閉じなかった**（`closeMemItemByCondition` が null → `closed:false`）ものは当てない（枠に残り、`now_stale` 等で見る） | ×（評価が要る） | quiet（`quiet_no_query`）／(c) が引けない（`record_gone`） | item ID・閉じた後の `version`・`met` |
| `decision_unreflected` | decision が未反映のまま古い | `state` が `open`・`recorded` で `memItemStaleness` が `stale`（decision は 14 日、A §8.2）。`full=true` ではさらに (b) の `unreflected:true`（`evaluate.ts:443`、B §5） | ○（古さだけ） | — | item ID・`version`・`state` |
| `manual_stale` | 閉じる条件が `manual` の open 項目が古い | `memItemStaleness` が `stale` で kind が `next`・`external`・`note`（`manual` を受ける kind、A §2.3） | ○ | — | item ID・`version` |
| `open_count` | open の件数が警告の数に達した | `full=true`：`memList` の `warnings` の `open_count`。quiet：A の export `countOpenItems`（`mem-db.ts:607`）と `MEM_OPEN_LIMITS[kind].warn`（`mem-db.ts:284-290`）を `>=` で比べる（`openWarnings` と同じ 1 式。境界の試験で両方の答えが一致することを固定する：§7.3 の I-F10） | ○ | — | kind・件数の段（10 件刻み） |
| `ref_unknown` | 条件の参照先が取れない | (b) の `unknown` のうち、参照先が無いことを示す語（`relay_not_found`・`not_found`、B §1.9）。照会の失敗（offline・timeout・上限）は**出さない**（一時的で、同じ促しを繰り返すだけになる） | × | quiet（`quiet_no_query`） | item ID・`version`・理由の語 |
| `evidence_missing` | `evidence` の `path:` が今は無い | (a) の `evidence` の `path:` を worktree の root から `lstat`（A §6.2 と同じ連鎖。symlink は「無い」扱い） | ○（ファイルの `lstat` だけ） | 項目が `withheld`（`withheld`：秘密らしいと判定された欄の値でファイルを触らない） | item ID・`version`・欠けた参照の数 |
| `decision_no_destination` | decision に記録の行き先が無い | (a) の `state='open'` の decision の `promoteTo` が `null`（表示の形でなく `MemRecord` を見るので、`withheld` で `promoteTo` が落ちた項目を「行き先なし」と誤って読まない。値は使わず `null` かだけ見る） | ○ | — | item ID・`version` |

- 対象の範囲：`now_*` は呼び手の (worktree, instance) の枠だけ（他のセッションの `now` に促しを出さない、D6。**同じ instance ID の別の worktree の枠は当てない**）。他の規則は呼び手のブランチの項目のうち、**呼び手が作成者の項目**（`owner.worktreeId`・`owner.instanceId`・`owner.incarnation` が呼び手と同じ）と、作成者の無い（人・サーバの）項目［見立て：他の Agent の項目は、その Agent に促す］
- `unavailable` は促しではない：テキストでは出さず、`--json` の `skipped` に `{ code, reason }` で出す。exit を 57 にしない。欠けた材料を「未設定」と読んで促すことはしない
- 規則の表は `src/lib/mem-suggest/rules.ts` の 1 つの配列に置き、テキスト・`--json`・`--quiet`・試験が同じ表を読む

### 3.3 （第 1 版の §3.3 は §3.1 の exit の契約に統合した）

### 3.4 出す文（固定のテンプレート）

テキスト（`--suggest`）：

```
suggest now_stale      item=<id> v<version>  `now` が 1 日以上更新されていません。今の作業で書き換えてください: commandmate mem now "<…>"
suggest decision_unreflected item=<id> v<version>  未反映の decision があります。画面で承認・反映を確かめてください
```

`--quiet`（1 回の呼び出しで 1 行だけ）：

```
[CommandMate mem] 未更新の項目が <n> 件あります（<code>,<code>…）。open の項目と now を確かめて更新してください: commandmate mem check --suggest
```

- 文は code ごとの固定の文と数・ID・版だけ。**項目の本文・ブランチ名・自由入力は入れない**（D1・D12）。ブランチ名も入れないのは、C がブランチ名を出口で置き換える（`sanitizeBranch`、`src/lib/brief/sanitize.ts:126`）のと同じ検査を足さずに済ませるため
- **quiet の 1 行の上限は 280 バイト**（第 1 版の 240 を改めた）。`<code>` は §3.2 の表の順に並べ、`<n>` は 999 を超えたら `999+` と出す。quiet で同時に成り立つ code は最大 6 つ（`now_missing` と `now_stale` は排他、`now_condition_met`・`ref_unknown` は quiet に無い）で、最長の組（`now_missing`・`decision_unreflected`・`manual_stale`・`open_count`・`evidence_missing`・`decision_no_destination`、`<n>`=`999+`）は **260 バイト**［事実：この文書を書いたときに `Buffer.byteLength` で数えた］。試験はこの最長の組を作って上限以下を固定する（§7.3 の I-F7）。上限を超える組は作れないので省略の規則は持たない（超えたら試験が落ちる＝規則を足した人が上限を見直す）
- D2 の 48 KiB の予算（D1 §6.1）には入らない（送信の本文ではない）

### 3.5 `--json` の形

```json
{
  "ok": true,
  "mode": "on",
  "branch": "feature/1-x",
  "instanceId": "claude",
  "full": true,
  "hook": null,
  "suggestions": [
    { "code": "now_stale", "itemIds": ["…"], "versions": [3], "fingerprint": "sha256:…", "shown": false,
      "message": "…固定の文…", "command": "commandmate mem now \"<…>\"" }
  ],
  "skipped": [{ "code": "ref_unknown", "reason": "quiet_no_query" }],
  "discarded": null
}
```

- `branch` は C の `sanitizeBranch` の結果を出す（A の `mem check --json` は生のブランチを出している：`service.ts:616`［事実］。F の `--json` は C の出口の規則に揃える［見立て］）
- `discarded` は §3.6 の再確認で捨てたときの理由の語（`mode`・`prompt_off`・`instance_lifetime`・`worktree_lifetime`・`branch`・`boundary`・`deadline`）。捨てたときは `suggestions: []`
- 型は `src/types/mem-suggest.ts`（新規）

### 3.6 要求の寿命の固定と、出力・記録の直前の再確認（P1 の処置）

Codex の指摘［事実］：`memList` は評価の await の後、最初に解決した mode で応答を組み立てる（`service.ts:527-557`）。照会の間に `on→off`、`promptOnEvents=false`、instance の削除・作り直しが起きても、古い要求が促しを返し、新しい世代の表示の記録を消費しうる。F は次の形で閉じる。

**固定（route に入って最初の同期の区間、await の前）**：

| 固定するもの | 読み方（呼ぶ export） |
|---|---|
| instance の寿命 `L0` | D1 の `readInstanceLifetime(db, worktreeId, instanceId)`（`session-brief-db.ts:174`）。`cliToolId` は roster の行か `L0.incarnationToolId` |
| worktree の世代 `W0` | A の `getWorktreeIncarnation`（`src/lib/mem/incarnation.ts:137`）。`full=true` では B の `fixMemEvalLifetime`（`evaluate.ts:104`）を `memList` が中で呼ぶので、その値と同じになる |
| 会話の境界 `B0` | D1 の `getCurrentBoundary(db, worktreeId, instanceId)?.id ?? null`（`session-brief-db.ts:139`） |
| 始めた時刻 `t0` | `deps.now()`（quiet の期限に使う） |

**所属（await を 1 回）**：A の `withMemTarget` で target `T0`（`members`・branch・mode・`features`）を得る。`full=true` ではさらに `memList` を await する。

**再確認（出力を組み立てる直前と、表示を記録する直前。両方を 1 つの同期の区間で行い、その間に await を挟まない）**：

1. worktree が在り、`getWorktreeIncarnation` が `W0` と同じ
2. `isSameInstanceLifetime(L0, readInstanceLifetime(...), cliToolId)`（`session-brief-db.ts:201`）が true。**正当な `null → lazy` の世代の発行**（mem の最初の書き込みで世代が出来た）はこの関数が同じ寿命と答える
3. `T0.members` のそれぞれについて `decideRootMode(db, root.id, T0.branch)`（A の同期の export）を読み直し、mode が `on`、`features.promptOnEvents` が `true`（`T0` と同じ）
4. `full=true`：`memList` の応答の `branch` と `mode` が `T0` と同じ
5. quiet：`getCurrentBoundary` が `B0` と同じ、`deps.now() - t0` が**サーバの期限 3 秒**以内

どれかが違えば、**出力も記録もゼロ**（§3.1 の「要求の途中で…変わった」の行）。Node のサーバは 1 つのプロセスで、記録（§4.2）は同じプロセスのメモリなので、同期の区間の中の再確認と記録の間に他の要求は割り込まない［事実：記録は DB でなくメモリで、transaction は要らない］。

**quiet の期限（P2 の処置）**：

- 許す処理：(1) CLI の身元の解決（`whoami`）、(2) A の `withMemTarget` の所属の確認（`observeWorktreeHead` の git 3 つ。各 1 秒の期限：`GIT_COMMAND_TIMEOUT_MS`、`src/lib/git/git-exec.ts:59`）、(3) DB の読み、(4) `evidence` の `path:` の `lstat`。**許さない処理**：B の評価（条件の照会の `git`・`gh`）、`memList`、tmux への送信
- 期限：CLI は `client.withDeadline(Date.now() + 4000)`（`src/cli/utils/api-client.ts:170`、既存）で要求全体を 4 秒で切り、超えたら何も出さず exit 0。サーバは上の 5 の「3 秒」を過ぎたら記録しない。サーバの期限を CLI より短くするのは、**CLI が諦めた後にサーバが記録して促しが一度も見えない**（応答の消失）を減らすため。残る隙間（サーバが記録した後、応答が CLI に届く前に切れる）は既知の制限（§4.5）
- 期限はタイマーで作らない（`setTimeout` を足さない。I-F4）。サーバは時刻の差を比べ、CLI は既存の `withDeadline` を使う

**直接の route の呼び出し**：route は CLI の身元の検査を当てにしない。`instanceId` が roster に居るか、その worktree に instance の世代の行がある（`L0.onRoster || L0.incarnation !== null`）ときだけ `now_*` を当て、quiet の記録をする。無ければ quiet は何もしない（200、`suggestions: []`）。OS の権限を持つプロセスが API を直接呼べば他の instance の記録を消費できる（A の説明「The author check stops mistakes, not intent」と同じ）ことは、説明に書く。

### 3.7 F の lib が呼ぶもの・変えないもの

- 呼ぶ（export を呼ぶだけ）：A の `withMemTarget`・`memList`・`listMem`・`getMemRecord`・`countOpenItems`・`MEM_OPEN_LIMITS`・`decideRootMode`・`presentMemItem`・`memItemStaleness`・`getWorktreeIncarnation`・`getInstanceIncarnation`（`src/lib/mem/incarnation.ts:24`）、B の評価の結果（`memList` の `conditions`）、D1 の `getCurrentBoundary`・`readInstanceLifetime`・`isSameInstanceLifetime`
- 変えない：`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`brief-provider.ts`・`session-brief.ts`・`session-brief-db.ts`。**brief に行を足さない**（§1.2 の R1）。フックの設定の生成（S1 不採用）
- E と共有（§5.2）：E が decision の未反映の判定を関数として export したら、`decision_unreflected` はそれを呼ぶ。E がマージされるまでは A の `memItemStaleness` と B の `unreflected` で決める

---

## 4. 同じ状態で同じ促しを繰り返さない条件（決めること 4）

### 4.1 状態の指紋と、記録の鍵

- 記録の鍵：**(worktree, instance, repository, branch, code)**
  - repository：§3.6 の `T0.storageRepositoryId`。branch：`T0` のブランチ（detached は `null`）。**Codex の指摘の処置**：worktree の ID の改名（`renameWorktreeIdPreservingChildren`、`src/lib/db/migrations/worktree-id-rename.ts:132`）は子の行を引き継ぎ、同じディレクトリでのブランチの切り替えでも世代・境界が同じことがある。鍵にブランチと repository が無いと、前のブランチで出した `now_missing`（材料がほぼ定数）の記録で新しいブランチの促しを抑えてしまう。鍵に入れれば、ブランチが変われば別の鍵で 1 回出る。前のブランチに戻ったときは前の鍵が残っていれば出ない（同じ状態）
- 鍵の値：**(instance の世代, 会話の境界, 指紋)**。どれかが今と違えば「未表示」と読み、出したら値を置き換える
  - instance の世代：A の `getInstanceIncarnation`（D5：ID の再利用で前の作業の記録を引き継がない）
  - 会話の境界：§3.6 の `B0`。境界を検出しないツールでは `null`（その instance の世代の間で 1 回）。新しい会話には前の会話の促しが見えていないので、境界が変われば同じ状態でも 1 回出す［見立て］
- 指紋：`sha256(JSON.stringify([code, 規則ごとの材料]))`。材料は §3.2 の「指紋に入れるもの」を ID の順に並べた配列。**時刻を入れない**（`stale` に変わった瞬間に 1 回出て、更新されるまで同じ指紋）。項目を更新すれば `version` が変わり、まだ当たれば新しい指紋でもう 1 回出る
- `--quiet` が 1 回の呼び出しで出す 1 行は、新しい値を持つ code をまとめたもの。記録するのは出した code の分だけ

### 4.2 保存先（S3：メモリだけ）

- `src/lib/mem-suggest/shown-memory.ts` の、モジュールの 1 つの `Map<string, { incarnation: string | null; boundaryId: string | null; fingerprint: string }>`。鍵は §4.1 の 5 つを `JSON.stringify` した文字列
- **上限 1,000 件、最近使った順（LRU）**：値を読んで「表示済み」と答えたとき・書いたときに、その鍵を `delete` して `set` し直す（`Map` の挿入順を最近使った順にする）。書いて 1,000 件を超えたら、挿入順の先頭（最も長く使っていない鍵）から捨てる
- 書くのは quiet の route の、§3.6 の再確認と同じ同期の区間だけ（mode `on`・`promptOnEvents=true` を読み直した直後）。DB にも migration にも書かない
- 試験はモジュールの `resetShownMemoryForTest()`（試験だけが呼ぶ export）で空にする。サーバの再起動はモジュールの再読み込み（`vi.resetModules()`）で表す

### 4.3 寿命と消える条件

| 条件 | 起きること |
|---|---|
| 同じ鍵の指紋・世代・境界が変わった | 次の `--quiet` で出し、値を置き換える |
| ブランチ・repository が変わった | 別の鍵になり、次の `--quiet` で 1 回出る |
| roster から instance が消えた・worktree の削除・ID の改名 | 古い鍵は使われなくなり、LRU で順に捨てられる（消す処理を足さない） |
| 規則の表から code が消えた（版の更新） | 同上 |
| mode が `off`・`derived` になった | 記録は残す（何も書かない・何も評価しない、A §4）。`on` に戻って指紋が同じなら、出さない［見立て：off の間に状態が変わっていなければ、同じ促しになる］ |
| サーバの再起動 | 全部消える（§4.5） |

- 新しい定期の実行・タイマー・常駐の見張りを足さない（D8・D13）。捨てるのはすべて次の書き込みの同じ同期の区間の中

### 4.4 明示の呼び出しは記録を見ない・quiet は自分の記録だけ

- `--suggest`（`--quiet` なし）は表示済みかを `shown` の欄で出すだけで、出す・出さないを変えず、記録も書かない。人や Agent が自分で聞いたときは、今の状態を全部答える
- quiet が読む・書く記録は、呼び手の身元の (worktree, instance) の鍵だけ（§3.1 の旗の表、§3.6 の直接の route）

### 4.5 既知の制限（S3 をメモリだけにしたことによる）

| # | 制限 | 起きること | 採った理由 |
|---|---|---|---|
| K1 | **サーバの再起動の後に 1 回だけ繰り返す** | 再起動の前に出した促しを、再起動の後の最初の quiet でもう 1 回出す。その後は同じ状態なら出ない | PM の決定（S3）：繰り返しは 1 回で害が小さい。migration を増やすと本番 DB の版の事故の面が増える（11-01 の v63 の件） |
| K2 | **容量を超えて捨てた鍵に戻ったとき 1 回だけ繰り返す** | 1,000 件を超えて LRU で捨てた鍵の (worktree, instance, ブランチ, code) で次に quiet が呼ばれると、同じ状態でも 1 回出す | 捨てない形（上限なし）は、ブランチ・instance の数だけメモリが増え続ける。新しい鍵を記録しない形（上限で止める）は、新しい状態の促しを出せなくなるか毎回出すことになり、繰り返しより悪い。鍵は 1 (worktree, instance, ブランチ) あたり最大 9 つで、1,000 件は約 110 の組。同時に動く instance とブランチの数はこれより十分小さい［見立て］ので、追い出しは長く使わなかった鍵に限られる |
| K3 | **応答が CLI に届く前に切れたとき、その促しは出ない** | サーバが記録した後、応答が CLI の 4 秒の期限に間に合わないと、記録済みで stdout に出ない。同じ状態の間は次も出ない | サーバの期限（3 秒）を CLI（4 秒）より短くして、狭くした。状態が変われば（項目の更新・会話の境界）また出る。繰り返さない側に倒す（受入基準） |
| K4 | ID の改名の後に 1 回だけ繰り返す | 鍵に worktree の ID を入れるので、改名の後は別の鍵になる | ブランチが同じ単なる改名は稀（同じディレクトリのブランチの切り替えは鍵のブランチも変わる）。鍵から worktree を外すと、別の worktree の同じ instance ID の記録が混ざる |

説明（`docs/user-guide/cli-operations-guide.md` と `docs/en/` の対）と試験（§7.3 の I-F2）に K1〜K3 をそのまま書く。

---

## 5. `manual` の open 項目の古さと、decision の未反映の警告（決めること 5）

### 5.1 古さ（A の「増え方の扱い」と共有）

- 古さは A の `memItemStaleness`（`src/lib/mem/staleness.ts:22-34`）**1 つ**だけで決める。F は閾値を持たない（A §8.2 の「list・F・G が同じ関数」）。閾値を変えるのは A の 1 か所
- F が出すのは `manual_stale`・`now_stale`・`decision_unreflected` の促しだけで、**項目を消さない・閉じない・書き換えない**。`mem check --suggest` の全体の評価が閉じるのは B の条件の成立だけ（`memList` の既存の動き）で、古さは閉じる理由にならない（A §8.2「古さは警告だけで、削除に使わない」）
- 件数の警告（`open_count`）は A の `warnings` と同じ式（§3.2）

### 5.2 decision の未反映の警告を E と共有する方法

［事実］E は未反映の警告を E の画面と E の API の応答の欄（`unreflected:true`）で出し、CLI の一覧・brief の文言は G へ送った（E §0.1 S3）。brief は既に `recorded` を区別し（`src/lib/brief/sources.ts:452`）、`unreflected` を出す（`:479`）。

| 何を | 正本 | F での扱い |
|---|---|---|
| 「未反映」の意味 | decision の `state` が `open`・`recorded`（E §1.1：`recorded` は「記録しただけで正本へ未反映」） | F は `state` を読むだけ。遷移は E だけ（E §0.2 E3：F の促しから E の書き込みを呼ぶ口を作らない） |
| 「期限超え」 | A の `memItemStaleness`（decision 14 日） | 同じ関数 |
| 「条件は成立したが未反映」 | B の評価の `unreflected:true` | `memList` の `conditions` を読む（`full=true` だけ） |
| 警告の文言 | E の画面の文（E §4.1）。CLI・brief の文言は G | F の文は「画面で承認・反映を確かめてください」の固定の 1 文だけで、E の画面へ人を送る。E の文を写さない |
| 判定の関数 | E が export するなら E の関数［未確認：E の設計に export の名前は無い］ | E がマージされた後の F の実装の契約で、E の export があれば呼ぶ。無ければ A・B の 2 つを F の `rules.ts` で組む（組み方は「`state ∈ {open, recorded}` かつ (`stale` または `unreflected`)」の 1 式だけ） |

- F の促しは E の operation（進行中・不明、E §1.2）を見ない［見立て］：進行中の operation があっても項目はまだ未反映で、促しは人を画面へ送るだけ。画面が operation の印を出す（E §4.1）

---

## 6. `send --note` と自由入力の検査（決めること 6）

### 6.1 形

```
commandmate send <worktree-id> "<message>" --instance <id> --reply-to <target> --note "<目的の一言>"
```

- `--note` は `--reply-to` と一緒のときだけ受ける。無ければ **exit 2、何も送らない**（F3）。この検査は `validateSendArgs`（`src/cli/commands/send.ts:571-`、副作用の前）に置く
- 呼び手の身元（`whoami`）が無ければ exit 2（mem の項目の作成者が決まらない。A の書き込みは instance を要る）。これも副作用の前に確かめる
- 送る本文（`<message>`）には足さない。`--json` の応答に `note: { itemId, state }` を足す

### 6.2 手順（既存の送信の順に、mem の書き込みを 1 つ挟む。P1 の処置）

［事実］今の `send` は、本文を送る前に次の副作用を順に取る（`src/cli/commands/send.ts:950-1090`）：`--contract` の task の行（`createContractTaskWithRole`、`:957-966`）、条件つき（`--role`・期待するロール）の送信では relay（`:1028`）、Auto-Yes の grant（`enableAutoYes`、`:1010-1043`。取る前に既存の grant を読む：`priorAutoYes`）、条件なしの送信では relay（`:1068-1073`）。本文の前で失敗したときの後始末は既にある：`failTask`（task を `failed` にする、`:970-974`）・`withdrawAutoYes(true)`（**この送信が取った grant だけ**を `expectedGrantId` つきで取り下げ、送信の前から on の grant は保つ：`:1046-1061`・`withdrawArmedAutoYes` `:502-551`）・`cancelRelayQuietly`（`src/cli/commands/relays.ts:243`）。

第 1 版は mem の書き込みを relay の直後に置き、拒否の後始末を relay の取り下げだけにしていた。**拒否は `postMessage` の前なので既存の送信の失敗の処理（`postMessage` の `onFailure`、`:1082-1095`）にも入らず、task が `pending` のまま、この送信が取った grant も残る**（Codex の指摘）。次の形に改める。

1. （既存）task の行・relay・Auto-Yes の grant を今の順で取る
2. **mem に書く（新しい段。`postMessage` の直前、条件つき・条件なしの両方の経路の合流の後に 1 か所）**：既存の `POST /api/worktrees/<送り手の worktree>/mem/items`（A、`mem add` と同じ口）に `{ kind:'waiting', text:<note>, closeWhen:'relay:<id>', evidence:['relay:<id>'], key:'send-note:<relay id>', instanceId:<送り手> }`
   - **断られたら（mode が `on` でない＝50、検査で 2、件数の上限 56、曖昧・未登録 52/53、届かない）：本文を送らない失敗として、既存の 3 つの後始末を全部通す**：
     1. `failTask()`：`--contract` の task を `failed` にする（`pending` で残さない）
     2. `withdrawAutoYes(true)`：この送信が取った grant を取り下げる。**送信の前から on の grant は保つ**（`priorAutoYes === true` なら何もしない、既存の動き）。`--note` は `--reply-to` を要るので、grant を取る送信では必ず `autoYesTarget` があり、取る前に既存の grant を読んでいる（`:1010-1020`［事実］）。読まずに取った grant を「残す」既存の分岐には入らない
     3. `cancelRelayQuietly(client, relay.id)`：relay を取り下げる
     
     そのうえで mem の exit code（50・2・56・52・53。`send` の他の exit と重ならないことを実装の契約で `git grep` で確かめる［未確認］）で終わる。stderr に「`--note` を記録できなかったので送らなかった」の 1 行（`--note` の原文は繰り返さない：§6.4）
   - `--model` で Auto-Yes を送った後に回す経路（`deferAutoYes`、`:982`）は、この段の時点で grant を取っていないので取り下げるものが無い
   - `--role` の保存（`registerInstanceWithRole`、`:947-949`）は既存の他の失敗と同じく保存されたまま（既存の文「Role saved … stays saved if this send goes no further」、`:445`）
   - `key` で再試行が冪等（A §5.4）
3. 本文を送る（既存の `postMessage`）
4. 送れなかったと確定した（`knownNotSent`）：既存の `onFailure` が task・grant・relay を片付ける。**mem の項目は作成者として閉じる**（`POST …/mem/items/<id>/close`、`reason:'send_not_sent'`）。閉じるのに失敗しても、relay が取り下げられたので B の評価が `relay` の条件で閉じる（B §1.5・§2）
5. 結果が不明（`indeterminate`）：mem には何もしない。項目は relay の状態で B が閉じる

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
- `--quiet` の引数に自由入力は無い（`--hook <event>` は表の語だけ）

---

## 7. 実装の範囲と、全入口の不変条件の表駆動の試験（決めること 7）

### 7.1 新規ファイル

| ファイル | 中身 |
|---|---|
| `src/lib/mem-suggest/rules.ts` | §3.2 の規則の表と判定（純関数）。`unavailable` の理由の語も |
| `src/lib/mem-suggest/fingerprint.ts` | §4.1 |
| `src/lib/mem-suggest/shown-memory.ts` | §4.2 の LRU の `Map`（上限 1,000）と `resetShownMemoryForTest` |
| `src/lib/mem-suggest/service.ts` | `memSuggest(db, spec, { full, instanceId, hook }, deps)`。§3.6 の固定・再確認。A・B・D1 の export を呼ぶだけ |
| `src/app/api/worktrees/[id]/mem/suggest/route.ts` | §3.1 の `POST` |
| `src/types/mem-suggest.ts` | §3.5 |
| `tests/unit/guards/mem-suggest-no-resident-4226.test.ts` | §7.3 の I-F4 の静的な検査 |
| `tests/unit/lib/mem-suggest/suggest-invariants.test.ts` | §7.3 の表 |
| `tests/unit/cli/mem-check-suggest.test.ts` | §3.1 の CLI の契約（実際の commander の parser から） |

第 1 版にあった `src/lib/db/suggestion-shown-db.ts`・`v70-suggestion-shown.ts`（S3）、`src/lib/hooks/mem-prompt-install.ts`・`src/cli/commands/mem-hooks.ts`（S1）は**作らない**。

### 7.2 変える既存のファイル

| ファイル | 変更 |
|---|---|
| `src/cli/commands/mem.ts` | `run()` の action が数を返せる（§3.1、1 か所）。`check` に `--suggest`・`--quiet`・`--hook [event]`・`--instance <id>` と、`--suggest` があるときだけ新しい route を呼ぶ分岐 1 つ。`MEM_HELP` の exit の表に 57 の 1 行 |
| `src/cli/types/index.ts` | `MemExitCode.SUGGESTED = 57` |
| `src/cli/commands/send.ts` | `--note`（§6）。`validateSendArgs` の検査と、`postMessage` の直前の mem の書き込みの段と、その拒否の後始末（既存の `failTask`・`withdrawAutoYes`・`cancelRelayQuietly` を呼ぶ） |
| `docs/user-guide/cli-operations-guide.md` と `docs/en/` の対 | `mem check --suggest`・`send --note` の節。「意図の書き漏れまでは見つけない」「同じ促しはサーバの再起動・容量の超過の後に 1 回だけ繰り返す（K1〜K3）」「OS の権限で API を直接呼べば記録を消費できる」を書く |

**変えないことを試験で固定するもの**：`src/lib/hooks/**` と `scripts/hooks/**`（S1 不採用）、`src/lib/db/migrations/**`（S3）、`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`src/lib/db/session-brief-db.ts`。

### 7.3 全入口の不変条件の表駆動の試験

入口（行）× 不変条件（列）を 1 つの表にし、同じ関数で当てる。状態は `os.tmpdir()` 配下の `fs.mkdtempSync` に DB（migration を全部当てた SQLite）・worktree の root・フックの設定ファイルを作り、`afterEach` で消す。本物の `~/.claude`・`~/.codex`・`~/.copilot`・`~/.gemini` には書かない（`CM_AGENT_HOOKS_DIR`・`CODEX_HOME` 等を一時ディレクトリへ向ける。`tests/setup.ts` の `CODEX_HOME` の pin と同じ）。

**入口**：

| # | 入口 |
|---|---|
| E-0 | 旗の無い既存の `mem check`（陰性対照） |
| E-1 | `mem check --suggest`（テキスト） |
| E-2 | `mem check --suggest --json` |
| E-3 | `mem check --suggest --quiet`（skill の手順から） |
| E-4 | `mem check --suggest --quiet --hook <event>` を、身元の無い環境（headless の `codex exec` の形） |
| E-R | route `POST …/mem/suggest` を CLI を通さず直接（`full=true`・`full=false`。roster に居ない instance・別 worktree の instance を含む） |
| E-5 | 全ツールのフックの設定の生成物（Claude・Codex・Command Code・Copilot・Antigravity・Gemini）— 変えないことの陰性対照 |
| E-7 | `send --note`（条件なし・条件つき（`--role`）・`--contract`・`--auto-yes` の既存 on／off・`--model` の後回し・配送の結果 `sent`／`not-sent`／`indeterminate` の組） |
| E-8 | brief（C の provider と CLI）— F が変えないことの陰性対照 |

**不変条件**：

| # | 不変条件 | 確かめ方 | 陽性対照（壊れた実装で落ちる） | 陰性対照（変わらない動き） |
|---|---|---|---|---|
| I-F1 | `off`・`derived` で促さない | E-1〜E-4・E-R で mode `off`・`derived`：stdout 空、E-1・E-2 は exit 50、E-3・E-4 は exit 0。記録の `Map` が増えない。`promptOnEvents=false` の `on` も促しが 0 | mode を見ずに規則を当てる版、`derived` で `listMem` を読んで捨てる版（読みの回数 0 を偽で確かめる） | `on`・`promptOnEvents=true` で古い `now` の状態なら `now_stale` が出る |
| I-F2 | 同じ状態で 1 回（と既知の制限） | E-3 を同じ状態で 3 回：1 回目だけ 1 行、2・3 回目は空。`now` を更新（`version+1`）して古くした状態で 1 回だけ出る。境界の ID・instance の世代を変えると 1 回出る。**ブランチを変える**と 1 回出て、戻すと出ない。**同じブランチのまま worktree の ID を改名**すると 1 回出る（K4）。**1,000 件の別の鍵の後**は最初の鍵も出ない、**1,001 件目**の後に最初の鍵へ戻ると 1 回だけ出る（K2）。**モジュールの再読み込み（再起動）の後**は 1 回だけ出る（K1） | 記録を書かない版、指紋に時刻を入れる版（2 回目も出る）、鍵に境界を入れない版（新しい会話で出ない）、鍵にブランチを入れない版（ブランチを変えて出ない）、LRU でなく挿入順で捨てる版（使い続けた鍵が捨てられて出る） | E-1 は同じ状態で毎回全部出す（§4.4）。別の instance には別に 1 回 |
| I-F3 | 既存のフックの設定が変わらない | E-5：全ツールの生成物・merge の結果が、F の前の期待値（既存の試験）と 1 バイト同じ。静的：`src/lib/mem-suggest/**`・新しい route・`mem.ts`・`send.ts` の F の差分が `@/lib/hooks/**` を import しない | 生成物に手を足す版、`mem-suggest` から生成の関数を呼ぶ版 | 既存の merge の試験（`mergeCodexHookSettings` 等）が変えずに通る |
| I-F4 | モデルの実行と常駐の見張りが増えない | 静的（ガード）：`src/lib/mem-suggest/**`・新しい route に `setInterval`・`setTimeout`・`setImmediate`・`new Worker`・`fork(`・`detached: true`・`.unref(`・`schedule-manager`/`timer-manager` の import・LLM の SDK・`@/lib/report`・`child_process` が無い。サーバの起動の経路（`server.ts`・`src/lib/server/**`）が `@/lib/mem-suggest` を import しない（B の G1・G2 と同じ形）。動的：`vi.useFakeTimers()` で E-1〜E-3 の後に `vi.getTimerCount() === 0`。**E-3 で所属の確認の `observe` が 1 回、B の評価の照会（`deps.evaluation` の git・gh の偽）が 0 回**（第 1 版の「`execFile` が 0 回」は所属の git と両立しないので改めた）。tmux への送信の偽が 0 回 | ガードの走査に `setInterval(` を含む文字列・`execFile` を呼ぶ版を渡すと違反。E-3 で `memList`（評価つき）を呼ぶ版は評価の偽が 1 回以上で落ちる。E-3 で DB のブランチ名で代用する版は `observe` が 0 回で落ちる | E-1 の評価は B の照会だけを呼ぶ（B の期限の helper のタイマーは評価の終わりで 0） |
| I-F5 | `--note` が relay を参照し、relay の事実を写さない | E-7 で作られた項目：kind `waiting`、`closeWhen=relay:<id>`、`evidence=[relay:<id>]`、`text` が `--note` の文と同じ。項目の全欄（`--json` の全鍵）に相手の worktree ID・instance ID・送った時刻の文字列が現れない。relay の取り下げ → B の評価で閉じる | 文に相手の名前を足す版、`evidence` に相手の worktree を足す版、`--reply-to` 無しでも書く版（exit 2 にならず落ちる） | `--note` の無い `send` の body・relay・exit が今と同じ（既存の send の試験が変えずに通る） |
| I-F6 | 記録できない `--note` は送らず、取った副作用を戻す（P1） | E-7 の全部の組で、mem が断る（mode `off`・秘密らしい文字列・件数の上限・届かない）とき：送信の偽が 0 回（本文ゼロ）、relay が取り下げられる、`--contract` の task が `failed`（`pending` で残らない）、**この送信が取った grant は `expectedGrantId` つきで取り下げられる**、**送信の前から on の grant は取り下げの要求が 0 回**、`--model` の後回しでは grant の要求が 0 回、exit が mem の code | 送ってから書く版、relay だけ取り下げる版（task が `pending`・grant が残って落ちる）、既存の grant まで止める版 | mode `on` の正しい `--note` は送り、項目が 1 つ。`--note` の無い送信の副作用の順と回数が今と同じ |
| I-F7 | 促しの文に自由入力が出ない・長さの上限 | 項目の本文・ブランチ名に目印の文字列・秘密判定の fixture（`ghp_`＋36 文字）・U+202E・BOM を入れ、E-1〜E-3・E-R の stdout・stderr・`--json` に現れない。**quiet の最長の組（§3.4 の 6 つ・`999+`）が 280 バイト以下** | `message` に項目の `text` を入れる版、上限を 240 に戻した版（最長の組で落ちる） | 項目 ID・版・code は出る |
| I-F8 | quiet は止めない・身元が無ければ黙る | E-3・E-4 の §3.1 の exit の表の全行・action の中の旗の誤りの全行・サーバに届かない・期限超えで exit 0。E-4 は stdout が空で記録が増えない。**parser の段（知らない旗）は exit 1 のまま**（範囲の外であることを固定） | 誤りで exit 2 を返す版 | E-1 の旗の誤りは exit 2 |
| I-F9 | F は brief を変えない | E-8：F の実装の前後で C の `brief-invariants.test.ts` が変えずに通る。`getBriefProvider()` の既定は D2 の決めたまま | brief に促しの行を足す版が C の I1・I14（予算・固定の部分）で落ちる | — |
| I-F10 | 規則は欠けた材料で誤って促さない（P2） | E-1・E-2・E-R：(1) `now` が条件で閉じた → `now_condition_met` だけが出る（`now_missing` は出ない）、(2) 版の競合で close が成り立たなかった → `now_condition_met` が出ない、(3) 同じ instance ID を持つ別の worktree の `now` → 呼び手に `now_*` を出さない、(4) `open_count` の境界（`warn-1`・`warn`・`warn+1`）で quiet と `full=true` の答えが一致、(5) 行き先を設定済みの `withheld` の decision → `decision_no_destination` を出さない、(6) `withheld` の項目の `evidence_missing` は `skipped` に `withheld` | `memList` の表示の形から `promoteTo` を読む版（(5) で落ちる）、`conditions` に無い kind を推す版（(1) で落ちる）、instance ID だけで枠を選ぶ版（(3) で落ちる） | 材料の揃った項目の規則は今の表どおり |
| I-F11 | 要求の途中の変化では出力も記録もゼロ（P1） | E-1〜E-3・E-R で、`withMemTarget`・`memList` の偽の await の間に：`on→off`、`promptOnEvents=false`、instance の削除と再追加（世代が変わる）、worktree の削除、ブランチの切り替え、境界の更新（quiet）、quiet の期限の超過。どれも stdout の促し 0・記録 0、`--json` は `discarded` | 再確認をしない版、出力の前だけ再確認して記録の前にしない版、記録の後に再確認する版 | 同じ寿命のまま、および**正当な `null → lazy` の世代の発行**（mem の最初の書き込み）が間に入ったときは促しが出て記録される |
| I-F12 | CLI の契約（S2） | `tests/unit/cli/mem-check-suggest.test.ts`：実際の `createMemCommand()` の parser で、57（促しあり）・0（なし）・50（off）、`--quiet --json`（quiet が勝つ）、値の無い `--hook`（quiet 0・無しで 2）、`--suggest` 無しの `--instance`（2）、`--suggest --branch`（2） | `run()` が 57 を 0 にする版、`--hook <event>` を値の要る形で宣言した版（値なしが parser で exit 1 になり落ちる） | **E-0：旗の無い `check` の出力・exit・要求の body が今と同じ**。他の subcommand は exit 0 のまま |

試験のファイル：`tests/unit/lib/mem-suggest/suggest-invariants.test.ts`（E-1〜E-4・E-R・E-7）、`tests/unit/cli/mem-check-suggest.test.ts`（I-F12）、`tests/unit/guards/mem-suggest-no-resident-4226.test.ts`（I-F4 の静的・I-F3 の import）。確認のコマンドは `npx vitest run <これらのファイル> tests/unit/guards tests/unit/docs`・`npm run lint`・`npx tsc --noEmit`。

### 7.4 実装の分け方［見立て］

1. **F-1**：§3〜§6 と I-F1〜I-F12。フックの手は置かない（全ツール「戻さない」で、代わりの経路だけ）。migration は足さない。マージの順は E → F → G（PM の決定）
2. H（#4228）が `mem check --suggest --quiet` を skill の手順（ターンの区切り・要約の前）に入れる
3. 文脈へ戻す手（S1）は、§8.2 の条件を満たしたときに追跡（#4289）で別に起票する

---

## 8. 未確認・未決

### 8.1 レビューで見てほしい点

| # | 点 | 影響 |
|---|---|---|
| U-F7 | 会話の要約を D1・D2 の境界にするか（D1 §2.2 の注は「しない」） | しないままなら、要約の直前の代わりの経路は R2（H の skill）だけ。境界にするなら D1・D2 の変更で、F の範囲の外 |
| U-F8 | 規則の対象を「呼び手が作成者の項目」に絞る（§3.2）でよいか | 絞らないと、同じブランチの他のセッションの項目まで促す |
| U-F9 | `--note` を記録できないとき送らない（§6.2 の 2）でよいか。代わりは「送って記録しない（stderr に警告）」 | 送らない方は、mode を `off` にしたブランチで `--note` を付けた依頼がすべて止まる |
| U-F10 | E が未反映の判定を export するか（§5.2） | しなければ F の `rules.ts` に 1 式を置く |
| U-F11 | `promptOnEvents` を「促しの全部」の切り替えにする（§3.1：`false` なら明示の `--suggest` も 0 件）でよいか。代わりは「quiet だけを切り替える」 | 代わりを採ると、明示の `--suggest` は `promptOnEvents` に依らず答える |
| U-F12 | `send` の他の exit と mem の 50〜56 が重ならないか（§6.2） | 重なるなら `--note` の拒否は exit 2 にまとめ、理由の語を stderr に出す |

### 8.2 S1（文脈へ戻す手）を後で採るときの条件（S1 不採用。PM が追跡 #4289 に写す）

S1 を採らない理由：文脈へ戻す手は、どのツールでも「その出来事の出力が文脈に入る」ことをこのリポジトリで実測していない（U-F1〜U-F5）。Codex の `hooks.json` に手を足すと、人の trust のレビューがもう一度要る。代わりの経路（R1・R2）で受入基準を満たす。後で採るときは、次の条件を**全部**満たした (ツール, 出来事) の組だけに手を足す。

| # | 条件 | 中身（Codex の事前レビューの指摘から） |
|---|---|---|
| C1 | 実測（U-F1〜U-F6） | U-F1：Claude の `SessionStart` の `type:"command"` の stdout が文脈に入るか（D2 の U-H1 と同じ）。U-F2：Claude の `PreCompact`（`matcher` の `manual`/`auto`）。U-F3：Codex の `SessionStart`・`PreCompact`（公式の仕様では `PreCompact` は平文の stdout を無視する）。U-F4：Command Code の `SessionStart`。U-F5：Copilot・Gemini の `SessionStart`、Gemini の `PreCompress`（公式の仕様では Gemini は JSON の出力を要り、`SessionStart` の文脈への追加は `additionalContext`、`PreCompress` は利用者への表示）。U-F6：Codex の trust の再要求。どれも隔離の HOME・`CODEX_HOME`・worktree で、採用するバージョンで |
| C2 | 出来事ごとの出力の形の表 | ツール × 出来事ごとに、**出来事の有無・登録の形・出力の形式（平文／JSON の鍵）・利用者への表示・モデルの文脈・続けて実行するか**を別の列にした表を作り、文脈に入る組だけを選ぶ。対照は「文脈に入る出力」と「UI にだけ出る出力」 |
| C3 | 所有の判定の識別の形 | Command Code（`isCommandMateHookCommand(command, worktreeId)`、`command-code/hooks-config.ts:261`）と Gemini（`gemini/settings-generator.ts:182`）の既存の判定は、`cmate-agent-event.sh`・tool・worktree の識別の部分を含む command だけを CommandMate の手と読む。第 1 版の §2.4 の手の形（`commandmate mem check --suggest --quiet --hook <event> # commandmate:agent-hooks mem-prompt`）はこれに当たらず、次の merge が利用者の手として残し、再登録・uninstall に失敗する。**ツールごとの実際の識別の形を書き、必要な判定の変更を S1 の範囲に入れる**（既存のグループに混ぜるなら、所有の判定が全 handler に当たること）。対照は 2 回の生成・uninstall・利用者の手と混ざったグループ・別の worktree の手が残ること |
| C4 | trust の扱い | Codex の trust はファイル全体でなく、**新しい・変わった hook の定義の hash** に対する確認（公式の仕様）。対照は未 trust／trust 済み／同じ中身での再生成。導入の出力に「人がレビューで 1 回 trust する」手順を書く |
| C5 | フックの実行の順と会話の境界 | 同じ出来事の command の hook は並行に走る（Codex の公式の仕様）ので、**登録の順（後ろに足す）は実行の完了の順を保証しない**。例：reset の `SessionStart` で、促しが先に旧い境界を読み、後から中継が新しい境界を開く（D1：`src/lib/session/session-boundary.ts:229-240`）と、新しい会話への出力を旧い境界に記録する。**出来事が属する会話と表示の記録の境界を結ぶ条件**（例：手が受けた出来事の会話 ID を route に渡し、境界の `conversationId` と一致したときだけ記録する）を決める。対照は中継が先・促しが先・同時 |
| C6 | 導入の操作 | 第 1 版 §2 の `commandmate mem hooks status|install|uninstall`（`--confirm` が無ければ差分だけ、Agent のセッションの中からは断る、印のファイル、冪等の `merge(merge(x,g),g)=merge(x,g)`）を、C3〜C5 を入れて作り直す。UAT の隔離（`CM_UAT_ISOLATION`）の下では手を足さない |

---

## 9. 対になる場所（探した結果）

| 探した対象 | 結果 |
|---|---|
| 促しの単位の写し：CLI（`mem check`）と画面（G #4227） | 画面の mem の表示は未実装（G）。G は同じ `memItemStaleness` を使う（A §8.2）。F の規則の表を G が読むかは G の判断。F は画面を変えない |
| フックの設定の生成：ツールごとの実装 | 6 つ（Claude・Codex・Command Code・Copilot・Antigravity・Gemini）。OpenCode・OpenCode V2・vibe-local は設定を書かない（§1.1）。S1 不採用で**どれも変えない**（I-F3 で固定） |
| 型の写し（`src/cli/types/`） | `MemExitCode`（`src/cli/types/index.ts:890-906`）に 57。`MemCommonOptions`（`:910-917`）には足さない（§3.1：`check` の action の型にだけ足す） |
| 説明（`docs/` の ja と en） | `docs/user-guide/cli-operations-guide.md` と `docs/en/` の対（§7.2）。CLAUDE.md の CLI の節は「踏むと事故になる規則」だけなので、`send --note` に `--reply-to` が要ること（exit 2）を 1 行足すかを実装の契約で決める |
| 古い動きを固定する試験 | 旗の無い `mem check` の試験（E-0）と、`send` の既存の試験（`--note` の無い送信の副作用の順と回数）。生成物を 1 バイトで固定する試験（例：`CM_AGENT_HOOKS_INJECT=0` で起動コマンドが同じ：CHANGELOG #1760）は、F が生成物を変えないので変わらない |
| 本文の前の失敗の後始末の写し（`send.ts`） | relay の拒否（`registerRelay` の `onFailure`）・Auto-Yes の拒否（`:1032-1040`）・送信の失敗（`postMessage` の `onFailure`）が同じ 3 つ（`failTask`・`withdrawAutoYes`・`cancelRelayQuietly`）を呼ぶ。`--note` の拒否も同じ 3 つを呼ぶ（§6.2） |
| D2 のガード `hook-no-brief-output-4224` | 未マージ。F はフックの生成物を変えず、`brief` を呼ばないので衝突しない |

---

## 10. 本文に無い指摘（この設計の範囲外。直さない）

- `mem check --json` の `branch` は生のブランチ名を出している（`src/lib/mem/service.ts:616`）。C は brief の出口でブランチ名を置き換える（`src/lib/brief/sanitize.ts:126`）。`mem list`・`mem check` の `--json` の出口の扱いは A・B の範囲（F の `--json` だけ C に揃える、§3.5）
- `cmate-agent-event.sh` の注（`:96-100`）は Codex の `PreCompact`・`PostCompact` を「実在する」と書くが、`tests/fixtures/hooks/codex/` に採取が無い（`session-start.json` 等 7 件だけ）。§8.2 の C1（U-F3）の実測で採取を足す
- `memList`（`src/lib/mem/service.ts:527-557`）は評価の await の後、最初に解決した mode と target で応答を組み立て、照会の間の `on→off` を見ない。F は自分の出力の前に読み直す（§3.6）が、`mem list` 自身の応答は A・B の範囲で直さない

---

## 11. 事前レビューの処置（Codex、`prereview/review-4226.md`、2026-11-09）

| # | 重さ | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|---|
| 1 | P1 | 照会中の設定・寿命の変更を、出力の直前に確かめる経路が無い（`memList` は await の後に古い mode で組み立てる） | **採る** | 古い要求が促しを返し、新しい世代の記録を消費しうる。D1 の寿命の比較と A の同期の `decideRootMode` で、F のファイルの中で閉じられる | §3.6 を新設（固定・再確認・期限）。§3.1 の exit の表に「途中で変わった」の行。§3.5 に `discarded`。§7.3 に I-F11（`null→lazy` の陰性対照を含む） |
| 2 | P1 | `--note` の保存の拒否で、契約の task と Auto-Yes が残る | **採る** | 拒否は `postMessage` の前で、既存の失敗の処理に入らない。既存の 3 つの後始末を呼べば足りる | §6.2 を書き直し（書く位置を `postMessage` の直前の 1 か所に移し、拒否で `failTask`・`withdrawAutoYes(true)`・`cancelRelayQuietly`）。§7.3 の E-7 を組み合わせに広げ、I-F6 を改めた。§9 に後始末の写しの行 |
| 3 | P2 | S1 の手の形が Command Code・Gemini の既存の所有の判定に当たらない | **採らない（S1 不採用）** | PM の決定で S1 を採らず、手を足さない | §8.2 の C3 に、後で採るときの条件として残した（#4289） |
| 4 | P2 | quiet の「git を呼ばず DB だけ」は `withMemTarget` の所属の git と両立しない | **採る** | 事実（`target.ts:128`→`git-observe.ts:23`）。DB のブランチ名で代用すると切り替え後の `off` を破る | §3.1（所属の git はする）、§3.6（許す処理・許さない処理・CLI 4 秒／サーバ 3 秒の期限）。I-F4 の「`execFile` 0 回」を「所属の `observe` 1 回・評価の照会 0 回」に改め、代用の版を陽性対照に |
| 5 | P2 | 規則の材料が予定の応答に揃わない（閉じた `now`・`warnings`・`withheld`） | **採る** | 事実（`mem-db.ts:1060-1083`・`service.ts:311`・`types/mem.ts:100`）。欠けた材料を「未設定」と読むと誤って促す | §3.2 に材料の取り方（`listMem` の `MemRecord`・`getMemRecord`・`countOpenItems`）と `unavailable` の列。§7.3 に I-F10（close の成功／版の競合・別 worktree の同じ instance ID・閾値の境界・行き先つきの `withheld`） |
| 6 | P2 | 指紋の範囲に repository・ブランチが無い。Map は 1,001 件目の追い出しで再起動の前にも繰り返す | **採る**（範囲）／**一部採る**（容量：繰り返しを既知の制限として明記） | 範囲は鍵に足せば閉じる。容量は、捨てない形はメモリが増え続け、記録しない形は新しい促しを出せず、どちらも 1 回の繰り返しより悪い。PM の決定（S3 はメモリだけ・migration を足さない）の内で、上限と LRU と繰り返しを明記した | §4.1（鍵に repository・branch）、§4.2（上限 1,000・LRU）、§4.5（K1〜K4）。I-F2 にブランチの変更・ID の改名・1,000／1,001 件・再起動 |
| 7 | P2 | フックの登録の順は D1 の境界の更新との実行の順に使えない | **採らない（S1 不採用）**／quiet の側は一部採る | フックの手を足さないので、登録の順に依る作りが無い。skill から呼ぶ quiet でも境界が途中で動きうるので、境界を固定して記録の前に再確認する | §8.2 の C5 に条件として残した（#4289）。§3.6 の再確認の 5 に境界 |
| 8 | P2 | S2 は旗 3 つと分岐 1 つだけでは CLI の契約を閉じられない（`run()` が常に 0、`--instance` が無い、parser の段） | **採る** | 事実（`mem.ts:179-188`・`:204-212`）。PM の決定も具体化を求めた | §3.1 を書き直し（足す 4 つの旗と宣言の形、57 を返す `run()` の 1 か所、旗の組み合わせの表、parser の段は commander の既定のまま＝quiet の「常に 0」は action の後）。§7.3 に E-0・I-F12 |
| 9 | P2 | S1 は出来事ごとの出力の形まで表にする必要がある。trust は定義の hash | **採らない（S1 不採用）** | 手を足さないので出力の形に依る作りが無い | §8.2 の C1・C2・C4 に条件として残した（#4289） |
| 10 | P3 | OpenCode V2 の開始を ○ としていた。quiet の 240 バイトの上限を最長の組が超える | **採る** | 事実（`opencode-v2/source.ts:292` に `session_start` が無い。最長の組は 260 バイト） | §1.1 で OpenCode と OpenCode V2 の行を分けた。§3.4 の上限を 280 バイトにし、最長の組を I-F7 に |
| 11 | 補足 | Claude には `Stop.additionalContext` という非エラーの戻し方もある。「block しかない」でなく「追加のモデルの実行を避けるため使わない」と書く | **採る** | 文の正確さ | §0.2 の F4 |
| 12 | 補足 | 試験の表に既存の check・HTTP route の直接の呼び出し・send の組・既存の brief を並べ、CLI の身元の検査だけで直接の route の記録を守れるとしない | **採る**（S1 の行は除く） | route は CLI を通らずに呼べる | §7.3 に E-0・E-R、E-7 の組。§3.6 の「直接の route の呼び出し」 |
| 13 | 推奨 | S3 は永続の表を採る | **採らない** | PM の決定（メモリだけ）。Codex はメモリだけを P1 にしていない。再起動・容量の超過で 1 回繰り返すことを既知の制限（K1・K2）として書いた | §0.1・§4.2・§4.5 |
