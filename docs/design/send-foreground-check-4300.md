# 終わった CLI のペインへ打ち込まない（Issue #4300）設計

- 段: 設計（この文書だけ）。改訂 3（2026-11-10）: codex-2 の再確認（`review-4300c.md`: N1〜N7 の判定と新 P1 1・P2 7）と PM の決定（`pm-return-4300-design-rev2.md` の (a)）を反映し、**起動（new-window）も復旧（respawn-pane）も、ペインのコマンドとして CLI を直接起動し、端末を読むシェルを一度も出さない**形に替えた。起動行を打つ経路・入力ロックの起動の番・起動の印 `@cm_launch` は外した（§2.5）。指摘ごとの処置は §11.0
- 改訂 2 の主筋（起動行に `exec` を足して打つ）は §2.1 に「採らない（新 P1）」として残す。改訂 1 の案 E も同じ表に残す
- 基準: develop `ed9b89eac`（この worktree の src。develop の先頭 `46cbe7699` との差は mem・handoff だけで、この設計が触る所は同じ）。行番号はこの時点のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 実装は 2 段: **PR1**（確かな証拠のときだけ止める小さな直し。別の worktree で実装中、`0ca482d3d`、未マージ。この文書は書かない）、**PR2**（この文書の本体。PR1 のマージ後、develop から別の契約で。§8 で 2 本に分ける）
- **改訂 7（2026-11-14、Issue #4304）が最新**。優先の順は「## 改訂 7」→「## 改訂 6」→「## 改訂 5」→「## 改訂 4」→ §0〜§12（食い違う箇所は新しい節の中で名指しする）。§0〜§12 の本文と行番号は改訂 3 の時点のまま残す

## 改訂の履歴

- 改訂 1（2026-11-09）: 前面の判定を「CLI がいる積極的な証拠」に改め、打鍵の各段・読み手・復旧の方針を固めた（`7901c149e`）
- 改訂 2（2026-11-10）: CLI を exec で起動してシェルを残さない方式へ PR2 の主筋を替えた（`b317577ee`）。§12 で #4303 の回答経路を整理（`84bf2824e`）
- 改訂 3（2026-11-10）: 起動も復旧もペインのコマンドとして CLI を直接起動する形に替えた（`f02cd6f55`）。再確認（`review-4300d.md`）で P1 1・P2 6 が残り、PM の決定 (b) で PR2 を止めて #4304 へ
- 改訂 4（2026-11-13、#4304）: P1（rc が別の対話シェルへ exec する）を H1-a（復旧の瞬間だけ入力ロックで直列化し、準備完了の証拠を新しい世代に限る）で閉じ、残りの 9 項目（P2 6 件・#4304 のコメントの 3 経路・行番号・Auto-Yes と世代）を決め、H2・H3 の人の決定を書いた（下の「## 改訂 4」）
- 改訂 5（2026-11-13、#4304）: 改訂 4 の再確認（`prereview-4304-rev4-reply.md`、codex-2、承認保留）を反映。準備完了の証拠を「新しい行」から「CLI へ exec した積極的な証拠（pane_pid の argv）＋その世代の印（nonce の行）」に替え、Enter 省略の回答を含む全キー経路をロックに載せ、世代の印の寿命と全読者・cwd と環境の同時の維持・PR2a/PR2b の依存の境界・対照の試験を決めた。決めきれない 3 点は要決定として選択肢と推奨を書いた（下の「## 改訂 5」）
- 改訂 6（2026-11-13、#4304、最後）: 改訂 5 の再確認（`prereview-4304-rev5-reply.md`、承認保留）と原因調査（`rootcause-4304-evidence-reply.md`）を反映。共通の原因（区別できない情報から「今の CLI」と「今の世代の画面」を確定していた）を受け、不変条件を 2 文（V1・V2）に置き換え、プロセスの証拠（実行イメージ＋入口＋前景のグループ、D4）と行の証拠（世代ごとに新しい grid、D5）を分け、argv の名前・nonce の不在・過去の成功を証拠にしない。操作ごとの画面の条件、D2=(b)+(c)、dead の後の回収の識別子、対照 10 行、PR の境界を決めた（下の「## 改訂 6」）
- 改訂 7（2026-11-14、#4304）: 改訂 6 の再確認（`prereview-4304-rev6-reply.md`、承認保留）と人の決定（PM 追補 1 の 7）を反映。D4=E1 を限定された保証として採り除外 (a)(b) を明記、D5=L1 に受入の 3 つを足し、行の証拠と最後の回収を capture の世代結合の設計（`capture-generation-binding-4304.md`、F1-a・F1-b は PR2a より前）へ委ね、strict を #4303-A の追跡の候補の PR に担当させた。追記で人の答え（Q5・Q6）と 2-4-4 確認の K1〜K3（PR の順の一本化・PR2a の識別子を CG に揃える・高々 1 回と必ず保存の区別）を反映（下の「## 改訂 7」）

## 改訂 4（2026-11-13、Issue #4304）: P1 の閉じ方と残りの 9 項目

- 材料: イネーブラーの具体化（`workspace/orchestration/runs/2026-11-13/enabler-return-4303-4304-design.md` の #4304 の節。§2.1 の H1〜H5、§2.2 の 9 項目）と、人の決定（2026-11-13 14:47、「推奨で」）: **H1-a**、**H2 は受け入れる**、**H3 は PR2b で既存の期待を変えてよい**。
- 基準: develop **`10232442d`**（2026-11-13 に `git fetch` した `origin/develop`）。この節の file:line はすべてこの版で、名前で探して取り直した。設計ブランチ `fix/4300-design-rev` は develop を取り込んでいない（この worktree の `src` は `ed9b89eac` のまま）。
- **実装（PR2a・PR2b）は改訂 4 の承認の後**に、develop から別の契約で始める。改訂 4 は codex-2 の差分の再確認（イネーブラー §3 の順 2）を受けてから承認を求める。

### R4.1 人の決定

| # | 決定 | この文書での扱い |
|---|---|---|
| **H1-a** | P1（`review-4300d.md` ①）は「**復旧（respawn）の瞬間だけ入力ロックの `exclusive` で直列化し、準備完了の証拠を新しい世代に限る**」で閉じる。H1-b（rc をペインの外で走らせる）・H1-c（残りとして受け入れる）は採らない | R4.2。§4.5 の「復旧を入力ロックの中で行う形は採らない」と §2.5 の「入力ロックの起動の番を外す」は、**respawn／new-window の 1 回の tmux 呼び出しに限って取り消す**（起動行を打つ番は外したまま） |
| **H2** | 終わったペインで `claude --resume <id>` 等を**打てなくなる**こと（dead pane は入力を捨てる）、tmux の `default-command` を**使わなくなる**ことを受け入れる | §6.1・§10 の記述どおり。PR2b の利用者向け文書（`docs/user-guide/cli-operations-guide.md` と en）に、終わったペインは次の send で作り直されること・前の画面（`Resume this session with:` を含む）は履歴に残ることを書く。fish をログインシェルにした起動は PR2b の UAT の行に残す（未確認） |
| **H3** | PR2b の契約で、起動行を固定する既存テストの**期待を変えてよい** | §8.3 の例外を確定。数え直し（`10232442d`、§8.3 と同じ grep）: `clear 2>/dev/null\|withLaunchScreenCleared\|LAUNCH_SCREEN_CLEAR_PREFIX` 14 ファイル、`renderAgentLaunchCommand\|buildAgentLaunchCommandLine` 28 ファイル、`typeLaunchLines\|launch-keys` 5 ファイル（改訂 3 と同数）。契約にはこの grep を書き、変えるのは起動の形を固定する期待だけに限る（`it`／`describe` の削除・改名は契約で個別に許す） |

H4（#4303 の小さな直しを先に出す）は R4.4、H5（tmux の最低版）は決めずに §10 の残りのまま。

### R4.2 H1-a: 復旧の瞬間の直列化と、新しい世代の証拠（P1 の閉じ方）

**今の骨組みを使う。** `session-launch-flight.ts` は「起動の single-flight は外、入力ロックは内」（同ファイルの冒頭の説明、R1・R2）で、今は起動行を打つ `typeLaunchLines`（`base.ts:914`）が `exclusive` の 1 回の番を取る。改訂 4 はこの番を残し、**番の中身を「起動行を打つ」から「spawn の 1 回の tmux 呼び出し」に替える**。

1. 復旧する側 B: 起動の single-flight を取る（今どおり）→ `withInstanceInputLock(sessionName, …, { mode: 'exclusive' })`（`instance-input-lock.ts:542`）を取る → 番の中で `readPaneState` を読み直し、まだ dead なら `beginAgentSession`（その中の `invalidateInstanceInput`、`agent-session-lifecycle.ts:114`。B 以外の ticket を失効させる）→ **R4.3 ②の世代の印を読む呼び出しと `respawn-pane -c <cwd> <コマンド> \; set-option -p … remain-on-exit on` を 1 回の tmux 呼び出しで** → 番を返す。準備待ちは番の外（#3975 と同じ）。
2. 送信 A（`exclusive`）・回答と Auto-Yes（`shared`、`prompt-answer-sender.ts:712` の `sendAsInputWriter`）はどちらも B の `exclusive` と同時に持てない。だから **A が出したキーは、B の respawn より前に tmux へ出終わっている**（`send-keys` は tmux がペインへ書いてから戻る）。届く先は dead pane（捨てる）か、終わる前の古い CLI。B の respawn の後に A がキーを出すことは、A の ticket が失効している（`invalidateInstanceInput`）ので無い。
3. respawn の後に送る人（A の再試行・C）は、**新しい世代の入力欄**（R4.3 ②）が見えるまで本文を打たない。rc が別の対話シェルへ exec した場合（P1 の構成）は入力欄が出ないので準備待ちが時間切れになり、§5.3 のとおり新方式のペインを kill して not-sent。その間、端末を読む対話シェルにキーを出す主体は無い（送信・回答は準備待ち、Auto-Yes は R4.3 の「Auto-Yes と世代」と⑦で止まる）。
4. デッドロック: R1（ロックを持つ側は他の起動を待たず `SessionLaunchInFlightError` で断られる）を保つので、「single-flight → ロック」の向きだけになり循環しない。A 自身の send が自分のペインを復旧する場合（codex の `requireSession({ relaunch: true })`）は R2 のとおり A の番に合流し、`invalidateInstanceInput` も呼び手の ticket を残す（`instance-input-lock.ts:795` の `invalidateInstanceInput` の説明。改訂 5 で参照を直した）。
5. 受け入れた残り（H1-a を決めたときの前提）: **UI の生の入力（`direct-input.ts:26` の `sendDirectInput`、WS の `terminal_input`）は入力ロックを通らない**。人が画面を見て打つ入力なので直列化の外に置く。dead pane では捨てられ、起動中は端末のバッファ（s6）。rc が対話シェルへ exec した構成で、人がそのシェルの画面を見て打つ入力は実行されうる。#4304 の受入基準案の「生の入力のキーが 1 バイトも」は、PR2b の受入で「dead pane・起動中（rc の読み込み中）」に絞る。
6. 見立て（PR2b の実測で確かめる）: `respawn-pane` は新しい pty を作るので、古い CLI が読まずに終わった入力は新しい世代へ持ち越されない。

**赤になる試験**（イネーブラー §3.1 の PR2a の 5、PR2b の 2 を確定）:
- PR2a（単体）: 送信 A が `exclusive` を持つ間に B の復旧を起こす → B の `respawn-pane` の呼び出しは A の解放の後。B が番を取った後、A の失効した ticket でのキー送信は 0 回。陽性対照: 番を外すと respawn が A の本文と Enter の間に入る。
- PR2b（実 tmux、`-L` の私設ソケット、`process.env.TMUX` を私設に向けたことを assert）: 仮の HOME の rc の末尾に `exec zsh -i`（`bash -i` も）を置き、A を本文の直前・本文の後・Enter の直前で止めて B の復旧を差す → 3 つとも `touch <f>` のファイルが作られず、B は準備待ちの時間切れ → kill → not-sent。陽性対照: 改訂 3 の形（番なし・世代の印なし）では作られる。

### R4.3 残りの 9 項目

| 項目 | 決定 | 根拠の場所（`10232442d`） |
|---|---|---|
| **② 準備の証拠の世代** | spawn と**同じ tmux 呼び出し**の先頭で `display-message -p '#{history_size} #{cursor_y}'` を読み、絶対行（`history_size + cursor_y`）を世代の印として起動の記録に持つ。準備待ちと起動中の答え（trust の Enter など）は、`capture-pane -S` を「印の絶対行 − 今の `history_size`」から取った行だけで入力欄・ダイアログを探す。履歴の上限で印より前が流れていたら全体を新しい世代とみなす（古い行はもう無い）。印の行そのもの（`Pane is dead` の行）を含めるかは PR2b の実測で決め、テストで固定する。clear はしない（履歴を残す、改訂 3 のまま）。対象は全 CLI の準備待ち: claude `waitForPrompt`（`claude-session.ts:832`）、codex `waitForReady`（`codex.ts:382`）、gemini（`gemini.ts:207`）、copilot `waitForReady`（`copilot.ts:687`）と `waitForPrompt`（`:767`）、antigravity（`antigravity.ts:362`）、command-code（`command-code.ts:325`）、opencode（`opencode.ts:600`）、opencode V2（`opencode-v2.ts:331`）。試験: 旧い入力欄を履歴に残し、新しい rc を 2 秒眠らせる → その間は準備完了にならない（本文 0・Auto-Yes 0）。陽性対照: 印を外すと gemini・copilot で準備完了と読む | 印の読み方は tmux の format。`capture-pane -S` の負の行は履歴の中 |
| **③ cwd** | `-c` の文字列を `<代入> cd -- <cwd> \|\| exit 97; exec <cli> <引数>` にする（rc の後、exec の直前に cwd を確かめる）。**全 CLI に付ける**: ロールの cwd の再確認は opencode V2 だけでなく `base.ts:339`（全 driver の起動）と `send-role.ts:219` でも使われている（`launchCwdRecheck`、`role-launch.ts:478`）。cd の失敗はペインが dead（状態 97）になり、§5.3 の早い失敗が「cwd に入れない」として返す。tmux の `-c <cwd>` は残す（rc が相対パスを読む場合の起点） | `opencode-v2.ts:301-306` の今の再確認 |
| **④ ps の不明** | 旧方式の置換（§5.2 の 3）は、「ps が成功し、取れた一覧に `pane_pid` の行がある」ときだけ判定する。ps の失敗・空・`pane_pid` の行が無い（対象不一致）は**不明**として置換しない（起動 0・kill 0・not-sent、理由 `agent-foreground-unknown`）。試験: 3 つの不明それぞれで `respawn-pane -k` 0 回 | `readPaneForeground`（`tmux.ts:347`）と同じ ps の読み方 |
| **⑤ 最後の画面の世代** | 応答の poll の回収（§3.2 の (11)）は、capture の前と後で `pane_pid` と `pane_dead` を読み、**両方とも同じ（同じ世代の dead）ときだけ**保存する。保存の直前にもう一度読み、違えば保存しない（後継の世代の画面を古い応答として保存しない）。試験: capture と保存の間に `pane_pid` を変える → 保存 0 回 | `src/lib/polling/response-checker.ts` |
| **⑥ prompt-response の API 配送** | 入口×配送×結果を次のとおりにする（§12.3 の API 回答の列と §12.4 の「常に indeterminate」を置き換える）: (a) 入口 `route.ts:117` の `isRunning` は PR2a で `agentAlive` になり、**dead では API 回答の分岐（`:140` の `answerViaStructuredDecision`）に入る前に 400 で断る**（未送信。dead の世代のダイアログへの答えを、TUI と別のサーバーが受け取る opencode V2 でも送らない。受領の有無が未確認なので断る側に倒す）。(b) strict の終了回答（答えた後に CLI が終わる）は `strict-respond.ts:349` の `session-ended`（成功、`:314`）を保つ。判定は `agentExitedToShell`（`:318`、前面の名前）に、新方式では `readPaneState` の dead を足す（dead pane の `pane_current_command` はシェルの名前なので名前だけに頼らない）。(c) 通常キー・strict キーの dead は最初のキーの前で未送信（§12.3 のまま） | `route.ts:117,140`、`strict-respond.ts:304,314,318,349` |
| **⑦ 開始窓の前倒し** | copilot の `beginLaunchWindow`（`copilot.ts:532`）と antigravity の `beginStartupWindow`（`antigravity.ts:327`）を、**spawn（`createLaunchPane`／respawn）の前**に開く。今は `createLaunchPane`（`copilot.ts:526`）の後・起動行の前に開いており、改訂 3 で起動が spawn に前倒しになると、spawn と窓の間に trust 画面へ Auto-Yes が先に答えうる。窓を閉じる `finally` は今どおり準備待ちの後。試験: spawn の直後に trust 画面を出して Auto-Yes の tick を差す → Auto-Yes の回答 0、起動側だけが答える | `createLaunchPane`（`base.ts:926`） |
| **#4304 のコメントの 3 経路** | 準備待ちがダイアログに打つキー: codex の trust・hooks の答え（`codex.ts:382` の `waitForReady` の中）、copilot の folder trust（`answerFolderTrustDialog`、`copilot.ts:593`。呼ぶ所は `:702`・`:804`）、antigravity の trust の Enter（`antigravity.ts:362` の `waitForReady`、`isTrustPressStill` `:444`）。**新方式**: ②の印より後の行だけで trust 画面を読むので、P1 の構成（対話シェル）では画面が出ず、キーは出ない。dead では捨てられる。**旧方式**: 各キーの前に PR1 の D（`readPaneForeground`）を通す（#4303-A と同じ部品、R4.4）。これらの答えは `shared` の番で打つので、R4.2 の `exclusive` の respawn とは直列 | コードの読み。#4304 のコメント（2026-11-10T19:31:57Z）の行（978・804・500 付近）は、今は上の行 |
| **行番号の取り直し** | この節の file:line は `10232442d`。§0〜§12 の行番号は改訂 3（`ed9b89eac`）のまま残す。PR1（`5055c4d27`、#4306）の後で設計が引く所: `readPaneForeground` `tmux.ts:347`、`recheckComposerBeforeInput` `composer-clear.ts:273`（前面の判定 `:308-331`）、`AGENT_NOT_IN_FOREGROUND_CODE` `send-attempt-types.ts:135`、`respawnLoginShell` `tmux.ts:434`。変わらなかった所: `relaunchIfToolExited` `base.ts:780`、`requireSession` `:814`、`resolveLaunchPane` `:878`、`typeLaunchLines` `:914`、`ensureHealthySession` `claude-session.ts:708`、`isClaudeRunning` `:802`、`sendPromptAnswer` `prompt-answer-sender.ts:959`、`transportDeliveryOf` `:783`、文字の答え `:1118`。PR2a・PR2b の契約は、この節の名前で探し直す | `git grep -n` を `10232442d` で |
| **Auto-Yes と世代** | Auto-Yes の 1 tick の画面（`capturePollerFrame`、`auto-yes-poller-capture.ts:67`）にも②の印を当てる: 起動の記録に印がある間（新方式の spawn の後、準備完了まで）は、**印より後の行だけ**でダイアログを探す。respawn が履歴に残した前の世代のダイアログに、新しいプロセス（P1 の構成では対話シェル）へ答えない。準備完了の後は今どおり（CLI が画面を描き直すので印は要らない）。世代の切り替えで記録を失効させる今の `beginEnterFallbackSession`（`agent-session-lifecycle.ts:104`）はそのまま。試験: 前の世代のダイアログを履歴に残して respawn → 準備完了までの tick の回答 0。陽性対照: 印を外すと答える | §3.2 の Auto-Yes の行（dead・unknown）に「起動中の世代」を足す |

### R4.4 #4303-A との関係

#4303-A（回答経路の前景の判定: 通常キー `sendPromptAnswer` と strict キーの最初のキーの前に PR1 の `readPaneForeground` を通し、`shell`・`unknown` なら未送信）は、確認の時点（`10232442d`、`gh pr list --search 4303` と `git log origin/develop --grep=4303` で該当なし）では **develop にマージされておらず、作業中の PR も無い**。改訂 4 はこれを前提にせず、独立に先行してよい（イネーブラー §3 の順 1、H4 の推奨）。関係は次のとおり: 旧方式のペインは PR2b の後も強制の移行をしないので、#4303-A の判定はその守りとして残り（§12.3 の「移行期間の旧方式」の行を塞ぐ）、#4304 のコメントの 3 経路（R4.3）の旧方式の側も同じ部品で塞ぐ。PR2a は回答経路の判定点を #4303-A と同じ所（最初のキーの前）に置き、**方式で分ける**（旧方式は #4303-A の D、新方式は `readPaneState`。新方式に D を当てると起動中の `-c` のシェルを `shell` と誤る、§0.2）。#4303-A が PR2a より後に入る場合も、PR2a はその判定点に方式の分岐を足すだけで、どちらの順でも衝突しない。dead・世代交代の扱い（#4303-B）は PR2b の後。

### R4.5 PR の順（確定）

1. 改訂 4 の承認（codex-2 の差分の再確認の後）。
2. **PR2a**（読み手・復旧・通知）: R4.2 の番の中の respawn、④⑤⑥、#4303-A との方式の分岐。G-PR3 は develop に入った（`fd2f4a589`）ので §8.2 の直列の条件は満たす。
3. **PR2b**（起動の形）: ②③⑦、Auto-Yes と世代、#4304 のコメントの 3 経路の新方式の側、H3 の期待の変更、H2 の利用者向け文書、R4.2 の実 tmux の試験。
4. #4303-B（dead・世代交代の回答経路）。

#4303-A はこの順の外で、いつ入ってもよい。

## 改訂 5（2026-11-13、Issue #4304）: 準備完了の積極的な証拠・全キー経路・世代の寿命・環境・PR の境界

- 材料: 改訂 4（`b1dd9e04e`）の再確認 `workspace/orchestration/runs/2026-11-13/prereview-4304-rev4-reply.md`（codex-2、**承認保留**）。判定は、改訂 3 の 7 件のうち解消 5（③④⑤⑥⑦）・一部未対応 2（① P1、② 世代）。残る P1 が 1、P2 が 3、PR の分け方の依存の穴が 1。
- 基準: develop `10232442d`（改訂 4 と同じ。2026-11-13 に `git fetch` し直して先頭が同じことを確かめた）。この節の file:line はこの版で、名前で探して確かめた。
- 改訂 4 の次の箇所は、この節が置き換える: R4.2 の 2・3・5、R4.3 の「② 準備の証拠の世代」「③ cwd」の `-c` の文字列の形、「Auto-Yes と世代」の寿命、R4.5 の PR の順。ほかの改訂 4 の決定（④⑤⑥⑦、行番号、H2・H3）はそのまま。
- **実装（PR2a・PR2b）は改訂 5 の承認の後**。R5.6 の要決定 3 点は、承認のときに PM が決める。

### R5.1 守るべき条件（不変条件）

実装・試験はすべて、次の 4 つを満たすかで判定する。

| # | 条件 | 破れる例（反例） |
|---|---|---|
| **I1** | 新方式のペインへ CommandMate が出すキー（本文・回答・起動時の答え・停止の行）は、**そのペインの今の `pane_pid` が CLI へ exec した積極的な証拠**（R5.2）を、そのキーの直前の判定で持つときだけ出す | rc が `exec zsh -i` し、PS1 が `> ` か `❯ `。画面の型だけで準備完了と読むと、B 自身の本文がシェルで実行される（再確認 (3)-1） |
| **I2** | 自動で出すキー（本文・回答・Auto-Yes・起動時の答え・停止の行）は、Enter 省略を含め**すべて入力ロックを通り**、respawn の `exclusive` の番と直列になる | Enter 省略の回答（`prompt-answer-sender.ts:1123-1129`）が番の外で、読んだ後・出す前に respawn が入る（(3)-2） |
| **I3** | 画面を操作の根拠にするときは、**その画面の行が今の世代のものだと確かめられる行だけ**を使う。確かめられない間は旧画面を根拠にしない（準備待ち・trust の再読・Auto-Yes・送信直前の readiness の全部、準備完了の後も） | 履歴に残った旧世代のダイアログに、準備完了の後の Auto-Yes の tick が答える（(3)-3） |
| **I4** | 新方式の起動は、rc の後の cwd と、CLI へ渡す環境（`CM_*`・ロールの代入・秘密の代入）を**同時に**保つ | `<代入> cd …; exec …` で代入が `cd` にだけ効き、CLI に届かない（(3)-4） |

