# 既存のフックと操作の出来事を使って mem の更新を促す（Issue #4226 / Epic #4220 の子 F）設計

- 状態：**実装済み（第 6 版、実装と同じコミット）**。第 6 版は PM の 5 回目のレビュー（`pm-review-4226e-claude.md`：P2 4 件・P3 5 件）の処分を規則として処置し、実装で確かめた結果を書いた（§12）。以下は第 5 版までの経過。**第 5 版**。第 1 版（`c12689c59`）の止める点 S1〜S3 に PM の決定（2026-11-09）が出て、Codex の事前レビュー（P1 2 件・P2 7 件・P3 1 件）を第 2 版（`b71eb25a8`）で処置した。第 3 版は、Codex の再確認（`prereview/review-4226b.md`：P1 3 件・P2 4 件）と、それを受けた PM の S3 の差戻し（`pm-decision-4226-s3-4227-sf.md`：S3 は永続、migration は v70）を処置した。第 4 版は、Codex の 3 回目の再確認（`prereview/review-4226c.md`：P1 1 件・P2 3 件・質問 1 件）と、質問への PM の答え（受入基準を弱めない：範囲を往復しても、各範囲の材料が変わらなければ再通知しない）を処置した（局所の改訂）。第 5 版は、Codex の 4 回目の再確認（`prereview/review-4226d.md`：P1 2 件・P2 1 件）を処置した。端を 1 つずつ塞ぐのをやめ、**「最後の await の後の 1 つの同期の区間で、所属（HEAD・登録・世代・境界）の照合と判定と記録を完結させる」を不変条件 INV-A** として §3.6 に書き、F の全部の await を表にした。表示の記録は、**登録が残っている root の範囲の行を消さずに保つ**（§4.3）。処置の一覧は §11（1 回目は §11.1、2 回目は §11.2、3 回目は §11.3、4 回目は §11.4）
- 前提：Epic #4220 の決定事項 D1〜D13。とくに D1（モデルを呼ばない）・D2（導けるものは書かない）・D3（既定は off、有効にするのは人）・D8（新しい常駐・定期の実行を足さない）・D12（記録はデータとして区切る・自由入力の検査）
- 読んだ設計：A `docs/design/mem-store-4221.md`・B `mem-close-when-4222.md`・C `brief-4223.md`・D1 `session-boundary-brief-4274.md`（develop にマージ済み）。D2（`../commandmate-issue-4224` の `HEAD:docs/design/brief-injection-d2-4224.md`）・E（`../commandmate-issue-4225` の `HEAD:docs/design/mem-promote-4225.md`）は読むだけ（未マージ）
- 凡例：**［事実］** = この文書を書いた時点（2026-11-09、`feature/4226-worktree` = develop `55b8192e0` の上）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. 冒頭

### 0.1 止める点（決定済み）

第 1 版の止める点 3 つは、PM の決定（2026-11-09、人が PM の推奨に委任した範囲）で次のとおり決まった。S3 は第 2 版の「メモリだけ」を、Codex の再確認の P1 を受けた PM の差戻し（同日）で**永続**に改めた。**この版で新たに止める点は無い**（理由は表の下）。

| # | 止める点（第 1 版） | 決定 | この版での作り |
|---|---|---|---|
| **S1** | Agent の文脈へ一言を戻すには、既存のフックの設定の生成に「出力を文脈へ返す手」を 1 つ足す必要がある（今の手はどれも何も返さない：中継は応答を捨てる `scripts/hooks/cmate-agent-event.sh:352` の `curl "$@" >/dev/null`） | **採らない** | 文脈へ戻す手を**どのツールにも足さない**。全ツールが §1.1 の「代わり」の行になる：D2 の境界の brief（R1）と、`mem check --suggest` を Agent・skill（H #4228）が呼ぶ（R2）。フックの設定の生成（`hook-settings-generator.ts`・各 `sources/*/hooks-config.ts` 等）は 1 バイトも変えない。§2（導入の操作 `mem hooks`）は作らない。Codex の S1 への指摘（所有判定の識別形・出来事ごとの出力形式・trust の hash・フックの実行順と境界）は「S1 不採用」として処置し、**実測して手を足すときの条件**として §8.2 に残す（PM が追跡 #4289 に写す） |
| **S2** | `commandmate mem check --suggest` は A の CLI のファイル（`src/cli/commands/mem.ts`）の `check` に旗を足し、`MemExitCode` に 1 つ足す必要がある | **採る**（`MemExitCode.SUGGESTED = 57`） | §3.1 の CLI の契約で、57 を返す経路（`run()` の 1 か所）・足す全部の旗（`--suggest`・`--quiet`・`--hook`・`--instance`）・parser の段の扱いを具体化した。**`service.ts`・`mem-db.ts`・B の評価は変えない** |
| **S3** | 「同じ状態で 1 回」を再起動の後まで保つには新しい表（migration）が要る | **永続にする**（第 2 版の「メモリだけ」を差し戻し。メモリの LRU は採らない） | §4.2。migration **v70**（E #4225 = v69、G #4227 は v71 へ入れ替え。マージの順は E → F → G）の表 `suggestion_shown` を、新しいファイル `src/lib/db/suggestion-shown-db.ts`（`mem-*` の名前にしない＝A のファイルにしない）と `src/lib/db/migrations/v70-suggestion-shown.ts` で持つ。鍵は (worktree, instance, code, 範囲)（第 4 版で範囲を値から鍵へ移した：ブランチを往復しても再通知しない）で、行の寿命（§4.3）を worktree の削除・instance の世代の終わり・規則が当たらなくなったこと・表からの code の削除・**範囲のブランチが git から消えたこと・範囲の root の登録が消えたこと**で決め、**行は (worktree, instance) あたり最大 7 × R_s ×（その worktree の git のローカルのブランチの数 + 2）**に収まる（R_s は登録が残っている root のうち、その worktree の storage になったことのある root の数。第 5 版：storage root を往復しても消さない）。再起動・容量で繰り返さない（第 2 版の K1・K2・K4 は無くなった。§4.5） |

止める点が無いと判断した理由：

