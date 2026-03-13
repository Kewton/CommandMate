> **Note**: このIssueは 2026-03-13 にレビュー結果を反映して更新されました。
> 詳細: dev-reports/issue/481/issue-review/

## 親Issue

- #475

## 概要

`src/lib` ルートに72ファイルが密集しており、ファイル探索性が低下している。既存のサブディレクトリパターン（`cli-tools/`, `proxy/`, `external-apps/`, `transports/`）を拡張し、ドメイン別に再整理する。

## 提案するサブディレクトリ構成

```
src/lib/
├── cli-tools/        # 既存: CLIツール抽象化 (11ファイル: base, claude, codex, gemini, index, manager, opencode-config, opencode, types, validation, vibe-local)
├── proxy/            # 既存: プロキシ (4ファイル: config, handler, index, logger)
├── external-apps/    # 既存: 外部アプリ (5ファイル: cache, db, index, interfaces, validation)
├── transports/       # 既存: tmuxトランスポート (2ファイル: control-mode-tmux-transport, polling-tmux-transport)
├── __tests__/        # 既存: テスト (9ファイル) ※現状維持
├── db/               # 新規: DB関連 (6ファイル: db.ts, db-instance, db-migrations, db-path-resolver, db-repository, db-migration-path)
├── session/          # 新規: セッション管理 (6ファイル: claude-session, cli-session, session-cleanup, session-transport, worktree-status-helper, claude-executor)
├── detection/        # 新規: 検出系 (4ファイル: status-detector, prompt-detector, cli-patterns, prompt-key)
├── tmux/             # 新規: tmux関連 (7ファイル: tmux.ts, tmux-capture-cache.ts, tmux-control-client.ts, tmux-control-mode-flags.ts, tmux-control-mode-metrics.ts, tmux-control-parser.ts, tmux-control-registry.ts)
├── security/         # 新規: セキュリティ (6ファイル: auth, ip-restriction, path-validator, env-sanitizer, sanitize, worktree-path-validator)
├── git/              # 新規: Git操作 (3ファイル: git-utils, worktrees, clone-manager)
├── polling/          # 新規: ポーリング・自動応答 (3ファイル: response-poller, auto-yes-manager, auto-yes-resolver)
└── (残り)            # ルート残留ファイル（下記参照）
```

### transports/ の扱い方針

`transports/` ディレクトリには tmux トランスポート実装が2ファイル存在する。これらは tmux/ への統合候補だが、トランスポート層としての責務分離を考慮し、以下のいずれかの方針を実装時に決定する:

- **案A**: `tmux/` に統合（tmux関連を一箇所に集約）
- **案B**: `transports/` を現状維持（レイヤー分離を優先）

### ルート残留ファイル一覧（37ファイル）

以下のファイルは今回のリファクタリングではルートに残留する:

```
# API・通信系
api-client.ts
api-logger.ts
ws-server.ts

# Claude出力系
claude-output.ts
prompt-answer-sender.ts
prompt-response-body-builder.ts

# 会話・メッセージ系
conversation-grouper.ts
conversation-logger.ts
message-sync.ts
assistant-response-saver.ts

# ファイル操作系
file-operations.ts
file-search.ts
file-tree.ts

# ログ系
log-export-sanitizer.ts
log-manager.ts
logger.ts

# 環境・設定系
env.ts
cmate-parser.ts
cmate-validator.ts

# コマンド・スラッシュ系
command-merger.ts
standard-commands.ts
slash-commands.ts

# スケジュール・リソース管理
schedule-manager.ts
resource-cleanup.ts
selected-agents-validator.ts

# ユーティリティ系
utils.ts
date-utils.ts
date-locale.ts
locale-cookie.ts
clipboard-utils.ts
pasted-text-helper.ts
terminal-highlight.ts
url-normalizer.ts
url-path-encoder.ts
sidebar-utils.ts
errors.ts
version-checker.ts
```

### 追加サブディレクトリ候補（将来検討）

残留ファイル数を更に削減するために、以下のサブディレクトリを将来的に検討可能:

- `logging/` - api-logger, logger, log-manager, log-export-sanitizer (4ファイル)
- `file/` - file-operations, file-search, file-tree (3ファイル)
- `conversation/` - conversation-grouper, conversation-logger, message-sync, assistant-response-saver (4ファイル)

### バレルエクスポート（index.ts）方針

各新規サブディレクトリには `index.ts` を設置し、外部からはバレルエクスポート経由でimportする方針とする。これにより:
- importパスの安定性を確保（内部ファイル名変更時の影響を最小化）
- 既存の cli-tools/, proxy/, external-apps/ と同じパターンを踏襲

## 受け入れ基準

- [ ] import パスの一括更新
- [ ] 循環依存が発生しないこと（`npx tsc --noEmit` での間接確認、または madge 等の専用ツールで検証）
- [ ] リファクタリング前後でimportグラフに循環が増加しないこと
- [ ] 既存テストが全パス（`npm run test:unit`）
- [ ] `npm run lint && npx tsc --noEmit` がパス
- [ ] CLAUDE.md のモジュール一覧を更新
- [ ] docs/module-reference.md のパス更新
- [ ] docs/architecture.md の更新（該当する場合）
- [ ] 各新規サブディレクトリに index.ts（バレルエクスポート）を設置

---

## レビュー履歴

### イテレーション 1 (2026-03-13)
- F001: cli-tools/ のファイル数を 7 → 11 に修正
- F002: proxy/ のファイル数を 2 → 4 に修正
- F003: external-apps/ のファイル数を 1 → 5 に修正
- F004: transports/ ディレクトリ（2ファイル）と __tests__/ ディレクトリの記載を追加
- F005: ルート残留ファイル37件の具体リストを追記、追加サブディレクトリ候補を提示
- F006: tmux/ の対象ファイル7件を具体的に列挙
- F007: worktree-status-helper.ts, claude-executor.ts を session/ に分類追加
- F008: 循環依存の検証方法を明確化（madge/tsc --noEmit）
- F009: docs/module-reference.md, docs/architecture.md を更新対象に追加
- F010: polling/ の説明を「ポーリング・自動応答」に変更
- F011: バレルエクスポート（index.ts）方針セクションを追加