### R5.2 P1: 準備完了は「CLI へ exec した積極的な証拠」で決める（I1・I3）

改訂 4 R4.2 の 3 の「対話シェルでは入力欄が出ない」は**成立しない**。画面の型は、シェルの PS1 で満たせる（`10232442d` で確かめた）:

| CLI | 準備・入力欄の型 | シェルの PS1 で満たせるか |
|---|---|---|
| gemini | `GEMINI_PROMPT_PATTERN` `/^[>❯]\s*$\|…/m`（`detection/tools/gemini/patterns.ts:22`、読むのは `gemini.ts:222`） | **満たせる**（`> `・`❯ ` だけの行） |
| claude | `CLAUDE_PROMPT_PATTERN` `/^[>❯](\s*$\|\s+\S)/m`（`detection/tools/claude/patterns.ts:166`） | **満たせる**（pure・starship の既定の `❯`） |
| copilot | `COPILOT_PROMPT_PATTERN`（`detection/tools/copilot/patterns.ts:17`）、`COPILOT_COMPOSER_ROW_PATTERN`（`copilot.ts:148`） | **満たせる** |
| command-code | `COMMAND_CODE_PROMPT_PATTERN` `/^❯(\s*$\|\s+\S)/m`（`detection/tools/command-code/patterns.ts:38`） | **満たせる** |
| codex | `CODEX_PROMPT_PATTERN` `/^›\s*/m`（`detection/tools/codex/patterns.ts:165`） | PS1 を `›` にすれば満たせる |
| opencode・antigravity・vibe-local | `Ask anything…`・`? for shortcuts`・`ctx:\d+%\s*[>❯]` | 型は固有だが、PS1 に同じ文字列を置けば満たせる（起こりにくい） |

**決定: 画面の型は「CLI の画面か」の判定に使わない。** 新方式のペインの準備完了と、各キーの直前の判定は、次の 3 つが**すべて**真のときだけ真（積極的な証拠、改訂 1 の原則に戻る）:

1. `readPaneState` が alive で、`pane_pid` が起動の記録の世代（R5.4 の印を出した `pane_pid`）と同じ。
2. **`ps -o args= -p <pane_pid>` の argv に、起動の計画の実行ファイル（`executablePath` の basename、vibe-local は `vibe-local`）が語として現れる**。`-c` のシェルは `exec` で同じ pid のまま CLI に置き換わるので、exec が済んでいれば pane_pid の argv は CLI のもの（node の CLI は `node …/<cli>`）。rc が別のシェルへ exec した場合は `zsh -i`・`-zsh`・`fish` などで、CLI の名前が無い → 偽。ps の失敗・空・行なしも偽（④と同じ読み方）。
3. その上で、R5.4 で今の世代と確かめられる行に、各 CLI の入力欄の型がある（今の型のまま。型は「どの画面か」の判定にだけ使う）。

- 1・2 は `readPaneForeground` と同じ `display-message` 1 回＋`ps` 1 回で読む。キーの直前ごとに読み直す（exec の後に pid は変わらないが、CLI がさらに別のプロセスへ exec する場合を拾う）。
- P1 の構成（rc が対話シェルへ exec）は 2 が偽のまま → 準備待ちは時間切れ → §5.3 のとおり新方式のペインを kill して not-sent。本文・回答・起動時の答えは 0。
- 非 exec のラッパー（argv が `bash /path/wrapper`）: 2 はラッパーの名前が実行ファイルの basename と同じなら真（`bash /usr/local/bin/claude …`）。違う名前のラッパー（`executablePath` が別名の symlink の先を指すなど）は偽になり起動に失敗する。これは要決定 D1（R5.6）。
- **対照の試験**（PR2b、私設 tmux）: 仮の HOME の rc の末尾に `exec zsh -i`（PS1=`'> '`）と `exec bash -i`（PS1=`'❯ '`）を置く。(a) 復旧の後の**新しい送信 B・C**と、回答・Auto-Yes・起動時の答えを通す → 本文・回答とも 0、kill・`not_sent`。(b) 陽性対照: 2 を外す（画面の型だけで判定する）と gemini・claude・copilot の準備待ちが真になり、B の本文がシェルに届く（`touch <f>` が作られる）。(c) 陰性対照: 本物の CLI の代わり（argv に名前のある `exec` の偽 CLI）では準備完了になり、送信が届く。

### R5.3 全キー経路をロックに載せる（I2）と #4303-A

改訂 4 R4.2 の 2「回答と Auto-Yes はすべて `sendAsInputWriter` を通る」は**誤り**だった。`10232442d` の全キー経路:

| 経路 | 今 | 改訂 5 の決定 |
|---|---|---|
| 送信の本文・Enter | `withInstanceInputLock`（`submit-verified-sender.ts:691`、`exclusive`） | 今のまま。最初のキーの前に R5.2 の判定 |
| 通常の回答: 矢印・複数選択 | `sendAsInputWriter`（`prompt-answer-sender.ts:712`、`shared`）。`:1105` | 今のまま＋最初のキーの前に R5.2 |
| 通常の回答: 文字＋Enter | `sendAsInputWriter`（`:1133`） | 同上 |
| **通常の回答: Enter 省略（数字 1 つ）** | **ロックの外**（`:1123-1129`、`stillAllowedNow` の後に `typeText`）。Auto-Yes もこの経路を通る | **`sendAsInputWriter`（`shared`）に入れる**。`shared` 同士は並ぶので回答どうしの順は今と変わらず、`exclusive` の respawn・本文とだけ直列になる。番の中で画面を読み直し（`answerTargetStillOnScreen`、`:657`）、R5.2 を通してから出す |
| strict の回答 | `answerStrictlyAsInputWriter`（`strict-prompt-answer-io.ts:190`）→ `sendSessionAnswerKey`（`cli-session.ts:264`） | 今のまま＋キーごとに R5.2（キーの間に画面を読み直す今の流れに載せる） |
| 起動時の答え（trust・hooks・update・nudge） | `answerUnderInstanceInputLock`（`instance-input-lock.ts:662`）: codex `:630,:671,:696,:728,:856`、copilot `:604`、gemini `:236`、antigravity `:399,:500`、claude `sendTrustDialogKey`（`claude-session.ts:429`）、`claude-auto-default-nudge.ts:140` | 今のまま（ロックの中）。**`stillApplies` の再読にも I3 を当てる**（今は `capturePane(sessionName, 50)` の生の画面。再確認 (2) の指摘） |
| plan-review | `answerUnderInstanceInputLock`（`prompt-response/plan-review.ts:74`） | 今のまま＋R5.2 |
| 停止の行（`/exit`・`/quit`） | command-code `:467-469`、copilot `:1205-1207`、gemini `:374`（claude の kill の `/exit` は #4304 本文の列挙。`10232442d` の `claude-session.ts` では打つ所を見つけられなかった、未確認） | 新方式のペインでは R5.2 が偽なら**打たずに** `kill-session` へ進む（シェルに `/quit` を実行させない） |
| interrupt（Escape） | `base.ts:627` の `sendSpecialKey` | Escape 単独はシェルで実行されないので対象外（受け入れる） |
| UI の生の入力 | `direct-input`（`cli-tools/direct-input.ts:26`）・`special-keys` ルート・WS の `terminal_input` | **要決定 D2**（R5.6） |

- **対照の試験**（PR2a）: Enter 省略の回答を「画面を読んだ後・キーを出す前」で止めて B の respawn を差す → 旧世代へのキー 0、respawn は回答の後。陽性対照: 回答をロックの外に戻すと respawn が間に入る。陰性対照: 生きた今の世代への Enter 省略の回答は 1 回で届く（Auto-Yes を含む）。
- **#4303-A との合わせ**: #4303-A（未着手。`10232442d` で `gh pr list --search 4303`・`git log --grep=4303` とも該当なし、2026-11-13 に再確認）が判定を `sendAsInputWriter` の中だけに置くと、**Enter 省略の経路（`:1123-1129`）を取りこぼす**。#4303-A の契約には「上の表の通常の回答 3 行と strict の全部で、最初のキーの前」と書く（Enter 省略の経路を名指しする）。判定は旧方式では PR1 の D（`readPaneForeground`）、新方式では R5.2（PR2b から）。改訂 4 R4.4 の「方式で分ける」はそのまま。#4303-A が先に入れば、PR2a は Enter 省略をロックに入れるときに #4303-A の判定点ごと番の中へ移す。

### R5.4 世代の印・寿命・全読者（I3）

改訂 4 の `history_size + cursor_y` は**採らない**（`history_size` は履歴の上限で頭打ちになり、通算の位置ではない。脱落を検出できない）。

**決定: 世代の印は「`-c` の文字列が exec の直前に出す nonce の行」**。

- `-c` の文字列（R5.5）の exec の直前で `printf '\n%s\n' 'commandmate:<nonce>'` を出す。nonce は起動ごとの乱数（16 進 16 文字）。nonce は `#{pane_start_command}` の中にもあるので、サーバーの再起動の後も tmux から読み直せる（メモリに持たない）。
- 読み方（すべての読者で同じ補助関数）: capture した窓の中で**最後の nonce の行を探し、その行と上を捨てる**。
  - 窓に nonce がある → nonce より下だけが今の世代。
  - 窓に nonce が無く、R5.2 の 2 が真（exec が済んだ＝nonce は出た）→ nonce は窓より上にある（履歴の上限で流れたか、窓が狭い）。旧世代の行は nonce より上にしか無いので、**窓の全部が今の世代**。
  - 窓に nonce が無く、R5.2 の 2 が偽（まだ rc の中、または P1 の構成）→ **世代を確かめられない。画面を根拠にしない**（I3）。
  - CLI が代替画面（`#{alternate_on}`=1）にいる → capture は代替画面だけで、旧世代の行を含まない。R5.2 の 2 が真なら全部が今の世代。
- 寿命: **世代の全体**（spawn から dead・absent まで）。改訂 4 の「準備完了の後は印が要らない（CLI が描き直す）」は根拠が無いので取り消す。準備完了の後も、すべての読者は上の読み方を通る。
- 全読者（`10232442d`）: 準備待ち（claude `waitForPrompt` `claude-session.ts:832`、codex `:382`、gemini `:207`、copilot `:687`・`waitForPrompt` `:767`、antigravity `:362`、command-code `:325`、opencode `:600`、opencode V2 `:331`、**vibe-local `waitForPrompt` `vibe-local.ts:249`**）、送信直前の readiness（**vibe-local `:212`**、opencode `:940`）、起動時の答えの `stillApplies`（R5.3 の表）、Auto-Yes の tick（`capturePollerFrame` `auto-yes-poller-capture.ts:67`、`captureAndCleanOutput` `:99`）、回答の再読（`answerTargetStillOnScreen` `prompt-answer-sender.ts:657`）、strict の画面の読み、応答の poll の最後の画面（⑤）。読者の一覧は PR2b の契約で `capturePane(`／`captureSessionOutput` の呼び手を `git grep` して表にし、漏れを無くす（R5.7 の試験 6）。
- 旧方式のペインは nonce を持たない（`pane_start_command` が新方式の形でない）。読み方は今のまま（§8.4）。
- **対照の試験**（PR2b）: (1) 履歴の上限: `history-limit` を小さくし、nonce が流れた後の窓で、今の世代の入力欄を読める／流れる前の旧世代のダイアログは読まない。(2) 再描画: 準備完了の後、旧世代のダイアログを履歴に残したまま CLI が画面を描き直す → Auto-Yes の tick の回答 0。(3) 準備完了の後の tick: 同上を準備完了から数 tick 後に差す。(4) vibe-local: `waitForPrompt` と送信直前の readiness が旧世代の `ctx:NN% >` を読まない。陽性対照: 補助関数を外すと (2)〜(4) が答える・準備完了と読む。

### R5.5 cwd と環境を同時に保つ（I4）

`-c` の文字列を次の順にする（改訂 4 の `<代入> cd … ; exec …` を置き換える。§2.2 の「代入は exec の直前」の約束に戻す）:

```
[unset CLAUDECODE; ]cd -- <cwd> || exit 97; printf '\n%s\n' 'commandmate:<nonce>'; <代入> exec <cli> <引数>
```

- 代入（`CM_*`・ロールの代入・`OPENCODE_CONFIG_CONTENT="$(cat '<file>')"` の秘密、`agent-roles/adapters.ts:246`）は **`exec` の直前**に置き、CLI の環境に入る（§2.2、表 3 の n）。`cd` の後なので、代入の中の相対パスは cwd から解決される（ロールの相対設定の対応が保たれる）。
- 適用先: 新規の起動（new-window）・復旧（respawn）・旧方式の置換（`respawn-pane -k`）・codex の #2068 の起動し直し・opencode V1/V2 の再利用の作り直しの**全部**が、同じ補助関数で文字列を作る（予備の経路だけ別の形にしない）。
- **対照の試験**（PR2b、私設 tmux）: 親の環境（tmux の大域と CommandMate の `process.env`）に対象の変数が無い状態で、偽 CLI が (a) `pwd` が `<cwd>`、(b) `CM_*` とロールの代入の変数を受け取る、の両方を記録する。rc が `cd /` しても (a) が保たれる。(c) cd の失敗（存在しない cwd）では偽 CLI は起動せず、ペインは dead（状態 97）、§5.3 の早い失敗が「cwd に入れない」で返る。陽性対照: 改訂 4 の形（代入を cd の前）では (b) が落ちる。

### R5.6 要決定（PM が承認のときに決める）

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| **D1** | R5.2 の 2（argv に CLI の名前）を満たさない非 exec ラッパー | (a) 起動の失敗にする（理由を出す。利用者は exec するラッパーに直す）／(b) argv の照合を「シェルの名前でない」に緩める（rc が `exec tmux`・`exec screen` する構成を通す）／(c) 設定で照合する名前を足せる | **(a)**。安全の条件（I1）を緩めない。既知のラッパー（nvm・asdf・volta は exec する見立て）は PR2b の UAT で確かめる |
| **D2** | UI の生の入力（`direct-input`・`special-keys`・WS の `terminal_input`） | (a) ロックの外のまま。受入基準を「dead pane・起動中」に絞る（改訂 4 R4.2 の 5、PM 未確定）／(b) 新方式のペインでは R5.2 の 1・2 を入力のまとまりごとに確かめ、偽なら捨てて画面に理由を出す（`pane_pid` ごとに結果を覚えて ps を減らす）／(c) `shared` の番に載せる | **(b)**。#4304 の受入基準案（生の入力も 1 バイトも届かない）を保てる。旧方式のペインは今のまま（人が CLI の終わった後のシェルで打つのは今の使い方） |
| **D3** | PR2a で新方式の復旧（dead → コマンド付きの respawn）を有効にするか（R5.7） | (a) PR2a では有効にしない（dead は未送信で返すだけ。respawn は PR2b で ②③⑦・R5.2〜R5.5・早い失敗と一緒に）／(b) PR2a で有効にし、R5.2〜R5.5 と⑦・§5.3 を PR2a へ移す | **(a)**。PR2a の時点の通常の起動は旧方式なので dead pane は生まれず、有効にしなくても利用者の振る舞いは変わらない |

### R5.7 PR の境界と「直す前に赤」の試験（改訂 4 R4.5 を置き換える。D3 は推奨 (a) で書く）

| 順 | PR | 中身 | 新方式の起動 |
|---|---|---|---|
| 1 | #4303-A（独立、いつでも） | 旧方式の回答経路の D。R5.3 の表の通常の回答 3 行（Enter 省略を含む）と strict | 生まない |
| 2 | **PR2a** 読み手・旧方式の復旧の守り・通知 | `readPaneState`・§3 の読み手、④（旧方式の置換の ps の不明）、⑤、⑥、`relaunched`、**Enter 省略の回答をロックへ（R5.3、I2）**。dead は読めるが**復旧はしない**（未送信で返す、D3 (a)） | 生まない（dead はテストで作るものだけ） |
| 3 | **PR2b** 起動の形 | spawn（new-window／respawn＋remain-on-exit）、R4.2 の番、R5.2（積極的な証拠）、R5.4（nonce と全読者）、R5.5（cwd と環境）、⑦、§5.3 の早い失敗、dead → respawn の復旧、停止の行（R5.3）、H3・H2、D2 | **ここで初めて生む** |
| 4 | #4303-B | 新方式の回答経路の dead・世代交代 | — |

**直す前に赤（各防御を個別に外す）**:

- PR2a ④: 実際の旧方式の relaunch の経路（`relaunchIfToolExited` `base.ts:780` → `startSession`）で、ps の失敗・空・行なしの 3 つで **起動 0・起動行の入力 0・kill 0**（改訂 4 の「respawn 0 回」だけでは旧版も通る）。陰性対照: 有効な ps（シェル以外のプロセス無し）では今どおり復旧する。
- PR2a ⑤⑥・ロックの順序: 改訂 4 R4.2・R4.3 の試験のまま。⑤は「世代が変わらなければ保存 1 回」も陰性対照に置く。
- PR2a I2: R5.3 の Enter 省略の試験。
- PR2b（私設 tmux。`-L` のソケットと `process.env.TMUX` を私設に向けたことを assert）: 防御は 4 つ（**ロックの番**・**R5.2 の argv の証拠**・**R5.4 の世代の読み方**・**R5.5 の順**）。試験は R5.2・R5.3・R5.4・R5.5 の各対照に加え、**防御を 1 つずつ外した 4 通り**でそれぞれ赤になることを確かめる（同時に外すだけでは各防御を検証できない）:
  1. ロックだけ外す: A を本文の途中で止めて B の respawn を差す → 改訂 4 R4.2 の試験が赤。
  2. argv の証拠だけ外す: rc の `exec zsh -i`（PS1=`> `）で B の新規送信が届く → 赤。
  3. 世代の読み方だけ外す: 旧世代のダイアログに準備完了の後の Auto-Yes が答える → 赤。
  4. 順だけ戻す（代入を cd の前）: 偽 CLI に代入の変数が届かない → 赤。
  5. 正常系: 4 つとも有効で、本物の代わりの偽 CLI に本文・回答が 1 回ずつ届く。
  6. 読者の網羅: `capturePane(`・`captureSessionOutput(` の新方式の呼び手が、すべて R5.4 の補助関数を通る（静的なガード、`tests/unit/guards` に置く）。
- 文書の試験（`tests/unit/docs`）は節と項目の存在だけを見る。安全の証明ではない（再確認 (4) の指摘のとおり）。上の赤は実装の PR で初めて確かめる（**未確認**）。

## 改訂 6（2026-11-13、Issue #4304、最後の改訂）: プロセスの証拠と行の証拠を分け、名前・nonce の不在・過去の成功で補わない

- 材料（全部読んだ）: 改訂 5（`955ff6119`）の再確認 `workspace/orchestration/runs/2026-11-13/prereview-4304-rev5-reply.md`（codex-2、**承認保留**）、この設計に関わっていない読み手の原因調査 `rootcause-4304-evidence-reply.md`（codex）、PM・人の処分（2026-11-13）: **D1=(a)、D3=(a)、D2=(b)+(c)**（人が 16:14 に変更: 共有の番の中で確かめ、入力のまとまりの配送の完了まで保持、PID のキャッシュなし）。操作ごとの画面の条件（再確認の③）と、再確認 (4) の対照の補完を入れてよい。
- 基準: develop `9d6e5adc6`（2026-11-13 に `git fetch`）。`git diff --stat 10232442d 9d6e5adc6` は `src/lib/tmux`・`src/lib/cli-tools`・`src/lib/session`・`src/lib/polling`・`prompt-answer-sender.ts`・`src/app/api/worktrees`・`ws-server.ts` で差が無いので、改訂 4・5 の file:line はそのまま使える。
- **この節が置き換えるもの**: R5.1 の I1〜I4（R6.1 の 2 文へ。I2・I4 は R6.1 を満たすための実装の条件として残す）、R5.2 の 2（argv の名前の照合は**採らない**）、R5.4 の「nonce が無ければ窓の全部が今の世代」（**取り消す**）、R5.3 の表の「停止の行」「UI の生の入力」の行、R5.6 の D1〜D3（処分済み）、R5.7。R5.3 の Enter 省略の回答をロックへ入れる決定、R5.5 の `-c` の文字列の順は残す。
- **実装は今日は入れない。PR2a・PR2b は改訂 6 の承認と、R6.2 の要決定 D4・D5 の処分の後**。

### R6.0 共通の原因

起動の前後や旧い行の有無を区別できない情報（argv の名前・nonce の不在・PID・過去の成功）から、「今の CLI」と「今の世代の画面」という**別々の事実**を確定しようとしていた（原因調査 §1）。改訂 4（入力欄が出ない）と改訂 5（argv の名前、nonce の不在）は同じ種類の誤りの 1 回目と 2 回目なので、**名前の照合を足して直さない**。この節は、何を直接観測すれば許可できるかを観測ごとに閉じ、観測できない CLI・起動の形・状態は**狭めて拒否**する。

### R6.1 不変条件（R5.1 を置き換える）

> **V1** 新方式のキーは、検証した実行実体・入力先・起動世代が配送時まで同じであり、操作対象の入力欄またはダイアログをその世代の現在のものと確認できた場合にだけ、対応する入力の番から送る。
>
> **V2** プロセスと行の証拠は独立に成立させ、argv 中の名前・nonce の不在・過去の成功では不足を補わず、観測不能・失効・世代混在ならキー 0 の未送信とする。

- 「入力の番から送る」は R5.3 の全キー経路のロック（旧 I2。Enter 省略の回答を含む）と、R6.4 の生の入力の共有の番。
- 「起動世代」は R6.2 の**世代の識別子**（`pane_id` と `pane_start_command` の中の nonce の組）で、PID ではない。
- cwd と環境（旧 I4、R5.5）は V1 の「検証した実行実体」に正しい環境で起動したことを含める実装の条件として残す。

### R6.2 証拠の表と、観測の仕組み（要決定 D4・D5）

各観測が**直接**確かめること（観測した時点の事実）と、偽・不足になる条件（原因調査 §2 を設計の言葉にした）:

| 観測 | 直接確かめること | 偽・不足になる条件 | この設計での使い方 |
|---|---|---|---|
| `pane_pid`＋alive（`pane_dead=0`） | ペインの最初のプロセスの PID と、生きていること | CLI の実体でも前景の読み手でもない。ラッパー・PID の再利用・**同じ PID の再 exec**を区別できない | 状態の読み（alive／dead／absent）だけ。CLI の証拠にしない |
| `pane_current_command`、ps の comm・argv[0] | 名前 | 実行ファイル・CLI の入口・世代を特定しない。インタープリタでは `node`・`python3` | 使わない（旧方式の PR1 の D は今のまま） |
| `pane_start_command` | ペインに渡した起動のコマンド（**起動の意図**） | そこまで実行が到達した証拠ではない | 世代の識別子（nonce を読む所）と方式の区別だけ |
| `ps args` の中の CLI 名（改訂 5 の R5.2 の 2） | argv にその文字列があること | exec の前の `zsh -l -i -c '… exec …/gemini …'`、別のコマンドの引数、ラッパーでも成り立つ。表示は書き換えられる | **採らない**（再確認①） |
| **OS が報告する実行イメージ＋入口＋端末の前景のプロセスグループ** | その時点で `pane_pid` が実行しているファイル、インタープリタなら入口のスクリプト、前景がそのプロセスのグループであること | 確認の**後の**再 exec・終了は分からない（スナップショット）。インタープリタでは入口の確認が要る。子に CLI がいるだけでは足りない | **プロセスの証拠**（D4 の E1） |
| CLI 自身が exec の後に出す ready の報告 | 報告したプロセスがその段階まで動いたこと | 起動側の `printf`・exec の前に渡す環境変数・子の生成の通知では代わりにならない。世代と発信プロセスの結合と、今も入力先であることの確認が要る | 9 CLI で揃わない（下の表）。証拠にしない |
| 画面の nonce の行 | その文字列が capture にあること | **不在は範囲の証拠にならない**（消された・折り返された・別画面）。あっても周りの全行の由来は証明しない | 同じ世代の中で「exec の前の rc の出力」と後を分ける補助だけ。不在から何も推論しない |
| 今の hooks・SSE | CLI が報告した会話・操作のイベント | 遅れて届く旧イベント・会話 ID の再利用・別サーバー。受け取っても前景や画面の各行を証明しない | 証拠にしない（構造化 API の宛先の確認だけ、R6.3） |
| **世代ごとに新しい画面（grid）** | その grid の行は、その世代のプロセス（rc と CLI）だけが書いたこと | grid を作り直した事実を tmux から確かめる必要がある（`pane_id` が新しく、作った直後の `history_size` が 0） | **行の証拠**（D5 の L1） |
| `#{alternate_on}` | 画面のモード | 起動世代の証拠ではない | 使わない |

