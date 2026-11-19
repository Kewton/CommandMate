# 開発体制（ロールつきのチーム）

worktree `mycodebranchdesk` で動かす、このリポジトリの開発体制（2026-11-07 の利用者の決定、Issue #4239）。
リポジトリ内部の開発の手順であり、利用者向けの設定ガイドは別（#4196）: [チームの役割](../user-guide/team-roles.md)。

## 1. 役割

| 役割 | インスタンス | ロール（CommandMate） | 仕事 |
|---|---|---|---|
| PM | `claude` | `project-manager` | 利用者の依頼をブリーフにし、開発リーダーに渡す。進みを見張り、承認の要るものだけ利用者に返す。受け入れはリリースごとに 1 回にまとめて依頼し、並行の本の分け・まとめの判定・マージの凍結を決める（§9） |
| イネーブラー | `codex`（`codex-2`）。Codex の代わりは Claude 5（`--instance claude-5`）。Antigravity には AI から頼まない（下の「Antigravity の扱い」）（§6 の 7） | `enabler` | 設計の事前レビュー（2-4-4）・整合性レビュー（5-2b）・原因調査。読むだけ |
| ジャッジ | `claude-2`（並行の本は新しいセッション） | `judge` | 統合した版の受け入れテスト・リグレッションテスト（UAT）。リリースごとに 1 回まとめ、独立した 2〜3 本に分けて並行し、主が結果をまとめて判定する（§9） |
| 開発リーダー | `claude-3` | `dev-leader` | ブリーフを受けて `/orchestrate` を回す。難易度でワーカーを選ぶ。受け入れの間のマージの凍結に従い、差し戻しは持ち主として直す（§9・§10） |
| ワーカー | Issue の worktree ごと | — | 易＝Command Code（#4238 のマージ後。それまでは orchestrate.md 1-2b の現行の担当）、中＝Claude sonnet、難＝Claude opus |

`claude-3` は、agent-health の自動修正ループ（Epic #3047、毎朝 08:30 の dispatch）の送り先も兼ねる。

## 2. 流れ

利用者 → PM → 開発リーダー → ワーカー。

- PM はワーカーへ直接送らない。ワーカーへの指示は開発リーダーが `/orchestrate` の手順で出す
- 開発リーダーは利用者へ直接聞かない。承認が要るもの・判断が要るものは PM へ返し、PM が利用者に返す
- イネーブラーへの依頼（2-4-4・5-2b）は今の `/orchestrate` の手順のまま。送るのは開発リーダー
- ジャッジへの UAT の依頼は PM が送る。`/orchestrate` の Phase 7（UAT）を行うのは、開発リーダーではなく PM がジャッジへ頼む形に替わる

- 手順書の改定・仕組みの導入・設計の方針・Issue の分け方のような高難易度の判断は、Issue にする前・実施する前にイネーブラーへレビューを頼む（PM の送り方は §3 の `pm-send.ts` だけ）。案は事実と見立てを分け、根拠のファイル・コマンドを添え、「同意の列挙ではなく反対と疑問を優先」と頼む。返ってきた指摘はリポジトリで確かめてから採否を決め、自分の報告に誤りが見つかれば訂正を明記する。イネーブラーが確認で止まったら（exit 10）答えず、選択肢を原文のまま利用者に見せる

- リーダーから PM への結果と案は `workspace/orchestration/runs/$DATE/lead-return-<issue>-<item>.md`、PM の処分は `pm-return-<issue>-<item>.md` に書く。同じ名前に書くと、PM の処分がリーダーの案を上書きする

## 3. PM から開発リーダーへのブリーフ

**PM の送り方は 1 つだけ**（Issue #4418。設計は [docs/design/pm-send-relay-4418.md](../design/pm-send-relay-4418.md)）。ブリーフ・途中の返事・再指示（PM の処分）・イネーブラーへのレビュー・ジャッジへの UAT の依頼を、すべて main のチェックアウトで次のコマンドで送る:

```bash
npx tsx scripts/orchestrate/pm-send.ts <worktree-id> --instance <id> --note "<待つもの>" "<本文>"
# claude-3 へは予約の token を足す（§4）
npx tsx scripts/orchestrate/pm-send.ts mycodebranchdesk --instance claude-3 --token <token> --note "<待つもの>" "<本文>"
```

