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

`launch-worker.mjs send --instance command-code` は、契約を送る前にこの値を読む。

| 読んだもの | 動き |
|---|---|
| `defaultMode: ask` | `permission ASK …` を出し、**何も送らずに exit 45** |
| JSON のオブジェクトでないファイル | `ask` でないと言えないので exit 45（何も送らない） |
| `ask` 以外・値が無い・ファイルが無い | `permission ok … defaultMode=<値>` を出して契約を送る |
| `--model opus` などを渡した | Claude のモデルは書かない。exit 2（何も送らない） |

exit 45 を受けたら、利用者に `permissions.defaultMode` を `ask` 以外にしてもらってから同じ呼び出しで送り直す。
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

`wait-verify.mjs` を通さずに待ったときの手順は、担当によらず docs/orchestrate/antigravity.md#3-3-完了の合図を手で確かめる と同じ（`INSTANCE=command-code` で使う）。

## 3-4 止まったときの対処

- 確認の画面で止まっている（`capture --pane` で見る）: 権限の既定が `ask` に変わった可能性がある。上の「3-1 権限の既定を確かめる」を読み、利用者に直してもらう
- exit 21（作業証跡ゼロ）: docs/orchestrate/exit-codes.md#3-4-21-の対応 の手順で切り分ける
- ワーカー起因の不合格が 2 回続いたら、本体 3-5 の手順で Claude（sonnet）へ格上げする
