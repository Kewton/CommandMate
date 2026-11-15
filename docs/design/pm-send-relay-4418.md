# PM の送信の入口を relay つきの 1 本にする（Issue #4418）

## 事象

PM の依頼の返しが受け手の記憶頼みで約 8 時間止まった。PM の送り方（素の `commandmate send`、`claude3-reserve.ts send`）が relay を張らなくても通るため。relay（`send --reply-to self`）なら、受け手が何を書いても手番の終わりに依頼元の入力欄へ届く。CommandMate 本体の relay の挙動・API・DB は変えず、使うだけにする。

## 決めたこと

- **入口は新設の `scripts/orchestrate/pm-send.ts`（＋ `pm-send-main.ts`）**。`claude3-reserve.ts send` の一般化は採らない
  - 理由: `claude3-reserve` は送り先を `mycodebranchdesk` の `claude-3` に固定することが設計の要（#4243 §「送り先を動かす引数は無い」、試験 R6 が固定）。宛先を引数にすると、その不変条件を崩す。PM の送り先は claude-3 のほかにイネーブラー（`codex` など）・ジャッジ（`claude-2`）がある
  - `.mjs` でなく `.ts` にしたのは、claude-3 の判定（`DISPATCH_WORKTREE_ID` / `DISPATCH_INSTANCE_ID`）と relay の旗（`pmRelayFlags`）を `src/lib/agent-health/dispatch.ts` と共有し、claude-3 宛ては `claude3-reserve-main.ts` の `main` へそのまま渡すため
- `pm-send <worktree-id> --instance <id> --note "<待つもの>" [--token <t>] "<本文>"`
  - `--note` が無い・空白だけ・値が無い → exit 2。commandmate を 1 回も起動しない（インスタンスの解決もしない）
  - 送る argv は常に `send <wt> <本文> --instance <id> --reply-to self --note <待つもの>`。終了コードはそのまま返す。relay を外す旗・`--reply-to` の宛先を変える旗は作らない（未知の旗は exit 2）
  - `mycodebranchdesk` 宛ては `commandmate reply … --json` でインスタンスを解決する（別名でも claude-3 は claude-3）。claude-3 なら `--token` が必須で、`claude3-reserve.ts send --token <t> --note <待つもの> <本文>` に渡す（team.md §4 の予約の規則をそのまま通る）。claude-3 以外への `--token` は exit 2
- `claude3-reserve.ts send` も `--note` を必須にし、`pmSendArgv(本文, note)`（＝`sendArgv(本文, false)` ＋ `--reply-to self --note`）で送る
- 毎朝の自動依頼（`dispatch-main.ts` の `sendArgv(message, withAutoYes)`）は変えない。PM 用の argv は別の関数 `pmSendArgv` にした（自動依頼の run は待っているセッションが無く、relay の届け先が無い）
- 依頼の雛形の締めは「最後の行は `DONE:` / `WAIT:`（了承・判断待ち）/ `STOP:` のどれか」（team.md §3・§8、orchestrate.md）。機械が読む締め（ワーカーの契約の `IMPL_COMPLETED`、5-2b の整合性レビューの `DONE:`）は変えない

## 試験

- `tests/unit/scripts/orchestrate/pm-send-4418.test.ts`: `--note` なし・空は exit 2 で exec / spawn が 0 回。陽性対照（argv に `--reply-to self` と `--note`）。claude-3 の token の規則。`claude3-reserve send` も同じ。`sendArgv` が変わらない
- `tests/integration/pm-send-relay-delivery-4418.test.ts`: 入口の argv が求める relay（PM → 送り先、送信に結合）を開き、受け手が送り返さずに手番を終えても PM の入力欄へ配送される
- `tests/unit/docs/pm-send-relay-docs-4418.test.ts`: team.md・orchestrate.md・雛形が新しい入口と `WAIT:` を指す

## 残り

- PM が素の `commandmate send` を打つことを仕組みで止めるのは、引き続き採らない（team.md §4。共有の設定のフックは全 Claude セッションに効くため）
- `claude3-reserve` の送信は `spawn-exec.ts` が stderr を捨てるので、claude-3 宛ての `Relay registered: <id>` と mem の拒否の文面は PM に見えない（終了コードは返る）