- 常に `--reply-to self --note "<待つもの>"` が付く。受け手が送り返さずに手番を終えても、その手番の終わりに返事が PM の入力欄へ届き、mem の `waiting` も relay が閉じれば閉じる。relay を外す旗は無い
- `--note` が無い・空なら exit 2 で何も送らない（commandmate を起動しない）。それ以外は `commandmate send` の終了コードをそのまま返す
- 素の `commandmate send` / `ask` / `cmate-delegate` で PM から送らない（返しが受け手の記憶頼みになり、約 8 時間止まった。#4418）
- relay で届いた返事を読んだ直後の再指示・次の依頼は、今は送れない（relay の連鎖の防止で exit 2・`RELAY_CHAIN_BLOCKED`）。人が PM に 1 行入れると戻る。`--allow-relay-chain` を付けても 3 ホップ目の次で止まる。未解決（設計メモ §「返事を受けた後の再依頼」）
- 送り先は解決済みの worktree（旧 ID は今の ID）とインスタンス（別名は ID）に送る。解決できなければ exit 2 で何も送らない

ブリーフには次の 4 点を含める。

1. 対象の Issue（番号）
2. マージの許可の範囲（どの Issue・どの base まで。無ければ「マージは進めず、マージ可能を報告して止まる」）
3. 止まる条件（例: 不合格が続いた・範囲外の変更が要る・承認が要る）
4. 締めの指示: 「**最後の行は `DONE: <要約>` / `WAIT: <了承・判断待ちの内容>` / `STOP: <理由>` のどれか**」。PM はこの行で完了・待ち・停止を読む（途中の返事・再指示の締めも同じ）

返し・引き継ぎ・送る本文に時刻を書くときは推測しない。書く直前に `date` を実行するか、書くコマンドの中で `$(date +%H:%M)` を使う（並列のレーンで返しが続くと、経過の足し算がずれていく）。

完了の主の合図は relay（`pm-send.ts` が張る `--reply-to self`）で受け、画面の見張りは従にする。画面を見張るときは `capture --pane --tail N` の末尾の窓だけを grep しない（`--tail` は先頭と末尾の空行を除いた後の最後の N 行で、`DONE:` 行の後に続く出力・入力欄・フッタが窓を埋めると、`DONE:` 行は窓の外へ押し出される）。全行を `LC_ALL=C` で読み、「一定時間変化が無い」で STALL を出す出口を持たせる。雛形の締めの行には実値と紛れない印（`<sha>` など）だけを使い、自分の送信や雛形の行を `DONE:` / `WAIT:` / `STOP:` と数えない。

## 4. agent-health の依頼とブリーフが重なったとき

開発リーダー（`claude-3`）は同時に 1 つの run しか回さない。agent-health の依頼（08:30）と PM のブリーフが重なったら、
先に受けた run を終えてから次に進む。並行して 2 つの run を回さない。
これを **claude-3 の予約**（`scripts/agent-health/claude3-reserve.ts`、Issue #4243。設計は [docs/design/claude3-dispatch-exclusion-4243.md](../design/claude3-dispatch-exclusion-4243.md)）で守る。
PM も dispatch も、予約を持っている間だけ `claude-3` に送る。片方が持っている間、もう片方は送らない（dispatch は待たずに `skipped-busy` を記録して終わり、PM のコマンドは exit 3 で止まる）。

コマンドはすべて main のチェックアウト（`mycodebranchdesk`）で `npx tsx scripts/agent-health/claude3-reserve.ts <サブコマンド>` として実行する。

1. **予約**: `reserve --label "<対象の Issue>"`。標準出力の 1 行が token。token は引き継ぎメモ（`workspace/mem`）にも書く。
   `claude-3` が処理中・プロンプト待ちなら exit 4、別の持ち主（前の PM の run・自動依頼の run）がいれば exit 3 で、どちらも予約しない
   **開発リーダー自身が守る場合**（PM を通さず直接 `/orchestrate` を頼まれた run など）: `claude-3` の中から `reserve --self --label "<対象の Issue>"`。状態確認を省き（自分が処理中のため）、持ち主は `leader`。`whoami` が `mycodebranchdesk` の `claude-3`（cliTool は claude）でなければ exit 2。dispatch は予約中として `skipped-busy` で見送る。解除は `release --token <token>`（`send` は exit 3）。token を失ったら `status` で読み、残った leader の予約は PM が `release --force --from <token>` で外す（`takeover` は使えない）。exit 3 は `status` で持ち主を見て、dispatch なら終わるのを待って取り直す