**明記: 今の tmux／ps のスナップショットだけでは、確認の後の再 exec（同じ PID の CLI → シェル）までは保証できない。** 確認と配送の間に CLI 自身がシェルへ exec する場合を塞ぐには、exec を直接観測する仕組みが要る。

**要決定 D4（プロセスの証拠の仕組みと保証の範囲）**

| 案 | 中身 | 保証の範囲 | 費用・未確認 |
|---|---|---|---|
| **E1 スナップショット＋配送の後の再観測**（推奨） | キーのまとまりごとに、番の中で「実行イメージ（macOS は `proc_pidpath` 相当、Linux は `/proc/<pid>/exe`）の実パス＝起動の計画で解決した実行ファイルの実パス、またはインタープリタのイメージ＋入口の実パス＝解決した入口の実パス」かつ「端末の前景のグループ（`tpgid`）＝そのプロセスのグループ」を読む。キャッシュしない。配送の後にもう一度読み、変わっていれば `indeterminate` | 確認の時点の実体と前景。**確認の前の再 exec・前景の交代・終了は拒否できる**。確認と配送の間（同じ番の中、tmux の 1 呼び出しの間）の CLI 自身の再 exec は**保証の外**（配送の後の再観測で `indeterminate` と言うだけ） | macOS で実行イメージを外から読む手段（`ps`・`lsof`・小さな補助）の選定は**未実測**。1 回の配送に数十 ms |
| E2 exec の常時の監視 | 起動から `pane_pid` の exec を通知で見張る（macOS は kqueue の `NOTE_EXEC`）。通知があれば世代の証拠を失効させる | E1 に加え、確認と配送の間の再 exec を検出できる（通知の順序と配送の順序の関係は**未確認**） | 常駐の補助プロセスが要る。Linux は特権なしの手段が限られる → Linux では E1 に狭める |
| E3 CLI 自身の ready の報告 | hooks に世代の nonce を結び付ける | 報告した時点まで | 9 CLI で揃わない（codex の `session_start` は最初のターン、copilot の SessionStart は遅い、vibe-local は専用の source なし）。採らない |
| E4 CommandMate の中継プロセスをペインの最初のプロセスにする | 中継が内側の pty で CLI を起動し、CLI が終われば入力を捨てる | 入力の経路そのものを持つので、再 exec を含めて最も強い | 端末の再現（サイズ・シグナル・代替画面）の作り直し。別 Issue の規模 |

推奨は **E1**。保証の外（確認と配送の間の CLI 自身の再 exec）は、通常の CLI では起きない操作（CLI がシェルへ exec する）なので、受入基準に「保証の外」と明記して受け入れ、強い保証が要るなら E2（macOS）・E4 を別 Issue にする。**PM が受け入れない場合、#4304 の受入基準を満たす案は E4 だけになる**。

**要決定 D5（行の証拠の仕組み）**

| 案 | 中身 | 保証 | 費用 |
|---|---|---|---|
| **L1 世代ごとに新しい grid**（推奨） | 復旧は `respawn-pane` ではなく、同じセッションの窓を `new-window -k`（R4.2 の番の中、spawn と同じ呼び出し）で作り直す。最後の画面は作り直す前に同じ番の中で回収する（R6.5）。作った直後に同じ呼び出しで `#{pane_id}`・`#{history_size}` を読み、新しい `pane_id` と `history_size`=0 を世代の記録に持つ | 旧世代の行は**物理的に無い**。窓の全部がこの世代（rc と CLI）の出力。再描画・折り返し・代替画面からの復帰・履歴の上限に関係なく成り立つ | 終わった CLI の画面はペインの履歴に残らない（DB の最後の画面と応答の履歴には残る）。H2（手触りの変化）の追加の受け入れが要る。`history-limit` はセッションの設定で同じ値にする |
| L2 respawn＋`clear-history`＋端末のリセット | 改訂 3 の respawn のまま、spawn の前に履歴と可視の画面を消す | 消えたことを確かめられれば L1 と同じ | dead pane の可視の画面を消す手段（`send-keys -R` など）が効くかは**未実測** |
| L3 履歴を残し、nonce が見えるときだけ行を使う | 改訂 5 の印を残し、不在を「不明」にする | 不明の間は自動の操作をしない | 代替画面の CLI（claude・copilot・opencode・opencode-v2、`cli-tools/types.ts:42`）は描き直しで nonce が消えるので、準備完了の後の Auto-Yes・回答がほぼ常に止まる。採らない |

- 同じ世代の中（L1 の grid の中）で、exec の前の rc の出力と CLI の出力は、nonce が見えればその下だけを使い、見えなければ区別しない。rc の出力をダイアログと誤読しても、プロセスの証拠（E1）があるのでキーの届く先は CLI で、シェルでは実行されない（正しさの残り。受け入れる）。
- 世代の識別子は `(pane_id, pane_start_command の nonce)`。1 回の `display-message` で読め、PID を使わない。

**9 CLI ごとの成立条件と、狭めて拒否する範囲**（原因調査 §2 の表。インストールの形は**未実測**）

| CLI | プロセスの証拠にする実体（E1） | 証明できず拒否する形・状態 | 起動の ready に使えないもの |
|---|---|---|---|
| claude | 解決した `claude` の実パス（ネイティブ）か、node＋入口 | 実パスが解決と違うラッパー（D1=(a) で起動の失敗） | hooks の会話イベントを前景の証拠に読み替えない |
| codex | 解決した `codex` の入口（npm の起動スクリプトが子でネイティブを起動する形なら、前景のグループの中の子の実行イメージまで確かめる）と実行実体の対応 | 入口と実体を対応させられない形 | `session_start` は最初のターン（`hooks/sources/codex/source.ts:19-23`） |
| gemini | node＋入口の実パス | 入口が確認できないインタープリタの起動 | hooks あり。入力欄の型は PS1 で満たせる |
| vibe-local | bash のスクリプトの最後の `exec python3`（§2.3 の表）まで済んだ python のイメージ＋入口 | `vibe-local` の名前の維持を要求しない。python への置換が確認できない間は不明 | 専用の event source なし |
| opencode | 解決した実行パスと前景の対応 | — | SSE の session／permission の ID は操作の証拠で、行の世代ではない |
| copilot | PATH の実行体、または `gh copilot`（`cli-tools/copilot.ts:449-455`）なら gh が起動した実体まで | 実体まで辿れない `gh` 経由の形 | SessionStart が UserPromptSubmit より遅い（同 source の `:53-63`） |
| antigravity | `agy` の実体と前景の対応 | — | 正規化イベントはプロセス・起動の nonce と結び付かない |
| command-code | 実コマンド `commandcode`（`command-code.ts:80`）の実体。tool ID と区別する | — | hooks あり。Review などの画面の対象は別に確かめる |
| opencode-v2 | 解決した V2 の実行体（TUI）。API サーバーと区別する | — | SSE の応答先が分かっても TUI が前景だとは言えない |

- 全 9 種で「起動の文字列・名前・nonce だけでは足りない」は共通（`cli-tools/types.ts:19` の `CLI_TOOL_IDS`）。
- 拒否は起動の失敗（`not_sent`、理由を出す）で、旧方式への黙った後退はしない。

### R6.3 操作ごとの画面の条件と「不明」の扱い（再確認③、原因調査 §3）

**CLI の実体と世代の確認（R6.2）と、操作ごとの画面の条件を分ける。** 画面の条件に「入力欄（composer）」を一律に求めない（copilot の folder trust は composer の前に答える経路。`copilot.ts:637` の説明、`:697` で composer、`:702` で trust）。

| 操作 | プロセスの証拠・世代 | 画面の条件 | 不明・失効のとき |
|---|---|---|---|
| 本文＋Enter | 要 | 今の世代の **composer** | 最初のキーを出さず未送信。composer だけで起動の完了としない |
| 通常の回答（矢印・文字・Enter 省略） | 要 | 今の世代の**対象のダイアログ**（番の中の再読、`answerTargetStillOnScreen`） | キー 0。キーの一部の後の失効は未送信に戻さず、部分送信／`indeterminate` として保持 |
| strict の回答 | 要（キーごと） | 対象のダイアログ | 同上。終了の回答の後の dead は `session-ended`（⑥） |
| 起動時の trust・hooks・update・nudge | 要 | 今の世代の**対象の画面**（trust の画面など）。**composer は要求しない** | 自動で答えない（起動は準備待ちの時間切れ → §5.3） |
| plan-review | 要 | 対象の画面 | キー 0 |
| Auto-Yes | 要 | 対象のダイアログ | 保留。答えたと記録せず、観測できないことを「画面が消えた・解決した」とも断定しない |
| 停止（`/exit`・`/quit`） | 要 | composer | 文字列を送らない。所有を確かめた `kill-session`（管理の操作）で終える |
| UI の生の入力・special-keys・WS | 要（R6.4） | 求めない（人が画面を見て打つ） | 配送しない。理由を返す（R6.4） |
| interrupt（Escape 単独） | 要 | 求めない | 送らない（シェルでは実行されないが、V1 を例外なく当てる） |
| 構造化 API の回答 | **ペインの証拠を使わない** | API の宛先と、今の決定 ID | 宛先・決定 ID の確認の契約で別に扱う。API の生存を TUI の前景の証拠にしない。dead は入口で 400（⑥のまま） |
| dead の後の最後の画面の回収 | 生前に取った世代（R6.5） | — | 由来が不明な capture は診断にだけ残し、今の世代の応答として確定しない |

### R6.4 D2 = (b)+(c): 生の入力を共有の番で確かめ、配送の完了まで保持する

- 対象: `direct-input`（`cli-tools/direct-input.ts:26`）・`special-keys` ルート・WS の `terminal_input`（`ws-server.ts` のソケットごとの直列の鎖、`:109`）の**全部**。新方式のペインだけ（旧方式は今のまま）。
- 流れ: 入力のまとまり（1 回の API 呼び出し、WS は鎖の 1 要素）ごとに、`withInstanceInputLock(…, { mode: 'shared' })` を取る → 番の中で R6.2 のプロセスの証拠（E1）と世代の識別子を**その場で**読む → 真なら tmux へ配送し、**配送の呼び出しが戻るまで番を持つ** → 番を返す。respawn／new-window の `exclusive` の番とは同時に持てないので、確かめた後・配送の前に作り直しが入らない（(b) 単独への反対の理由を塞ぐ）。
- **キャッシュを置かない**: `pane_pid` ごとの成功を覚えない（exec は PID を保つので、CLI → シェルの置換の後に成功を使い回しうる）。まとまりごとに読む。
- 不明・偽: 配送しない。`direct-input`・`special-keys` は 409（未配送、理由つき）、WS は配送しなかったことをクライアントへ返す。
- 費用: まとまりごとに `display-message` 1 回＋E1 の観測 1 回。打鍵の遅れは PR2b の UAT で測る（**未実測**）。

### R6.5 dead の後の最後の画面の回収（⑤ と §5 の保存の条件を合わせる）

- 生前（alive で、R6.2 の証拠が真の poll）に、世代の識別子 `(pane_id, nonce)` を応答の poll の状態に持つ。
- dead を読んだら、同じ `display-message` で `pane_dead=1` と世代の識別子を読む。**生前に持った識別子と同じなら**、その capture は同じ dead の世代のもの（dead pane に書くプロセスはいない）として **1 回保存**する。死後の ps は要求しない（読めない）。
- 識別子が違う・読めない・生前に持っていない（サーバーの再起動の後など）capture は、診断にだけ残し、今の世代の応答として確定しない。
- 作り直し（L1 の `new-window -k`）は、最後の画面の回収を**同じ `exclusive` の番の中で先に**済ませてから行う。回収と作り直しの間に後継の画面は生まれない。
- これで改訂 4 の⑤（`pane_pid` の前後の照合）を置き換える。`pane_pid` は使わない。§3.2 の (11) と §5 の保存の条件も、この識別子で読む。

### R6.6 対照の試験（各防御を 1 つずつ外して赤）

他の条件を成り立たせてから、防御を**1 つだけ**外す。結果はファイルの有無だけでなく、配送・保存・spawn の順序の記録で見る。

| # | 対照 | 要求する結果 | 外す防御（赤になること） |
|---|---|---|---|
| 1 | 起動のシェルの argv に正しい CLI 名を残し、rc が対話シェルを前景で起動。PS1 と入力欄の型は満たす | プロセスの証拠だけで拒否、キー 0 | プロセスの証拠（E1） |
| 2 | 本物の対応する CLI・対応するインタープリタ経由 | 送信できる（名前が違うだけで常に拒否する実装を検出） | —（陰性対照） |
| 3 | CLI の子プロセスはいるが、前景は別のシェル | 許可しない | 前景のグループの照合 |
| 4 | 証拠を取った後、同じ PID で CLI → シェルへ再 exec（nonce の行は出た後） | 次のまとまりは拒否（成功のキャッシュを使わない）。確認と配送の間の再 exec は E1 では保証の外として `indeterminate` を返す | キャッシュを入れると赤。argv だけを外す対照もこの形で（nonce の不在の規則に頼らず argv の防御を検証できる） |
| 5 | プロセスの証拠は成り立つ。旧世代のダイアログを残そうとする（L1 では残らないことを確かめる。L2・L3 を採る場合は nonce だけを消して旧ダイアログを履歴に残す） | 自動の回答 0 | 行の証拠（L1 の grid の作り直し） |
| 6 | nonce の折り返し（狭い幅）・履歴の上限・代替画面への出入り | 「見つからない」を今の世代に変えない。由来が確かめられる新しい画面は読める | 行の証拠 |
| 7 | 旧世代の hook を遅れて届かせる／今の世代のイベントの受信の後に CLI が終わる | 受信の時刻や過去のイベントだけで ready・送信の許可を立てない | — |
| 8 | composer の無い今の世代の trust／旧世代の trust | 前者はキー 1 回、その後に本文の送信が届く。後者は 0 回 | 操作ごとの画面の条件（composer を一律に求めると前者が赤） |
| 9 | 同じ dead の世代の最後の回収／回収の途中の世代交代 | 前者は保存 1 回、後者は後継を混ぜない。ps が無いだけで前者を捨てない | R6.5 の識別子の照合 |
| 10 | 全操作の unknown、番の中の再読、全 9 CLI の各入口 | 本文・回答・trust・Auto-Yes・停止の文字列・生の入力に抜けがなく、判定できないときキーが出ない | 各経路の判定点（静的なガードに加え、実際の配送の結果を検査） |

再確認 (4) の補完:

- **I2（PR2a）**: `exclusive` を持つ送信が配送している間に、Enter 省略の回答が届かない（実在の経路で赤にできる）。陽性対照: Enter 省略をロックの外に戻すと送信の途中に数字が入る。dead → respawn の試験は PR2b へ移す（R5.3・R5.7 の旧い試験の再利用の記述は取り消す）。
- **ロックだけを外す対照（PR2b）**: ファイルが作られないことだけでなく、**A の配送の完了の前に B が spawn したこと**を記録で検出する（ticket の確認・再照合だけでファイルの作成が止まる場合があるため）。
- **D2**: `direct-input`・`special-keys`・WS のそれぞれで、(i) 確認の後に respawn を差す → respawn は配送の完了の後、(ii) 同じ PID で別のプロセスへ exec → 次のまとまりは配送しない。
- **環境の順（R5.5）**: 代入を cd の前に戻すと偽 CLI に変数が届かない（成立済み）。

### R6.7 PR の境界（R5.7 を置き換える）

| 順 | PR | 中身 | 新方式の起動 |
|---|---|---|---|
| 1 | #4303-A（独立、いつでも） | 旧方式の回答経路の D。R5.3 の通常の回答 3 行（Enter 省略を名指し）と strict | 生まない |
| 2 | **PR2a** | `readPaneState`・§3 の読み手、世代の識別子の読み（`pane_id`＋`pane_start_command`）、④、⑥、R6.5 の回収（作った dead pane で試験）、`relaunched`、**Enter 省略の回答を `shared` の番へ**（試験は R6.6 の I2）。dead は読めるが**復旧しない**（D3=(a)、未送信） | 生まない |
| 3 | **PR2b** | spawn（D5 の L1 なら `new-window -k`）＋remain-on-exit、R4.2 の番、R6.2 のプロセスの証拠（D4）と行の証拠（D5）、R6.3 の操作ごとの条件、R6.4 の生の入力、R5.5 の `-c` の文字列、⑦、§5.3 の早い失敗、dead → 作り直しの復旧、停止の `kill-session`、H2（D5 で増える分を含む）・H3、R6.6 の 1〜10 と補完 | **ここで初めて生む** |
| 4 | #4303-B | 新方式の回答経路の dead・世代交代 | — |

- PR2b の受入（#4304 本文の案を改める）: 「保証の外」（D4 の E1 なら確認と配送の間の CLI 自身の再 exec）を除き、どの CLI でも、CLI の終了後・復旧の最中・rc が別のシェルへ exec する構成で、send・回答・生の入力のキーがシェルに 1 バイトも届かない。証明できない起動の形（R6.2 の拒否の列）は起動の失敗として返る。
- 文書の試験（`tests/unit/docs`）は節と項目の存在だけを見る。設計の赤は実装の PR で初めて確かめる（**未確認**）。

## 改訂 7（2026-11-14、Issue #4304）: D4・D5 の処分、行の証拠を capture の世代結合の設計へ委ね、strict の担当を決める

- 材料（全部読んだ）: 改訂 6（`bd55f8469`）の再確認 `workspace/orchestration/runs/2026-11-13/prereview-4304-rev6-reply.md`（codex-2、**承認保留**。A: 返された capture の世代帰属、B: strict の担当 PR、D4・D5 への意見）、人の承認（2026-11-14 00:1x、PM 追補 1 の 7 `2026-11-14/pm-brief-stage1-addendum1.md`）、A の原因調査 `2026-11-14/enabler-return-4304-A-cause.md`、そこから切り出した設計 `docs/design/capture-generation-binding-4304.md`（以下 **CG**。PR #4376、ブランチ `docs/4304-capture-generation`、第 3 版 `807a329f0`、2-4-4 を 3 回で**条件つき承認** `2026-11-14/prereview-4304-capgen-3-reply.md`）。
- **この節が置き換えるもの**: R6.2 の要決定 D4・D5（処分済み）と D4 の表の E1 の「配送の後の再観測で `indeterminate` と言うだけ」・「PM が受け入れない場合、#4304 の受入基準を満たす案は E4 だけ」、R6.1・R6.2 の世代の識別子 `(pane_id, nonce)`、R6.5 の全部、R6.6 の 4 の「argv だけを外す対照」と 9、R6.7 の順の表（#4303-A の行の strict を含む）と PR2b の受入の「保証の外」。改訂 6 の他の行（V1・V2、証拠の表の観測ごとの行、R6.3、R6.4、対照の 1〜3・5〜8・10、補完）は残す。
- **実装は今日は入れない。PR2a・PR2b は改訂 7 の承認の後**（加えて R7.6 の順のとおり）。
- 基準: file:line はこの worktree の src（改訂 6 と同じ基準。名前で探して取り直した）。改訂 6 の見出しの「最後の改訂」は、A を同じ種類の 3 回目として CG へ切り出したので守れなかった（改訂 7 は処分と参照の書き直しが主で、新しい観測の仕組みを足さない）。
- 追記（2026-11-14 01:4x 以降）: 人の答え `2026-11-14/pm-return-4304-q5q6.md`（**Q5 受け入れ・Q6 受け入れ**）と、改訂 7 の 2-4-4 確認 `2026-11-14/prereview-4304-rev7-reply.md`（codex-2、**条件つき承認**、K1〜K3）を反映した。Q6 は R7.1・R7.7、Q5 は R7.3、K1 は R7.6（PR の順の唯一の置き場所）、K2 は R7.3、K3 は R7.2・R7.5。処置は R7.8 の表の最後の行
- 書き方: CG に書いてあること（識別子の成立条件、`captureBoundFrame` の手順、回収の権利の状態と札、試験の行）はここに写さず、CG の節を名指す。CG と食い違ったら CG を正とする（CG が改訂されたら、その版を読む）。

### R7.1 D4 = E1 を「限定された保証」として採る（人の決定）

- **採る: E1**（R6.2 の表の行のとおり、キーのまとまりごとに番の中で、`pane_pid` の実行イメージの実パス（インタープリタなら入口の実パス）＝起動の計画で解決したもの、かつ端末の前景のグループ（`tpgid`）＝そのプロセスのグループ、を読む。キャッシュしない。配送の後にもう一度読む）。
- E1 が保証するのは「**観測した各時点で**、ペインの最初のプロセスが計画した実体・入口で、前景のグループがそのプロセスのグループだった」ことだけ。次の 2 つは**保証の除外**として受入基準・変更の説明・`docs` に明記する:
  - **(a) 前後の観測の間の変化（観測と入力の間の窓）**: 配送の前の観測と配送の間、配送と後の観測の間に起きた再 exec・前景の交代・終了は防がない。後の観測が前と同じでも、途中で変わって戻った場合は検出できない。R6.2 の「配送の後の再観測で `indeterminate` と言う」を「**後の観測で差を見たときだけ** `indeterminate`。差を見なかったことを、途中の変化が無かった証拠にしない」に改める（再確認 (3) の 2 点目）。
  - **(b) `tpgid` は前景のプロセスグループの証拠でしかない**: 端末を実際に読むプロセスを特定しない。同じグループの中の子（CLI が自分のグループの中で起動したシェル・ページャー等）へ入力が渡る状態は**拒否せず保証の外**とする。読み: ジョブ制御のある対話シェルは自分のグループを作って前景にするので `tpgid` が変わり、E1 で拒否される（対照の 3）。除外に残るのはグループを作らない子だけ。
- **E2（exec の通知）は候補止まり**。通知と配送の順序の保証が成り立つまでは「E1 より強い検出の候補」で、この Issue の受入に使わない（再確認 (3) の E2 の意見）。
- **E4（中継プロセス）だけで受入を満たす扱いにはしない**。R6.2 の「PM が受け入れない場合、受入を満たす案は E4 だけ」は**取り消す**（中継だけでは内側のプロセスの再 exec を識別できるとは限らない、再確認 (3)）。E4 は調査の候補として残す。
- 先に確かめること: 対応する起動の形（R6.2 の 9 CLI の表）で、実体・入口・前景を外から観測できること。macOS の観測の手段（`ps`・`lsof`・小さな補助）は**未実測**で、PR2b の最初に実装者が隔離の環境で測り、リーダーが選ぶ（R7.7）。観測できない形は R6.2 のとおり狭めて拒否する（起動の失敗、旧方式への黙った後退なし）。
- 改訂 6 の R6.2 の D5 の下の箇条（同じ grid の中で nonce が見えなければ rc の出力と CLI の出力を区別せず、rc の出力をダイアログと誤読しても受け入れる）は、**V1 の「操作対象を今の世代の現在のものと確認」を「今の世代の grid（rc と CLI が書いた行）の中の対象」に狭める判断**として明示する（再確認 (3) の最後）。**人が受け入れた（2026-11-14 01:4x、Q6）**ので、**保証の除外 (c)** として (a)(b) と同じく受入基準・変更の説明・`docs` に明記する: **(c) 同じ grid の中で nonce が見えないとき、exec の前の rc の出力を CLI のダイアログと区別しない**（誤読してもプロセスの証拠 E1 があるのでキーの届く先は CLI で、シェルでは実行されない）。受け入れない場合の代わり（nonce が見えるときだけ自動）は採らない。

