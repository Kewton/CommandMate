# エージェント CLI の日次ヘルスチェック（依頼文）

あなたは CommandMate の日次ヘルスチェック担当です。次の手順を上から順に、確認や質問をせずに最後まで実行してください。
コマンドはすべてフォアグラウンドで実行し、終わるまで待ってから次へ進んでください。

## 守ること
- このリポジトリのファイルを編集・コミット・push しない（`scripts/agent-health/daily.sh` が行う `git pull` 以外に、git の操作をしない）
- tmux の既定サーバに触れない（`tmux` コマンドを直接使わない）
- Issue を閉じない。ラベル `agent-health` の Issue 以外にコメントしない
- 新しく立てる Issue は 1 回の実行で 3 件まで

## 手順
1. 最新の develop に同期して確認を実行する（12 分ほどかかることがある）
   ```bash
   REPORT="$HOME/.commandmate/agent-health/reports/$(TZ=Asia/Tokyo date +%F).json"
   bash scripts/agent-health/daily.sh --out "$REPORT"; echo "EXIT=$?"
   ```
   - 出力の `AGENT_HEALTH_SYNC …` の行を、最後の報告に含める
   - 出力の終わりにある要約（1 行目が `pass N・fail N・skip N（…）` の行から、表と「未実施の理由:」まで）を、最後の報告に含める。
     skip は「確かめていない」という意味で、pass ではない。「全項目 pass」「すべて合格」とは書かない
   - `EXIT=2` のとき: スクリプト自体の異常（同期の失敗を含む）。`$REPORT` の `scriptErrors` を証拠にして、後の手順の「スクリプトの異常」として扱う。確認のやり直しはしない
2. `$REPORT` を読む。まず要約と skip の内訳を出す（手順 1 の出力から要約が読み取れないときも、これで読める）
   ```bash
   node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const l of r.summary ?? ["(summary が無い)"]) console.log(l); const c=r.coverage?.counts; console.log("COUNTS=" + (c ? `pass=${c.pass} fail=${c.fail} skip=${c.skip}` : "-")); console.log("SKIP_KINDS=" + (Object.entries(c?.skipByKind ?? {}).map(([k,n])=>k+":"+n).join(",") || "-"))' "$REPORT"
   ```
   次に、`tools[].checks[]` のうち `status` が `fail` のものを並べる
   - 各 fail について、次で 1 回だけやり直す。やり直しで `pass` になったものは「一時的な失敗」とし、Issue にしない
     ```bash
     npx tsx scripts/agent-health/run.ts --tools <tool> --only <checkId> --out "$REPORT.retry-<tool>-<checkId>.json"; echo "EXIT=$?"
     ```
   - version だけを読むツール（`gemini`・`vibe-local`・`copilot`）は `--tools` に指定できない。これらの `version` の fail は、
     次で 1 回だけやり直す（`--only version` なので、どのツールも起動せず、モデルも呼ばない。9 ツールすべての `version` を読む）。
     やり直しの結果は `$REPORT.retry-version.json` の、そのツールの `version` を見る
     ```bash
     npx tsx scripts/agent-health/run.ts --only version --out "$REPORT.retry-version.json"; echo "EXIT=$?"
     ```
3. やり直しても `fail` のもの（と、スクリプトの異常）について、Issue を立てるかコメントするかを決める
   - 識別子: `agent-health:<tool>:<checkId>`（スクリプトの異常は `agent-health:script:run`）
   - 既存の Issue を探す:
     ```bash
     gh issue list --repo Kewton/CommandMate --label agent-health --state open --search "\"agent-health:<tool>:<checkId>\" in:body" --json number,title
     ```
   - 見つかったら、その Issue に今日の結果をコメントする（`gh issue comment <番号> --repo Kewton/CommandMate --body-file <file>`）。同じ日に 2 回コメントしない（既存のコメントに今日の日付があれば何もしない）
   - 見つからなければ、`docs/agent-health/issue-template.md` の形で Issue を立てる:
     ```bash
     gh issue create --repo Kewton/CommandMate --label agent-health --label bug --title "<タイトル>" --body-file <file>
     ```
   - 新しく立てる Issue が 3 件を超えるときは、4 件目以降を 1 件の Issue（識別子 `agent-health:batch:<日付>`）にまとめる
4. 最後に、手順 1 の要約（1 行目から表・「未実施の理由:」まで）をそのまま出力し、その後に次の 1 行を出力して終わる
   ```
   AGENT_HEALTH date=<YYYY-MM-DD> pass=<数> fail=<数> flaky=<数> skip=<数> skip_kinds=<種類>:<数>,… issues_created=<番号をカンマ区切り> issues_commented=<番号をカンマ区切り> sync=<AGENT_HEALTH_SYNC の status>
   ```
   - `pass`・`fail`・`skip` は手順 2 の `COUNTS=`（レポートの `coverage.counts`。9 ツール × 7 項目）の数。`skip_kinds` は `SKIP_KINDS=` の値をそのまま書く
     （例: `no-definition:5,not-shown:2,signed-out:6,unsupported:12`）。`coverage` が無いレポート（`EXIT=2` の同期失敗など）は `skip_kinds=-`
