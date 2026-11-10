# 開発体制（ロールつきのチーム）

worktree `mycodebranchdesk` で動かす、このリポジトリの開発体制（2026-11-07 の利用者の決定、Issue #4239）。
リポジトリ内部の開発の手順であり、利用者向けの設定ガイドは別（#4196）。

## 1. 役割

| 役割 | インスタンス | ロール（CommandMate） | 仕事 |
|---|---|---|---|
| PM | `claude` | `project-manager` | 利用者の依頼をブリーフにし、開発リーダーに渡す。進みを見張り、承認の要るものだけ利用者に返す |
| イネーブラー | `codex`（`codex-2`） | `enabler` | 設計の事前レビュー（2-4-4）・整合性レビュー（5-2b）・原因調査。読むだけ |
| ジャッジ | `claude-2` | `judge` | 統合した版の受け入れテスト・リグレッションテスト（UAT） |
| 開発リーダー | `claude-3` | `dev-leader` | ブリーフを受けて `/orchestrate` を回す。難易度でワーカーを選ぶ |
| ワーカー | Issue の worktree ごと | — | 易＝Command Code（#4238 のマージ後。それまでは orchestrate.md 1-2b の現行の担当）、中＝Claude sonnet、難＝Claude opus |

`claude-3` は、agent-health の自動修正ループ（Epic #3047、毎朝 08:30 の dispatch）の送り先も兼ねる。

## 2. 流れ

利用者 → PM → 開発リーダー → ワーカー。

- PM はワーカーへ直接送らない。ワーカーへの指示は開発リーダーが `/orchestrate` の手順で出す
- 開発リーダーは利用者へ直接聞かない。承認が要るもの・判断が要るものは PM へ返し、PM が利用者に返す
- イネーブラーへの依頼（2-4-4・5-2b）は今の `/orchestrate` の手順のまま。送るのは開発リーダー
- ジャッジへの UAT の依頼は PM が送る。`/orchestrate` の Phase 7（UAT）を行うのは、開発リーダーではなく PM がジャッジへ頼む形に替わる

## 3. PM から開発リーダーへのブリーフ

次の 4 点を含める。

1. 対象の Issue（番号）
2. マージの許可の範囲（どの Issue・どの base まで。無ければ「マージは進めず、マージ可能を報告して止まる」）
3. 止まる条件（例: 不合格が続いた・範囲外の変更が要る・承認が要る）
4. 締めの `DONE:` 行（完了時に最後の行へ出す要約。PM はこの行で完了を読む）

## 4. agent-health の依頼とブリーフが重なったとき

開発リーダー（`claude-3`）は同時に 1 つの run しか回さない。agent-health の依頼（08:30）と PM のブリーフが重なったら、
先に受けた run を終えてから次に進む。並行して 2 つの run を回さない。
これを **claude-3 の予約**（`scripts/agent-health/claude3-reserve.ts`、Issue #4243。設計は [docs/design/claude3-dispatch-exclusion-4243.md](../design/claude3-dispatch-exclusion-4243.md)）で守る。
PM も dispatch も、予約を持っている間だけ `claude-3` に送る。片方が持っている間、もう片方は送らない（dispatch は待たずに `skipped-busy` を記録して終わり、PM のコマンドは exit 3 で止まる）。

コマンドはすべて main のチェックアウト（`mycodebranchdesk`）で `npx tsx scripts/agent-health/claude3-reserve.ts <サブコマンド>` として実行する。

1. **予約**: `reserve --label "<対象の Issue>"`。標準出力の 1 行が token。token は引き継ぎメモ（`workspace/mem`）にも書く。
   `claude-3` が処理中・プロンプト待ちなら exit 4、別の持ち主（前の PM の run・自動依頼の run）がいれば exit 3 で、どちらも予約しない
   **開発リーダー自身が守る場合**（PM を通さず直接 `/orchestrate` を頼まれた run など）: `claude-3` の中から `reserve --self --label "<対象の Issue>"`。状態確認を省き（自分が処理中のため）、持ち主は `leader`。`whoami` が `mycodebranchdesk` の `claude-3` でなければ exit 2。dispatch は予約中として `skipped-busy` で見送る。解除は `release --token <token>`（`send` は exit 3）
2. **送信**: ブリーフも途中の返事も `send --token <token> "<本文>"` で送る（PM の予約の token でだけ送れる。自動依頼の token では exit 3）（中身は `commandmate send mycodebranchdesk "<本文>" --instance claude-3`）。素の `commandmate send … --instance claude-3` は使わない
3. **解除**: 開発リーダーの `DONE:` を読んだら `release --token <token>`。長くかかるときは `renew --token <token> [--hours 1-24]`。期限（既定 8 時間）を過ぎても予約は外れない。期限は「要確認」の表示だけ
4. **PM の再起動後**: `status` で自分の予約の token を見て `takeover --from <token> --reason restart`。新しい token に替わり、古い token の操作は以後すべて exit 3
5. **自動依頼の run が外せなかったとき**: run の最後の `finish --token` が完了の印（予約の置き場所の `finished-<token>.json`）を残したのに解除が通らなかった場合だけ、`claude-3` が手すきなら `takeover --from <token> --reason dispatch-finished` で引き継げる。リリース判断レポート（HTML）は run の途中でも手で作れるので証拠にしない。印が無ければ exit 3 で、人が `release --force --from <token>` で判断する
6. **導入時**: PM のセッションと Schedule（dispatch）の環境の両方で `status` を実行し、出た `dir=` の絶対パスが同じことを確かめる（置き場所は `~/.commandmate/agent-health/claude3.reservation` に固定）

dispatch 側は、対象があれば `/clear` の前に予約を取り、依頼を送った後も run の終わりまで持つ。run の最後に `claude-3` 自身が条件ファイルの指示どおり `finish --token` を実行する（完了の印を残してから解除）（[agent-health.md](../user-guide/agent-health.md)「自動依頼」）。
PM が素の `commandmate send` を打つことを仕組みで止めるのは未対応（追跡）。リポジトリの共有の設定（`.claude/settings.json` のフック）を足すと clone した利用者を含む全 Claude セッションに効くため採らない。`claude-3` へは `npx tsx scripts/agent-health/claude3-reserve.ts send` だけで送る（手順 2）。

## 5. UAT の結果の返し方（Phase 7）

UAT はジャッジ（`claude-2`）が行い、結果はジャッジ → PM → 開発リーダーの順で返す。不合格の修正ループ（`/uat-fix-loop`）は開発リーダーが回す。
修正ループ内の再UAT（`/uat-fix-loop` の Step 5 の `/uat`）と全 Issue の回帰確認も同じで、開発リーダーが自分で `/uat` を回さず、PM 経由でジャッジに頼み結果を待つ。
開発リーダー以外の人が 1 人で `/orchestrate` を回す場合（今の運用）は、`orchestrate.md` の Phase 7 の手順のままでよい。