### R7.2 D5 = L1 を採る（人の決定）と、受入に足す 3 つ

- **採る: L1**（世代ごとに新しい grid。復旧は同じセッションの窓を `new-window -k` で作り直す。R6.2 の表の行のとおり）。L2・L3 は採らない。
- 受入に次の 3 つを入れる（イネーブラーの条件、再確認 (3) の D5・L1）:
  1. **A の frame の帰属**: 新しい grid を確かめるだけでなく、実際に使う frame をその世代へ結び付ける。中身は R7.3（CG）。
  2. **履歴の喪失の受入**: 作り直しの後、終わった CLI の画面はペインの履歴に**残らない**。人は L1 の採択（2026-11-14 00:1x）でこの手触りの変化を受け入れた（H2 に足す分）。DB に残るものは 2 つに分けて書く（K3）: (i) **既に保存済みの応答の履歴**は残る（作り直しで消えない）。(ii) **旧世代の最後の画面（最終 frame）の保存は高々 1 回で、必ず保存されるとは約束しない**（CG の G2: 成功の保存は高々 1 回、失敗した世代は 0 回）。生前の印が無い（サーバーの再起動の後など）・frame が unknown・保存の失敗のときは **0 回**で、それでも作り直しは CG §4.7 の終端の規則に従って進む。受入基準は「作り直しの後のペインに旧世代の行が無いこと」と「旧世代の最後の画面の成功の保存が高々 1 回で、0 回の場合を含むこと」の両方。契約と利用者向けの説明（changelog）でも「最後の画面が必ず残る」とは書かない。
  3. **窓の geometry の再適用の対照**: `new-window` で作った窓は前の窓の `window-size manual` を継がない（事実: `src/lib/tmux/tmux.ts:547-551` のコメント、`show-window-options -v window-size` が空）。作成時は窓の作り直しの**後**に `reconcileSessionGeometry`（`tmux.ts:129`、呼び出しは `:552`）を呼ぶ順で守っている。L1 の作り直しでも同じ順で、`window-size manual`・`resize-window` の幅と高さ、CLI ごとの幅（opencode `src/lib/cli-tools/opencode.ts:451`、opencode-v2 `opencode-v2.ts:285`）を再適用する。`history-limit` はセッションの option（`tmux.ts:502`）なので新しい pane が引き継ぐ（新しい pane だけが効く、`tmux.ts:489-498`）。対照: 作り直しの前に窓の幅・高さ・`window-size` を作成時の値にしておき、作り直しの後に同じであること。再適用を 1 つ外すと赤（`window-size` が空に戻る／幅が既定に戻る）。再適用の対象の一覧は PR2b の実装者が src の設定箇所から作り、レビューで確かめる（R7.7）。

### R7.3 行の証拠と最後の画面の回収は CG に委ねる（A、同じ種類の 3 回目）

再確認の A（新しい grid の確認が、返された capture の由来を保証しない。通常の dead の回収とキャッシュ経由の 2 経路）は、team.md §6-6 のとおり止め、作業に関わっていないイネーブラーの原因調査（`enabler-return-4304-A-cause.md`）を受けて CG に切り出した。改訂 7 は次のとおり**書き直し、中身は CG を参照する**:

| 改訂 6 の箇所 | 改訂 7 での読み方（中身は CG） |
|---|---|
| R6.1・R6.2 の世代の識別子 `(pane_id, pane_start_command の nonce)` | grid の識別は CG §4.8 の `(server の start_time, pane_id)`（CG の未決 U2 の結果を足した形）。nonce は同じ grid の中で rc の出力と CLI の出力を分ける補助だけ（CG §2） |
| R6.2 の行の証拠（L1）と R6.3・R6.4 の画面を読む所 | 行動する読者は `captureBoundFrame` が返す BoundFrame だけを使い、キャッシュを読まない・書かない（CG §4.1・§4.4・§4.5）。不変条件は CG の **G0**（G1・G2 を含む）。F1 が保証するのは frame の grid・pane の出典だけで、E1（R7.1）と入力の番は別の保証として並べる（CG §1.5） |
| R6.5 dead の後の最後の画面の回収 | **R6.5 は全部無効**。CG §4.6（dead を確かめた後にその世代を的に取った frame だけ）と §4.7（**回収の権利**: `globalThis` の 1 つの記録、**札**（fencing token）、終端の意味、作り直しが終端を待つ順）で置き換える。通常 poll の dead の保存（R1・R2）も同じ権利と札を通す |
| R6.6 の 9 | CG §6 の T4・T5・TC1〜TC3・TD1〜TD5（TD2a〜c・TD4a〜c を含む）と対照 (i)〜(iii)。CG の条件つき承認の C1〜C3（非行数型の受入、通常の保存と回収の札の区別、同期の commit と失効の対照）は該当 PR の契約に入れる |

- **境界**（順そのものは R7.6 だけに書く、K1）: **回収の権利の最初の呼び手は PR2a**（呼び手 R3 と R1・R2 の dead の保存が初めて現れる PR。未使用のモジュールを先に入れない）。**作り直し（`new-window -k`）が回収の終端を待つ順は PR2b**（CG §4.7・§5）。PR2b は起動の期待の世代の取り方を、CG §4.10 の「作成／再利用の最初の読みより前」を正として spawn が返す pane id へ替える（CG §5 に残る「`launchSession` の後の読み」の書き方は採らない）。
- **PR2a が継承する識別子と回収の契約（K2）**: 名前と中身は CG §4.6〜§4.8 に揃え、改訂 6 の書き方を契約へ写さない。
  - 世代: CG §4.8 の `PaneGeneration`＝`(server の start_time, pane_id)`（CG の U2 で選んだ識別を足した形）。読みは `readPaneGeneration`・`readPaneGenerationById`（CG §4.1）。`pane_start_command` と nonce は**方式の区別**と**同じ grid の中で rc と CLI の出力を分ける補助**だけで、grid の識別に使わない。R6.7 の PR2a の行の「世代の識別子の読み（`pane_id`＋`pane_start_command`）」は継がない。
  - 最後の画面: CG §4.6 の手順（`%G` が dead → `capture-pane -t %G` → `%G` がまだ dead で同じ世代）で取った frame だけ。旧 R6.5 の「識別子が同じなら、名前で取った capture も同じ世代」は復活させない。
  - 回収の権利: CG §4.7 の世代ごとの記録 `{ 状態, 札, 生前に bound で alive を見た印 }`（`globalThis` の 1 つの領域。状態は 無し・進行中・保存中・完了・失敗）。回収はこの記録からしか始めない。
  - CG の条件つき承認の C1〜C3 を PR2a の契約に入れる。とくに**通常の alive の保存（R2 の照合）と dead の最後の回収の札は別の条件**（C2）。PR2a は R1・R2・R3 と生前の印の登録元を同じ PR に入れ、F1-b で確定する受け入れた世代・カーソル（CG §4.11）を PR2a へ先送りしない。PR2b の作り直しの待ちは CG §4.7 の札・失効・終端の意味をそのまま使う。
- **利用者に見える変更（Q5）**: CG §4.2 の挙動の変更（手の回答は capture の失敗で未送信 `answer_not_delivered`、send の guard と relay は判定できないとき保留、生存は第 3 の値、待ちを解決しない）は**人が受け入れた（2026-11-14 01:4x、Q5）**。CG の U6 は決定済みで、F1-a の契約の受入に入れ、changelog に挙動の変更として明記する（#4313 B-1 の「fail-open は変えない」は F1-a で上書き）。

### R7.4 strict の担当（再確認 B）

- 事実: #4303 の PR（#4364、マージ済み）は再指示 3 で strict の経路を develop と同一に戻した（`a18d31c54`。changelog に「strict `respond` の経路はまだ前景の判定を通らない（既知の残り、別 PR）」）。だから R6.7 の表の「#4303-A … と strict」は事実と食い違う。**取り消す**。
- **決定（人の承認、PM 追補 1 の 7）**: strict は **#4303-A の追跡の候補（strict の回答の経路に前景の判定を入れる）と同じ PR**（以下 **strict PR**）にまとめる。順は**原因調査 → 設計の表 → 実装**。
- strict PR の担当範囲（再確認 B）: キーの数・各キーの前の判定点だけでなく、**token・operation の保存・初回の応答・再送の一致**まで。通常の回答の経路（#4303-A・PR2a の Enter 省略）へ strict の指摘を持ち込まない境界にする（前回の strict の P2 2 件、`review-4303-ac.md` は strict PR の原因調査の入力）。
- 依存と順: strict の read は CG の F1-a で BoundFrame に移る（CG §5 の R7 strict の read、Fresh の書き戻しの削除と同じ PR）。新方式の strict の条件（R6.3 の strict の行: プロセスの証拠と世代をキーごと）は、R4.4 と同じ形で**判定点を持つ PR が先、方式の分岐を足す PR が後**: strict PR は旧方式の判定を当てた判定点を入れ、PR2b が新方式の分岐（E1・世代）をその判定点に足す。PR2a へ strict の実装を混ぜない。**順は R7.6**（K1 で一本化）。

### R7.5 R6.6 の 4 の対照を E1 の確認ごとに引き直す（再確認 (4)）

R6.6 の 4 の「argv だけを外す対照」は撤回した判定（argv の名前）を指すので取り消し、E1 の 3 つの確認を**1 つずつ**外す対照に替える。他の条件（世代・番・画面）は成り立たせる。

| # | 対照 | 要求する結果 | 外す防御（赤になること） |
|---|---|---|---|
| 4a | 証拠を取った後、同じ PID で計画と違う実行イメージへ exec（CLI → シェル） | 次のまとまりはキー 0 | 実行イメージの照合 |
| 4b | 同じインタープリタのイメージのまま、計画と違う入口のスクリプトへ exec | キー 0 | 入口の照合 |
| 4c | 実体と入口は正しいが、前景のグループが別（対照 3 と同じ形） | キー 0 | 前景のグループの照合 |
| 4d | 前のまとまりで成功した後に 4a の状態 | キー 0（成功を使い回さない） | キャッシュを入れると赤 |
| 4e | 配送の前後の観測が同じで、途中だけ変わる | 結果を要求しない（R7.1 の除外 (a)）。差を見たときは `indeterminate` | —（保証の外を試験で固定しない） |

- PR2b の受入は実装の対照で閉じる（K3）: 旧行が無いこと・geometry の復元・4a〜4d を、**それぞれ独立に防御を 1 つ外す対照**で確かめる。4a・4b の置換は**次のまとまりの事前の観測より前**に成り立たせ、除外 (a) の窓（観測と配送の間）と混ぜない。陽性の対照（実体・入口・前景が正しい CLI で送れる）、composer の無い正しい trust（キー 1 回）、通常・strict の結果の保存と再送の整合も残す。存在のラベルを見る文書の試験だけで受入を済ませない。

### R7.6 PR の順（R6.7 の表を置き換える。PR の順の唯一の置き場所、K1）

この表が #4304 に関わる PR の順の**唯一の置き場所**。他の節（R7.3・R7.4・R7.7）は順を書かず、ここを参照する。順は **F1-a・F1-b は #4304 PR2a より前に入る**、strict PR は PR2a の後・PR2b の前（2-4-4 確認 K1 で依頼の順 `F1-a → F1-b → PR2a → strict → PR2b` に揃えた）。

| 順 | PR | 中身 |
|---|---|---|
| 0 | #4303-A（#4364、マージ済み） | 旧方式の通常の回答経路の前景の判定。strict は含まない |
| 1 | CG F1-a | 回答の経路の BoundFrame、strict の read の移し替えと Fresh の書き戻しの削除（CG §5）。Q5 の挙動の変更（R7.3）を受入と changelog に |
| 2 | CG F1-b | 保存・送信・起動・状態の経路（R10 を含む。CG §5）。CG の U4 で分けても**全部の片が PR2a より前** |
| 3 | **PR2a** | R6.7 の PR2a の中身から R6.5 の回収と旧い世代の識別子の読み（`pane_id`＋`pane_start_command`）を除き、R7.3 の K2 の契約（CG §4.6〜§4.8 の名前）で最後の回収と**回収の権利（最初の呼び手）**を入れる。strict の実装は混ぜない。復旧はしない（D3=(a)） |
| 4 | strict PR | R7.4。原因調査 → 設計の表 → 実装。PR2a の後・PR2b の前 |
| 5 | **PR2b** | R6.7 の PR2b の中身＋D4=E1（R7.1）・D5=L1（R7.2 の 3 つ）・作り直しが回収の終端を待つ順（CG §4.7）・spawn の pane id で期待の世代・strict の判定点への新方式の分岐（R7.4）・R7.5 の対照。**新方式はここで初めて生む** |
| 6 | #4303-B | 新方式の回答経路の dead・世代交代 |

- 並行の作業: 書くファイルが重ならなければ、契約・実装の作業は並行してよい。ただし**検証と統合（develop へのマージ）はこの表の順**で行う。順を替えるときは、リーダーが変更の理由と依存を整理してからこの表を改める（ファイルが重ならないことだけでは順を替えない）。
- PR2b の受入（R6.7 を改める）: **保証の除外 (a)(b)(c)（R7.1）**を除き、どの CLI でも、CLI の終了後・復旧の最中・rc が別のシェルへ exec する構成で、send・回答（strict を含む）・生の入力のキーがシェルに 1 バイトも届かない。証明できない起動の形は起動の失敗として返る。作り直しの後に旧世代の行がペインに無く、geometry が作成時と同じ（R7.2）。旧世代の最後の画面の成功の保存は高々 1 回（0 回を含む、R7.2 の K3）。
- 文書の試験（`tests/unit/docs`）は節と項目の存在だけを見る。設計の赤は実装の PR で初めて確かめる（**未確認**）。

### R7.7 未決（誰が・何で・いつ決めるか）

| 未決 | 誰が | 何で | いつ／決まるまで |
|---|---|---|---|
| ~~R7.1 の rc の出力の誤読を許す V1 の狭め~~ **決定済み** | 人（PM 経由） | 2026-11-14 01:4x、Q6 で受け入れ（`pm-return-4304-q5q6.md`） | 保証の除外 (c) として明記した（R7.1） |
| E1 の macOS・Linux の観測の手段と、9 CLI の起動の形で観測できるか | PR2b の実装者が隔離の環境で実測し、リーダーが選ぶ | R6.2 の 9 CLI の表の各行 | PR2b の最初。観測できない形は狭めて拒否（保証を広げる後退はしない） |
| geometry の再適用の対象の一覧 | PR2b の実装者（レビューで確かめる） | src の窓・ペインの設定箇所（R7.2 の 3） | PR2b の中 |
| strict PR の契約（原因調査の結果と設計の表） | リーダー（strict PR の原因調査はイネーブラー） | `review-4303-ac.md` の strict の P2 と R7.4 の担当範囲 | strict PR の開始の前に閉じる（順は R7.6）。決まるまで strict PR を送らない |
| E2・E4 を別 Issue にするか | PM | R7.1 の除外 (a)(b) が運用で問題になるか | PR2b の後 |
| CG の U1〜U7 | CG §7.2 のとおり（ここに写さない）。U6 は Q5 で決定済み（R7.3） | — | CG §7.2 |

### R7.8 改訂 6 の再確認の指摘ごとの処置（`prereview-4304-rev6-reply.md`。追記で改訂 7 の確認 `prereview-4304-rev7-reply.md` の K1〜K3 と人の答え Q5・Q6）

| 指摘 | 処置（閉じた先） |
|---|---|
| A（P2）: 返された capture の世代帰属（通常の dead の回収・キャッシュ経由） | 閉じた: CG に切り出し、R6.5 を CG §4.6・§4.7（回収の権利・札・G0）で置き換え、行動する読者は BoundFrame だけ（R7.3） |
| B（P2）: strict の担当 PR が最新の処分と食い違う | 閉じた: R6.7 の strict を取り消し、strict PR（#4303-A の追跡の候補と同じ PR、原因調査→設計の表→実装）に token・operation の保存・初回の応答・再送の一致まで担当させた。順は R7.6（K1 の行）（R7.4・R7.6） |
| D4・E1: 限定された保証として条件つき賛成、保証の除外を PM が決める | 閉じた: 人の決定で E1 を限定された保証として採り、除外 (a)(b) を明記（R7.1） |
| D4・E1: `tpgid` は前景のグループの証拠で読み手の証拠ではない（拒否か保証の外か） | 閉じた: 同じグループの子は保証の外（除外 (b)）、グループを作る子は拒否（R7.1） |
| D4・E1: 前後の観測が同じでも途中の変化はありうる | 閉じた: 除外 (a)。「差を見たときだけ `indeterminate`」に改め、対照 4e で保証の外を固定しない（R7.1・R7.5） |
| D4・E2: 通知だけで配送を阻止できるとは扱わない | 閉じた: 候補止まり、受入に使わない（R7.1） |
| D4・E4: 「E4 だけなら受入を満たす」に反対 | 閉じた: その文を取り消し、調査の候補に（R7.1） |
| D5・L1: A の frame の帰属・履歴の喪失の受入・geometry の再適用の対照が要る | 閉じた: 受入に 3 つを入れた（R7.2、1 は R7.3） |
| D:257 の rc の出力への誤回答を V1 の狭めとして明示 | 閉じた: 明示し、人が受け入れた（Q6）。保証の除外 (c)（R7.1・R7.7） |
| D:320 の「argv だけを外す」を E1 の確認へ対応させる | 閉じた: 対照 4a〜4e に引き直した（R7.5） |
| K1（P2、改訂 7 の確認）: PR の順が依頼と R7.6 で食い違う | 閉じた: R7.6 を唯一の置き場所にし `F1-a → F1-b → PR2a → strict → PR2b` に揃えた。並行は作業だけ、検証と統合は順のとおり（R7.6）。R7.3・R7.4・R7.7 は参照に替えた |
| K2（P3）: PR2a が旧い識別子（`pane_id＋pane_start_command`）を写しうる | 閉じた: CG §4.6〜§4.8 の名前（`PaneGeneration`・`readPaneGeneration`・回収の権利の記録）に揃え、旧い読みと旧 R6.5 を継がないと明記。C1〜C3 と C2 の札の区別を PR2a の契約へ（R7.3・R7.6） |
| K3（P3）: 「高々 1 回」と「必ず保存」の区別、受入を実装の対照で閉じる | 閉じた: 既に保存済みの応答の履歴と最終 frame の保存を分け、0 回（生前の印なし・unknown・保存の失敗）を明記（R7.2）。独立の対照と 4a・4b の成立の時点（R7.5） |
| Q5（人）: CG §4.2 の利用者に見える変更 | 受け入れ（2026-11-14 01:4x）。F1-a の受入と changelog に（R7.3） |
| Q6（人）: rc の出力の誤読を許す V1 の狭め | 受け入れ（2026-11-14 01:4x）。保証の除外 (c)（R7.1） |

## 0. 改訂 3 の要約と PR1 との関係

### 0.1 要約（改訂 3 で決めたこと）

| # | 決めること | 決定 | 節 |
|---|---|---|---|
| (1) | 起動の形 | **ペインのコマンドとして起動する**: `new-window -k -c <cwd> <shell> -l -i -c '<代入> exec <cli> <引数>'`。復旧は `respawn-pane -c <cwd>`（`-k` なし）に同じコマンド。起動行は**打たない**。`<shell>` は tmux の `default-shell`（今の `respawnLoginShell` と同じ読み方） | §2.1、§2.2 |
| (2) | なぜ `sh -c` でなくログインシェルの `-l -i -c` か | **実測で `sh -c` は今の起動と同じ環境にならない**（表 4 の s2: rc の PATH と rc が export する変数が CLI に届かず、PATH にしか無い CLI は `not found` で 127）。`<shell> -l -i -c` は今の起動と PATH・rc の変数・`CM_*`・秘密の代入まで同じ（s1 と s3 が一致）。`-c` のシェルはコマンドを文字列からだけ読み、端末からは読まない（プロンプトも出さない）。起動中（rc を読んでいる間）に届いたキーは端末のバッファに溜まり CLI が読む（s6: 改行入りでも実行されない） | §2.1、§9 表 4 |
| (3) | `env` | **外す**。`exec env` の `env` は「bash の対話シェルは exec に失敗しても残る」穴のためだった。`-c` のシェルは exec に失敗すると終わり、ペインは dead（127）になる（s9: zsh・bash・sh とも）。P2-2 の「`env` が PATH に無い」心配も消える | §2.2 |
| (4) | remain-on-exit | `new-window`／`respawn-pane` と**同じ tmux の呼び出しに `;` でつなぐ**（`… \; set-option -p -t <pane> remain-on-exit on`）。別の呼び出しにすると、すぐ終わる CLI（起動の失敗）ではセッションごと消える（s10: 別呼び出し 0/20 残る、つなぐと 20/20 残る） | §2.4 |
| (5) | 方式の区別（P2: 印と世代） | 印 `@cm_launch` は**外す**。代わりに tmux 自身が作成と respawn の時に入れる `#{pane_start_command}` を読む（s4: 旧方式は空か `<shell> -l`、新方式は `<shell> -l -i -c "…"`、respawn で入れ替わる）。ペインとその世代に tmux が原子的に結び付けるので、印の保存の前のサーバー終了・保存の失敗・古い起動が後継に印を付ける、が構造的に無い | §2.4、§3.1 |
| (6) | 読み手 | ペインを alive／dead／absent／unknown に分け、方式（exec／legacy）を同じ 1 回の `display-message` で読む。`paneExists`＝alive または dead、`agentAlive`＝alive かつ（新方式、または旧方式で今の判定が alive） | §3 |
| (7) | 送信中の復旧（新 P1） | 復旧は respawn で**CLI を直接起動**するので、送信中の古いキーが届きうる先は「dead pane（捨てられる）」「起動中の `-c` のシェル（読まない。端末のバッファに溜まる）」「新しい CLI」だけ。**シェルが端末を読む区間は無い**（s5・s6）。新しい CLI に届いた場合は Enter の後の確認が `pane_pid` の変化で indeterminate にする（正しさの面、§4.5） | §4.5 |
| (8) | 旧方式の Ctrl-Z（P2） | 旧方式のペインを作り直す前に、前面がペインのシェル（PR1 の D）**かつ**そのペインの端末にシェル以外のプロセスが無いことを確かめる（s11: Ctrl-Z で止まった CLI は `ps -t <tty>` に `T` で残る）。止まったジョブがあれば起動も kill もせず not-sent（`detail: 'suspended'`）。`fg` で同じ CLI に戻れる | §5.2 |
| (9) | unknown（P2） | 不明では**置換しない**。最初のキーの前の不明は not-sent、キーが届きうる段より後の不明・absent は indeterminate | §4.2、§5.1 |
| (10) | terminal ルート（P2） | **send と同じ「復旧して送る」に揃える**。absent は今どおり 404（自動で作らない）。dead は send と同じ `startSessionForSend` で起動し直してから送り、答えに `relaunched` を載せる。unknown は 409 で何もしない | §3.2、§3.3 |
| (11) | 応答の poll（P2） | dead への遷移では、**その世代（`pane_pid`）の最後の画面を 1 回回収して保存してから**止める。答えのキーは出さない。後継の世代（`pane_pid` が違う）には書かない | §3.2 |
| (12) | relaunched（P2） | 「置換した事実」と「会話を引き継いだか」を分ける: `relaunched: { replaced: true, conversation: 'resumed' \| 'new' }`。opencode V1 の `-s <id>` の再開は `resumed`、ほかは `new` | §6 |
| (13) | §12（P2） | 回答の入口と配送を分けた: 通常キー（`sendPromptAnswer`）・strict キー（`strict-prompt-answer-io.ts`）・API 回答（`respondByDecisionId`／`respondToSolePendingDecision` → エージェントの API）。それぞれの dead／absent／起動中／世代交代の扱い | §12 |
| (14) | PR の分け方と G-PR3 | PR2a（読み手・復旧・通知・terminal・poll）→ PR2b（起動の形）。**PR2a は G-PR3 の契約の scope（`src/app/api/worktrees/[id]/send/**`・`src/cli/types/**`）と重なるので G-PR3 のマージ後に直列**。`send-user-message.ts` はどちらの PR も触らない | §8 |

