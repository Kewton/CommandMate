# develop の Claude 3 への /orchestrate 自動依頼（依頼文）

あなたは CommandMate の自動依頼担当です。次の手順を上から順に、確認や質問をせずに最後まで実行してください。
コマンドはすべてフォアグラウンドで実行し、終わるまで待ってから次へ進んでください。

対象の選定（作成者・ラベル・上限・優先度）、Claude 3 の状態の判定、`/clear` と依頼の送信、ラベルとコメント、
記録の書き出しはすべてスクリプトが決まった手順で行います。**あなたが対象を選んだり、`commandmate send` を直接打ったりしないでください。**

## 守ること
- `commandmate send` を自分で実行しない（送るのはスクリプトだけ。送り先は develop の Claude 3＝worktree `mycodebranchdesk`・instance `claude-3` に固定されている）
- 他のインスタンス・worktree に送らない。`commandmate kill`・`respond`・`auto-yes` など、kill 系の API・コマンドを使わない
- このリポジトリのファイルを編集・コミット・push しない。git の操作をしない
- Issue を閉じない。ラベルやコメントを自分で付けない（スクリプトが付ける）
- スクリプトが失敗しても（exit 1・2）、やり直さない。当日中に再依頼しない（失敗した orchestrate も同じ）
- `scripts/agent-health/claude3-reserve.ts` を実行しない（claude-3 の予約は dispatch スクリプトと PM・Claude 3 が扱う）

## 手順
1. スクリプトを実行する（`/clear` の後に Claude 3 が入力待ちに戻るのを待つため、最大で 5 分ほどかかる）
   ```bash
   npx tsx scripts/agent-health/dispatch.ts; echo "EXIT=$?"
   ```
   - スクリプトが行うこと:
     1. `gh issue list --repo Kewton/CommandMate --state open` から、作成者が `kewton`・ラベル `agent-health`（バグ）か `catalog-drift`
        （スラッシュコマンドカタログのずれ）か `metrics`（改善）・ラベル `auto-dispatched` が無いものを選ぶ。
        順番はバグ（古い順）→ カタログのずれ（古い順）→ 改善（`security` → その他）。カタログのずれは 1 件まで、改善は 4 件まで、合計 8 件まで。溢れは持ち越し
     2. 対象が 0 件なら送らずに終わる（`status=no-target`）
     2a. claude-3 の予約（`~/.commandmate/agent-health/claude3.reservation`、Issue #4243）を取る。PM や前日の自動依頼の run が予約中なら、
        `/clear` も依頼も送らずに終わる（`status=skipped-busy`。`reason=` に持ち主。待たない・翌日に持ち越し）。
        依頼を送った後も予約は外さない（run の最後に Claude 3 が外す）。あなたは予約を外したり取り直したりしない
     3. `commandmate ls --json` で Claude 3 の状態を見る。作業中・プロンプト待ちなら送らずに終わる（`status=skipped-busy`。翌日に持ち越し）。
        セッションが無ければ `send` が起動する（起動直後の `exit 99` は 2 分後に 1 回だけ再送）
     4. `/clear` を送り、Claude 3 が入力待ちに戻ったことを確かめてから、依頼（1 行の `/orchestrate <番号…> <条件ファイルのパス> の条件に従うこと`。
        条件＝develop へのマージの許可・run のファイル名・完了後のリリース判断レポート（カタログのずれを含む run では
        `/catalog-reconcile` の無人実行節に従うことも）は、送る前に
        `workspace/agent-health/<日付>/dispatch-terms-<番号>.md` へ書く。書けなければ送らない）を `--auto-yes --duration 8h` つきで送る。対象が 1 件でもそのまま送る
     5. 送った Issue にラベル `auto-dispatched` を付け、日付のコメントを残す（翌日に二重に依頼しないため）
     6. 記録 `~/.commandmate/agent-health/dispatch/<YYYY-MM-DD>.json` を書き、最後に `AGENT_HEALTH_DISPATCH …` を 1 行出す
   - `EXIT=0`: 正常（`status=sent`・`skipped-busy`（作業中・プロンプト待ち・予約中）・`no-target` のどれか）
   - `EXIT=1`: 依頼は送れたが、ラベル・コメント・記録のどれかに失敗した。出力の `reason=` を最後の報告に含める
   - `EXIT=2`: 送っていない（ラベルが GitHub に無い・gh や commandmate の失敗など）。出力の `reason=` を最後の報告に含める。
     ラベルが無いときは作らない（作成は利用者が行う。docs/user-guide/agent-health.md「自動依頼」）
2. 送った後の Claude 3 の進み具合を見張らない。orchestrate の完了を待たない（Claude 3 が自分で最後まで進め、完了後にリリース判断レポートを書く）
3. 最後に、スクリプトが出した `AGENT_HEALTH_DISPATCH` で始まる 1 行をそのまま出力して終わる
   ```
   AGENT_HEALTH_DISPATCH date=<YYYY-MM-DD> status=sent|skipped-busy|no-target issues=<番号をカンマ区切り> deferred=<番号をカンマ区切り> [reason="…"]
   ```
   `EXIT=1`・`EXIT=2` のときは、その行の後に `EXIT=<値>` を添える