- **S3 は永続で受入基準を満たす**：第 2 版はメモリの LRU（1,000 件）で「再起動・追い出しの後に 1 回だけ繰り返す」を既知の制限にしたが、Codex の再確認が「1,001 鍵を同じ順で回すと毎周すべて再通知」「再起動でも再通知」を受入基準「同じ状態で同じ促しが繰り返されない」に反する P1 とし、PM が永続に差し戻した。この版は表 `suggestion_shown`（v70）に持ち、I-F2 に「1,001 鍵を 3 周」「再起動の後」の試験を置く（§4・§7.3）。**第 4 版：範囲の往復**（ブランチ A→B→A→B）でも、各範囲の材料が変わらなければ再通知しない（3 回目の再確認の質問への PM の答え）。範囲を鍵に入れると行は範囲の数だけ増えるが、quiet の書き込みの同じ transaction で「今の git のローカルのブランチに無い範囲」と「登録が消えた root の範囲」の行を消す（§4.3）ので、行の数は登録の数と git のブランチの数で抑えられ、訪ねた回数・時間では増えない。**第 5 版：storage root の往復**（同じ Git の登録 R1・R2 の enabled の入れ替えで storage が R1→R2→R1）でも、登録が残っている root の範囲の行は消さないので再通知しない（4 回目の再確認の P1-2。第 4 版は今の storage 以外の root の行を消し、往復のたびに再通知していた）。上限は 7 × R_s ×（ブランチの数 + 2）で、R_s は人が登録した root の数（同じ Git の登録の数以下）なので、訪ねた回数・時間では増えない。**上限を保てると判断したので、ここでは止めない**。**A のファイルは変えない**：新しい表は新しいファイル（`suggestion-shown-db.ts`・`v70-*.ts`）で、migration の登録（`src/lib/db/migrations/index.ts`・`runner.ts` の `CURRENT_SCHEMA_VERSION`）は D1（v68）・E（v69）と同じ足し方。行の worktree の改名・削除の追従は既存の `getWorktreeChildTables`（`worktree_id` の列を持つ表を動的に拾う：`src/lib/db/migrations/worktree-child-tables.ts:47`［事実］）に任せ、改名・削除の関数を変えない
- **P1 の処置**（第 2 版の 2 件と、再確認の残り 2 件、4 回目の 2 件）は、F の新しいファイル（§3.6 の寿命の固定・await の表と INV-A・`memList` の前の照合・締めの build の中の照合）と `send.ts` の `--note` の段（§6.2）で済み、A・B・C・D1 のファイルの作り直しは要らない。寿命の比較は D1 の export（`readInstanceLifetime`・`isSameInstanceLifetime`、`src/lib/db/session-brief-db.ts:174`・`:201`）、worktree の世代の固定は B の export（`fixMemEvalLifetime`、`src/lib/mem/evaluate.ts:104`）、mode の読み直しは A の export（`decideRootMode`、`src/lib/db/mem-db.ts:254`）、roster は既存の `resolveAgentInstances`（`src/lib/session/agent-instances-resolver.ts:47`）を呼ぶだけ
- **D1〜D13 と違う作りは要らない**。A・B・C・D1 のファイル（`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`src/lib/session/brief-provider.ts`・`session-brief.ts`・`src/lib/db/session-brief-db.ts`）は、S2 の `mem.ts` の変更（§3.1）と `MemExitCode` の 1 行のほかは変えない。永続の表は D8（新しい常駐・定期の実行を足さない）に当たらない：行を消すのは quiet の書き込みの同じ transaction の中と、worktree の削除の既存の掃除だけ（§4.3）。D2（#4224）・E（#4225）の worktree とファイルには触らない

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
- `full=false`（quiet）は**条件の評価の照会（B の `git`・`gh`）をしない**。ただし**所属の確認の git はする**（§3.6）：A の `withMemTarget`（`src/lib/mem/target.ts:116`）の既定は worktree の HEAD を `observeWorktreeHead`（`src/lib/mem/git-observe.ts:23`）で読み、`git symbolic-ref`・`git rev-parse`・`git-common-dir` の確かめを順に走らせる［事実］。DB に残ったブランチ名で代用しない（古いブランチで mode を決めると、切り替えた後のブランチの `off` を破る）。quiet はさらに、表の行を範囲ごとに掃除するためにローカルのブランチの一覧の git を 1 つ走らせる（§3.6 の await の表の W2、§4.3。第 4 版）。第 5 版で、一覧は所属の確認の**前**に走らせ、所属の確認（`withMemTarget`）を最後の await にする（§3.6 の INV-A）

**exit の契約**：

| 状況 | `--suggest`（テキスト・`--json`） | `--suggest --quiet` |
|---|---|---|
| mode `on`・`promptOnEvents=true`・促しが 1 つ以上 | **exit 57**（`MemExitCode.SUGGESTED`）。テキストは 1 行に 1 つ、`--json` は §3.5 | 新しい促し（§4 で未表示）だけを §3.4 の 1 行で出し、表示を記録する。**exit 0** |
| 同・促しが 0 | exit 0。テキストは何も出さない、`--json` は `suggestions: []` | 何も出さない。exit 0 |
| 同・促しはあるが全部表示済み | exit 57（明示の呼び出しは表示済みでも全部出す。表示を記録しない） | 何も出さない。exit 0 |
| mode `on`・`promptOnEvents=false` | exit 0、`suggestions: []`、`--json` に `disabledBy: "promptOnEvents"` | 何も出さない。exit 0 |
| mode `off`・`derived` | **stdout に何も出さない**、stderr に 1 行、exit 50（A の `mem check` と同じ） | 何も出さない。exit 0 |
| 要求の途中で mode・`promptOnEvents`・instance や worktree の寿命・ブランチ・所属の登録（id・path・enabled）が変わった（§3.6） | exit 0、`suggestions: []`、`--json` に `discarded: "<理由の語>"`、stderr に「状態が変わったのでもう一度」の 1 行 | 何も出さない。記録しない。exit 0 |
| 曖昧・未登録・worktree が無い | exit 53／52（A §12.1） | 何も出さない。exit 0 |
| 身元が無い（`--instance` も無い） | `now_*` を除いて当てる（§3.2 の `unavailable`）。exit は上と同じ | 何も出さない。exit 0（身元の無い呼び出しは記録の鍵が決まらない） |
| サーバに届かない・認証の失敗 | A の CLI の既存の扱い（exit 1・99 等） | 何も出さない。exit 0（fail-open。理由は stderr に 1 行） |
| quiet の期限（§3.6）を超えた | （期限なし。B の `check` と同じ 10 秒の評価の期限：B §7 G5） | 何も出さない。exit 0 |
| action の中の旗の誤り（上の表） | exit 2 | **exit 0**、stderr に 1 行 |

- `--quiet` が表示を記録するのは mode `on` かつ `promptOnEvents=true` のときだけ。`off`・`derived` では表示の記録を書かない（A §4 の「F：更新の促し」の行のとおり）。記録は表 `suggestion_shown`（§4.2、v70）。例外は §3.6 の worktree の世代の固定（`fixMemEvalLifetime` が未発行の世代を作る）で、これは `mem list`・`mem check` も mode を読む前に行う既存の書き込みと同じ（`memList` は `off` を返す前に呼ぶ：`src/lib/mem/service.ts:534`［事実］）

### 3.2 規則の一覧

材料はすべて A・B・C・D1 の正本の読み。**項目の本文は材料にも出力にも使わない**（ID・kind・状態・時刻・版・条件の結果・所有者だけ）。**意図の書き漏れ（書くべきだったのに書かれていない意図）を見つけるとは約束しない**：規則は「書かれた項目の状態」と「`now` の枠が空」しか見ない。

**材料の取り方（Codex の指摘：`memList` の応答だけでは揃わない）**［事実］：

- `memList` の応答の `items`・`now` は `presentMemItem` を通した表示の形で、`withheld` の項目は `promoteTo`・`evidence` を落とす（`MEM_WITHHELD_KEPT_KEYS`、`src/types/mem.ts:100-114`）
- 成立して閉じた `now` は枠から消え（`closeMemItemByCondition`、`src/lib/db/mem-db.ts:1060-1083`）、既定の一覧にも残らない。`conditions` は ID → 条件の結果だけ（`conditionsById`、`src/lib/mem/service.ts:584-588`）で kind・所有者・版を持たない
- `listMem`（`src/lib/db/mem-db.ts:954`）は表示の前の `MemRecord`（`src/lib/mem/present.ts:28-48`：`promoteTo`・`evidence`・`owner`・`version` を持つ）を返すが、`warnings` は持たない。`warnings` は `memList` の中の private の `openWarnings`（`service.ts:311-320`：`countOpenItems(...) >= MEM_OPEN_LIMITS[kind].warn`）が作る

そこで F は次の 3 つを材料にする：(a) `listMem` の `MemRecord`（両方の経路。scope は §3.6 で固定した target の 4 つの欄 `storageRepositoryId`・`readRepositoryIds`・branch・worktreeId から作る。`service.ts:163-170` の `scopeOf` と同じ欄）、(b) `full=true` のときだけ `memList` の `conditions`、(c) 閉じた項目の所有者と版は `getMemRecord`（`mem-db.ts:651`）で ID から引き直す。

**(b) を (a)・(c) に結ぶときの版の確かめ（再確認の P2 の処置）**［事実］：`memList` の `conditions` は ID → 結果だけで、評価した版を持たない（`conditionsById`、`service.ts:584-588`）。B は `memList` の中の await（target の解決）の**後**に候補を読み（`candidatesOf`、`evaluate.ts:160`）、decision の `unreflected` は版を確かめずに付ける（`evaluate.ts:443`）。そのため、照会中に decision の v1 が v2 に更新されると、v1 の結果が v2 に付きうる。F は次で結ぶ：

- **前の写し**：§3.6 の「`memList` の前の照合」と同じ同期の区間で、`memList` を呼ぶ直前に (a) を読み、候補の項目ごとに `{ version, closeWhen, state }` を控える
- **後の写し**：`memList` が返った後、§3.6 の締めの build の中の照合と同じ同期の区間（W5 の build の中。INV-A）で (a)・(c) を読み直す
- **使ってよい結果**：`closed:false` の結果（`unreflected`・`ref_unknown` の材料）は、前と後の写しで `version`・`closeWhen`・`state` が全部同じ項目だけ。版は増える一方（更新は `version = version + 1`：`mem-db.ts:905`・`:947`・`:1079`［事実］）なので、前と後が同じなら、その間に B が読んだ版も同じ。`closed:true` の結果は、B の close の 2 つの経路を**分けて**照合する（3 回目の再確認の P2 の処置。第 3 版は両方に `version + 1` を求め、正常に閉じた `now`（v7 のまま記録される）を `version_changed` で捨て、代わりに `now_missing` を出していた）［事実］：
  - **`now`（枠の項目。`now_condition_met` の材料はこれだけ）**：`closeMemItemByCondition` は枠の項目を `archiveSlot` で `mem_items` へ写して閉じ（`mem-db.ts:1070-1074`）、写した行の `version` は**枠の `slot.version` のまま**（`mem-db.ts:518`）。進むのは枠の別の数え `session_note_versions` だけ（`nextSlotVersion`、`mem-db.ts:473`・`:1072`）。そこで、後の記録（(c)）の kind が `now`・`state` が `closed`・`closeReason` が `condition` で、`version` と `closeWhen` が前の写し（(a) の `now`）と**同じ**ときだけ使う（同じ ID の `now` を条件つきで閉じる経路はこれだけ：閉じた後は `memTransition` が断る）
  - **通常の項目**：`UPDATE … version = version + 1 … WHERE id = ? AND version = ?`（`mem-db.ts:1079`）。後の記録の `state` が `closed`・`closeReason` が `condition`・`closeWhen` が同じで、`version` が前の写しの `version + 1` のときだけ使う。今の規則の表には通常の項目の `closed:true` を材料にする規則は無い（規則を足すときはこの照合を使う）
- 合わない項目の結果は使わず、`--json` の `skipped` に `{ code, reason: 'version_changed', itemId }` を出す（促さない）。古さだけで決まる規則（`decision_unreflected` の古さ・`manual_stale` 等）は後の写しの (a) で決める

| code | 意味 | 判定の材料 | quiet | `unavailable` になるとき（促さず `skipped` に理由を出す） | 指紋（§4.1）に入れるもの |
|---|---|---|---|---|---|
| `now_missing` | 呼び手の instance に `now` が無い | (a) の `now` に呼び手の (worktree, instance) の行が無い。roster に居る instance だけ（`resolveAgentInstances`、C の S1。物理の roster の行が無い worktree では `selectedAgents` から導いた primary も roster に居る：`agent-instances-resolver.ts:52-59`［事実］）。`full=true` で同じ回に `now_condition_met` が出たら出さない | ○ | 呼び手の instance が分からない（`no_instance`） | code・instance・「無い」 |
| `now_stale` | 呼び手の `now` が古い | `memItemStaleness`（`src/lib/mem/staleness.ts:22-34`、`now` は 1 日）が `stale` | ○ | 同上 | `now` の item ID・`version` |
| `now_condition_met` | 呼び手の `now` の条件が成立して閉じた | (b) の `conditions[id]` が `result:'met'` かつ `closed:true` で、(c) の記録の kind が `now`、`owner.instanceId` が呼び手の instance、`owner.incarnation` が §3.6 で固定した instance の世代と同じ（A の所有の判定 `ownedBy` と同じ 2 つ。`owner.worktreeId` は書いた時点の ID で改名の後も旧い ID のまま残るので見ない：`mem-db.ts:856-863`［事実］。instance の世代は (worktree, instance) ごとの行で、改名で新しい ID へ移るので、同じ instance ID の別の worktree の項目はこれで外れる）。上の「版の確かめ」に合うものだけ。**版の競合で閉じなかった**（`closeMemItemByCondition` が null → `closed:false`）ものは当てない（枠に残り、`now_stale` 等で見る） | ×（評価が要る） | quiet（`quiet_no_query`）／(c) が引けない（`record_gone`） | item ID・閉じた後の `version`・`met` |
| `decision_unreflected` | decision が未反映のまま古い | `state` が `open`・`recorded` で `memItemStaleness` が `stale`（decision は 14 日、A §8.2）。`full=true` ではさらに (b) の `unreflected:true`（`evaluate.ts:443`、B §5） | ○（古さだけ） | — | item ID・`version`・`state` |
| `manual_stale` | 閉じる条件が `manual` の open 項目が古い | `memItemStaleness` が `stale` で kind が `next`・`external`・`note`（`manual` を受ける kind、A §2.3） | ○ | — | item ID・`version` |
| `open_count` | open の件数が警告の数に達した | `full=true`：`memList` の `warnings` の `open_count`。quiet：A の export `countOpenItems`（`mem-db.ts:607`）と `MEM_OPEN_LIMITS[kind].warn`（`mem-db.ts:284-290`）を `>=` で比べる（`openWarnings` と同じ 1 式。境界の試験で両方の答えが一致することを固定する：§7.3 の I-F10） | ○ | — | kind・件数の段（10 件刻み） |
| `ref_unknown` | 条件の参照先が取れない | (b) の `unknown` のうち、参照先が無いことを示す語（`relay_not_found`・`not_found`、B §1.9）。照会の失敗（offline・timeout・上限）は**出さない**（一時的で、同じ促しを繰り返すだけになる） | × | quiet（`quiet_no_query`） | item ID・`version`・理由の語 |
| `evidence_missing` | `evidence` の `path:` が今は無い | (a) の `evidence` の `path:` を worktree の root から `lstat`（A §6.2 と同じ連鎖。symlink は「無い」扱い） | ○（ファイルの `lstat` だけ） | 項目が `withheld`（`withheld`：秘密らしいと判定された欄の値でファイルを触らない） | item ID・`version`・欠けた参照の数 |
| `decision_no_destination` | decision に記録の行き先が無い | (a) の `state='open'` の decision の `promoteTo` が `null`（表示の形でなく `MemRecord` を見るので、`withheld` で `promoteTo` が落ちた項目を「行き先なし」と誤って読まない。値は使わず `null` かだけ見る） | ○ | — | item ID・`version` |

- 対象の範囲：`now_*` は呼び手の (worktree, instance) の枠だけ（他のセッションの `now` に促しを出さない、D6。**同じ instance ID の別の worktree の枠は当てない**）。他の規則は呼び手のブランチの項目のうち、**呼び手が作成者の項目**（A の所有の判定と同じ：`owner.instanceId` が呼び手の instance で、`owner.incarnation` が §3.6 で固定した呼び手の instance の世代と同じ。`owner.worktreeId` は見ない＝改名の後も自分の項目が外れない。再確認の P2 の処置）と、作成者の無い（人・サーバの）項目［見立て：他の Agent の項目は、その Agent に促す］。instance の世代が無い呼び手（mem に一度も書いていない primary）には自分の項目が無いので、作成者の無い項目だけが対象
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
- `discarded` は §3.6 の照合で捨てたときの理由の語（`mode`・`prompt_off`・`instance_lifetime`・`worktree_lifetime`・`branch`・`membership`・`registration`・`boundary`・`deadline`）。捨てたときは `suggestions: []`。`membership`（締めの所属の storage・members が `T0` と違う）と `registration`（登録の全行が `R0` と違う）は第 5 版で足した（第 4 版は登録の照合で捨てる語を表に書いていなかった）
- 型は `src/types/mem-suggest.ts`（新規）

### 3.6 要求の寿命の固定と、出力・記録の直前の再確認（P1 の処置）

Codex の指摘［事実］：`memList` は評価の await の後、最初に解決した mode で応答を組み立てる（`service.ts:527-557`）。照会の間に `on→off`、`promptOnEvents=false`、instance の削除・作り直しが起きても、古い要求が促しを返し、新しい世代の表示の記録を消費しうる。F は次の形で閉じる。

**固定（W1 の body の読みの後の最初の同期の区間、他の await の前）**：

| 固定するもの | 読み方（呼ぶ export） |
|---|---|
| 呼び手の instance の所属 | worktree の行（`getWorktreeById`）と、その `selectedAgents` で解いた roster（`resolveAgentInstances(db, worktreeId, worktree.selectedAgents)`、`agent-instances-resolver.ts:47`）。**物理の roster の行が無い worktree で導いた primary も所属に入る**（再確認の P2 の処置）。寿命の比較に渡す tool `C0` は roster の要素の **`cliTool`**（`AgentInstance` の欄名：`src/lib/cli-tools/types.ts:152`。第 3 版の「roster の要素の `cliToolId`」は誤りで、型検査に通らず、`undefined` を渡すと正当な `null → lazy` の発行を別の寿命と判定する：`session-brief-db.ts:209`。3 回目の再確認の P2 の処置） |
| instance の寿命 `L0` | D1 の `readInstanceLifetime(db, worktreeId, instanceId)`（`session-brief-db.ts:174`）。所属とは別に、寿命の比較にだけ使う（導いた primary は `incarnation: null`・`onRoster: false` で、それでよい） |
| worktree の世代 `W0` | **両方の経路で** B の `fixMemEvalLifetime(db, spec)`（`evaluate.ts:104`。未発行なら作る `getOrCreateWorktreeIncarnation`）の `incarnation`。第 2 版の `getWorktreeIncarnation`（未発行なら `null`）は、`memList` が中で世代を作ると `null !== 新しい UUID` で初回の full を「寿命が変わった」と誤るので改めた（再確認の P2 の処置）。`memList` を含む評価の全入口が同じ関数で固定する（B の注、`evaluate.ts:99-103`） |
| 会話の境界 `B0` | D1 の `getCurrentBoundary(db, worktreeId, instanceId)?.id ?? null`（`session-brief-db.ts:139`） |
| 始めた時刻 `t0` | `deps.now()`（quiet の期限に使う） |

**不変条件 INV-A（第 5 版。4 回目の再確認の P1-1 の処置）**：

> **最後の await の後の 1 つの同期の区間で、所属（HEAD・登録・世代・境界）の照合と、規則の判定と、出力の組み立てと、表示の記録を完結させる。** その区間は、A の `withMemTarget` の **build の中**（所属の resolver が登録の署名を比べた `finishAttempt` と同じ同期の区間で、HEAD は resolver の 2 回目の `observe` の値：`src/lib/agent-roles/resolve.ts:238`・`:272-276`、build の注 `:292`「Runs in the same synchronous stretch as the final check」［事実］）にする。つまり**どの経路でも最後の await は `withMemTarget`** で、build が返すのは出来上がった応答（plain data）だけ。build が返った後の F は、その値を route に返すだけで、DB を読まず、判定せず、記録しない。

第 4 版までは、照合を「出力・記録の直前」の場所ごとに足していた。そのため `withMemTarget` の後に足した await（ブランチの一覧）の待ちの間に HEAD が A（`on`）から B（`off`）へ変わると、登録・世代・境界は同じなので照合を通り、A の材料で促し・記録をしていた（4 回目の再確認の P1-1。§0.2 の「古いブランチで mode を決めると、切り替えた後のブランチの `off` を破る」に反する）。HEAD の読みは git（await）なので、同期の区間で読み直すことはできない。そこで**HEAD を読む await（`withMemTarget`）を最後に置き、その build の中で全部を終える**形を規則にした。

**await の表**（F のサーバ側の全部の await。表に無い await を足すと §7.3 の I-F13 の検査が落ちる）：

| # | await | 経路 | 位置 | その await の後に成り立たせること |
|---|---|---|---|---|
| W1 | route の body の読み（`request.json()`） | 両方 | 固定（下の表）の**前** | 何も固定していないので照合は要らない。固定は W1 の後の最初の同期の区間で行い、待ちの間の変化は**変わった後の状態**で答える |
| W2 | ブランチの一覧 `deps.listBranches`（`execGitCommandCapture(['for-each-ref', …])`） | quiet | 固定の後、所属の前 | 結果は §4.3 の掃除の「残す範囲」にだけ使う。待ちの間の HEAD・登録・mode の変化は、後の W5 が今の状態で解くので、ここで照合しない |
| W3 | 1 回目の所属 `withMemTarget`（build で `T0`・`R0` を控える） | full | 固定の後 | build の後、同じ同期の区間の続きで「`memList` の前の照合」（下）をして `memList` を呼ぶ（W4 の副作用＝close の前の照合） |
| W4 | `memList`（中で target の解決と B の評価の照会） | full | W3 の後 | W5 が今の所属を解き直し、build の中で `T0`・`R0`・`memList` の応答と比べる |
| W5 | **締めの所属** `withMemTarget`（build が INV-A の区間） | 両方（quiet はこれが唯一の所属の解決） | **最後** | build の中で下の「締めの build の中の照合」1〜5、規則の判定、出力の組み立て、`readShown`・`settleShown`（quiet）を行う |

- CLI の側の await（`whoami`・要求の送信）はサーバの外で、照合の対象にしない（判定はサーバが要求の届いた後の状態で行う）
- `evidence` の `path:` の確かめは `lstatSync`（A の `src/lib/mem/validate.ts:208` と同じ同期の読み）で、W5 の build の中で行う（await にしない）
- 順：quiet は W1 → 固定 → W2 → W5。full は W1 → 固定 → W3 → `memList` の前の照合 → W4 → W5。`withMemTarget` の呼び出しは quiet で 1 回、full で 2 回
- `withMemTarget` の build は所属の解決の失敗（`not_found`・`ambiguous` 等）も受ける（`src/lib/mem/target.ts:112-157`）ので、締めの build は全部の結果をそこで答える

**INV-A を固定するものと、I-F13 のガードの保証の範囲（第 6 版の追記。PM の決定 2026-11-10、`pm-return-4226-guard.md`）**：

- **INV-A そのものは実行時の試験で固定する**：§7.3 の I-F11 の表駆動の対照（`tests/unit/lib/mem-suggest/suggest-invariants.test.ts`）が、`MEM_SUGGEST_AWAITS` の各行（W1〜W5）の await の後に状態を変える注入をして、促し 0・記録 0 を確かめる。表は `MEM_SUGGEST_AWAITS` から読むので、表に足した await は自動でこの対照に入る
- **I-F13 のガード（`tests/unit/guards/mem-suggest-await-table-4226.test.ts`）は補助**：新しい await（や build の外の記録）を足したときに気づくための静的な検査で、INV-A の証明ではない。呼び出しの静的な解析は、別名・helper の段数・高階関数・動的な呼び出しと原理的に端が尽きないので、範囲を次のとおりに決め、範囲の外を追いかけない
- **保証の範囲**：直接の呼び出し、import の別名（`import { settleShown as settleLate }`・名前空間の import `ns.peek(…)`）、変数の別名（`const f = peek`・`let f = …; f = peek` の再代入）、**1 段の helper の逆引き**（W5 の build が直接呼ぶ helper を、build の外からも呼ぶこと）
- **保証の範囲の外**：**多段の helper**（`wrapped → peek → readShown` を W5 の build の中で呼び、W5 の後に `wrapped` を呼ぶ形。Codex の 5-2b の 3 回目の再レビュー `review-4226d.md` の P2 の 2 段の helper はここ。#4289 に追跡）、**高階関数**（関数を値として渡し、別の場所で呼ぶ）、**動的な呼び出し**（計算されたプロパティ名、`call`・`apply`、文字列での引き当て）。この形で記録・await を足しても I-F13 は落ちないことがあり、そのときは I-F11 の実行時の対照が落ちる（W5 の後に足した偽の await の間の変化で促し・記録が残る）

**所属（W3・W5）**：A の `withMemTarget` で target（`members`・branch・mode・`features`）を得る。quiet は W5 の 1 回で、その target を `T0` とする。full は W3 の target を `T0` とし、W5 の target `Tf` と比べる。**`T0` を得た build の中（所属の最後の照合と同じ同期の区間）で、登録の状態 `R0` を控える**（3 回目の再確認の P1 の処置）：`getAllRepositories(db)`（`src/lib/db/db-repository.ts:408`）の全行の `[id, path, enabled]`。所属の resolver の `rootsSignature`（`src/lib/agent-roles/resolve.ts:208`。private なので F が同じ式を持つ。A のファイルは変えない）と同じ形で、resolver は build の直前にこの署名を比べる（`finishAttempt`、`resolve.ts:248`）ので、`R0` は `T0.members` を決めた登録の状態そのもの。members の行だけでなく全行を控えるのは、所属が candidates の `enabled` で決まり（enabled の candidates が在ればそれだけが members：`resolve.ts:194-195`）、同じ Git の登録の追加でも変わるため［事実］。

**ブランチの一覧（W2。quiet だけ、await を 1 回。第 4 版、第 5 版で所属の前へ移した）**：固定の後、`withMemTarget`（W5）の前に、`execGitCommandCapture(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], worktree.path)`（`src/lib/git/git-exec.ts:131`、1 秒の期限。`observeWorktreeHead` の `symbolic-ref --short` と同じ短縮の形）で今のローカルのブランチを得る（試験では `deps.listBranches` の偽）。§4.3 の「範囲のブランチが git から消えた」掃除にだけ使い、出力には使わない。**失敗・期限切れなら促しも記録もしない**（`skipped` に `branches_unknown`。消せないまま書くと行の上限が保てない。出して記録しないと次も出る）。`full=true` は表に書かないので走らせない。

**`memList` の前の照合（`full=true` だけ。再確認の P1 の処置）**［事実］：`memList` は呼ばれた時点で worktree の世代を固定し直し（`fixMemEvalLifetime`、`service.ts:534`）、その値で評価して閉じる。F の所属の await の間に同じ ID・同じ path で worktree が削除・再作成されると、`memList` は新しい世代を固定して新しい世代の成立した項目を閉じ、F は最後に `W0` との不一致で出力だけを捨てる（閉じた項目は戻らない）。所属の判定の署名は path・repositoryPath で世代を含まない（`src/lib/agent-roles/resolve.ts:305`）ので、所属の確認では気づけない。そこで F は、W3（1 回目の `withMemTarget`）の後の**最初の同期の区間で**次を行い、その区間の最後で `memList(...)` を呼ぶ（`memList` の最初の await＝target の解決より前の部分は同じ同期の区間で走る）：

1. 下の「締めの build の中の照合」の 1〜3（`getWorktreeIncarnation(db, worktreeId) === W0`・instance の寿命・登録の状態と mode と `promptOnEvents`。3 は `T0` の members について）。どれかが違えば `memList` を**呼ばずに**捨てる（出力・記録ゼロ、`discarded`）
2. §3.2 の「前の写し」を読む
3. `memList` を呼ぶ。`memList` の中の `fixMemEvalLifetime` は、1 で `W0` と同じと確かめた行を返す（`getOrCreateWorktreeIncarnation` は在る行をそのまま返す：`incarnation.ts:145-153`）ので、**評価が使う固定値は `W0` と一致する**

`memList` の中の await（target の解決・照会）の間に削除・再作成が起きた場合は、B の close が閉じる直前に固定値の世代が生きているかを確かめて断る（`aliveOf`、`evaluate.ts:113-119`［事実］）ので、新しい世代の項目は閉じない。F はその後の W5 の build の中の照合で捨てる。

**締めの build の中の照合（W5 の build。INV-A の区間。第 4 版までの「再確認」を、出力・記録の直前の場所ごとでなく、この 1 つの区間に集めた）**：

1. worktree が在り、`getWorktreeIncarnation(db, worktreeId)`（作らない読み）が `W0` と同じ
2. 呼び手の instance が今も所属（固定の表の roster）に居て、`isSameInstanceLifetime(L0, readInstanceLifetime(...), C0)`（`session-brief-db.ts:201`。`C0` は roster の要素の `cliTool`）が true。**正当な `null → lazy` の世代の発行**（mem の最初の書き込みで世代が出来た）はこの関数が同じ寿命と答える
3. 登録の状態（`getAllRepositories` の全行の `[id, path, enabled]`）が `R0` と同じで（違えば `registration`）、full は W5 の `Tf` の `storageRepositoryId`・members の ID の列・branch（detached は null）が `T0` と同じ（違えば `membership`・`branch`。quiet は W5 の target が `T0` そのもの）、そのうえで `T0.members` のそれぞれについて `decideRootMode(db, root.id, T0.branch)`（A の同期の export）を読み直し、mode が `on`、`features.promptOnEvents` が `true`（`T0` と同じ）。登録の照合が無いと、所属の先の切り替え（同じ Git の登録 root R1・R2 の enabled の入れ替えで今の所属が R2 になる）の後も旧い R1 の設定は `on`・`true` のままで、`decideRootMode` は enabled を見ない（`mem-db.ts:254`）ので、R2 の `promptOnEvents=false` を見落とす（3 回目の再確認の P1）。登録が変わっていれば捨てる。HEAD は W5 の resolver が 2 回の `observe` の一致（`resolve.ts:272-276`）で確かめた値が build に渡るので、build の中では読み直さない（読み直しは await が要る）。HEAD の変化が W5 の待ちの間なら resolver が試し直し（最大 `MAX_MEMBERSHIP_ATTEMPTS` = 3 回、`resolve.ts:205`）、試し直しても落ち着かなければ `ambiguous` で、促し・記録ゼロ
4. `full=true`：`memList` の応答の `branch` と `mode` が `T0` と同じ。§3.2 の「後の写し」を読む
5. quiet：`getCurrentBoundary` が `B0` と同じ、`deps.now() - t0` が**サーバの期限 3 秒**以内

どれかが違えば、**出力も記録もゼロ**（§3.1 の「要求の途中で…変わった」の行）。照合が通ったら、**同じ build の中で**、§3.2 の材料（quiet は (a) と `countOpenItems`・`lstatSync`、full は「後の写し」）を読み、規則を判定し、出力を組み立て、quiet は `readShown(db, worktreeId, instanceId, scopeHash)`（§4.2）で今の範囲の記録を読んで新しい促しを選び、`settleShown` で記録する。build はその応答を返し、build の後には何もしない（INV-A）。表示の記録（§4.2）は表 `suggestion_shown` への書き込みで、better-sqlite3 の同期の `db.transaction` で行う。Node のサーバは 1 つのプロセスで、再確認・記録の読み・記録の書き込みを 1 つの同期の区間に置くので、その間に同じプロセスの他の要求は割り込まない［事実：better-sqlite3 の呼び出しは同期で await を挟まない］。表に書くのはサーバのプロセスだけ（CLI は route を呼ぶだけ）。

**quiet の期限（P2 の処置）**：

- 許す処理：(1) CLI の身元の解決（`whoami`）、(2) A の `withMemTarget` の所属の確認（`observeWorktreeHead` の git 3 つ。各 1 秒の期限：`GIT_COMMAND_TIMEOUT_MS`、`src/lib/git/git-exec.ts:59`）、(3) DB の読み、(4) `evidence` の `path:` の `lstatSync`（W5 の build の中）、(5) ブランチの一覧の git 1 つ（W2、1 秒の期限。第 4 版。第 5 版で (2) の前に走らせる）。期限の判定（5 の「3 秒」）は W5 の build の中で行うので、遅い git は記録の前に必ず捨てられる。**許さない処理**：B の評価（条件の照会の `git`・`gh`）、`memList`、tmux への送信
- 期限：CLI は `client.withDeadline(Date.now() + 4000)`（`src/cli/utils/api-client.ts:170`、既存）で要求全体を 4 秒で切り、超えたら何も出さず exit 0。サーバは上の 5 の「3 秒」を過ぎたら記録しない。サーバの 3 秒はサーバの fix から数えるので、CLI が要求の前に使った時間（(1) の身元の解決・接続）を含まない。**CLI が諦めた後にサーバが記録して促しが一度も見えない**隙間は、サーバの期限では狭まらない（PM P3-3。§12.5）。この隙間は既知の制限（§4.5）。CLI の (1) も 4 秒の期限の内側で行う：環境変数で身元が分かれば tmux に聞かず、聞くときは期限で打ち切る子プロセスで聞く（Codex P2-1。§12.5）
- 期限はタイマーで作らない（`setTimeout` を足さない。I-F4）。サーバは時刻の差を比べ、CLI は既存の `withDeadline` を使う

**直接の route の呼び出し**：route は CLI の身元の検査を当てにしない。`instanceId` が**解いた roster**（固定の表の `resolveAgentInstances`。導いた primary を含む）に居るか、その worktree に instance の世代の行がある（`L0.incarnation !== null`）ときだけ `now_*` を当て、quiet の記録をする。無ければ（任意の未知の ID）quiet は何もしない（200、`suggestions: []`）。第 2 版の「物理の roster の行（`L0.onRoster`）か世代の行」は、mem を使っていない正当な primary（導いた primary）を両方とも持たないので断っていた（再確認の P2）。所属の確認（解いた roster）と寿命の比較（`L0`）を分けて直した。OS の権限を持つプロセスが API を直接呼べば他の instance の記録を消費できる（A の説明「The author check stops mistakes, not intent」と同じ）ことは、説明に書く。

### 3.7 F の lib が呼ぶもの・変えないもの

- 呼ぶ（export を呼ぶだけ）：A の `withMemTarget`・`memList`・`listMem`・`getMemRecord`・`countOpenItems`・`MEM_OPEN_LIMITS`・`decideRootMode`・`presentMemItem`・`memItemStaleness`・`getWorktreeIncarnation`・`getInstanceIncarnation`（`src/lib/mem/incarnation.ts:24`）・`instanceIncarnationAlive`（`incarnation.ts:128`）、B の `fixMemEvalLifetime` と評価の結果（`memList` の `conditions`）、D1 の `getCurrentBoundary`・`readInstanceLifetime`・`isSameInstanceLifetime`、既存の `getWorktreeById`・`resolveAgentInstances`・`getAllRepositories`（§3.6 の `R0`）・`execGitCommandCapture`（§3.6 のブランチの一覧。`child_process` を F が直接 import しない）。F の表は F の `suggestion-shown-db.ts`（§4.2）だけが読み書きする
- 変えない：`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`brief-provider.ts`・`session-brief.ts`・`session-brief-db.ts`・`agent-instances-resolver.ts`・`worktree-child-tables.ts`・`worktree-id-rename.ts`・`worktree-db.ts`。**brief に行を足さない**（§1.2 の R1）。フックの設定の生成（S1 不採用）
- E と共有（§5.2）：E が decision の未反映の判定を関数として export したら、`decision_unreflected` はそれを呼ぶ。E がマージされるまでは A の `memItemStaleness` と B の `unreflected` で決める