### 0.2 PR1 が入れるもの（PR2 の土台）

PR1 の実装（`../commandmate-issue-4300` の `0ca482d3d`）を読んで確かめた。改訂 2 の §0.2 にあった「`sendUserMessage` の早い拒否」は **PR1 には入っていない**（PR1 のコミットの本文: claude 以外の driver は `requireSession({relaunch:true})` で終わったツールを起動し直してから送るので、その前で断ると #2070 の復旧を止める、という理由）。この改訂で表を実装に合わせた。

| PR1 が入れるもの | 中身 | PR2 での扱い |
|---|---|---|
| `readPaneForeground(sessionName): 'shell' \| 'other' \| 'unknown'`（`src/lib/tmux/tmux.ts`） | 案 D。`display-message '#{pane_current_command}\t#{pane_pid}'`、名前がシェルのときだけ `ps -o tpgid= -p <pane_pid>`。shell は `tpgid == pane_pid` のとき | **旧方式のペイン（`pane_start_command` が新方式の形でない）にだけ使う**（§8.4）。新方式のペインに当てると、起動中（rc を読む `-c` のシェルが `pane_pid`、s6）と exec した非 exec ラッパー（表 3 の h）を `shell` と誤る |
| `recheckComposerBeforeInput`（`composer-clear.ts:263`）で `shell` なら `AGENT_NOT_IN_FOREGROUND_CODE` | 全 driver が本文の最初のキーの前に通る点 | 同じ点で `readPaneState` を読む（§4.2）。旧方式のペインでは PR1 の判定のまま |
| `SendAttemptReason` の `'agent-not-in-foreground'`、`classifySendFailure` | 500＋`not_sent` → exit 99 | 新方式の dead も同じ理由で返す。理由を 2 つ足す（`agent-foreground-unknown`・`agent-left-mid-send`、§4.3） |
| 表駆動テスト（`tests/unit/cli-tools/send-foreground-gate-4300.test.ts`、9 ツール）と陽性対照 | 前面がシェルで send-keys 0 回 | 残す（旧方式の守り）。新方式の行を足す（§7） |

PR1 の残りのリスク（判定の後に CLI が終わる競合、改行を含む本文の先頭行が本文の送信だけで実行されうる＝N3、#2070 の relaunch が旧方式のシェルへ起動行を打つ経路）は、PR1 の `changelog.d/4300.md` と PR 本文に明記する（PM の決定。この契約では changelog.d を書かない）。新方式に移ったペインではこの残りが消える（§11）。

### 0.3 止める点

- PR2 は起動（`src/lib/tmux/tmux.ts`・`src/lib/hooks/sources/launch-command.ts`・各 driver の起動）、復旧（`base.ts`・`claude-session.ts`・`opencode*.ts`・`codex.ts`）、読み手（§3 の表）、送信の最初の判定と Enter の後の確認（`composer-clear.ts`・`submit-verified-sender.ts`）、ルートと CLI の表示（`send/route.ts`・`terminal/route.ts`・`message-dispatch.ts`）で収まる。`src/lib/session/send-user-message.ts`・`src/lib/handoff`・`src/components/mem` には触らない。
- `src/lib/prompt-answer-sender.ts`・`strict-prompt-answer-io.ts`・`respond/structured-decision.ts`（回答の経路）は直さない（PM の決定 (c)。#4303 の範囲）。新方式のペインでは答えのキーもシェルに届かなくなる（§12）。

## 1. 今の経路と、claude だけがシェルへ打ち込む理由

### 1.1 経路（事実）

`commandmate send` → `postMessage`（`src/cli/commands/message-dispatch.ts:188`、`POST /api/worktrees/:id/send`）→ ルートが所有権を確かめ（`src/app/api/worktrees/[id]/send/route.ts:228`）、`settleSessionLaunch` の後に `cliTool.isRunning()` を読み（同 `:305`）、false なら `startSessionForSend`（`send-session-start.ts:93`）→ `sendUserMessage`（同 `:380`）。
claude 以外の driver は送る前に `requireSession(..., { relaunch: true })`（`src/lib/cli-tools/base.ts:814`）を通り、ツールが画面から終わったと読めれば同じペインで起動し直す（`relaunchIfToolExited`, `base.ts:780`、#2070）。
その後、全員が `sendMessageWithSubmitVerification`（`src/lib/cli-tools/submit-verified-sender.ts:688`）に入り、入力ロックの中で 再読（`recheckComposerBeforeInput`）→ 準備の再確認 → 入力欄を空ける → 本文 → Enter → 読み戻し → 再送。

### 1.2 根の原因（事実）

全 CLI の起動は、`createSession`（`src/lib/tmux/tmux.ts:438`。window 0 を `sleep` の仮置き `:373` で作り、`new-window -k`（`:523`）でログインシェルの対話シェルに置き換える）の後、そのシェルへ起動行を打つ（`typeLaunchLines`, `src/lib/cli-tools/launch-keys.ts:39`）。CLI はシェルの子なので、**CLI が終わるとペインには入力を読むシェルが残る**（`launch-screen.ts` の冒頭のコメントが「the pane falls back to the same shell prompt」と明記）。どの判定がすり抜けても、打った本文はシェルが読んで実行する。

### 1.3 claude だけが打ち込む理由（事実＋実測、改訂 1 と同じ）

claude は終了時に最後の画面（入力欄の `❯ ` 行と罫線）を残し、その下に `Resume this session with:`・`claude --resume <id>`・シェルのプロンプトを出す。`CLAUDE_PROMPT_PATTERN`（`src/lib/detection/tools/claude/patterns.ts:166`）が残った `❯ ` 行に当たり、liveness は画面全体に alive の型を当てる（`liveness-spec.ts:167-168`、`tool-liveness.ts:249-253`）ので、`isClaudeRunning`・`ensureHealthySession`・準備待ちが全部通る。codex・command-code が断ったのは偶然（表示が変われば打ち込みうる、見立て）。


## 2. ペインのコマンドとして起動する（決定 (1)〜(5)）

### 2.1 案の比較

| 案 | 中身 | 判定 | 理由 |
|---|---|---|---|
| D（PR1） | 名前がシェル かつ `tpgid == pane_pid` なら断る | 旧方式のペインの守りとして残す | 対話サブシェル・ジョブ制御無効で誤る（§9 表 1 の d・f）。exec した非 exec ラッパーと、新方式の起動中（rc を読む `-c` のシェル）を誤って断る（表 3 の h、表 4 の s6） |
| E（改訂 1） | 前面のグループにシェル名でないプロセスがいれば送る。lease＝`tpgid`、打鍵の各段で再判定 | 採らない（N1〜N4） | 「推測と打鍵の間にシェルがいる」ことが根で、端を足しても出続ける系統（改訂 2 の §2.1 と同じ） |
| F-2（改訂 2） | ログインシェルの対話シェルに起動行 `… exec env <cli>` を打つ | **採らない（新 P1）** | 起動と復旧のたびに、起動行を打つまでの間は**端末を読むシェルが前面にいる**。復旧の `respawn-pane` が出したシェルへ、送信中の古い本文・Enter が届きうる（`review-4300c.md` の 1）。印 `@cm_launch` を付けるまでの区間の誤分類（同 2）もこの形から来る |
| F-1a `sh -c`（PM の決定の形） | `new-window -k … /bin/sh -c '<代入> exec env <cli>'` | 形（ペインのコマンド・1 本・exec）は採る。**`sh` は採らない** | 実測で今の起動と環境が違う（表 4 の s2）。tmux のペインは tmux サーバーの大域の環境（その tmux サーバーを最初に起こした端末の環境）をそのまま受け取り、rc（`.zprofile`・`.zshrc`）を読まない。PATH にしか無い CLI（nvm・Homebrew・`~/.local/bin`）は `not found`、rc が export する API キー類も届かない |
| **F-1b ログインシェルの `-l -i -c`（採用）** | `new-window -k -c <cwd> <default-shell> -l -i -c '<代入> exec <cli> <引数>'`。復旧は `respawn-pane -c <cwd>`（`-k` なし）に同じ | **採用** | 今の起動（ログインシェルの対話シェルが rc を読んだ後に起動行を実行）と同じ rc を同じ順で読むので、PATH・rc の変数・代入（`CM_*`・秘密）が同じになる（表 4 の s1 と s3 が一致）。`-c` のシェルは文字列のコマンドだけを実行し、端末からコマンドを読まず、プロンプトも出さない。最後の `exec` で CLI に置き換わり、終わればペインは dead |

- 「対話のシェルを一度も出さない」の意味: 端末から行を読んでコマンドとして実行するシェルが、ペインのどの時点にもいないこと。`-i` は rc を読ませるため（zsh は対話のときだけ `.zshrc` を読む。bash の `.bashrc` も多くは `$-` に `i` が無いと戻る）で、`-c` があるのでシェルは端末を読まない。表 4 の s6: rc が 1 秒眠っている間に `touch <f>`＋Enter を送ると、文字は端末の echo で画面に出たが**実行されず**、起動した CLI（`cat`）がそのまま読んだ。
- `default-command`（利用者が tmux.conf で設定した場合）は、今は `new-window` にコマンドが無いので使われる。新方式は使わない（見立て: 使う利用者は少ない。`reattach-to-user-namespace -l zsh` のような古い macOS の設定。§10）。
- fish をログインシェルにした利用者: 今も同じ起動行（`NAME='v' cli`）を fish に打っているので、構文の前提は変わらない。`NAME='v' exec cli` を fish が受け付けるかは**未確認**（手元に fish が無い）。受け付けなければ起動は 127 で dead になり、失敗として返る（シェルは残らない、§5.3）。

### 2.2 起動のコマンドの形

今: シェルに打つ `clear 2>/dev/null; printf '\033[3J'; NAME='v' … <cli> <引数>`（`launch-screen.ts:44` の接頭辞＋`renderAgentLaunchCommand`, `src/lib/hooks/sources/launch-command.ts:276`）。
新: tmux の argv で `[<default-shell>, '-l', '-i', '-c', "NAME='v' … exec <cli> <引数>"]`。

- `-c` の文字列は `renderAgentLaunchCommand` の今の出力に `exec ` を挟んだもの（`${代入} exec ${plan.command}`）。後ろに足すフラグ（claude・antigravity の `--model`、command-code の起動フラグ、opencode の `-s <id>`）は今どおり行末に付く。計画を通らない vibe-local（`'vibe-local -y'`, `vibe-local.ts:143`）も同じ補助関数で `exec vibe-local -y`。
- 代入を `exec` の前に置く（`NAME='v' exec cmd`）。zsh・bash・sh で代入が CLI の環境に入る（表 3 の n、表 4 の s9 の bash）。秘密を含む代入（ロールの `OPENCODE_CONFIG_CONTENT="$(cat '<file>')"`、`src/lib/agent-roles/adapters.ts:245`）も今どおり。`#{pane_start_command}` と `ps` に見えるのは `$(cat '<file>')` の文字列で、秘密の値ではない（表 4 の s1・s4: `SECRET` は CLI に届き、start_command には `$(cat …)` だけ）。
- `exec` の後ろに `env` を置かない（決定 (3)）。`-c` のシェルは exec に失敗すると終わる（s9）。
- claude: 今は起動行の前に同じシェルで `unset CLAUDECODE` を打つ（`claude-session.ts:975`）。新方式は `-c` の文字列の先頭に `unset CLAUDECODE; ` を置く（同じシェルで先に走る。打たない）。`tmux set-environment -g -u CLAUDECODE`（`:974`）は今どおり（tmux の大域の環境に `CLAUDECODE` が残っているとペインに届くことを s1・s3 で確かめた）。
- 起動のコマンドの echo（#3180）: 打たないので echo が無い。`clear; printf '\033[3J'` の接頭辞は外す。respawn では前の CLI の画面を履歴に残したい（#2070 の「pane holds the transcript」）ので、消さないほうが今の non-claude の振る舞いに近い（表 4 の s6: respawn の後も前の出力が残った）。
- ガード（§7.4）: `new-window`／`respawn-pane` に起動のコマンドを渡す所は 1 つの関数（`spawnAgentPane`, `tmux.ts`、新設）だけで、その argv の最後の要素が `exec ` を含む。`typeLaunchLines` は残らない。

### 2.3 全 CLI の起動と、起動の前に要るもの

| CLI | 起動のコマンドを作る所 | 今の打つ所 → 新 | 起動の前に要るもの | 扱い |
|---|---|---|---|---|
| claude | `buildAgentLaunchCommandLine`（`claude-session.ts:938`）＋`--model`（`:948`） | `typeLaunchLines`（`:975`）→ `createLaunchPane`／respawn にコマンドを渡す | `unset CLAUDECODE` | `-c` の文字列の先頭に置く |
| codex | `buildAgentLaunchCommandLine`（`codex.ts:313`） | `codex.ts:343`、#2068 の打ち直し `:337` → 同上。#2068 は dead を読んで respawn（§5.1） | なし | |
| command-code | `buildCommandCodeLaunchCommand`（`command-code.ts:127`） | `command-code.ts:303` → 同上 | なし | |
| copilot | `buildAgentLaunchCommandLine`（`copilot.ts:513`） | `copilot.ts:533` → 同上 | なし | |
| antigravity | `buildAgentLaunchCommandLine`＋`--model`（`antigravity.ts:303-308`） | `antigravity.ts:331` → 同上 | なし | |
| opencode | `buildAgentLaunchCommandLine`＋`-s <id>`（`opencode.ts:470-490`） | `opencode.ts:504` → 同上 | なし | respawn のたびに `-s <id>` を読み直して新しいコマンドを作る（`respawn-pane` をコマンド無しで撃つと前の start_command を再実行するので必ず渡す） |
| opencode-v2 | `buildAgentLaunchCommandLine`（`opencode-v2.ts:300`） | `opencode-v2.ts:304`（前の段が cwd の再確認 `launchCwdRecheck`, `role-launch.ts:478`）→ 同上 | cwd の再確認 | 確認は `-c` に渡す直前の cwd（`new-window`／`respawn-pane` の `-c`）に当てる。今はペインの cwd を読む（打つ直前）。新方式ではペインがまだ無い（new-window）か dead（respawn）なので、渡す値そのものを確かめる |
| gemini | `buildAgentLaunchCommandLine`（`gemini.ts:164`） | `gemini.ts:178` → 同上 | なし | |
| vibe-local | 文字列 `'vibe-local -y'`＋`-m`・`--context-window`（`vibe-local.ts:143-157`） | `vibe-local.ts:164` → 同上 | なし | vibe-local 自体は bash スクリプトで最後に `exec python3` |

- 順序の変化: 今は `createLaunchPane`（`base.ts:926`、`createSession` の後に 0.x 秒待つ）→ 起動行を作る → 打つ。新方式は**起動のコマンドを先に作り**、`createSession` に渡す（`CreateSessionOptions.command`、無ければ今どおりログインシェル。`createSession` の起動以外の呼び手 `tmux.ts:1059`・transport はそのまま）。ロールの `gateLaunchRole`（`role-launch.ts:503`、「ペインを作る前に準備する」）は今どおり先に走る。
- 作り直しの失敗の予備（`respawnLoginShell`, `tmux.ts:382`）: `new-window -k` が失敗したとき、コマンドがあれば `respawn-pane -k`（仮置きの `sleep` を殺す。仮置きなので `-k` でよい）に同じコマンドと remain-on-exit をつなぐ。

### 2.4 remain-on-exit と方式の区別（決定 (4)(5)）

- remain-on-exit: `new-window -k -t <s>:0 -c <cwd> <argv…> \; set-option -p -t <s>:0 remain-on-exit on` を **1 回の tmux の呼び出し**で撃つ（`;` は tmux のコマンドの区切り。execFile の argv に `';'` を 1 要素で入れる）。respawn も同じ形（respawn は remain-on-exit を保つことを表 3 の a で確かめたが、同じ形にそろえる）。サーバ全体・`-g` には撃たない。
  - 理由（実測 s10）: すぐ終わるコマンド（`sh -c 'exit 3'`、起動の失敗の代わり）で、つなぐと 20/20 回 dead で残り（status 3）、別の呼び出しにすると 20/20 回セッションごと消えた。起動の失敗の画面と終了の状態を残すにはつなぐ必要がある。
  - CLI が終わった後: ペインは dead（`pane_dead=1`、`pane_dead_status`）で残り、最後の画面と `Pane is dead (status N, …)` が見える（表 3 の b2）。セッションは消えない。
- 方式の区別: `#{pane_start_command}` を読む（実測 s4）。
  - 旧方式（今の `createSession` の `new-window` にコマンド無し）: 空。予備の `respawnLoginShell`: `<shell> -l`。
  - 新方式: tmux が描く `<shell> -l -i -c "…"`。`respawn-pane` にコマンドを渡すと入れ替わる（s6 の後の値）。
  - 判定は 1 つの関数 `isExecLaunchStartCommand(startCommand)`（`<絶対パス> -l -i -c ` で始まる）。読めない・形違いは unknown。
- 印 `@cm_launch` を外した理由（P2: 印と世代）: 改訂 2 の印は CommandMate が「準備の確認の後」に書くので、書く前のサーバー終了・書く失敗・古い起動処理が後継のペインに書く、の 3 つの隙間があった。`pane_start_command` は tmux がペインを作る（respawn する）その時に入れるので、ペインと世代に結び付き、CommandMate が書く段が無い。
- 状態ごとの読み方（P2: 旧方式・起動途中・exec 済み・起動失敗の区別）:

| 状態 | `pane_dead` | start_command | 前面の名前 | 送信 |
|---|---|---|---|---|
| 旧方式 | 0 | 空か `<shell> -l` | 何でも | PR1 の D（§8.4） |
| 新方式・起動途中（rc を読んでいる） | 0 | 新方式 | シェルの名前（s6） | 端末を読むシェルはいない。準備の確認（入力欄）が通るまで送らない（今の準備待ち）。D は当てない |
| 新方式・exec 済み | 0 | 新方式 | CLI | 送る |
| 新方式・起動失敗 | 1 | 新方式 | シェルの名前（dead の `pane_current_command` は exec 前の名前が残る、s5・Q） | not-sent（§4.2）。起動の準備待ちは dead を読んだら待たずに失敗にし、最後の画面と状態を載せる（§5.3） |
| 新方式・CLI が終わった | 1 | 新方式 | 同上 | not-sent。次の send は復旧（§5） |
| absent | — | — | — | 今の「セッションが無い」 |
| unknown | — | — | — | not-sent（キーの前）／indeterminate（キーの後） |

- tmux の版: `set-option -p`・`pane_start_command`・`respawn-pane -c` は tmux 3.0 以降の見立て（リポジトリに最低版の宣言は無い）。実測は 3.5a。

### 2.5 外したもの（PM の決定）

| 外したもの | 改訂 2 での役目 | 改訂 3 で要らない理由 | 残るテスト・文書への影響 |
|---|---|---|---|
| 起動行を打つ経路 `typeLaunchLines`（`launch-keys.ts:39`、全 9 か所の呼び出し、`base.ts:914` の包み） | ログインシェルに起動行を打つ | 起動はペインのコマンドの argv。打つ先（端末を読むシェル）が無い | `launch-keys.ts` を消す。`tests/unit/session/launch-keys-input-lock-3975.test.ts`・`tests/unit/cli-tools/launch-lines-input-lock-3981.test.ts`・ガード `tests/unit/guards/pane-key-writers.test.ts` の `typeLaunchLines` の行（`:104-119`）の期待を変える（PR2b の契約で許す、§8.3） |
| 入力ロックの起動の番（#3975・#3981 の `exclusive` の番、`session-launch-flight.ts` の R2「起動のキーは起動元が持つロックに合流する」） | 送信のキーと起動行のキーが入力欄で混ざらない | 起動にキーが無い。送信のキーが起動中のペインに届いても、読むのは端末のバッファ→CLI で、シェルは実行しない（s6） | R1（ロックを持つ側は他の起動を待たない）は残す。R2 の説明と `session-launch-single-flight-3981.test.ts` の該当の期待を変える |
| 起動の印 `@cm_launch` の付け外し | 方式の区別 | `pane_start_command`（§2.4） | 無し（未実装） |
| 起動行の `clear; printf '\033[3J'` 接頭辞（#3180、`launch-screen.ts`） | 起動行の echo を消す | 打たないので echo が無い | `launch-screen.ts` を消す。起動行の文字列を固定するテスト（`git grep -l 'clear 2>/dev/null\|withLaunchScreenCleared\|LAUNCH_SCREEN_CLEAR_PREFIX' -- tests` で 14 ファイル）の期待を変える |
| `exec env` の `env` | bash の対話シェルの exec の失敗でシェルが残る | `-c` のシェルは失敗で終わる（s9） | 無し |
| codex #2068 の「同じペインに起動行を打ち直す」（`relaunchIntoSamePane`, `codex.ts:334`） | `Update now` の後にシェルへ打ち直す | codex が更新して終わるとペインは dead。dead を読んで respawn する（§5.1） | `codex.ts` の待ちの中で dead を読む |
| copilot・antigravity の「同じペインに打ち直す」（`copilot.ts:519`・`antigravity.ts:314` のコメント） | 同上 | 同上 | |

外さなかったもの: `beginAgentSession`（`agent-session-lifecycle.ts:77`）による入力の ticket の失効（`:114`）は残す。respawn の前に呼ぶので、古い送信の**まだ出していない**キーは出なくなる（既に出したキーは §4.5）。新しい仕組みは足していない。

## 3. 読み手（決定 (6)、N6）

### 3.1 状態と 2 つの述語

`readPaneState(sessionName): { state: 'alive' | 'dead' | 'absent' | 'unknown', launch: 'exec' | 'legacy' | null, panePid: number | null, deadStatus: number | null }`（`src/lib/tmux/tmux.ts`、新設）: `display-message -p -t <exact> '#{pane_dead}\t#{pane_pid}\t#{pane_dead_status}\t#{pane_start_command}'` を 1 回。セッションが無い → absent。`pane_dead=1` → dead。`0` → alive。tmux の時間切れ・形違い → unknown（`launch` も null）。

- `paneExists` = alive／dead（unknown は今の `hasSession` に落とす）。停止・片付けが読む。
- `agentAlive` = alive かつ（`launch === 'exec'`、または legacy で今の判定が alive）。`isRunning` がこれを返す。送信・状態・relay・wait が読む。
- 一括: `listSessions` の `-F`（`tmux.ts:341`）に `#{pane_dead}`・`#{pane_start_command}` を足す（s4: `list-sessions -F` で 1 回に読めた。start_command はタブを含みうるので最後の欄に置く）。ps は使わない。
- 注意（実測）: dead pane の `pane_current_command` は終わる前の値ではなくシェルの名前（`zsh`・`sh`）が残り、`pane_tty` は別のペインが使い回す（表 3 の a・l、表 4 の s5・Q）。dead の判定に名前と tty を使わない。

### 3.2 読み手の表

