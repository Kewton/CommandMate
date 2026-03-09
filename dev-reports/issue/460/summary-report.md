# Issue #460 設計作成・レビュー完了報告

## 作成物

- 設計方針書: `dev-reports/issue/460/design-policy.md`
- 設計レビュー: `dev-reports/issue/460/design-review.md`
- 既存 issue レビュー: `dev-reports/issue/460/issue-review/`

## 要点

1. tmux control mode 導入は terminal page から段階導入し、worktree detail は後続フェーズに分離
2. `SessionTransport` + `PollingTmuxTransport` + `ControlModeTmuxTransport` の3層で snapshot と streaming を共存
3. browser から tmux control mode へ直接接続させず、server-side gateway で認証・権限制御を維持
4. feature flag、snapshot fallback、idle cleanup、metrics を設計段階で必須化

## レビュー結果

| 観点 | 判定 | 要旨 |
|------|------|------|
| 性能 | 妥当 | terminal page の live 化と snapshot 経路の共存が現実的 |
| 拡張性 | 妥当 | capability を持つ transport abstraction が有効 |
| セキュリティ | 妥当 | gateway 経由、auth 維持、resource control 明記 |
| 保守性 | 妥当 | dual-path 管理と rollback 方針が定義済み |

## 残タスク

- work plan で terminal gateway の実装位置を確定
- Phase 0 で `tmux.ts` 直接利用箇所を棚卸し
- Phase 1 用に control mode parser の fixture を準備
