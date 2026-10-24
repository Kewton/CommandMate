# run の記録の決まり

本体の 1-5 から、run の記録の中身と `status` の `next` の決まりを移した（#3481）。記録はスクリプトが書く。

## 1-5 記録の中身と next の決まり

（1 行 1 段の JSON。issue・段・結果・HEAD・task id・契約・担当とモデル・所要時間・時刻）。追記だけなので、同じフォルダの別の run の
ファイルは上書きしない。`verify` / `review` / `findings` / `precheck` / `ci` / `merge` は HEAD つきでしか記録できない（その HEAD にだけ効く）。
`status` の `next` は、**最新の HEAD について満たしていない最初の段**: 後の段が通った後で前の段が `fail` になればそこへ戻り、
HEAD が変われば検証・確認をやり直す（`skip` は通ったと数える。対象外の段も `skip` を記録する。ただし `verify` / `findings` / `precheck` は `ok` だけ）。
`verify` / `review` / `findings` は**作業の HEAD**（ワーカーの最後のコミット）で、ほかの段は**公開する HEAD** で見る。develop の取り込みや
module-reference の一本化を重ねた HEAD の記録には、`--work-head <作業の HEAD>` で作業の HEAD も書く（公開のスクリプトと precheck は自分で書く）。
`--head` / `--work-head` は **`git rev-parse HEAD` の 40 桁の SHA だけ**を受け付ける（短い SHA は exit 2 で拒否。`publish-pr.mjs` が 40 桁で記録を探すため、短い SHA で書くと「記録が無い」と読まれる、#3664）。すでに記録された 7 桁の行は `status` が読める。
この規則は `publish-pr.mjs` / `merge-pr.mjs` の止まる条件と同じ関数（`unmetStage`）なので、再開先と公開側の判定はずれない。
`verify` は `scripts/orchestrate/wait-verify.mjs`（3-3）、`precheck` は `scripts/orchestrate/precheck.mjs`（6-1-1）が自分で書く。

## 1-5 同じ Issue の複数の PR（work item）

1 つの Issue に PR が 2 本以上あるとき（PR 1a と PR 2 など）は、PR ごとに **`--item <名前>`**（英数字・`-`・`_`、32 文字まで）を付けて記録する（#3883）。
記録の行に `item` が入り、`status` は work item ごとに再開地点を出す（`#3883/d1`）。PR d1 の `merge=ok` で PR d2 は終わらず、PR d2 の HEAD で PR d1 の確認はやり直しにならない。
`item` の無い行（#3883 より前の行も）は Issue 自身の行として、今までどおりに読む。`wait-verify.mjs` と `consistency-review.mjs` も `--item` を受け取り、
記録・ログ名（`wait-<issue>-<item>.log`、`review-<issue>-<item>.md`）に同じ名前を使う。`wait-verify.mjs` の記録には、その実行の
**execution key**（`<run の Issue 範囲>:<work item>:<task id>:a<試行の番号>`）が `key` として入る。
`precheck.mjs` / `publish-pr.mjs` / `merge-pr.mjs` はまだ `--item` を取らず、Issue のすべての行を見る（HEAD つきの段は HEAD で絞られるので、別の PR の行で通ることは無い）。
