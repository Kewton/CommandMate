# Issue #481 Stage 1 通常レビュー（1回目）レポート

## レビュー対象

- **Issue**: #481 refactor: src/lib ディレクトリ再整理（R-3）
- **レビュー日**: 2026-03-13
- **レビュータイプ**: 通常レビュー（Consistency & Correctness）

## レビューサマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 5 |
| should_fix | 4 |
| nice_to_have | 2 |
| **合計** | **11** |

## 総合評価

Issue #481は src/lib ルートの72ファイル密集問題を解決するリファクタリング提案として方向性は妥当だが、以下の重大な問題がある。

1. **既存サブディレクトリのファイル数がすべて誤っている** -- cli-tools: 7→実際11, proxy: 2→実際4, external-apps: 1→実際5
2. **既存の transports/ ディレクトリが完全に未言及** -- tmux関連トランスポート2ファイルが含まれる
3. **移動対象が全体の46%にとどまる** -- 72ファイル中33ファイルのみ移動、39ファイルがルート残留。残留ファイルのリストが不在

---

## 指摘事項一覧

### must_fix（5件）

#### F001: cli-tools/ のファイル数が誤り

- **カテゴリ**: 事実誤認
- **現在の記述**: `cli-tools/ # 既存: CLIツール抽象化 (7ファイル)`
- **実際**: 11ファイル（base.ts, claude.ts, codex.ts, gemini.ts, index.ts, manager.ts, opencode-config.ts, opencode.ts, types.ts, validation.ts, vibe-local.ts）
- **修正案**: ファイル数を11に修正

#### F002: proxy/ のファイル数が誤り

- **カテゴリ**: 事実誤認
- **現在の記述**: `proxy/ # 既存: プロキシ (2ファイル)`
- **実際**: 4ファイル（config.ts, handler.ts, index.ts, logger.ts）
- **修正案**: ファイル数を4に修正

#### F003: external-apps/ のファイル数が誤り

- **カテゴリ**: 事実誤認
- **現在の記述**: `external-apps/ # 既存: 外部アプリ (1ファイル)`
- **実際**: 5ファイル（cache.ts, db.ts, index.ts, interfaces.ts, validation.ts）
- **修正案**: ファイル数を5に修正

#### F004: transports/ ディレクトリの未言及

- **カテゴリ**: 情報欠落
- **内容**: 既存サブディレクトリとして transports/（control-mode-tmux-transport.ts, polling-tmux-transport.ts の2ファイル）が存在するが完全に未言及。tmux関連のトランスポート実装であり、新規 tmux/ への統合か現状維持かの方針決定が必要。また __tests__/ ディレクトリの扱いも未記載。
- **修正案**: 既存ディレクトリ一覧に transports/ を追加し、扱い方針を明記

#### F005: 残留ファイル39件の具体リスト不在

- **カテゴリ**: 情報欠落
- **内容**: 提案されたサブディレクトリへの移動対象は33ファイル。72ファイル中39ファイル（54%）がルートに残留するが「ユーティリティ系は現状維持」としか書かれていない。リファクタリングの効果が限定的になるリスクがある。
- **残留ファイル一覧**: api-client.ts, api-logger.ts, assistant-response-saver.ts, claude-executor.ts, claude-output.ts, clipboard-utils.ts, cmate-parser.ts, cmate-validator.ts, command-merger.ts, conversation-grouper.ts, conversation-logger.ts, date-locale.ts, date-utils.ts, env.ts, errors.ts, file-operations.ts, file-search.ts, file-tree.ts, locale-cookie.ts, log-export-sanitizer.ts, log-manager.ts, logger.ts, message-sync.ts, pasted-text-helper.ts, prompt-answer-sender.ts, prompt-response-body-builder.ts, resource-cleanup.ts, schedule-manager.ts, selected-agents-validator.ts, sidebar-utils.ts, slash-commands.ts, standard-commands.ts, terminal-highlight.ts, url-normalizer.ts, url-path-encoder.ts, utils.ts, version-checker.ts, worktree-status-helper.ts, ws-server.ts
- **修正案**: 残留ファイルリストを明記し、追加サブディレクトリの検討（例: logging/, file/, conversation/ 等）

### should_fix（4件）

#### F006: tmux/ のファイル列挙が不明確

- **カテゴリ**: 明確性不足
- **内容**: `tmux-control-*` のワイルドカード表記で実際の5ファイルが不明確。合計7ファイルになる。
- **修正案**: 具体的なファイル名を列挙し、transports/ からの統合も検討事項として記載

#### F007: worktree-status-helper.ts 等の分類漏れ

- **カテゴリ**: 完全性
- **内容**: worktree-status-helper.ts は cli-session, status-detector, claude-session に依存しており session/ または detection/ の候補。claude-executor.ts, claude-output.ts もセッション関連の分類候補。
- **修正案**: これらのファイルの分類先を明記するか、意図的に残留とする理由を記載

#### F008: 循環依存検証方法の未記載

- **カテゴリ**: 受け入れ基準
- **内容**: 「循環依存が発生しないこと」の検証方法が不明確。
- **修正案**: 検証ツール（madge等）または手法を明記

#### F009: ドキュメント更新対象の不足

- **カテゴリ**: 受け入れ基準
- **内容**: CLAUDE.md 以外にも docs/module-reference.md, docs/architecture.md 等の更新が必要な可能性。
- **修正案**: 更新対象ドキュメントを網羅的に列挙

### nice_to_have（2件）

#### F010: polling/ のドメイン名の妥当性

- **カテゴリ**: 実装リスク
- **内容**: auto-yes-manager/resolver はポーリングより自動応答判定の責務が強く、「polling」という名前が実態と合わない可能性。

#### F011: バレルエクスポート方針の未記載

- **カテゴリ**: 実装リスク
- **内容**: 各サブディレクトリに index.ts を設けるかどうかの方針が未記載。importパス更新の方針に大きく影響する。

---

## 仮説検証結果の反映

仮説検証で指摘された3つの申し送り事項はすべて本レビューの指摘事項に反映済み:

1. ファイル数の誤り → F001, F002, F003
2. transports/ 未言及 → F004
3. 未割り当てファイルリスト不在 → F005