---

## 4. 同じ状態で同じ促しを繰り返さない条件（決めること 4）

### 4.1 状態の指紋と、記録の鍵

- 記録の鍵：**(worktree, instance, code, 範囲)**（表の主キー。第 4 版で範囲を値から鍵へ移した）
- 鍵の値：**(instance の世代, 会話の境界, 指紋)**。どれかが今と違えば「未表示」と読み、出したら値を置き換える
  - instance の世代：A の `getInstanceIncarnation`（D5：ID の再利用で前の作業の記録を引き継がない）。世代の無い instance（導いた primary）は `null`
  - 会話の境界：§3.6 の `B0`。境界を検出しないツールでは `null`（その instance の世代の間で 1 回）。新しい会話には前の会話の促しが見えていないので、境界が変われば同じ状態でも 1 回出す［見立て］
  - **範囲**（鍵の 4 つ目、列 `scope_hash`）：`sha256(JSON.stringify([T0.storageRepositoryId, T0 のブランチ（detached は null）]))`。第 3 版は範囲を**値**に置いて (worktree, instance, code) の 1 行を上書きしたので、同じ境界・世代でブランチを A→B→A→B と往復すると、各ブランチの材料が変わらなくても毎回出た（3 回目の再確認の質問）。PM は受入基準を弱めないので、第 4 版は範囲を**鍵**に入れ、**範囲ごとに行を持つ**。第 2 版が鍵から外した理由（行の寿命を決められない）は、§4.3 の「範囲のブランチが git から消えた」掃除（quiet の書き込みの同じ transaction）で閉じる。Codex の 1 回目の指摘（前のブランチで出した記録で新しいブランチの促しを抑える）も閉じたまま：範囲が違えば別の行。ブランチ名を表に残さないよう、hash にする（自由入力に近い文字列を F の表に置かない。D12）
- 指紋：`sha256(JSON.stringify([code, 規則ごとの材料]))`。材料は §3.2 の「指紋に入れるもの」を ID の順に並べた配列。**時刻を入れない**（`stale` に変わった瞬間に 1 回出て、更新されるまで同じ指紋）。項目を更新すれば `version` が変わり、まだ当たれば新しい指紋でもう 1 回出る
- `--quiet` が 1 回の呼び出しで出す 1 行は、新しい値を持つ code をまとめたもの。記録するのは出した code の分だけ
- 前のブランチ・前の storage root に戻っても、その範囲の行が残っていて値（世代・境界・指紋）が同じなら出ない（往復で再通知しない。ブランチは第 4 版、storage root は第 5 版）。行の無い範囲（初めてのブランチ・初めての root、git から消えて行が消えた後に作り直したブランチ、登録を消して作り直した root＝別の ID）では 1 回出る

### 4.2 保存先（S3：永続。migration v70）

```sql
-- src/lib/db/migrations/v70-suggestion-shown.ts（CURRENT_SCHEMA_VERSION = 70）
CREATE TABLE suggestion_shown (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  code TEXT NOT NULL,
  instance_incarnation TEXT,
  boundary_id TEXT,
  scope_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  shown_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, instance_id, code, scope_hash)
);
```

- **番号**：v70（PM の決定。E #4225 が v69＝`v69-mem-promote.ts`［事実：E の設計 §6.1］、G #4227 は v71 に入れ替え）。マージの順は E → F → G。runner は今の版より上の版を全部当てる（v68 の注、`v68-session-brief-boundaries.ts:15-17`［事実］）ので、v69 が先に入っていても入っていなくても v70 に届く。`CURRENT_SCHEMA_VERSION`（`runner.ts:34`、今は 68［事実］）は E のマージの後の F の実装の契約で 70 にする
- **名前**：表は `suggestion_shown`、ファイルは `src/lib/db/suggestion-shown-db.ts`。`mem_` で始めない（PM の条件。A のファイルにしない。E の設計 §11 の I7 のとおり、v66 の試験は「`mem_%` の表が 0」を見るので、`mem_` で始めると v66 より前へ戻す試験に `down` を足す必要が出る）。v66 より前へ戻す既存の試験が上の版の `down` を順に呼ぶ形なら、v70 の `down`（`DROP TABLE IF EXISTS suggestion_shown`）を足すかを実装の契約で `git grep -n "v69_migrations\|v68_migrations" -- tests` で確かめる
- **`worktree_id` の列**：`getWorktreeChildTables`（`worktree-child-tables.ts:47`）は `worktree_id` の列を持つ表を動的に拾い、worktree の ID の改名（`renameWorktreeIdPreservingChildren`、`worktree-id-rename.ts:132`）は子の行を新しい ID へ移し、削除は子の行を消す（`deleteWorktreeChildRows`、`worktree-id-rename.ts:84`）［事実］。F の表もこれに乗るので、**改名で記録が移り（第 2 版の K4 は無くなる）、削除で消える**。改名・削除の関数は変えない
- **本文を持たない**：列は ID・code・世代・境界の ID・hash・時刻だけ。項目の本文・ブランチ名・`--note` の文は置かない
- **関数**（全部同期。`suggestion-shown-db.ts`）：`readShown(db, worktreeId, instanceId, scopeHash): Map<code, ShownRow>`（**対象の範囲 `scopeHash` の行だけを返す**。第 5 版：主キーに範囲を入れた第 4 版で読みの契約が追従しておらず、同じ code の複数の範囲を 1 つの Map で表せなかった。4 回目の再確認の P2）、`settleShown(db, { worktreeId, instanceId, scopeHash, write: ShownRow[], clear: code[], rosterInstanceIds, knownCodes, liveScopeHashes })`（`clear` は今の範囲 `scopeHash` の行だけに当てる。`liveScopeHashes` は §4.3 の掃除の残す範囲。`readShown` と `settleShown` は同じ W5 の build の中で同じ `scopeHash` で呼ぶ）（下の §4.3 の消す処理と書き込みを 1 つの `db.transaction` で行う）
- 書くのは quiet の route の、§3.6 の締めの build の中の照合と同じ同期の区間（W5 の build の中。INV-A）だけ（mode `on`・`promptOnEvents=true` を読み直した直後）。`full=true`（明示の `--suggest`）は読むだけ（`shown` の欄）
- 試験は `os.tmpdir()` 配下の DB（migration を全部当てた SQLite）で行う。**テスト・verify の前に必ず `export CM_DB_PATH=$PWD/data/test.db`**（本番 DB を v70 に上げない。11-01 に worker のテストが本番 DB を v63 に上げた件）。サーバの再起動は同じ DB のファイルを開き直すこと（モジュールの再読み込み `vi.resetModules()` と DB の接続の作り直し）で表す

### 4.3 行の寿命（いつ消すか）

