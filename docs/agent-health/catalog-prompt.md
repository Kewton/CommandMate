# スラッシュコマンドカタログのずれの日次チェック（依頼文）

あなたは CommandMate のカタログ確認担当です。次の手順を上から順に、確認や質問をせずに最後まで実行してください。
コマンドはすべてフォアグラウンドで実行し、終わるまで待ってから次へ進んでください。

判定（ずれ・差分なし・検査不能）、版の比較、Issue の作成・更新・close、記録の書き出しはすべてスクリプトが決まった手順で行います。
**あなたがカタログを直したり、Issue を自分で立てたり閉じたりしないでください。**

## 守ること
- このリポジトリのファイルを編集・コミット・push しない（`daily.sh --sync-only` が行う `git pull` 以外に、git の操作をしない）。
  `npm run catalog:refresh -- --write` や `/catalog-reconcile` を実行しない（追跡対象のファイルが書き換わると、翌朝の `daily.sh` が
  「手元に編集あり」で同期を拒否し、日次確認ごと止まる）
- tmux に触れない。`commandmate send`・`kill`・`respond`・`auto-yes` などを使わない
- ラベル `catalog-drift` 以外の Issue に触れない。`catalog-drift` の Issue もスクリプトが扱うので、自分でコメント・編集・close しない
- スクリプトが失敗しても（exit 1・2）、やり直さない

## 手順
1. 最新の develop に同期する（07:00 の日次確認の同期とは時刻をずらしてある）。`--out` は必ず一時ファイルにする
   （同期に失敗したとき `daily.sh` は `--out` に最小のレポートを書く。省くと当日の agent-health レポートを上書きしてしまう）
   ```bash
   SYNC_REPORT="$(mktemp "${TMPDIR:-/tmp}/cm-agent-health-catalog-sync.XXXXXX")"
   bash scripts/agent-health/daily.sh --sync-only --out "$SYNC_REPORT"; echo "EXIT=$?"
   ```
   - `EXIT=0` なら次へ進む
   - `EXIT=2`（同期の失敗）なら、出力の `AGENT_HEALTH_SYNC …` の行を最後の報告に含めて手順 3 へ進む（スクリプトは実行しない）
2. スクリプトを実行する（ソースの取得を含め 1〜3 分ほど）
   ```bash
   npx tsx scripts/agent-health/catalog-check.ts; echo "EXIT=$?"
   ```
   - スクリプトが行うこと:
     1. `npm run catalog:refresh -- --check`（読むだけ。ファイルを書かない）の出力を `drift`・`clean`・`inconclusive` に判定する。exit code では判定しない。
        opencode 1.x の provider の skip は既知の状態として扱い、検査不能に数えない
     2. 当日の `~/.commandmate/agent-health/reports/<YYYY-MM-DD>.json` の各 CLI の版と `src/config/slash-commands-attestations.json` の版を比べる
        （版の差だけではずれにしない。opencode 1.x は除く）
     3. 作成者 `kewton`・ラベル `catalog-drift` の open な Issue に合わせる: ずれがあれば作成（無いとき）か本文の更新（あるとき。件数が動いたときだけコメント）、
        ずれが解消したら「ずれ 0・検査不能なし」とコメントして close、検査不能なら何もしない
     4. 記録 `~/.commandmate/agent-health/catalog/<YYYY-MM-DD>.json` を書き、最後に `AGENT_HEALTH_CATALOG …` を 1 行出す
   - `EXIT=0`: 正常（判定は問わない）
   - `EXIT=1`: 判定はできたが、Issue の同期か記録に失敗した。出力の `reason=` を最後の報告に含める
   - `EXIT=2`: 実行できなかった。出力の最後の数行を最後の報告に含める
3. 最後に、スクリプトが出した `AGENT_HEALTH_CATALOG` で始まる 1 行をそのまま出力して終わる
   ```
   AGENT_HEALTH_CATALOG date=<YYYY-MM-DD> status=drift|clean|inconclusive new=<数> attestation_drift=<数> version_gaps=<tool:記録->手元,…|none|unknown> issue=<番号|none> action=created|updated|closed|none [reason="…"]
   ```
   `EXIT=1`・`EXIT=2` のときは、その行の後に `EXIT=<値>` を添える。同期に失敗してスクリプトを実行しなかったときは、
   `AGENT_HEALTH_SYNC` の行と `EXIT=2` を出す
