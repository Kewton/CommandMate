# PM の送信の入口を relay つきの 1 本にする（Issue #4418）

## 事象

PM の依頼の返しが受け手の記憶頼みで約 8 時間止まった。PM の送り方（素の `commandmate send`、`claude3-reserve.ts send`）が relay を張らなくても通るため。relay（`send --reply-to self`）なら、受け手が何を書いても手番の終わりに依頼元の入力欄へ届く。CommandMate 本体の relay の挙動・API・DB は変えず、使うだけにする。

## 決めたこと

- **入口は新設の `scripts/orchestrate/pm-send.ts`（＋ `pm-send-main.ts`）**。`claude3-reserve.ts send` の一般化は採らない
  - 理由: `claude3-reserve` は送り先を `mycodebranchdesk` の `claude-3` に固定することが設計の要（#4243 §「送り先を動かす引数は無い」、試験 R6 が固定）。宛先を引数にすると、その不変条件を崩す。PM の送り先は claude-3 のほかにイネーブラー（`codex` など）・ジャッジ（`claude-2`）がある
  - `.mjs` でなく `.ts` にしたのは、claude-3 の判定（`DISPATCH_WORKTREE_ID` / `DISPATCH_INSTANCE_ID`）と relay の旗（`pmRelayFlags`）を `src/lib/agent-health/dispatch.ts` と共有し、claude-3 宛ては `claude3-reserve-main.ts` の `main` へそのまま渡すため
- `pm-send <worktree-id> --instance <id> --note "<待つもの>" [--token <t>] [--] "<本文>"`
  - `--note` が無い・空白だけ・値が無い → exit 2。commandmate を 1 回も起動しない（インスタンスの解決もしない）
  - 送る argv は常に `send <wt> --instance <id> --reply-to self --note <待つもの> -- <本文>`。終了コードはそのまま返す。relay を外す旗・`--reply-to` の宛先を変える旗は作らない（未知の旗は exit 2）
  - 本文は `--` の後に置く（opus P3-4）。`-h` や `- 箇条書き` のように `-` で始まる本文も本文として送る（help で exit 0 にならない）。pm-send 自身も `--` の後をすべて位置引数として読む。claude-3 宛ては `claude3-reserve` が本文を位置引数で渡すので、`-` で始まる本文は exit 2 で送らない
  - インスタンスはどの宛先でも解決する（別名でも claude-3 は claude-3）。claude-3 なら `--token` が必須で、`claude3-reserve.ts send --token <t> --note <待つもの> <本文>` に渡す（team.md §4 の予約の規則をそのまま通る）。claude-3 以外への `--token` は exit 2
- 判定と送信は同じ接続先・同じ ID（不変条件 I3'。Codex のレビューの P2-1・P2-2、08f798f72 の再レビューの P2-1・P2-2、PM の裁定 案 A）
  - **接続先は 1 つ**: pm-send は CLI と同じ `loadClientEnv` → `resolveServerEndpoint` で接続先を 1 回決め、自分の `ApiClient`（`baseUrl`）と、起動する全ての `commandmate`（`send`・`reply`・`ls`・`claude3-reserve` の中の `ls`・`send`）に同じ接続先を明示して渡す（`CM_PORT`・`CM_BIND`・`CM_HTTPS_CERT`・`CM_HTTPS_KEY` を環境変数で export。CLI は export された値を .env より優先するので、checkout と global の CLI が別の .env を読んでも同じサーバーへつながる。HTTPS を使わないときは空の値で .env の値を消す）。接続先を決められなければ exit 2
  - **解決はその接続先で**: worktree は `GET /api/worktrees/:id`（旧 ID は今の ID。`id` と `path` を持つ）、インスタンスは `GET /api/worktrees/:id/resolve-target?instance=<selector>`（行の ID → ツール ID → 別名の順。`conflict` は exit 2）で、全ての宛先で解決する。claude-3 の判定はこの ID で行う
  - **送る直前に確かめる**: 判定した worktree（ID・path）とインスタンス（ID・ツール）を、pm-send の接続先で読み直し（`GET /api/worktrees/:id`、resolve-target を解決済みの ID で）、さらに送る CLI 自身にも読ませる（`commandmate ls --json` の同じ ID の行の path、`commandmate reply <ID> --instance <ID> --json` の `worktreeId`・`instanceId`・`cliToolId`）。どれかが違う・読めなければ exit 2 で何も送らない（fail-closed）。行が消えてその ID が別のインスタンスの別名に付け替わった（resolve-target は行の ID を別名より先に読むが、行が無ければ別名で読む）、別名の先が antigravity の行になった、CLI が pin を無視して別の接続先を読んだ、のどれも送らない
  - **送るのは解決済みの ID**（別名を送信へ渡さない）。claude-3 は `claude3-reserve` が定数の `mycodebranchdesk` / `claude-3` で送る
  - 残る隙（既知の制限）: `commandmate send` は `--instance` を必ず selector として resolve-target に通す（ID だけを受け取る入力が CLI に無い。src/cli は scope 外）。確かめた後、CLI の送信が解決するまでの間（同じ処理の中の数十 ms）に行が消えて別名が付け替わった場合は防げない。閉じるには、send に「ID として読み、行が無ければ断る」入力を足す本体の変更が要る
