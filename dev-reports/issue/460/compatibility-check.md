# Issue #460 互換性確認メモ

更新日: 2026-03-09

## 対象

- `src/app/api/worktrees/[id]/current-output/route.ts`
- `src/lib/cli-session.ts`
- `src/lib/response-poller.ts`
- `src/components/worktree/WorktreeDetailRefactored.tsx`

## 結論

Issue #460 の現時点実装では、terminal page に control mode 系の streaming 経路を追加した一方で、worktree detail と `current-output` / `response-poller` の snapshot path は維持されている。

そのため、後方互換性の観点では以下を満たしている。

- `current-output` API は継続利用可能
- worktree detail は既存 polling 前提のまま成立
- `response-poller.ts` は既存の `captureSessionOutput()` 契約を継続利用できる
- control mode 導入により snapshot path が破壊される状態にはなっていない

## 確認結果

### 1. `current-output` API の経路

`src/app/api/worktrees/[id]/current-output/route.ts` は引き続き `captureSessionOutput()` を使用している。

確認内容:

- route 自体に control mode 専用分岐は未追加
- `captureSessionOutput()` の返却契約は変更していない
- status 判定は従来どおり `detectSessionStatus()` を利用している

判断:

- worktree detail の current snapshot 取得は互換維持
- terminal page の live stream 追加は `current-output` API を置き換えていない

### 2. `cli-session.ts` の互換レイヤー

`src/lib/cli-session.ts` は `SessionTransport` を導入したが、デフォルト transport は `getPollingTmuxTransport()` のまま。

確認内容:

- `getDefaultTransport()` は polling transport を返す
- `captureSessionOutput()` は `transport.captureSnapshot()` を使う
- `captureSessionOutputFresh()` も snapshot 契約を維持
- cache (`tmux-capture-cache.ts`) の利用形態は維持

判断:

- `capture-pane` ベースの snapshot path は abstraction の裏側に移動しただけ
- `current-output` と `response-poller` は既存挙動を保ったまま transport seam の配下に入った

### 3. `response-poller.ts` の継続性

`src/lib/response-poller.ts` は `captureSessionOutput()` / `isSessionRunning()` を利用しており、control mode への直接依存は追加されていない。

確認内容:

- polling interval / extraction / prompt detection ロジックに変更なし
- output source は `cli-session.ts` の公開 API のまま
- worktree detail や assistant-response-saver の前提契約も維持

判断:

- Issue #460 の変更は `response-poller.ts` の呼び出し元契約を壊していない
- hidden session / non-viewing path は従来の polling path で継続可能

### 4. worktree detail 側の影響

`src/components/worktree/WorktreeDetailRefactored.tsx` は引き続き `/api/worktrees/${worktreeId}/current-output` を定期取得している。

確認内容:

- terminal page とは別経路のまま
- live stream gateway への直接切り替えは未実施
- UI 側の `terminalOutput` 更新ロジックに breaking change なし

判断:

- worktree detail は Issue #460 現段階では非移行
- 既存 polling 表示と active prompt 表示は影響を受けない

## リスク

### 低リスク

- `SessionTransport` 追加により snapshot path の実装位置は変わったが、外部契約は維持されている

### 中リスク

- 今後 `cli-session.ts` の default transport を切り替える場合、`response-poller.ts` / `current-output` / prompt verification の期待値確認が必要
- `PollingTmuxTransport` と `ControlModeTmuxTransport` の capability 差異が上位で十分に分岐されていない箇所は follow-up 対象

## 結論

Phase 5.1 の観点では、snapshot path は破壊されていない。Issue #460 の control mode 導入は terminal page に限定され、worktree detail と `response-poller` は後方互換性を保っている。
