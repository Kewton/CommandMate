# Manual Verification Record: Issue #460

更新日: 2026-03-09

## 目的

Issue #460 の terminal page 向け control mode 導入について、Phase 6 の manual verification 観点を記録する。

## 実施結果サマリ

- 実施済み:
  - unit / component / integration test による input/output/resize/reconnect/fallback の代替確認
  - lint / typecheck の通過
  - metrics, resource control, snapshot fallback の実装確認
- 未実施:
  - 実ブラウザからの terminal page 操作
  - 実 tmux session を用いた Codex / OpenCode TUI 操作
  - idle timeout 後の再接続の実機確認
- 未実施理由:
  - 現在の sandbox ではブラウザ操作と tmux TUI の対話確認ができない
  - WebSocket listen を伴う一部 integration test は sandbox の `listen EPERM` に阻害される

## 代替証跡

### 1. terminal input / output

- `tests/unit/components/TerminalComponent.test.tsx`
  - terminal input forwarding
  - connected 時の subscribe / output 処理
  - quick command 有効化条件
- `tests/unit/lib/ws-server-terminal.test.ts`
  - terminal subscribe
  - invalid worktree reject
  - unauthorized reject

### 2. resize

- `tests/unit/components/TerminalComponent.test.tsx`
  - connected 後の `window.resize` で `terminal_resize` が送信されることを確認
- `tests/unit/lib/ws-server-terminal.test.ts`
  - resize payload validation は gateway 実装済み

### 3. reconnect / disconnect

- `tests/unit/components/TerminalComponent.test.tsx`
  - close 後に `Disconnected` 表示へ遷移することを確認
  - 1 秒後に WebSocket を再生成し `Connecting` 状態へ戻ることを確認
- `tests/unit/lib/ws-server-terminal.test.ts`
  - disconnect cleanup により subscription が解放されることを確認

### 4. fallback

- `tests/unit/components/TerminalPage.test.tsx`
  - feature flag 無効時に Snapshot Fallback 表示になることを確認
- `tests/unit/lib/ws-server-terminal.test.ts`
  - control stream error 時に snapshot fallback を返し、その後 `terminal_error` を送ることを確認

### 5. worktree detail 影響

- `tests/integration/worktree-detail-integration.test.tsx`
  - worktree detail 側の既存挙動が維持されることを確認
- `dev-reports/issue/460/compatibility-check.md`
  - snapshot path の後方互換性を整理

## 実行コマンド記録

- `npx vitest run tests/unit/lib/ws-server-terminal.test.ts`
- `npx vitest run tests/unit/components/TerminalComponent.test.tsx tests/unit/components/TerminalPage.test.tsx`
- `npx vitest run tests/integration/worktree-detail-integration.test.tsx`
- `npx tsc --noEmit --pretty false`
- `npm run lint`

## 未実施の手動確認項目

1. 実ブラウザで terminal page を開き、input/output が live に往復すること
2. terminal page でブラウザリサイズ後に TUI 描画崩れが発生しないこと
3. WebSocket 切断後に再接続し、再度 input/output が成立すること
4. feature flag 無効時に snapshot fallback UI が表示され、live 接続を張らないこと
5. Codex / OpenCode の TUI で入力、プロンプト、全画面描画が破綻しないこと
6. idle cleanup 後に viewer を戻すと再購読できること

## 判定

- 実装観点:
  - Issue #460 の terminal page 移行に必要な主要挙動は automated test で概ね確認済み
- 運用観点:
  - 実機 manual verification は未完了
  - 本番投入前にブラウザ + tmux 実環境で上記 6 項目の確認が必要
