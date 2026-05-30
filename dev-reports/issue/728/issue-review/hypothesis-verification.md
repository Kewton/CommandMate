# Issue #728 仮説検証レポート (Phase 0.5)

Issue #728 は機能追加（PC版ターミナル 1-3 横分割 + 各スプリット独立 CLI/MessageInput）。
仮説そのものは少ないが、本文中で「既存コードがこうなっている」と前提している事実主張が複数あるため、Stage 1 レビュー前にコードベースと照合した。

検証ブランチ: `feature/728-worktree` @ HEAD `73263e39`

## 検証結果サマリ

| # | 仮説/主張 | 判定 | 申し送り |
|---|----------|------|---------|
| 1 | MessageInput draft key は `commandmate:messageDraft:{worktreeId}` | **Rejected** | 実際は `commandmate:draft-message:${worktreeId}`。Issue 本文の「実装方針 3.」のキー名修正が必要 |
| 2 | 既存の `mcbd-claude-{worktreeId}` パターンを `splitIndex=0` で維持できる | **Confirmed** | `src/lib/session/claude-session.ts:425-426` `getSessionName()` で一意。同一CLI再利用も `hasSession()` で済 |
| 3 | `FilePanelSplit` が現状のターミナル+ファイル分割パターン | **Confirmed** | `src/components/worktree/FilePanelSplit.tsx` がそのまま該当 |
| 4 | Issue #730 後の構造: ActivityBar / WorktreeDesktopLayout (2col) / TerminalContainer (History+Terminal) / FilePanelSplit | **Confirmed** | TerminalContainer の `terminal` prop が FilePanelSplit。Issue #728 が分割したい領域は「FilePanelSplit 内の Terminal 側」 |
| 5 | CLI セレクター候補 = Claude / Codex / Gemini / Copilot / OpenCode / Vibe Local | **Confirmed** | `src/cli/config/cli-tool-ids.ts:10` `['claude','codex','gemini','vibe-local','opencode','copilot']` |
| 6 | NavigationButtons / special-keys API / Auto-Yes 再利用可能 | **Confirmed (要注意)** | Auto-Yes は既に `(worktreeId, cliToolId)` 複合キー（Issue #525）。**スプリットごとに同一CLIが複数立つ場合の動作**を仕様で確定する必要あり |
| 7 | PaneResizer 流用可能 | **Confirmed** | `src/components/worktree/PaneResizer.tsx` — `horizontal/vertical` 対応・既に WorktreeDesktopLayout/TerminalContainer/FilePanelSplit で使用済み |
| 8 | LayoutState に `terminalSplits` を追加可能 | **Confirmed** | `src/types/ui-state.ts:108-129` 現状フィールド: `mode, mobileActivePane, leftPaneTab, splitRatio, leftPaneCollapsed, activityBar, historyPane`。`historyPane` の後に追加可 |

## 影響度の大きい修正必要点

### Rejected: MessageInput draft key 名

- **Issue 記載**: `commandmate:messageDraft:${worktreeId}`
- **実コード**: `src/components/worktree/MessageInput.tsx:39, 79, 97, 152` = `commandmate:draft-message:${worktreeId}`
- **影響**: Issue 「実装方針 3. MessageInput のスコープ化」の下位互換マイグレーションコード（旧キー → splitIndex=0）が **そのまま実装するとそもそも旧キーをヒットしない**。Stage 1 レビューで Must Fix として正す必要あり。

### Confirmed (要注意): 同一CLIを2スプリットで開いた場合の tmux セッション共有

- **Issue 記載**: 「同一CLIを2スプリットで開いた場合は同じ tmux セッションを共有（出力ミラーリング）」
- **実コード**: `claude-session.ts:425-426` は worktreeId のみで session 名が決まる。`hasSession()` で再利用される。よって**同じCLI×同じworktreeなら自然に共有される**実装が既にある。
- **未確定**: 出力は共有されるが、**Auto-Yes 制御 / 特殊キー送信 / NavigationButtons の押下** がどちらのスプリットからも同じセッションに飛ぶ。これは仕様として OK か、片方を「主導権あり」にするか、Stage 1 レビューで意思決定が必要。

### Confirmed (要注意): Auto-Yes と response-poller のキー設計

- 現状: `(worktreeId, cliToolId)` 複合キー（Issue #525）
- スプリット導入後: 同一 (worktreeId, cliToolId) を 2 スプリットで持ったとき、Auto-Yes は **どちらか片方からの ON で両方有効** になる。これは「スプリットごとに独立して制御」という Issue の受入条件と矛盾する。
- **Stage 1 で扱うべき論点**: スプリットごとに独立した Auto-Yes 状態を持つなら、キーを `(worktreeId, cliToolId, splitIndex)` にする必要がある。が、tmux セッションは共有されるので**実際に送られる "y" は同一セッションへの送信**になり、矛盾する。
- 設計選択: (A) 同一CLI複数スプリット時は Auto-Yes を共有する / (B) 同一CLI複数スプリットを許容しない / (C) 後発スプリットは「ミラー表示専用」とする、のいずれか。

## Stage 1 レビューへの申し送り事項

1. **MUST FIX**: MessageInput draft key を `commandmate:draft-message:{worktreeId}:{splitIndex}` に訂正。旧キーマイグレーションは正しいキー名で記述。
2. **論点**: 同一 (worktreeId, cliToolId) を複数スプリットで開く場合の挙動を Issue で確定（出力共有/独立操作/禁止のいずれか）。これが決まらないと TDD 不可。
3. **論点**: Auto-Yes / response-poller のキー設計が変わるかどうか。変えるなら `auto-yes-manager.ts` / `response-poller.ts` の API 変更が影響範囲に追加される。
4. **論点**: `splitIndex` を worktreeId スコープの状態に持つか、`(worktreeId, cliToolId)` ペアに持つか。スプリットが何で識別されるかをデータモデルレベルで確定。
5. **モバイル明示**: Issue は「PCのみ」だが、`WorktreeDetailRefactored.tsx` 側で MobileLayout fallback はどう扱うかの記述が薄い。レイアウト切替境界を明文化すべき。
