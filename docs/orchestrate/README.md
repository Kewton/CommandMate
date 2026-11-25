# 運用の文書の索引（docs/orchestrate）

開発体制（PM・開発リーダー・ワーカー・審判・イネーブラー）の各ロールが、場面ごとに何を読めばよいかの索引です。
この文書には規則を書きません。規則と数は、下の表のリンク先にだけあります。

- **カード**: その場面で必ずすることの数行。ロールの正本 [roles/](roles/project-manager.md) の「場面ごとに必ずすること」の節です（#4548）。正本の場面の節に無い場面は、正本の別の節を指します。ワーカーにはロールが無く、カードは契約の雛形 [goal.md](../../scripts/orchestrate/templates/goal.md) です
- **参照**: 数・上限・コマンド・手順。運用文書（このディレクトリの各ファイル）と `/orchestrate` の本体 [orchestrate.md](../../.claude/commands/orchestrate.md) の節です

## 置き場の原則

- 規則は 1 か所に書く。ほかの場所からはリンクで指し、文を写さない（カードは正本、運用の細部は運用文書の 1 つの節）
- 数とコマンドは参照（運用文書）に置く。カードは「運用文書の上限」のように指すだけで、数を書き写さない
- 日付つきの実測と判断の物語は経緯として分けて置き、規則の文に混ぜない

## 読み手 × 場面

場面: 着手（始める前の確かめ）・依頼（頼む・頼まれる）・見張り・裁定（合否と止める判断）・マージ・受け入れ・振り返り。
セルは「カード」と「参照」。当てはまる節が無いところは、無いことと理由を書いています。

### PM

