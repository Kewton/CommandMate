# Command Code 担当の運用メモ

本体の 1-2b・3-1・3-3・3-5 から読む。難易度「易」の担当は #4238 で Antigravity から Command Code に変わった（中・難は変えていない）。
Antigravity の実測は docs/orchestrate/antigravity.md に残してある（今は使わない）。

## 1-2b Command Code に回す前提

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

## 3-3 完了の合図が要る理由

Command Code は、前のターンの `hook_stop` が、生成中のターンより先に完了として読まれることがある（#2429）。
`wait` はそれを完了と読むので、作業の途中で検証に進み、exit 20 か 21 になる。

そのため `wait-verify.mjs` は `command-code` の担当（`command-code-2` や alias も、サーバーが返す `cliToolId` で判定する）で、
画面に `IMPL_COMPLETED`（または今の HEAD を名指す `IMPL_COMPLETED head=<sha>`）が出るまで裁定しない。
合図が `--signal-timeout` の間に出なければ exit 3（Auto-Yes は切らない）。Claude の担当は合図を待たない。

再指示の後（`--after-reinstruct`）は、task が同じなので、前の試行の `IMPL_COMPLETED` が最新の返信に残っている。そのため合図は再指示の送信より後に
書かれたものだけを数える（送る直前の時刻を `--signal-since` で渡す。無ければ呼び出しの開始から）。画面の `IMPL_COMPLETED head=<sha>` も、
その HEAD が送信より後のコミットでなければ数えない。HEAD が前の試行と同じなら、新しい合図が返信に出るまで裁定しない。
送信時刻は記録の要約に `signal-since=<時刻>` として残る。再指示をせずに検証だけをやり直すとき（mutex 待ちの exit 99 の後など）は
`--reverify --task <id>` で呼ぶ。境界は前の呼び出しのものを引き継ぐので、既に出ている合図で裁定に進む（新しい合図は来ない）。
境界は再指示の後の呼び出しが待つ前に `<run-dir>/wait-<issue>[-<item>].since.json` へ書かれるので、その呼び出しが記録を書く前に中断・例外で終わっても引き継がれる（記録の `signal-since=` と新しい方を使う）。再指示なしの呼び出しはこの印を消す。

`wait-verify.mjs` を通さずに待ったときの手順は、担当によらず docs/orchestrate/antigravity.md#3-3-完了の合図を手で確かめる と同じ（`INSTANCE=command-code` で使う）。
再指示の後は `SENT_AT` に再指示の送信時刻を入れ、task の作成ではなくその時刻を境界にする。

## 3-4 止まったときの対処

- 確認の画面で止まっている（`capture --pane` で見る）: 権限の既定が `ask` に変わった可能性がある。上の「3-1 権限の既定を確かめる」を読み、利用者に直してもらう
- exit 21（作業証跡ゼロ）: docs/orchestrate/exit-codes.md#3-4-21-の対応 の手順で切り分ける
- ワーカー起因の不合格が 2 回続いたら、本体 3-5 の手順で Claude（sonnet）へ格上げする
