# run の記録の決まり

本体の 1-5 から、run の記録の中身と `status` の `next` の決まりを移した（#3481）。記録はスクリプトが書く。

## 1-5 記録の中身と next の決まり

（1 行 1 段の JSON。issue・段・結果・HEAD・task id・契約・担当とモデル・所要時間・時刻）。追記だけなので、同じフォルダの別の run の
ファイルは上書きしない。`verify` / `review` / `findings` / `precheck` / `ci` / `merge` は HEAD つきでしか記録できない（その HEAD にだけ効く）。
`status` の `next` は、**最新の HEAD について満たしていない最初の段**: 後の段が通った後で前の段が `fail` になればそこへ戻り、
HEAD が変われば検証・確認をやり直す（`skip` は通ったと数える。対象外の段も `skip` を記録する。ただし `verify` / `findings` / `precheck` は `ok` だけ）。
`verify` / `review` / `findings` は**作業の HEAD**（ワーカーの最後のコミット）で、ほかの段は**公開する HEAD** で見る。develop の取り込みや
module-reference の一本化を重ねた HEAD の記録には、`--work-head <作業の HEAD>` で作業の HEAD も書く（公開のスクリプトと precheck は自分で書く）。
この規則は `publish-pr.mjs` / `merge-pr.mjs` の止まる条件と同じ関数（`unmetStage`）なので、再開先と公開側の判定はずれない。
`verify` は `scripts/orchestrate/wait-verify.mjs`（3-3）、`precheck` は `scripts/orchestrate/precheck.mjs`（6-1-1）が自分で書く。
