# agent-health の依頼と claude-3 の予約の手順

元の場所: [team.md](team.md) §4（#4546 で移した。文は元のまま）。並行して run を回さない規則は team.md §4 に残っている。

コマンドはすべて main のチェックアウト（`mycodebranchdesk`）で `npx tsx scripts/agent-health/claude3-reserve.ts <サブコマンド>` として実行する。

1. **予約**: `reserve --label "<対象の Issue>"`。標準出力の 1 行が token。token は引き継ぎメモ（`workspace/mem`）にも書く。
   `claude-3` が処理中・プロンプト待ちなら exit 4、別の持ち主（前の PM の run・自動依頼の run）がいれば exit 3 で、どちらも予約しない
   **開発リーダー自身が守る場合**（PM を通さず直接 `/orchestrate` を頼まれた run など）: `claude-3` の中から `reserve --self --label "<対象の Issue>"`。状態確認を省き（自分が処理中のため）、持ち主は `leader`。`whoami` が `mycodebranchdesk` の `claude-3`（cliTool は claude）でなければ exit 2。dispatch は予約中として `skipped-busy` で見送る。解除は `release --token <token>`（`send` は exit 3）。token を失ったら `status` で読み、残った leader の予約は PM が `release --force --from <token>` で外す（`takeover` は使えない）。exit 3 は `status` で持ち主を見て、dispatch なら終わるのを待って取り直す
2. **送信**: ブリーフも途中の返事も `send --token <token> "<本文>"` で送る（PM の予約の token でだけ送れる。自動依頼の token では exit 3）（中身は `commandmate send mycodebranchdesk "<本文>" --instance claude-3`）。素の `commandmate send … --instance claude-3` は使わない
3. **解除**: 開発リーダーの `DONE:` を読んだら `release --token <token>`。長くかかるときは `renew --token <token> [--hours 1-24]`。期限（既定 8 時間）を過ぎても予約は外れない。期限は「要確認」の表示だけ
4. **PM の再起動後**: `status` で自分の予約の token を見て `takeover --from <token> --reason restart`。新しい token に替わり、古い token の操作は以後すべて exit 3
5. **自動依頼の run が外せなかったとき**: run の最後の `finish --token` が完了の印（予約の置き場所の `finished-<token>.json`）を残したのに解除が通らなかった場合だけ、`claude-3` が手すきなら `takeover --from <token> --reason dispatch-finished` で引き継げる。リリース判断レポート（HTML）は run の途中でも手で作れるので証拠にしない。印が無ければ exit 3 で、人が `release --force --from <token>` で判断する
6. **導入時**: PM のセッションと Schedule（dispatch）の環境の両方で `status` を実行し、出た `dir=` の絶対パスが同じことを確かめる（置き場所は `~/.commandmate/agent-health/claude3.reservation` に固定）

dispatch 側は、対象があれば `/clear` の前に予約を取り、依頼を送った後も run の終わりまで持つ。run の最後に `claude-3` 自身が条件ファイルの指示どおり `finish --token` を実行する（完了の印を残してから解除）（[agent-health.md](../user-guide/agent-health.md)「自動依頼」）。

元の場所: team.md §4（素の send を止めない理由）

リポジトリの共有の設定（`.claude/settings.json` のフック）を足すと clone した利用者を含む全 Claude セッションに効くため採らない。
