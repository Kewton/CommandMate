# agent-health の Issue のひな形

タイトル: `fix(agent-health): <tool> <version> で <checkId> が失敗する`

本文:

```markdown
<!-- agent-health:<tool>:<checkId> -->
**種別**: 日次ヘルスチェックが見つけた不具合（自動登録）
**ツール**: <tool> <version>（前回 <previousVersion>、版の変化: <versionChanged>）
**チェック**: `<checkId>` — <summary>
**確認日**: <YYYY-MM-DD>（やり直しでも失敗）

## 証拠
```
<evidence>
```

## 参考
- レポート: `~/.commandmate/agent-health/reports/<YYYY-MM-DD>.json`（確認したマシンのみ）
- チェックの意味: `docs/user-guide/agent-health.md`
- 原因の調査・修正方針は未記入（この Issue は自動登録のため、担当者が追記する）
```