- `claude3-reserve.ts send` も `--note` を必須にし、`pmSendArgv(本文, note)`（＝`sendArgv(本文, false)` ＋ `--reply-to self --note`）で送る
- 毎朝の自動依頼（`dispatch-main.ts` の `sendArgv(message, withAutoYes)`）は変えない。PM 用の argv は別の関数 `pmSendArgv` にした（自動依頼の run は待っているセッションが無く、relay の届け先が無い）
- 依頼の雛形の締めは「最後の行は `DONE:` / `WAIT:`（了承・判断待ち）/ `STOP:` のどれか」（team.md §3・§8、orchestrate.md）。機械が読む締め（ワーカーの契約の `IMPL_COMPLETED`、5-2b の整合性レビューの `DONE:`）は変えない

## 試験

- `tests/unit/scripts/orchestrate/pm-send-4418.test.ts`: `--note` なし・空は exit 2 で exec / spawn が 0 回。陽性対照（argv に `--reply-to self` と `--note`）。claude-3 の token の規則。`claude3-reserve send` も同じ。`sendArgv` が変わらない
- `tests/integration/pm-send-relay-delivery-4418.test.ts`: 入口の argv が求める relay（PM → 送り先、送信に結合）を開き、受け手が送り返さずに手番を終えても PM の入力欄へ配送される
- 同じ単体試験の「the rule and the send use the same resolved target」: 旧 ID でも claude-3 に token が要る（陽性対照: token ありなら予約を通る）、送る argv が解決済みの worktree とインスタンス、解決できなければ何も送らない
- 同じ結合試験の「PM asks again after a relayed answer (Codex P1, after #4420)」: 送信は入口（`pm-send`）を通し、その argv を CLI と同じく実の relay で開く。(a) 送る → 返事 → 次を送るが旗なしで 3 回通り毎回 hops 1（#4420 の前の develop では 2 回目が `RELAY_CHAIN_BLOCKED`）、(b) 窓の中で 10 本の返事を受けた後の `pm-send` は exit 2・送信 1 回（relay つき）だけ・受け手に本文が届かない・`RELAY_ROUNDS_REFUSED_NOTICE` を出す
- `tests/unit/scripts/flow/relay-watch-4418.test.ts` の (c): 試験の中で `notifyNoRelay: true` にしたときの形（tick が relay の無い依頼を PM へ 1 回知らせる）。リポジトリの `.commandmate/flow.yaml` は `false` のまま（#4517 で戻す。`flow-relay-watch-4418.md` §5.1）
- `tests/unit/scripts/orchestrate/pm-send-dest-4418.test.ts`（I3'）: 偽の 2 つのサーバーと偽の `commandmate`。陽性対照（通常の解決・claude-3 の予約の経路は 1 回送る、pin を受ける CLI は pm-send の接続先へ送る）、(d) 行が消えて同じ文字列が別のインスタンスの別名に付け替わる（通常・claude-3 の経路）、(e) CLI が pin を無視して別の接続先を読む、(f) 別名の先が antigravity の行になる、はどれも exit 2・送信 0。`-` で始まる本文（`-h`・箇条書き）は `--` の後で送る、claude-3 宛ては exit 2
- `tests/unit/docs/pm-send-relay-docs-4418.test.ts`: orchestrate.md・雛形・この設計メモが新しい入口と `WAIT:`・#4420 の後の事実を指す。team.md を固定する試験（`tests/unit/docs/pm-send-relay-team-4418.test.ts`）は team.md の差分と一緒に後から当てる（§残り）

## 返事を受けた後の再依頼（Codex のレビューの P1。#4420 で解消）

PM が relay で返事を受け、人の入力を挟まずに `pm-send` で再指示・次の依頼を送ると、#4420 の前は 2 回目で `RELAY_CHAIN_BLOCKED`（exit 2・未送信）だった。#4420（`docs/design/relay-reply-not-parent-4420.md`。往復の数え方は同 §3 の案 Q）で本体が直り、入口は旗を足さずにそのまま送れる。

### 今の事実（試験 `tests/integration/pm-send-relay-delivery-4418.test.ts` の 2 つ目の describe が固定）

- 返事の配送は PM の入力欄に `messageType: 'relay'`・`request_id = relay:<PM が開いた relay の id>` の user 行を書く。その relay の `from` は PM 自身なので、次に PM が開く relay の親に数えない（#4420）。送る → 返事 → 次を送る は旗なしで通り、毎回 hops 1
- 止めるのは往復の上限だけ: 直近 30 分（`RELAY_ROUNDS_WINDOW_MS`）に受けた自分の relay の返事が 10 本（`MAX_RELAY_ROUNDS`）以上なら `RELAY_HOPS_EXCEEDED`（`src/lib/relay/relay-policy.ts`。`--allow-relay-chain` でも外れない）。数えるのは依頼元（PM のセッション）単位の合計で、相手ごとではない
- **PM は多くの相手（開発リーダー・ジャッジ・イネーブラー）から返事を受けるので、この 10 本に当たりうる**。3 分に 1 往復より速い往復が 30 分続くと当たる
- 人が PM に普通の行を入れても往復の数は 0 に戻らない（台帳の時刻だけで数える）。戻るのは返事が 30 分の窓から外れたとき

### 往復の上限で断られたときの入口

- `commandmate send` は relay の拒否を `Error: <message>` で stderr に出し exit 2 で終わる（コードは出ない。`src/cli/commands/relays.ts` の `registerRelay`）。`pm-send` は送信の stderr を流しながら末尾を持ち、exit 2 で、かつ stderr のある 1 行が往復の上限の拒否の行の全体（`Error: This session received <n> replies to its relays in the last <n> minutes; the limit is <n>. Wait before opening another (the count clears as replies age out).`）と一致したときだけ（Codex P3-1。断片を含む別の行・別の exit では出さない）、`RELAY_ROUNDS_REFUSED_NOTICE`（何も送っていない・素の send には落とさない・待つか人に返す）を 1 行足して、**exit をそのまま返す**
- 素の send（relay 無し）で送り直さない（L1。不変条件 I5）。`--allow-relay-chain` を付けて送り直すこともしない（上限は旗で外れない）
- claude-3 宛て（`claude3-reserve.ts send` 経由）も同じ。`claude3-reserve` の送信の runner は stderr を捨てるので、`pm-send` が stderr を流して持つ runner（`reserveSpawn`）を渡す（試験が `exec` / `spawnExec` を差し込んだときは渡さない）
- 文面の照合は `decideRelayCreation` の実の文面で試験が固定する（`pm-send-4418.test.ts` の「pm-send after the relay pace ceiling」）。深さの上限（同じ `RELAY_HOPS_EXCEEDED`）は `pm-send` が `--allow-relay-chain` を付けないので起きず、照合もしない

### 入口で採らなかったこと（#4420 の前に検討した案。今も採らない）

- `--allow-relay-chain` を入口が常に付ける: 今は不要。付けても往復の上限は外れず、PM が転送役になる連鎖（他人の返事をそのまま別の宛先へ流す）を通すだけ
- 返事の後に PM 自身へ普通の行を送る: 人の入力を装う。#4420 の後は往復の数も戻らないので効きもしない
- 拒否されたら relay 無しで送り直す: L1（PM の送信は必ず relay つき）を壊す

## 残り

- PM が素の `commandmate send` を打つことを仕組みで止めるのは、引き続き採らない（team.md §4。共有の設定のフックは全 Claude セッションに効くため）
- `claude3-reserve.ts send` を直接打つと、`spawn-exec.ts` が stderr を捨てるので claude-3 宛ての `Relay registered: <id>` と拒否の文面は見えない（終了コードは返る）。`pm-send` 経由なら stderr を流す runner を渡すので見える
- flow の relay の見張りの検査 1（relay の無い依頼）は #4420 の後も記録だけ（`notifyNoRelay: false`）。戻すと毎朝の自動依頼・人の直接の入力・照会の失敗が毎日「relay なし」と知らされるため。理由と戻し方は `flow-relay-watch-4418.md` §5.1、戻すのは #4517
- team.md の差分（§3 の往復の上限の 1 文を含む）と team.md を固定する試験は、claude-8 の割り当て規則の PR のマージ後にリーダーの指示で最後のコミットとして当てる（それまで team.md は develop のまま）
