# Issue #1: 初版開発 - 作業計画

**作成日**: 2025-11-17
**ステータス**: 計画完了 / 実装待機中
**見積もり**: 47-62時間（6-8日間の集中作業）

---

## 概要

git worktree ごとに Claude Code / tmux セッションを張り、スマホブラウザから「ブランチごとのチャット UI」として操作できる開発コンパニオンツール **myCodeBranchDesk** の初版を実装する。

---

## ドキュメント構成

このディレクトリには、Issue #1の実装に関する以下のドキュメントが含まれています:

### コア実装ドキュメント

#### 1. [implementation-plan.md](./implementation-plan.md) 📋

**目的**: プロジェクト全体の実装計画

**内容**:
- 12フェーズに分けた実装計画
- 各フェーズの詳細タスクリスト
- データモデル・API仕様
- リスク分析と対策
- 完了条件
- 見積もり

**対象読者**: プロジェクトマネージャー、開発リーダー、SWEエージェント

---

#### 2. [technical-spec.md](./technical-spec.md) ⚙️

**目的**: 技術実装の詳細仕様

**内容**:
- tmux統合の詳細実装
- Stopフック機構
- 差分抽出アルゴリズム
- WebSocket実装
- データベーススキーマ
- 認証フロー
- エラーハンドリング
- 実装コード例

**対象読者**: 実装担当者、技術レビュアー

---

#### 3. [quick-start.md](./quick-start.md) 🚀

**目的**: 開発着手用の実践ガイド

**内容**:
- 即座に始めるためのコマンド集
- Phase別の実行手順
- デバッグTips
- よくある問題と解決策
- チェックリスト
- 開発スケジュール案

**対象読者**: 実装担当者、SWEエージェント

---

### 品質保証ドキュメント ✨

#### 4. [tdd-guide.md](./tdd-guide.md) 🔴🟢🔵

**目的**: テスト駆動開発の実践ガイド

**内容**:
- TDD基本原則（Red-Green-Refactor）
- Phase別TDDアプローチ
- ユニットテストの書き方
- テスト実践例
- ツールとセットアップ

**対象読者**: 実装担当者、品質保証担当者

---

#### 5. [testing-strategy.md](./testing-strategy.md) 🧪

**目的**: 包括的テスト戦略

**内容**:
- テストピラミッド（ユニット・統合・E2E）
- Playwright MCPによる受け入れテスト
- カバレッジ目標
- CI/CDパイプライン
- テスト実行コマンド

**対象読者**: 実装担当者、品質保証担当者、DevOpsエンジニア

---

#### 6. [code-review-checklist.md](./code-review-checklist.md) ✅

**目的**: コードレビューとリファクタリング基準

**内容**:
- Phase別レビューポイント
- 共通チェック項目
- リファクタリングガイド
- レビューコメント例
- SOLID原則の適用

**対象読者**: 実装担当者、レビュアー

---

## 開発フロー（TDD準拠）

```
1. TDD Guide で開発方針を理解
   ↓
2. Quick Start を見ながらPhase開始
   ↓
3. テストを先に書く（Red）
   ↓
4. Technical Spec で実装詳細を確認
   ↓
5. 最小限の実装でテストを通す（Green）
   ↓
6. Code Review Checklist でセルフレビュー
   ↓
7. リファクタリング（Refactor）
   ↓
8. Testing Strategy に従ってテスト実行
   ↓
9. 各Phase完了後、チェックリストで確認
   ↓
10. 全Phase完了後、受け入れテスト（Playwright MCP）
   ↓
11. Issue #1 をクローズ
```

---

## 主要な実装フェーズ

| Phase | 内容 | 見積もり |
|-------|------|----------|
| 1 | プロジェクト基盤構築 | 2-3h |
| 2 | データレイヤー実装 | 3-4h |
| 3 | Worktree管理機能 | 2-3h |
| 4 | tmux統合 | 4-5h |
| 5 | API Routes実装 | 8-10h |
| 6 | WebSocket実装 | 3-4h |
| 7 | 認証・セキュリティ | 2-3h |
| 8 | UI実装 - 画面A | 4-5h |
| 9 | UI実装 - 画面B | 8-10h |
| 10 | UI実装 - 画面C | 3-4h |
| 11 | テスト・品質保証 | 6-8h |
| 12 | ドキュメント整備 | 2-3h |

**合計**: 47-62時間

---

## 技術スタック