2. **送信**: ブリーフも途中の返事も `npx tsx scripts/orchestrate/pm-send.ts mycodebranchdesk --instance claude-3 --token <token> --note "<待つもの>" "<本文>"` で送る（§3。中で `claude3-reserve.ts send --token <token> --note "<待つもの>" "<本文>"` を通り、`commandmate send mycodebranchdesk "<本文>" --instance claude-3 --reply-to self --note "<待つもの>"` になる）。PM の予約の token でだけ送れる（自動依頼の token では exit 3）。token が無ければ exit 2、`--note` が無ければ exit 2 で、どちらも送らない。素の `commandmate send … --instance claude-3` は使わない
3. **解除**: 開発リーダーの `DONE:` を読んだら `release --token <token>`。長くかかるときは `renew --token <token> [--hours 1-24]`。期限（既定 8 時間）を過ぎても予約は外れない。期限は「要確認」の表示だけ
4. **PM の再起動後**: `status` で自分の予約の token を見て `takeover --from <token> --reason restart`。新しい token に替わり、古い token の操作は以後すべて exit 3
5. **自動依頼の run が外せなかったとき**: run の最後の `finish --token` が完了の印（予約の置き場所の `finished-<token>.json`）を残したのに解除が通らなかった場合だけ、`claude-3` が手すきなら `takeover --from <token> --reason dispatch-finished` で引き継げる。リリース判断レポート（HTML）は run の途中でも手で作れるので証拠にしない。印が無ければ exit 3 で、人が `release --force --from <token>` で判断する
6. **導入時**: PM のセッションと Schedule（dispatch）の環境の両方で `status` を実行し、出た `dir=` の絶対パスが同じことを確かめる（置き場所は `~/.commandmate/agent-health/claude3.reservation` に固定）

dispatch 側は、対象があれば `/clear` の前に予約を取り、依頼を送った後も run の終わりまで持つ。run の最後に `claude-3` 自身が条件ファイルの指示どおり `finish --token` を実行する（完了の印を残してから解除）（[agent-health.md](../user-guide/agent-health.md)「自動依頼」）。
PM が素の `commandmate send` を打つことを仕組みで止めるのは未対応（追跡）。リポジトリの共有の設定（`.claude/settings.json` のフック）を足すと clone した利用者を含む全 Claude セッションに効くため採らない。`claude-3` へは `npx tsx scripts/orchestrate/pm-send.ts … --token <token>` だけで送る（手順 2）。

手で着手する Issue に `agent-health` / `catalog-drift` / `metrics` のラベルが付いていれば、着手のときに `gh issue edit <N> --add-label auto-dispatched` を付けてコメントを残す。付けないと、翌朝の自動依頼（`src/lib/agent-health/dispatch.ts`）が同じ Issue を `claude-3` に送り、ブランチ・PR が重なる。自分で起票する Issue には、自動の修正に回したいもの以外これらのラベルを付けない。

## 5. UAT の結果の返し方（Phase 7）

UAT はジャッジ（`claude-2`）が行い、結果はジャッジ → PM → 開発リーダーの順で返す。PM はジャッジへの依頼も開発リーダーへの返しも `pm-send.ts` で送る（§3）。不合格の修正ループ（`/uat-fix-loop`）は開発リーダーが回す。
修正ループ内の再UAT（`/uat-fix-loop` の Step 5 の `/uat`）と全 Issue の回帰確認も同じで、開発リーダーが自分で `/uat` を回さず、PM 経由でジャッジに頼み結果を待つ。
開発リーダー以外の人が 1 人で `/orchestrate` を回す場合（今の運用）は、`orchestrate.md` の Phase 7 の手順のままでよい。
UAT を起こす worktree は、run-lock を machine-lock に載せた #4288 PR1b を含む develop を取り込んでから起こす（`scripts/uat/run-server.sh` は各 worktree のチェックアウトのものを使うので、取り込む前の worktree は旧い run-lock のまま取り合い、混在の間は旧い `up` が新しい `up` のロックを pid だけで死んだと読んで取ることがある。設計は `docs/design/run-lock-machine-lock-4288.md` と `docs/design/lock-reservation-rest-4288.md` §1.9）。