| 読み手 | 今 | 新方式 |
|---|---|---|
| 一覧・状態の poll（`worktree-status-helper.ts:868` → `probeToolSessionLiveness` → `probeSessionLiveness`） | 画面の liveness | 先に `pane_dead`（一括）。dead → `sessionStatusReason: 'exited'`（`:808` の語）。dead pane の画面には `❯` が残るので、**画面より先に読むことが必須**。起動中（`startingSince`）は今どおり飛ばす |
| `capture --json`（`current-output-builder.ts:925` の `isRunning`、`:958` の `session_not_running`） | claude 以外は `hasSession` | `isRunning`＝`agentAlive`。停止理由は dead → `exited`、absent → `session_not_running`。本文（最後の画面）は dead でも返す |
| `wait`（`wait.ts:635-645`、`:642` の `basis=session_gone`） | capture を読む | 一度動いて `isRunning=false` → `Completed (basis=session_gone)` exit 0（PM の決定 (b)）。一度も動いていない → NOT_STARTED |
| `kill-session`（`kill-session/route.ts:136-138`） | `isRunning` が false ならスキップ | `paneExists`。dead pane も kill する。dead のときは各 driver の `requestExit`（終了のキー）を飛ばし、すぐ `kill-session` |
| `session-cleanup`（`session-cleanup.ts:264`） | 同じ | `paneExists` |
| `terminal` ルート（`terminal/route.ts:170` の `isRunning` → 404、`:220` の `driver.sendMessage`） | `isRunning` が false で 404。claude 以外は driver の中で #2070 の relaunch が走りうる | **send と同じ「復旧して送る」に揃える（§3.3）** |
| relay（`relay-readiness.ts:84`） | `isRunning` | `agentAlive`。dead → `session_stopped` で保留（作り直さない、今どおり） |
| 送信ルート（`send/route.ts:259`・`:305`） | `isRunning` | dead → `isRunning=false` → `startSessionForSend`（`send-session-start.ts:93`）→ driver が respawn（§5）。`refuseModelOnRunningSession`（`:259`）は `agentAlive` |
| auto-yes の poller（`auto-yes-poller.ts:1029` の `captureObservedFrame`） | 画面を直接読む | tick の最初に `readPaneState`。dead・unknown なら答えない・数えない。読まなくても答えのキーは dead pane に捨てられる（表 3 の b）ので安全の穴ではないが、「答えた」の記録の誤りを防ぐ |
| 応答の poll（`response-checker.ts:1687` の `isSessionRunning` → false なら `stopPolling` して戻る、`cli-session.ts:101` は `sessionExists`） | セッションの有無 | **dead への遷移では、その世代の最後の画面を 1 回回収してから止める**（P2）。tick の最初に `readPaneState`: alive → 今どおり。dead かつ `panePid` が poll を始めた世代と同じ → 画面を 1 回 capture して保存の経路（`recordCompletedResponse`）に通し、`stopPolling`。dead で `panePid` が違う（既に後継が起動して死んだ）、または absent → 何も書かずに `stopPolling`。答えのキーは出さない（auto-yes は上の行で飛ぶ）。世代は poll の開始時に控えた `panePid` で見る |
| UI の端末の生の入力（`direct-input`・`special-keys`・WebSocket の `terminal_input`, `ws-server.ts:1151`） | 生のキー | 変えない。dead pane へのキーは tmux が捨てる。UI は状態 `exited` を表示する |

### 3.3 terminal ルートの契約（P2）

入口の契約を send に揃える: **「セッションが無ければ断る。CLI が終わっていれば起動し直してから送る」**。

| 状態 | 今 | 新 |
|---|---|---|
| absent | 404（自動で作らない、`:168` のコメント） | 404（同じ） |
| dead | `isRunning=false` で 404（claude 以外も） | `startSessionForSend`（send と同じ関数、モデルの指定なし）→ `driver.sendMessage`。答えに `relaunched`（§6）。起動の失敗は send と同じ `answerSessionStartFailure` |
| alive | `driver.sendMessage`（claude 以外は中の #2070 で relaunch しうる） | 同じ。中の relaunch は `readPaneState` が alive なら何もしない（§5.1） |
| unknown | — | 409（`code: 'agent_state_unknown'`）。起動も打鍵もしない |
| 旧方式・画面が終了 | claude 以外は driver の中で同じシェルへ起動行を打つ | §5.2 の旧方式の作り直し（止まったジョブがあれば断る） |

理由: terminal ルートは driver の `sendMessage` を呼ぶので、claude 以外は今も driver の中で起動し直している（`base.ts:833`）。「dead なら断る」にすると、ルートの確認の後に CLI が終わった場合に driver が起動し直すので守れない（`review-4300c.md` の 5）。起動し直しを入口で明示し、send と同じ関数・同じ通知を通す。

## 4. 送信と Ctrl-Z（決定 (7)(9)）

### 4.1 なぜ各段の判定が要らなくなるか

新方式のペインで端末の入力を読むのは、起動中は**誰も読まない**（`-c` のシェルは文字列のコマンドだけを実行する。キーは端末のバッファに溜まる）、CLI が生きている間は CLI（またはその exec の先）、終わった後は tmux が入力を捨てる（dead pane）。復旧の respawn も CLI を直接起動するので、この 3 つ以外の区間が無い。判定と打鍵の間に CLI が終わっても、復旧が挟まっても、本文・改行・Enter は**シェルでは実行されない**（表 3 の b・e2、表 4 の s5・s6）。だから改訂 1 の「打鍵の各段の直前に前面を確かめる」は安全のためには要らない。残るのは「届いたか」の正しさだけ（§4.2・§4.5）。

### 4.2 送信の判定（新方式のペイン）

- 最初のキーの前（PR1 と同じ `recheckComposerBeforeInput`）: `readPaneState` が
  - `dead` → not-sent（`agent-not-in-foreground`、PR1 と同じ理由、`detail: 'exited'`）。
  - `absent` → 今の「セッションが無い」。
  - `unknown` → not-sent（`agent-foreground-unknown`、新）。**キーはまだ 1 つも出ていない**ので not-sent と言える。
  - `alive` → `panePid` を控える。旧方式（`launch === 'legacy'`）なら PR1 の D をそのまま当てる。
- Enter（と再送）の後の読み戻しで `submitted` と言う前に、もう一度 `readPaneState`（P2: unknown／absent の扱い）:
  - `alive` かつ `panePid` が控えと同じ → 今どおり読み戻しの結果。
  - `dead`、`panePid` が控えと違う（respawn された）、`absent`、`unknown` → **indeterminate**（`agent-left-mid-send`、新。unknown のときは `detail: 'unreadable'`）。キーが届きうる段より後なので not-sent には戻さない（CLI が本文を読んだ後に終わった・読めない、を区別できない）。同じ CLI だと確かめられないので `submitted` とも言わない。
- 本文の途中（空けの反復・撤回・copilot の一括送信）では読まない（N4。安全のためには要らない §4.1。正しさは最後の確認が拾う）。
- 費用: 1 回の送信で `display-message` が 2 回。ps は使わない（旧方式のペインだけ PR1 の ps が 1 回）。

### 4.3 理由と exit code

| 状態・段 | state | reason | 答え |
|---|---|---|---|
| dead（最初のキーの前） | not-sent | `agent-not-in-foreground`（PR1）、detail `exited` | 500＋`not_sent` → exit 99 |
| unknown（最初のキーの前） | not-sent | `agent-foreground-unknown`（新） | 同じ |
| 旧方式で止まったジョブ（§5.2、復旧の判断で） | not-sent | `agent-not-in-foreground`、detail `suspended` | 同じ。案内: 「ペインで `fg` するか、`commandmate instances <id> kill <instance>` してから送り直す」 |
| Enter の後に dead・respawn・absent・unknown | indeterminate | `agent-left-mid-send`（新） | 500＋`unknown`。再送してよいとは言わない。案内: 「本文の後に CLI が終わった／入れ替わった。届いたかは capture の最後の画面で確かめる」 |

新しい exit 番号は作らない。

### 4.4 Ctrl-Z（実測 e・f・g・s8）

- 新方式では CLI がペインのプロセス（`pane_pid`）で、端末のセッションリーダー・前面のグループのリーダー（`Ss+`、s3 の ps: pid = pgid = tpgid = pane_pid）。親は tmux なので、そのグループは**孤立したプロセスグループ**で、端末からの SIGTSTP は捨てられる（表 3 の e・f、表 4 の s8: ペインのコマンドとして起動した `cat` も `Ss+` のまま、`^Z` が出ただけで次の行を読んだ）。
- よって新方式では「Ctrl-Z で止まった CLI に送る／作り直す」状況は起きない。利用者が Ctrl-Z を押しても CLI は止まらない。CLI が生のモードで Ctrl-Z を自分の機能に使う（自分に SIGTSTP を送る）場合も、孤立したグループでは止まらない（表 3 の f の自分への `kill -TSTP`）。**本物の CLI では未確認**（§10）。CLI が自分でジョブ制御をして子を別のグループで前面に出す場合、その子は止まりうるが、CLI 自身は生きていてペインは alive で、届く先はシェルではない（§10）。
- 外から SIGSTOP（通常の操作ではない）: 表 3 の g は未解明（未確認）。安全の穴ではない。

### 4.5 送信中の復旧（新 P1）

`review-4300c.md` の反例: 「A が alive を確かめて送信中 → CLI 終了 → B が復旧で respawn → A の本文・Enter が新しいシェルへ到着」。

- 新方式では B の respawn が出すのは `-c` のシェルで、そのシェルは端末を読まず、rc の後に exec で CLI になる。A のキーが届く先は時刻によって次のどれかで、**どれもシェルの実行ではない**:

| A のキーが着く時刻 | 届く先 | 実測 |
|---|---|---|
| CLI が終わってから B の respawn まで | dead pane。tmux が捨てる（exit 0） | 表 3 の b、表 4 の s5 |
| respawn の後、rc を読んでいる間 | 端末のバッファ。画面に echo され、起動した CLI が読む | s6（改行入りの `touch <f>`＋Enter でファイルは作られない） |
| CLI の起動の後 | 新しい CLI の入力欄 | s6 の続き（`cat` が読んだ） |

- 正しさの面: A の本文が新しい CLI の入力欄に入り、A の Enter が新しい会話へ送りうる。A は Enter の後の確認（§4.2）で `panePid` の変化を読み indeterminate を返す。B は respawn の前に `beginAgentSession` で ticket を失効させるので、A の**まだ出していない**キー（本文の後半・Enter）は出ない（送信側が本文・Enter の前に ticket を確かめる今の流れ、`submit-verified-sender.ts:775`・`:808` の `assertInputOwner`）。B 自身の本文は入力ロック（A の後）で入り、最初に入力欄を空ける（`clearComposerBeforeSend`）ので A の残りは B の本文と混ざらない。
- 復旧を入力ロックの中で行う形（改訂 2）は採らない（PM の決定: 起動の番を外す）。上の残り（A の一部のキーが新しい CLI に着く）は安全の穴ではなく、A は indeterminate で返るので「送った」とは言わない。
- テスト（§7.2）: A を「本文の直前」「本文の後」「Enter の直前」で止め、B の復旧（dead → respawn）を差す。陽性対照: 改訂 2 の形（ログインシェルの対話シェルに起動行を打つ）では、本文に改行があるとファイルが作られる。陰性: 新方式では 3 つとも作られず、A は indeterminate、B は 1 回だけ起動。回答の矢印・文字・Enter（§12）も同じ順序で 1 本ずつ。

## 5. 既存の復旧（N5、P2 の Ctrl-Z・unknown）

### 5.1 新方式のペイン

すべての「再利用か起動か」の判断は、**最初と最後で同じ `readPaneState` を読む**（画面で終了を判定しない）。

| 復旧 | 場所 | 新方式 |
|---|---|---|
| #2070 の send 前の relaunch | `relaunchIfToolExited`（`base.ts:780`）が `isToolLive`（画面）を読む、`requireSession`（`:814`、relaunch は `:833`） | alive → 何もしない（画面を読まない）。dead → `startSession` へ。**unknown → 何もしない**（置換しない。続く最初のキーの前の判定が not-sent で返す）。absent → 今どおり「セッションが無い」 |
| 起動の再利用の判断 | `resolveLaunchPane` の `isToolLive(…, { confirm: true })`（`base.ts:897`） | 同じ `readPaneState`。alive → 再利用、dead → `beginAgentSession` → `respawn-pane -t <pane> -c <cwd> <起動のコマンド> \; set-option -p … remain-on-exit on`（`-k` なし）。dead から alive に変わっていた（別の要求が先に起動した）なら tmux が respawn を断るので（s7）、再読して再利用。unknown → 起動を断る（`SessionStartUnavailableError` と同じ扱いで not-sent） |
| opencode V1 の再利用 | `opencode.ts:393` | 同じ。dead → respawn。`-s <id>` を読み直して新しいコマンドで（§2.3） |
| opencode V2 の再利用 | `opencode-v2.ts:266`（dead のときは `releaseOpencodeV2Server` してから） | 同じ |
| codex の #2068（`Update now` の後） | `relaunchIntoSamePane`（`codex.ts:334-339`） | codex が更新して終わるとペインは dead。準備待ちの中で dead を読んだら `beginAgentSession` → respawn（打ち直さない） |
| copilot・antigravity の同じペインへの起動し直し | `createLaunchPane` を飛ばして打つ（`copilot.ts:519`・`antigravity.ts:314`） | `resolveLaunchPane` の結果に `respawn` を持たせ、driver は共通の `spawnAgentPane` を呼ぶだけ |
| claude の `ensureHealthySession` | `claude-session.ts:708`。不健康なら kill（`:712`）して作り直す（`:884-893`） | dead → 不健康と同じ経路（kill して作り直す。claude は今も作り直すので形を変えない）。alive → 今の画面の健康の判定（終了の判定には使わない）。unknown → 作り直さない（起動を断る） |
| ルートの `startSessionForSend` | `send/route.ts:305`、`send-session-start.ts:93` | dead で `isRunning=false` → 今どおり呼ぶ。中で上の driver の経路 |
| タイマー・relay | `timer-manager.ts:110`・`relay-delivery.ts:611` | タイマー: non-claude は driver の relaunch（今どおり）、claude は断る（今どおり）。relay は保留（今どおり） |

- respawn は履歴を消さない（表 3 の a、表 4 の s6）。#1624 の履歴の上限は同じペインなので保たれる。#2958（rc の途中でシェルを殺す）は、dead pane にはシェルがいないので当たらない。新規作成の仮置き（`sleep`）も今どおり。

### 5.2 旧方式のペイン（P2: Ctrl-Z と requireSession の順）

旧方式のペイン（今 CommandMate で動いているセッション全部）は、PR2b の後も強制の再起動をしないので残る（§8.4）。旧方式で #2070 の relaunch が起動行を打つ経路は、`typeLaunchLines` を外すので**同じシェルに打つことはしない**。代わりに次の順で判断する。

1. 画面が終了と読める（今の `isToolLive` が false）。そうでなければ今どおり何もしない。
2. PR1 の `readPaneForeground` が `shell`（ペインのシェルが前面）。`other` → 置換しない（画面の判定より前面の事実を取る。CLI が前面にいる）。`unknown` → 置換しない、not-sent（`agent-foreground-unknown`）。
3. **そのペインの端末にシェル以外のプロセスが無い**: `ps -o pid=,stat= -t <pane_tty>`（PR1 と同じ ps の 1 回）で `pane_pid` 以外の行が無いこと。実測 s11: Ctrl-Z で止めた `sleep` は `T` で残り、前面の名前は `zsh`、`tpgid = pane_pid`（D は `shell` と読む）。ここで止まったジョブ・背景のジョブがあれば、**起動も kill もせず** not-sent（`agent-not-in-foreground`、`detail: 'suspended'`）。利用者は `fg` で同じ CLI に戻れる（s11 の `fg` で前面が `sleep` に戻った）。
4. 1〜3 が全部通ったら（PR2b から。PR2a の間は今どおり同じシェルに起動行を打つ、§8.3）`beginAgentSession` → `respawn-pane -k -t <pane> -c <cwd> <起動のコマンド> \; set-option -p … remain-on-exit on`（`-k` は「何も動いていない旧方式のシェル」を消すためだけ。3 で確かめた）。ペインは同じなので前の画面は履歴に残る（今の #2070 と同じ）。この時点で新方式に移る。

- claude の旧方式: `ensureHealthySession` が kill する前に 2・3 を同じく確かめる（止まった claude の会話を kill しない）。
- 2 と 3 の間、3 と 4 の間に利用者がシェルで何かを起動する競合は残る（旧方式の残り、§10）。`-k` で消えるのはそのとき起動されたもの。
- 旧方式の通常の終了（止まったジョブなし）は今どおり復旧する（陽性対照）。止まったジョブありは断る（陰性対照）。

### 5.3 起動の失敗

- 起動の途中で CLI が終わった（認証の失敗・PATH に無い・rc の失敗）: ペインは dead で残る（s9・s10）。各 driver の準備待ちが `pane_dead=1` を読めたら時間切れを待たずに失敗にし、最後の画面の数行と `pane_dead_status` をエラーに載せる（今は 60 秒ほど待って exit 99）。
- 準備待ちが時間切れで失敗し、ペインが alive のまま（CLI が入力欄を出さない・rc が別の対話シェルを `exec` した、§10）: 新方式のペインは kill して失敗を返す（端末を読むシェルが残っている可能性を残さない。最後の画面はエラーに載せる）。

## 6. relaunched の通知（N7、P2: 置換と会話の継続を分ける）

- 起動の結果 `LaunchOutcome = { kind: 'created' | 'reused' | 'replaced' | 'joined', conversation: 'new' | 'resumed' | null }` を起動の印（`session-launch-flight.ts`）に残す。`replaced` は「入る前のペインが dead（新方式）、または旧方式で終了と判定されて作り直した（§5.2・claude の作り直し）」とき。`conversation` は `replaced`／`created` のときに driver が入れる: opencode V1 が `-s <id>` で起動した（`opencode.ts:486-497`、`resumeSessionId !== null`）→ `resumed`、ほか → `new`。ほかの CLI に CommandMate からの再開は無い（`--resume` を起動のコマンドに付ける所は無い、`git grep` で確かめた）。
- ルートは送信の後（成功・失敗とも）に `takeLaunchReplacedNotice({ worktreeId, instanceId })` で読む（`send/route.ts:462` の `takeOpencodeResumeNotice` と同じ形）。`send-user-message.ts` は変えない。terminal ルート（§3.3）も同じ関数で読む。
- 答え: `relaunched: { replaced: true, conversation: 'new' | 'resumed', exitStatus: number | null }`（置換が無ければ `relaunched` を載せない）。成功（201）にも失敗（500、not_sent／indeterminate）にも載せる。`joined` は合流先の結果を見る。opencode V1 の再開は今の `opencodeResume`（セッション id）とも一致させる（両方があるときは同じ id）。
- CLI（`message-dispatch.ts`）は exit の前に stderr に 2 行まで:
  - 1 行目（置換の事実）: `Note: the previous <tool> process in <session> had exited (status <n>); a new process was started (Issue #4300).`
  - 2 行目（会話）: `resumed` → `The conversation was resumed (opencode session <id>).`、`new` → `The previous conversation was not carried over.`。claude で前の画面から `claude --resume <id>` が読めたら `Previous conversation: claude --resume <id>` を続ける（§6.1）。
- **復旧の変更（§5）と同じ PR（PR2a）に入れる**。PR2a 単体で、置換して成功・置換後に失敗（not_sent／indeterminate）・並行の 2 本・初回起動（なし）・再利用（なし）と、`conversation` の 3 つの対照（opencode V1 の同じ id の再開 → `resumed`、opencode V1 で id が無い → `new`、claude の作り直し → `new`）を検証する（§7.3）。

### 6.1 `Resume this session with:` と利用者への影響

| 場面 | 今 | 新方式 |
|---|---|---|
| CLI が終わった直後の capture・UI の端末 | 最後の画面と Resume の行、シェルのプロンプト | 最後の画面と Resume の行、その下に `Pane is dead (status 0, <時刻>)`（表 3 の b2）。シェルのプロンプトは無い |
| ペインで続きを打つ | シェルで `claude --resume <id>` を打てる | **できない**（dead pane は入力を捨てる）。`commandmate send` で新しいプロセスとして起動し直すか、`commandmate stop` してから起動する |
| 次の送信で起動し直した後 | claude は kill して作り直す（Resume の行は消える）。non-claude は同じペインに打つ（履歴に残る） | claude は同じ（relaunched の 2 行目に `claude --resume <id>` を添える）。non-claude は respawn で履歴に残る |
| 運用の手当て（`pane-ok.sh`） | 末尾の Resume・シェルのプロンプトを見る | dead pane は `Pane is dead` の行で分かる。手当ての版を足す（運用、この設計の外） |

続きの会話を CommandMate から再開する（`--resume` を起動のコマンドに付ける）機能はこの Issue では作らない（§10）。

## 7. テストの設計

### 7.1 状態の単体（`tests/unit/tmux/pane-state-4300.test.ts`）

`execFile` の mock に `display-message` の出力を与える: `0\t<pid>\t\t/bin/zsh -l -i -c "…"` → alive・exec／`0\t<pid>\t\t` → alive・legacy／`0\t<pid>\t\t/bin/zsh -l` → alive・legacy／`1\t<pid>\t127\t…` → dead・status 127／`can't find session` → absent／時間切れ・形違い → unknown。`isExecLaunchStartCommand` は表 4 の s4 の実際の文字列で。一括（`listSessions`）の読み取り。

### 7.2 送信（PR1 の表駆動に足す）

- `CLI_TOOL_IDS` の全員で、準備条件を満たした同じ画面に対し状態だけを変える: alive・exec → 送る（陽性対照: 判定を外すと dead でも各 CLI で send-keys が出て、claude は `submitted` と誤る）／dead → send-keys・paste-buffer・load-buffer 0 回、`agent-not-in-foreground`（`exited`）／unknown → 0 回、`agent-foreground-unknown`。
- Enter の後の確認（P2: unknown／absent）: 読み戻しの直前に dead／`panePid` の変化／absent／unknown を注入 → indeterminate（`agent-left-mid-send`）、not_sent に戻らない。対照: alive のまま → `submitted`。
- 起動中（alive・exec、前面の名前が `zsh`）: D を呼ばない（PR1 の ps が 0 回）。旧方式（legacy）: PR1 の判定がそのまま効く（PR1 のテストを変えない）。
- 実 tmux（`-L` の私設ソケット、`process.env.TMUX` を私設サーバへ向け、向いていることを assert）の結合テスト（`tests/integration/send-exec-launch-4300.test.ts`）:
  - dead pane へ改行入りの本文を送り、ファイルが作られないこと（表 3 の b・e2）。
  - **新 P1**: 代わりの CLI（`exec cat`）を `-l -i -c` で起動し、送信 A を本文の直前・本文の後・Enter の直前で止め（sender の hook で待たせる）、CLI を kill → B の復旧（`respawn-pane` にコマンド）を差してから A を続ける。3 つとも改行入りの本文でファイルが作られず、A は indeterminate、B の起動は 1 回。陽性対照: 同じ順序を「ログインシェル＋起動行を打つ」形で行うとファイルが作られる。

### 7.3 復旧と relaunched（PR2a）

- `base.ts`: alive → 画面を読まず再利用／dead → `respawn-pane`（`-k` なし）にコマンドと remain-on-exit が 1 回の呼び出しで渡る／unknown → 置換しない（`startSession` 0 回）・最初のキーの前で not-sent／absent → 「セッションが無い」。
- 最初の判定と最後の再利用が同じ `readPaneState` を読むこと（N5）: 終了の画面なのに alive・exec → 再利用、`❯` が残る画面なのに dead → respawn（claude の誤りの再現の陽性対照）。
- 旧方式（P2: Ctrl-Z の順）: 画面が終了・D が shell・端末に他のプロセス無し → `respawn-pane -k` で置換（陽性）／止まったジョブあり（ps の fixture に `T` の行）→ 起動 0 回・kill 0 回・not-sent（`suspended`）／D が other → 置換しない／D が unknown → 置換しない。claude の `ensureHealthySession` も同じ 4 本。実 tmux の結合テストで、止めた `sleep` が送信の後も `T` で残り、`fg` で前面に戻ること。
- opencode V1/V2・codex #2068・claude: dead → それぞれの起動し直し、alive → 再利用。opencode V1 の respawn が新しい `-s <id>` のコマンドを渡す（コマンド無しの `respawn-pane` を撃たない）。
- `relaunched`: 初回起動 → なし／再利用 → なし／置換して成功 → `replaced`／置換後に失敗 → `replaced` と not_sent・indeterminate／並行 send の 2 本 → 両方 `replaced` で起動は 1 回／`conversation`: opencode V1 の同じ id の再開 → `resumed`（id が `opencodeResume` と同じ）、opencode V1 で id 無し → `new`、claude の作り直し → `new`。stderr の行は `message-dispatch` のテストで成功と exit 99 の両方、claude の `--resume` の行は画面に id があるときだけ。

