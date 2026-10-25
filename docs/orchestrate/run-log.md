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
`verify` / `precheck` の行は、所要時間を待ちと実行に分けた `queueSec`・`mutexSec`・`runSec` を持てる（#3884。省略可能で、無い行は今までどおり読む。
docs/orchestrate/ci-merge.md#6-1-1-重い検証の資源制御と待ちの記録）。

## 1-5 同じ Issue の複数の PR（work item）

1 つの Issue に PR が 2 本以上あるとき（PR 1a と PR 2 など）は、PR ごとに **`--item <名前>`**（英数字・`-`・`_`、32 文字まで）を付けて記録する（#3883）。
記録の行に `item` が入り、`status` は work item ごとに再開地点を出す（`#3883/d1`）。PR d1 の `merge=ok` で PR d2 は終わらず、PR d2 の HEAD で PR d1 の確認はやり直しにならない。
`item` の無い行（#3883 より前の行も）は Issue 自身の行として、今までどおりに読む。`wait-verify.mjs` と `consistency-review.mjs` も `--item` を受け取り、
記録・ログ名（`wait-<issue>-<item>.log`、`review-<issue>-<item>.md`）に同じ名前を使う。`wait-verify.mjs` の記録には、その実行の
**execution key**（`<run の Issue 範囲>:<work item>:<task id>:a<試行の番号>`）が `key` として入る。
`precheck.mjs` / `publish-pr.mjs` / `merge-pr.mjs` も `--item` を取り、その work item の行だけを読み、書く行にも `item` を入れる（#3883）。
各段の最新の行を Issue 全体で取ると、別の PR が後から書いた行で「no result」と止まり（2026-10-24 の run）、別の PR の `unit` ゲートの合格で
`Unit Tests` の待ちを飛ばしていた。`--item` を付けないときは `item` の無い行（Issue 自身の行）だけを読む。work item の行は混ぜない。
precheck のログは `precheck-<issue>[-<item>]-<短い SHA>.log`（同じ HEAD の再実行は `.a<n>.log`。前のログを上書きしない）、
module-reference の断片の写しは `module-reference-<issue>[-<item>].md`。`publish-pr.mjs` は、run の記録にある同じ Issue の別の work item の PR を
「同じ Issue の 2 本目の PR」として止めない（記録に無い PR は今までどおり止める）。`merge-pr.mjs --item` は、`--close <N>` を付けない限り Issue を閉じない
（最後の PR の呼び出しで `--close <N>` を付ける）。

## 1-5 work item の run の呼び出し

同じ Issue の PR が 2 本以上ある run は、**3-1 の送信から 6-2 のマージまで、全段に同じ `--item` を渡す**（#3883）。1 段でも落とすと、
その段は Issue 自身（`item` の無い行）の記録を読み書きし、後の段が「no result」で止まる・`status` の `next` と実際の作業が分かれる。
work item は **tasks.tsv の 6 列目に `item=<名前>` と書いて明示する**（`item=d1`）。各段は `item=` で始まる 6 列目からだけ `--item` を作る。
6 列目が無い行・`item=` で始まらない行（#3883 より前の run が 6 列目に書いた `3883-d1`・`3883-d1-r2` などの再試行ラベル）・`item=` だけの行は
`--item` を付けずに呼ぶ（今までどおり Issue 自身の記録）。**列の数で新旧を分けない**: 旧い run の記録は `item` が無いので、6 列目のラベルを
work item と読むと、再開した段が別の単位を読み書きし、publish・merge が「verify: no result」で止まる。本体の 3-3・5-1 の雛形は 5 列で読むので、
6 列の tasks.tsv（旧い run のラベル付きも）にはこの節の雛形を使う（5 列の雛形で読むと 5 列目のモデルに 6 列目がつながって入る）。

- **旧い run の再開**: tasks.tsv も記録も書き換えず、この節の雛形でそのまま読む。ラベルは `item=` で始まらないので、全段が `item` 無しのまま続く
- **work item への切り替え**: 切り替えるのは、これから送る（3-1）Issue だけ。その行の 6 列目に `item=<名前>` を書き、send の記録から
  `--item` を付ける。既に `item` 無しの記録がある Issue は、マージまで `item` 無しで通す（記録は移せない。途中で `item=` を書くと、それまでの
  verify・review の記録を読めない）。同じ work item の再送・再指示・切替の行も同じ `item=<名前>` を書く（`-r2` を名前に足すと別の work item に
  なる）。再試行のラベルを残すなら 7 列目に書く
