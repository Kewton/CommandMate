> **Note**: このIssueは 2026-03-13 にレビュー結果（Stage 4: 影響範囲レビュー指摘反映）を反映して更新されました。
> 詳細: dev-reports/issue/481/issue-review/

## 親Issue

- #475

## 概要

`src/lib` ルートに72ファイルが密集しており、ファイル探索性が低下している。既存のサブディレクトリパターン（`cli-tools/`, `proxy/`, `external-apps/`, `transports/`）を拡張し、ドメイン別に再整理する。

## 影響規模

本リファクタリングは以下の規模の変更を伴う:

| 項目 | 規模 |
|------|------|
| 移動対象ファイル | 35ファイル（7グループ） |
| 更新が必要なimport行 | 約696行 |
| 影響を受けるソースファイル | src/app/api/ 等 約100ファイル |
| 影響を受けるテストファイル | tests/ 約99ファイル |
| 影響を受けるlib内テスト | src/lib/__tests__/ 9ファイル中6ファイル |
| ドキュメント更新（CLAUDE.md） | 約52箇所のパス参照 |
| ドキュメント更新（module-reference.md） | 約54箇所のパス参照 |
| ドキュメント更新（architecture.md） | 約6箇所のパス参照 |

### 段階的移行戦略

規模が大きいため、グループ単位で段階的に移行する。各グループのバレルエクスポート（index.ts）を先行設置することで、importパスの安定化を図る。

**推奨移行順序**（依存の方向: tmux <- session <- polling, detection <- session/polling）:

