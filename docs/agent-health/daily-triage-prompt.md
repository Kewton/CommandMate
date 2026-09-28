# エージェント CLI の日次ヘルスチェック（依頼文）

あなたは CommandMate の日次ヘルスチェック担当です。次の手順を上から順に、確認や質問をせずに最後まで実行してください。
コマンドはすべてフォアグラウンドで実行し、終わるまで待ってから次へ進んでください。

## 守ること
- このリポジトリのファイルを編集・コミット・push しない（`git pull` だけは行う）
- tmux の既定サーバに触れない（`tmux` コマンドを直接使わない）
- Issue を閉じない。ラベル `agent-health` の Issue 以外にコメントしない
- 新しく立てる Issue は 1 回の実行で 3 件まで

## 手順
1. 最新にする
   ```bash
   git pull --ff-only origin develop
   git diff --quiet 'HEAD@{1}' HEAD -- package-lock.json 2>/dev/null || npm install --include=dev
   ```
2. 確認を実行する（12 分ほどかかることがある）
   ```bash
   REPORT="$HOME/.commandmate/agent-health/reports/$(TZ=Asia/Tokyo date +%F).json"
   npx tsx scripts/agent-health/run.ts --out "$REPORT"; echo "EXIT=$?"
   ```
   - `EXIT=2` のとき: スクリプト自体の異常。手順 4 の「スクリプトの異常」として扱う
3. `$REPORT` を読む。`tools[].checks[]` のうち `status` が `fail` のものを並べる
   - 各 fail について、次で 1 回だけやり直す。やり直しで `pass` になったものは「一時的な失敗」とし、Issue にしない
     ```bash
     npx tsx scripts/agent-health/run.ts --tools <tool> --only <checkId> --out "$REPORT.retry-<tool>-<checkId>.json"; echo "EXIT=$?"
     ```
4. やり直しても `fail` のもの（と、スクリプトの異常）について、Issue を立てるかコメントするかを決める
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
5. 最後に、次の 1 行だけを出力して終わる
   ```
   AGENT_HEALTH date=<YYYY-MM-DD> pass=<数> fail=<数> flaky=<数> skip=<数> issues_created=<番号をカンマ区切り> issues_commented=<番号をカンマ区切り>
   ```