- **同じ work item の行が複数あるとき**: 6-2 は (Issue, work item) ごとに最新の行だけをマージし、Issue を閉じるのはその Issue の
  最後の対象だけ（`d1`→`d2`→`d1` の再試行なら d1 の最新の行・d2 の順で、d2 だけ `--close`）。最後の行と同じ名前の先の行を終わりとして扱わない
- **item 無しの行（旧い run）**: 6-2 は (Issue, WT) を 1 つの PR とみなす。同じ WT の行は再試行で最新の 1 行だけ、別の WT は別の PR で
  どれも残す（#3880 の A1→A2→A1 の再試行なら A1 の最新の行・A2 の順）。最後の対象より前は `--close -`、最後だけ merge-pr の既定で閉じる。
  切替で WT を変えた行も別の PR に数える。旧い WT の PR を出していなければ、その対象で merge-pr が「no PR」で止まり、後の対象も Issue も
  閉じないので、どちらの PR を残すかを決めてから残りを呼ぶ

```bash
# 3-1: 送った行の 6 列目に item=<work item> を書き（item=d1 など。work item の無い Issue は item= だけ）、send の記録にも同じ --item を付ける
ITEM_ARGS=(); [ -z "$ITEM" ] || ITEM_ARGS=(--item "$ITEM")
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$issue" "$WT" "$AGENT" "$TASK_ID" "$MODEL" "item=$ITEM" >> "workspace/orchestration/runs/$DATE/tasks.tsv"
node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --stage send --result "$SENT" --head "$(git -C "$WT_DIR" rev-parse HEAD)" --task "$TASK_ID" \
  --contract "$CONTRACT" --agent "$AGENT" --model "$MODEL" "${ITEM_ARGS[@]}"
```

```bash
# 3-3: 待機と検証。ログは runs/$DATE/wait-<issue>[-<item>].log
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL COL6 REST <&3; do
  ITEM=; case "$COL6" in item=?*) ITEM=${COL6#item=} ;; esac   # item= で始まらない 6 列目（旧い run のラベル）は item 無し
  ITEM_ARGS=(); [ -z "$ITEM" ] || ITEM_ARGS=(--item "$ITEM")
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/wait-verify.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --wt "$WT" --worktree "$WT_DIR" --instance "$AGENT" --task "$TASK_ID" --model "$MODEL" "${ITEM_ARGS[@]}"
  echo "exit=$? issue=${issue} item=${ITEM:--}"
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

```bash
# 5-2b: 整合性レビュー。work item の worktree を --worktree で名指す（省くと --item の既定は ../commandmate-issue-<N>-<item>。
# Issue の ../commandmate-issue-<N> は見ない）。保存先は runs/$DATE/review-<issue>[-<item>].md
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL COL6 REST <&3; do
  ITEM=; case "$COL6" in item=?*) ITEM=${COL6#item=} ;; esac   # item= で始まらない 6 列目（旧い run のラベル）は item 無し
  ITEM_ARGS=(); [ -z "$ITEM" ] || ITEM_ARGS=(--item "$ITEM")
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/consistency-review.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --head "$(git -C "$WT_DIR" rev-parse HEAD)" \
    --brief "workspace/orchestration/runs/$DATE/brief-review-${issue}${ITEM:+-$ITEM}.txt" --worktree "$WT_DIR" "${ITEM_ARGS[@]}"
  echo "review exit=$? issue=${issue} item=${ITEM:--}"
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

```bash
# 5-3 の処置を終えた行の findings、6-1-1 の precheck、6-1 の公開（precheck が通った行だけ）
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL COL6 REST <&3; do
  ITEM=; case "$COL6" in item=?*) ITEM=${COL6#item=} ;; esac   # item= で始まらない 6 列目（旧い run のラベル）は item 無し
  ITEM_ARGS=(); [ -z "$ITEM" ] || ITEM_ARGS=(--item "$ITEM")
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --stage findings --result ok --head "$(git -C "$WT_DIR" rev-parse HEAD)" "${ITEM_ARGS[@]}"
  node scripts/orchestrate/precheck.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --worktree "$WT_DIR" "${ITEM_ARGS[@]}"
  RC=$?; echo "precheck exit=$RC issue=${issue} item=${ITEM:--}"   # runs/$DATE/precheck-<issue>[-<item>]-<sha>.log。3 は cpu.heavy が空かず裁定不能（再実行する。ci-merge.md 6-1-1）
  [ "$RC" = 0 ] || continue
  node scripts/orchestrate/publish-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --worktree "$WT_DIR" --label feature "${ITEM_ARGS[@]}"
  echo "publish exit=$? issue=${issue} item=${ITEM:--}"   # module-reference の控えは runs/$DATE/module-reference-<issue>[-<item>].md
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

```bash
# 6-2: マージの対象は 1 PR に 1 本。item= の行は (Issue, work item)、item 無しの行（旧い run・work item の無い Issue）は (Issue, WT)
# を単位にし（同じ WT は再試行、別の WT は別の PR）、単位ごとの最新の行だけを、その単位が tasks.tsv に初めて出た順に 1 本ずつ。
# Issue を閉じるのはその Issue の最後の対象だけ。それより前の対象は閉じない（item 無しには --close - を付ける）。
# item 有りと無しが混ざる Issue はどれが最後か決められないので、全部 --close - にして、全部マージした後に手で閉じる
while IFS="$(printf '\t')" read -r CLOSE issue WT AGENT TASK_ID MODEL COL6 REST <&3; do
  ITEM=; case "$COL6" in item=?*) ITEM=${COL6#item=} ;; esac   # item= で始まらない 6 列目（旧い run のラベル）は item 無し
  ITEM_ARGS=(); [ -z "$ITEM" ] || ITEM_ARGS=(--item "$ITEM")
  case "$CLOSE" in close) ITEM_ARGS+=(--close "$issue") ;; keep) ITEM_ARGS+=(--close -) ;; esac   # default は merge-pr の既定
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/merge-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --worktree "$WT_DIR" "${ITEM_ARGS[@]}"
  RC=$?; echo "merge exit=$RC issue=${issue} item=${ITEM:--} wt=${WT} close=${CLOSE}"
  [ "$RC" = 0 ] || break   # 止まったら、その PR を直してから同じ雛形を回し直す（マージ済みの PR は merge-pr が記録だけ足して飛ばす）