1. **db/** - 最もimport参照が多い（db-instance: 46ファイル、db: 36ファイル）が、他グループへの依存がなく独立している
2. **tmux/** - session/ の前提。他の新規グループへの依存なし
3. **security/** - 他の新規グループへの依存なし
4. **detection/** - session/, polling/ の前提。tmux/ への依存なし
5. **session/** - detection/, tmux/ に依存
6. **polling/** - session/, detection/ に依存
7. **git/** - 独立しているが優先度が低い

## グループ間依存関係

移動対象グループ間には以下の依存関係が存在する。依存方向は一方向（polling -> session -> detection/tmux）であり、循環依存リスクは低い。

```
polling/ ──→ session/ ──→ detection/
   │             │
   │             └──→ tmux/
   └──→ detection/

transports/ ──→ tmux/
```

**具体的な依存:**

| From | To | Via | 依存ファイル |
|------|----|-----|-------------|
| polling/ | session/ | cli-session | response-poller, auto-yes-manager |
| polling/ | detection/ | prompt-detector, cli-patterns, prompt-key | response-poller, auto-yes-manager |
| session/ | detection/ | status-detector | claude-session, worktree-status-helper, claude-executor |
| session/ | tmux/ | tmux, tmux-capture-cache | claude-session, cli-session, session-cleanup, worktree-status-helper |
| transports/ | tmux/ | tmux, tmux-control-mode-metrics, tmux-control-registry | control-mode-tmux-transport |

### 高影響ファイル

| ファイル | 外部からのimport数 |
|---------|-------------------|
| db-instance | 46ファイル |
| db (db.ts) | 36ファイル |
| auto-yes-manager | 11ファイル |
| tmux | 8ファイル |
| path-validator | 6ファイル |
| git-utils | 5ファイル |

## 提案するサブディレクトリ構成

```
src/lib/
├── cli-tools/        # 既存: CLIツール抽象化 (11ファイル: base, claude, codex, gemini, index, manager, opencode-config, opencode, types, validation, vibe-local)
├── proxy/            # 既存: プロキシ (4ファイル: config, handler, index, logger)
├── external-apps/    # 既存: 外部アプリ (5ファイル: cache, db, index, interfaces, validation)
├── transports/       # 既存: tmuxトランスポート (2ファイル: control-mode-tmux-transport, polling-tmux-transport)
├── __tests__/        # 既存: テスト (9ファイル) ※ディレクトリ位置は現状維持（下記注記参照）
├── db/               # 新規: DB関連 (6ファイル: db.ts, db-instance, db-migrations, db-path-resolver, db-repository, db-migration-path)
├── session/          # 新規: セッション管理 (6ファイル: claude-session, cli-session, session-cleanup, session-transport, worktree-status-helper, claude-executor)
├── detection/        # 新規: 検出系 (4ファイル: status-detector, prompt-detector, cli-patterns, prompt-key)
├── tmux/             # 新規: tmux関連 (7ファイル: tmux.ts, tmux-capture-cache.ts, tmux-control-client.ts, tmux-control-mode-flags.ts, tmux-control-mode-metrics.ts, tmux-control-parser.ts, tmux-control-registry.ts)
├── security/         # 新規: セキュリティ (6ファイル: auth, ip-restriction, path-validator, env-sanitizer, sanitize, worktree-path-validator)
├── git/              # 新規: Git操作 (3ファイル: git-utils, worktrees, clone-manager)
├── polling/          # 新規: ポーリング・自動応答 (3ファイル: response-poller, auto-yes-manager, auto-yes-resolver) ※session/, detection/, cli-tools/ への外部依存が多い。凝集度向上のため将来的なグループ再編を検討可能
└── (残り)            # ルート残留ファイル（下記参照）
```

### __tests__/ ディレクトリの注記

ディレクトリ位置は現状維持だが、移動対象ファイルへの相対importパス（`../db`, `../db-migrations`, `../cli-session`, `../status-detector`, `../cli-patterns` 等）は `@/lib/group/xxx` 形式に更新が必要。

**影響ファイル:** worktrees-sync.test.ts, db-migrations-v10.test.ts, db-memo.test.ts, assistant-response-saver.test.ts, status-detector.test.ts, cli-patterns.test.ts

### transports/ の扱い方針

`transports/` ディレクトリには tmux トランスポート実装が2ファイル存在する。これらは tmux/ への統合候補だが、トランスポート層としての責務分離を考慮し、以下のいずれかの方針を実装時に決定する:

- **案A**: `tmux/` に統合（tmux関連を一箇所に集約）
  - 影響: cli-session.ts, ws-server.ts + テスト4ファイルのimportパス変更
  - transports/index.ts は不要になる
- **案B**: `transports/` を現状維持（レイヤー分離を優先）
  - 影響: transports/ 内3ファイルの相対パスを `../tmux/xxx` に変更
  - transports/ に index.ts を新設するか検討

### db/ グループの後方互換性

現在 `@/lib/db` で db.ts を直接importしているコードが36箇所ある。db/ ディレクトリ作成後は `@/lib/db` がディレクトリを指すようになるため、`db/index.ts` で db.ts の全 export を再エクスポートすれば、外部からの `@/lib/db` import は変更不要になる可能性がある。この戦略を積極的に活用し、移行コストを削減する。

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

### importパス更新

- [ ] 外部からの参照（`@/lib/xxx` → `@/lib/group/xxx` または `@/lib/group` 経由）の一括更新
- [ ] 移動ファイル内部の相対import（`./xxx`）を、同一グループ内は相対パス維持、グループ外は `@/lib/` パス形式に変換
- [ ] `__tests__/` 内の相対importパスを `@/lib/group/xxx` 形式に更新（6ファイル）
- [ ] `vi.mock()` のモジュールパス指定も `@/lib/group/xxx` に更新すること（バレルエクスポートで旧パスを維持する場合はmock対象パスの変更は不要だが、方針を明確にすること）

### 循環依存チェック

- [ ] 循環依存が発生しないこと（`npx tsc --noEmit` での間接確認、または madge 等の専用ツールで検証）
- [ ] リファクタリング前後でimportグラフに循環が増加しないこと

### テスト・ビルド

- [ ] 既存テストが全パス（`npm run test:unit`）
- [ ] `npm run lint && npx tsc --noEmit` がパス

### ドキュメント更新

- [ ] CLAUDE.md のモジュール一覧を更新（約52箇所のパス参照）
- [ ] docs/module-reference.md のパス更新（約54箇所のパス参照）
- [ ] docs/architecture.md の更新（約6箇所のパス参照、該当する場合）

### バレルエクスポート

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

### イテレーション 2 - 影響範囲レビュー (2026-03-13)
- F101: 影響規模セクションを追加（35ファイル移動、約696行import更新、約100ソースファイル・約99テストファイル影響）
- F102: グループ間依存関係セクションを追加（依存方向の図・具体的依存テーブル）、推奨移行順序を明記
- F103: 受け入れ基準のimportパス更新を4項目に細分化（外部参照・内部相対・__tests__・vi.mock()）
- F104: db/ グループの後方互換性戦略を追記（@/lib/db パスの維持方法）
- F105: __tests__/ の注記を追加（相対importパス更新が必要な6ファイルを列挙）
- F106: transports/ 案A/案Bの具体的影響差分を追記
- F107: ドキュメント更新の影響規模を明記（CLAUDE.md: 52箇所、module-reference.md: 54箇所、architecture.md: 6箇所）
- F108: vi.mock() のモジュールパス更新方針を受け入れ基準に追加
- F109: polling/ グループに凝集度に関する注釈を追記
