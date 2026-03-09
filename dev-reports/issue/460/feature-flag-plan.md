# Feature Flag 方針

## 目的

tmux control mode 導入を terminal page 限定で段階有効化し、異常時は既存 polling 経路へ即時 rollback できるようにする。

## 採用フラグ

### `TMUX_CONTROL_MODE_ENABLED`

- 型: boolean
- デフォルト: `false`
- 役割: control mode transport 全体の大元フラグ

### `TMUX_CONTROL_MODE_TERMINAL_PAGE_ONLY`

- 型: boolean
- デフォルト: `true`
- 役割: terminal page のみ有効化し、worktree detail への波及を防ぐ

## 有効化条件

- `TMUX_CONTROL_MODE_ENABLED=true`
- terminal page 経路であること
- session / worktree authorization が通ること

## rollback 条件

- parser 異常
- terminal stream reconnect 失敗の多発
- idle cleanup 漏れ
- `capture-pane` fallback 不能
- terminal page 表示不整合

## 実装メモ

- フラグ判定は server 側 transport selector と terminal page 接続初期化の両方で行う
- `TMUX_CONTROL_MODE_ENABLED=false` の場合は常に `PollingTmuxTransport`
- Phase 1 時点では flag 追加のみ。実際の切り替えは terminal gateway 実装時に使用する
