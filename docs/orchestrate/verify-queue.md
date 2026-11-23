# 重い検証の順番

元の場所: [team.md](team.md) §10 の 4（#4546 で移した。文は元のまま）。mutex を分けない・同時のワーカーの数・裁定は verify の run で行う、は team.md §10 の 4 に残っている。

## 待ち・列・直の実行

verify の待ちは 1 本あたり 30〜45 分を見込みに入れる（#4467 の後、手元の `unit-related` は src・tests 以外の変更でもテスト全体に切り替わらず `mode=related reason=non-source:<ファイル>` で流れる。全体は CI の `Unit Tests` が見る。ci-merge.md の「テスト全体と unit-related の分け方」）。同じ worktree の古いコミットの run を列に残さない。列の順を変える手段は無いので、急ぐレーンがあるときは PM が両リーダーに新しい verify を控えてもらう。exit 99（待ち切り）はテストの不合格にせず、`--mutex-retries` で並び直す。ゲートのコマンドを worktree で直に流すのは調べるためだけ（直の実行は verify の mutex・work-evidence・scope・env-clean を通らない）。マシンで 1 度に 1 本、PM へ 1 行知らせてから流す。