## 6. 直しとレビューを収束させる規則

直し→レビューの往復が収束しない問題（mem の G-PR2 で Codex 9 回、G-PR3 で 5 回、#4288 PR1a で 4 回）への手当て。人の承認: 2026-11-11。数字の出典は PM の台帳（`workspace/mem/pm-2026-11-09-remaining.md`）。
根にあったのは、指摘の多くが直しで変えていない行（最初からあった穴）にあり、レビュー 1 回で一部ずつしか見つからなかったこと、設計・実装が枝ごとの場合分けで組み合わせの数だけ漏れが出たこと、呼び手の無い API の使われない組み合わせを直し続けたこと、P2 の処分が「広げて直す」だけだったこと、同じ種類の 2 回目で止まらなかったこと。

1. **1 回目のレビューで網羅させる。** 高リスクの変更の最初の 5-2b と PM の Claude レビューで、レビュアーにすべての return・throw・書き込みの表と、入力・状態の組み合わせの表を作らせる。なぜ: 穴を 1 回ずつ見つける往復を 1 回に縮めるため
2. **高リスクは最初から不変条件で書く。** 送信の経路・ロック・データ・公開 API は、設計と最初の契約から「不変条件＋全組み合わせの表の試験＋先に赤」で書く。なぜ: 枝ごとの場合分けは組み合わせの数だけ確かめ漏れを生む
   - 判定した値で実行する。判定と実行を同じ値・同じ時点で行い、「拒否の後に取り消す」形（途中で落ちると残る）は禁止。待ちの間の差し替えで判定を迂回される（段 6 の L1・L2 PR1・L2 PR2）
   - 静的な検査の試験は、脅威の範囲を冒頭に書き、許可リストと構文で判定する（docs/orchestrate/contract.md#2-4-静的ガードの試験の書き方）
3. **PR を危険の境目で分ける。** 送信の経路・ロックを画面の変更と同じ PR に入れない。目安は数百行・20 ファイル程度（目安であってゲートではない）。なぜ: PR が大きいほどレビューの回数が増えた
4. **API は呼び手と同じ PR で作る。** 呼び手の無い組み合わせは引数の検査で拒否し、広げるのは呼び手を作るとき。なぜ: 使われない組み合わせを P2 として直し続けた
5. **P2 の処分に「狭めて塞ぐ」を必ず選択肢に入れる。** 今の呼び手が通らない経路は、まず拒否で塞ぐ。なぜ: 「広げて直す」だけでは穴が増え続けた
6. **同じ種類の穴が 2 回出たら止める。** 直しを送る前に止め、作業に関わっていないイネーブラーに共通の原因を調べさせてから直しを出す。なぜ: 同じ種類の 2 回目で止まらず往復が続いた
7. **レビュアーの代わり。**
   - Codex の週の上限が切れたら、レビューは Claude 5（`--instance claude-5`、ロール `enabler`）に頼む。止まっていれば 1 行の send で起動してから送る
   - 上限が回復したら（codex の画面の weekly limit の表示で確かめる）Codex に戻す。Claude 5 は戻した後に止めてよい
   - 上限以外の Codex の不調（接続など）の代わりも Claude 5（`--instance claude-5`）。Antigravity には頼まない
   - `codex-2` は `codex` と同じアカウントの上限を共有するので、上限の対策にならない（stream disconnected のような個別の不調で `codex-2` へ振り替えるのは従来どおり）
8. **見通しは実績の率で幅を出す。** 「次のレビューで指摘が出なければ」という条件つきの最短を予測として伝えない。残りの往復の見込み（台帳と整合性レビューの記録から）× 1 往復の時間（verify の待ち＋実行＋レビュー）で幅を出し、最短と見込みを分けて書く。分かっている制約（夜の計測・期限・1 人のリーダーを通る直列・CI の不安定）は最初から入れる。見通しを変えたら、何が外れたかを 1 行添える。なぜ: 条件が外れるたびに終わりが延び、後ろ倒しに見えた
9. **「使っていない」「同じ条件だ」「生きている」を、外れうる観測から推測して許可に使う設計は、同じ種類の 2 回目で形を変える。** Sprint 7 で 3 本が同じ形で止まった: #4430（生成物の片付け。lstart・server の行・名前・親の死から不使用を推測）、#4432 案 A（合格の使い回し。並列の設定・途中の作業ツリー・未申告の入力が同じと推測）、#4459（busy 待ち。秒数・欄の変化から run の生存を推測）。観測を足して塞ぐのをやめ、(a) 推測を人の確認に置き換える（#4430 → 人の確認で消すコマンド）、(b) 推測が外れても安全側に倒れる範囲にだけ使う（観測は「残す」「待つ」側にだけ効かせる）、(c) 生存・同一を示す専用の印を作る（#4463 の心拍）、のどれかに設計を替える。外れたら合格になる・消える・打ち切る向きの推測は、ゲートと受入条件を弱めることになる

