# Sprint の Milestone の割り当てと整合（正本）

Sprint と Issue の割り当て・計画の承認の日の移し・検査を流す時点・Sprint を閉じる条件の正本（人の決定 ② 2026-11-28 12:52。#4642 PR-2 を兼ねる）。
team.md §13・PM のロールの報告と着手の確かめ・plan-check.md の計画の欄は、ここを指す。検査の道具は `scripts/orchestrate/milestone-check.mjs`（読み取り専用の助言。定義は docs/design/milestone-check-4642.md、exit は [exit-codes.md 1-5](exit-codes.md#1-5-milestone-check-の-exit-code)）。

## Sprint と Milestone

- 段 7 以降の段を Sprint N と呼ぶ。Sprint ごとにリリースで閉じる（リリースは人の承認）
- Issue がどの Sprint に入るかの正は GitHub の Milestone（`Sprint N`）だけ。計画の表・台帳・依頼文は割り当てを写さず、Milestone を指す
- ロードマップの Issue #4461 には、Sprint の並び・理由・保留の条件・変更の履歴を書く（割り当ての一覧は書かない）
- 今の Sprint は `.commandmate/flow.yaml` の `milestone.current` に名前で書く。道具も人も「一番小さい open な Sprint」などから推さない

## 割り当ての段

| 段 | 割り当て | 書くこと |
|---|---|---|
| 次の 1 Sprint | 確定（計画の承認で Issue を入れる） | 計画の表のとおり |
| その次の 1〜2 Sprint | 仮 | Milestone の説明の先頭に「仮（次の計画で確定）」 |
| その先 | 空（Milestone は作ってよいが Issue を入れない） | 候補は Sprint の候補の一覧と bug-rca の index に置く |

- 段の途中で起こす追跡の Issue は、Milestone を付けずに起票する（起票の基準は [bug-flow.md](bug-flow.md#1-起票)）。なぜ: 次の Sprint の Milestone を自動で付けると、容量を見ずに Sprint が膨らむ（対策 5、人の承認 2026-11-21）
- Sprint に Issue を足す・外すのは人の判断（承認された範囲の変更）。PM は理由と推奨をつけて聞く

## 承認の日の移しと途中の替え

計画の承認の日と、途中の替え（足す・外す・Sprint の替え）を人が承認したときは、同じ手番で次の 4 つを行い、台帳に 1 行書く。道具には移させない（読み取り専用）。

1. 承認された表のとおり Issue を移す（`gh issue edit <N> --milestone "<名前>"`、外すときは `--remove-milestone`）
2. 今の Sprint が替わるなら `.commandmate/flow.yaml` の `milestone.current` を替える
3. #4461 に変更をコメントで残す（移した Issue・理由・承認の出どころ）。記録の無い移動は検査の M6 に出る
4. `node scripts/orchestrate/milestone-check.mjs check` が exit 0。62 なら行の `detail` を読んで直し、流し直す。61 は「ずれ無し」と読まない

## 検査を流す時点

`check`（ずれの判定）と `summary --md`（今の Milestone の要約）を、次の時点で流す。

- 再起動の後の読み直しの最初
- 定期の見張り（PM の台帳の 30 分ごとの行）
- PR のマージの後
- 人への区切りの報告の前（`summary --md` の出力を報告の頭に貼る。報告の形は [roles/project-manager.md](roles/project-manager.md#報告)）
- 人の承認（「推奨で」を含む）の後、次のディスパッチの前（上の 4 つの後に、Milestone の位置と変えた差分を 1〜3 行で返す）

## Sprint を閉じる条件

次の 3 つがそろったら PM が Milestone を閉じ、#4461 にコメントする。

- 受け入れ: 審判のまとめが合格、または不合格の項目の扱いを人が決めた（team.md §9）
- リリース: 人が承認したリリースが出た
- 整合: 残った Issue を下の手順で移した後に、`milestone-check.mjs check` が exit 0

その Sprint に OPEN で残った Issue は、Issue ごとに「次の Sprint へ送る」か「候補に戻す（Milestone を外す）」かを人が決める。PM は Issue ごとに推奨をつけて聞き、決まったら上の「承認の日の移しと途中の替え」の 4 つを行う。
次の Sprint の計画には、前の Sprint の閉じ方（上の 3 つと check の exit）を欄に書く（[plan-check.md の計画の欄](plan-check.md#1-4-sprint-の計画の欄)）。閉じていなければ、欠けている条件と見込みを書いて人の承認を受ける。黙って着手しない。

## 再起動の後の読み直し

`milestone-check.mjs summary --md`・#4461・今の Sprint の Milestone・PM の台帳（`workspace/orchestration/runs/<日付>/pm-ledger-s<N>.md`）・`commandmate brief` の順に読み直す。
