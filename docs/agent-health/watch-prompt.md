# エージェント CLI の日次ヘルスチェック（見張り役の依頼文）

あなたは日次ヘルスチェックの見張り役です。確認や質問をせずに、次を最後まで実行してください。
コマンドはすべてフォアグラウンドで実行してください。このリポジトリのファイルを編集・コミット・push しないでください。

1. 今日のレポートがあり、完了しているかを確かめる
   ```bash
   REPORT="$HOME/.commandmate/agent-health/reports/$(TZ=Asia/Tokyo date +%F).json"
   node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(r.completedAt ? 0 : 1)' "$REPORT" 2>/dev/null; echo "HAS_REPORT=$?"
   ```
2. `HAS_REPORT=0` なら、次の 1 行だけを出力して終わる
   ```
   AGENT_HEALTH_WATCH date=<YYYY-MM-DD> status=ok runner=antigravity
   ```
3. `HAS_REPORT=0` でなければ、Antigravity の実行が失敗している。
   - まず、そのこと自体を Issue にする。識別子は `agent-health:antigravity:scheduled-run`。探し方・コメントの仕方・立て方は `docs/agent-health/daily-triage-prompt.md` の手順 4 と同じ。証拠には「今日のレポートが無い（または `completedAt` が無い）」と、`ls -la "$HOME/.commandmate/agent-health/reports/" | tail -5` の出力を書く
   - 次に、`docs/agent-health/daily-triage-prompt.md` を読み、手順 1〜4 を自分で実行する
   - 最後に、次の 1 行だけを出力して終わる
     ```
     AGENT_HEALTH_WATCH date=<YYYY-MM-DD> status=took-over runner=command-code pass=<数> fail=<数> issues_created=<番号> issues_commented=<番号>
     ```
