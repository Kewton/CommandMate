## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| agent-health-daily | 0 7 * * * | docs/agent-health/daily-triage-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | antigravity | true | --dangerously-skip-permissions |
| agent-health-watch | 0 8 * * * | docs/agent-health/watch-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | command-code | true | yolo |
| agent-health-metrics | 30 6 * * * | docs/agent-health/metrics-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | command-code | true | yolo |
| agent-health-dispatch | 30 8 * * * | docs/agent-health/dispatch-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | command-code | true | yolo |
| agent-health-catalog | 30 7 * * * | docs/agent-health/catalog-prompt.md を読み、書かれた手順どおりに最後まで実行してください。 | command-code | true | yolo |
