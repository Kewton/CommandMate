# Command Code 担当の運用メモ

本体の 1-2b・3-1・3-3・3-5 から読む。難易度「易」の担当は #4238 で Antigravity から Command Code に変わり、**2026-11-19 から「中」も Command Code** が担当する（難は Claude opus）。
Antigravity の実測は docs/orchestrate/antigravity.md に残してある（今は使わない）。

## 1-2b Command Code に回す前提

- 難の観点（危険な領域・設計・原因未特定・未決事項・実機でしか決まらない検証・強い依存・新規 export）に当てはまらないものは、易と中をまとめて Command Code に回す。**中**＝選択肢か手順と受入条件が本文で閉じている判断（旧 sonnet）。**新しいガード・テストを 1 本まるごと設計するものは難（opus）に残す**
- **本文が閉じていないまま回さない。** 着手の前に、イネーブラーが Issue を「選択肢・手順・受入条件」まで具体化する
- 仕事の **6〜8 割**を Command Code で回すのが目標。Sprint ごとにワーカーのモデルの割合を lead-return と台帳に数える
- 名簿の instance id は `command-code`（2 本目は `command-code-2`）。`send` / `wait` / `capture` / `respond` に `--instance command-code` を渡す
- Claude のモデルは無い。契約の設定は `agent: command-code` で `model` を書かない（`-`）。`agent: antigravity` は契約を作らずに止まる（`contract.mjs`）
- skill の置き場所は `.commandcode/skills` と `.agents/skills` だけで、`.claude/commands` は読まない。
  goal の雛形（`scripts/orchestrate/templates/goal.md`）のどの節も省かない。`/pm-auto-issue2dev` のような多段ワークフローは使えない

## 3-1 権限の既定を確かめる

対話の権限は、セッションの**起動時**に worktree の `.commandcode/settings.local.json`（そこに無ければ `.commandcode/settings.json`）の
`permissions.defaultMode` で決まる。`ask` だと、Auto-Yes が有効でも確認の画面で止まる。

`launch-worker.mjs send --instance command-code` は、契約を送る前にこの値を読む。Command Code かどうかは、サーバーが `--instance` を解決した
ツール（`cliToolId`。`wait-verify.mjs` と同じ根拠）で決めるので、`command-code-2` や alias（例: `cc`）でも同じ確認が効く。

| 読んだもの | 動き |
|---|---|
| `defaultMode: ask` | `permission ASK …` を出し、**何も送らずに exit 45** |
| JSON のオブジェクトでないファイル | `ask` でないと言えないので exit 45（何も送らない） |
| `ask` 以外・値が無い・ファイルが無い | `permission ok … defaultMode=<値>` を出し、動いているセッションを止めてから契約を送る（新しいセッションがこの値で起動する） |
| 止まったと確かめられない | exit 42（何も送らない） |
| `--instance` を解決できない | exit 2（何も送らない） |
| `--model opus` などを渡した | Claude のモデルは書かない。exit 2（何も送らない） |

exit 45 を受けたら、利用者に `permissions.defaultMode` を `ask` 以外にしてもらってから同じ呼び出しで送り直す。
`ask` で起動済みのセッションは設定を直しても `ask` のままなので、送り直しの呼び出しはそれを止めてから送る（Claude の担当と同じ「止める→起動→送る」の形）。
オーケストレーターは利用者の設定（`~/.commandcode/`）を書き換えない。値が無いときに確認の画面が出るかは、UAT の実機の 1 本で確かめる。

## 3-1 冷間起動

send が exit 99（`prompt not ready`）なら、メッセージは送られていない（Codex / Command Code で実測）。待つ前に画面を見る。
手順は docs/orchestrate/exit-codes.md#3-1-冷間起動の失敗-exit-99 の表（信頼ダイアログ・既にプロンプト・まだ起動中）に従う。

起動の直後に `? for shortcuts` が一瞬出てから、コーディングの好みを学ぶ画面（`Learning your coding taste` → `Press Enter to continue`）に切り替わることがある（`.commandcode/` が既にある作業ディレクトリで観測）。この間に打った依頼は消える。tmux で直に起動して依頼を打つときは、`Press Enter to continue` を見つけ次第 Enter で閉じ、学習の画面が見えている間は打たず、入力欄が数回続けて見えてから打つ。

## 3-3 完了の合図が要る理由

Command Code は、前のターンの `hook_stop` が、生成中のターンより先に完了として読まれることがある（#2429）。
`wait` はそれを完了と読むので、作業の途中で検証に進み、exit 20 か 21 になる。

そのため `wait-verify.mjs` は `command-code` の担当（`command-code-2` や alias も、サーバーが返す `cliToolId` で判定する）で、
返しの行（`DONE: #<N> <sha> verify exit <n>`。`<sha>` は今の HEAD を名指す）が出るまで裁定しない。
`IMPL_COMPLETED` の行も引き続き合図として読む（#4532 より前に送った task がまだそれを待っている）が、**返しの行が終わりの形**で、
`IMPL_COMPLETED` は「形の外の終わり方」である（見張りは `SHAPE_OUTSIDE` として知らせる。合格にはしない）。
合図が `--signal-timeout` の間に出なければ exit 3（Auto-Yes は切らない）。Claude の担当は合図を待たない。

