# 開発体制（ロールつきのチーム）

worktree `mycodebranchdesk` で動かす、このリポジトリの開発体制（2026-11-07 の利用者の決定、Issue #4239）。
リポジトリ内部の開発の手順であり、利用者向けの設定ガイドは別（#4196）。

## 1. 役割

| 役割 | インスタンス | ロール（CommandMate） | 仕事 |
|---|---|---|---|
| PM | `claude` | `project-manager` | 利用者の依頼をブリーフにし、開発リーダーに渡す。進みを見張り、承認の要るものだけ利用者に返す |
| イネーブラー | `codex`（`codex-2`）。Codex の代わりは、週の上限切れなら Claude 5（`--instance claude-5`）、上限以外の不調なら Antigravity（`--instance antigravity`）（§6 の 7） | `enabler` | 設計の事前レビュー（2-4-4）・整合性レビュー（5-2b）・原因調査。読むだけ |
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
   **開発リーダー自身が守る場合**（PM を通さず直接 `/orchestrate` を頼まれた run など）: `claude-3` の中から `reserve --self --label "<対象の Issue>"`。状態確認を省き（自分が処理中のため）、持ち主は `leader`。`whoami` が `mycodebranchdesk` の `claude-3`（cliTool は claude）でなければ exit 2。dispatch は予約中として `skipped-busy` で見送る。解除は `release --token <token>`（`send` は exit 3）。token を失ったら `status` で読み、残った leader の予約は PM が `release --force --from <token>` で外す（`takeover` は使えない）。exit 3 は `status` で持ち主を見て、dispatch なら終わるのを待って取り直す
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
UAT を起こす worktree は、run-lock を machine-lock に載せた #4288 PR1b を含む develop を取り込んでから起こす（`scripts/uat/run-server.sh` は各 worktree のチェックアウトのものを使うので、取り込む前の worktree は旧い run-lock のまま取り合い、混在の間は旧い `up` が新しい `up` のロックを pid だけで死んだと読んで取ることがある。設計は `docs/design/run-lock-machine-lock-4288.md` と `docs/design/lock-reservation-rest-4288.md` §1.9）。

## 6. 直しとレビューを収束させる規則

直し→レビューの往復が収束しない問題（mem の G-PR2 で Codex 9 回、G-PR3 で 5 回、#4288 PR1a で 4 回）への手当て。人の承認: 2026-11-11。数字の出典は PM の台帳（`workspace/mem/pm-2026-11-09-remaining.md`）。
根にあったのは、指摘の多くが直しで変えていない行（最初からあった穴）にあり、レビュー 1 回で一部ずつしか見つからなかったこと、設計・実装が枝ごとの場合分けで組み合わせの数だけ漏れが出たこと、呼び手の無い API の使われない組み合わせを直し続けたこと、P2 の処分が「広げて直す」だけだったこと、同じ種類の 2 回目で止まらなかったこと。

1. **1 回目のレビューで網羅させる。** 高リスクの変更の最初の 5-2b と PM の Claude レビューで、レビュアーにすべての return・throw・書き込みの表と、入力・状態の組み合わせの表を作らせる。なぜ: 穴を 1 回ずつ見つける往復を 1 回に縮めるため
2. **高リスクは最初から不変条件で書く。** 送信の経路・ロック・データ・公開 API は、設計と最初の契約から「不変条件＋全組み合わせの表の試験＋先に赤」で書く。なぜ: 枝ごとの場合分けは組み合わせの数だけ確かめ漏れを生む
3. **PR を危険の境目で分ける。** 送信の経路・ロックを画面の変更と同じ PR に入れない。目安は数百行・20 ファイル程度（目安であってゲートではない）。なぜ: PR が大きいほどレビューの回数が増えた
4. **API は呼び手と同じ PR で作る。** 呼び手の無い組み合わせは引数の検査で拒否し、広げるのは呼び手を作るとき。なぜ: 使われない組み合わせを P2 として直し続けた
5. **P2 の処分に「狭めて塞ぐ」を必ず選択肢に入れる。** 今の呼び手が通らない経路は、まず拒否で塞ぐ。なぜ: 「広げて直す」だけでは穴が増え続けた
6. **同じ種類の穴が 2 回出たら止める。** 直しを送る前に止め、作業に関わっていないイネーブラーに共通の原因を調べさせてから直しを出す。なぜ: 同じ種類の 2 回目で止まらず往復が続いた
7. **レビュアーの代わり。**
   - Codex の週の上限が切れたら、レビューは Claude 5（`--instance claude-5`、ロール `enabler`）に頼む。止まっていれば 1 行の send で起動してから送る
   - 上限が回復したら（codex の画面の weekly limit の表示で確かめる）Codex に戻す。Claude 5 は戻した後に止めてよい
   - 上限以外の Codex の不調（接続など）の代わりは Antigravity（`--instance antigravity`）
   - `codex-2` は `codex` と同じアカウントの上限を共有するので、上限の対策にならない（stream disconnected のような個別の不調で `codex-2` へ振り替えるのは従来どおり）
