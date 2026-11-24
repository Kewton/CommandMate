# 複数のリーダーで回すときの持ち分の細部

元の場所: [team.md](team.md) §10（#4546 で移した。PR-2 は文を元のまま、#4546 PR-4 で §10 の 2・3・6 を移した。文は元のまま）。規則の題は team.md §10 に残っている。§10 の 2・3・6 の本文はこのファイルにある。

## 根拠

元の場所: team.md §10（冒頭）

根拠: `workspace/orchestration/runs/2026-11-17/leader2-onboarding.md` §2 と `pm-reply-leader2-rules.md`。

## 既定の分け方

元の場所: team.md §10 の 1

既定の分け方は、画面＝`src/app` の画面・`src/components`・`src/hooks`／CLI・サーバー＝`src/cli`・`src/app/api`・`src/lib`。

## 境界のファイル

元の場所: team.md §10 の 2

共有の型（`src/types/**`・`src/cli/types/api-responses.ts`）・API の呼び口（`src/lib/api-client*.ts`）・DB の migration（版の番号は計画で割り当てる）・試験の基盤（`tests/setup.ts`・`tests/helpers/**`・`vitest.config.ts`）・文言（`locales/{ja,en}/*.json`）・文書（`docs/module-reference.md`・`docs/user-guide/cli-operations-guide.md`・`.env.example`）。

元の場所: team.md §10 の 2（#4546 で移した。文は元のまま）

一覧は [multi-lead.md](multi-lead.md#境界のファイル)。持ち主でないリーダーのワーカーは書かない。changelog は Issue ごとの断片なので持ち分の対象にしない。API を変える Issue と、それを呼ぶ画面の Issue は同じリーダーの同じ PR にするか、API を先にマージする直列にする。もう 1 人のリーダーの未マージのブランチの上でブランチを切らない（土台のマージの後に develop から切る）

## マージの順と積み直し

元の場所: team.md §10 の 3（#4546 で移した。文は元のまま）

マージは各リーダーが自分の PR を自分で流す（ロックの先着順に任せ、待ち合わせのシェルを自作しない）。**積み直し（develop の取り込み・衝突の解消・precheck・merge-pr の exit 4 の再実行）の持ち主は、後からマージする PR のリーダー**。衝突の解消で相手の持ち分のファイルの意味を変える必要があれば、解消せずに止めて PM に返す。統合破壊は後からマージした側が直す。マージのたびに develop の push CI の結論を見て、赤なら 2 人とも次のマージを止める。「CI が通れば」の許可の run では全 PR に `--last` を付ける。列（`--queue`）には条件がそろった PR だけを 1 回に 2〜3 本まで入れる

## 同じ種類の指摘の一覧

元の場所: team.md §10 の 6（#4546 で移した。文は元のまま）

片方のリーダーで 1 回目が出た種類は、もう片方の依頼文にも最初から不変条件として書く（2 人で数えを共有する）。2 回目は直しを送らず STOP で PM に返す