### 7.4 読み手とガード

- 状態: `worktree-status-helper` と `current-output-builder` の実際の応答を全 CLI で: dead → `isRunning=false`・`exited`／absent → `session_not_running`／alive → 今どおり。
- 停止・片付け（N6 の対照）: 旧方式のシェルのペイン（今どおり）、dead pane（kill する、終了のキーを打たない）、セッション無し（スキップ）。
- terminal ルート（P2）: dead → `startSessionForSend` 1 回・本文の打鍵 1 回・200 と `relaunched`／absent → 404・起動 0 回・打鍵 0 回／alive → 起動 0 回・打鍵 1 回・`relaunched` なし／unknown → 409・起動 0 回・打鍵 0 回。
- 応答の poll（P2）: tick の間に「最後の出力を描いてから終わる」を差す（fixture: 前の tick は応答の途中、次の tick で dead・同じ `panePid`）→ 保存 1 回、答えのキー 0 回、`stopPolling`。対照: dead で `panePid` が違う → 保存 0 回／absent → 保存 0 回／alive → 今どおり。
- `wait`: 動いた後の dead → `session_gone` exit 0、一度も動いていない → NOT_STARTED。
- auto-yes: dead pane の画面にダイアログがあっても答えない。
- ガード（`tests/unit/guards/`）: (i) `new-window`／`respawn-pane` に起動のコマンドを渡す所は `spawnAgentPane` だけで、argv の最後が `exec ` を含み、同じ呼び出しに `remain-on-exit on` が続く、(ii) `src/lib` に `typeLaunchLines`・起動行の `sendKeys` が残らない、(iii) `isRunning(` を読むファイルの一覧を固定し、`hasSession` を「動いている」と読む所が増えたら見直しを強いる、(iv) `respawn-pane -k` は `respawnLoginShell`（`tmux.ts:397`）・仮置きの予備・§5.2 の旧方式の置換（端末のプロセスの確認の後）の 3 か所だけ。
- 既存のテスト: tmux を部分的に mock したテストが `readPaneState` の unknown で断るようになって落ちる場合は、共通の mock（`tests/helpers`）に alive・exec を返す既定を足す。起動行を固定するテスト・`typeLaunchLines` と入力ロックの起動の番を固定するテスト（§2.5）の期待の変更は PR2b の契約で許す（§8.3）。

## 8. PR2 の範囲

### 8.1 書くファイル（予定）

- 起動: `src/lib/tmux/tmux.ts`（`createSession` の `command`、`spawnAgentPane`（new-window／respawn-pane＋remain-on-exit を 1 回の呼び出しで）、`readPaneState`、`isExecLaunchStartCommand`、`listSessions` の `-F`）、`src/lib/hooks/sources/launch-command.ts`（`renderAgentLaunchCommand` に `exec`、argv を作る補助）、各 driver の起動（`claude-session.ts`・`codex.ts`・`command-code.ts`・`copilot.ts`・`antigravity.ts`・`opencode.ts`・`opencode-v2.ts`・`gemini.ts`・`vibe-local.ts`）、`src/lib/session/role-launch.ts`（cwd の再確認を渡す値に当てる）、`src/lib/session/session-launch-flight.ts`（R2 の説明、`LaunchOutcome`）
- 消す: `src/lib/cli-tools/launch-keys.ts`、`src/lib/session/launch-screen.ts`、`base.ts:914` の `typeLaunchLines`
- 復旧: `src/lib/cli-tools/base.ts`（`relaunchIfToolExited`・`resolveLaunchPane`・`createLaunchPane`・旧方式の置換）、`claude-session.ts`（`isClaudeRunning`・`ensureHealthySession`）、`opencode.ts`・`opencode-v2.ts`・`codex.ts`
- 送信: `src/lib/session/composer-clear.ts`（最初の判定）、`src/lib/cli-tools/submit-verified-sender.ts`（Enter の後の確認）、`src/lib/session/send-attempt-types.ts`・`send-attempt-state.ts`（理由 2 つ）
- 読み手: `src/lib/session/worktree-status-helper.ts`、`src/lib/cli-tools/session-liveness.ts`、`src/lib/session/current-output-builder.ts`、`src/app/api/worktrees/[id]/kill-session/route.ts`、`src/lib/session-cleanup.ts`、`src/lib/auto-yes-poller.ts`、`src/lib/session/cli-session.ts`、`src/lib/polling/response-checker.ts`（最後の画面の回収）
- ルートと CLI: `src/app/api/worktrees/[id]/send/route.ts`（`relaunched`）、`send-failure.ts`、`src/app/api/worktrees/[id]/terminal/route.ts`（§3.3）、`src/cli/commands/message-dispatch.ts`（stderr の行）、`src/cli/types/`（答えの型）
- 文書: `docs/user-guide/cli-operations-guide.md` と `docs/en/user-guide/cli-operations-guide.md`（dead pane・relaunched・wait の `session_gone`・terminal の dead）、`changelog.d/4300.md`（PR1 の断片に追記）、module-reference の断片
- テスト: §7 の各ファイル、PR1 の表駆動・ガード、§2.5 の期待を変えるテスト

### 8.2 G-PR3 との重なり

G-PR3 の契約（`workspace/orchestration/runs/2026-11-09/contract-4227-pr3.yaml`・`contract-4227-pr3b.yaml`）の scope を読んで比べた。

| ファイル | PR1 | PR2a | PR2b | G-PR3 の scope |
|---|---|---|---|---|
| `src/lib/session/send-user-message.ts` | 触らない（§0.2） | 触らない | 触らない | **含む** |
| `src/app/api/worktrees/[id]/send/**`（`route.ts`・`send-failure.ts`・`send-session-start.ts`） | 触らない | **書く**（`relaunched`） | 触らない | **含む** |
| `src/cli/types/**` | 触らない | **書く**（答えの型） | 触らない | **含む**（pr3b） |
| `src/types/**`・`src/hooks/**`・`src/components/worktree/**`・`src/lib/handoff/**` | 触らない | 触らない | 触らない | 含む |
| ほか（`src/lib/tmux`・`src/lib/cli-tools`・`src/lib/session` の上以外・`terminal/route.ts`・`message-dispatch.ts`） | `composer-clear.ts`・`send-attempt-*`・`tmux.ts` | 書く | 書く | 含まない |

- **`send-user-message.ts` は重ならない**（改訂 2 と同じ）。
- **PR2a は scope で重なる**（`send/**`・`src/cli/types/**`）。G-PR3 が実際にこれらを書くかは契約の scope だけでは分からないので、**PR2a は G-PR3 のマージ後に直列**にする（PM の指示「重なるなら直列」）。`relaunched` を `send/route.ts` の外で答えに載せる道は無い（送信の後に読む所がルート）ので、PR2a から外せない（N7 で通知と復旧は同じ PR）。
- PR2b は G-PR3 と重ならない。ただし PR2a の後なので、結果として G-PR3 の後。
- PR1 は G-PR3 と重ならない（並行でよい、今の進め方どおり）。

### 8.3 PR の分け方（推奨）

| PR | 中身 | 単体での振る舞い | 依存 |
|---|---|---|---|
| **PR2a 読み手・復旧・通知** | `readPaneState`（方式の区別を含む）・`paneExists`／`agentAlive`、§3 の読み手全部（terminal・応答の poll を含む）、§5 の復旧（dead なら respawn、旧方式の置換の順、unknown で置換しない）、§6 の `relaunched`、§4.2 の判定と Enter の後の確認、`LaunchOutcome` | dead pane はまだ通常の起動では生まれない（PR2b まで起動の形は今のまま）。PR2a の respawn は dead pane（テストで作るもの）だけに効く。**旧方式の #2070 の relaunch は PR2a から §5.2 の 1〜3 の確認を通る**（止まったジョブ・不明では置換しない）。確認の後の起動は PR2a では今どおり同じシェルに起動行を打ち、PR2b で §5.2 の 4（`respawn-pane -k` にコマンド）に替える。通知もここで付く（N7） | PR1 のマージ後、**G-PR3 のマージ後** |
| **PR2b 起動の形** | 新規の起動を `createSession` の `command` へ（§2.2・§2.3）、remain-on-exit をつなぐ（§2.4）、`typeLaunchLines`・`launch-screen.ts`・起動の番の R2 を外す（§2.5）、起動の途中の dead を早く失敗にする（§5.3）、起動行を固定するテストの期待の更新、文書 | これで新しいセッションは全部新方式 | PR2a のマージ後 |

分ける理由: (i) どの時点でも「dead pane を読めない読み手」が無い（PR2a が先に読めるようにし、PR2b が初めて新規の起動で dead pane を生む）。(ii) 復旧の変更と通知が同じ PR（N7）。(iii) PR2b は起動の形を変えるので、起動行を固定している既存のテスト（`git grep -l 'clear 2>/dev/null\|withLaunchScreenCleared\|LAUNCH_SCREEN_CLEAR_PREFIX' -- tests` で 14 ファイル、`renderAgentLaunchCommand\|buildAgentLaunchCommandLine` で 28 ファイル、`typeLaunchLines\|launch-keys` で 5 ファイル）の期待を変える。**期待を変えることを PR2b の契約で許す**（作業ルールの「既存の期待を変えない」の例外。PM の決定が要る）。`session-relaunch-2070` の「同じシェルに起動行を打つ」期待は PR2a では変えず（確認を足すだけ）、PR2b の契約で変える。

### 8.4 既存のセッションの移行

- 強制の再起動はしない（稼働中の会話を捨てない）。旧方式のペインは `pane_start_command` が新方式の形でないことで分かる（s4。一括の `list-sessions -F` でも読める）。
- 旧方式のペイン: 送信は PR1 の判定（D）、読み手は今の画面の判定に `pane_dead` を重ねる（旧方式のペインは remain-on-exit が無いので dead にならず、シェルの `exit` ならセッションごと消える＝absent）。**旧方式の間の残りのリスク（判定の後に終わる競合、N3）は PR1 の残りとして続く**。
- 新方式へ移る点: (i) 利用者の stop → start、(ii) 旧方式の CLI が終わり、次の送信で §5.2 の順を通って `respawn-pane -k` で置換したとき（止まったジョブがあれば移らずに断る）、(iii) claude の作り直し（同じ確認の後に kill して新しいセッション）、(iv) サーバーの再起動では移らない（tmux のセッションは残る）。
- 新方式のペイン: PR1 の判定（D）は**当てない**（表 3 の h、表 4 の s6）。判定は §4.2。
- 混在の期間の表示: 一覧・capture は両方式とも同じ語（`exited`・`session_not_running`）を出す。

## 9. 実機で決まること（隔離した tmux で確かめた）

手順（表 3）: `mktemp -d "$TMPDIR/c4300r2.XXXX"` の中に仮の HOME（`.zshrc` に `export PATH="$HOME/fakebin:$PATH"; export RC_LOADED=yes`、`fakebin/fakecli` は `echo …; exec sleep 300` の sh スクリプト）を作り、`env -i HOME=<仮> PATH=/usr/bin:/bin:/opt/homebrew/bin TERM=xterm SHELL=/bin/zsh tmux -L c4300r2x -f /dev/null …`。セッションは本番と同じ順（`new-session … sleep 2147483647` → `new-window -k -c <dir>` → 必要なら `set-option -p remain-on-exit on`）で作った。最後に各セッションを `kill-session -t '=<name>:'`、`-L c4300r2x kill-server`、ソケットと dir を消した。既定の tmux サーバー・稼働中の `mcbd-*`・サーバーには触れていない。本物の CLI は起動していない（代わりのプロセス: `sleep`・`cat`・`sh -c`・`bash` スクリプト）。

### 表 3（2026-11-10、tmux 3.5a、macOS、ログインシェル zsh）

| 記号 | 状況 | 結果 |
|---|---|---|
| a | `… exec env FOO='a b' fakecli`（remain-on-exit on） | `pane_pid` が CLI 自身（`Ss+ sleep`、pid = pane_pid = pgid = tpgid）。CLI の出力 `fakecli PATH-ok RC=yes FOO=a b`（rc の PATH・変数・代入が届いた）。CLI を kill → `pane_dead=1`、`has-session` は成功、画面の最後に `Pane is dead (signal term, …)`。dead の `pane_current_command` は `zsh` のまま。`respawn-pane`（`-k` なし）→ rc=0、alive、新しい pid、**前の CLI の出力が履歴に残った**。respawn 後も `remain-on-exit` は on で、再び exec して kill → dead |
| b | remain-on-exit **なし**で `exec env sh -c '…; exit 0'` | CLI の終了でセッションごと消えた（`can't find session`） |
| b2 | remain-on-exit on で同じ（Resume の行を出して exit 0） | `pane_dead=1`・`pane_dead_status=0`、画面に `Resume this session with:`・`claude --resume X`・`Pane is dead (status 0, …)` |
| b（送信） | dead pane へ `send-keys -l 'echo … > <file>'` と `Enter` | どちらも **exit 0**。ファイルは作られず、画面も変わらない（入力は捨てられる） |
| c | 生きているペインへ `respawn-pane`（`-k` なし） | `respawn pane failed: pane … still active`、rc=1 |
| c | zsh で `exec nosuchcli-4300` | `command not found`、シェルも終わり dead（status 127） |
| c2 | zsh で `exec env nosuchcli-4300` | `env: …: No such file or directory`、dead（127） |
| c3 | **bash** の対話シェルで `exec nosuchcli-4300` | **シェルが残った**（`pane_dead=0`） |
| c4 | 同じ bash で `exec env nosuchcli-4300` | dead（127） |
| e | `exec env cat` に Ctrl-Z（`send-keys C-z`） | `cat` は `Ss+` のまま（止まらない）。画面に `^Z` |
| e2 | 同じペインへ改行を含む本文（`touch <f1>⏎touch <f2>`）と Enter | `cat` が行をそのまま返しただけ。**ファイルは作られない** |
| f | `exec env sh -c 'kill -TSTP $$; echo AFTER_TSTP; sleep 300'` | 止まらず `AFTER_TSTP` が出た（孤立したグループの SIGTSTP は捨てられる） |
| g | `exec env cat` に外から `kill -STOP` | `ps` の状態は `Ss+` のまま、打ったキーを `cat` が読んだ。macOS で STOP が効かなかった理由は未解明（**未確認**） |
| h | `exec env <bash スクリプト（sleep を子で起動、exec しない）>` | `pane_current_command=bash`、`/bin/bash` の pid = pgid = tpgid = pane_pid、子の sleep は同じグループ。**PR1 の D はこれを `shell` と読む**（誤って断る） |
| l | `set-option -p @cm_launch exec` と `list-sessions -F '#{session_name} #{pane_dead} #{@cm_launch}'` | 印は `#{@cm_launch}` で読め、印の無いペインは空。`pane_dead` も一括で読めた。dead pane どうしで `pane_tty` が同じ値になった（使い回し） |
| m | `respawn-pane … "exec env sleep 300"`（pane command の形、F-1） | `pane_start_command` に入り、`default-shell -c` で走る。`.zshrc` の `RC_LOADED` が CLI の環境に**無かった**（rc を読まない） |
| n | `FOO=bar exec env sh -c 'echo $FOO'`（zsh -f・bash --norc・sh） | 3 つとも `FOO=bar`。bash で `FOO="$(echo s3cr)" exec env …` も届いた。zsh で `FOO=bar exec nosuch` はシェルが終わる |

未確認（本物の CLI で確かめる、PR2b の UAT）: 各 CLI を exec 起動して終わらせたときの dead pane の画面と終了の状態、claude の Ctrl-Z の扱い、codex の `Update now`（#2068）の後に dead になること、fish をログインシェルにした利用者（手元に fish が無い）、Linux の tmux。

### 表 1・表 2（改訂 1、旧方式のペインの判定の根拠）

旧方式のペイン（PR1 の D が守る）の判定の根拠として残す。手順は改訂 1 と同じ（`tmux -S <dir>/s`、`zsh -f -i`、pane_pid=86183）。

| 記号 | 状態 | pane_current_command | tpgid | 前面のグループ | ほかのグループ | D | E（採らない） |
|---|---|---|---|---|---|---|---|
| a | 何も動いていないシェル | `zsh` | =pane_pid | zsh `Ss+` | なし | shell | exited |
| b | `sleep`（CLI の代わり） | `sleep` | 別 | sleep `S+` | — | other | agent |
| c | 非 exec の bash ラッパー → sleep | `bash` | 別 | `/bin/bash`・sleep | — | other | agent |
| d | 対話のサブシェル（`bash -i`）が入力待ち | `bash` | 別 | bash だけ | — | **other（誤り）** | subshell |
| e | サブシェルの中で sleep | `sleep` | 別 | sleep | bash | other | agent |
| f | `set +m` の後 sleep を前面に | `zsh` | =pane_pid | zsh・sleep（同じ） | なし | **shell（誤り）** | unknown |
| g | `set +m` の後 `sleep &` | `zsh` | =pane_pid | zsh・sleep（同じ） | なし | shell | unknown |
| h | ジョブ制御有効で `sleep &` | `zsh` | =pane_pid | zsh | sleep（別） | shell | background |
| i | sleep を Ctrl-Z | `zsh` | =pane_pid | zsh | sleep `T` | shell | suspended |
| j | `fg` の後 | `sleep` | 別 | sleep | — | other | agent |
| k | 子が終わった後 | `zsh` | =pane_pid | zsh | なし | shell | exited |

表 2: `node -e`・`npx --no-install node -e`・exec する bash ラッパーは、どれも `tpgid ≠ pane_pid`（D は other）。


### 表 4（改訂 3、2026-11-10、tmux 3.5a、macOS、ログインシェル zsh）

手順: `mktemp -d "$TMPDIR/c4300r3.XXXX"` の中に仮の HOME（`.zprofile` に `export PATH="$HOME/brewbin:$PATH"; export ZPROFILE_LOADED=yes`、`.zshrc` に `export PATH="$HOME/fakebin:$PATH"; export RC_LOADED=yes; export FAKE_API_KEY=k123`、必要なら `sleep`。`fakebin/fakecli` は環境を 2 行出して `exec cat` する sh スクリプト）と作業 dir を作り、`env -i HOME=<仮> PATH=/usr/bin:/bin TERM=xterm-256color SHELL=/bin/zsh LANG=… CLAUDECODE=1 tmux -L c4300r3x -f /dev/null …`（ソケットは `c4300r3x`・`c4300r3y`・`c4300r3z` を使い分けた）。tmux サーバーの大域の環境はこの `env -i` の値になる（=本番で tmux サーバーを起こした環境の代わり）。セッションは本番と同じ順（`new-session … sleep 2147483647` → `set-option history-limit` → `new-window -k -c <dir> [コマンド]`）で作った。後始末は各セッションを `kill-session -t '=<name>:'`、`-L <socket> kill-server`、dir を消した（`ls` で無いことを確認）。既定の tmux サーバーのセッション数は実測の前後とも 39 で、`mcbd-*`・CommandMate のサーバーには触れていない。本物の CLI は起動していない（代わりのプロセス: `fakecli`（`cat`）・`sleep`・`sh -c`）。

| 記号 | 状況 | 結果 |
|---|---|---|
| s1 | **今の形**: `new-window -k`（コマンド無し、ログインシェル）に `CM_PORT='3000' CM_HOOK_URL='…' SECRET="$(cat '<file>')" fakecli` を打つ | CLI の環境: PATH は `/etc/zprofile` の path_helper が足した値＋`brewbin`＋`fakebin`、`RC=yes`・`ZP=yes`・`KEY=k123`、`CM_PORT`・`CM_HOOK_URL`・`SECRET=s3cr`（秘密の値）、`TMUX_PANE`・`TMUX` あり、`CLAUDECODE=1`（tmux の大域の環境から）、PWD は作業 dir |
| s2 | **`sh -c`（PM の決定の形）**: `new-window -k -c <dir> /bin/sh -c "<同じ代入> exec fakecli" \; set-option -p remain-on-exit on` | `/bin/sh: line 0: exec: fakecli: not found`、dead（status 127）。絶対パスで起動すると動くが、PATH は `/usr/bin:/bin`（tmux の大域の環境のまま）、`RC`・`ZP`・`KEY` は**空**。`CM_*`・`SECRET`・`TMUX_PANE`・PWD は届いた |
| s3 | **採用の形**: `/bin/zsh -l -i -c "<同じ代入> exec fakecli"` を同じくペインのコマンドに | **s1 と同じ**（PATH の全体・`RC`・`ZP`・`KEY`・`CM_*`・`SECRET`・`TMUX_PANE`・`CLAUDECODE=1`・PWD。違いは `SHLVL` が 1 か 2 か だけ）。ps: `cat` の pid = pgid = tpgid = pane_pid、`Ss+` |
| s4 | `#{pane_start_command}` | 旧方式（`new-window` にコマンド無し）: 空。`respawn-pane -k … /bin/zsh -l`（今の予備）: `/bin/zsh -l`。新方式: `/bin/zsh -l -i -c "CM_PORT='3000' … SECRET=\"$(cat '<file>')\" exec fakecli"`（秘密は `$(cat …)` の文字列のまま）。`list-sessions -F '#{session_name}\|#{pane_dead}\|#{pane_start_command}'` で全セッションを 1 回に読めた |
| s5 | 新方式で CLI を kill → dead。dead pane へ `send-keys -l 'touch <f>'` と `Enter` | dead: `pane_dead=1`、`pane_current_command=zsh`（exec 前のシェルの名前が残る）。send-keys・Enter とも exit 0、ファイルは作られない |
| s6 | dead pane へ `respawn-pane -t … -c <dir> /bin/zsh -l -i -c "…exec fakecli"`（`-k` なし）。rc は 1 秒眠る。respawn の**直後**に `send-keys -l 'touch <f>'`＋`Enter` | respawn rc=0。直後は `pane_current_command=zsh`（rc を読む `-c` のシェル）、1 秒後に `cat`。**ファイルは作られない**。画面には打った行が 2 回（端末の echo と `cat` の出力）＝ CLI が読んだ。前の CLI の出力（`FAKECLI-START …`）は履歴に残った。`pane_start_command` は新しいコマンド |
| s7 | 生きているペインへ同じ `respawn-pane`（`-k` なし） | `respawn pane failed: pane R:0.0 still active`、rc=1 |
| s8 | ペインのコマンドとして起動した `cat` に Ctrl-Z（`send-keys C-z`） | `Ss+` のまま。画面に `^Z`、続けて打った行を `cat` が読んだ |
| s9 | `-l -i -c "CM_PORT='3000' exec nosuchcli4300"` を zsh・bash・sh で | 3 つとも dead、status 127（シェルは残らない）。zsh で `PATH=/nonexistent; … exec env fakecli` → `command not found: env`、dead 127。bash で `CM_PORT='3000' FOO='a b' exec sh -c 'echo …'`（`env` なし）→ `FOO=a b CM_PORT=3000`（代入が届く） |
| s10 | すぐ終わるコマンド（`sh -c 'exit 3'`）で remain-on-exit の付け方を比べる、各 20 回 | `new-window … \; set-option -p … remain-on-exit on`（1 回の呼び出し）: 20/20 回 dead で残った（status 3）。`new-window` と `set-option` を別の呼び出し: 0/20（20 回ともセッションごと消えた） |
| Q | `/bin/sh -c "exec sleep 1"` が終わった dead pane | `pane_current_command=sh` |
| s11 | **旧方式**のペイン（ログインシェル）で `sleep 300` を Ctrl-Z | 前面の名前 `zsh`、`ps -o pid,pgid,tpgid,stat,comm -t <pane_tty>`: `-zsh`（pid = pgid = tpgid = pane_pid、`Ss+`）と `sleep`（別の pgid、`T`）。`fg` で前面の名前が `sleep` に戻った |

