# bug の流れ（起票から受け入れまで、正本）

bug の起票・真因と横展開・計画への入れ方・まとめ方・PR の形・受け入れの正本（人の決定 ③ 2026-11-28 12:52。前の決定 11-28 00:22〜00:24 を含む）。
team.md §13・ci-merge.md 6-2・plan-check.md の計画の欄・イネーブラーのロールは、ここを指す。ラベルの作成と今の bug への付け直しは PM が人の承認の後に行う。

## 1 起票

- 起票の前に、既存の根の Issue を探す（`workspace/orchestration/bug-rca/index.md` の塊の親と、`gh issue list --state all --search`）。同じ根なら新しい Issue にせず、その Issue にコメントで足す
- 新しい bug の Issue にするのは、develop で赤になる再現がある P1・P2 だけ。fix の Issue には `bug` のラベルを付ける
- レビュー・受け入れの範囲の外の P3 は、新しい Issue にせず、親の Issue の追跡の表に 1 行で置く。親の無い P3・未確認の候補は起票せず、Sprint の候補の一覧（`workspace/orchestration/runs/<日付>/followup-candidates.md`）に 1 行で足す（日時・出どころのファイル・中身・根の候補）
- 起票した bug には `bug` と `needs-rca` を付け、Milestone を付けない
- 例外（P1。基準は PM の案で、この PR の承認の対象）: 利用者のデータ・安全・公開の入口を壊す P1 と、develop の CI を赤のままにする P1 は、PM が人の承認で今の Sprint に入れてよい。そのときも 2 の真因と横展開は直しと並行して書き、直しの PR の前にそろえる

## 2 真因・横展開・対策（イネーブラー）

- 起票から 1 日以内に、その bug の作業に関わっていないイネーブラーが、`workspace/orchestration/bug-rca/` の塊のファイル（`k<N>-<名前>.md`）に書き、`index.md` の塊の行を足す・直す
- 真因分析と横展開はセットで行う。塊のファイルには、真因（1 行）・含む bug・横展開の場所（同じ真因の写しと読み手の一覧）・方針・赤の確かめ・難易度（Command Code に切り出せる部分）・大きさ・親の案を書く
- 「方針が明確」の基準: 選択肢・手順・受入条件が本文で閉じ、人に聞くことが列挙され、写しの数 n→m と表の生成元（ファイル:関数）の欄がある（[plan-check.md 1-4 高リスクの Issue の着手の関門](plan-check.md#1-4-高リスクの-issue-の着手の関門と写しの数)）
- 明確になった塊の bug は、イネーブラーの `DONE:` を受けて PM が `needs-rca` を `rca-ready` に替える（イネーブラーは Issue を書かない）

## 3 計画に入れる

- Sprint に入れる bug は `rca-ready` の塊だけ。塊ごとに Milestone を付ける（[milestone.md](milestone.md)）
- 難（opus）の割合は Sprint の計画の欄の決まり（[plan-check.md の計画の欄](plan-check.md#1-4-sprint-の計画の欄)）に数える

## 4 まとめ方

- 同じ真因の塊の bug は、塊ごとの親の Issue 1 つにまとめる。残りはその Issue の表の行にして、親の番号をコメントに書いて閉じる

## 5 塊の PR の形

- 正本 1 つ: 同じ事実を持つ写し（値・書き手・読み）を 1 つにする。計画に写しの数 n→m を書く
- 読み手の表の試験: 正本を読む関数・呼び所を機械で並べ、各行の期待を持つ。直す前に赤のコミットを先に作る
- 静的ガード: 新しい写し・正本を通らない読み手を足すと赤になる検査

## 6 マージから受け入れ

- develop 向けの PR のマージでは Issue は閉じない（[ci-merge.md 6-2 develop 向け PR と Issue のクローズ](ci-merge.md#6-2-develop-向け-pr-と-issue-のクローズ)）。マージ済みで受け入れを待つ bug（`merge-pr.mjs --close -` で開いたまま残したもの）にラベル `merged-awaiting-accept` を付け、受け入れで閉じるときに外す
- 塊の真因と横展開を書いたイネーブラーは、その塊の受け入れの審判にしない（関わった成果物）
- PM の台帳（`pm-ledger-s<N>.md`）の残りの bug の数は「直していない」と「受け入れ待ち（`merged-awaiting-accept`）」の 2 列に分けて数える
