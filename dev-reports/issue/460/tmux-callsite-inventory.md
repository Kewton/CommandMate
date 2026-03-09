# tmux.ts 利用箇所棚卸し

## 対象

`src/lib/tmux.ts` の直接 import 箇所を Phase 0 時点で分類した。

## 分類結果

### Phase 1 で transport 化の入口にする箇所

| ファイル | 用途 | 方針 |
|---------|------|------|
| `src/lib/cli-session.ts` | session existence / capture | `SessionTransport` 経由へ移行開始 |
| `src/app/api/worktrees/[id]/capture/route.ts` | terminal snapshot capture | 将来的に transport selector 利用候補 |
| `src/app/api/worktrees/[id]/terminal/route.ts` | terminal input | terminal gateway 導入後に再整理 |

### 当面は直接利用を維持する箇所

| ファイル | 用途 | 理由 |
|---------|------|------|
| `src/lib/claude-session.ts` | Claude 固有 session lifecycle | CLI tool 固有挙動が多く、Phase 1 ではスコープ外 |
| `src/lib/cli-tools/codex.ts` | Codex session lifecycle / input | 同上 |
| `src/lib/cli-tools/gemini.ts` | Gemini 固有処理 | 同上 |
| `src/lib/cli-tools/vibe-local.ts` | Vibe Local 固有処理 | 同上 |
| `src/lib/cli-tools/opencode.ts` | OpenCode 固有処理 / resize 補償 | control mode 導入後の follow-up 対象 |
| `src/lib/prompt-answer-sender.ts` | prompt answer input | transport 化の候補だが影響範囲が広い |
| `src/lib/pasted-text-helper.ts` | pasted text 補助 capture | 現時点では snapshot 前提 |
| `src/app/api/worktrees/[id]/respond/route.ts` | prompt 応答送信 | 既存 `sendKeys` 経路を維持 |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | session kill | low-level 操作のまま維持 |
| `src/app/api/worktrees/[id]/route.ts` | session list 状態取得 | terminal live transport と直結しない |
| `src/app/api/worktrees/route.ts` | session list 状態取得 | 同上 |
| `src/app/api/repositories/route.ts` | repository 削除時の session cleanup | 同上 |

### テスト

`tests/unit/tmux.test.ts` などの `tmux.ts` 直接 import は Phase 1 では維持する。transport 導入後も low-level 単体テストは必要。

## 判断

- Phase 1 の主変更点は `cli-session.ts` に限定する
- CLI tool 固有 session lifecycle の transport 化は follow-up とする
- `response-poller.ts` / `current-output` は `cli-session.ts` 経由のため、Phase 1 で間接的に polling transport 配下へ入る
