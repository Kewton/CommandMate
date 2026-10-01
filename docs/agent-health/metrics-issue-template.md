# メトリクスの改善 Issue のひな形

タイトル: 計測 JSON の `title` をそのまま使う（例: `security: ws の脆弱性 1 件（high）を解消する`、
`refactor: src/lib/foo.ts を分割する（1620 行）`、`perf: api/worktrees list:slow の遅延を減らす（p95 8,524ms）`）。
performance の Issue には JSON にある値だけを書き、本番ログの行の中身（worktree の ID・パス・エラーの文面）は写さない（リポジトリは公開）

本文（1 行目は識別子。検索に使うので変えない）:

```markdown
<!-- metrics:<metricId>:<target> -->
**種別**: 日次メトリクス計測が見つけた<セキュリティの問題 | 保守性の悪化 | 性能の問題>（自動登録）
**指標**: `<metricId>` — <summary>
**確認日**: <YYYY-MM-DD>

## 目標
<下の表の「目標」を evidence の具体的な値で埋める>

## 受入基準
- [ ] <下の表の「受入基準」を具体的な値で埋める>
- [ ] `npm run lint`・`npx tsc --noEmit`・`npm run test:unit` が通る

## 証拠
```
<evidence>
```

## 参考
- 計測結果: `~/.commandmate/agent-health/metrics/<YYYY-MM-DD>.json`（計測したマシンのみ）
- 指標と閾値の意味: `docs/user-guide/agent-health.md` の「メトリクス計測」
- 原因の調査・修正方針は未記入（この Issue は自動登録のため、担当者が追記する）
```

## metricId ごとの目標と受入基準

| metricId | 目標 | 受入基準 |
|---|---|---|
| `npm-audit` | `<package>` を evidence の「目標」の版以上に上げる（メジャー更新が要るなら、その親パッケージの更新） | `npm audit --omit=dev --json` で evidence に並んだ advisory が消える |
| `semgrep` | `<path>` の `<rule>` の検出を解消する（誤検出なら理由を書いて抑止） | `semgrep --config p/typescript --config p/nodejs <path>` で当該 ERROR が 0 件 |
| `secrets` | 秘密情報を取り除き、**その値を無効化（ローテーション）**する | `gitleaks detect` で当該 fingerprint が出ない。無効化したことを Issue に記録 |
| `file-size` | `<path>` を 1,500 行以下に分割する（増えただけなら前回の行数以下に戻す） | `wc -l <path>` が目標以下。分割先にも単体テストがある |
| `complexity` | `<path>` の `<関数>` の複雑度を 25 未満（または前回の値以下）にする | ESLint `complexity` で当該関数が目標未満 |
| `duplication` | `src/` の重複率を前回の値以下に戻す | `npx jscpd src` の重複率が前回の値以下 |
| `unused` | 未使用の依存 `<name>` を `package.json` から外す（実は使っているなら knip の設定で明示） | `npx knip` が当該依存を報告しない。`npm run build` が通る |
| `outdated` | `<name>` を `latest` のメジャーへ上げる（上げられない理由があれば記録） | `npm outdated <name>` のメジャーの遅れが 2 未満 |
| `type-safety` | 増えた `any`・`eslint-disable`・`@ts-ignore` を前回の数以下に戻す | 計測の件数が前回の値以下 |
| `coverage` | 行カバレッジを前回の値以上に戻す | `vitest --coverage`（unit）の lines が前回の値以上 |
| `api-latency` | `<tag> <event>` の p95 を 5,000ms 未満（前回比で悪化したなら前回の値以下）にする。evidence の内訳の最大のフィールドから手を付ける | 翌日以降の計測で当該 `<tag> <event>` の p95 が目標以下 |
| `log-volume` | `<tag> <event>` の行数を 1 日 20,000 行未満（倍増したなら前回の値以下）にする（レベルを下げる・間引く・出す条件を絞る） | 翌日以降の計測で当該 `<tag> <event>` の 24 時間の行数が目標以下 |
| `error-rate` | `<tag> <event>` の ERROR を 1 日 50 行未満（倍増したなら前回の値以下）にする（原因を直す。正常系ならレベルを下げる） | 翌日以降の計測で当該 `<tag> <event>` の 24 時間の ERROR 行数が目標以下 |
| `server-process` | サーバーの RSS を 1,500MB 未満（増えたなら前回の値以下）にする／CPU の平均を 50% 未満にする | 翌日以降の計測で RSS の最大・CPU の平均が目標以下 |