## 7. WIP の上限とレーンの組み方

- PM はレーンを足す前に未マージのブランチ数を数える（`node scripts/orchestrate/flow-wip.mjs check`。exit 60 なら上限で、新しいレーンを入れずマージを先にする。上限は `.commandmate/flow.yaml` の `wip.total`）
- 作る速さがマージの速さを超えると、開いた PR が溜まり、CI 1 回が長くなって、さらにマージが遅れる。PM は返しを待つだけでなく、定期的に「直近 1 時間のマージ数・開いた PR 数・ランナーの online 数・queued の最古」を見る。online 0 か queued 10 分超なら、ランナーの健康を先に確かめる（docs/orchestrate/ci-merge.md の「6-3 CI が queued のまま進まないとき」）
- 着手・再開・報告のたびに、残りの Issue を「書くファイル」で分け、重ならないものと設計（読むだけ）は別レーンで同時にリーダーへ渡す。直列にするのは同じファイルを書くものと、統合の後でないと書けないものだけ。目安は 3 レーン（PM が結果を確かめきれる数とリーダーのコンテキストが上限。WIP の上限も守る）。重い検証の待ちが詰まるときは、CPU を使わない設計・レビュー・調査を前に倒す。見込みは並列にした場合の完了時刻で報告する

## 8. 依頼ごとの完了の見張り

- PM の依頼は `pm-send.ts` で送る（§3）。返事は relay で PM の入力欄に届くので、それが主の合図。見張りは従
- 依頼（ワーカー・イネーブラー・CI）を送ったら、同じ手番で期限の無い完了の見張りを張る。`DONE:` / `WAIT:` / `STOP:` 行（または返しのファイルのその行）が出たら終わる待ちにする。期限で切れる見張りを張り直す運用にしない
- 見張りはペインの全行を読む（`capture --pane --tail N` の末尾 N 行には、`DONE:` 行の後に出た出力・入力欄・フッタが並び、`DONE:` 行が入らないことがある）。画面が長く変わらなければ STALL として知らせる。依頼文の締めに「最後の行は `DONE: <要約>` / `WAIT: <了承・判断待ちの内容>` / `STOP: <task> <理由>` のどれか」を必ず入れる（了承・判断を待つときは `WAIT:` で止まり、`DONE:` と書かない）
- 見張りの除外の規則を自作しない（雛形どおりに書いた本物の `DONE:` 行まで除いてしまう）。`DONE:` 行の形は依頼文で決め、見張りではその形で絞る。見張りを張ったら、`DONE:` が既にある画面で一度鳴ることを確かめる
- CI は `bucket` が全部終わるまでを待ち、10 分以上 queued ならランナーが online かも見る。動いている依頼と見張りの一覧をいつでも出せるようにしておく

## 9. 受け入れのまとめ方と計画の決まり（Issue #4434、段 7 の決まり）

受け入れ（UAT）は、準備と片付けの固定の時間を 1 回で済ませるため、**リリースの前に 1 回まとめて行う**。そのうえで所要時間を短くする。人の決定: 2026-11-16。