done 3< <(awk -F'\t' '{
    it = ($6 ~ /^item=./) ? substr($6, 6) : ""
    k = (it != "") ? $1 SUBSEP "item" SUBSEP it : $1 SUBSEP "wt" SUBSEP $2
    if (!(k in row)) { order[++n] = k; issueOf[k] = $1; withItem[k] = (it != ""); if (it != "") items[$1]++; else plain[$1]++ }
    row[k] = $0
  } END {
    for (j = 1; j <= n; j++) last[issueOf[order[j]]] = order[j]
    for (j = 1; j <= n; j++) {
      k = order[j]; i = issueOf[k]
      if (items[i] && plain[i]) c = "keep"
      else if (k != last[i]) c = withItem[k] ? "default" : "keep"
      else c = withItem[k] ? "close" : "default"
      print c "\t" row[k]
    }
  }' "workspace/orchestration/runs/$DATE/tasks.tsv")
```

- 再開は `run-log.mjs status` の work item ごとの行（`#3883/d1`）で、`next` の段から上の雛形の同じ行を呼ぶ
- 6-4 の一本化は、work item ごとの控え（`module-reference-<issue>-<item>.md`）を読む
- 再指示（3-4）の `--after-reinstruct` の呼び出しにも同じ `--item` を付ける。最後の 1 本の `--last` は `ITEM_ARGS` の後に足す
- 3-1 の送信（`launch-worker.mjs send --item`）は `send-<issue>[-<item>][.a<n>].out` / `.err`、5-1 の契約なしの検証は `execution-key.mjs allocate` で
  `verify-<issue>[-<item>][.a<n>].json` を呼び出しごとに排他的に取り、記録に同じ `--item` と execution key（`--key`）を入れる（#3883。本体の 5-1 の雛形は 6 列目を読む）
- 5-1 の契約なしの検証も、wait-verify と同じ実行の入力の manifest を残す（#3883 N6）: `env-manifest.mjs start` を `verify` の直前、`end` を直後に呼び、
  `verify-<issue>[-<item>][.a<n>].env.json` に execution key と一緒に置く。`end` は記録の note に足す `env=<hash>` を出し、検証中に入力が変わっていれば
  `env-changed-during-verify=<項目>` と exit 3（雛形は `RC=3`＝`verify=fail` にする。裁定にしない）。precheck / publish / merge はこの `env=` を 3-3 の記録と同じに照らし合わせる
  （docs/orchestrate/workers.md の「合格を使う地点も環境を照らし合わせる」）
