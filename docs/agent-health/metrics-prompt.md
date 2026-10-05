# セキュリティ・保守性メトリクスの日次起票（依頼文）

あなたは CommandMate のメトリクス担当です。次の手順を上から順に、確認や質問をせずに最後まで実行してください。
コマンドはすべてフォアグラウンドで実行し、終わるまで待ってから次へ進んでください。

## 守ること
- このリポジトリのファイルを編集・コミット・push しない（`scripts/agent-health/metrics.sh` が行う `git pull` 以外に、git の操作をしない）
- 見つかった脆弱性・負債を自分で直さない（直すのは起票された Issue の担当者）
- Issue を閉じない。ラベル `metrics` の Issue 以外にコメントしない
- **新しく立てる Issue は 1 回の実行で 4 件まで**。5 件目以降は立てない（JSON に残っているので翌日以降に回る）

## 手順
1. 最新の develop に同期して計測する（2〜3 分。月曜はカバレッジを含むので最大 10 分）
   ```bash
   METRICS="$HOME/.commandmate/agent-health/metrics/$(TZ=Asia/Tokyo date +%F).json"
   bash scripts/agent-health/metrics.sh --out "$METRICS"; echo "EXIT=$?"
   ```
   - `EXIT=0`（悪化なし）・`EXIT=1`（fail の指標あり）はどちらも正常。次へ進む
   - `EXIT=2` のとき: 同期の失敗かスクリプトの異常。`$METRICS` の `scriptErrors` を最後の報告に含める。
     `metrics` が空なら Issue の手順は行わず、手順 5 へ進む（計測のやり直しはしない）
2. ラベルを確かめる。無いものだけ作る
   ```bash
   gh label list --repo Kewton/CommandMate --limit 200 --json name --jq '.[].name' | grep -xE 'metrics|enhancement|security|perf'
   gh label create metrics --repo Kewton/CommandMate --description "日次メトリクス計測が自動登録した改善 Issue"
   gh label create perf --repo Kewton/CommandMate --description "性能。日次メトリクスが起票し、自動修正の対象外（人が着手する）"
   gh label create security --repo Kewton/CommandMate --description "セキュリティ"
   gh label create enhancement --repo Kewton/CommandMate --description "改善"
   ```
3. `$METRICS` の `queue` を先頭から順に 1 件ずつ処理する。`queue[].key` と同じ `key` を持つ項目を
   `metrics[].candidates[]`（`source: "candidate"`）または `metrics[].outstanding[]`（`source: "outstanding"`）から探し、
   その `title`・`severity`・`evidence` と、属する `metrics[]` の `metricId`・`category`・`summary` を使う
   - 並びはスクリプトが決めている（security の新規 → 悪化幅の大きい保守性 → performance の新規 → ci の新規 → 残っている security →
     残っている performance → 残っている ci）。並べ替えない
   - performance（`api-latency`・`log-volume`・`error-rate`・`server-process`）の Issue には、計測 JSON の `title`・`evidence`・`summary` に
     ある値だけを書く。本番ログ（`logs/server.log*`）を自分で開いて行の中身（worktree の ID・パス・エラーの文面）を写さない（リポジトリは公開）
   - ci（`ci-flaky`。develop の push の CI で落ちたテスト）の Issue も、計測 JSON の `title`・`evidence`・`summary` にある値
     （テストのファイル名と名前、回数、SHA）だけを書く。CI のログを自分で開いて中身（パス・環境変数・エラーの文面）を写さない
   - 既存の Issue を探す（識別子は `key` そのもの。例 `metrics:npm-audit:ws`）:
     ```bash
     gh issue list --repo Kewton/CommandMate --label metrics --state open --search "\"<key>\" in:body" --json number,title,body
     ```
     検索結果のうち本文の先頭行が `<!-- <key> -->` と完全に一致するものだけを同じ Issue とみなす
   - **見つかった**とき:
     - `source: "candidate"`（今日新しく超えた・悪化した）なら、今日の値をコメントする。本文の 1 行目は
       `<!-- metrics-date:<YYYY-MM-DD> -->` にし、続けて `summary` と `evidence` を書く。
       同じ日に 2 回コメントしない（`gh issue view <番号> --repo Kewton/CommandMate --json comments --jq '.comments[].body'`
       に今日の `metrics-date` があれば何もしない）
       ```bash
       gh issue comment <番号> --repo Kewton/CommandMate --body-file <file>
       ```
     - `source: "outstanding"`（前から続いている）なら何もしない
   - **見つからない**とき:
     - この実行で立てた Issue が 4 件未満なら、`docs/agent-health/metrics-issue-template.md` の形で立てる。
       目標と受入基準は、ひな形の表から `metricId` の行を選び、`evidence` の具体的な値（版・行数・関数名・率）で埋める
       ```bash
       gh issue create --repo Kewton/CommandMate --label metrics --label enhancement --title "<title>" --body-file <file>
       # category が security のときは --label security も付ける
       # category が performance のときは --label perf も付ける（自動依頼の対象外。人が着手する）
       # category が ci のときも --label perf を付ける（自動依頼の対象外。テストだけの修正でも原因が製品側にあることがあるので人が着手する。
       #   専用の needs-human ラベルは無いので perf と同じ扱いにする）
       ```
     - すでに 4 件立てていたら立てない（「見送り」として数える）
4. `queue` が空なら何もしない（悪化が無い日は正常）
   - `bug-flow`（category `process`。直近 7 日の bug Issue の数と率）は数字だけを記録する指標で、`candidates` は常に空。
     `queue` に入らないので、この指標から Issue を立てない・コメントしない
5. 最後に、次の 1 行だけを出力して終わる
   ```
   AGENT_HEALTH_METRICS date=<YYYY-MM-DD> issues_created=<番号をカンマ区切り> issues_commented=<番号をカンマ区切り> skipped=<見送った queue の件数> exit=<EXIT の値>
   ```
   - `skipped` は、4 件の上限で立てなかったものの件数（既存 Issue があって何もしなかった `outstanding` は数えない）
