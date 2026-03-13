# Issue #481 仮説検証レポート

## 検証日時
- 2026-03-13

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | src/lib ルートに72ファイルが密集している | Confirmed | `find src/lib -maxdepth 1 -type f` → 72件 |
| 2 | 既存サブディレクトリは cli-tools/, proxy/, external-apps/ の3つ | Partially Confirmed | transports/ も存在（未言及） |
| 3 | cli-tools/ は 7ファイル | Rejected | 実際は11ファイル（base.ts, claude.ts, codex.ts, gemini.ts, index.ts, manager.ts, opencode-config.ts, opencode.ts, types.ts, validation.ts, vibe-local.ts） |
| 4 | proxy/ は 2ファイル | Rejected | 実際は4ファイル（config.ts, handler.ts, index.ts, logger.ts） |
| 5 | external-apps/ は 1ファイル | Rejected | 実際は5ファイル（cache.ts, db.ts, index.ts, interfaces.ts, validation.ts） |
| 6 | 提案するdb/,session/,detection/,tmux/,security/,git/,polling/の各ファイルが存在する | Confirmed | 全対象ファイルがsrc/libルートに存在 |

## 詳細検証

### 仮説 1: src/lib ルートに72ファイルが密集

**Issue内の記述**: 「src/lib ルートに72ファイルが密集しており、ファイル探索性が低下している」

**検証手順**:
1. `find src/lib -maxdepth 1 -type f | wc -l` 実行

**判定**: Confirmed

**根拠**: 実際に72ファイルが確認された。

---

### 仮説 2: 既存サブディレクトリ（cli-tools/, proxy/, external-apps/）

**Issue内の記述**: 「既存のサブディレクトリパターン（cli-tools/, proxy/, external-apps/）を拡張し」

**検証手順**:
1. `find src/lib -maxdepth 1 -type d` で確認

**判定**: Partially Confirmed

**根拠**: cli-tools/, proxy/, external-apps/ は存在するが、`transports/` ディレクトリ（control-mode-tmux-transport.ts, polling-tmux-transport.ts の2ファイル）が存在するにも関わらず未言及。

**Issueへの影響**: transports/ ディレクトリの扱いを明記する必要がある。

---

### 仮説 3: cli-tools/ のファイル数

**Issue内の記述**: 「cli-tools/ 既存: CLIツール抽象化 (7ファイル)」

**判定**: Rejected

**根拠**: 実際は11ファイル（base.ts, claude.ts, codex.ts, gemini.ts, index.ts, manager.ts, opencode-config.ts, opencode.ts, types.ts, validation.ts, vibe-local.ts）

---

### 仮説 4: proxy/ のファイル数

**Issue内の記述**: 「proxy/ 既存: プロキシ (2ファイル)」

**判定**: Rejected

**根拠**: 実際は4ファイル（config.ts, handler.ts, index.ts, logger.ts）

---

### 仮説 5: external-apps/ のファイル数

**Issue内の記述**: 「external-apps/ 既存: 外部アプリ (1ファイル)」

**判定**: Rejected

**根拠**: 実際は5ファイル（cache.ts, db.ts, index.ts, interfaces.ts, validation.ts）

---

### 仮説 6: 提案ファイルの存在確認

**Issue内の記述**: db/, session/, detection/, tmux/, security/, git/, polling/ に移動するファイル群

**判定**: Confirmed

**根拠**: db.ts, db-instance.ts, db-migrations.ts, db-path-resolver.ts, db-repository.ts, db-migration-path.ts, claude-session.ts, cli-session.ts, session-cleanup.ts, session-transport.ts, status-detector.ts, prompt-detector.ts, cli-patterns.ts, prompt-key.ts, tmux.ts, tmux-capture-cache.ts, tmux-control-*.ts, auth.ts, ip-restriction.ts, path-validator.ts, env-sanitizer.ts, sanitize.ts, worktree-path-validator.ts, git-utils.ts, worktrees.ts, clone-manager.ts, response-poller.ts, auto-yes-manager.ts, auto-yes-resolver.ts --- すべて存在確認。

---

## Stage 1レビューへの申し送り事項

- **既存サブディレクトリのファイル数が誤っている**: cli-tools(7→11), proxy(2→4), external-apps(1→5) → Issue内の数値を修正する必要がある
- **transports/ ディレクトリが未言及**: 既存の `transports/` ディレクトリ（2ファイル）の扱いを明記すること（tmux/ サブディレクトリへの統合候補か、現状維持か）
- **未割り当てファイルの多さ**: 「(残り) ユーティリティ系は現状維持」として扱うファイルが多数あるが、具体的なリストがない（api-client.ts, claude-executor.ts, ws-server.ts等）