再指示の後（`--after-reinstruct`）は、task が同じなので、前の試行の合図が最新の返信に残っている。そのため合図は再指示の送信より後に
書かれたものだけを数える（送る直前の時刻を `--signal-since` で渡す。無ければ呼び出しの開始から）。画面の `DONE:` / `IMPL_COMPLETED head=<sha>` も、
その HEAD が送信より後のコミットでなければ数えない。HEAD が前の試行と同じなら、新しい合図が返信に出るまで裁定しない。
送信時刻は記録の要約に `signal-since=<時刻>` として残る。再指示をせずに検証だけをやり直すとき（mutex 待ちの exit 99 の後など）は
`--reverify --task <id>` で呼ぶ。境界は前の呼び出しのものを引き継ぐので、既に出ている合図で裁定に進む（新しい合図は来ない）。
境界は再指示の後の呼び出しが待つ前に `<run-dir>/wait-<issue>[-<item>].since.json` へ書かれるので、その呼び出しが記録を書く前に中断・例外で終わっても引き継がれる（記録の `signal-since=` と新しい方を使う）。再指示なしの呼び出しはこの印を消す。

`wait-verify.mjs` を通さずに待ったときの手順は、担当によらず docs/orchestrate/antigravity.md#3-3-完了の合図を手で確かめる と同じ（`INSTANCE=command-code` で使う）。
再指示の後は `SENT_AT` に再指示の送信時刻を入れ、task の作成ではなくその時刻を境界にする。

### 見張りが拾う3つの終わり方（#4532）

`orchestrate-monitor` のループは、状態（`state` / `promptData`）を `capture --json` から読み、終わり方は `capture --pane` の**全行**から読んで、**1 回だけ** report する（エピソードであって毎ポーリングの洪水にしない）:

| 画面の終わり方 | 出力 |
|---|---|
| `DONE: #<N> <sha> verify exit <n>`（行全体） | `monitor[w1]: return line DONE — …` |
| `WAIT: <理由>`（行全体） | `monitor[w1]: return line WAIT — the worker is waiting; …` |
| `STOP: <理由>`（行全体） | `monitor[w1]: return line STOP — the worker stopped; …` |
| `IMPL_COMPLETED[ head=<sha>]`（行全体） | `monitor[w1]: SHAPE_OUTSIDE ending — IMPL_COMPLETED … (not a return line; not completion)` |
| どれも無い（生成中・入力待ち） | 何も出さない（従来のストリームと 1 バイトも変わらない） |

行頭の完全一致で読む。依頼文（goal）自体が 3 つの形を名指しして画面に残るので、部分一致だと「指示を終わりと読む」— だから行全体で判定する。
Command Code は 200x1000 の pane の上から描く（top-anchored）ので、`realtimeSnippet`（下の 100 行）は transcript が pane を埋めるまで余白になる（#4245）。そのため終わり方は `capture --json` の `content` / `realtimeSnippet` ではなく、`capture --pane` の全行から読む（末尾 30 行の窓では、枠の行が下に続くと合図が窓の外へ押し出される）。見張りは担当を問わず（セッションが動いていれば）毎ポーリングで `--pane` を引き、終わり方はその全行だけで判定する（codex も下端の入力欄で `realtimeSnippet` が埋まり、上の方の合図が窓に入らない。#3946）。許可のダイアログも、`ml_cc_has_prompt_marker` と同じ目印（下の 30 行の窓）を pane にも当てて `PROMPT` にする（#4434 の枠のように `content` が空で `isPromptWaiting` が false でも拾う）。`--pane` の読み取りに失敗したら 1 回だけ `WARN capture --pane failed` を出す。


## 3-4 止まったときの対処

- 確認の画面で止まっている（`capture --pane` で見る）: 権限の既定が `ask` に変わった可能性がある。上の「3-1 権限の既定を確かめる」を読み、利用者に直してもらう
- exit 21（作業証跡ゼロ）: docs/orchestrate/exit-codes.md#3-4-21-の対応 の手順で切り分ける
- ワーカー起因の不合格が 2 回続いたら、本体 3-5 の手順で Claude（opus）へ格上げする。sonnet は、Command Code が起動・送信で詰まったときの代わりだけ（理由を lead-return に書く）

## 付録 同梱バンドルから仕様を読むとき

外部 CLI の同梱バンドル（`dist/cli.mjs` など）を grep して仕様を決めるときは、値を**受理する**関数（loader / validator）だけでなく、
その値を**使う**関数（`select*` / `run*` / `resolve*` など）も追う。後者の方が厳しいことがある。
Command Code の hook の `matcher` がその例で、loader は `"*"` を全一致として警告なく受理するが、実行側は空でない `matcher` に
ツール名を求めるので、ツール名の無い `SessionStart` / `Stop` は `"*"` では一度も発火しない（空文字なら発火する）。
CommandMate が `matcher: ""` で登録する理由は `src/lib/hooks/sources/command-code/hooks-config.ts` の冒頭にある。

追い切れないときは、疑う値と既知の良い値を**別の層へ同時に**仕込み、1 回の起動で対照する
（例: 2 つの設定の層に別のコマンドを登録し、発火した数を見る）。1 回の実機のターンで切り分けられ、イベントによってはモデルの呼び出しより前に発火するので利用枠も使わない。
validator が唯一の判定者である値（例: 列挙の検証だけで決まる権限モード）は、validator を読めば足りる。
