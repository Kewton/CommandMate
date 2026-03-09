# Issue #460 follow-up notes

更新日: 2026-03-09

## 目的

Issue #460 の現時点実装を terminal page 先行導入として整理し、worktree detail 統合や polling 依存整理の次アクションを残す。

## active session view への限定統合条件

worktree detail を直ちに全面 streaming 化するのではなく、以下の条件が揃った場合のみ active session view から限定導入する。

1. `current-output` と live stream の優先順位を UI で明示できること
2. active tab / visible panel のみ subscribe する resource control があること
3. prompt detection と status detection が live chunk でも崩れないこと
4. reconnect / fallback / terminal closed 状態を UI で説明できること
5. non-active session は snapshot path に残せること

## 残る polling 依存箇所

現時点で polling 依存を維持している主要箇所:

- `src/app/api/worktrees/[id]/current-output/route.ts`
- `src/lib/response-poller.ts`
- `src/components/worktree/WorktreeDetailRefactored.tsx`
- `src/lib/assistant-response-saver.ts`
- `src/lib/auto-yes-manager.ts`
- `src/lib/prompt-answer-sender.ts` 周辺の prompt verification flow

判断:

- これらは hidden session / background observation / message extraction と結びついており、Issue #460 単体で全面移行するのは過剰

## 将来削除候補の特殊ケース処理

### 1. terminal page の旧直結前提

旧 `ws://localhost:3000/terminal/...` 前提は browser 側から除去済み。将来的には関連コメントや旧前提の運用知識も削除対象。

### 2. OpenCode 向け polling 補償

`response-poller.ts` には OpenCode の alternate screen / overlap accumulation 補償がある。terminal page の live stream では直接は不要だが、background extraction が残るため即削除対象ではない。

### 3. prompt verification の fresh capture

`captureSessionOutputFresh()` に依存する prompt-response 再検証は snapshot path 前提。control mode event だけで置き換えるには、buffer consistency の設計を別途要する。

### 4. tool-specific session lifecycle

`src/lib/cli-tools/codex.ts`、`src/lib/cli-tools/opencode.ts`、`src/lib/claude-session.ts` などは tmux low-level API を直接使っている。transport abstraction 配下へ寄せるとしても別 issue で段階化すべき。

## 推奨 follow-up 順

1. gateway test を追加して unauthorized / invalid worktree / disconnect cleanup / parser fallback を埋める
2. terminal page の reconnect / fallback UX を integration test で固める
3. worktree detail の active view 限定 subscribe を別 issue で設計する
4. `cli-tools/*` の tmux low-level 呼び出し棚卸しを再実施し、transport 化対象を切り出す
5. metrics の公開方法を決める

## 非推奨

- `response-poller.ts` を Issue #460 の続きで即時置換すること
- all sessions を常時 subscribe すること
- browser に tmux 制御面を直接露出すること

## 結論

Issue #460 の次段階は「worktree detail 全面移行」ではなく、「gateway/terminal page の品質補強」と「active session view だけを対象にした限定統合設計」が妥当。