1. **独立した 2〜3 本に分けて並行で行う（A）。** 例: 画面／API・CLI・tick／本物のエージェント。主のジャッジ（`claude-2`）のほかに、作業に関わっていない新しいセッションを立てる（ロール `judge`）。**ケースと合否の基準は変えない**（分けるのは担当だけ）。各本は結果を返し、**主のジャッジが結果をまとめて判定**し、PM → 開発リーダーの順で返す（§5）。ブラウザーは本ごとに新しい文脈で開く
2. **機械で決まるケースはスクリプトにする（B）。** API・CLI・tick のように合否が exit code と出力で決まるケースは、受け入れでは流して結果を見る。ここに書くのは書き方だけで、スクリプトは別の PR（今回は作らない）
3. **E2E との重複の整理は、入れる前に人へ伺う（C）。** CI の E2E が同じ入口で確かめたケースは結果の確認にとどめ、ジャッジを E2E が見ていないところ（本物のエージェント・統合した版・スマホの幅・複数の Issue の組み合わせ）に絞る案。受入条件の確かめ方が変わるので、PM が人の了承を取り、記録が残るまで入れない
4. **隔離の環境（ビルド・試験用のリポジトリとデータ）は使い回せる形にする（D）。** 本ごとに作り直さず、同じ版のビルドと試験用データを使い回す。使い回し方の実装は別の PR
5. **計画の段階の決まり: 同じ画面・同じファイルを書く Issue は 1 人のワーカーに 1 本の PR（Issue ごとにコミット）としてまとめる。** 別のワーカーに分けて直列にすると待ちが積み重なる（段 5 で `/sessions` の 3 本を直列にして約 19 時間かかった）。計画の表の「書くファイル」で重なりを見て決める（orchestrate.md 1-4・plan-check.md）

実績（数字は台帳 `workspace/orchestration/runs/2026-11-17/pm-ledger-s6.md`（追跡されない置き場所で、main のチェックアウトにしか無い）から。推測で埋めない）:

| | 所要 | 備考 |
|---|---|---|
| 前（計画） | 約 5.5 時間 | 段 5 後半の計画。ビルドと準備 30 分・画面 2 時間・API と RG 1 時間・tick 45 分・本物のエージェント 45 分・片付けと報告 30 分。ジャッジ 1 人が 40 余りのケースを順に通す。**計画値で、実測ではない** |
| 受け入れ 1（11-17、並行の分けを試した） | 14:51〜15:21（約 30 分） | 版 47a03b7c0。T2・T3 の新しいセッション（claude-6・claude-7）は 15:1x に起動。ケース数・本ごとの時間は未計測 |
| 受け入れ 2（11-18 未明） | 00:27 開始〜01:08 まとめ DONE（約 41 分） | 版 6535f8b29。主のジャッジ（本 1。まとめを兼ねる）と新しい 1 本（本 2、00:54 に DONE）の 2 本。全件合格は差し戻しの再判定（08:30）まで。本ごとのケース数は未計測 |

「前後を比べた数字」のうち、同じケース数・同じ範囲で測った前後の比は**未計測**（前は計画値、受け入れ 1・2 はケース数が違う）。次のリリースから、受け入れの依頼に「本ごとのケース数・開始と終了の時刻」を書かせて測る。

### 受け入れの間のマージの凍結

判定する版を決めるのは PM。**受け入れ・リリースの間も develop へのマージは続ける**（人の決定、mem c31afe28）。止めるのは、**main への PR を作ってから、マージバック（main の変更を develop へ戻すマージ）が済むまで**だけで、PM が「停止」「再開」を全リーダーへ 1 行で知らせる。止めている間もレビュー・直し・verify は続けてよい。判定する版（commit）は固定し、その後に develop へ入ったものは次の受け入れの対象になる。関門は変えない（根拠は ci-merge.md の 6-2-1）。

## 10. 開発リーダー 2 人で回す決まり（段 7、PM の採用: 2026-11-17）

根拠: `workspace/orchestration/runs/2026-11-17/leader2-onboarding.md` §2 と `pm-reply-leader2-rules.md`。