| 条件 | 起きること | 消す場所 |
|---|---|---|
| 同じ鍵（範囲を含む）の世代・境界・指紋が変わった | 次の `--quiet` で出し、値を置き換える（行は増えない） | quiet の書き込み（`INSERT … ON CONFLICT … DO UPDATE`） |
| **規則が当たらなくなった**（quiet が評価した code のうち、`unavailable` でなく「当たらない」と決まったもの） | **今の範囲の** (worktree, instance, code, 範囲) の行を消す（他の範囲の行は、その範囲を評価していないので消さない）。状態が戻ってまた当たれば 1 回出る（状態が変わったので繰り返しではない） | 同じ transaction |
| **規則の表から code が消えた**（版の更新） | その (worktree, instance) の、表に無い code の行を消す | 同じ transaction |
| **roster から instance が消えた**（instance の削除） | 書き込む worktree の行のうち、instance が解いた roster（§3.6）に居ず、かつ `instance_incarnation` が生きていない（`instanceIncarnationAlive` が false、または `null`）ものを消す | 同じ worktree への次の quiet の transaction |
| instance の削除と再追加（ID の再利用） | 世代が違うので未表示と読み、出して置き換える（D5） | quiet の書き込み |
| **worktree の削除** | 子の行として消える（`ON DELETE CASCADE` と `deleteWorktreeChildRows`） | 既存の削除 |
| worktree の ID の改名 | 子の行として新しい ID へ移る（同じ状態なら出ない） | 既存の改名 |
| ブランチ・storage の root が変わった | 行の無い範囲なら 1 回出て、その範囲の行を足す。行の在る範囲（ブランチ・root を往復で戻った）なら値が同じ限り出ない（ブランチは第 4 版、root は第 5 版） | quiet の書き込み |
| **範囲のブランチが git から消えた**（ブランチの削除）・**範囲の root の登録が消えた**（`deleteRepository`、`src/lib/db/db-repository.ts:317`） | その worktree の行（全 instance）のうち、`scope_hash` が残す範囲＝{**登録が残っている root**（W5 の build の中で読んだ `getAllRepositories` の全行の id。enabled か否かは問わない）× (§3.6 の W2 のブランチの一覧の各ブランチ ∪ {null}（detached））} ∪ {今の範囲（unborn のブランチも含む）} の hash に無いものを消す。消えた後に同じ名前で作り直したブランチ・登録し直した root（別の ID）では 1 回出る。**storage の root が変わっただけ**（同じ Git の登録の enabled の入れ替え等で、前の root の登録は残る）**では前の root の行を消さない**（第 5 版。第 4 版は今の storage 以外の root の行を消し、R1→R2→R1 の往復のたびに再通知していた：4 回目の再確認の P1-2） | 同じ worktree への次の quiet の transaction（W5 の build の中）。ブランチの一覧が取れない回は書かない（§3.6） |
| mode が `off`・`derived` になった | 記録は残す（何も書かない・何も評価しない、A §4）。`on` に戻って値が同じなら出さない［見立て：off の間に状態が変わっていなければ、同じ促しになる］ | — |
| サーバの再起動 | **何も消えない**（DB の表）。再起動の後も同じ状態なら出ない | — |

**範囲の次元で行を消すのは次の 4 つだけ**（第 5 版。上の表の行を範囲の次元でまとめたもの）：(1) 範囲の root の**登録が消えた**、(2) 範囲の**ブランチが git から消えた**、(3) **worktree の削除**、(4) その範囲の**状態の指紋の変化**（今の範囲で規則が当たらなくなった行の削除と、値の置き換え）。storage の root が変わった・ブランチを切り替えた・mode が `off` になった・時間が経った、では消さない。code の次元（表から消えた code）と instance の次元（roster から消えた instance）の掃除は上の表のとおりで、範囲の行を余計に残しも消しもしない。

**行の数の上限**（第 4 版、第 5 版で root の数を入れた）：主キーが (worktree, instance, code, 範囲) で、code は quiet の規則の 7 つ（`now_missing`・`now_stale`・`decision_unreflected`・`manual_stale`・`open_count`・`evidence_missing`・`decision_no_destination`）だけ。行を書くのは今の範囲（`T0.storageRepositoryId`, 今のブランチ）だけなので、行の root はその worktree の storage になったことのある root に限られる。表に書く quiet の transaction が同時に「残す範囲」の外を消すので、書いた直後の worktree の行の範囲は、**登録が残っている root のうち storage になったことのある root の数 R_s** ×（ローカルのブランチの数 b + detached の 1）+ 今の範囲（unborn）の 1 を超えない。よって行は **(worktree, instance) あたり最大 7 ×（R_s ×（b + 1）+ 1）≦ 7 × R_s ×（b + 2）**（存続する root の数 × ブランチの数 × code の数）。R_s は同じ Git の登録の数以下（storage は所属の members の先頭：`src/lib/mem/target.ts:102`）で、人が登録した数。b は git の今の状態。どちらも訪ねた回数・時間では増えない（F の表の履歴ではない）ので、行が増えるのは quiet の書き込みだけで、その同じ transaction で掃除する。登録の path を別の Git へ付け替えた root の行は、その root が storage に戻らない限り使われないまま、登録が消えるか worktree が削除されるまで残る（R_s に数えるので上限の内）。worktree の行は worktree の削除で消え、instance の行は roster から消えた後の同じ worktree への次の quiet で消える。残るのは「roster から消えた後・ブランチや登録が消えた後、その worktree で一度も quiet が呼ばれていない」行だけで、その数は最後の quiet の時点の上限で抑えられ、worktree の削除で消える。時刻（期限）で消すことはしない（期限で消すと、期限の後に同じ状態で繰り返す）。

- 新しい定期の実行・タイマー・常駐の見張りを足さない（D8・D13）。消すのはすべて quiet の書き込みの同じ transaction の中と、既存の worktree の削除の中

### 4.4 明示の呼び出しは記録を見ない・quiet は自分の記録だけ

- `--suggest`（`--quiet` なし）は表示済みかを `shown` の欄で出すだけで、出す・出さないを変えず、記録も書かない。人や Agent が自分で聞いたときは、今の状態を全部答える
- quiet が読む・書く記録は、呼び手の身元の (worktree, instance) の鍵だけ（§3.1 の旗の表、§3.6 の直接の route）

### 4.5 既知の制限

| # | 制限 | 起きること | 採った理由 |
|---|---|---|---|
| K3 | **応答が CLI に届く前に切れたとき、その促しは出ない** | サーバが記録した後、応答が CLI の 4 秒の期限に間に合わないと、記録済みで stdout に出ない。同じ状態の間は次も出ない | サーバの期限（3 秒）はサーバの fix から数え、CLI が要求の前に使った時間（whoami・route の手前）を含まないので、この隙間は狭まらない（PM P3-3。CLI の残り時間をサーバへ渡す案は採らず、記述を実際に合わせた）。状態が変われば（項目の更新・会話の境界）また出る。繰り返さない側に倒す（受入基準） |
| K5 | roster から消えた instance の行・git から消えたブランチの範囲の行・登録が消えた root の範囲の行は、その worktree で次に quiet が呼ばれるか worktree が削除されるまで残る。登録が残っている root の範囲の行は、その root が storage でなくなっても残る（往復で再通知しないため。第 5 版） | 行は (worktree, instance) あたり最大 7 × R_s ×（ブランチの数 + 2）で、増え続けない | 消すために定期の実行を足さない（D8） |
| K6 | ブランチの一覧の git が失敗・期限切れの回は、quiet は促さない（第 4 版） | その回の新しい促しは次の quiet まで遅れる | 消せないまま書くと行の上限が保てず、出して記録しないと次も出る。繰り返さない側に倒す |

第 2 版の K1（再起動の後に 1 回繰り返す）・K2（容量を超えて捨てた鍵で 1 回繰り返す）・K4（改名の後に 1 回繰り返す）は、永続の表と改名の追従で**無くなった**（番号は欠番のまま残し、§11 から引けるようにする）。説明（`docs/user-guide/cli-operations-guide.md` と `docs/en/` の対）と試験（§7.3 の I-F2）に K3・K5 をそのまま書く。

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

1. （既存）task の行・relay・Auto-Yes の grant を今の順で取る。**ただし `--note` の送信で、grant を取る前の読み（`readAutoYes`）が状態を決められなかったら、grant を取らずに止める**（再確認の P1 の処置。下の「Auto-Yes の前の状態が不明なとき」）
2. **mem に書く（新しい段。`postMessage` の直前、条件つき・条件なしの両方の経路の合流の後に 1 か所）**：既存の `POST /api/worktrees/<送り手の worktree>/mem/items`（A、`mem add` と同じ口）に `{ kind:'waiting', text:<note>, closeWhen:'relay:<id>', evidence:['relay:<id>'], key:'send-note:<relay id>', instanceId:<送り手> }`
   - **断られたら（mode が `on` でない＝50、検査で 2、件数の上限 56、曖昧・未登録 52/53、届かない）：本文を送らない失敗として、既存の 3 つの後始末を全部通す**：
     1. `failTask()`：`--contract` の task を `failed` にする（`pending` で残さない）
     2. `withdrawAutoYes(true)`：この送信が取った grant を取り下げる。**送信の前から on の grant は保つ**（`priorAutoYes === true` なら何もしない、既存の動き）。`--note` は `--reply-to` を要るので、grant を取る送信では必ず `autoYesTarget` があり、取る前に既存の grant を読もうとする（`:1012-1018`［事実］）。第 2 版は「読んでいるので残す分岐に入らない」と書いたが、**読みが失敗すると `readAutoYes` は `null` を返し（`:464-475`）、`priorAutoYes` は `null` のまま grant を取り（`:1022`）、`withdrawAutoYes` は `priorAutoYes === null` で取り下げずに警告だけ出して戻る（`:1054-1057`）**［事実。Codex の再確認の P1］。`--note` の送信ではこの組を作らない（下）ので、ここに来るときの `priorAutoYes` は `true`・`false` のどちらか
     3. `cancelRelayQuietly(client, relay.id)`：relay を取り下げる
     
     そのうえで mem の exit code（50・2・56・52・53。`send` の他の exit と重ならないことを実装の契約で `git grep` で確かめる［未確認］）で終わる。stderr に「`--note` を記録できなかったので送らなかった」の 1 行（`--note` の原文は繰り返さない：§6.4）
   - **Auto-Yes の前の状態が不明なとき（`--note` の送信だけ）**：`armsNow`（`--auto-yes` で、`--model` の後回しでない）で、`priorAutoYes === null`（読みの失敗、または `agent`・`instanceId` が決まらず読めない）なら、**`enableAutoYes` を呼ぶ前に**止める：`failTask()`、relay を先に取った条件つきの経路では `cancelRelayQuietly`、mem に書かず、本文を送らない。stderr に「Auto-Yes の今の状態を読めなかったので、`--note` の送信を止めた」の 1 行と、`--note` を外すか後で送り直す案内。exit は `ExitCode.UNEXPECTED_ERROR`（99。`send` の既存の「サーバの答えが読めない」と同じ扱い［見立て：実装の契約で `send.ts` の他の読めない失敗の exit を名前で確かめて揃える］）
     - 採らなかった案：`priorAutoYes === null` のとき `onlyIfOff: true` で条件つきに取る。今のサーバは最後の await の後に同期で確かめて断る（`AUTO_YES_ALREADY_ENABLED`、`src/app/api/worktrees/[id]/auto-yes/route.ts:527-541`［事実］）ので既存の grant は守れるが、`onlyIfOff` を知らない古いサーバ（#4132 より前）は旗を無視して既存の grant を上書きし、grant に名前（`grantId`）も無いので取り下げられない（`withdrawArmedAutoYes` の「this server does not name its grants」で残る：`send.ts:526-529`）。状態が不明な送信を止める方が、どのサーバでも grant を残さない
     - `--note` の無い送信は今のまま（読めなくても送り、失敗のときは警告で残す。I-F6 の陰性対照）
   - `--model` で Auto-Yes を送った後に回す経路（`deferAutoYes`、`:982`）は、この段の時点で grant を取っていないので取り下げるものが無い（読みもしない）
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
| `src/lib/db/suggestion-shown-db.ts` | §4.2 の表の読み書き（`readShown`・`settleShown`）と §4.3 の消す処理。全部同期 |
| `src/lib/db/migrations/v70-suggestion-shown.ts` | §4.2 の表（`up`・`down`） |
| `src/lib/mem-suggest/service.ts` | `memSuggest(db, spec, { full, instanceId, hook }, deps)`。§3.6 の固定・`memList` の前の照合・締めの build の中の照合（INV-A）と、§3.2 の前と後の写し。A・B・D1 の export と F の表の関数を呼ぶだけ。**全部の await は `step(id, () => …)` を通し、`id` は同じファイルの export `MEM_SUGGEST_AWAITS`（§3.6 の await の表の W1〜W5 と経路・位置）のキー**（第 5 版。`step` の既定は呼んで待つだけで、試験は `deps.step` の偽で待ちの間に状態を変える） |
| `src/app/api/worktrees/[id]/mem/suggest/route.ts` | §3.1 の `POST` |
| `src/types/mem-suggest.ts` | §3.5 |
| `tests/unit/guards/mem-suggest-no-resident-4226.test.ts` | §7.3 の I-F4 の静的な検査 |
| `tests/unit/guards/mem-suggest-await-table-4226.test.ts` | §7.3 の I-F13（await の表の網羅と INV-A の静的な検査。第 5 版） |
| `tests/unit/lib/mem-suggest/suggest-invariants.test.ts` | §7.3 の表 |
| `tests/unit/cli/mem-check-suggest.test.ts` | §3.1 の CLI の契約（実際の commander の parser から） |
| `tests/unit/db/migration-v70-suggestion-shown-4226.test.ts` | v70 の `up`・`down`、主キー、`getWorktreeChildTables` に拾われること（改名で移り、削除で消える） |

第 1 版にあった `src/lib/hooks/mem-prompt-install.ts`・`src/cli/commands/mem-hooks.ts`（S1）は**作らない**。第 2 版の `src/lib/mem-suggest/shown-memory.ts`（メモリの LRU）は、S3 の差戻しで**作らない**（永続の表に置き換えた）。

### 7.2 変える既存のファイル

| ファイル | 変更 |
|---|---|
| `src/cli/commands/mem.ts` | `run()` の action が数を返せる（§3.1、1 か所）。`check` に `--suggest`・`--quiet`・`--hook [event]`・`--instance <id>` と、`--suggest` があるときだけ新しい route を呼ぶ分岐 1 つ。`MEM_HELP` の exit の表に 57 の 1 行 |
| `src/cli/types/index.ts` | `MemExitCode.SUGGESTED = 57` |
| `src/lib/db/migrations/index.ts`・`runner.ts` | v70 の登録と `CURRENT_SCHEMA_VERSION = 70`（D1 の v68・E の v69 と同じ足し方）。版を固定する既存の試験は実装の契約で `git grep -n "CURRENT_SCHEMA_VERSION\|toBe(69)" -- tests` で探す |
| `src/cli/commands/send.ts` | `--note`（§6）。`validateSendArgs` の検査と、Auto-Yes の前の状態が不明なときに grant の前で止める分岐（§6.2）と、`postMessage` の直前の mem の書き込みの段と、その拒否の後始末（既存の `failTask`・`withdrawAutoYes`・`cancelRelayQuietly` を呼ぶ） |
| `docs/user-guide/cli-operations-guide.md` と `docs/en/` の対 | `mem check --suggest`・`send --note` の節。「意図の書き漏れまでは見つけない」「同じ状態の促しは再起動の後も繰り返さない。応答が届く前に切れた促しは出ないことがある（K3）。消えた instance の記録は次の quiet か worktree の削除で消える（K5）」「OS の権限で API を直接呼べば記録を消費できる」を書く |

**変えないことを試験で固定するもの**：`src/lib/hooks/**` と `scripts/hooks/**`（S1 不採用）、`src/lib/db/migrations/**` のうち v70 の新しいファイルと登録（`index.ts`・`runner.ts`）のほか（既存の版・`worktree-child-tables.ts`・`worktree-id-rename.ts`）、`src/lib/mem/**`・`src/lib/db/mem-*.ts`・`src/lib/brief/**`・`src/lib/db/session-brief-db.ts`。

### 7.3 全入口の不変条件の表駆動の試験

入口（行）× 不変条件（列）を 1 つの表にし、同じ関数で当てる。状態は `os.tmpdir()` 配下の `fs.mkdtempSync` に DB（migration を全部当てた SQLite。v70 を含む）・worktree の root・フックの設定ファイルを作り、`afterEach` で消す。**テスト・verify の前に必ず `export CM_DB_PATH=$PWD/data/test.db`**（ワーカーの tmux はサーバの `CM_DB_PATH` を継ぐので、書かないと本番 DB を v70 に上げる）。本物の `~/.claude`・`~/.codex`・`~/.copilot`・`~/.gemini` には書かない（`CM_AGENT_HOOKS_DIR`・`CODEX_HOME` 等を一時ディレクトリへ向ける。`tests/setup.ts` の `CODEX_HOME` の pin と同じ）。

**入口**：

| # | 入口 |
|---|---|
| E-0 | 旗の無い既存の `mem check`（陰性対照） |
| E-1 | `mem check --suggest`（テキスト） |
| E-2 | `mem check --suggest --json` |
| E-3 | `mem check --suggest --quiet`（skill の手順から） |
| E-4 | `mem check --suggest --quiet --hook <event>` を、身元の無い環境（headless の `codex exec` の形） |
| E-R | route `POST …/mem/suggest` を CLI を通さず直接（`full=true`・`full=false`。roster に居ない任意の未知の ID・別 worktree の instance・**物理の roster の行も世代も無い、`selectedAgents` から導いた primary** を含む） |
| E-5 | 全ツールのフックの設定の生成物（Claude・Codex・Command Code・Copilot・Antigravity・Gemini）— 変えないことの陰性対照 |
| E-7 | `send --note`（条件なし・条件つき（`--role`）・`--contract`・`--auto-yes` の前の状態 **on／off／unknown（読みの失敗）** の 3 値・`--model` の後回し・配送の結果 `sent`／`not-sent`／`indeterminate` の組） |
| E-8 | brief（C の provider と CLI）— F が変えないことの陰性対照 |

**不変条件**：

| # | 不変条件 | 確かめ方 | 陽性対照（壊れた実装で落ちる） | 陰性対照（変わらない動き） |
|---|---|---|---|---|
| I-F1 | `off`・`derived` で促さない | E-1〜E-4・E-R で mode `off`・`derived`：stdout 空、E-1・E-2 は exit 50、E-3・E-4 は exit 0。表 `suggestion_shown` の行が増えない。`promptOnEvents=false` の `on` も促しが 0 | mode を見ずに規則を当てる版、`derived` で `listMem` を読んで捨てる版（読みの回数 0 を偽で確かめる） | `on`・`promptOnEvents=true` で古い `now` の状態なら `now_stale` が出る |
| I-F2 | 同じ状態で 1 回（永続。S3 の差戻し） | E-3 を同じ状態で 3 回：1 回目だけ 1 行、2・3 回目は空。`now` を更新（`version+1`）して古くした状態で 1 回だけ出る。境界の ID・instance の世代を変えると 1 回出る。**ブランチを変える**と 1 回出る。**同じブランチのまま worktree の ID を改名**（`renameWorktreeIdPreservingChildren`）すると**出ない**（行が移る）。改名の後も、自分が作った項目（`owner.worktreeId` が旧い ID）が `decision_unreflected`・`manual_stale` 等の対象に**残る**（記録の鍵だけでなく項目の選別。再確認の P2）。**1,001 個を超える別の鍵（168 の (worktree, instance) × 1 範囲あたり最大 6 code ＝ 1,008。`now_missing` と `now_stale` は排他なので 1 範囲で quiet の 7 code は揃わない：第 6 版、P3-1）を同じ順で 3 周**：1 周目だけ各 1 回出て、2・3 周目は 0。**再起動の後**（同じ DB のファイルを開き直し、モジュールを再読み込み）も同じ状態なら 0。規則が当たらなくなると行が消え、また当たると 1 回出る。roster から instance を消した後の同じ worktree の quiet でその instance の行が消え、worktree の削除で全部消える。**範囲の往復（第 4 版）**：同じ境界・世代で、ブランチを A→B→A→B（各ブランチの材料は変えない）：A・B の 1 回目だけ出て、戻った A・B は 0（範囲ごとの行）。B の材料だけを変えて B に戻ると B だけ 1 回出る。**ブランチの掃除**：101 個のブランチを順に回した後、ブランチの一覧（`deps.listBranches` の偽）から 100 個を外して quiet を 1 回 → 消えた範囲の行が消え、行の数が (worktree, instance) あたり 7 ×（ブランチの数 + 2）以下。ブランチの一覧が失敗した回は促し 0・記録 0（`skipped` に `branches_unknown`）。**storage root の往復（第 5 版）**：同じ Git の登録 R1・R2（両方 mode `on`・`promptOnEvents=true`）で、呼び出しの間に enabled を入れ替えて storage を R1→R2→R1→R2（ブランチ・項目・世代・境界は変えない）：R1・R2 の 1 回目だけ出て、戻った R1・R2 は 0。R2 の登録を消した次の quiet で R2 の範囲の行が消え、登録し直した R2'（別の ID）では 1 回出る。行の数は 7 × R_s ×（ブランチの数 + 2）以下。**往復の試験は表への保存だけを見ず、実際の `readShown(db, worktreeId, instanceId, scopeHash)` から表示の判定（新しい促しの選択）まで通す**（`readShown` を偽にしない。同じ code を 2 つの範囲に持つ状態で、今の範囲の行だけが返ることも確かめる：4 回目の再確認の P2） | 記録を書かない版、指紋に時刻を入れる版（2 回目も出る）、値に境界を入れない版（新しい会話で出ない）、値に範囲を入れない版（ブランチを変えて出ない）、**メモリの LRU（1,000 件）の版（1,001 鍵の 2 周目で全部出て落ちる・再起動の後に出て落ちる）**、改名で行を移さない表（`worktree_id` の列名を変えた版：改名の後に出て落ちる）、`owner.worktreeId` で選ぶ版（改名の後に自分の項目が外れて落ちる）、消す処理の無い版（instance の削除の後も行が残って落ちる）、**範囲を値に置いて 1 行を上書きする版（第 3 版：往復の 2 周目で出て落ちる）、ブランチの掃除の無い版（一覧から外した後も 7 × 101 行が残って落ちる）、一覧の失敗でも書く版（記録が増えて落ちる）**、**今の storage root 以外の行を消す版（第 4 版：R1→R2→R1 の 3 回目で出て落ちる）、登録が消えた root の行を消さない版（R2 の登録を消した後も行が残って落ちる）、`readShown` が範囲を受けず (worktree, instance) の全範囲を 1 つの Map に畳む版（同じ code の別の範囲の行で今の範囲の判定が変わり、往復か初回のどちらかで落ちる）** | E-1 は同じ状態で毎回全部出す（§4.4）。別の instance には別に 1 回。v70 の前の DB の表（v69 まで）は変わらない（migration の試験） |
| I-F3 | 既存のフックの設定が変わらない | E-5：全ツールの生成物・merge の結果が、F の前の期待値（既存の試験）と 1 バイト同じ。静的：`src/lib/mem-suggest/**`・新しい route・`mem.ts`・`send.ts` の F の差分が `@/lib/hooks/**` を import しない | 生成物に手を足す版、`mem-suggest` から生成の関数を呼ぶ版 | 既存の merge の試験（`mergeCodexHookSettings` 等）が変えずに通る |
| I-F4 | モデルの実行と常駐の見張りが増えない | 静的（ガード）：`src/lib/mem-suggest/**`・`src/lib/db/suggestion-shown-db.ts`・新しい route に `setInterval`・`setTimeout`・`setImmediate`・`new Worker`・`fork(`・`detached: true`・`.unref(`・`schedule-manager`/`timer-manager` の import・LLM の SDK・`@/lib/report`・`child_process` が無い。サーバの起動の経路（`server.ts`・`src/lib/server/**`）が `@/lib/mem-suggest` を import しない（B の G1・G2 と同じ形）。動的：`vi.useFakeTimers()` で E-1〜E-3 の後に `vi.getTimerCount() === 0`。**E-3 で F の `withMemTarget` の呼び出しが 1 回（E-1 は W3・W5 の 2 回。第 5 版。数えるのは F の `step('W3')`・`step('W5')`：`memList` は中で `resolveTarget` → `withMemTarget` を呼ぶので、module を spy で数えると E-1 は 3 回になる。第 6 版、P3-2）、呼ぶ順はブランチの一覧 → `withMemTarget`（第 5 版：所属が最後の await）、所属の確認の `observe`（`deps.observe` の偽）は安定のとき 2 回（所属の照会の前と後：`resolve.ts:272`・`:274`）、2 つの `observe` の間に HEAD を変えると再試行で 4 回（`withMemTarget` は 1 回のまま、促しは変えた後の HEAD で決まる）、ブランチの一覧（`deps.listBranches` の偽）が 1 回、B の評価の照会（`deps.evaluation` の git・gh の偽）が 0 回**（第 1 版の「`execFile` が 0 回」は所属の git と両立しないので改めた。第 3 版の「`observe` が 1 回」は既存の安定の確認と両立しないので、`withMemTarget` の呼び出しの回数と `observe` の回数を分けた：3 回目の再確認の P2）。tmux への送信の偽が 0 回 | ガードの走査に `setInterval(` を含む文字列・`execFile` を呼ぶ版を渡すと違反。E-3 で `memList`（評価つき）を呼ぶ版は評価の偽が 1 回以上で落ちる。E-3 で DB のブランチ名で代用する版は `observe` が 0 回で落ちる | E-1 の評価は B の照会だけを呼ぶ（B の期限の helper のタイマーは評価の終わりで 0） |
| I-F5 | `--note` が relay を参照し、relay の事実を写さない | E-7 で作られた項目：kind `waiting`、`closeWhen=relay:<id>`、`evidence=[relay:<id>]`、`text` が `--note` の文と同じ。項目の全欄（`--json` の全鍵）に相手の worktree ID・instance ID・送った時刻の文字列が現れない。relay の取り下げ → B の評価で閉じる | 文に相手の名前を足す版、`evidence` に相手の worktree を足す版、`--reply-to` 無しでも書く版（exit 2 にならず落ちる） | `--note` の無い `send` の body・relay・exit が今と同じ（既存の send の試験が変えずに通る） |
| I-F6 | 記録できない `--note` は送らず、取った副作用を戻す（P1） | E-7 の全部の組で、mem が断る（mode `off`・秘密らしい文字列・件数の上限・届かない）とき：送信の偽が 0 回（本文ゼロ）、relay が取り下げられる、`--contract` の task が `failed`（`pending` で残らない）、**この送信が取った grant は `expectedGrantId` つきで取り下げられる**、**送信の前から on の grant は取り下げの要求が 0 回**、`--model` の後回しでは grant の要求が 0 回、exit が mem の code。**Auto-Yes の前の状態の 3 値**：on（grant の要求 0・取り下げ 0）／off（取った grant を取り下げる）／**unknown（`readAutoYes` の GET を失敗させる）：grant の要求（`POST …/auto-yes` の `enabled:true`）が 0 回、mem の書き込み 0 回、送信 0 回、task `failed`、条件つきでは relay の取り下げ、exit 99** | 送ってから書く版、relay だけ取り下げる版（task が `pending`・grant が残って落ちる）、既存の grant まで止める版、**unknown のまま grant を取る版（今の `send.ts` の分岐：grant が 1 回取られ、mem の拒否の後に取り下げの要求が 0 回で落ちる）** | mode `on` の正しい `--note` は送り、項目が 1 つ。`--note` の無い送信の副作用の順と回数が今と同じ（**unknown でも `--note` が無ければ今どおり grant を取って送る**） |
| I-F7 | 促しの文に自由入力が出ない・長さの上限 | 項目の本文・ブランチ名に目印の文字列・秘密判定の fixture（`ghp_`＋36 文字）・U+202E・BOM を入れ、E-1〜E-3・E-R の stdout・stderr・`--json` に現れない。**quiet の最長の組（§3.4 の 6 つ・`999+`）が 280 バイト以下** | `message` に項目の `text` を入れる版、上限を 240 に戻した版（最長の組で落ちる） | 項目 ID・版・code は出る |
| I-F8 | quiet は止めない・身元が無ければ黙る | E-3・E-4 の §3.1 の exit の表の全行・action の中の旗の誤りの全行・サーバに届かない・期限超えで exit 0。E-4 は stdout が空で記録が増えない。**parser の段（知らない旗）は exit 1 のまま**（範囲の外であることを固定） | 誤りで exit 2 を返す版 | E-1 の旗の誤りは exit 2 |
| I-F9 | F は brief を変えない | E-8：F の実装の前後で C の `brief-invariants.test.ts` が変えずに通る。`getBriefProvider()` の既定は D2 の決めたまま | brief に促しの行を足す版が C の I1・I14（予算・固定の部分）で落ちる | — |
| I-F10 | 規則は欠けた材料・別の版の結果で誤って促さない（P2） | E-1・E-2・E-R：(1) `now` が条件で閉じた → `now_condition_met` だけが出る（`now_missing` は出ず、`skipped` に `version_changed` が無い）。**`memList` の応答を偽造せず**、実際の store に `now` を書き、実際の B の評価と `closeMemItemByCondition` の close（`archiveSlot` の経路）を通す。偽にするのは条件の照会の答え（`met`）だけ（3 回目の再確認の P2）、(2) 版の競合で close が成り立たなかった → `now_condition_met` が出ない、(3) 同じ instance ID を持つ別の worktree の `now` → 呼び手に `now_*` を出さない、(4) `open_count` の境界（`warn-1`・`warn`・`warn+1`）で quiet と `full=true` の答えが一致、(5) 行き先を設定済みの `withheld` の decision → `decision_no_destination` を出さない、(6) `withheld` の項目の `evidence_missing` は `skipped` に `withheld`、**(7) open の decision v1 の条件の照会の偽の await の間に、v2（未成立の条件）へ更新 → `decision_unreflected` の `unreflected` 由来の促しを出さず、`skipped` に `version_changed`**、**(8) `relay` の条件の項目の照会中に版が変わる → `ref_unknown` を出さず `version_changed`** | `memList` の表示の形から `promoteTo` を読む版（(5) で落ちる）、**`now` にも `version + 1` を求める版（第 3 版：(1) で正常に閉じた `now` を `version_changed` で捨て、`now_missing` を出して落ちる）**、`conditions` に無い kind を推す版（(1) で落ちる）、instance ID だけで枠を選ぶ版（(3) で落ちる）、**ID だけで結果を結ぶ版（(7)(8) で v1 の結果が v2 に付いて落ちる）** | 材料の揃った項目の規則は今の表どおり。照会の間に変わらなかった項目の `unreflected`・`ref_unknown` は出る |
| I-F11 | 要求の途中の変化では出力も記録もゼロ・新しい世代を触らない（P1） | E-1〜E-3・E-R で、`withMemTarget`・`memList` の偽の await の間に：`on→off`、`promptOnEvents=false`、instance の削除と再追加（世代が変わる）、worktree の削除、**同じ ID・同じ path での worktree の削除と再作成（新しい世代に、条件が成立する項目を置く）**、ブランチの切り替え、境界の更新（quiet）、quiet の期限の超過、**所属の先の切り替え（第 4 版）**：同じ Git の登録 root R1（enabled・`promptOnEvents=true`）・R2（disabled・`promptOnEvents=false`）、mode は両方 `on`。`memList`（`full=true`）とブランチの一覧（quiet）の偽の await の間に R1・R2 の enabled を入れ替える。所属は**実際の所属の resolver**（`withMemTarget` の既定の `withSettledObservedWorktreeMembership`。偽にするのは `observe` と git の答えだけ）で解き、入れ替えの後に同じ resolver で解き直すと所属が R2 になることを同じ試験で確かめる。**ブランチの一覧の待ちの間の HEAD の切り替え（第 5 版、4 回目の再確認の P1-1）**：ブランチ A（mode `on`・`promptOnEvents=true`、古い `now` がある）・B（mode `off`）。E-3・E-R（quiet）で `deps.listBranches` の偽の待ちの間に `deps.observe` の偽の HEAD を A→B に変える → 促し 0・記録 0（W5 が B で解いて `off`）。**await の表の全行で同じ対照（表駆動）**：`MEM_SUGGEST_AWAITS` の各行（W1〜W5。経路の合う E-1〜E-3・E-R）× 変化の種類（HEAD の A(on)→B(off)、`on→off`、`promptOnEvents=false`、所属の先の切り替え、instance の削除と再追加、worktree の削除と再作成、境界の更新）を、`deps.step` の偽がその await の待ちの間に変化を入れる形で 1 つの表から回す。期待は、W1（固定の前）では**変わった後の状態で答える**（`off` 系は促し 0・記録 0、寿命の変化は新しい世代で答える）、W2〜W5 では促し 0・記録 0（`off` か `discarded`、W5 の待ちの間は resolver の試し直しの後の状態）。表の行は `MEM_SUGGEST_AWAITS` から読む（試験の側で await を列挙しない）ので、表に足した await は自動でこの対照に入る。どれも stdout の促し 0・表の記録 0、`--json` は `discarded`。**削除と再作成では、新しい世代の DB の項目（`state`・`version`・close の記録）も変わらない**：`withMemTarget` の await の間なら `memList` が呼ばれない（呼び出しの偽が 0 回）、`memList` の中の await の間なら B の close が断る | 再確認をしない版、出力の前だけ再確認して記録の前にしない版、記録の後に再確認する版、**`memList` の前に照合しない版（新しい世代の項目が閉じて落ちる）**、**登録の状態を照合しない版（第 3 版：旧い R1 の設定が `on`・`true` のままで、R2 の `promptOnEvents=false` を見落として促しを返し落ちる）**、**ブランチの一覧を `withMemTarget` の後に置く版（第 4 版：一覧の待ちの間の A→B で A の材料の促しを返し、記録して落ちる）**、**`withMemTarget` の build が返った後に判定・記録する版（build の外の照合：W5 の後に足した偽の await の間の変化で落ちる）** | 同じ寿命のまま、**正当な `null → lazy` の世代の発行**（mem の最初の書き込み）が間に入ったとき（`C0` は偽でなく**実際の `resolveAgentInstances` の戻り値の要素の `cliTool`**。roster の欄を `cliToolId` で読む版は `undefined` を渡して `discarded` になり落ちる：3 回目の再確認の P2）、**worktree の世代が未発行の worktree への初回の `full=true`**（`fixMemEvalLifetime` が作った世代と `memList` の固定値が同じ）は、促しが出て記録される（第 2 版の `getWorktreeIncarnation` で固定する版は初回が `discarded` になって落ちる）。**導いた primary（物理の行も世代も無い）は E-R で成功し、任意の未知の ID は断られる**（`suggestions: []`・記録 0）。登録の全行の id・path・enabled が同じ（表示名の変更だけ）なら所属の照合は通り、促しが出る（無関係な repository の登録の追加・削除でも捨てる：安全側） |
| I-F12 | CLI の契約（S2） | `tests/unit/cli/mem-check-suggest.test.ts`：実際の `createMemCommand()` の parser で、57（促しあり）・0（なし）・50（off）、`--quiet --json`（quiet が勝つ）、値の無い `--hook`（quiet 0・無しで 2）、`--suggest` 無しの `--instance`（2）、`--suggest --branch`（2） | `run()` が 57 を 0 にする版、`--hook <event>` を値の要る形で宣言した版（値なしが parser で exit 1 になり落ちる） | **E-0：旗の無い `check` の出力・exit・要求の body が今と同じ**。他の subcommand は exit 0 のまま |
| I-F13 | await の表の網羅と INV-A（第 5 版。D2 の §3 の連鎖の網羅・E の T23 の書き込みの網羅と同じ、本文から求めて表と突き合わせる形） | 静的（`tests/unit/guards/mem-suggest-await-table-4226.test.ts`。TypeScript の構文木で読む）：(1) `src/lib/mem-suggest/**` と新しい route の全部の `await`（`for await` を含む）が `step('<id>', …)` の形で、`<id>` が `MEM_SUGGEST_AWAITS` のキー。`.then(`・await の無い Promise の受け渡し（`void p`・`return p` で Promise を返す helper）も違反、(2) `MEM_SUGGEST_AWAITS` のキーが全部使われている（表と本文が一致）、(3) `settleShown`・`readShown`・規則の判定（`rules.ts` の export）・出力の組み立ての呼び出しが、`step('W5', …)` に渡す `withMemTarget` の build の関数の中にだけある（helper 越しも呼び出しの連鎖を解いて見る）、(4) build の関数が `async` でなく、Promise を返さない。動的：I-F11 の表駆動の対照 | 合成の source で落ちる：素の `await deps.listBranches()`、表に無い `step('W9', …)`、使われない表のキー、W5 の後の `settleShown`、build の外での `readShown`、`async` の build、helper の中の素の await | 今の `service.ts`・route は通る。読みだけの同期の helper（指紋の計算等）は build の外でも違反にしない。保証の範囲は直接の呼び出し・import の別名・変数の別名・1 段の helper の逆引きまで（多段の helper・高階関数・動的な呼び出しは範囲の外。§3.6 の「INV-A を固定するものと、I-F13 のガードの保証の範囲」） |

試験のファイル：`tests/unit/lib/mem-suggest/suggest-invariants.test.ts`（E-1〜E-4・E-R・E-7）、`tests/unit/cli/mem-check-suggest.test.ts`（I-F12）、`tests/unit/guards/mem-suggest-no-resident-4226.test.ts`（I-F4 の静的・I-F3 の import）、`tests/unit/guards/mem-suggest-await-table-4226.test.ts`（I-F13）、`tests/unit/db/migration-v70-suggestion-shown-4226.test.ts`（v70）。確認のコマンドは `export CM_DB_PATH=$PWD/data/test.db` の後に `npx vitest run <これらのファイル> tests/unit/guards tests/unit/docs`・`npm run lint`・`npx tsc --noEmit`。

### 7.4 実装の分け方［見立て］

1. **F-1**：§3〜§6 と I-F1〜I-F13。フックの手は置かない（全ツール「戻さない」で、代わりの経路だけ）。migration は v70 の 1 つ（§4.2）。マージの順は E（v69）→ F（v70）→ G（v71）（PM の決定）。実装の契約は E のマージの後に出し、`CURRENT_SCHEMA_VERSION` を 69 → 70 にする
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
| U-F13 | `--note` の送信で Auto-Yes の前の状態が不明なとき止める exit を 99 にするか（§6.2） | `send` の他の「読めない」失敗の exit に揃える。揃える先が別の値なら実装の契約で直す |
| U-F14 | **決定済み（PM、2026-11-09。3 回目の再確認の質問への答え）**：ブランチを往復（A→B→A→B）しても、各範囲の材料が変わらなければ再通知しない（受入基準を弱めない） | 範囲を鍵に入れ、範囲ごとに行を持つ（§4.1）。行の寿命はブランチの削除に結ぶ：quiet がブランチの一覧の git を 1 つ走らせ、同じ transaction で git に無い範囲の行を消す（§3.6・§4.3）。行は (worktree, instance) あたり最大 7 ×（ブランチの数 + 2）。I-F2 に往復と掃除の試験。**第 5 版**：storage root の往復（R1→R2→R1）も同じ扱いにし、登録が残っている root の範囲の行を消さない。上限は 7 × R_s ×（ブランチの数 + 2）（§4.3） |

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
| 寿命の固定の写し：評価の全入口（`mem list`・`mem check`・brief・preview） | 全部 `fixMemEvalLifetime` で await の前に固定する（`evaluate.ts:99-103` の注、`service.ts:534`・`:602`）。F も同じ関数で固定する（§3.6）。F の 2 段（F の所属の await → `memList`）は既存の入口に無い形なので、`memList` の前の照合を F にだけ足す。既存の入口は変えない |
| 所有の判定の写し：A の `ownedBy`（`mem-db.ts:857`）と F の規則の対象（§3.2） | 揃えた（instance と世代。`owner.worktreeId` を見ない）。B の `closeItemByCondition` の `triggeredBy` は記録の欄で、選別ではない |
| roster の写し：`resolveAgentInstances`（導いた primary を含む）と D1 の `readInstanceLifetime`（物理の行だけを `onRoster`） | F は所属に前者、寿命に後者を使う（§3.6）。D1 の関数は変えない |
| Auto-Yes の「読めないまま取る」写し：`send.ts` の条件つき・条件なしの経路 | 両方とも `priorAutoYes === null` で grant を取りうる（`:1022`）。F は `--note` の送信だけ止める（§6.2）。`--note` の無い送信の動きは変えない（範囲の外。本文に無い指摘としては挙げない：警告と止め方の案内を出す既存の設計） |
| 所属の署名の写し：所属の resolver の `rootsSignature`（`resolve.ts:208`、private）と F の `R0`（§3.6） | F は同じ式（`getAllRepositories` の全行の `[id, path, enabled]`）を自分のファイルに持つ。resolver を export に変えない（A・既存のファイルを変えない）。式が分かれる危うさは I-F11 の所属の先の切り替えで、実際の resolver と並べて固定する |
| close の版の写し：`closeMemItemByCondition` の 2 つの経路（`now` の `archiveSlot` は版を保つ、通常の項目は `version + 1`）と、手で閉じる `closeMemItem`（`mem-db.ts:939` も `now` は `archiveSlot`） | F は `now` と通常の項目で照合を分ける（§3.2）。手で閉じた項目は `closeReason` が `condition` でないので `closed:true` の結果として使わない |
| 表の子の行の追従：`worktree_id` の列を持つ既存の表（`session_brief_boundaries` 等） | 同じ規約に乗る（§4.2）。`getWorktreeChildTables` が動的に拾うので、登録の表は無い［事実：`worktree-child-tables.ts:47-90`］ |
| 「最後の await の後の同期の区間」の写し：所属の resolver の build（`resolve.ts:292` の注：登録の署名を比べた同じ同期の区間で走り、plain data を返す）と F の INV-A（§3.6） | F は自分の照合・判定・記録をこの build の中に置く（W5）。resolver・`withMemTarget` は変えない。F の他の await（W1〜W4）は表に置き、I-F13 で表と本文を突き合わせる |
| await の網羅の検査の写し：D2 の §3（呼び出しの連鎖の走査の網羅）・E の T23（書き込みの連鎖の網羅：本文から求めて表と突き合わせ、合成の source で落とす） | F の I-F13 は同じ形（本文の `await` を構文木で求め、`MEM_SUGGEST_AWAITS` と突き合わせ、合成の source を陽性対照にする）。D2・E のファイルは読むだけで変えない |
| 範囲の掃除の残す集合の写し：ブランチ（git の今のローカルのブランチ）と root（`getAllRepositories` の今の登録） | 両方とも「今在るもの」で残し、「今の storage・今の HEAD」で残さない（§4.3。第 4 版は root だけ今の storage で残していた） |

---

## 10. 本文に無い指摘（この設計の範囲外。直さない）

- `mem check --json` の `branch` は生のブランチ名を出している（`src/lib/mem/service.ts:616`）。C は brief の出口でブランチ名を置き換える（`src/lib/brief/sanitize.ts:126`）。`mem list`・`mem check` の `--json` の出口の扱いは A・B の範囲（F の `--json` だけ C に揃える、§3.5）
- `cmate-agent-event.sh` の注（`:96-100`）は Codex の `PreCompact`・`PostCompact` を「実在する」と書くが、`tests/fixtures/hooks/codex/` に採取が無い（`session-start.json` 等 7 件だけ）。§8.2 の C1（U-F3）の実測で採取を足す
- `memList`（`src/lib/mem/service.ts:527-557`）は評価の await の後、最初に解決した mode と target で応答を組み立て、照会の間の `on→off` を見ない。F は自分の出力の前に読み直す（§3.6）が、`mem list` 自身の応答は A・B の範囲で直さない

---

## 11. 事前レビューの処置

### 11.1 1 回目（Codex、`prereview/review-4226.md`、2026-11-09。第 2 版で処置）

| # | 重さ | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|---|
| 1 | P1 | 照会中の設定・寿命の変更を、出力の直前に確かめる経路が無い（`memList` は await の後に古い mode で組み立てる） | **採る** | 古い要求が促しを返し、新しい世代の記録を消費しうる。D1 の寿命の比較と A の同期の `decideRootMode` で、F のファイルの中で閉じられる | §3.6 を新設（固定・再確認・期限）。§3.1 の exit の表に「途中で変わった」の行。§3.5 に `discarded`。§7.3 に I-F11（`null→lazy` の陰性対照を含む） |
| 2 | P1 | `--note` の保存の拒否で、契約の task と Auto-Yes が残る | **採る** | 拒否は `postMessage` の前で、既存の失敗の処理に入らない。既存の 3 つの後始末を呼べば足りる | §6.2 を書き直し（書く位置を `postMessage` の直前の 1 か所に移し、拒否で `failTask`・`withdrawAutoYes(true)`・`cancelRelayQuietly`）。§7.3 の E-7 を組み合わせに広げ、I-F6 を改めた。§9 に後始末の写しの行 |
| 3 | P2 | S1 の手の形が Command Code・Gemini の既存の所有の判定に当たらない | **採らない（S1 不採用）** | PM の決定で S1 を採らず、手を足さない | §8.2 の C3 に、後で採るときの条件として残した（#4289） |
| 4 | P2 | quiet の「git を呼ばず DB だけ」は `withMemTarget` の所属の git と両立しない | **採る** | 事実（`target.ts:128`→`git-observe.ts:23`）。DB のブランチ名で代用すると切り替え後の `off` を破る | §3.1（所属の git はする）、§3.6（許す処理・許さない処理・CLI 4 秒／サーバ 3 秒の期限）。I-F4 の「`execFile` 0 回」を「所属の `observe` 1 回・評価の照会 0 回」に改め、代用の版を陽性対照に |
| 5 | P2 | 規則の材料が予定の応答に揃わない（閉じた `now`・`warnings`・`withheld`） | **採る** | 事実（`mem-db.ts:1060-1083`・`service.ts:311`・`types/mem.ts:100`）。欠けた材料を「未設定」と読むと誤って促す | §3.2 に材料の取り方（`listMem` の `MemRecord`・`getMemRecord`・`countOpenItems`）と `unavailable` の列。§7.3 に I-F10（close の成功／版の競合・別 worktree の同じ instance ID・閾値の境界・行き先つきの `withheld`） |
| 6 | P2 | 指紋の範囲に repository・ブランチが無い。Map は 1,001 件目の追い出しで再起動の前にも繰り返す | **採る**（範囲）／**一部採る**（容量：繰り返しを既知の制限として明記） | 範囲は鍵に足せば閉じる。容量は、捨てない形はメモリが増え続け、記録しない形は新しい促しを出せず、どちらも 1 回の繰り返しより悪い。PM の決定（S3 はメモリだけ・migration を足さない）の内で、上限と LRU と繰り返しを明記した | 第 2 版：§4.1（鍵に repository・branch）、§4.2（上限 1,000・LRU）、§4.5（K1〜K4）。**第 3 版で改めた**：容量の部分は §11.2 の 1 で永続に覆り、repository・ブランチは鍵から値（範囲の hash）へ移した（§4.1。行の数を抑えるため） |
| 7 | P2 | フックの登録の順は D1 の境界の更新との実行の順に使えない | **採らない（S1 不採用）**／quiet の側は一部採る | フックの手を足さないので、登録の順に依る作りが無い。skill から呼ぶ quiet でも境界が途中で動きうるので、境界を固定して記録の前に再確認する | §8.2 の C5 に条件として残した（#4289）。§3.6 の再確認の 5 に境界 |
| 8 | P2 | S2 は旗 3 つと分岐 1 つだけでは CLI の契約を閉じられない（`run()` が常に 0、`--instance` が無い、parser の段） | **採る** | 事実（`mem.ts:179-188`・`:204-212`）。PM の決定も具体化を求めた | §3.1 を書き直し（足す 4 つの旗と宣言の形、57 を返す `run()` の 1 か所、旗の組み合わせの表、parser の段は commander の既定のまま＝quiet の「常に 0」は action の後）。§7.3 に E-0・I-F12 |
| 9 | P2 | S1 は出来事ごとの出力の形まで表にする必要がある。trust は定義の hash | **採らない（S1 不採用）** | 手を足さないので出力の形に依る作りが無い | §8.2 の C1・C2・C4 に条件として残した（#4289） |
| 10 | P3 | OpenCode V2 の開始を ○ としていた。quiet の 240 バイトの上限を最長の組が超える | **採る** | 事実（`opencode-v2/source.ts:292` に `session_start` が無い。最長の組は 260 バイト） | §1.1 で OpenCode と OpenCode V2 の行を分けた。§3.4 の上限を 280 バイトにし、最長の組を I-F7 に |
| 11 | 補足 | Claude には `Stop.additionalContext` という非エラーの戻し方もある。「block しかない」でなく「追加のモデルの実行を避けるため使わない」と書く | **採る** | 文の正確さ | §0.2 の F4 |
| 12 | 補足 | 試験の表に既存の check・HTTP route の直接の呼び出し・send の組・既存の brief を並べ、CLI の身元の検査だけで直接の route の記録を守れるとしない | **採る**（S1 の行は除く） | route は CLI を通らずに呼べる | §7.3 に E-0・E-R、E-7 の組。§3.6 の「直接の route の呼び出し」 |
| 13 | 推奨 | S3 は永続の表を採る | **採らない**（第 2 版）→ **第 3 版で採る**（§11.2 の 1） | 第 2 版：PM の決定（メモリだけ）。Codex はメモリだけを P1 にしていない。第 3 版：再確認で P1 になり、PM が永続に差し戻した | §0.1・§4.2・§4.5 |

### 11.2 2 回目（Codex の再確認、`prereview/review-4226b.md`、2026-11-09。PM の決定 `pm-decision-4226-s3-4227-sf.md` の F の節とあわせて第 3 版で処置）

再確認は第 2 版の 1 回目の処置のうち、旧 4・5・8・10 を「解消」、旧 3・7・9 を「S1 不採用で範囲外」、旧 1・2・6 を「一部解消」とした。残りと追加の指摘の処置：

| # | 重さ | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|---|
| 1 | P1 | S3 のメモリの LRU は受入基準に反する：1,001 鍵を同じ順で回すと毎周すべて再通知、再起動でも再通知。「以前 P2 だった」は例外の根拠にならない（旧 6 の残り） | **採る**（PM の差戻し：永続） | 反例は正しい：LRU は使い続ける鍵の数が上限を 1 つ超えるだけで毎回すべて追い出す。PM は受入基準を弱めない。永続にしても、鍵を (worktree, instance, code) にして範囲を値へ移せば、行は (worktree, instance) あたり 7 以下に収まり、無限に増えない | §0.1 の S3 の行と理由、§3.1 の注、§3.6（DB の transaction）、§4 を書き直し（鍵と値、v70 の表、行の寿命の表と上限、K1・K2・K4 の削除と K5）、§7.1（`suggestion-shown-db.ts`・`v70-*.ts`・migration の試験。`shown-memory.ts` を作らない）、§7.2（登録）、§7.3 の I-F2（1,001 鍵を 3 周・再起動の後・行の寿命）と `CM_DB_PATH`、§7.4、§8.1 の U-F14、§9 |
| 2 | P1 | Auto-Yes の事前の読みが失敗すると `priorAutoYes=null` のまま grant を取り、`--note` が拒否されても `withdrawAutoYes(true)` は `null` で取り下げない（旧 2 の残り） | **採る** | 事実（`send.ts:464-475`・`:1015-1022`・`:1054-1057`）。第 2 版の「読んでいるので残す分岐に入らない」は読みの失敗を見落としていた。条件つきの取得（`onlyIfOff`）は今のサーバでは守れるが、旗を知らない古いサーバでは上書きして名前の無い grant を残すので、**状態が不明なら grant を取る前に止める**方を採った | §6.2 の 1 と 2.ii を書き直し、「Auto-Yes の前の状態が不明なとき」を足した（採らなかった案も）。§7.2 の `send.ts` の行。§7.3 の E-7 と I-F6 に on・off・unknown の 3 値。§8.1 の U-F13。§9 |
| 3 | P1 | 古い要求が、新しい worktree の世代の項目を閉じてから捨てられる：`memList` は呼ばれた時点で世代を固定し直し、F の世代の比較はその後（旧 1 の残り） | **採る** | 事実（`service.ts:533-534`、所属の署名は path・repositoryPath：`agent-roles/resolve.ts:305`）。F の所属の await の後、`memList` を呼ぶ同じ同期の区間で寿命を照合すれば、`memList` の固定値は `W0` と一致する。`memList` の中の await の間の変化は B の `aliveOf` が close を断る | §3.6 に「`memList` の前の照合」を足した。§7.3 の I-F11 に同じ ID・path の削除と再作成、新しい世代の DB の項目が変わらないこと、`memList` の前に照合しない版を陽性対照に |
| 4 | P2 | worktree の世代の初回の発行を寿命の変更と誤る：`getWorktreeIncarnation` は未発行で `null`、`memList` の中の `fixMemEvalLifetime` は作る | **採る** | 事実（`incarnation.ts:137-143`・`:145-153`、`evaluate.ts:104-107`）。固定を両方の経路で `fixMemEvalLifetime` に揃えれば、初回でも `W0` と `memList` の固定値が同じになる。再確認は作らない読み（`getWorktreeIncarnation`）で比べる | §3.6 の固定の表の `W0`、§3.1 の注（`off` でも世代を作るのは既存の入口と同じ）。§7.3 の I-F11 に未発行からの初回の `full=true` の陰性対照 |
| 5 | P2 | 改名の後、自分の項目が促しの対象から外れる：`owner.worktreeId` の一致を要求しているが、A は改名の後も旧い ID を残し、所有は instance と世代で決める | **採る** | 事実（`mem-db.ts:856-863` の `ownedBy`）。A と同じ 2 つ（`owner.instanceId`・`owner.incarnation`）に揃える。世代は (worktree, instance) ごとなので、別の worktree の同じ instance ID は世代で外れる | §3.2 の `now_condition_met` の行と「対象の範囲」。§7.3 の I-F2 に改名の後の項目の選別、`owner.worktreeId` で選ぶ版を陽性対照に。§9 |
| 6 | P2 | 旧版の条件の結果を新版の項目に結ぶ：B は評価の前の候補を持ち、decision の `unreflected` を版を確かめずに付け、応答から版を落とす | **採る** | 事実（`evaluate.ts:160`・`:443`、`service.ts:584-588`）。A・B を変えずに、F が `memList` の前と後で記録を写し、版・条件・状態が同じ項目の結果だけを使う（版は増える一方なので前後が同じなら間も同じ）。`closed:true` は B の close が版の一致で書くので `version + 1` で確かめる | §3.2 に「版の確かめ」、`skipped` の `version_changed`。§7.3 の I-F10 に (7) decision・(8) `ref_unknown` の評価中の更新 |
| 7 | P2 | 正当な派生の primary を未登録として断る：物理の roster の行か世代を要求しているが、正本の `resolveAgentInstances` は行が無ければ `selectedAgents` から primary を導く | **採る** | 事実（`agent-instances-resolver.ts:47-60`、`session-brief-db.ts:174-186` の `onRoster` は物理の行だけ）。所属（解いた roster）と寿命（`L0`）を分ける。導いた primary は `L0 = { incarnation: null, onRoster: false }` で、`isSameInstanceLifetime` は途中の `lazy` の発行も同じ寿命と答える | §3.6 の固定の表（所属の行）と「直接の route の呼び出し」、§3.2 の `now_missing`。§7.3 の E-R と I-F11 に導いた primary は成功・任意の未知の ID は断るの対照 |

PM の決定（F の節）の条件の処置：新しいファイル `suggestion-shown-db.ts`（`mem-*` の名前にしない）と `v70-suggestion-shown.ts` → §4.2・§7.1。行の寿命 → §4.3。I-F2 の「1,001 鍵を 3 周」「再起動の後」 → §7.3。`export CM_DB_PATH=$PWD/data/test.db` → §4.2・§7.3。§0.1 の S3 の行と §4 の書き換え → 済み。マージの順 E → F → G・番号 v69／v70／v71 → §0.1・§4.2・§7.4。

### 11.3 3 回目（Codex の再確認、`prereview/review-4226c.md`、2026-11-09。第 4 版で処置）

再確認は第 3 版の 2 回目の処置 7 件のうち、1〜5・7 を「解消」、6 を「一部解消」（`now` の close の版）とした。残りと追加の指摘・質問の処置：

| # | 重さ | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|---|
| 1 | P1 | 所属の先の切り替えで今の `promptOnEvents=false` を見落とす：最終の照合は古い `T0.members` の設定だけを読む。同じ Git の登録 root R1・R2 の enabled を `memList` の await の間に入れ替えると、今の所属は R2 だが、R1 の設定は `on`・`true` のままで、`decideRootMode` は enabled を見ない | **採る** | 事実（`resolve.ts:194-195` の members は enabled の candidates、`mem-db.ts:254` の `decideRootMode` は enabled を見ない）。所属を決めた登録の状態（全行の `[id, path, enabled]`、resolver の `rootsSignature` と同じ形）を `withMemTarget` の build の中で `R0` として控え、再確認で比べて変わっていれば出力も記録も破棄する。全行にするのは、candidates の enabled と同じ Git の登録の追加でも所属が変わるため | §3.6（`R0` の控え、`memList` の前の照合の 1、再確認の 3）、§3.1 の `discarded` の行、§3.7、§7.3 の I-F11（実際の所属の resolver で R1・R2 を入れ替える対照と、登録を照合しない版の陽性対照）、§9 |
| 2 | P2 | 条件で閉じた `now` は版が増えない：`archiveSlot` は `slot.version` のまま写し、別の数えだけを進める。`version + 1` を求めると正常な結果を `version_changed` で捨て、`now_missing` を出す | **採る** | 事実（`mem-db.ts:518`・`:1070-1074`、通常の項目は `:1079` で `version + 1`）。`now` の archive の経路（版が同じ・`closeReason` が `condition`）と通常の項目の版の更新（`version + 1`）を分けて照合する | §3.2 の「版の確かめ」、§7.3 の I-F10(1)（`memList` の応答を偽造せず、実際の store と close を通す。`version + 1` を求める版の陽性対照）、§9 |
| 3 | P2 | roster から読む tool の欄名が違う：`AgentInstance` の欄は `cliTool`。`cliToolId` では型検査に通らず、`undefined` を渡すと正当な `null → lazy` を別の寿命と判定する | **採る** | 事実（`src/lib/cli-tools/types.ts:152`、`session-brief-db.ts:209`） | §3.6 の固定の表（`C0` は `cliTool`）と再確認の 2、§7.3 の I-F11（null→lazy の対照は実際の `resolveAgentInstances` の戻り値で。`cliToolId` で読む版の陽性対照） |
| 4 | P2 | I-F4 の「`observe` が 1 回」は既存の安定の確認と両立しない：resolver は所属の照会の前と後で `observe` を呼び（安定で 2 回）、再試行でさらに増える | **採る** | 事実（`resolve.ts:272`・`:274`、`MAX_MEMBERSHIP_ATTEMPTS`）。`withMemTarget` の呼び出しの回数（1 回）と `observe` の回数（安定で 2 回、間の HEAD の変更で再試行して 4 回）を分ける。条件の評価の照会 0 回は保つ | §7.3 の I-F4 |
| 5 | 質問 | 範囲の往復の再通知：範囲を値に置いて 1 行を上書きするので、ブランチ A→B→A→B で各ブランチの材料が変わらなくても毎回通知する。U-F14 が未決 | **PM の答え：受入基準を弱めない（往復でも再通知しない）**。範囲を鍵に入れ、範囲ごとに行を持つ | 往復を「状態の変更」と読むのは受入基準を弱める。範囲を鍵に入れると行は範囲の数だけ増えるが、quiet がローカルのブランチの一覧の git を 1 つ走らせ、同じ transaction で git に無い範囲の行を消すので、行は (worktree, instance) あたり最大 7 ×（ブランチの数 + 2）に収まり、訪ねた回数・時間では増えない。上限を保てると判断したので止めない。一覧が取れない回は促さない（K6） | §0.1 の S3 の行と理由、§3.1 の quiet の git、§3.6（ブランチの一覧・許す処理）、§4.1（鍵と値）、§4.2（主キー・`settleShown`）、§4.3（往復・掃除の行、行の数の上限）、§4.5（K5・K6）、§7.3 の I-F2（往復・掃除・一覧の失敗）・I-F4（一覧の回数）、§8.1 の U-F14 を決定済みに |

A・B・C・D1 のファイルの作り直しは要らない（`getAllRepositories`・`execGitCommandCapture` は既存の export を呼ぶだけ。`resolve.ts`・`mem-db.ts`・`session-brief-db.ts`・`agent-instances-resolver.ts` は変えない）。D2・E の worktree とファイルには触っていない。

### 11.4 4 回目（Codex の再確認、`prereview/review-4226d.md`、2026-11-09。第 5 版で処置）

再確認は第 4 版の 3 回目の処置 5 件のうち、1〜4 を「解消」、5（範囲の往復）を「一部解消」（repository の範囲を消す例外と読みの API）とした。残りと追加の指摘の処置。方針（PM の契約の決定）：**端を 1 つずつ塞ぐのをやめて規則にする**。

| # | 重さ | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|---|
| 1 | P1 | ブランチの一覧の await の後、旧い HEAD の mode で促せる：一覧は `withMemTarget` の後に await し、最終の照合は `T0.branch` の設定を読むだけで、quiet には HEAD の再観測が無い。A（`on`）の target の後、一覧の待ちの間に B（`off`）へ切り替えると、登録・世代・境界は同じなので照合を通り、A の材料で促し・記録する | **採る（規則にする）** | 個別の穴でなく「最後の await の後の同期の区間で、所属（HEAD・登録・世代・境界）の照合と判定と記録を完結させる」の破れ。HEAD の読みは await なので同期の区間で読み直せない。そこで HEAD を読む await（`withMemTarget`）をどの経路でも最後に置き、その build（resolver が登録の署名を比べた同じ同期の区間で、HEAD は 2 回の `observe` の一致した値：`resolve.ts:238`・`:272-276`・`:292`［事実］）の中で照合・判定・出力の組み立て・記録を終える。quiet は一覧を所属の前へ移し（一覧は掃除の残す範囲にだけ使うので順を入れ替えても意味は変わらない）、full は `memList` の後に締めの所属（W5）を足す（`memList` の中の評価の await の後に HEAD が変わる穴も同じ規則で閉じる）。F の全部の await を表（W1〜W5）にし、`step(id, …)` を通さない await・表と本文の不一致・build の外の記録を静的に落とす（D2・E の網羅の検査と同じ形） | §0.1、§3.1（一覧の順）、§3.5（`membership`・`registration`）、§3.6（INV-A・await の表・所属の W3／W5・一覧の W2・`memList` の前の照合の位置・締めの build の中の照合・期限）、§7.1（`MEM_SUGGEST_AWAITS`・`step`・I-F13 のガードのファイル）、§7.3 の I-F4（`withMemTarget` の回数と順）・I-F11（一覧の待ちの間の A(on)→B(off) で促し・記録ともゼロ、await の表の全行 × 変化の種類の表駆動、陽性対照 2 つ）・I-F13（新設）、§9 |
| 2 | P1 | storage root の往復では同じ材料でも毎回再通知する：往復で再通知しないとしながら、今の storage の repository 以外の行を全部消す。同じ Git の R1・R2 を両方 `on`・`promptOnEvents=true` にして enabled の入れ替えで storage を R1→R2→R1 とすると、前の範囲の履歴が毎回消える | **採る** | 事実（`resolve.ts:194` の所属は enabled の candidates、`target.ts:102` の storage は members の先頭）。第 4 版は行の上限を保つために root の行を今の storage で残したが、往復の抑止と両立しない。**登録が残っている root の範囲の行は消さず**、範囲の次元で消すのを (1) 登録が消えた root、(2) git から消えたブランチ、(3) worktree の削除、(4) 状態の指紋の変化 の 4 つだけにした。行の上限は存続する root の数 × ブランチの数 × code の数で定義し直し、(worktree, instance) あたり最大 7 ×（R_s ×（b + 1）+ 1）≦ 7 × R_s ×（b + 2）。R_s（登録が残っている root のうち storage になったことのある root の数）は同じ Git の登録の数以下で、人が登録した数なので、訪ねた回数・時間では増えない。**上限を保てると判断したので止めない** | §0.1 の S3 の行と理由、§4.1、§4.3（往復の行・掃除の行・範囲の次元で消す 4 つ・上限）、§4.5 の K5、§7.3 の I-F2（R1→R2→R1→R2 の往復、登録の削除と登録し直し、陽性対照 2 つ）、§8.1 の U-F14、§9 |
| 3 | P2 | `readShown` の契約が範囲ごとの行に追従していない：主キーは範囲を含むが、読みは `readShown(db, worktreeId, instanceId): Map<code, ShownRow>` のままで、同じ code の複数の範囲を表せず、対象の範囲の引数も無い | **採る**（`scopeHash` を引数に足し、対象の範囲だけを返す） | 戻り値の鍵を複合にする案より、呼び手（W5 の build）が今の範囲だけを読む形の方が、判定が他の範囲の行に引きずられない。`settleShown` と同じ `scopeHash` を同じ build の中で渡す | §3.6 の締めの build の中の照合の後段、§4.2 の関数、§7.3 の I-F2（往復の試験を実際の `readShown` から表示の判定まで通す。同じ code を 2 つの範囲に持つ状態。範囲を畳む版の陽性対照） |

A・B・C・D1 のファイルの作り直しは要らない（`withMemTarget` の build の同期の区間は A の既存の契約で、F は呼ぶ順と build の中身を変えるだけ。`getAllRepositories` は既存の export を呼ぶだけ。`target.ts`・`resolve.ts`・`mem-db.ts`・`db-repository.ts` は変えない）。D2・E の worktree とファイルには触っていない（設計を読んだだけ）。

---

## 12. 実装（第 6 版。PM の 5 回目のレビューの処分と、実装で確かめたこと）

### 12.1 P2 の処置（PM の処分：必須）

| # | 指摘 | 処置（実装） | 直しを外すと落ちる対照 |
|---|---|---|---|
| P2-1 | I-F13 の「全部の await が `step`」は route の正しい書き方と両立しない | route には**別の規則**を当てる：await は `params` → `readMemBody`（W1）→ `memSuggest` の 3 つだけ、`memSuggest` の後は `return NextResponse.json(…)` だけ。`step` の定義の除外は `runStep`（`service.ts`）の 1 か所だけを名指し。W1 は表に残し、route の規則が通ったとき「使われている」と数える | `tests/unit/guards/mem-suggest-await-table-4226.test.ts` の self-test：route の `memSuggest` の後に await を足すと規則の破れと W1 の未使用で落ちる |
| P2-2 | W5 の行が空虚・誤った期待になる | 注入点は「その await の Promise が解けた後、続きが走る前」（試験の `deps.step` の偽が `await run()` の後に変える）。W5 の**待ちの間**は `deps.observe` の 1 回目と 2 回目の間で変える（resolver が試し直し、build は変わった後の状態で答える＝促し 0・記録 0）。W5 が**解けた後**の変化は陰性の対照で、促しと記録が残る（INV-A の境界。worktree の削除だけは子の行として記録も消える） | `tests/unit/lib/mem-suggest/suggest-invariants.test.ts` の I-F11 の表（`MEM_SUGGEST_AWAITS` の各行 × 変化の種類）。照合を外すと W2〜W5 の行が落ちる（実装中に変異で確かめた） |
| P2-3 | instance の世代が null → lazy に変わると同じ材料の促しがもう 1 回出る | 記録の値の世代の比較を `isSameInstanceLifetime` と同じ規則にした（`sameIncarnation`：保存が null で、今が `lazy` の発行・同じ tool なら同じ）。同じと読んだ行は、その build の `settleShown` で値の世代を X へ書き換える（`shown_at` は保つ） | I-F2 の「P2-3」：導いた primary が null で促し → 最初の書き込みで lazy X → 同じ材料で 0、行の世代が X。値で比べる版は 2 code が再び出て落ちる |
| P2-4 | full の始めからの `off`・`derived`・`promptOnEvents=false` の扱い | W3 の build（`openRequest`）で T0 が `off`・`derived` なら `disabled`（409 → CLI exit 50）、`promptOnEvents=false` なら 200 の `disabledBy`。どちらも `memList` を呼ばない（`withMemTarget` は 1 回）。`discarded` は T0 と違うときだけ | I-F1：`steps` が `['W3']` で、門を外すと W4 へ進んで落ちる |

### 12.2 P3 の処置

- **P3-1・P3-2**：I-F2・I-F4 の行を直した（上の §7.3）
- **P3-3（refname の短縮のずれ）［事実：2026-11-09、git の一時リポジトリで確かめた］**：同じ名前の tag があると `for-each-ref --format=%(refname:short)` も `symbolic-ref --short HEAD` も `heads/foo` を返し、揃っていた。同じ名前の remote（`refs/remotes/origin/main`）では両方 `main`。それでも短縮の規則が分かれる版に備えて、W2 は `--format=%(refname:short) %(refname)` で読み、**短い形と `refs/heads/` を落とした形の両方**を残す範囲に入れる（`branchesOf`）。unborn のブランチは一覧に出ないが、今の範囲は常に残すので行は消えない（離れた後の quiet で消え、戻ると 1 回出る：上限は守られる）
- **P3-4（NOT IN の変数の上限）**：`settleShown` は worktree の行を 1 回読み、残す範囲・既知の code・roster の判定を JS で行って主キーで 1 行ずつ消す。`NOT IN (?, …)` を作らないので変数の上限に当たらない
- **P3-5（本番 DB の守り）**：Vitest は `tests/setup.ts` の `isolateTestDatabaseEnv`（#4086）で、引き継いだ `CM_DB_PATH` も pid ごとの tmp に置き換え、`getDbInstance` は Vitest の下で tmp でないパスを断る（`src/lib/db/db-instance.ts` の backstop）。F の試験は `os.tmpdir()` の下の `mkdtemp` に migration を当てた DB を作り（`openMigratedFileDb`）、再起動の試験はその同じファイルを開き直す（`vi.resetModules()` の後に service を import し直す）。`export CM_DB_PATH=$PWD/data/test.db` は Vitest には冗長だが、verify の他のゲートのために続ける

### 12.3 実装で決めたこと

- **`send --json` は無い**［事実：`createSendCommand` に `--json` は無い］。§6.1 の「`--json` の応答に `note` を足す」は採れないので、stderr に `Note kept in mem: <id>` の 1 行を出す（stdout は `--contract` の task の ID が持つ）
- **`--note` の拒否の exit**：mem の code の写し（`MEM_EXIT_BY_CODE`。50・2・56・52・53 等）。届かないときは 1（`DEPENDENCY_ERROR`）、それ以外は 99。`send` の既存の exit（2・31・32・99）と 50〜56 は重ならない［事実：`git grep` で確かめた。U-F12］。Auto-Yes の前の状態が読めないときは 99（`send` の他の「サーバの答えが読めない」と同じ。U-F13）
- **作成者の無い項目**：mem の項目は全部に作成者の instance がある［事実：`mem_items.origin_instance_id` は NOT NULL］。§3.2 の「作成者の無い（人・サーバの）項目」は `createdBy === 'human'`（画面から人が書いた項目）と読んだ
- **`open_count` の材料**：full も quiet も W5 の build の中で `countOpenItems` を読む（後の写し）。`memList` の `warnings` と同じ式で、I-F10 (4) で `warn-1`・`warn`・`warn+1` の 3 点で quiet・full・`memList` の警告の一致を固定した
- **quiet の一覧の失敗**：`skipped` の code は `all`（何も判定していない）
- **v66 の試験**：`tests/unit/db/migration-v66-mem-store-4221.test.ts` は上の版の `down` を順に呼ぶ形［事実］。v70 の `down` と schema_version の 1 行を足した（期待値は変えていない。§4.2 の確かめ）

### 12.4 共通規則の全読者（5-2b の前に書く）

F が他の module と共有する規則と、その規則を読む全部の場所［事実：2026-11-09 の `git grep`（未追跡の F のファイルを含む）］。規則を変えるときは、この全部を同じ PR で見る。

| 規則 | 正本 | 読む場所 |
|---|---|---|
| 古さ（`memItemStaleness`） | `src/lib/mem/staleness.ts` | `src/lib/mem/present.ts`（一覧・brief・画面の `stale`）、F の `src/lib/mem-suggest/rules.ts`（`now_stale`・`decision_unreflected`・`manual_stale`） |
| 件数の警告（`countOpenItems` ≧ `MEM_OPEN_LIMITS[kind].warn`） | `src/lib/db/mem-db.ts` | `src/lib/mem/service.ts`（`openWarnings`：`mem list`・書き込みの応答）、F の `rules.ts`（`open_count`）と `service.ts`（件数を読む） |
| instance の寿命（`isSameInstanceLifetime`） | `src/lib/db/session-brief-db.ts` | `src/lib/brief/build.ts`、`src/lib/session/session-boundary.ts`、`src/lib/session/session-brief.ts`、F の `service.ts`（`lifetimeMoved`）。記録の値の世代の比較（`sameIncarnation`）は同じ規則の写し（P2-3） |
| 根の mode（`decideRootMode`） | `src/lib/db/mem-db.ts` | `src/lib/mem/target.ts`、`src/lib/db/mem-close-db.ts`（`memModeOnFor`）、`src/lib/brief/build.ts`、F の `service.ts`（`settingsMoved`） |
| ブランチ名の出口（`sanitizeBranch`） | `src/lib/brief/sanitize.ts` | `src/lib/brief/build.ts`、`src/lib/promote/render.ts`、F の `service.ts`（`--json` の `branch`） |
| 登録の署名（`[id, path, enabled]` の全行） | `src/lib/agent-roles/resolve.ts` の private `rootsSignature` | resolver の `withSettledMembership`・`finishAttempt`、F の `service.ts` の `registrationOf`（同じ式の写し。I-F11 の所属の先の切り替えで実際の resolver と並べて固定） |
| 作成者の判定（instance と世代。`owner.worktreeId` を見ない） | `src/lib/db/mem-db.ts` の private `ownedBy` | A の更新・閉じる経路、F の `rules.ts` の `ownsOrPerson`（同じ 2 つの欄の写し。人が書いた項目も対象） |
| 促しの規則の表（`MEM_SUGGEST_CODES`・`MEM_SUGGEST_MESSAGES`・`MEM_SUGGEST_QUIET_CODES`） | `src/types/mem-suggest.ts`・`src/lib/mem-suggest/rules.ts` | F の `service.ts`（判定・記録の `knownCodes`）、`src/cli/commands/mem.ts`（テキスト・quiet）、route、試験。G（#4227）が読むかは G の判断 |
| await の表（`MEM_SUGGEST_AWAITS`） | `src/lib/mem-suggest/service.ts` | `service.ts` の `step`、route（W1）、`tests/unit/guards/mem-suggest-await-table-4226.test.ts`（`paths`・`position` も読み、経路ごとの step の順・回数と照合する。§12.5）、`tests/unit/lib/mem-suggest/suggest-invariants.test.ts`（I-F11 の表） |
| セッションの身元（`resolveSessionIdentity`） | `src/cli/commands/whoami.ts` | `mem.ts` の `identityOf`（書き込み・読みの対象）と、quiet の `quietIdentity`（環境変数を先に読み、tmux は期限つきで 1 回だけ聞き、その名前を `identityFromSessionName` で whoami の `splitRemainder` と同じ規則で解く。Codex P2-1・5-2c P2-1。規則の写しは `mem-check-suggest.test.ts` で `resolveSessionIdentity` と並べて固定）、`send.ts` の `--note` の作成者 |
| 記録の表（`readShown`・`settleShown`） | `src/lib/db/suggestion-shown-db.ts` | F の `service.ts` の W5 の build だけ（I-F13 の (3) で固定）。改名・削除の追従は `getWorktreeChildTables` が動的に拾う |

### 12.5 5-2b（Codex）と PM の再レビューの処置

対象：Codex の `review-4226.md`（P2 2 件）と、PM の `pm-review-4226-claude.md`（P3 5 件）の処分。develop（D2・E（v69）・#4288）を取り込んだ `b8520e4e0` の上で直した。

| # | 指摘 | 処置（実装） | 直しを外すと落ちる対照 |
|---|---|---|---|
| Codex P2-1 | quiet の 4 秒の期限が身元の解決に届かない（`resolveSessionIdentity` は期限の無い同期の `tmux display-message` を、環境変数を読む前に呼ぶ） | `mem.ts` の `quietIdentity`：まず `TMUX` を外した環境で `resolveSessionIdentity` を呼ぶ（tmux を呼ばない。環境変数の身元はこれで決まる）。名前が無く `TMUX` があるときだけ、`execFile` の子プロセスで tmux に聞き、残り時間で `SIGKILL` する。答えが来たら、いつもの `resolveSessionIdentity` で身元を解く。`whoami.ts` は変えない（scope 外） | `tests/unit/cli/mem-check-suggest.test.ts`：PATH の先頭に 12 秒止まる偽の `tmux`（mkdtemp）を置き、身元の無い quiet が 7 秒以内に無出力・exit 0・送信 0 で戻る。環境変数で身元が分かるときは tmux が止まっていても 7 秒以内に送る。直しを外すと両方 12 秒待って落ちる。陰性：答える tmux は従来どおりその session の身元で送る |
| Codex P2-2・PM P3-1 | await の網羅の検査が 3 ファイルの固定列挙で、別のファイルを辿らない。表の id の使い回し・順の入れ替え・浮いた Promise を通す | guard を (5)(6) に広げた：対象は `src/lib/mem-suggest/**` を `readdirSync` で列挙。import した helper は別名を解いて辿る（(3) の到達の判定も同じ）。`memSuggest` の全経路を、呼ぶ helper を展開して step の id の列にし、表の `paths`・順・`position: 'last'` から作る列（quiet `W2 → W5`、full `W3 → W4 → W5`）の接頭辞であること、各列を歩く経路があることを確かめる。ループ・`try`・条件式・関数値の中の step は断る。型が Promise の呼び出しは、await されるか `step` の arrow（と `runStep`）が返すものでなければ違反（route も） | guard の self-test 9 件（G1 の `W2 → W5 → W2`、G3 の `W5 → W2 → W5`、quiet から W5 を外す、ループの中の step、build の中の浮いた `execGitCommandCapture`、`memSuggest` が `memList` を返す、別ファイルの素の await、別ファイルの helper の中の W2 を W5 の後に呼ぶ、別ファイルの helper の `readShown`）。前の guard ではどれも通る（9 件とも落ちないことを実行で確かめた）。陰性：別ファイルの同期の helper を build から呼ぶのは違反なし |
| PM P3-2 | `--agent` だけの `send --note --auto-yes` が必ず exit 99「後でもう一度」 | 宛先を決めた直後（副作用の前）に、`--note`・`--auto-yes`（`--model` で後回しにしない）で instance が決まらなければ exit 2「`--instance` が要る」。読めなかったときの exit 99 はそのまま | `tests/unit/cli/commands/send-note-4226.test.ts`：exit 2・要求 0・文言に `--instance`。直しを外すと exit 99 で落ちる。陰性：`--note` なし・`--auto-yes` なし・`--instance` ありは従来どおり |
| PM P3-3 | 「隙間を狭くしている」の根拠が弱い | 小さい方を採り、記述を実際に合わせた（ja・en の cli-operations-guide、§3.6、§4.5 の K3）。CLI の残り時間をサーバへ渡す案は採らない | 文書だけ |
| PM P3-4 | quiet の W5 の `gateOf` を外しても落ちない | 記録だけ（処分どおり）。`settingsMoved` が同じ結果に倒すので害は無い | — |
| PM P3-5 | マージの手順 | 手順（PM が行う）。この契約では develop を取り込んだ木で検証をやり直す | — |

残り：quiet で tmux に答えが来た後の `resolveSessionIdentity` は、もう一度同期の `tmux display-message` を呼ぶ（`whoami.ts` の `readTmuxSessionName` に期限が無い。scope 外なので直さない）。答えた直後の 2 回目なので、止まるのは tmux がその間に止まったときだけ。（→ §12.6 の 5-2c P2-1 で解消。2 回目の読み取りをなくした）

### 12.6 5-2c（Codex の再レビュー `review-4226b.md`）の処置

| # | 指摘 | 処置（実装） | 直しを外すと落ちる対照 |
|---|---|---|---|
| Codex P2-1 | quiet で tmux が 1 回答えた後、`resolveSessionIdentity` が期限の無い同期の `tmux display-message` で読み直す（1 回答えたことは 2 回目が間に合う証拠にならない） | `mem.ts`：`tmuxAnswersBy`（真偽）を `tmuxSessionNameBy`（期限内に得た名前）に替え、その名前から `identityFromSessionName` で身元を作る（`parseSessionName` で割り、末尾の `-<n>` は quiet の期限つき client で読んだ worktree の一覧で whoami の `splitRemainder` と同じ規則で決める。一覧の期限切れは投げ直す）。tmux は 1 回しか呼ばない。`whoami.ts` は変えない（scope 外） | `tests/unit/cli/mem-check-suggest.test.ts`：1 回目は `mcbd-claude-w` を即答し 2 回目からは 12 秒止まる偽の `tmux` で、quiet が 7 秒以内に `w`・`claude` で送る。直しを外すと 12 秒待って落ちる。陰性：`-<n>` の曖昧さ 5 例（一覧に `w` だけ／`w-2` だけ／両方／一覧なし／名前空間つき）で quiet の送り先と `resolveSessionIdentity` の答えが一致する。CommandMate の名前でない session は何も送らない |
| Codex P2-2 | 記録の関数（`RESTRICTED`）の分類が呼び出しの綴り（`calleeName`）で、`settleShown as settleLate` の別名を見逃す | guard の `declaredCalleeName`：呼び出し先の symbol を import の別名（`getAliasedSymbol`）と、識別子・プロパティを初期値にする変数の束縛まで辿り、宣言の名前で分類する。build が辿る helper を build の外から呼ぶ検査も、名前の文字列でなく宣言の一致（`declarationOf`）で見る | guard の self-test 4 件（`settleShown as settleLate` を W5 の後に同期で呼ぶ、`const settleLate = settleShown` を W5 の後に呼ぶ、別ファイルで `readShown as peekRecord` を build の外から呼ぶ、build が辿る helper を `peek as look` で build の外からも呼ぶ）。前の guard では 4 件とも違反が出ない（self-test が落ちることを実行で確かめた）。陰性：W5 の build の中の `settleShown as settleRecord` は違反なし |
| Codex P3 | develop の取り込みで、E の旧い「決定を正本へ記録する」の節が最新の節の前に二重に残った（ja・en） | 旧い方の節を両言語から取り除いた。`git diff origin/develop` で F の追記だけが残ることを確かめた | 文書だけ |

### 12.7 5-2b の再レビューの続き（Codex `review-4226c.md`・`review-4226d.md`）と PM の決定

| # | 指摘 | 処置 | 対照 |
|---|---|---|---|
| Codex 5-2c-2 P2（`review-4226c.md`） | W5 の build が呼ぶ helper の呼び出し元の検査が、変数の別名・名前空間の import を辿らない | `f4869a095`：名前の解決を guard の `symbolsOf` 1 つにまとめ、import の別名・変数への束縛・再代入・名前空間の import を同じ規則で辿る | guard の self-test（陽性 6 件・陰性 1 件。`f4869a095` のコミットの本文） |
| Codex 5-2c-3 P2（`review-4226d.md`） | 呼び出し元の検査が 2 段の helper を逆引きしない（`wrapped → peek → readShown` を W5 の build で呼び、W5 の後に `wrapped(db)` を呼んでも検出されない）。現行製品での症状は未観測 | **直さない（保証の範囲の外と明記）**。PM の決定（2026-11-10、`pm-return-4226-guard.md` の案 (a)）：静的な解析は原理的に端が尽きず、同じ種類の指摘（別名 → 変数の別名の helper → 2 段の helper）が 3 回続いたので手当てをやめる。ガードの保証の範囲と範囲の外を §3.6・§7.3 の I-F13 とガードの冒頭のコメントに書いた。INV-A は I-F11 の実行時の表駆動の対照で固定済み。この形は #4289 に追跡 | 文書とコメントだけ（コードの動作・テストの判定は変えていない） |