未確認（本物の CLI で確かめる、PR2b の UAT）: 各 CLI を `-l -i -c` で起動したときの起動の時間・認証・hook の届き方（`--settings` のファイル・`CODEX_HOME`・`COPILOT_HOME` は起動のコマンドに載るので s1/s3 と同じく届く見立て）、終わったときの dead pane の画面と終了の状態、claude の Ctrl-Z（生のモードで自分に SIGTSTP を送る）、codex の `Update now`（#2068）の後に dead になること、fish・bash をログインシェルにした利用者の rc、Linux の tmux、tmux の大域の環境に PATH が無いほど小さい場合（launchd から起動した tmux サーバー）。

## 10. 未確認・残り

- 本物の CLI での表 3・表 4 の再確認（§9 の未確認）。PR2b の UAT で、各 CLI を新方式で起動 → 終わらせる → capture・一覧・send（not_sent）・次の send（relaunched）・terminal・stop を確かめる。
- 旧方式のペインの間の残り（PR1 の残り）: 判定の後に CLI が終わる競合、改行を含む本文の先頭行の実行（N3）、§5.2 の確認と `respawn-pane -k` の間に利用者がシェルで何かを起動する競合。新方式に移るまで続く（§8.4）。
- 送信中の復旧（§4.5）: A の一部のキーが新しい CLI の入力欄に着き、A の Enter が新しい会話へ送りうる。シェルでは実行されない。A は indeterminate で返る。
- rc が別の対話シェルを `exec` する利用者（`.zshrc` の最後に `exec fish` など）: `-c` の文字列が実行されず、端末を読むシェルが前面に出る。準備待ちが時間切れになり、§5.3 で新方式のペインを kill して失敗を返す。その間（準備待ちの最大 60 秒ほど）の送信は、起動の途中なので準備の確認（入力欄）で待つか断る（見立て）。rc が端末から読む（oh-my-zsh の更新の問い合わせ）場合、送信のキーは rc に読まれうる（実行はされない、見立て）。
- tmux の `default-command` を設定した利用者: 新方式では使われない（§2.1）。
- tmux の大域の環境: 新方式でも今と同じく、ペインの環境の土台は tmux サーバーの大域の環境で、その上に rc が載る（s1＝s3）。tmux サーバーを CommandMate 以外が先に起こした場合の差も今と同じ。
- 回答経路（`prompt-answer-sender.ts` ほか）: §12。旧方式のペインでは改訂 1 §5.3 のとおり残る。
- CLI 自身が対話シェルを子として開く機能（CLI の中の「シェルに入る」操作）があれば、その間の送信はそのシェルに届く。CommandMate の起動の問題ではなく CLI の中の操作なので対象外（見立て、各 CLI の機能は未確認）。
- 非 exec のラッパーが CLI を中で起動し直す場合（N2 の例）、本文は新しい CLI に届く（シェルではない）。会話が変わったことは通知されない（`pane_pid` が変わらない）。
- 外から SIGSTOP で止まった CLI（§4.4、実測 g が未解明）: 読み戻しが `submitted` と誤りうる。通常の操作では起きない。
- CommandMate から続きの会話を再開する機能（`claude --resume` を起動のコマンドに付ける）は作らない。必要なら別 Issue。
- `wait` の `session_gone` に終了の状態（`pane_dead_status`）を載せるかは PR2b の契約で決める（今は載せない）。
- tmux の最低版（`set-option -p`・`pane_start_command`・`respawn-pane -c` は 3.0 以降の見立て）。

## 11. 指摘ごとの処置

### 11.0 再確認（`review-4300c.md`、codex-2、改訂 2 の再確認）の新 P1・P2 7 件

PM の決定: `pm-return-4300-design-rev2.md` の (a)（起動も復旧もペインのコマンドとして CLI を直接起動、対話のシェルを一度も出さない。起動行を打つ経路・入力ロックの起動の番・印の付け外しは外す。新しい仕組みは足さない。再確認でまだ「シェルが現れる区間」の P1 が出たら (b)）。

N1〜N7 の判定（解消 4・一部解消 3）のうち一部解消の 3 件（N2・N3・N4）は、どれも「復旧の respawn がシェルを出す区間」（新 P1）が理由だったので、下の 1 行目の処置で同じく閉じる。N2 の「ラッパーの中の CLI の交代は検出できない」は §10 の残り（シェルではない）。

| # | 指摘 | 処置 | 理由（実測） | 入れた節 |
|---|---|---|---|---|
| 新 P1 | respawn が送信中の入力先をシェルへ戻す（A の本文・Enter が新しいシェルへ） | **採る（形を替えた）**: respawn も新規の起動も、ペインのコマンドとして CLI を直接起動する（`<shell> -l -i -c '… exec <cli>'`）。端末を読むシェルが出る区間が無い | A のキーの届く先は dead pane（捨てる、s5）・起動中の端末のバッファ（実行されず CLI が読む、s6）・新しい CLI の 3 つだけ。新しい CLI に着いた分は Enter の後の `panePid` の確認で indeterminate。対照のテスト（本文の直前・後・Enter の直前で止めて復旧を差す、回答の矢印・文字・Enter も）を §7.2 に | §2、§4.5、§7.2 |
| P2-a（2） | 印なしを旧方式とみなすと、起動途中・失敗後を誤分類。`env` が PATH に無い環境 | **採る**: 印を外し、tmux の `pane_start_command` で方式を読む。`env` を外した | `pane_start_command` は tmux がペインの作成・respawn の時に入れる（s4）ので、印の保存前のサーバー終了・保存の失敗・古い起動が後継に付ける、が無い。起動途中（alive・新方式・前面の名前がシェル）、起動失敗（dead・status）の読み方を表にした。`-c` のシェルは exec の失敗で終わる（s9、`env` が無い場合も dead 127） | §2.2、§2.4 |
| P2-b（3） | 旧方式の Ctrl-Z で、PR1 の拒否より先に requireSession の relaunch が走る | **採る**: 旧方式の置換の前に「D が shell」かつ「端末にシェル以外のプロセスが無い」を確かめ、止まったジョブがあれば起動も kill もせず not-sent（`suspended`） | s11: 止まった CLI は `ps -t <tty>` に `T` で残り、D は `shell` と読む（D だけでは区別できない）。`fg` で同じ CLI に戻れる。新方式の Ctrl-Z は s8 で止まらないことを確かめたが、本物の CLI とジョブ制御するラッパーは未確認と明記 | §5.2、§4.4、§10 |
| P2-c（4） | unknown・absent の扱いが復旧時と送信後で未完 | **採る**: 不明では置換しない（復旧の判断で unknown → 何もしない／起動を断る）。最初のキーの前の unknown は not-sent、キーの後の unknown・absent・dead・世代交代は indeterminate | キーが届きうる段より後は not-sent に戻せず、同じ CLI と確かめられないので submitted とも言えない。注入のテスト（入力前・Enter の後・復旧判断中）を §7.2・§7.3 に | §4.2、§5.1 |
| P2-d（5） | terminal ルートの「dead なら not_sent」と driver の自動復旧が両立しない | **採る**: terminal を send と同じ「復旧して送る」に揃えた（absent は 404 のまま、dead は `startSessionForSend` → 送信、unknown は 409） | terminal は `driver.sendMessage` を呼び、claude 以外は中で起動し直す（`base.ts:833`）ので「断る」は守れない。復旧の回数・打鍵・結果を検証する（§7.4） | §3.3 |
| P2-e（6） | 応答の poll を dead で直ちに止めると終了直前の出力を保存できない | **採る**: dead への遷移では、その世代（`panePid`）の最後の画面を 1 回回収して保存してから止める。答えのキー 0、後継の世代へは書かない | 今の `response-checker.ts:1687` は生存が false なら画面を読む前に戻る。dead pane は最後の画面を残す（表 3 の b2）ので回収できる | §3.2、§7.4 |
| P2-f（7） | relaunched の案内が、再開した会話を「引き継がなかった」と言う | **採る**: `relaunched` を「置換の事実」と「会話（`resumed`／`new`）」に分けた。stderr も 2 行に分けた | opencode V1 は `-s <id>` で再開する（`opencode.ts:486-497`）。ほかの CLI に CommandMate からの再開は無い | §6 |
| P2-g（8） | §12 に strict 回答と構造化回答（API 回答）が抜けている | **採る**: 入口と配送を分け、通常キー・strict キー・API 回答のそれぞれで dead／absent／起動中／世代交代を書いた。「回答の確認の後に CLI 終了 → respawn → 残りのキーが着く」を §4.5 と同じ扱いにした | strict は `strict-prompt-answer-io.ts:100` の `sendKey`（ticket の確認つき）で別にキーを出す。API 回答は端末を使わない | §12 |

PM の (b) の条件（再確認でまだ「シェルが現れる区間」の P1 が出たら PR2 を止める）に備えて、シェルが出うる区間を全部書き出した: 旧方式のペイン（PR1 が守る、§8.4）、rc が別の対話シェルを `exec` する利用者（§10、§5.3 で kill）。新方式の起動・復旧そのものには無い。

以下の 11.1・11.2 は改訂 2 の処置の記録（節の番号は改訂 2 のもの）。改訂 3 で変わったものは 11.0。

### 11.1 再確認（`review-4300b.md`、codex-2）の N1〜N7

PM の決定: `pm-return-4300-design-rev1.md` の (a)（exec 起動で根の原因を消す）。

| # | 指摘 | 新方式で | 理由 | 入れた節 |
|---|---|---|---|---|
| N1／P1 | E の「非シェルがいる」は対象 CLI の証拠にならない（補助プロセス・サブシェル内の Ctrl-Z） | **消える** | 前面を推し量らない。新方式のペインには入力を読むシェルがどの時点にもおらず、CLI の終了は tmux の `pane_dead`（親としての tmux が見た事実）で決まる。サブシェルも Ctrl-Z の停止も起きない（表 3 の e・f）。E は「採らない」として §2.1 に残す | §2.1、§3.1、§4.1 |
| N2／P1 | lease＝`tpgid` では同じ CLI の寿命を識別できない | **消える**（安全の面）。正しさの面は `pane_pid` で十分 | 寿命の識別が要ったのは、別の寿命に打つとシェルが実行しうるため。新方式ではどの寿命に打ってもシェルには届かない。respawn は `pane_pid` が変わる（表 3 の a）ので Enter の後の確認（§4.2）で indeterminate にする。非 exec ラッパーの中の再起動は残り（§10、安全の穴ではない） | §4.2、§10 |
| N3／P1 | 改行を含む本文は本文の送信だけでシェルが先頭行を実行しうる。「Enter を止めれば実行されない」は誤り | **新方式で消える。旧方式では残る** | 新方式では改行を読んで実行するシェルがいない（表 3 の e2: 改行入りの本文が実行されない、b: dead pane は入力を捨てる）。旧方式のペインの間は PR1 の残りとして changelog.d と PR 本文に明記（PM の決定）。改訂 1 の「Enter を止めれば実行されない」の記述は削った | §0.2、§4.1、§8.4、§10 |
| N4／P1 | 各段の表に、キーを出す内部の経路（空けの反復・撤回・copilot の一括送信）が足りない | **消える** | 各段の判定そのものを安全のためには使わない（§4.1）。どの内部の経路のキーも、シェルではなく CLI か捨て先に届く。正しさのための確認は最初のキーの前と Enter の後の 2 回だけ（§4.2）で、内部の経路を列挙しない | §4.1、§4.2 |
| N5／P2 | 非 claude の最後の再利用の判断（`base.ts:897`・opencode・opencode V2）が旧い画面の判定のまま | **消える** | 最初の判定（`relaunchIfToolExited`）と最後の再利用（`resolveLaunchPane`・opencode V1/V2・claude の `ensureHealthySession`）が同じ `readPaneState` を読み、新方式のペインでは画面で終了を判定しない。dead からの復旧は `respawn-pane`（`-k` なし）で、生きたペインには tmux が断る（表 3 の c） | §5 |
| N6／P2 | `pane_dead=1` とペイン不在をまとめると停止・清掃が漏れる | **採る（分けた）** | alive／dead／absent の 3 つにし、停止・片付け・terminal の 404 は `paneExists`（dead を含む）、送信・状態・relay は `agentAlive`。dead pane の停止では終了のキーを飛ばす。対照: 旧方式のシェル、dead pane、セッション無し（§7.4） | §3 |
| N7／P2 | PR2a で復旧を変えるなら通知を PR2b まで延ばせない | **採る** | 復旧（§5）と relaunched（§6）を同じ PR2a に入れた。旧方式の #2070 の relaunch にも PR2a から通知が付く。PR2a 単体で置換の成功・置換後の失敗・並行の送信を検証 | §6、§8.3 |

### 11.2 最初の事前レビュー（`review-4300.md`）P1-1〜P2-10 の今の扱い

改訂 1 の処置のうち、新方式で形が変わったもの:

| # | 改訂 1 の処置 | 改訂 2 |
|---|---|---|
| P1-1 判定後の終了・再作成 | 各段の判定と lease | 新方式では届く先がシェルでなくなる（§4.1）。正しさは最初と Enter の後の確認（§4.2）。旧方式は PR1 |
| P1-2 unknown | 断る | 同じ（`readPaneState` の unknown を断る） |
| P1-3 D の誤判定 | E を採用 | E は採らない。新方式は判定に推測を使わない。D は旧方式のペインだけ |
| P1-4 capture の実経路 | `isRunning`＝`agentAlive` | 同じ（dead → `exited`） |
| P2-5 既存の復旧 | 種類を読む | `readPaneState` を読む（§5、N5） |
| P2-6 一時停止 | `suspended` で断る | 新方式では Ctrl-Z で止まらない（§4.4）。旧方式は PR1 で断る（作り直さない） |
| P2-7 停止・cleanup | `paneExists` | 同じ（dead を含む、N6） |
| P2-8 auto-yes の説明 | 訂正 | 新方式では答えのキーもシェルに届かない（§3.3） |
| P2-9 入口・各 CLI の対照 | 入口の表 | 入口ごとの拒否／復旧は §5 の表と同じ。全 CLI の陽性対照は §7.2 |
| P2-10 relaunched | `replaced` のとき | 同じ。PR2a に移した（N7） |

PM の設計の決定 (a)〜(e)（`pm-return-4300-design.md`）: (a) relaunched と stderr の 1 行 → §6。(b) wait の変化を受け入れる → §3.2。(c) 回答経路は直さない → §0.3・§3.3・§10。(d) G-PR3 との重なり → §8.2（重ならない）。(e) 事前レビューは codex-2 → この改訂の後、差分だけ再確認を受ける。

## 12. #4303 の経路（回答の送信）への効き目

#4303（`respond`・`prompt-response`・auto-yes の回答が、CLI の終わったペインへキーを打ち込みうる）が、新方式の起動（§2）で同時に塞がるかを経路ごとに見る。この Issue（#4300）では回答経路を直さない（PM の決定 (c)）。ここは #4303 の設計の入力。改訂 3 で、入口と配送を分けた（`review-4300c.md` の 8）。

### 12.1 入口と配送（事実、`ed9b89eac`）

| 入口 | 前の確認 | 配送 |
|---|---|---|
| `respond`（CLI・UI）で `messageId` あり | `src/app/api/worktrees/[id]/respond/route.ts:315`。前に `screenAtSend`（`:312`）で画面を読む。`isRunning` は読まない | **通常キー**: `sendPromptAnswer`（`src/lib/prompt-answer-sender.ts:959`） |
| `respond` の strict（観測つきの回答） | `src/lib/prompt-observation/strict-respond.ts`、I/O は `src/lib/session/strict-prompt-answer-io.ts` | **strict キー**: `sendKey`（`strict-prompt-answer-io.ts:100`）が入力の ticket を確かめて（`:101`）`sendSessionAnswerKey`。Enter の後に `paneCommand`（`:110`、`readSessionPaneCommand`, `cli-session.ts:276`）で前面がシェルか読む（`agentExitedToShell`, `strict-respond.ts:318`、indeterminate の判定だけ） |
| `respond` で `messageId` なし（`decisionId` あり／なし） | `respond/route.ts:107-127` → `respondByDecisionId`／`respondToSolePendingDecision`（`respond/structured-decision.ts:455`・`:519`）。この instance の `listPending()` にその決定があること | **API 回答**: `answerPendingDecisionWithReceipt`（`structured-decision.ts:726`）でエージェント自身の API（opencode の REST）へ。**端末にキーを出さない**。届いたかは source の受領（`delivered`）で決まり、届かなければ `decision_not_delivered` |
| `prompt-response`（UI のカード） | `prompt-response/route.ts:117` の `cliTool.isRunning`（claude は画面の健康、ほかは `hasSession`）→ `frame-verification.ts:83` の画面の再読 → `answer-delivery.ts:179` | 通常キー（同じ `sendPromptAnswer`） |
| auto-yes | `src/lib/auto-yes-poller.ts:1029` の `captureObservedFrame`（画面を直接読む）→ `:919` | 通常キー |

`sendPromptAnswer` の中でキーを出す所: Command Code の複数選択（`sendCommandCodeMultiSelectAnswer`, `:517`）、claude・antigravity の矢印の選択（`sendSpecialKeysWhileCurrent`, `:1111` → `:842`・`:856`。AskUserQuestion で既定の選択肢なら `['Down', 'Up', 'Enter']`, `:1100-1102`）、文字の答え（`sendKeys(sessionName, answer, false)`, `:1118`）と Enter（`:1153`）、Enter を抑える答え（`:1129`、入力ロックの外）。ロックの中の再読は `answerTargetStillOnScreen`（`:657`）で、画面にダイアログが残っていれば通る。前面のプロセス・`pane_dead` を読む所は無い。

### 12.2 実測（隔離した tmux、2026-11-10）

手順は §9 と同じ（`tmux -L c4303x -f /dev/null`、`env -i`、仮 HOME）。後始末は各セッションを `kill-session -t '=<name>:'`、`-L c4303x kill-server`、dir とソケットを消した。既定のサーバー・`mcbd-*` には触れていない。本物の CLI は起動していない。改訂 3 の起動の形（ペインのコマンド）での届く先は表 4 の s5・s6 を使う。

| 記号 | 状況 | 結果 |
|---|---|---|
| p | 旧方式のペイン（シェルのプロンプト）で `touch <f>` を実行し、外から `<f>` を消してから、回答のキー `Down Up Enter` | **`<f>` がまた作られた**（`Up` が直前のコマンドを呼び出し、`Enter` で実行）。続けて `1`＋`Enter` → `zsh: command not found: 1`（シェルが実行した） |
| r | 新方式の dead pane へ `Down Up Enter` と `y` | どちらも exit 0、何も起きない（入力は捨てられる） |
| q | 新方式で、CLI の代わりが子（`sleep &`）を残して終わる | `pane_dead=1`（子が端末を持っていても、ペインのプロセスが終われば dead）。子は後始末の前に消えていた（見立て: ペインが閉じた端末の SIGHUP） |
| q3 | 同じく、端末を読む子（`(sleep 1; exec cat) &`）を残して終わる | `pane_dead=1`。`y`＋`Enter` は子に届かず（画面に出ない）捨てられた |

### 12.3 配送ごとの扱い

| 状況 | 通常キー（`sendPromptAnswer`） | strict キー | API 回答 |
|---|---|---|---|
| 新方式・dead pane（画面にダイアログが残る） | **塞がる**（安全）。キーは捨てられる（r）。要るもの: 最初のキーの前に `readPaneState` が dead なら未送信（`PromptAnswerNotDeliveredError`）、auto-yes は答えずに記録。`prompt-response` は PR2a で `isRunning`＝`agentAlive` になり `:117` で 400 | **塞がる**（安全）。キーは捨てられる。要るもの: 同じく最初のキーの前の dead で未送信。Enter の後の `agentExitedToShell` は dead pane の `pane_current_command` がシェルの名前（s5・Q）なので「シェルへ戻った」と読み indeterminate になる。#4303 では `readPaneState` の dead に読み替える（名前に頼らない） | 端末を使わないので exec の起動は効かない（安全の穴もない）。opencode V1 は API を TUI の同じプロセスが出す見立てで、dead なら届かず `decision_not_delivered`。opencode V2 はサーバーが TUI と別（`releaseOpencodeV2Server`）なので、TUI の dead の後もサーバーが受けうる（**未確認**）。どちらもシェルには届かない |
| absent | **塞がる**。tmux が `can't find session` で失敗。未送信として返ること（`transportDeliveryOf`, `:783`）をテストで固定 | 同じ | 端末と無関係。`listPending()` が空なら 404 |
| 新方式・起動中（respawn の後、rc を読んでいる） | シェルでは実行されない（s6: 端末のバッファ → 新しい CLI が読む）。ただし respawn は前の画面を履歴に残す（s6）ので、前のダイアログを読んで答えると、**新しい CLI の入力欄に答えが着く**（正しさ）。要るもの: `readPaneState` の `panePid` を回答の前と後で比べ、変わっていれば indeterminate。起動中（`session-launch-flight` の起動の印）は答えない | 同じ（ticket は respawn の前の `beginAgentSession` で失効するので、まだ出していないキーは出ない） | 影響なし |
| 新方式・回答の確認の後に CLI 終了 → respawn → 残りのキーが着く（世代交代） | §4.5 と同じ。キーの届く先は dead pane・端末のバッファ・新しい CLI で、シェルではない。`Down Up Enter` が新しい CLI に着くと、CLI の中の履歴の呼び出し・空の送信になりうる（正しさ）。要るもの: 回答の後の `panePid` の確認で indeterminate | 同じ | 影響なし |
| 新方式・生きた CLI の中で別のプロセス（エディタ・ページャ・ツールの子）が端末を読み、古い画面のダイアログに当たる | **塞がらない**（シェルではない）。今の `answerTargetStillOnScreen` の再読を保つ。子が対話シェル（CLI の「シェルに入る」機能）なら実行されうる（**未確認**） | 同じ | 影響なし |
| 新方式・Ctrl-Z | **塞がる**（起きない、s8） | 同じ | 影響なし |
| 移行期間の旧方式で CLI が終わった（シェルのプロンプト、画面にダイアログが残る） | **塞がらない**。`Down Up Enter` で直前のコマンドが再実行され（p）、数字・`y`＋Enter はコマンドとして実行される。要るもの: 最初のキーの前（矢印の束・文字・Enter の各 `sendKeys`／`sendSpecialKeys` の前）に PR1 の判定（D）を通す。矢印は本文より危ない（履歴の再実行）ので、表駆動で claude・antigravity の矢印の経路を陽性対照に | **塞がらない**。同じく最初のキーの前に D を通す | 影響なし |
| 移行期間の旧方式で Ctrl-Z で止まった CLI | **塞がらない**。D は `shell` と読む（§9 表 1 の i）。止まった CLI を kill・作り直ししない（§5.2 の端末のプロセスの確認と同じ） | 同じ | 影響なし |
| 移行期間の旧方式で、判定の後に CLI が終わる競合 | **塞がらない**（PR1 の残り）。受け入れる（新方式に移るまで） | 同じ | 影響なし |

### 12.4 まとめ

- 新方式のペインでは、#4303 の安全の穴（答えのキーがシェルで実行される）は起動の形（§2）で同時に塞がる。通常キー・strict キーとも、#4303 の中身は「dead・absent・起動中を未送信として返し、回答の後に `panePid` の変化を indeterminate にし、auto-yes が答えたと記録しないこと」の確認とテストになる。API 回答は端末を使わないので、この Issue の起動の形とは独立（opencode V2 の TUI の dead の後の受領は未確認）。
- 塞がらないのは、(i) 移行期間の旧方式のペイン（PR1 の判定を通常キー・strict キーの両方に通す。矢印の答えを優先）、(ii) 新方式の起動中・世代交代で答えが新しい CLI に着く（正しさ。シェルではない）、(iii) 生きた CLI の子への誤った答え（シェルではない）。
- テスト（#4303 の契約に渡す）: dead／absent／起動中／世代交代の 4 つを、通常キー（矢印・文字・Enter）・strict キー・API 回答の 3 つの配送それぞれで。
- 本文に無い指摘（#4303 の範囲で見るもの）: 文字の答えは `sendKeys(sessionName, answer, false)`（`:1118`）で `literal` を付けていない。答えが `Enter`・`C-c` などキー名と同じ文字列なら tmux がキーとして解釈しうる（`SendKeysOptions.literal` の説明、`tmux.ts` の #1933）。
