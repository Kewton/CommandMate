# Issue #736 マルチステージレビュー完了報告

**対象**: refactor(terminal): remove state.terminal.* reducer slice by migrating Mobile to useTerminalPanePolling (#728 R3-007 + R3-010)
**実施日**: 2026-05-31
**レビュアー**: Claude opus（Stage 1）+ PM grep検証（Stage 3）

## 仮説検証結果（Phase 0.5）

| # | 主張 | 判定 |
|---|------|------|
| 1 | PC経路は useTerminalPanePolling に移行済み | Confirmed |
| 2 | state.terminal.* slice が二重実装で残置（16件） | Confirmed |
| 3 | Mobile経路は state.terminal.* を消費 | Confirmed |
| 4 | TerminalState 型は ui-state.ts に定義 | Confirmed |
| 5 | SET_TERMINAL_* action は ui-actions.ts | Confirmed（ただし SET_AUTO_SCROLL も terminal slice、計4） |
| 6 | 影響テスト3件が存在 | Confirmed |
| 7 | useTerminalPanePolling が output/prompt/selection 等を提供 | Confirmed |

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | 7主張 | - | 完了（全Confirmed） |
| 1 | 通常レビュー（1回目） | 8（M3/S4/N1） | 8 | 完了 |
| 2 | 指摘事項反映（1回目） | - | 8 | 完了（Issue本文更新） |
| 3 | 影響範囲レビュー（1回目） | 4（M0/S2/N2） | 4 | 完了 |
| 4 | 指摘事項反映（1回目） | - | 4 | 完了（Issue本文更新） |
| 5-8 | 2回目イテレーション（Codex） | - | - | **スキップ**（ユーザー指示: Codex委任スキップ） |

## 主要 Must Fix（実装必須考慮点）

- **M1**: 複合action `START_WAITING_FOR_RESPONSE`/`RESPONSE_RECEIVED`/`SESSION_ENDED` も `state.terminal` を変更 → slice削除でコンパイルエラー。production未使用なので削除可（要テスト更新）。
- **M2**: `fetchCurrentOutput` は prompt/isSelectionListActive/Auto-Yes も駆動。hook はそれらを所有しないため Mobile の state 分割方針を確定（hook=terminal/prompt/selection、parent=Auto-Yes/messages、二重polling許容）。
- **M3**: parent 側 `state.terminal`/`setTerminal*` 参照 7箇所（polling gate L1356、MessageInput L2044、handleAutoScrollChange、L426、L610-612、handleKillConfirm）を全列挙し移行/除去。
- **S1**: 削除 action は4種（`SET_AUTO_SCROLL` 含む）。

## 次のアクション

- [x] Issueの最終確認（本文更新済み）
- [ ] ~~/design-policy~~（スキップ: ユーザー指示）
- [ ] ~~/multi-stage-design-review~~（スキップ: ユーザー指示）
- [ ] /work-plan で作業計画立案（Phase 4）
- [ ] /pm-auto-dev で TDD実装（Phase 5）
