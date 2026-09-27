## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| agent-health-daily | 0 7 * * * | docs/agent-health/daily-triage-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | antigravity | true | --dangerously-skip-permissions |
| agent-health-watch | 0 8 * * * | docs/agent-health/watch-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | command-code | true | yolo |