1. **持ち分の表。** PM が計画で、Issue ごとに「書くファイル（glob）」と「境界の持ち主」の列を持つ表を書く。既定の分け方は、画面＝`src/app` の画面・`src/components`・`src/hooks`／CLI・サーバー＝`src/cli`・`src/app/api`・`src/lib`。持ち分の外を書く必要が計画の後に分かったら、書かずに STOP で返す
2. **境界のファイルは Issue ごとに 1 人の持ち主を決める。** 共有の型（`src/types/**`・`src/cli/types/api-responses.ts`）・API の呼び口（`src/lib/api-client*.ts`）・DB の migration（版の番号は計画で割り当てる）・試験の基盤（`tests/setup.ts`・`tests/helpers/**`・`vitest.config.ts`）・文言（`locales/{ja,en}/*.json`）・文書（`docs/module-reference.md`・`docs/user-guide/cli-operations-guide.md`・`.env.example`）。持ち主でないリーダーのワーカーは書かない。changelog は Issue ごとの断片なので持ち分の対象にしない。API を変える Issue と、それを呼ぶ画面の Issue は同じリーダーの同じ PR にするか、API を先にマージする直列にする。もう 1 人のリーダーの未マージのブランチの上でブランチを切らない（土台のマージの後に develop から切る）
3. **マージの順と積み直しの持ち主。** マージは各リーダーが自分の PR を自分で流す（ロックの先着順に任せ、待ち合わせのシェルを自作しない）。**積み直し（develop の取り込み・衝突の解消・precheck・merge-pr の exit 4 の再実行）の持ち主は、後からマージする PR のリーダー**。衝突の解消で相手の持ち分のファイルの意味を変える必要があれば、解消せずに止めて PM に返す。統合破壊は後からマージした側が直す。マージのたびに develop の push CI の結論を見て、赤なら 2 人とも次のマージを止める。「CI が通れば」の許可の run では全 PR に `--last` を付ける。列（`--queue`）には条件がそろった PR だけを 1 回に 2〜3 本まで入れる
4. **単体テストの mutex（`cpu.heavy`）の取り合い。** mutex はマシンで 1 本のまま、リーダーで分けない。重いゲートを走らせる人を減らす（リーダーは同じ tree・同じ環境の合格を再利用し、重ねて流さない）。2 人合わせて同時のワーカーは 5〜6 本以下。verify の待ちは 1 本あたり 30〜45 分を見込みに入れる（#4467 の後、手元の `unit-related` は src・tests 以外の変更でもテスト全体に切り替わらず `mode=related reason=non-source:<ファイル>` で流れる。全体は CI の `Unit Tests` が見る。ci-merge.md の「テスト全体と unit-related の分け方」）。同じ worktree の古いコミットの run を列に残さない。列の順を変える手段は無いので、急ぐレーンがあるときは PM が両リーダーに新しい verify を控えてもらう。exit 99（待ち切り）はテストの不合格にせず、`--mutex-retries` で並び直す。ゲートのコマンドを worktree で直に流すのは調べるためだけ（直の実行は verify の mutex・work-evidence・scope・env-clean を通らない）。マシンで 1 度に 1 本、PM へ 1 行知らせてから流す。**合否の裁定は verify の run で行い、直の実行の結果を裁定に使わない**（ci-merge.md の mutex の節）
5. **受け入れの間のマージ。** §9 のとおり（止めるのは main への PR からマージバックまで。それ以外は develop へのマージを続ける）。2 人の成果は統合した develop の 1 つの HEAD で 1 回の受け入れにまとめる。差し戻しは Issue の持ち主のリーダーへ PM が振り分ける
6. **同じ種類の指摘の一覧（`workspace/orchestration/same-kind-findings.md`）を、リーダーは依頼文を書く前に読む。** 片方のリーダーで 1 回目が出た種類は、もう片方の依頼文にも最初から不変条件として書く（2 人で数えを共有する）。2 回目は直しを送らず STOP で PM に返す

## 11. mem の運用規則

mem は許可・決定・作業の状態・次の一手・人への質問の置き場（CLAUDE.md「記憶の書き場所」、コマンドは docs/user-guide/cli-operations-guide.md の mem の節）。次の 3 つを守る。

