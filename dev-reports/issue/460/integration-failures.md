# Integration Failure Triage: Issue #460

更新日: 2026-03-09

## 概要

`npm run test:integration` は起動可能な状態まで回復したが、suite 全体は Issue #460 とは独立した既存 failure により失敗した。

## 実行結果

- コマンド: `npm run test:integration`
- 結果: failed
- サマリ:
  - Test Files: 12 failed / 28 passed
  - Tests: 33 failed / 494 passed
  - Errors: 8

## Issue #460 関連の確認結果

- `tests/integration/worktree-detail-integration.test.tsx` は通過
- terminal page control mode 導入に直接関係する失敗は新規には観測していない
- `tests/integration/websocket.test.ts` は sandbox の `listen EPERM` で失敗しており、Issue #460 実装差分の回帰とは判断していない

## 主な failure 分類

### 1. sandbox 制約

- `tests/integration/websocket.test.ts`
  - HTTP server の `listen(0)` で `listen EPERM: operation not permitted 0.0.0.0`
  - ローカル sandbox 制約による失敗

### 2. 既存 API / message 系 failure

- `tests/integration/api-hooks.test.ts`
- `tests/integration/api-kill-session-cli-tool.test.ts`
- `tests/integration/api-messages.test.ts`

代表症状:

- 想定 200/400/404 に対して 500 応答
- message 並び順や pagination の期待値不一致

### 3. 既存 acceptance / timeout 系 failure

- `tests/integration/issue-208-acceptance.test.ts`
- `tests/integration/trust-dialog-auto-response.test.ts`

代表症状:

- 非連番 prompt 判定の期待値不一致
- trust dialog timeout シナリオの失敗

## 判断

- `npm run test:integration` が起動しない状態は解消済み
- 現在の残 failure は Issue #460 完了判定の直接ブロッカーではなく、既存課題として別管理するのが妥当
- ただし、repository 全体の green 状態は未回復

## フォローアップ案

1. `tests/integration/websocket.test.ts` は sandbox 外または権限付き環境で再実行する
2. API 系 failure は別 issue に切り出し、500 応答の原因を優先調査する
3. acceptance / timeout 系 failure は prompt 判定ロジックの既存仕様と期待値を再確認する
