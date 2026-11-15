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
- 判定と送信は同じ解決済みの宛先を使う（Codex のレビューの P2-1・P2-2）
  - worktree は全宛先で今の ID に直す: サーバーの `GET /api/worktrees/:id`（`canonicalWorktreeId` で旧 ID を今の ID にし、`id` を返す）を CLI の `ApiClient` で読む。旧 ID の `mycodebranchdesk` も `mycodebranchdesk` として claude-3 の判定に掛かる
  - `mycodebranchdesk` 宛ては `commandmate reply <今の ID> --instance <別名> --json` の `instanceId` で判定し、その `instanceId` で送る（別名を送信へ渡さない。判定の後に別名の対応が変わっても、送り先は判定した ID）
  - どちらかが解決できなければ exit 2 で何も送らない（fail-closed）
- `claude3-reserve.ts send` も `--note` を必須にし、`pmSendArgv(本文, note)`（＝`sendArgv(本文, false)` ＋ `--reply-to self --note`）で送る
- 毎朝の自動依頼（`dispatch-main.ts` の `sendArgv(message, withAutoYes)`）は変えない。PM 用の argv は別の関数 `pmSendArgv` にした（自動依頼の run は待っているセッションが無く、relay の届け先が無い）
- 依頼の雛形の締めは「最後の行は `DONE:` / `WAIT:`（了承・判断待ち）/ `STOP:` のどれか」（team.md §3・§8、orchestrate.md）。機械が読む締め（ワーカーの契約の `IMPL_COMPLETED`、5-2b の整合性レビューの `DONE:`）は変えない

## 試験

- `tests/unit/scripts/orchestrate/pm-send-4418.test.ts`: `--note` なし・空は exit 2 で exec / spawn が 0 回。陽性対照（argv に `--reply-to self` と `--note`）。claude-3 の token の規則。`claude3-reserve send` も同じ。`sendArgv` が変わらない
- `tests/integration/pm-send-relay-delivery-4418.test.ts`: 入口の argv が求める relay（PM → 送り先、送信に結合）を開き、受け手が送り返さずに手番を終えても PM の入力欄へ配送される
- 同じ単体試験の「the rule and the send use the same resolved target」: 旧 ID でも claude-3 に token が要る（陽性対照: token ありなら予約を通る）、送る argv が解決済みの worktree とインスタンス、解決できなければ何も送らない
- 同じ結合試験の「PM asks again after a relayed answer」: P1 の事実（旗なしは 2 回目で `RELAY_CHAIN_BLOCKED`、旗ありは hops 1・2・3 の次で `RELAY_HOPS_EXCEEDED`、人の入力で 1 に戻る）
- `tests/unit/docs/pm-send-relay-docs-4418.test.ts`: team.md・orchestrate.md・雛形が新しい入口と `WAIT:` を指す

## 返事を受けた後の再依頼（Codex のレビューの P1。未解決・本体の変更が要る）

PM が relay で返事を受け、人の入力を挟まずに `pm-send` で再指示・次の依頼を送ると、今は送れない。本体を変えずに何往復でも続ける方法は無かったので、入口は直していない。

### 調べた事実（試験 `tests/integration/pm-send-relay-delivery-4418.test.ts` の 2 つ目の describe が固定）

- 返事の配送は PM の入力欄に `messageType: 'relay'`・`request_id = relay:<PM が開いた relay の id>` の user 行を書く（`src/lib/relay/relay-delivery.ts:616-620`）
- 次に PM が relay を開くとき、PM の最新の user 行（5 ターンの窓。`src/lib/relay/relay-service.ts:94`）が relay の行で、それより新しい行が echo だけなら、その relay の `hops` が親になる（`relay-service.ts:170-185`、`:220`）
- 親があると `--allow-relay-chain` 無しは `RELAY_CHAIN_BLOCKED`（`src/lib/relay/relay-policy.ts:132-139`）。今の `pm-send` は付けないので、**返事を受けた後の 2 回目の送信で止まる**（exit 2・未送信）
- `--allow-relay-chain` を付けると `hops = 親 + 1`（`relay-policy.ts:130`）。上限は `MAX_RELAY_HOPS = 3`（`:46`、`:142-147`）。PM の 1 回目が 1、返事の後の再依頼が 2、その次が 3、**4 回目の送信（3 回目の再依頼）で `RELAY_HOPS_EXCEEDED`**
- 人が PM に普通の行を入れると連鎖は切れ、次は 1 から（`relay-service.ts:180`、既存の試験 `tests/unit/lib/relay/relay-parent-hops-2387.test.ts:223`）
- 配送済みの relay の行を消す API は無い（`DELETE FROM session_relays` は src に無い）。親が消えたときの fail-open（`relay-service.ts:183-185`）は使えない

### 入口だけでは採らなかったこと

- `--allow-relay-chain` を入口が常に付ける: 人の入力 1 回あたり 3 回まで延びるだけで「何往復でも」にならない。しかも PM が転送役になる連鎖（他人の返事をそのまま別の宛先へ流す）も通してしまう
- 返事の後に PM 自身へ普通の行を送って連鎖を切る: 人の入力を装って連鎖の防止を骨抜きにする
- 拒否されたら relay 無しで送り直す: L1（PM の送信は必ず relay つき）を壊す

### 取りうる案（本体の変更。別 Issue）

1. **自分が開いた relay の返事は親にしない**: `findParentRelayHops` で親の relay の `from` が依頼元と同じ（自分の問いへの返事）なら連鎖と見なさない。問い→返事→問いは転送ではない。ただしエージェント同士の往復（A が B に問い続ける）も無制限になるので、2 と組み合わせる
2. **PM に限る**: 1 の扱いを、ロール（agent-roles の PM ロールなど）または送信時の明示の旗で、PM のセッションだけに効かせる。連鎖の防止の目的（エージェント同士の無限往復を止める）は PM 以外ではそのまま残る。PM は人の代理で依頼を出す側で、往復の回数は PM の判断（team.md の止まる条件）で止める
3. **同じ相手との往復の回数に別の上限を持つ**（例: 人の入力なしで 20 往復まで）: 1 の無制限を数で縛る

推奨は 1 + 2（PM のセッションでだけ、自分の問いへの返事を親にしない）。

## 残り

- PM が素の `commandmate send` を打つことを仕組みで止めるのは、引き続き採らない（team.md §4。共有の設定のフックは全 Claude セッションに効くため）
- `claude3-reserve` の送信は `spawn-exec.ts` が stderr を捨てるので、claude-3 宛ての `Relay registered: <id>` と mem の拒否の文面は PM に見えない（終了コードは返る）