1. **ジャッジ（審判）のセッションは、起動した人（PM・リーダー）が起動の後に `/effort high` を送る。** 推論の強さの決定（mem の決定 4c98e7a4、人 11-18）: codex は high 既定・高リスクのレビューだけ xhigh。審判 high、開発リーダー・イネーブラー medium。`/effort` で稼働中でも変えられる。並行の本の新しいセッション（§9）の審判にも同じく送る。開発リーダー・イネーブラーの medium も、起動した人が起動の後に `/effort medium` を送る。**codex は例外（決定 c31c6c68、人 11-18）**: codex（gpt-6.2-sol）には `/effort` が無い（送ると `Unrecognized command '/effort'` が出て、入力欄に文字が残り、次の依頼がその後ろに打たれる）。effort は人が codex の画面の `/model` で選ぶしかないので、codex は high のまま使い、xhigh へは切り替えない。高リスクのレビューは codex（high）に、新しい文脈の Claude opus のレビューを 1 本足して補う。次の起動の既定は `~/.codex/config.toml` の `model = "gpt-6.2-sol"`・`model_reasoning_effort = "high"`
2. **mem の決定には行き先を付ける。** `commandmate mem add --kind decision … --promote-to issue:#N`（または `pr:#N`、リポジトリからの相対の `path:<docs の .md ファイル>`）。決定の行き先は該当する Issue、docs に残す規則なら path。path は `.md` のファイルを名指す（ディレクトリは画面から記録できない）。行き先の無い `open` の決定は `mem check --suggest` が `decision_no_destination` と出す（対象は自分の項目だけ）。書き込みは人が画面で承認したときだけ（CLI に書く口は無い）
3. **path（docs）を行き先にした決定は、その docs の PR で反映する。** 反映の記録は画面の流れで行う（人が差分を承認 → `recorded` → 正本へ反映したことを確かめて `promoted`）。`mem close` で閉じられるのは決定を書いた instance か人（画面）だけで、ほかの instance（PM が他人の決定を閉じる場合を含む）は exit 55（`not_owner`）。`recorded` になった後は `mem close` も断られる。docs の PR のマージ後、PM が人へ画面での記録を頼む。反映していない決定を閉じない

## 12. 反映済みの決定

- 決定 4c98e7a4: 推論の強さ（審判 high など）を §11 の 1 に反映した（#4460）。行き先は `path:docs/orchestrate/team.md`
- 決定 89aee71f: `merge-pr` は `--last` が無いと `Build`・`Unit Tests` だけを待つ（それぞれ例外の条件のとき）。E2E を含む全チェックの合格が条件のマージには `--last` を付ける。中身は ci-merge.md の「6-2 「CI が通れば」の許可と全チェックの合格」に反映した（#4460）。この決定の行き先は `path:docs/orchestrate/`（ディレクトリ）で画面から記録できないため、人が行き先を `.md` のファイルに直すか、PM が人へ伝えて閉じ方を決める

- 決定 c31c6c68: codex は high のまま、高リスクのレビューは Claude opus を 1 本足す（§11 の 1 に反映。develop へ直接、人 11-19 の許可）

## 13. Sprint・Milestone・ロードマップ（人の決定 2026-11-18、mem c1bb26d2）

- 段 7 以降の段を Sprint N と呼ぶ。Sprint ごとにリリースで閉じる（リリースは人の承認）
- 管理は GitHub の Milestone（`Sprint 7`〜`Sprint 13`）と、ロードマップの Issue #4461。Sprint の並び・理由・保留の条件・変更の履歴は #4461 に書き、Issue の割り当ては Milestone で持つ
- 段の途中で起こす追跡の Issue は、次の Sprint の Milestone を付ける（`gh issue create … --milestone "Sprint 8"`）
- Sprint に Issue を足す・外すのは人の判断（承認された範囲の変更）。PM は理由と推奨をつけて聞き、決まったら Milestone を移し、#4461 に変更をコメントで残す
- 再起動の後は、#4461・今の Sprint の Milestone・PM の台帳（`workspace/orchestration/runs/<日付>/pm-ledger-s<N>.md`）・`commandmate brief` の順に読み直す

## Antigravity の扱い

2026-11-16 から、私たちの運用では AI（PM・ジャッジ・リーダー・ワーカー・イネーブラー）から Antigravity（agy）を使わない。理由: Google Antigravity 追加利用規約 6 条と公式 FAQ（https://antigravity.google/terms ・ https://antigravity.google/docs/faq ）が、個人向けプランで第三者のソフトウェア・エージェントを通して Antigravity を使うことを制限している。私たちのサインインは個人向けプラン。

- `send`・`ask`・`respond`・relay・`/orchestrate` の宛先に antigravity を選ばない。Schedule・日次サマリー・agent-health の対象にしない。antigravity の instance に Auto-Yes を入れない。`agy --version` などの読み取りも AI からは実行しない
- agy の動きの試験は偽の agy（隔離のサーバー）で行う。本物が要る場面は人が端末で手で行い、結果を渡す
- 製品側の既定の拒否と利用上の注意は、それぞれの Issue で進める