### フロントエンド
- Next.js 14.x (App Router)
- React 18.x
- TypeScript 5.x
- Tailwind CSS 3.x
- react-markdown

### バックエンド
- Node.js 20.x
- Next.js API Routes
- WebSocket (ws)
- SQLite (better-sqlite3)

### インフラ
- tmux
- Claude CLI
- git worktree

### テスト・品質保証
- Vitest（ユニット・統合テスト）
- Playwright（E2Eテスト・受け入れテスト）
- Playwright MCP（受け入れテスト自動化）

---

## 主要機能

1. **画面A: Worktree一覧** - git worktree を最終更新日時順に表示
2. **画面B: チャット画面** - worktree専用のClaude対話インターフェース
3. **画面C: ログビューア** - Markdownログの詳細表示
4. **リアルタイム通信** - WebSocketによる非同期メッセージ配信
5. **イベント駆動アーキテクチャ** - Stopフックによる処理完了検知

---

## 完了条件

### 機能要件 ✅

- [ ] 画面A: Worktree一覧が表示される
- [ ] 画面B: チャット送信・受信が動作する
- [ ] 画面C: Markdownログが表示される
- [ ] WebSocketリアルタイム更新が動作する
- [ ] tmuxセッションが正しく管理される
- [ ] Stopフックが正しく発火する
- [ ] ログファイルが正しく保存される
- [ ] 認証機能が動作する（0.0.0.0バインド時）

### 品質要件 ✅

- [ ] 全APIが型安全に実装されている
- [ ] エラーハンドリングが適切に実装されている
- [ ] レスポンシブデザインが実装されている
- [ ] TDDアプローチで開発されている
- [ ] ユニットテストカバレッジ90%以上
- [ ] 統合テストカバレッジ70%以上
- [ ] E2Eテスト（主要フロー100%）
- [ ] Playwright MCPで受け入れテスト完了
- [ ] コードレビュー完了
- [ ] リファクタリング完了
- [ ] Lint・Formatエラーがゼロ
- [ ] ドキュメントが完成している

### パフォーマンス要件 ✅

- [ ] 画面A→Bの遷移が1秒以内
- [ ] メッセージ送信からUI反映まで200ms以内
- [ ] Stopフック受信からプッシュまで300ms以内
- [ ] 50件のメッセージ表示が1秒以内

---

## 次のアクション

1. ✅ **作業計画の確認** - このドキュメントを確認（完了）
2. 📚 **TDDガイドの理解** - [tdd-guide.md](./tdd-guide.md) を読む
3. 🧪 **テスト戦略の確認** - [testing-strategy.md](./testing-strategy.md) を確認
4. ✅ **レビュー基準の理解** - [code-review-checklist.md](./code-review-checklist.md) を確認
5. ⏭️ **Phase 1の開始** - [quick-start.md](./quick-start.md) を参照
6. 🔄 **定期的な進捗確認** - 各Phaseごとにチェックリストで確認

---

## リスク管理

### 高リスク項目

1. **tmux統合の複雑性** - 十分なテスト時間を確保
2. **WebSocketの安定性** - 再接続ロジック必須
3. **Stopフックの信頼性** - タイムアウト機構実装

### 対策

- 各リスクについて technical-spec.md に詳細な対策を記載
- Phase 4, 6で重点的にテストを実施
- 問題発生時の代替案を準備

---

## 進捗管理

### 進捗記録方法

このディレクトリに以下のファイルを追加して進捗を記録してください:

- `progress.md` - 日次の進捗メモ
- `issues.md` - 発生した問題と解決策
- `decisions.md` - 実装時の意思決定記録

---

## 参考資料

### プロジェクトドキュメント

- [README.md](../../../README.md) - プロジェクト概要
- [docs/swe-agents.md](../../../docs/swe-agents.md) - SWEエージェント向けガイド
- [docs/architecture.md](../../../docs/architecture.md) - アーキテクチャ詳細（作成予定）

### 外部リソース

- [Next.js App Router Documentation](https://nextjs.org/docs/app)
- [tmux Documentation](https://github.com/tmux/tmux/wiki)
- [Claude CLI Documentation](https://claude.com/claude-code)
- [WebSocket API (ws)](https://github.com/websockets/ws)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

## 連絡先・質問

- **Issue**: GitHub Issues にて質問・バグ報告
- **Discussion**: 設計に関する議論
- **PR**: 実装完了後にPull Request作成

---

**作成者**: Claude (SWE Agent)
**最終更新**: 2025-11-17
**バージョン**: 1.0.0