| 場面 | カード（正本の節） | 参照（運用文書の節） |
|---|---|---|
| 着手 | [計画を人に出す前・レーンやワーカーを足す前（着手の確かめ）](roles/project-manager.md#場面ごとに必ずすること)・[重い検証（排他のロックを取るもの）の順番](roles/project-manager.md#場面ごとに必ずすること) | [team.md §7 WIP の上限とレーンの組み方](team.md#7-wip-の上限とレーンの組み方)・[team.md §10-4 重い検証の取り合い](team.md#10-開発リーダー-2-人で回す決まり段-7pm-の採用-2026-11-17)・[verify-queue.md 待ち・列・直の実行](verify-queue.md#待ち列直の実行)・[verify-queue.md 同時のワーカーの上限](verify-queue.md#同時のワーカーの上限)・[verify-queue.md 手で始める重い検証と控え・PM の保留](verify-queue.md#手で始める重い検証と控え)・[ci-merge.md 6-1-1 マシンの資源の枠](ci-merge.md#6-1-1-マシンの資源の枠resourceyaml-と-status) |
| 依頼 | [ワーカーに伝えたいことがあるとき](roles/project-manager.md#場面ごとに必ずすること)・[人から別件・割り込みが来たとき](roles/project-manager.md#場面ごとに必ずすること)・[タスクの書き方](roles/project-manager.md#タスクの書き方) | [team.md §2 流れ](team.md#2-流れ)・[team.md §3 ブリーフ](team.md#3-pm-から開発リーダーへのブリーフ) |
| 見張り | [動いている間](roles/project-manager.md#場面ごとに必ずすること)・[人の答えを待つとき](roles/project-manager.md#場面ごとに必ずすること) | [team.md §8 依頼ごとの完了の見張り](team.md#8-依頼ごとの完了の見張り)・[workers.md 3-2 返しの形と見張りが起きるとき](workers.md#3-2-返しの形と見張りが起きるとき)・[ci-merge.md 6-3 マージの流れを定期的に見る](ci-merge.md#6-3-マージの流れを定期的に見る)・[workers.md 3-2 見張りが pane を読む細部](workers.md#3-2-完了の見張りが-pane-を読む細部)・[ci-merge.md 6-3 CI が queued のまま進まないとき](ci-merge.md#6-3-ci-が-queued-のまま進まないとき) |
| 裁定 | [STOP の裁定の合間](roles/project-manager.md#場面ごとに必ずすること)（動いている間。待ち切れのときの投入の保留と順番の見直し）。場面の節の外は [判断の基準](roles/project-manager.md#判断の基準)・[進め方](roles/project-manager.md#進め方) | [team.md §6 直しとレビューを収束させる規則](team.md#6-直しとレビューを収束させる規則)・[verify-queue.md 見通しを実績の率で幅を出す](verify-queue.md#見通しを実績の率で幅を出す)・[difficulty.md 1-2b 易しい bug の速い道](difficulty.md#1-2b-易しい-bug-の速い道)・[verify-queue.md PM の保留の指示](verify-queue.md#pm-の保留の指示) |
| マージ | 当てはまる節は無い（誰がマージを流すかは [team.md §10-3](team.md#10-開発リーダー-2-人で回す決まり段-7pm-の採用-2026-11-17)・[multi-lead.md マージの順と積み直し](multi-lead.md#マージの順と積み直し)。受け入れ中のマージの止めと再開は参照の節） | [team.md §9 受け入れ・リリースの間のマージ](team.md#受け入れリリースの間のマージ続ける止めるのは-main-への-pr-からマージバックまで)・[ci-merge.md 6-2-1](ci-merge.md#6-2-1-受け入れリリースの間の-develop-へのマージ)・[ci-merge.md 6-2 道具を変えた PR のマージの後](ci-merge.md#6-2-道具を変えた-pr-のマージの後) |
| 受け入れ | [受け入れを頼むとき](roles/project-manager.md#場面ごとに必ずすること)・[人に確かめ（本物の環境での操作など）を頼むとき](roles/project-manager.md#場面ごとに必ずすること) | [team.md §9 受け入れのまとめ方](team.md#9-受け入れのまとめ方と計画の決まりissue-4434段-7-の決まり)・[team.md §5 UAT の結果の返し方](team.md#5-uat-の結果の返し方phase-7) |
| 振り返り | [区切り（Sprint など）の終わり](roles/project-manager.md#場面ごとに必ずすること) | [team.md §13 Sprint・Milestone・ロードマップ](team.md#13-sprintmilestoneロードマップ人の決定-2026-11-18mem-c1bb26d2)・[history.md 運用の経緯](history.md) |

### 開発リーダー

| 場面 | カード（正本の節） | 参照（運用文書の節） |
|---|---|---|
| 着手 | [ワーカー・設計の subagent を起動する直前](roles/dev-leader.md#場面ごとに必ずすること)・[難易度とワーカー](roles/dev-leader.md#難易度とワーカー) | [orchestrate.md 1-2b 難易度判定と担当割当](../../.claude/commands/orchestrate.md#1-2b-難易度判定と担当割当)・[team.md §10-1〜3 持ち分の表](team.md#10-開発リーダー-2-人で回す決まり段-7pm-の採用-2026-11-17)・[multi-lead.md 持ち分の細部](multi-lead.md)・[multi-lead.md 境界のファイル](multi-lead.md#境界のファイル)・[difficulty.md 1-2b 易しい bug の速い道](difficulty.md#1-2b-易しい-bug-の速い道)・[plan-check.md 1-4 共有状態の表](plan-check.md#1-4-共有状態の表を書く理由)・[verify-queue.md 同時のワーカーの上限](verify-queue.md#同時のワーカーの上限) |
| 依頼 | [ワーカーへの依頼文を書く前](roles/dev-leader.md#場面ごとに必ずすること)・[手戻りを最初の 1 回で減らす](roles/dev-leader.md#手戻りを最初の-1-回で減らす2026-11-16-追記) | [orchestrate.md 2-4 実行契約の起案](../../.claude/commands/orchestrate.md#2-4-実行契約の起案)・[contract.md 委任の前に本文の前提を確かめる](contract.md#2-4-委任の前に本文の前提を確かめる)・[workers.md 3-1 send とワーカーの起動の exit code](workers.md#3-1-send-とワーカーの起動の-exit-code)・[multi-lead.md 同じ種類の指摘の一覧](multi-lead.md#同じ種類の指摘の一覧) |
| 見張り | [見張るとき](roles/dev-leader.md#場面ごとに必ずすること) | [team.md §8 依頼ごとの完了の見張り](team.md#8-依頼ごとの完了の見張り)・[workers.md 3-2 返しの形と見張りが起きるとき](workers.md#3-2-返しの形と見張りが起きるとき)・[workers.md 3-2 見張りが pane を読む細部](workers.md#3-2-完了の見張りが-pane-を読む細部)・[workers.md 3-2 monitor の起動と読み方](workers.md#3-2-monitor-の起動と読み方)・[orchestrate.md 3-3 完了待機と検証](../../.claude/commands/orchestrate.md#3-3-完了待機と検証wait---verify) |
| 裁定 | [重い検証（排他のロックを取るもの）を手で始めるとき](roles/dev-leader.md#場面ごとに必ずすること)・[同じ種類の指摘が 2 回目に出たとき](roles/dev-leader.md#場面ごとに必ずすること)・[報告](roles/dev-leader.md#報告) | [orchestrate.md 3-4 exit code 分岐](../../.claude/commands/orchestrate.md#3-4-exit-code-分岐)・[exit-codes.md](exit-codes.md)・[team.md §6-6 同じ種類の 2 回目](team.md#6-直しとレビューを収束させる規則)・[multi-lead.md 同じ種類の指摘の一覧](multi-lead.md#同じ種類の指摘の一覧)・[switching.md 担当の切り替え](switching.md)・[verify-queue.md 手で始める重い検証と控え](verify-queue.md#手で始める重い検証と控え)・[verify-queue.md PM の保留の指示](verify-queue.md#pm-の保留の指示) |
| マージ | 場面の節には無い。[権限](roles/dev-leader.md#権限) | [orchestrate.md 6-2 マージの順](../../.claude/commands/orchestrate.md#6-2-マージは先行をマージ--後続を-refresh--tsc--影響テスト--マージ)・[ci-merge.md 6-2 マージの列](ci-merge.md#6-2-マージの列--queue)・[multi-lead.md マージの順と積み直し](multi-lead.md#マージの順と積み直し)・[run-log.md 1-5 記録の中身](run-log.md#1-5-記録の中身と-next-の決まり) |
| 受け入れ | 当てはまる節は無い（受け入れは PM 経由で審判に頼み、自分で合否を出さない）。[チームとの分担](roles/dev-leader.md#チームとの分担) | [team.md §9 受け入れ・リリースの間のマージ](team.md#受け入れリリースの間のマージ続ける止めるのは-main-への-pr-からマージバックまで)・[ci-merge.md 6-2-1](ci-merge.md#6-2-1-受け入れリリースの間の-develop-へのマージ)・[team.md §5 UAT の結果の返し方](team.md#5-uat-の結果の返し方phase-7) |
| 振り返り | 当てはまる節は無い（区切りの振り返りは PM が書く。リーダーは run の区切りごとに返す）。[報告](roles/dev-leader.md#報告) | [orchestrate.md 8-2 結果レポート](../../.claude/commands/orchestrate.md#8-2-結果レポート)・[orchestrate.md 8-3 振り分けの改善案](../../.claude/commands/orchestrate.md#8-3-振り分けの改善案)・[report.md](report.md) |

### ワーカー

ワーカーにはロールの正本が無い。カードは契約の雛形（`scripts/orchestrate/templates/goal.md`）の節。

| 場面 | カード（契約の雛形の節） | 参照（運用文書の節） |
|---|---|---|
| 着手 | [実装の進め方](../../scripts/orchestrate/templates/goal.md#実装の進め方) | 当てはまる節は無い（ワーカーは契約の goal だけを読む） |
| 依頼 | [作業ルール（厳守）](../../scripts/orchestrate/templates/goal.md#作業ルール厳守) | 当てはまる節は無い（ワーカーは契約の goal だけを読む） |
| 見張り | 当てはまる節は無い（ワーカーは見張られる側。返しの行の形は [作業ルール（厳守）](../../scripts/orchestrate/templates/goal.md#作業ルール厳守) の最後） | [team.md §8 依頼ごとの完了の見張り（返しの形）](team.md#8-依頼ごとの完了の見張り)・[workers.md 3-2 返しの形と見張りが起きるとき](workers.md#3-2-返しの形と見張りが起きるとき) |
| 裁定 | 当てはまる節は無い（ワーカーは裁定しない。自己確認は [実装の進め方](../../scripts/orchestrate/templates/goal.md#実装の進め方) の 4） | [exit-codes.md 3-4 20 の対応](exit-codes.md#3-4-20-の対応) |
| マージ | 当てはまる節は無い（push・PR・マージはしない。[作業ルール（厳守）](../../scripts/orchestrate/templates/goal.md#作業ルール厳守)） | 当てはまる節は無い（ワーカーは契約の goal だけを読む） |
| 受け入れ | 当てはまる節は無い（受け入れは統合した版を審判が見る） | 当てはまる節は無い（ワーカーが読む受け入れの参照は無い） |
| 振り返り | 当てはまる節は無い（振り返りは PM が書く） | 当てはまる節は無い（ワーカーの担当の改善は開発リーダーの [orchestrate.md 8-3](../../.claude/commands/orchestrate.md#8-3-振り分けの改善案)） |

### 審判

| 場面 | カード（正本の節） | 参照（運用文書の節） |
|---|---|---|
| 着手 | [依頼を受けたとき（計画を作る前）](roles/judge.md#場面ごとに必ずすること)・[計画（成果を見る前に固める）](roles/judge.md#計画成果を見る前に固める) | [team.md §9 受け入れのまとめ方](team.md#9-受け入れのまとめ方と計画の決まりissue-4434段-7-の決まり)・[verify-queue.md 手で始める重い検証と控え・PM の保留](verify-queue.md#手で始める重い検証と控え) |
| 依頼 | [人に確かめてもらうケースがあるとき](roles/judge.md#場面ごとに必ずすること) | [team.md §2 流れ（依頼は PM から）](team.md#2-流れ) |
| 見張り | 当てはまる節は無い（審判は見張らない。自分の run が起こしたものの記録は [隔離の環境（サーバー・端末）を起こすたび](roles/judge.md#場面ごとに必ずすること)） | 当てはまる節は無い（見張りの参照は PM と開発リーダーのもの） |
| 裁定 | 場面の節には無い。[判定と報告](roles/judge.md#判定と報告)・[独立であること](roles/judge.md#独立であること崩れたら判定しない) | [team.md §9-1 並行の本と主のまとめ](team.md#9-受け入れのまとめ方と計画の決まりissue-4434段-7-の決まり)・[orchestrate.md 7-2 UAT 結果判定](../../.claude/commands/orchestrate.md#7-2-uat結果判定) |
| マージ | 当てはまる節は無い（マージしない。[やらないこと](roles/judge.md#やらないこと)） | [team.md §9 受け入れ・リリースの間のマージ](team.md#受け入れリリースの間のマージ続ける止めるのは-main-への-pr-からマージバックまで)・[ci-merge.md 6-2-1](ci-merge.md#6-2-1-受け入れリリースの間の-develop-へのマージ) |
| 受け入れ | [隔離の環境（サーバー・端末）を起こすたび](roles/judge.md#場面ごとに必ずすること)・[終わるとき](roles/judge.md#場面ごとに必ずすること)・[実行](roles/judge.md#実行) | [orchestrate.md 7-1 受入テスト実行](../../.claude/commands/orchestrate.md#7-1-受入テスト実行)・[uat-isolation.md](../user-guide/uat-isolation.md)・[team.md §5 UAT の結果の返し方](team.md#5-uat-の結果の返し方phase-7) |
| 振り返り | 当てはまる節は無い（振り返りは PM が書く） | 当てはまる節は無い（審判が書く振り返りの参照は無い） |

### イネーブラー

| 場面 | カード（正本の節） | 参照（運用文書の節） |
|---|---|---|
| 着手 | [依頼を受けたとき](roles/enabler.md#場面ごとに必ずすること)・[受ける仕事の種類](roles/enabler.md#受ける仕事の種類) | [team.md §1 役割](team.md#1-役割)・[team.md §2 流れ（高難易度の判断のレビュー）](team.md#2-流れ)・[verify-queue.md 手で始める重い検証と控え・PM の保留](verify-queue.md#手で始める重い検証と控え) |
| 依頼 | [人の別件（割り込み）を PM から受けたとき](roles/enabler.md#場面ごとに必ずすること)・[実物を動かして確かめるとき](roles/enabler.md#場面ごとに必ずすること)・[種類ごとの出力](roles/enabler.md#種類ごとの出力) | [orchestrate.md 2-4-4 事前レビュー](../../.claude/commands/orchestrate.md#2-4-4-新しい仕組みの設計の事前レビュー)・[trials.md 2-4-4 事前レビューの書き方と記録](trials.md#2-4-4-事前レビューの書き方と記録)・[trials.md 5-2b 整合性レビューの進め方と記録](trials.md#5-2b-整合性レビューの進め方と記録) |
| 見張り | 当てはまる節は無い（イネーブラーは見張らない） | 当てはまる節は無い（見張りの参照は PM と開発リーダーのもの） |
| 裁定 | 当てはまる節は無い（合否は出さない。[やらないこと](roles/enabler.md#やらないこと)） | [trials.md 5-2b 終了コードと記録の条件表](trials.md#5-2b-終了コードと記録の条件表) |
| マージ | 当てはまる節は無い（マージしない。[やらないこと](roles/enabler.md#やらないこと)） | 当てはまる節は無い（イネーブラーが読むマージの参照は無い） |
| 受け入れ | 当てはまる節は無い（受け入れの判定は審判。[やらないこと](roles/enabler.md#やらないこと)） | 当てはまる節は無い（イネーブラーが読む受け入れの参照は無い） |
| 振り返り | 当てはまる節は無い（振り返りは PM が書く。計画の容量の確かめは [種類ごとの出力](roles/enabler.md#種類ごとの出力)） | 当てはまる節は無い（イネーブラーが書く振り返りの参照は無い） |

## 文書の一覧

ロールの正本（カード）:
- [roles/project-manager.md](roles/project-manager.md)・[roles/dev-leader.md](roles/dev-leader.md)・[roles/judge.md](roles/judge.md)・[roles/enabler.md](roles/enabler.md)

運用文書（参照）:
- [team.md](team.md) — 開発体制。役割・流れ・収束の規則・WIP・見張り・受け入れ・リーダーの持ち分・mem・Sprint
- [verify-queue.md](verify-queue.md) — 重い検証の順番（待ち・列・直の実行・同時のワーカーの上限・手で始めるときの控え・PM の保留・見通しの幅。team.md §10-4・§6-8 の細部）
- [multi-lead.md](multi-lead.md) — 複数のリーダーの持ち分の細部（team.md §10 の 1・2・3・6）
- [agent-health-dispatch.md](agent-health-dispatch.md) — agent-health の依頼と claude-3 の予約の手順（team.md §4 の細部）
- [ci-merge.md](ci-merge.md) — PR とマージ（同時の本数・precheck・重い検証の資源・マージの列・CI の対処・断片の一本化・受け入れ中のマージ〈team.md §9〉・マージの流れの見張り〈team.md §7〉）
- [contract.md](contract.md) — 契約の起案（goal・scope・断片・静的ガードの試験）
- [workers.md](workers.md) — ワーカーへの送信と監視（返しの形と見張りが起きるとき〈team.md §8〉を含む）
- [exit-codes.md](exit-codes.md) — exit code ごとの対処
- [run-log.md](run-log.md) — run の記録
- [plan-check.md](plan-check.md) — 共有状態・経路・重い検証の計画時の検査
- [difficulty.md](difficulty.md) — 難易度の判定（1-2b）の根拠・易しい bug の速い道（team.md §6-10）
- [trials.md](trials.md) — 試行中の段（事前レビュー・整合性レビュー）
- [switching.md](switching.md) — 担当の切り替え
- [command-code.md](command-code.md)・[antigravity.md](antigravity.md) — 担当ごとの運用メモ（antigravity.md の冒頭は、私たちの運用で AI から使わない方針）
- [refactor.md](refactor.md) — 整理の Issue
- [report.md](report.md) — 完了報告

経緯（規則ではない）:
- [history.md](history.md) — 規則の文書から移した、日付つきの実測と判断の物語（元の節つき）
